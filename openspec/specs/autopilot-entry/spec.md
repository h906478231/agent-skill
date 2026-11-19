# autopilot-entry Specification

## Purpose
托管入口：`/opsx:autopilot` 从 apply 阶段起托管变更与撤回托管、前置条件、托管记录，以及门禁脚本把 `decisions/` 等托管文件当作产物接受。

## Requirements

### Requirement: The autopilot command SHALL hand over a change only from the apply stage onward

`autopilot.mjs start <name>` SHALL read the entry of the change from `progress.mjs --json`. It SHALL accept the change only when `rule` is one of `R6` to `R11`. On acceptance it SHALL create `decisions/autopilot.json` in the change directory with `status` `active`, `startedAt`, `rule` and `tier`, and SHALL print a reminder that the user does not edit the same repository while the change is under autopilot. When `rule` is one of `R1` to `R5`, it SHALL exit with code 1, print the rule and its `blockers`, and SHALL NOT write files. When the change already has an autopilot record with `status` `active` or `exiting`, it SHALL exit with code 1 and SHALL NOT change the record. One checkout SHALL implement one change at a time (`phases.md`「同一检出只实现一个变更」): when the `implementing` list of the progress view has another change, or another active change of the same project has an autopilot record with `status` `active` or `exiting`, it SHALL exit with code 1, print the names of those changes, and SHALL NOT write files. When the progress view has no active change with this name, it SHALL exit with code 2.

When the output of the progress view has no `implementing` array, `autopilot.mjs start` SHALL exit with code 2, print that the copy of `openspec-change-progress` needs to be synced, and SHALL NOT write files. When the progress entry of the change has no key `reviewStale`, or `reviewStale` is `null`, it SHALL exit with code 2, print that the copies of `openspec-change-progress` and `openspec-technical-review` need to be synced together, and SHALL NOT write files. When the current branch (`git symbolic-ref --short HEAD`) is not the `baseBranch` of the project, it SHALL exit with code 1, print the current branch, and SHALL NOT write files. When `git config user.name` of the project is empty, it SHALL exit with code 1, print `user.name`, and SHALL NOT write files. When the autopilot record has `status` `void`, it SHALL first set each decision with `status` `pending` or `answered` to `void` with `voidReason` `上一次托管遗留`, print each item of `request.checkFailures` of these decisions (the file, the finding ID or the field, and the values before and after the run), then write the record again with only `status` `active`, a new `startedAt`, `rule` and `tier`, without the `implSnapshot` and `exit` of the earlier autopilot. When `run.lock` names this change and the lock is not stale (the rule of spec `autopilot-scheduler`), it SHALL exit with code 1, print that the stage is still stopping, and SHALL NOT change the record.

#### Scenario: Signed change is handed over
- **WHEN** the change has a signed `review-summary.md` and the progress view gives rule `R6`
- **THEN** `autopilot.mjs start` exits with code 0
- **AND** `decisions/autopilot.json` has `status` `active` and `rule` `R6`

#### Scenario: Change without a technical review is handed over
- **WHEN** `overview.md` has the tier line `L0`, the change has no `review-summary.md`, and the progress view gives rule `R6`
- **THEN** `autopilot.mjs start` exits with code 0 and writes `decisions/autopilot.json`

#### Scenario: Unsigned change is rejected
- **WHEN** the progress view gives rule `R5` with the blocker `签字行空白`
- **THEN** `autopilot.mjs start` exits with code 1 and prints `R5` and `签字行空白`
- **AND** the change directory has no `decisions/` directory

#### Scenario: Second start is rejected
- **WHEN** `decisions/autopilot.json` has `status` `active`
- **THEN** `autopilot.mjs start` exits with code 1 and the record is unchanged

#### Scenario: Change in a checkout with another implementing change is rejected
- **WHEN** the progress view gives rule `R6` for the change and lists `other-change` in `implementing`
- **THEN** `autopilot.mjs start` exits with code 1 and prints `other-change`
- **AND** the change directory has no `decisions/` directory

#### Scenario: Second change of the same project is rejected
- **WHEN** `other-change` of the same project has `decisions/autopilot.json` with `status` `active` and is not in `implementing`
- **THEN** `autopilot.mjs start` exits with code 1 and prints `other-change`

