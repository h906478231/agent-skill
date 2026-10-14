## ADDED Requirements

### Requirement: Each implemented vertical slice SHALL have a fresh evidence record

For every vertical slice that is applicable to the change, the workflow SHALL maintain one evidence record under `evidence/slice-<id>.md`. The record SHALL identify the slice behavior, declared Seam, implementation fingerprint, changed files, verification commands, results, covered acceptance behavior, and remaining risks.

#### Scenario: A slice is completed before task checkboxes are marked
- **WHEN** all implementation work for a slice is complete
- **THEN** the workflow creates or updates that slice's evidence record before marking the corresponding task checkbox complete

#### Scenario: A slice has no applicable evidence requirement
- **WHEN** the change has no vertical slice or the slice evidence rule is explicitly not applicable
- **THEN** Verify records the reason for non-applicability instead of silently treating missing evidence as success

### Requirement: Slice evidence SHALL be linked from tasks without breaking checkbox parsing

The task plan SHALL reference the slice evidence outside the checkbox syntax, using an `Evidence:` line or equivalent link. Existing `- [ ]` and `- [x]` task formats SHALL remain parseable by Apply and Verify.

#### Scenario: A task slice references evidence
- **WHEN** a reviewer reads a slice section in `tasks.md`
- **THEN** the section contains a link to its evidence record and the task checkbox lines retain their original format

### Requirement: Verification SHALL reject missing, incomplete, or stale slice evidence

Verify SHALL check that each applicable slice has an evidence record, that the record contains verification results and coverage information, and that its implementation fingerprint matches the current implementation unless a documented non-behavioral exception applies.

#### Scenario: Evidence is missing
- **WHEN** an applicable completed slice has no evidence record
- **THEN** Verify reports a CRITICAL issue and the change is not eligible for Archive

#### Scenario: Evidence is stale after code changes
- **WHEN** the evidence fingerprint differs from the current implementation fingerprint and the changed files can affect the slice behavior
- **THEN** Verify marks the evidence as stale, requires the slice verification to be rerun, and blocks Archive

#### Scenario: Evidence is current
- **WHEN** the evidence fingerprint matches the current implementation and the recorded commands have passing results
- **THEN** Verify accepts the evidence as fresh for that slice and checks its coverage against the declared Seam and acceptance behavior

### Requirement: Archive SHALL require complete review and slice evidence closure

Archive SHALL reject an enabled change when dual-axis review has an open Blocker, an applicable slice lacks fresh evidence, or Verify reports unresolved evidence-related CRITICAL issues.

#### Scenario: Archive is attempted with unresolved evidence
- **WHEN** at least one applicable slice has missing or stale evidence
- **THEN** Archive refuses to move the change to archive and reports the affected slice identifiers

#### Scenario: Archive is attempted after all checks pass
- **WHEN** both review axes pass, all applicable slice evidence is fresh, and Verify has no unresolved CRITICAL issue
- **THEN** Archive proceeds under the existing spec sync and change archive rules
