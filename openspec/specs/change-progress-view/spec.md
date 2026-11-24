# change-progress-view Specification

## Purpose
进度视图为每个活跃变更推导阶段、卡点与下一步命令，输出终端表格或 JSON。已归档变更只列出名称与日期，不运行门禁。
## Requirements
### Requirement: The progress view SHALL list the active changes of the current project

`progress.mjs` SHALL read the active changes and the project root from `openspec list --json`, and the completeness of the planning artifacts and the change root from `openspec status --change <name> --json`. It SHALL run the openspec CLI with `OPENSPEC_TELEMETRY=0` and a timeout of 60 seconds. For each active change it SHALL run `implementation-gate.mjs facts <changeRoot> --repo <projectRoot>` in the working directory of the view, with the project root from `openspec list --json` and a timeout of 60 seconds. It SHALL write one entry per active change with `change`, `tier`, `stage`, `tasks` (`done`, `total` from `completedTasks`, `totalTasks`), `openQuestions`, `rule`, `blockers`, `warnings`, `notes`, `next` and `error`. It SHALL NOT write files in the change directories and SHALL NOT run git commands that write refs, the index or the work tree.

#### Scenario: Two active changes
- **WHEN** the project has two active changes and one archived change
- **THEN** `progress.mjs --json` writes two entries in `active`, one per change

#### Scenario: Open questions do not change the stage
- **WHEN** an active change has `openQuestions.pending` equal to 2 and all other facts are the same as a change with no open questions
- **THEN** both changes have the same `stage`, `rule` and `next`
- **AND** the entry shows `openQuestions.pending` as 2

### Requirement: The progress view SHALL derive the stage with ordered rules

The view SHALL check the rules in this order and SHALL use the first rule that matches:

| Rule | Condition | Stage | Next |
|---|---|---|---|
| R1 | a planning artifact in `applyRequires` is not `done` | `propose` | `/opsx:propose <name>` |
| R2 | no `review-summary.md`, and `tier` is `L1`, `L2` or `L3`, or `tier` is `null` and `tasks.done` is 0 | `review` | `/opsx:review <name>` |
| R3 | `gateVerdict` is `BLOCKED` | `review` | `/opsx:update <name>`, then `/opsx:review <name>` |
| R4 | `review-summary.md` exists and `gateVerdict` is `null` | `review` | check the gate verdict in `review-summary.md` by hand |
| R5 | `review-summary.md` exists and `approval` is not `signed` | `approval` | review `review/*.md` and sign `review-summary.md` |
| R6 | `tasks.done` is less than `tasks.total` | `apply` | `/opsx:apply <name>` |
| R7 | `archive.evidence.issues` is not empty | `apply` | run the slice again and update the evidence |
| R8 | `archive.review.applicable` is `true`, and `archive.review.verdict` is not `PASSED` or `archive.review.stale` is not `false` | `quality` | `/opsx:quality <name>` |
| R9 | `verification.exists` is `false` or `verification.current` is not `true` | `verify` | `/opsx:verify <name>` |
| R10 | `archive.ok` is `false` | `verify` | fix the blocker, then `/opsx:verify <name>` |
| R11 | all other cases | `archive` | `/opsx:archive <name>` when `verification.legacy` is `false`; in all other cases, confirm that `verification.md` has no CRITICAL, then `/opsx:archive <name>` |

The entry SHALL contain the rule ID in `rule`. For R10 the entry SHALL contain `archive.blockers` in `blockers`, including the blockers of the verify verdict. When `tier` is `null` and `tasks.done` is greater than 0, the entry SHALL contain a note that the change has no tier line and is handled as a historical change. `archive.warnings` SHALL be copied to `warnings` and SHALL NOT change the rule. The entry SHALL contain `reviewStale`: `archive.review.stale` when the review applies and that value is `true` or `false`, `false` when the review does not apply, and `null` when the review applies and the gate does not report a boolean `stale`. When `reviewStale` is `null` and R8 matches, the blockers SHALL contain a blocker that asks the user to sync the copy of `openspec-technical-review`.

