# change-recap Specification

## Purpose
完成清单：archive 把变更移入归档目录后，由一个子 agent 在归档目录写出 `recap.md`，按新增、修改、删除、修复、没做与遗留 5 类列出事项并写出落点，内容以已勾选任务、delta specs、切片证据与评审结论为准，`/opsx:recap <变更名>` 为已归档变更补生成；跨变更总表由 `recap.mjs list` 只读取完成清单的 4 个头部字段，按主题分组打印，不调用 LLM，不写文件。
## Requirements
### Requirement: The change recap SHALL have a fixed header and fixed sections

The change recap SHALL be the file `recap.md` in the archive directory of a change: `<archiveDir>/<YYYY-MM-DD>-<变更名>/recap.md`.

The file SHALL start with the line `# 完成清单：<变更名>`. Four list items SHALL follow in this order:

- `- 归档日期：<YYYY-MM-DD>`
- `- 分级：<值>`
- `- 主题：<值>`
- `- 摘要：<一句话>`

After the header, the file SHALL contain the second-level headings `## 新增`, `## 修改`, `## 删除`, `## 修复`, `## 没做与遗留` and `## 落点` in this order. A category without items SHALL contain the line `无`. A value that no artifact states SHALL be written as `未定义`.

`分级` SHALL be one of `L0`, `L1`, `L2`, `L3`, `MVP` and `未定义`. It SHALL NOT contain a person, a date or a reason. The recap SHALL read `分级` in the same way as the archive gate: from the tier line at the start of `overview.md`, it takes the field before the first `｜`. When the field contains `MVP`, `分级` SHALL be `MVP`. Otherwise `分级` SHALL be the level `L0`–`L3` in the field, or in the full line when the field has no level. A legacy line `方案类型：MVP` SHALL give `MVP`. When `overview.md` gives no level, `分级` SHALL be the `Gate-Level` value of `review-summary.md`. When neither gives a value, `分级` SHALL be `未定义`.

`node recap.mjs check <recapFile>` SHALL check the format:

- The directory that contains `recap.md` has a name of the form `YYYY-MM-DD-<name>`.
- The first line names the change. The name equals the archive directory name without the `YYYY-MM-DD-` prefix.
- The four header fields exist in the order above, and each value is not empty.
- `归档日期` is a valid date and equals the date prefix of the archive directory name.
- `分级` is one of `L0`, `L1`, `L2`, `L3`, `MVP` and `未定义`.
- The six headings exist in the order above.

Each violation SHALL produce one item in `blocking` with the line number and the field or heading. The command SHALL exit with code `0` when `blocking` is empty, `1` when `blocking` is not empty, and `2` for an argument error or a missing file.

#### Scenario: Valid recap passes the check
- **WHEN** `2026-10-28-eval-harness-v2/recap.md` has the header line, the four header fields and the six headings in order
- **THEN** `recap.mjs check` exits with code 0
- **AND** `blocking` is empty

#### Scenario: Missing header field is blocking
- **WHEN** `recap.md` has no line that starts with `- 主题：`
- **THEN** `recap.mjs check` exits with code 1
- **AND** one item in `blocking` names `主题`

#### Scenario: Archive date differs from the directory name
- **WHEN** `recap.md` in `2026-10-28-eval-harness-v2` has `- 归档日期：2026-10-27`
- **THEN** `recap.mjs check` exits with code 1
- **AND** the item in `blocking` names `归档日期` and the expected value `2026-10-28`

#### Scenario: Tier outside the value domain is blocking
- **WHEN** `recap.md` has `- 分级：L0 豁免。判定人：用户`
- **THEN** `recap.mjs check` exits with code 1
- **AND** one item in `blocking` names `分级`

#### Scenario: Category without items passes the check
- **WHEN** the section `## 删除` contains only the line `无`
- **THEN** `recap.mjs check` exits with code 0

#### Scenario: Missing recap file is an error
- **WHEN** the path given to `recap.mjs check` does not exist
- **THEN** `recap.mjs check` exits with code 2
- **AND** the message names the path

### Requirement: The recap content SHALL describe actual results

