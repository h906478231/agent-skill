# change-progress-facts Specification

## Purpose
门禁脚本的 `facts` 子命令输出一个变更的事实 JSON，供进度视图读取。JSON 包含分级、评审裁决、签字、verify 报告指纹、待决定条数与归档阻断项。
## Requirements
### Requirement: The facts command SHALL report the facts of one change as JSON

`implementation-gate.mjs facts <changeRoot> [--repo <dir>]` SHALL write one JSON object with the fields `command` (`facts`), `change`, `tier`, `technicalReview`, `verification`, `openQuestions`, `currentFingerprint` and `archive`. `tier` SHALL use the same reading as the `archive` command: `L0`, `L1`, `L2`, `L3`, `MVP` or `null`. `archive` SHALL contain the same `ok`, `blockers`, `warnings`, `notes`, `review` and `evidence` that the `archive` command writes for the same change root. The command SHALL exit with code `0` when it writes the facts, also when `archive.ok` is `false`. It SHALL exit with code `2` on the same argument and environment errors as the other commands. It SHALL NOT write files in the change directory. When the dual-axis review applies, `archive.review` SHALL contain `stale`: `true` when the `archive` command writes the warning that the implementation changed after the review (the baseline fingerprint differs from the current fingerprint, or from the fingerprint of the change head when `tasks.md` declares one, and the changes since the baseline are not only comment changes and not only changes registered as test only), and `false` in all other cases. The `archive` command SHALL write the same `stale` in its `review`.

#### Scenario: Facts of a change with blockers
- **WHEN** a change has a slice whose evidence fingerprint differs from the current fingerprint
- **THEN** `facts` exits with code 0
- **AND** `archive.ok` is `false` and `archive.blockers` contains the same text as the output of the `archive` command

#### Scenario: Review is stale after a code change
- **WHEN** the review baseline of a change is fingerprint A, and a source file changed after A
- **THEN** `archive.review.stale` is `true` and `archive.warnings` contains the warning that the implementation changed after the review

#### Scenario: Review is not stale after a comment change
- **WHEN** the review baseline of a change is fingerprint A, and the only change after A is a comment
- **THEN** `archive.review.stale` is `false`

#### Scenario: Tier from the tier line
- **WHEN** `overview.md` starts with the line `> 分级：L2 标准 ｜ 判定人：tigger ｜ 日期：2026-10-30 ｜ 依据：新增业务流程`
- **THEN** `tier` is `L2`

#### Scenario: Change root that does not exist
- **WHEN** `facts` is run with a path that is not a directory
- **THEN** the command exits with code 2 and writes the reason

### Requirement: The facts command SHALL read the technical review verdict and the signature line with the rules of the approval hook

`technicalReview.exists` SHALL be `true` only when `review-summary.md` exists. `technicalReview.gateVerdict` SHALL be the first word of ASCII letters and underscores after the last `Gate-Verdict:` or `Gate-Verdict：` (full-width colon) on the last line that matches `^[-*>\s]*Gate-Verdict[:：]`. It SHALL be `null` when the file, the line or such a word does not exist. The signature line SHALL be the last line that matches `^[-*>\s]*Technical Review Approved:`. A line that contains `Technical Review Approved:` only in the middle of the line, in backticks, in a table cell or after other text SHALL NOT be the signature line. `technicalReview.approval` SHALL be:

- `missing` when the file does not exist or has no signature line;
- `blank` when the value after the last `Technical Review Approved:` of the signature line and before `签署人`, without white space, is empty, has only underscores (`_` or the full-width `＿`), starts with `__` or `＿＿`, or contains `<签名>` or `＜签名＞`;
- `signed` in all other cases.

White space in these rules SHALL be the white space of the JavaScript `\s` class: ASCII white space and the non-ASCII characters in `UNICODE_SPACES` of the shared samples `scripts/lib/review-approval-samples.mjs` (for example U+3000 and U+00A0). These rules SHALL give the same result as `skills/openspec-technical-review/hooks/check-review-approval.sh` for each verdict line, each signature line and each summary sample in the shared samples, when the hook runs in the C locale and in a UTF-8 locale.

