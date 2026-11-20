# autopilot-entry Specification

## Purpose
托管入口：`/opsx:autopilot` 从 apply 阶段起托管变更与撤回托管、前置条件、托管记录，以及门禁脚本把 `decisions/` 等托管文件当作产物接受。

## Requirements

### Requirement: The autopilot command SHALL hand over a change only from the apply stage onward

`autopilot.mjs start <name>` SHALL first select a configured project by the management project rule of spec `autopilot-scheduler`, then read its active entry from `progress.mjs --json`. It SHALL accept the change only when `rule` is one of `R6` to `R11`. On acceptance it SHALL create `decisions/autopilot.json` in the change directory with `status` `active`, `startedAt`, `rule` and `tier`, and SHALL print a reminder that the user does not edit the same repository while the change is under autopilot. When `rule` is one of `R1` to `R5`, it SHALL exit with code 1, print the rule and its `blockers`, and SHALL NOT write files. When the change already has an autopilot record with `status` `active` or `exiting`, it SHALL exit with code 1 and SHALL NOT change the record. One checkout SHALL implement one change at a time (`phases.md`「同一检出只实现一个变更」): when the `implementing` list of the progress view has another change, or another active change of the same project has an autopilot record with `status` `active` or `exiting`, it SHALL exit with code 1, print the names of those changes, and SHALL NOT write files. When the progress view has no active change with this name, it SHALL exit with code 2.

When the output of the progress view has no `implementing` array, `autopilot.mjs start` SHALL exit with code 2, print that the copy of `openspec-change-progress` needs to be synced, and SHALL NOT write files. When the progress entry of the change has no key `reviewStale`, or `reviewStale` is `null`, it SHALL exit with code 2, print that the copies of `openspec-change-progress` and `openspec-technical-review` need to be synced together, and SHALL NOT write files. When the current branch (`git symbolic-ref --short HEAD`) is not the `baseBranch` of the project, it SHALL exit with code 1, print the current branch, and SHALL NOT write files. When `git config user.name` of the project is empty, it SHALL exit with code 1, print `user.name`, and SHALL NOT write files. When the selected record has `status` `void`, `start` SHALL use the shared project protection to check the previous batch's complete decision list. It SHALL set each remaining `pending` or `answered` decision to `void` with `voidReason` `上一次托管遗留` and print the verified `request.checkFailures` items of those decisions. An incomplete list or a failed write SHALL leave the old record unchanged and return a nonzero result. Only after it proves that no old open decision remains SHALL it write `status` `active` with a new `startedAt`, `rule` and `tier`, without the earlier batch's `implSnapshot`, `exit`, or handoff data. A retry SHALL NOT rewrite decisions already voided.

Under the shared project protection, before legacy decision cleanup or publication, `start` SHALL check the saved `returnHandoff` IDs of all same-project, same-name candidates, including `void` archives. It SHALL apply the terminal handoff verification in `autopilot-scheduler`. If any referenced alert is still `answered` or cannot be verified as `used`, `start` SHALL return nonzero and retain that batch and decision. Once verified complete, that handoff no longer blocks the other admission checks.

Before admission, a live lock has to be verified for the selected project and batch. A verified same-batch lock or an unknown lock that cannot be excluded SHALL fail start with code 1 and leave the record unchanged. A verified lock for another project or batch SHALL NOT reject start on its own; the same-checkout and pending-check guards still apply.

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
- **WHEN** `decisions/autopilot.json` has `status` `void`, and `run.lock` verifies a live instance of the same project and batch
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

#### Scenario: A different project's same-name lock does not reject start
- **WHEN** the working directory belongs to the configured project of the selected change and a verified live lock belongs to a different project with the same change name
- **THEN** start applies its other checks and does not reject because of that lock

#### Scenario: A new handover waits for a previous return to the session
- **WHEN** a same-name `void` batch, including one in an archive, names a verified `answered` return-to-session alert and `start` obtains project protection before the scheduler completes it
- **THEN** `start` returns nonzero and leaves the previous batch and its alert unchanged
- **AND** after the scheduler completes and verifies that same alert as `used`, a new attempt proceeds through the other admission checks