Each item SHALL be one sentence. Each category SHALL have 8 items or fewer. Each item in `新增`, `修改`, `删除` and `修复` SHALL end with `（<落点>）`, which names a file, a directory or a main spec.

The recap SHALL take its items from these sources:

| Category | Sources |
|---|---|
| `新增`, `修改`, `删除` | Checked tasks in `tasks.md`, and ADDED, MODIFIED and REMOVED requirements of the delta specs |
| `修复` | Defects that existed before the change and that a checked task or a delta requirement corrects |
| `没做与遗留` | Tasks that `design.md` moves out of scope, unchecked tasks, findings with the status `open` in the dual-axis reports, Risk Accepted items, slices in the status `pending-environment`, and items of `deployment.md` |
| `落点` | The sync result of the main specs, and the union of the `## 变更文件` lists of the slice evidence, grouped by first-level directory with counts |

An item of the What Changes section of `proposal.md` SHALL NOT appear in `新增`, `修改` or `删除` when no checked task and no delta requirement supports it. `修复` SHALL NOT list a finding on code that the change itself added. When the change has no slice evidence, the file part of `落点` SHALL be `未定义`.

The recap SHALL read finding status only from the dual-axis reports `review/standards.md` and `review/spec-fidelity.md`:

- When a report has the section `## Finding 台账`, the recap SHALL read status only from that section.
- When a report has no such section, the recap SHALL read the last column `闭环状态` of the `## Findings` table. An empty value SHALL count as `open`, `risk-accepted` SHALL count as Risk Accepted, and each ID SHALL count once.
- When neither gives a status, the finding part of `## 没做与遗留` SHALL be `未定义`, not `无`.
- The recap SHALL NOT read finding status from the reports of the review before coding (`review/<role>.md`).

The `open` findings of one report SHALL be one item that states the count, the severity of each finding and the IDs. When a category has more than 8 items, items from the same source SHALL be merged.

#### Scenario: Work moved out of scope is not reported as done
- **WHEN** `design.md` records that Slice 08–10 move out of scope, and `tasks.md` has no checked task for them
- **THEN** the section `## 没做与遗留` lists the moved-out work
- **AND** the section `## 新增` does not list it

#### Scenario: Finding on new code of the change is not a fix
- **WHEN** a Finding 台账 has a closed finding on a file that the change adds
- **THEN** the section `## 修复` does not list the finding

#### Scenario: Open finding is a leftover
- **WHEN** the Finding 台账 of `review/standards.md` has a finding with the status `open`
- **THEN** the section `## 没做与遗留` lists the finding ID

#### Scenario: Report without Finding 台账 falls back to the Findings table
- **WHEN** `review/standards.md` has no section `## Finding 台账`, and the `闭环状态` column of its `## Findings` table has 8 findings with `open` and 1 finding with `risk-accepted`
- **THEN** the section `## 没做与遗留` has one item for the report that states 8 `open` findings with their severities and IDs
- **AND** the section lists the `risk-accepted` finding as Risk Accepted

#### Scenario: Change without slice evidence
- **WHEN** the archive directory of the change has no `evidence/` directory
- **THEN** the file part of the section `## 落点` is `未定义`

### Requirement: Archive SHALL generate the recap after moving the change directory

After archive shows the archive summary, archive SHALL generate `recap.md` with one sub-agent. Then archive SHALL run `recap.mjs check` on the file, and SHALL show the path of `recap.md` and the value of `摘要` from the `header` of the check output.

The sub-agent SHALL create or replace only `recap.md` in the archive directory of the change. It SHALL NOT change other files in the archive directory, SHALL NOT run commands other than `recap.mjs list`, SHALL NOT run git commands and SHALL NOT ask the user. The same limits SHALL apply to the one correction, and to the generation by the main session when the environment has no sub-agent.

When the sub-agent fails, or `recap.mjs check` still exits with code 1 after one correction, archive SHALL NOT move the change back. Archive SHALL show a warning and the command `/opsx:recap <变更名>`. When archive refuses the change at a gate, archive SHALL NOT generate a recap.