#### Scenario: Blocked verdict
- **WHEN** `review-summary.md` contains the line `Gate-Verdict: BLOCKED`
- **THEN** `technicalReview.gateVerdict` is `BLOCKED`

#### Scenario: Verdict followed by a full-width note
- **WHEN** `review-summary.md` contains the line `Gate-Verdict: BLOCKED（未闭环）`
- **THEN** `technicalReview.gateVerdict` is `BLOCKED`

#### Scenario: Verdict line with a full-width colon
- **WHEN** `review-summary.md` contains the line `Gate-Verdict：BLOCKED`
- **THEN** `technicalReview.gateVerdict` is `BLOCKED`

#### Scenario: Verdict line after non-ASCII white space
- **WHEN** `review-summary.md` contains a line that starts with a full-width space (U+3000) followed by `Gate-Verdict: BLOCKED`
- **THEN** `technicalReview.gateVerdict` is `BLOCKED`

#### Scenario: Verdict value without an ASCII word
- **WHEN** `review-summary.md` contains the line `Gate-Verdict: 待定`
- **THEN** `technicalReview.gateVerdict` is `null`

#### Scenario: Verdict of the previous round before the verdict line
- **WHEN** the body of `review-summary.md` contains the line `- Gate-Verdict: READY_FOR_HUMAN_APPROVAL（R3 的裁决）`
- **AND** a later line is `Gate-Verdict: BLOCKED`
- **THEN** `technicalReview.gateVerdict` is `BLOCKED`

#### Scenario: Signature line with a placeholder and a note
- **WHEN** the signature line is `Technical Review Approved: __________ （签字 / 日期）`
- **THEN** `technicalReview.approval` is `blank`

#### Scenario: Signature value with only a no-break space
- **WHEN** the signature line is `Technical Review Approved:` followed by one space and one no-break space (U+00A0)
- **THEN** `technicalReview.approval` is `blank`

#### Scenario: Signed review
- **WHEN** the signature line is `Technical Review Approved: tigger 2026-10-30`
- **THEN** `technicalReview.approval` is `signed`

#### Scenario: Signed signature mentioned in the body before a blank signature line
- **WHEN** the body of `review-summary.md` contains ``R3 已签字（`Technical Review Approved: tigger`）``
- **AND** the last line of the file is `Technical Review Approved: __________`
- **THEN** `technicalReview.approval` is `blank`

#### Scenario: Signed line after the placeholder
- **WHEN** `review-summary.md` contains `Technical Review Approved: __________` and a later line `Technical Review Approved: 张三 2026-11-08`
- **THEN** `technicalReview.approval` is `signed`

#### Scenario: Signature only in the middle of a line
- **WHEN** the only line that contains `Technical Review Approved:` is `签字：Technical Review Approved: 张三`
- **THEN** `technicalReview.approval` is `missing`

#### Scenario: Legacy summary without a verdict line
- **WHEN** `review-summary.md` exists and has no `Gate-Verdict` line
- **THEN** `technicalReview.exists` is `true` and `technicalReview.gateVerdict` is `null`

### Requirement: The facts command SHALL compare the fingerprint of the verify report with the fingerprint that verify writes

`verification.exists` SHALL be `true` only when `verification.md` exists. `verification.fingerprint` SHALL be the value of the first `Fingerprint` field line when the value is `git-tree:` followed by 40 or 64 lowercase hexadecimal characters. A list marker, bold markers and a full-width colon SHALL be allowed in the field line, and backticks and asterisks around the value SHALL be removed. It SHALL be `null` in all other cases, including a value with text after the fingerprint. `verification.expectedFingerprint` SHALL be the change head fingerprint (the output of `fingerprint <changeRoot> --rev <change head>`) when `tasks.md` has a `## 变更终点` section, and `currentFingerprint` in all other cases. `verification.current` SHALL be `true` when the fingerprint equals `verification.expectedFingerprint`, `false` when it differs, and `null` when there is no fingerprint. When the `## 变更终点` section is not valid, the command SHALL exit with code `2` and write the reason, as the other commands do. The command SHALL NOT read the list of CRITICAL issues in the report.

#### Scenario: Verify report for the current implementation
- **WHEN** `verification.md` contains `- Fingerprint: <current fingerprint>`
- **THEN** `verification.current` is `true`

