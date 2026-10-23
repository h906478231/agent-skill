# task-phase-boundary Specification

## Purpose
任务与阶段边界：任务勾选项只包含归档前可完成、有可检查交付物的工作，阶段动作、登记记录、发布动作等排除项各有固定去处；门禁脚本报告等待阶段结果或要求 git 写操作的任务，归档后的发布工作记录在验收部署文档 `deployment.md`。
## Requirements
### Requirement: Task checkboxes SHALL contain only work that can finish before archive

A checkbox in `tasks.md` SHALL satisfy all four conditions:

- The developer or the agent of this change does the work.
- The work happens in this repository, or in a test or pre-release environment that is available before release.
- The work can finish before archive and does not wait for the result of a workflow phase.
- The work produces a deliverable that a reviewer can check: code, a test, SQL, a configuration file, a document in the repository or in the change directory, or an evidence file.

`task-slicing.md` SHALL keep an exclusion list. Each category SHALL have a destination:

| ID | Content that is not a task | Destination |
|---|---|---|
| E1 | Phase actions: run quality, verify, overview or archive, run `openspec validate`, do the technical review | The next-step hint at the end of each phase, in the order of `phases.md` |
| E2 | Checks that a phase rule already requires: a separate full regression, a self-review against the standards, a technical review before apply | The phase rule. The tests of one task go into the completion standard of that task |
| E3 | Edits of planning artifacts: proposal, specs, design, overview | `/opsx:update` |
| E4 | Open decisions and design inputs: refine, finalize, evaluate, choose a strategy, collect data for a design parameter | The Open Questions of `design.md`, or explore and grill before propose |
| E5 | Registrations and records: commits outside the gate, risk acceptance, sign-off | The registration table of post-implementation changes, Risk Accepted of `design.md`, the sign-off line of `review-summary.md` |
| E6 | Release actions: merge, deploy, gray release, SQL or data fixes in production | `deployment.md` |
| E7 | Observation after release, and removal of an old entry point after its traffic stops | `deployment.md`. The removal is a new change |
| E8 | Work of other people or of external systems: alert configuration by operations, notices to third parties, team knowledge bases, task trackers, commit, push, pull requests | Hand-over items of `deployment.md` with an owner. Commit, push and write-back need a separate authorization of the user |
| E9 | Confirmations without a deliverable, such as "X is not affected" | A test, or the completion standard of the task that can affect X |

When one task contains both work and content from the list, the author SHALL split the task and SHALL move the content to its destination. `/opsx:propose`, `/opsx:ff` and `/opsx:update` SHALL check new and changed tasks against the list. The questions before `tasks.md` becomes final SHALL include the question whether a task contains content from the list.

A verification in a test or pre-release environment is a task. Its slice SHALL declare `Environment:`.

During its manual check, verify SHALL report a WARNING for each task that matches the list. The WARNING SHALL name the category and the destination.

#### Scenario: Phase action becomes a next-step hint
- **WHEN** the author writes the tasks of a change
- **THEN** no task asks to run `/opsx:quality` or `/opsx:verify`
- **AND** apply shows these commands as the next step after the last task

#### Scenario: Technical review before apply is not a task
- **WHEN** the change uses the technical review gate
- **THEN** no task asks to do the technical review before apply
- **AND** apply reads the verdict and the sign-off line of `review-summary.md`

#### Scenario: Mixed task is split
- **WHEN** a task asks to write the release steps and to configure alerts on the log platform
- **THEN** the task keeps the release steps
- **AND** the alert configuration becomes a hand-over item of `deployment.md`

#### Scenario: Verify reports a task from the list
- **WHEN** a checked task says "confirm that the rollback semantics do not change" and has no test
- **THEN** verify reports a WARNING with category E9 and the destination

### Requirement: The gate script SHALL report tasks that wait for a phase or ask for a git write

`implementation-gate.mjs evidence` SHALL report in the list `taskIssues` each unchecked checkbox that matches one of these patterns:

- `phase-action`: a run verb before `/opsx:quality`, `/opsx:verify`, `/opsx:overview`, `/opsx:archive`, `openspec archive` or `openspec validate`, or one of these commands before "通过后" or "完成后".
- `git-action`: a run verb before `git commit` or `git push`.

The script SHALL NOT report a match that follows a negation in the same clause. A negation SHALL be a word that negates the run action: "不运行", "不执行", "不重跑", "不在", "不要", "不得", "不必", "无需", "禁止", or the whole English words "never" and "not". A negation SHALL start before the match and MAY contain the run verb of the match, as in "不执行". The words "不必要" and "不得不" SHALL NOT count as a negation. The single character "不" inside a common word such as "不同", "不再" or "不变" SHALL NOT count as a negation. The script SHALL NOT report a checkbox that only names the file of a phase skill or a command. The script SHALL compute `taskIssues` also when slice evidence is not applicable. Each entry SHALL contain the task ID, the kind and the matched text.

