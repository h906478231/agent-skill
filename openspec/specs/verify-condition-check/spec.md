# verify-condition-check Specification

## Purpose
verify 条件核对：verify 直接对照 review-summary.md 核对有条件通过的条件，不刷新 overview.md；只需编辑规划产物的条件以 `<文件>:<行号>` 闭环，不需要任务；archive 以最近一次 verify 的条件结论为准，不读 overview.md 的条件矩阵。
## Requirements
### Requirement: Verify SHALL check review conditions without refreshing the overview

Verify SHALL check each conditional-pass condition of `review-summary.md` against the mapped task and the implementation, or against the mapped line of a planning artifact. Verify SHALL NOT run `/opsx:overview` and SHALL NOT require a refreshed `overview.md`. When `overview.md` contains the generated blocks, verify SHALL write the generation date and the review round of the overview in its report. When the change has no `review-summary.md`, verify SHALL write that the condition check is not applicable and SHALL state the reason.

#### Scenario: Verify with a generated overview does not regenerate it
- **WHEN** `overview.md` contains the generated blocks from review round R6 and the current review round is R7
- **THEN** verify checks the conditions from `review-summary.md`
- **AND** verify writes the overview round R6 in the report without running `/opsx:overview`

#### Scenario: Change without a review summary
- **WHEN** the change has no `review-summary.md`
- **THEN** verify writes that the condition check is not applicable because the change skipped the technical review

### Requirement: A condition that needs only a planning artifact edit SHALL close by a line reference

A conditional-pass condition SHALL map to a task when it needs code, a test, SQL, a configuration file or a deliverable document. A condition that needs only an edit of a planning artifact SHALL map to the line of that artifact, written as `<file>:<line>`, and SHALL NOT need a task. The edit SHALL go through `/opsx:update`. A condition that maps to no task, line or current handling record SHALL count as a Blocker, except a pending condition with explicit wording and a linked open Major awaiting a decision or the selected planning edit. That exception SHALL neither permit signing nor allow apply. Verify SHALL check that a mapped line exists and states the condition.

#### Scenario: Design-only condition closes by a line reference
- **WHEN** condition C2 asks to add a decision to `design.md`
- **AND** the condition list maps C2 to `design.md:120` and that line states the decision
- **THEN** verify reports C2 as closed without a task

#### Scenario: Line reference that does not state the condition stays open
- **WHEN** the condition list maps C2 to `design.md:120` and that line does not state the decision
- **THEN** verify reports C2 as an open condition

#### Scenario: Condition without a task, a line or a handling record is a Blocker
- **WHEN** condition C3 has no task, line or current handling record, and is not a pending condition with an explicit source and wording
- **THEN** the technical review counts C3 as a Blocker

### Requirement: Archive SHALL use the condition result of verify

Archive SHALL require that the latest verify result has no open condition and that it matches the current conditions and their effective handling records. The final check and the move of the active change directory SHALL share one exclusive protection with withdrawal. After acquiring it, archive SHALL read the current review verdict, pending withdrawals, conditions, their handling records and the latest verify result. Archive SHALL stop without moving if it cannot acquire protection, the active change no longer exists, there is a pending withdrawal, the verdict is blocked, the verify report version differs from the one that passed the archive prechecks, or a current condition or handling decision differs from the latest verify result. On success, archive SHALL move the directory before releasing protection and remove its protection from the moved path. If the move fails, archive SHALL release its protection at the source path. User prompts, delta spec sync and post-move steps SHALL stay outside this protection. Archive SHALL NOT write main specs unless the directory move succeeded. When the user chose to sync as part of archive, archive SHALL record the approved delta and the before and target versions of the affected main spec files before moving. Only the record for the move that succeeded, at the archived path, SHALL authorize that sync. A retry that does not require sync or whose user explicitly skips sync SHALL replace any pending record left by a failed move before moving. If sync fails or stops partway, archive SHALL retain the archived directory and record sync as pending. A retry SHALL verify the archived delta, skip files already at the approved target, write only files still at the approved before version, and request confirmation if other versions are present. It SHALL NOT report sync as complete until it verifies the target versions. Archive sync and independently authorized sync SHALL share a short exclusive protection for main spec writes. A busy protection SHALL leave archive sync pending without writing. Independently authorized sync SHALL NOT require an archived change or an archive sync record. Archive SHALL NOT read the condition matrix of `overview.md`.

During the same final check, before writing the pending sync record or moving the directory, archive SHALL compute the implementation fingerprint using the same scope as verify and compare it with the `Fingerprint` in the report that passed the prechecks. With no declared change head, archive SHALL use the current implementation fingerprint. With a valid declared change head, archive SHALL use the fingerprint of that commit; changes after that commit SHALL NOT affect this comparison. If the report fingerprint is missing or unreadable, the declared change head is invalid, the fingerprint cannot be computed, or the two values differ, archive SHALL state the reason and stop without writing a pending sync record for this attempt, moving the directory, or starting its spec sync. An invalid change head SHALL be corrected before retrying. A missing, unreadable, or mismatched report fingerprint SHALL require a new verify report and new archive prechecks. This comparison SHALL NOT replace the report version check or change the slice evidence check. It SHALL NOT apply when resuming sync for an already archived directory.

Verify SHALL prepare the report outside protection and use the same exclusive protection as archive when publishing it. It SHALL verify that the directory is still the same active instance, the check inputs still match, and the last report is unchanged or still missing, before replacing `verification.md`. On a mismatch or if the directory has moved, verify SHALL write to neither path and SHALL NOT recreate the active directory.