#### Scenario: Verify report before a later code change
- **WHEN** `verification.md` contains a fingerprint and a source file changes after the report
- **THEN** `verification.current` is `false`

#### Scenario: Verify report at the change head
- **WHEN** `tasks.md` has a valid `## 变更终点` section, a commit after the change head changes a source file, and `verification.md` contains the change head fingerprint
- **THEN** `verification.expectedFingerprint` is the change head fingerprint and differs from `currentFingerprint`
- **AND** `verification.current` is `true`

### Requirement: The facts command SHALL report the verdict fields of the verify report

`facts` SHALL read the `Verify-Verdict` and `Critical-Count` field lines with the rule of the capability `verify-verdict`, and SHALL use the same reading as the blockers of `archive`. `verification.verdict` SHALL be `PASS` or `FAIL` when the gate recognizes the verdict, and `null` in all other cases. `verification.criticalCount` SHALL be the count as a number, and `null` when the `Critical-Count` line does not exist or its value does not start with a decimal integer. `verification.legacy` SHALL be `true` when `verification.md` exists and has neither field line, `false` when it has at least one of them, and `null` when `verification.md` does not exist.

#### Scenario: Report with verdict fields
- **WHEN** `verification.md` contains `- Verify-Verdict: FAIL` and `- Critical-Count: 2`
- **THEN** `verification.verdict` is `FAIL`, `verification.criticalCount` is `2` and `verification.legacy` is `false`

#### Scenario: Legacy report without verdict fields
- **WHEN** `verification.md` contains only a `Fingerprint` line and a `Verify Mode` line
- **THEN** `verification.verdict` and `verification.criticalCount` are `null` and `verification.legacy` is `true`

#### Scenario: No verify report
- **WHEN** the change has no `verification.md`
- **THEN** `verification.legacy` is `null`

### Requirement: The facts command SHALL count the open questions of design.md without new markers

`openQuestions.total` SHALL be the number of items in the section `## Open Questions` of `design.md`, from that heading (case-insensitive) to the next level-1 or level-2 heading or the end of the file. Lines in fenced code blocks SHALL NOT start items. Each `### ` heading SHALL be one item, and list items below it SHALL be part of its text. Each top-level list item (`- `, `* ` or `<number>. ` at the start of the line) that is not below a `### ` heading in the section SHALL be one item. `openQuestions.pending` SHALL be the number of items whose text does not contain `结论`. Both numbers SHALL be `0` when `design.md` or the section does not exist, or when the section has no items.

#### Scenario: Questions with headings and option lists
- **WHEN** the section has the headings `### Q1` to `### Q4`, each with an option list and the word `建议`, and none contains `结论`
- **THEN** `openQuestions` is `{ "pending": 4, "total": 4 }`

#### Scenario: Questions with conclusions
- **WHEN** the section has three list items and each contains `**结论（2026-10-07）**`
- **THEN** `openQuestions` is `{ "pending": 0, "total": 3 }`

#### Scenario: No open questions
- **WHEN** the section contains only `无。`
- **THEN** `openQuestions` is `{ "pending": 0, "total": 0 }`

### Requirement: facts SHALL 统一输出变更的推进意愿

`implementation-gate.mjs facts <changeRoot>` SHALL 按 `change-pause` 的文件契约读取推进意愿，在原有字段之外输出 `changeStateVersion: 1` 与 `changeState`。`changeState` SHALL 为 `{ state, reason, updatedAt, error, digest }`。`digest` SHALL 为状态文件原始字节的 SHA-256，小写十六进制共 64 个字符，不归一化。状态文件缺失、非普通文件、超限或字节不能完整读取时 `digest` SHALL 为 `null`。`digest` 只用于写入前的一致性复核，SHALL 不作为签署字段或门禁证据。状态文件缺失时 SHALL 输出 `enabled` 和四个 `null`（原因、时间、错误、摘要）。文件合法时 SHALL 输出其中的状态、原因、时间、摘要及 `error: null`。文件无效时 SHALL 输出 `state: unknown`、原因为 `null`、时间为 `null`，以及包含文件路径与具体原因的 `error`，仅在字节完整读取且未超限时仍输出摘要。