Verify SHALL report each entry as CRITICAL. The fix SHALL be to rewrite the task and to move the content to its destination. The fix SHALL NOT be to wait for the phase action or to run the git command.

#### Scenario: Task that waits for verify is reported
- **WHEN** the unchecked task 9.4 says that the agent runs `/opsx:verify` and checks the task after verify passes
- **THEN** `evidence` reports a task issue of kind `phase-action` for 9.4
- **AND** verify reports it as CRITICAL and asks the agent to rewrite the task

#### Scenario: Task that asks to push is reported
- **WHEN** an unchecked task says "执行 `git push` 推送分支"
- **THEN** `evidence` reports a task issue of kind `git-action` for that task

#### Scenario: Negated git command is not reported
- **WHEN** an unchecked task says "写明记录证据时不执行 `git commit`"
- **THEN** `evidence` reports no task issue for it

#### Scenario: Common word with 不 does not hide a phase action
- **WHEN** an unchecked task asks the agent to add tests for different cases ("不同场景") and then run `/opsx:verify`
- **THEN** `evidence` reports a task issue of kind `phase-action` for that task

#### Scenario: Word that starts with 不必 or 不得 does not hide a phase action
- **WHEN** an unchecked task asks the agent to delete unnecessary logs ("不必要的日志") and then run `/opsx:verify`
- **THEN** `evidence` reports a task issue of kind `phase-action` for that task

#### Scenario: Checked task that names a phase action is ignored
- **WHEN** a checked task mentions `/opsx:verify`
- **THEN** `evidence` reports no task issue for it

#### Scenario: Task that edits a phase skill file is not reported
- **WHEN** an unchecked task says that the agent edits step 9 of `openspec-verify-change/SKILL.md`
- **THEN** `evidence` reports no task issue for it

#### Scenario: Flat task list is still checked
- **WHEN** `tasks.md` has no slices and an unchecked task asks to run `/opsx:overview`
- **THEN** `evidence` returns `applicable: false`
- **AND** `taskIssues` contains that task

### Requirement: Release work after archive SHALL be recorded in the acceptance deployment document

A change SHALL have `deployment.md` in its change directory when the Migration Plan of `design.md` has a step in production, or when Risk Accepted of `design.md` has a re-check condition after release. Other changes SHALL NOT need the file.

`deployment.md` SHALL have four sections: release checks, deploy and rollback, acceptance after release, and hand-over items. Each section SHALL use a table with an owner column and a status column. The file SHALL NOT use checkboxes. Each item of the acceptance after release SHALL state the metric, the observation window, the pass condition and the action when the condition fails. When a slice is pending an environment, its re-test plan SHALL be an item of the release checks.

Writing `deployment.md` SHALL be a task. Doing its items SHALL NOT be a task. Archive SHALL NOT require that its items are done. Verify SHALL report a WARNING for each item without an owner or a pass condition. Verify SHALL also report a WARNING when the change needs the file and does not have it. The verify report SHALL refer to `deployment.md` and SHALL NOT repeat its items.

`deployment.md` SHALL refer to the evidence files for pre-release verification that is already done, and SHALL NOT copy the results. Content that operations need for a long time, such as the meaning of parameters and the steps to examine an alert, SHALL go to the documents of the project. The person who does an item after archive SHALL record the result in the system that this person uses, not in the archived change directory. A result that fails its pass condition and needs a code change SHALL start a new change.

#### Scenario: Observation after release goes to the deployment document
- **WHEN** Risk Accepted of `design.md` requires three days of production metrics after release
- **THEN** `/opsx:propose` writes a task to write `deployment.md`
- **AND** no task asks for the observation
- **AND** `deployment.md` lists the observation in the acceptance after release with an owner and a pass condition

#### Scenario: Archive does not wait for release items
- **WHEN** every task is checked and an item of the acceptance after release has the status 未开始
- **THEN** archive does not block on that item

#### Scenario: Item without an owner is a warning
- **WHEN** a hand-over item of `deployment.md` has an empty owner cell
- **THEN** verify reports a WARNING that names the item

#### Scenario: Change without production steps needs no document
- **WHEN** the Migration Plan has no step in production and Risk Accepted has no re-check condition after release
- **THEN** verify reports no issue about `deployment.md`