#### Scenario: Archive ignores an old overview matrix
- **WHEN** `overview.md` marks a condition as not implemented
- **AND** the latest verify result maps every condition of `review-summary.md` to a checked task or to a line that states the condition
- **AND** no condition or handling decision changed since verify and the current verdict is not blocked
- **THEN** archive does not block on the overview matrix

#### Scenario: Open condition blocks archive
- **WHEN** the latest verify result reports one open condition
- **THEN** archive refuses to move the change and names the condition

#### Scenario: Archive stops when a condition decision changed after verify
- **WHEN** the latest verify result reports a condition as handled, but the current handling decision has been withdrawn or replaced
- **THEN** archive stops and asks for a new verify result

#### Scenario: Withdrawal finishes before the final archive check
- **WHEN** archive finished its preliminary checks but did not acquire protection, and another session completes a withdrawal
- **THEN** archive reads the current review files after it acquires protection and stops without moving the directory
- **AND** it does not reuse the prior check or the verify result affected by the withdrawal

#### Scenario: Archive moves the directory before withdrawal can write
- **WHEN** archive acquires protection, completes the final check and is about to move the active directory, and another session requests a withdrawal
- **THEN** withdrawal cannot write while archive holds protection
- **AND** archive releases its protection at the moved path on success; a withdrawal retry stops when the active directory is gone and writes to neither path

#### Scenario: A failed archive move releases protection at the source
- **WHEN** archive passes the final check but the directory move fails
- **THEN** archive reports failure and releases its protection at the still-active source path
- **AND** it does not run the post-move steps

#### Scenario: A pending withdrawal blocks archive without a linked condition
- **WHEN** a pending withdrawal remains for a Blocker with no linked condition and the latest verify result has no open condition
- **THEN** archive refuses to move the directory and names the pending finding ID

#### Scenario: A refused archive does not change main specs
- **WHEN** the user selected sync during archive, and final review refuses the move or the move fails
- **THEN** archive does not write main specs or run the post-move sync

#### Scenario: Archive sync resumes after a partial write
- **WHEN** the directory is already archived and the approved sync stopped after updating one of two files
- **THEN** archive remains complete and sync remains pending
- **AND** retry skips the file already at its approved target and writes the other only if it still matches the approved before version
- **AND** a conflicting change on that file is reported and not overwritten without a new confirmation

#### Scenario: A newer verify report stops archive
- **WHEN** verify publishes a newer report after the archive prechecks and before the final archive check
- **THEN** archive does not move using the old result, and requires the prechecks to use the current report

#### Scenario: Changed implementation stops archive with an unchanged verify report
- **WHEN** no change head is declared, archive prechecks passed, and the user chose to sync main specs
- **AND** an implementation change that alters the fingerprint is completed before the final check, while the verify report remains unchanged
- **THEN** archive reports the fingerprint mismatch and asks for a new verify report before retrying
- **AND** it retains the active directory and neither writes a pending sync record for this attempt nor changes main specs

#### Scenario: Changes after the change head do not invalidate the report fingerprint
- **WHEN** the report records the fingerprint of the current valid change head and implementation changes occur after that commit
- **THEN** those changes do not cause a fingerprint mismatch in the final archive check
- **AND** archive still applies all other checks, including the existing slice evidence check

#### Scenario: An unavailable report fingerprint stops archive
- **WHEN** the verify report passed the archive prechecks but its `Fingerprint` is missing or unreadable
- **THEN** the final check reports the missing or unreadable value, retains the active directory, and asks for a new verify report
- **AND** it does not write a pending sync record for this attempt or start spec sync

#### Scenario: An archived change does not receive a verify report
- **WHEN** archive holds protection for the final check and move, and verify tries to publish a report for the same change
- **THEN** verify cannot publish during the move
- **AND** a retry after the move does not write at either path or recreate the active directory

### Requirement: A condition of a finding that is not fixed SHALL close by its handling record

When the status of a condition is `risk-accepted`, `false-positive` or `deferred`, verify SHALL look for the handling record of the source finding in the `review/<role>.md` of its dimension. Verify SHALL recognize only the latest handling record for that finding if it has not been withdrawn and matches both the finding ledger and the condition status. A handled condition SHALL NOT need a task or a line and SHALL NOT block archive. Verify SHALL report a condition as open when it is pending or when its record is missing, withdrawn or inconsistent. Verify SHALL record each condition result and the location and checked content of its current handling record, if any. Archive SHALL compare the current decision and record content with that report, not only the location or condition status.

#### Scenario: Accepted condition closes by its record
- **WHEN** condition C4 comes from PERF-12, the status of C4 is `risk-accepted`, and `review/performance.md` has the risk-accepted record of PERF-12
- **THEN** verify reports C4 as handled without a task or a line
- **AND** archive does not block on C4

#### Scenario: Accepted condition without a record stays open
- **WHEN** the status of condition C5 is `false-positive` and the report of its dimension has no rejection record of the source finding
- **THEN** verify reports C5 as an open condition

#### Scenario: A withdrawn handling record cannot close a condition
- **WHEN** a handling record is still in the role report, but it has been withdrawn and the condition is pending
- **THEN** verify reports the condition as open rather than using the historical record
- **AND** archive stops even if an earlier verify report marked the condition as handled