`implementation-gate.mjs hygiene` SHALL NOT warn about `recap.md`.

#### Scenario: Archive writes the recap
- **WHEN** archive moves `add-change-recap` to `archive/2026-11-02-add-change-recap/`
- **THEN** `archive/2026-11-02-add-change-recap/recap.md` exists
- **AND** `recap.mjs check` on the file exits with code 0
- **AND** archive shows the path and the value of `摘要` after the archive summary

#### Scenario: Recap failure does not undo the archive
- **WHEN** the sub-agent that generates the recap fails
- **THEN** the change stays in the archive directory
- **AND** archive shows a warning and `/opsx:recap <变更名>`

#### Scenario: Recap generation changes no other archive file
- **WHEN** the recap of a change is generated
- **THEN** each file in the archive directory of the change other than `recap.md` has the same content before and after the generation

#### Scenario: Refused archive writes no recap
- **WHEN** archive refuses the change because `verification.md` does not exist
- **THEN** no `recap.md` exists for the change

#### Scenario: Hygiene accepts the recap
- **WHEN** a change directory contains `recap.md`
- **THEN** `implementation-gate.mjs hygiene` has no warning for `recap.md`

### Requirement: The recap command SHALL generate the recap of an archived change

`/opsx:recap <变更名>` SHALL generate the recap of one archived change with the same rules as archive. `<变更名>` SHALL match an archive directory name exactly, or match the part after the `YYYY-MM-DD-` prefix.

- When two or more directories match, the command SHALL ask the user to select one.
- When no archive directory matches and an active change has the name, the command SHALL state that the recap is only for archived changes, and SHALL NOT write a file.
- When nothing matches, the command SHALL report that the change does not exist.

A new generation SHALL replace the whole file. When the old file has a `主题` value that is not empty, the new file SHALL keep that value.

#### Scenario: Recap for an old archived change
- **WHEN** the user runs `/opsx:recap add-change-head` and `archive/2026-10-26-add-change-head/` has no `recap.md`
- **THEN** `archive/2026-10-26-add-change-head/recap.md` exists
- **AND** `recap.mjs check` on the file exits with code 0

#### Scenario: New generation keeps the theme
- **WHEN** `recap.md` has `- 主题：门禁与评审` and the user runs `/opsx:recap` with the change name again
- **THEN** the new `recap.md` has `- 主题：门禁与评审`

#### Scenario: Name matches two archive directories
- **WHEN** `archive/2026-10-12-foo/` and `archive/2026-10-20-foo/` both exist and the user runs `/opsx:recap foo`
- **THEN** the command asks the user to select one directory
- **AND** the command writes no file before the user answers

#### Scenario: Active change is refused
- **WHEN** the user runs `/opsx:recap ddd-visualization-data-separation` and the change is not archived
- **THEN** the command states that the recap is only for archived changes
- **AND** no `recap.md` is written

### Requirement: The recap theme SHALL reuse existing themes

Before the sub-agent writes `主题`, it SHALL run `recap.mjs list <archiveDir> --json` to read the existing themes. The sub-agent SHALL use an existing theme when the main area of the change matches it. Only when no existing theme matches SHALL it write a new theme. The conclusion of the sub-agent SHALL state whether the theme is reused or new.

#### Scenario: Existing theme is reused
- **WHEN** existing recaps have the themes `门禁与评审` and `评测与测试`, and the change adds a step to the review gate
- **THEN** the new recap has `- 主题：门禁与评审`
- **AND** the conclusion of the sub-agent states that the theme is reused

### Requirement: The recap list SHALL print the cross-change table from recap headers

`node recap.mjs list <archiveDir>` SHALL read only the header of `recap.md` in each subdirectory of `<archiveDir>` whose name does not start with `.`, and SHALL print a Markdown table grouped by `主题`. A subdirectory whose name starts with `.` SHALL NOT count in `total` and SHALL NOT be listed in `没有完成清单`.

- Groups are ordered by the number of changes, from most to least, then by theme name.
- Rows in a group are ordered by `归档日期`, from newest to oldest, then by directory name.
- Each row has the columns `归档日期`, `变更`, `分级` and `摘要`.
- The section `没有完成清单` lists each subdirectory without `recap.md`, and each subdirectory whose header fails the format check, with the reason.