#### Scenario: Failed leftover cleanup keeps the previous batch
- **WHEN** the selected previous record is `void` and its decisions cannot be completely listed or one open decision cannot be voided
- **THEN** start returns nonzero, reports whether the list or a write failed, and does not publish another `startedAt`

### Requirement: The autopilot command SHALL cancel an autopilot and stop its running stage without deleting files

`autopilot.mjs cancel <name>` and `autopilot.mjs status <name>` SHALL use the shared candidate enumeration and record-identity reader of spec `autopilot-scheduler` (Requirement «The autopilot SHALL locate the managed batch for status and cancel»). `cancel` SHALL set the autopilot record from `active` or `exiting` to `void` with `voidReason` `用户撤回`, and SHALL set each eligible `pending` or `answered` decision to `void`. In both protected write sections, `cancel` SHALL verify any saved `returnHandoff` and leave its verified `answered` alert for the scheduler to finish. It SHALL report that the handoff is pending and continue cleanup of the other open decisions of that batch. Failed handoff verification SHALL return nonzero and leave its record and alert intact. Each write SHALL verify the selected batch under the project protection and compare the current `status` with the expected statuses before it writes, and SHALL write a temporary file that replaces the file by rename. When the record already has `status` `void`, `cancel` SHALL NOT write the record again and SHALL run the steps for `run.lock` below; it SHALL still void open decisions of the same batch as described after the lock. When the record has another status or does not exist, it SHALL exit with code 1 and SHALL NOT change files.

After the first write section, `cancel` SHALL read `run.lock` in the autopilot home and wait at most `cancelWaitSeconds` (default 30) when the live lock belongs to the selected project root, change and `startedAt`. Before signaling and on each 200 millisecond re-read, the lock and the process group SHALL be verified for that exact batch and lock instance. A missing `claudePid` sends no signal. If the published group is verified during the wait it SHALL receive `SIGTERM` once for that instance. A different batch SHALL NOT receive a signal; a live lock with unknown identity SHALL NOT be signaled or reported stopped. A replaced lock SHALL be checked again. Removal or replacement alone SHALL NOT prove a stored writer stopped; `cancel` SHALL verify that writer under the unfinished-check rule. When there is no live writer of the selected batch, `cancel` SHALL acquire the shared per-project write protection, re-enumerate and verify the original batch, then void its record if needed and all eligible still-open decisions of that batch, including decisions left by a failed earlier withdrawal or written during the wait. The verified handoff alert remains protected. An already void record SHALL NOT be rewritten. An already void batch with a complete list and no eligible open decision SHALL have no changes to its files. An incomplete list is not proof of cleanup; report it separately from a failed write, with only the verified batch, ID when known, and safe error category. `cancel` SHALL report nonzero for timeout, unknown writer, ambiguous ownership, failed recheck or incomplete write rather than reporting success. It SHALL NOT touch a different batch or delete files. `status` SHALL print the record and counts by decision state; its running status SHALL also check any saved writer for the selected batch. It SHALL report yes for a verified live instance, unknown for unresolved identity or exit, and no only when the selected batch has no such instance, never released it to write, or its exit has been proved. Absence, replacement or staleness of a lock alone SHALL NOT prove exit.

#### Scenario: Cancel voids open decisions
- **WHEN** the autopilot is `active`, no stage runs, and `decisions/D-0002.json` has `status` `pending`
- **THEN** after `autopilot.mjs cancel` the record has `status` `void` and `D-0002.json` has `status` `void`
- **AND** both files still exist

#### Scenario: Status counts the decisions
- **WHEN** the change has one `used` decision and one `pending` decision
- **THEN** `autopilot.mjs status` prints the record and the counts `used: 1` and `pending: 1`

#### Scenario: Cancel stops a running stage
- **WHEN** `run.lock` verifies a same-batch live test group that removes `run.lock` and exits on `SIGTERM`
- **THEN** the test process receives `SIGTERM`
- **AND** `autopilot.mjs cancel` exits with code 0 after `run.lock` is removed, and the record has `status` `void`

#### Scenario: Cancel reports a stage that does not stop
- **WHEN** `run.lock` verifies a same-batch live test group that ignores `SIGTERM`, and `cancelWaitSeconds` is 1
- **THEN** `autopilot.mjs cancel` exits with code 1 and prints that the stage is still stopping
- **AND** the record has `status` `void`