#### Scenario: Unknown change is an argument error
- **WHEN** the progress view has no active change named `no-such-change`
- **THEN** `autopilot.mjs start no-such-change` exits with code 2 and writes no file

#### Scenario: Progress view without implementing is an environment error
- **WHEN** the progress view gives rule `R6` for the change and its output has `active` and `archived` but no `implementing`
- **THEN** `autopilot.mjs start` exits with code 2 and prints `openspec-change-progress`
- **AND** the change directory has no `decisions/` directory

#### Scenario: Change on another branch is rejected
- **WHEN** the progress view gives rule `R6`, the `baseBranch` of the project is `main`, and the current branch is `fix/a`
- **THEN** `autopilot.mjs start` exits with code 1 and prints `fix/a`
- **AND** the change directory has no `decisions/` directory

#### Scenario: Missing git user name is rejected
- **WHEN** the progress view gives rule `R6` and `git config user.name` of the project is empty
- **THEN** `autopilot.mjs start` exits with code 1 and prints `user.name`
- **AND** the change directory has no `decisions/` directory

#### Scenario: Cancelled change is handed over again
- **WHEN** `decisions/autopilot.json` has `status` `void` and `startedAt` `2026-11-06T10:00:00Z`, the progress view gives rule `R6`, and `run.lock` does not exist
- **THEN** `autopilot.mjs start` exits with code 0
- **AND** the record has `status` `active` and a `startedAt` later than `2026-11-06T10:00:00Z`

#### Scenario: Hand over while the cancelled stage still runs is rejected
- **WHEN** `decisions/autopilot.json` has `status` `void`, and `run.lock` names the change with the process id of a live process and the current boot time
- **THEN** `autopilot.mjs start` exits with code 1 and the record is unchanged

#### Scenario: New handover voids leftover decisions
- **WHEN** `decisions/autopilot.json` has `status` `void` and an `implSnapshot`, `decisions/D-0006.json` has `status` `pending`, the progress view gives rule `R6`, and `run.lock` does not exist
- **THEN** `autopilot.mjs start` exits with code 0, and `D-0006.json` has `status` `void` with `voidReason` `上一次托管遗留`
- **AND** the record has `status` `active` and no `implSnapshot`

#### Scenario: New handover lists the check failures of a leftover alert
- **WHEN** `decisions/autopilot.json` has `status` `void`, and the session alert decision `D-0007` has `status` `pending` and a `request.checkFailures` item for `STD-02`
- **THEN** `autopilot.mjs start` exits with code 0, `D-0007.json` has `status` `void`, and the output names `STD-02`

#### Scenario: Progress entry without reviewStale is an environment error
- **WHEN** the progress view gives rule `R6` for the change and its entry has no key `reviewStale`
- **THEN** `autopilot.mjs start` exits with code 2, prints both skill names, and does not write files

### Requirement: The autopilot command SHALL cancel an autopilot and stop its running stage without deleting files

`autopilot.mjs cancel <name>` and `autopilot.mjs status <name>` SHALL locate the change directory by the change name in the `active` and `archived` lists of the progress view, in the same way as spec `autopilot-scheduler`. `cancel` SHALL set the autopilot record from `active` or `exiting` to `void` with `voidReason` `用户撤回`, and SHALL set every decision with `status` `pending` or `answered` to `void`. Each write SHALL compare the current `status` with the expected statuses before it writes, and SHALL write a temporary file that replaces the file by rename. When the record already has `status` `void`, `cancel` SHALL NOT write files and SHALL run the steps for `run.lock` below. When the record has another status or does not exist, it SHALL exit with code 1 and SHALL NOT change files.

