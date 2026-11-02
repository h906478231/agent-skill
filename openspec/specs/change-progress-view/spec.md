# change-progress-view Specification

## Purpose
进度视图为每个活跃变更推导阶段、卡点与下一步命令，输出终端表格或 JSON。已归档变更只列出名称与日期，不运行门禁。
## Requirements
### Requirement: The progress view SHALL list the active changes of the current project

`progress.mjs` SHALL read the active changes and the project root from `openspec list --json`, and the completeness of the planning artifacts and the change root from `openspec status --change <name> --json`. It SHALL run the openspec CLI with `OPENSPEC_TELEMETRY=0` and a timeout of 60 seconds. For each active change it SHALL run `implementation-gate.mjs facts <changeRoot>` in the working directory of the view, without `--repo`, with a timeout of 60 seconds. It SHALL write one entry per active change with `change`, `tier`, `stage`, `tasks` (`done`, `total` from `completedTasks`, `totalTasks`), `openQuestions`, `rule`, `blockers`, `warnings`, `notes`, `next` and `error`. It SHALL NOT write files in the change directories and SHALL NOT run git commands that write refs, the index or the work tree.

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
| R8 | `archive.review.applicable` is `true` and `archive.review.verdict` is not `PASSED` | `quality` | `/opsx:quality <name>` |
| R9 | `verification.exists` is `false` or `verification.current` is not `true` | `verify` | `/opsx:verify <name>` |
| R10 | `archive.ok` is `false` | `verify` | fix the blocker, then `/opsx:verify <name>` |
| R11 | all other cases | `archive` | confirm that `verification.md` has no CRITICAL, then `/opsx:archive <name>` |

The entry SHALL contain the rule ID in `rule`. When `tier` is `null` and `tasks.done` is greater than 0, the entry SHALL contain a note that the change has no tier line and is handled as a historical change. `archive.warnings` SHALL be copied to `warnings` and SHALL NOT change the rule.

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

#### Scenario: Verify report is out of date
- **WHEN** all earlier rules do not match and the fingerprint in `verification.md` is not the current fingerprint
- **THEN** `stage` is `verify` and `rule` is `R9`

#### Scenario: Ready to archive
- **WHEN** all earlier rules do not match, `verification.current` is `true`, and `archive.ok` is `true`
- **THEN** `stage` is `archive`, `rule` is `R11`, and `next` tells the user to confirm that there is no CRITICAL before `/opsx:archive`

### Requirement: The progress view SHALL list archived changes without running the gate

The view SHALL list each directory in `<planningHome.changesDir>/archive/` in `archived` with `name` and `date`. `planningHome` SHALL come from the `openspec status` output of an active change; when there is no active change, the view SHALL use `<root>/openspec/changes/archive/`. For a directory name `YYYY-MM-DD-<name>`, `date` SHALL be `YYYY-MM-DD` and `name` SHALL be `<name>`. For other directory names, `name` SHALL be the directory name and `date` SHALL be `null`. The view SHALL NOT run `implementation-gate.mjs` for archived changes.

#### Scenario: Archived change with stale evidence
- **WHEN** an archived change has slice evidence whose fingerprint is not the current fingerprint
- **THEN** the view lists it in `archived` with its name and date
- **AND** the view writes no blocker for it

### Requirement: The progress view SHALL write a table by default and JSON with --json

Without `--json`, the view SHALL write one line per active change with the columns change, tier, stage, tasks, open questions, blocker and next step. The blocker column SHALL show one blocker and the total count when there is more than one. Below the lines the view SHALL write the warnings and one line with the number of archived changes and the latest archived change. With `--json`, the view SHALL write one JSON object with `root`, `active` and `archived`.

#### Scenario: Table output
- **WHEN** `progress.mjs` runs without `--json` in a project with one active change
- **THEN** the output contains the name of the change, its stage and its next step on one line
- **AND** the output ends with the line about the archived changes

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