#### Scenario: Cancel waits for the scheduler without a claude process
- **WHEN** `run.lock` verifies the same scheduler instance and batch with `claudePid` `null`, and its `pid` is a live test process that removes `run.lock` after 1 second
- **THEN** the test process receives no signal
- **AND** `autopilot.mjs cancel` exits with code 0 after `run.lock` is removed

#### Scenario: Cancel signals a claude process that starts during the wait
- **WHEN** `run.lock` verifies the same scheduler instance and batch with `claudePid` `null`, and after 1 second the same lock instance publishes a verified live test group that removes `run.lock` and exits on `SIGTERM`
- **THEN** the test process receives `SIGTERM`
- **AND** `autopilot.mjs cancel` exits with code 0 after `run.lock` is removed

#### Scenario: Cancel of a void record still stops the stage
- **WHEN** `decisions/autopilot.json` has `status` `void`, no decision of the batch has `status` `pending` or `answered`, and `run.lock` verifies a live same-batch group that removes `run.lock` and exits on `SIGTERM`
- **THEN** the test process receives `SIGTERM` and `autopilot.mjs cancel` exits with code 0
- **AND** no file of the change directory is changed

#### Scenario: Cancel of a void record voids decisions added during the wait
- **WHEN** `decisions/autopilot.json` has `status` `void`, the scheduler writes `decisions/D-0008.json` with `status` `pending` during the lock wait, and then releases `run.lock`
- **THEN** `autopilot.mjs cancel` exits with code 0 and `D-0008.json` has `status` `void`
- **AND** the autopilot record is not written again

#### Scenario: Cancel voids again a record written back by the scheduler
- **WHEN** the scheduler writes `{status: active, rerunStage: quality}` with the same `startedAt` after the cancel wrote `void`, and then releases `run.lock`
- **THEN** `autopilot.mjs cancel` exits with code 0, and the autopilot record has `status` `void`

#### Scenario: Cancel of an exiting change finds the archive directory
- **WHEN** the change is in the `archived` list of the progress view, and `decisions/autopilot.json` in its archive directory has `status` `exiting`
- **THEN** `autopilot.mjs cancel` exits with code 0 and that record has `status` `void`

#### Scenario: A same-name lock belongs to another project
- **WHEN** a live lock is verified for a batch of the same name in another project
- **THEN** cancellation of the selected batch sends no signal to that writer and status does not report that writer as the selected batch

#### Scenario: Cancel retries remaining open decisions without new decisions
- **WHEN** a previous withdrawal left the same batch void but a decision still open, and no decision was added during the current wait
- **THEN** the command voids that decision without rewriting the record, or reports a nonzero exit when the write cannot finish

#### Scenario: Cancel preserves the original alert during a terminal handoff
- **WHEN** a verified batch is `void` with an `answered` return-to-session alert in `returnHandoff`, and `cancel` obtains project protection before the scheduler completes that alert
- **THEN** cancel reports the pending handoff, preserves the original alert and record, and voids only other eligible open decisions of the same batch
- **AND** the scheduler can still set the original alert to `used` and complete the same handoff without starting an exit action

#### Scenario: No lock does not prove a saved writer exited
- **WHEN** no current lock belongs to the selected batch but the saved writer's exit cannot be verified
- **THEN** status reports unknown, and cancel does not claim that the stage has stopped

#### Scenario: An incomplete decision list does not prove withdrawal finished
- **WHEN** the selected batch is `void` and a same-batch decision file cannot be read or validated
- **THEN** cancel returns nonzero and distinguishes the incomplete list from a failed write of a known decision

### Requirement: The gate script SHALL accept the autopilot files as artifacts

`implementation-gate.mjs hygiene <changeRoot>` SHALL report no warning for `decisions/autopilot.json` and for files that match `decisions/D-<four digits>.json`. Other files under `decisions/` SHALL be reported as files outside the allowlist.

#### Scenario: Autopilot files pass hygiene
- **WHEN** the change directory contains `decisions/autopilot.json` and `decisions/D-0001.json`
- **THEN** `hygiene` reports no warning for these files

#### Scenario: Other file under decisions is reported
- **WHEN** the change directory contains `decisions/notes.md`
- **THEN** `hygiene` reports one warning for that file