After the record is `void`, `cancel` SHALL read `run.lock` in the autopilot home. When the lock names this change and is not stale (the rule of spec `autopilot-scheduler`), it SHALL wait at most `cancelWaitSeconds` (configuration key, default 30) for the lock to be removed. When `claudePid` is alive, it SHALL first send `SIGTERM` to the process group of `claudePid`. When `claudePid` is `null`, it SHALL send no signal. While it waits, it SHALL read `run.lock` again every 200 milliseconds, and SHALL send `SIGTERM` to the process group of `claudePid` once when `claudePid` changes from `null` to a live process. When the lock is removed, when the lock is stale, or when the lock does not name this change, it SHALL read the autopilot record again; when `startedAt` equals the value read before the cancel and `status` is not `void`, it SHALL set the record and the open decisions to `void` again. Then it SHALL exit with code 0. It SHALL exit with code 1 and print that the autopilot is cancelled and the stage is still stopping when the wait ends. It SHALL NOT delete files. `status` SHALL print the record, the number of decisions for each `status`, and whether a stage of this change is running.

#### Scenario: Cancel voids open decisions
- **WHEN** the autopilot is `active`, no stage runs, and `decisions/D-0002.json` has `status` `pending`
- **THEN** after `autopilot.mjs cancel` the record has `status` `void` and `D-0002.json` has `status` `void`
- **AND** both files still exist

#### Scenario: Status counts the decisions
- **WHEN** the change has one `used` decision and one `pending` decision
- **THEN** `autopilot.mjs status` prints the record and the counts `used: 1` and `pending: 1`

#### Scenario: Cancel stops a running stage
- **WHEN** `run.lock` names the change, and its `pid` and `claudePid` are a live test process that removes `run.lock` and exits on `SIGTERM`
- **THEN** the test process receives `SIGTERM`
- **AND** `autopilot.mjs cancel` exits with code 0 after `run.lock` is removed, and the record has `status` `void`

#### Scenario: Cancel reports a stage that does not stop
- **WHEN** `run.lock` names the change, its `claudePid` is a live test process that ignores `SIGTERM`, and `cancelWaitSeconds` is 1
- **THEN** `autopilot.mjs cancel` exits with code 1 and prints that the stage is still stopping
- **AND** the record has `status` `void`

#### Scenario: Cancel waits for the scheduler without a claude process
- **WHEN** `run.lock` names the change with `claudePid` `null`, and its `pid` is a live test process that removes `run.lock` after 1 second
- **THEN** the test process receives no signal
- **AND** `autopilot.mjs cancel` exits with code 0 after `run.lock` is removed

#### Scenario: Cancel signals a claude process that starts during the wait
- **WHEN** `run.lock` names the change with `claudePid` `null`, and after 1 second a live test process is written to `claudePid` that removes `run.lock` and exits on `SIGTERM`
- **THEN** the test process receives `SIGTERM`
- **AND** `autopilot.mjs cancel` exits with code 0 after `run.lock` is removed

#### Scenario: Cancel of a void record still stops the stage
- **WHEN** `decisions/autopilot.json` has `status` `void`, and `run.lock` names the change with a live `claudePid` that removes `run.lock` and exits on `SIGTERM`
- **THEN** the test process receives `SIGTERM` and `autopilot.mjs cancel` exits with code 0
- **AND** no file of the change directory is changed

#### Scenario: Cancel voids again a record written back by the scheduler
- **WHEN** the scheduler writes `{status: active, rerunStage: quality}` with the same `startedAt` after the cancel wrote `void`, and then releases `run.lock`
- **THEN** `autopilot.mjs cancel` exits with code 0, and the autopilot record has `status` `void`

#### Scenario: Cancel of an exiting change finds the archive directory
- **WHEN** the change is in the `archived` list of the progress view, and `decisions/autopilot.json` in its archive directory has `status` `exiting`
- **THEN** `autopilot.mjs cancel` exits with code 0 and that record has `status` `void`

### Requirement: The gate script SHALL accept the autopilot files as artifacts

`implementation-gate.mjs hygiene <changeRoot>` SHALL report no warning for `decisions/autopilot.json` and for files that match `decisions/D-<four digits>.json`. Other files under `decisions/` SHALL be reported as files outside the allowlist.

#### Scenario: Autopilot files pass hygiene
- **WHEN** the change directory contains `decisions/autopilot.json` and `decisions/D-0001.json`
- **THEN** `hygiene` reports no warning for these files

#### Scenario: Other file under decisions is reported
- **WHEN** the change directory contains `decisions/notes.md`
- **THEN** `hygiene` reports one warning for that file