上表 SHALL 先计算原有的阶段、规则和阶段建议。通过文件契约检查的 `paused` 状态 SHALL 不改变阶段、规则、任务、卡点或门禁事实，但最终输出的 `next` SHALL 改为 `node <AUTOPILOT>/autopilot.mjs resume <name>`，其中 `<AUTOPILOT>` 表示已安装托管脚本的目录。若状态为 `unknown`，`next` SHALL 指向修复状态文件，不得推荐 apply 或托管。字段缺失也 SHALL 作为未知状态处理。状态只覆盖下一步的显示，不改变 R1–R11 的匹配顺序。

#### Scenario: Planning artifacts are not complete
- **WHEN** a change has `proposal.md` and no `tasks.md`
- **THEN** `stage` is `propose`, `rule` is `R1`, and `next` starts with `/opsx:propose`

#### Scenario: New change without a tier line
- **WHEN** a change has all planning artifacts, no `overview.md`, no `review-summary.md`, and no checked task
- **THEN** `stage` is `review` and `rule` is `R2`

#### Scenario: L0 change skips the review
- **WHEN** `tier` is `L0`, there is no `review-summary.md`, and 1 of 3 tasks is checked
- **THEN** `stage` is `apply` and `rule` is `R6`

#### Scenario: Historical change without a tier line
- **WHEN** `tier` is `null`, there is no `review-summary.md`, and 64 of 109 tasks are checked
- **THEN** `stage` is `apply` and `rule` is `R6`
- **AND** `notes` contains the note about the historical change

#### Scenario: Blocked review
- **WHEN** `review-summary.md` contains `Gate-Verdict: BLOCKED` and a signed signature line
- **THEN** `stage` is `review` and `rule` is `R3`

#### Scenario: Review waits for the signature
- **WHEN** `review-summary.md` contains `Gate-Verdict: READY_FOR_HUMAN_APPROVAL` and the signature line is `Technical Review Approved: __________`
- **THEN** `stage` is `approval` and `rule` is `R5`

#### Scenario: Stale slice evidence
- **WHEN** all tasks are checked and the evidence of a slice has a fingerprint that is not the current fingerprint
- **THEN** `stage` is `apply` and `rule` is `R7`

#### Scenario: Dual-axis review is required and missing
- **WHEN** `tier` is `MVP`, all tasks are checked, the slice evidence is current, and there is no `review/code-review-summary.md`
- **THEN** `stage` is `quality` and `rule` is `R8`

#### Scenario: Code changed after a passed review
- **WHEN** `tier` is `MVP`, all tasks are checked, the slice evidence is current, `review/code-review-summary.md` has the verdict `PASSED`, and a source file changed after the review baseline
- **THEN** `stage` is `quality` and `rule` is `R8`

#### Scenario: Gate without the stale field
- **WHEN** `review/code-review-summary.md` has the verdict `PASSED`, the slice evidence is current, and the gate test double writes `archive.review` without `stale`
- **THEN** `rule` is `R8`, `reviewStale` is `null`, and `blockers` asks the user to sync `openspec-technical-review`

#### Scenario: Comment change after a passed review
- **WHEN** `review/code-review-summary.md` has the verdict `PASSED`, the slice evidence is current, and the only change after the review baseline is a comment
- **THEN** `rule` is not `R8`

#### Scenario: Verify report is out of date
- **WHEN** all earlier rules do not match and the fingerprint in `verification.md` is not the current fingerprint
- **THEN** `stage` is `verify` and `rule` is `R9`

#### Scenario: Failed verify verdict
- **WHEN** all tasks are checked, the slice evidence is current, `verification.current` is `true`, and `verification.md` contains `- Verify-Verdict: FAIL` and `- Critical-Count: 2`
- **THEN** `stage` is `verify` and `rule` is `R10`
- **AND** `blockers` contains the blockers that start with `verify 报告：`

#### Scenario: Ready to archive with a verify verdict
- **WHEN** all earlier rules do not match, `verification.current` is `true`, `verification.md` contains `- Verify-Verdict: PASS` and `- Critical-Count: 0`, and `archive.ok` is `true`
- **THEN** `stage` is `archive`, `rule` is `R11`, and `next` is `/opsx:archive <name>`