With `--json`, the command SHALL print `{ total, withRecap, themes, missing }` instead. The command SHALL NOT write a file, SHALL NOT call an LLM and SHALL NOT use the network. The command SHALL exit with code `0` when the table is printed, also when some changes have no recap. It SHALL exit with code `2` when `<archiveDir>` does not exist or an argument is invalid.

`/opsx:recap` without arguments SHALL run `recap.mjs list` on the archive directory of the current OpenSpec root, and SHALL show the output without changes.

#### Scenario: Table grouped by theme
- **WHEN** three recaps have the theme `门禁与评审` and one recap has the theme `STE 规则`
- **THEN** the group `门禁与评审` is printed before the group `STE 规则`
- **AND** the rows in the group `门禁与评审` are ordered from the newest to the oldest `归档日期`

#### Scenario: Change without a recap is listed
- **WHEN** `archive/2026-10-08-add-change-model-visualization/` has no `recap.md`
- **THEN** the section `没有完成清单` lists `2026-10-08-add-change-model-visualization`
- **AND** `recap.mjs list` exits with code 0

#### Scenario: Recap with an invalid header is listed with the reason
- **WHEN** a `recap.md` has no line that starts with `- 摘要：`
- **THEN** the section `没有完成清单` lists the directory with a reason that names `摘要`

#### Scenario: List writes no file
- **WHEN** `recap.mjs list` runs on an archive directory
- **THEN** the files in the archive directory are the same before and after the run

#### Scenario: Missing archive directory
- **WHEN** `<archiveDir>` does not exist
- **THEN** `recap.mjs list` exits with code 2
- **AND** the message names the path

### Requirement: The recap SHALL keep the git boundary

The agent SHALL NOT run `git add` or `git commit` on `recap.md`, and SHALL NOT change `.gitignore`. The rule text of archive and of `/opsx:recap` SHALL state this boundary: the two archive copies, `skills/openspec-change-recap/SKILL.md` and `claude/commands/opsx/recap.md` SHALL contain the git guard sentence of `scripts/test-doc-consistency.mjs` and `不修改 \`.gitignore\``.

`recap.mjs check` SHALL run both git commands in the directory of the recap file after it resolves symbolic links, and SHALL give the file name after `--`. It SHALL report `gitIgnored`:

- `true` when `git check-ignore` exits with code 0.
- `false` when `git check-ignore` exits with code 1. The output SHALL then contain one item in `warnings` with the rule `openspec/changes/archive/*/recap.md`.
- `null` when the file is not in a git work tree, when git is not installed, or when `git check-ignore` exits with another code. An error SHALL NOT give `true`.

A warning SHALL NOT change the exit code.

#### Scenario: Project that ignores openspec
- **WHEN** the project `.gitignore` contains `/openspec` and `recap.mjs check` runs on a recap in the archive directory
- **THEN** `gitIgnored` is `true`
- **AND** `warnings` is empty

#### Scenario: Project that commits the archive directory
- **WHEN** the project `.gitignore` does not ignore the recap file
- **THEN** `gitIgnored` is `false`
- **AND** `warnings` contains the rule `openspec/changes/archive/*/recap.md`
- **AND** the exit code depends only on `blocking`

#### Scenario: Directory outside a git work tree
- **WHEN** the recap file is not in a git work tree
- **THEN** `gitIgnored` is `null`
- **AND** `warnings` is empty

#### Scenario: Process in another git repository
- **WHEN** the recap file is in git repository A, which does not ignore the file, and the working directory of the process is git repository B
- **THEN** `gitIgnored` is `false`
- **AND** `warnings` contains the rule `openspec/changes/archive/*/recap.md`

#### Scenario: Rule text keeps the git boundary
- **WHEN** `scripts/test-doc-consistency.mjs` runs
- **THEN** the two archive copies, `skills/openspec-change-recap/SKILL.md` and `claude/commands/opsx/recap.md` contain the git guard sentence and `不修改 \`.gitignore\``