`facts` SHALL 同时输出 `changeDirectory: { path, dev, ino }`。路径为核对后的绝对目录路径，设备号与 inode 为十进制字符串。读取前后 SHALL 核对目录实例。路径不可定位、目录缺失或实例变化时 SHALL 输出 `changeDirectory: null` 与 `state: unknown`。只在已核对目录内缺少状态文件时按 `enabled` 读取。

变更状态无效时 `facts` SHALL 仍输出其他可读事实并退出 0。其他参数与环境错误 SHALL 沿用原规则。`facts` SHALL 不因暂缓改变 `archive`、指纹或技术评审字段。读取状态文件的规则 SHALL 只在门禁模块中定义，进度视图与托管管理不得另写一套解析规则。

读取前 SHALL 确认状态目录属于项目真实根：活跃目录为 `openspec/changes` 的直接子目录，归档目录为 `openspec/changes/archive` 下符合 `YYYY-MM-DD-<name>` 的直接子目录。SHALL 不跟随目录软链接。归属不明时 SHALL 不读取状态正文，也不解释为缺文件；可读的其他门禁事实仍按原规则输出。

#### Scenario: 缺少状态文件的事实
- **WHEN** 变更没有状态文件，其他事实可读
- **THEN** `facts` 退出 0，输出版本 1 与 `state: enabled`
- **AND** 不创建状态文件

#### Scenario: 目录缺失不等于状态文件缺失
- **WHEN** 门禁无法核实原目录，或读取前后目录实例不一致
- **THEN** 输出 `changeDirectory: null` 和 `state: unknown`，不回退为 `enabled`

#### Scenario: 超限状态仍保留其他门禁事实
- **WHEN** 已确认归属的状态文件超过 16 KiB
- **THEN** 状态为 `unknown`，原因与摘要为 `null`
- **AND** 其他可读门禁事实仍输出，不计算截断摘要

#### Scenario: 摘要随文件字节变化
- **WHEN** 同一变更的状态文件内容改变一个字节
- **THEN** 两次 `facts` 的 `changeState.digest` 不同，文件未修改时两次相同
- **AND** 文件缺失时 `digest` 为 `null`

#### Scenario: 状态错误不覆盖门禁事实
- **WHEN** 状态文件是无效 JSON，且技术评审为 `BLOCKED`
- **THEN** `facts` 退出 0，状态为 `unknown`，错误包含文件路径
- **AND** 技术评审仍为 `BLOCKED`

### Requirement: 门禁 SHALL 提供只读状态子命令

`implementation-gate.mjs state <changeRoot> [--repo <dir>]` SHALL 使用与 `facts` 相同的读取函数，只输出 `changeStateVersion`、`changeDirectory` 与 `changeState`，字段含义与 `facts` 相同。`state` SHALL 不计算实现指纹，不读取评审、任务或证据，不向 Git 对象库写入对象。状态无效时 SHALL 输出 `state: unknown` 并退出 0。参数与环境错误 SHALL 沿用 `facts` 的规则。

#### Scenario: state 与 facts 给出相同的状态
- **WHEN** 同一变更分别运行 `state` 与 `facts`，状态文件没有改变
- **THEN** 两次输出的 `changeStateVersion`、`changeDirectory` 与 `changeState` 相同

#### Scenario: state 不写 Git 对象
- **WHEN** 工作区有未入库的修改，运行 `state`
- **THEN** 运行前后对象库的对象数相同

### Requirement: 门禁 SHALL 接受变更状态文件而不豁免检查

产物允许清单 SHALL 接受变更根目录唯一的 `change-state.json`。其他路径中的同名文件 SHALL 不因此取得允许。该文件只属于规划数据，SHALL 沿用规划目录的指纹排除规则。`archive`、`review`、`evidence` 和 `trace` 的原有业务检查 SHALL 不因文件存在或状态为 `paused` 而通过。

#### Scenario: 状态文件是合法产物
- **WHEN** 变更根目录有一份合法 `change-state.json`
- **THEN** 产物检查不报告该文件为清单外文件

#### Scenario: 暂缓不改变归档阻断
- **WHEN** 变更状态为 `paused`，verify 结论为 `FAIL`
- **THEN** 归档检查仍报告 verify 结论的阻断