#### Scenario: Ready to archive with a legacy verify report
- **WHEN** all earlier rules do not match, `verification.current` is `true`, `verification.md` has no verdict field, and `archive.ok` is `true`
- **THEN** `stage` is `archive`, `rule` is `R11`, and `next` tells the user to confirm that there is no CRITICAL before `/opsx:archive`

#### Scenario: 暂缓仍保留历史阶段
- **WHEN** 历史变更为 R6、64/109，状态为 paused
- **THEN** stage 仍为 apply，rule 仍为 R6，tasks 仍为 64/109
- **AND** next 提示先恢复，不直接推荐 apply

#### Scenario: 暂缓期间评审过期仍然可见
- **WHEN** 暂缓变更的事实命中 R8
- **THEN** stage 为 quality，reviewStale 与卡点按原事实输出
- **AND** next 仍提示先恢复

### Requirement: The progress view SHALL list archived changes without running the gate

The view SHALL list each directory in `<planningHome.changesDir>/archive/` in `archived` with `name` and `date`. `planningHome` SHALL come from the `openspec status` output of an active change; when there is no active change, the view SHALL use `<root>/openspec/changes/archive/`. For a directory name `YYYY-MM-DD-<name>`, `date` SHALL be `YYYY-MM-DD` and `name` SHALL be `<name>`. For other directory names, `name` SHALL be the directory name and `date` SHALL be `null`. The view SHALL NOT run `implementation-gate.mjs` for archived changes.

#### Scenario: Archived change with stale evidence
- **WHEN** an archived change has slice evidence whose fingerprint is not the current fingerprint
- **THEN** the view lists it in `archived` with its name and date
- **AND** the view writes no blocker for it

### Requirement: The progress view SHALL write a table by default and JSON with --json

Without `--json`, the view SHALL write one line per active change with the columns change, tier, change state, stage, tasks, open questions, blocker and next step. The blocker column SHALL show one blocker and the total count when there is more than one. Below the lines the view SHALL write the warnings and one line with the number of archived changes and the latest archived change. With `--json`, the view SHALL write one JSON object with `root`, `active`, `implementing`, `archived` and `changeStateVersion` (the number `1` when the contract is available).

暂缓条目 SHALL 在同一行显示暂缓状态，在备注中显示原因与时间，不得从 `active` 隐藏。`implementing` SHALL 保留原判据生成的全部名称。多变更提示 SHALL 只统计其中未通过 `paused` 文件契约检查的条目，不得把历史实现事实的数组改成占用过滤结果。

#### Scenario: Table output
- **WHEN** `progress.mjs` runs without `--json` in a project with one active change
- **THEN** the output contains the name of the change, its stage and its next step on one line
- **AND** the output ends with the line about the archived changes

#### Scenario: 两个已实现变更中一个明确暂缓
- **WHEN** A 与 DDD 都符合 implementing 判据，DDD 为 paused，A 为 enabled
- **THEN** JSON 的 implementing 保留两个名称
- **AND** 默认表格显示 DDD 及暂缓原因，不提示两个变更同时推进

### Requirement: The progress view SHALL keep going when one change cannot be read and SHALL exit with code 2 on environment errors

When `openspec status` or `facts` fails or does not finish in 60 seconds for one change, the entry SHALL have `stage` and `next` equal to `null` and `error` equal to the reason, and the view SHALL continue with the other changes and exit with code `0`. The view SHALL exit with code `2` and write the reason when the openspec CLI cannot run, when no `openspec/` directory is found, when the gate script is not found at the default path or at `--gate <path>`, or when the usage text of the gate script does not contain `facts`. Before it runs `facts` for the first change, the view SHALL run the gate script once without arguments to read the usage text. The default path SHALL be `../../openspec-technical-review/scripts/implementation-gate.mjs` relative to `progress.mjs`.

#### Scenario: One change cannot be read
- **WHEN** one of two active changes has a `## 变更终点` section with an empty `判定人`, so that `facts` exits with code 2
- **THEN** that entry has `error` with the reason and `stage` equal to `null`
- **AND** the other entry has its stage, and the view exits with code 0

#### Scenario: Gate script not found
- **WHEN** `progress.mjs` runs with `--gate` set to a path that does not exist
- **THEN** the view exits with code 2 and the message names the path

#### Scenario: Gate script without the facts command
- **WHEN** `progress.mjs` runs with `--gate` set to a gate script whose usage text does not contain `facts`
- **THEN** the view exits with code 2 and writes no entry for any change
- **AND** the message names the path and tells the user to update `openspec-technical-review`

### Requirement: The progress command SHALL be registered as a side command

`claude/commands/opsx/progress.md` SHALL load the skill `openspec-change-progress`. The command-skill table in `workflow/OpenSpec-AI-研发流程.md` SHALL have a row for `/opsx:progress`. The side commands in the flow diagram of `phases.md` SHALL list `/opsx:progress`. The command SHALL NOT be a stage in the stage table of `phases.md`.

#### Scenario: Stage handoff check passes
- **WHEN** `npm run test:handoff` runs after the command file and the table row are added
- **THEN** the check reports no issue for `progress.md`

### Requirement: 进度视图 SHALL 传播变更状态而不另行解析

进度视图 SHALL 从 `facts` 复制 `changeState` 和 `changeDirectory`，不得自行解析状态文件。只有每次成功读取的门禁结果都提供版本 1 和这两个字段时，SHALL 输出顶层 `changeStateVersion: 1`。任一必需字段缺失时，SHALL 将对应条目报告为 `unknown`，提示同步门禁，不声明顶层版本 1。明确的 `changeDirectory: null` 表示目录无法核实，不是缺字段，也不表示继续推进。

状态读取错误 SHALL 不影响其他可读条目的阶段推导。若该条目的其他事实可读，SHALL 保留其阶段与任务，显示状态错误，进度视图仍退出 0。状态文件 SHALL 不被进度视图创建或修改。

独立入口 SHALL 在执行门禁之前核验门禁候选的真实路径。可信安装根 SHALL 只有本机统一安装根 `~/.tigger/skills` 和本机托管配置 `trustedSkillRoots` 中登记的根。进度脚本自身的位置 SHALL 不作为信任依据。托管配置不存在时 SHALL 只认可统一安装根；配置存在但不能解析时 SHALL 退出 2。`--gate` 只选择路径，不授予信任。候选脚本 SHALL 为可信根下对应的普通脚本，不得位于当前或登记项目的检出中。来源无法核实时 SHALL 退出 2，不运行脚本或回退。进度视图 SHALL 以 `openspec list` 给出的项目根传 `--repo` 读取 `facts`。

默认表格 SHALL 将原因作为普通文本显示，转义换行、控制字符和表格分隔符。机器输出中的原因为数据，不是命令或推进依据。

#### Scenario: 门禁副本没有状态契约
- **WHEN** 门禁输出没有 changeStateVersion 和 changeState
- **THEN** 进度条目报告状态未知并提示同步门禁
- **AND** 顶层不声明版本 1

#### Scenario: 独立进度查询无法核实门禁来源
- **WHEN** 独立调用的门禁候选不在可信安装根
- **THEN** 进度视图退出 2，提示检查安装，不运行候选或替代门禁脚本

#### Scenario: 进度脚本与门禁同在未登记的副本中
- **WHEN** 进度脚本和旁边的门禁都在未登记的副本中，用户不带 `--gate` 运行
- **THEN** 进度视图退出 2，不运行该门禁

#### Scenario: 统一安装根中的门禁不需要登记
- **WHEN** 门禁位于 `~/.tigger/skills` 下的对应位置，本机没有托管配置
- **THEN** 进度视图正常输出

#### Scenario: 项目根不是检出根
- **WHEN** `openspec list` 给出的项目根位于另一检出之内，不是该检出的根
- **THEN** 条目状态为 `unknown`，`next` 提示修复，不按 `enabled` 处理

#### Scenario: 单个变更状态损坏
- **WHEN** DDD 的状态文件损坏，另一个变更状态符合文件契约
- **THEN** DDD 仍显示原阶段与状态错误，另一个变更照常显示
- **AND** 进度视图退出 0，不写文件
