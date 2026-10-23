# slice-fresh-evidence Specification

## Purpose
每个已实现的垂直切片记录与实现指纹绑定的新鲜证据；Verify 与 Archive 拒绝缺失、不完整、失败或过期的证据。
## Requirements
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

A change between two fingerprints in which `implementation-gate.mjs classify` reports every file as comment-only SHALL count as a documented non-behavioral exception. It SHALL NOT need a manual exemption row. The script SHALL apply this rule to the part of the chain after the last valid exemption row.

A slice MAY declare `Environment: <environment name>` in `tasks.md` when its acceptance needs an environment that the local machine does not provide. When the evidence of such a slice is stale, the evidence record MAY contain a `## 待环境补测` table with the columns `登记指纹 | 原因 | 补测计划 | 负责人 | 确认人 | 日期`. When one row has a filled confirmer cell and a registered fingerprint that is equal to the current fingerprint, or that has only comment-only differences from the current fingerprint, the script SHALL report the slice as `pending-environment` in `warnings` instead of `issues`. The user SHALL fill the confirmer cell. The agent SHALL NOT fill it for the user. A `## 待环境补测` table in a slice without an `Environment:` line SHALL have no effect.

#### Scenario: Evidence is missing
- **WHEN** an applicable completed slice has no evidence record
- **THEN** Verify reports a CRITICAL issue and the change is not eligible for Archive

#### Scenario: Evidence is stale after code changes
- **WHEN** the evidence fingerprint differs from the current implementation fingerprint and the changed files can affect the slice behavior
- **THEN** Verify marks the evidence as stale, requires the slice verification to be rerun, and blocks Archive

#### Scenario: Evidence is current
- **WHEN** the evidence fingerprint matches the current implementation and the recorded commands have passing results
- **THEN** Verify accepts the evidence as fresh for that slice and checks its coverage against the declared Seam and acceptance behavior

#### Scenario: Comment-only change keeps the evidence current
- **WHEN** the evidence fingerprint is A, the current fingerprint is B, and `classify` reports every file changed between A and B as comment-only
- **THEN** `evidence` reports the slice as `exempted` with the reason `comment-only`
- **AND** Verify reports no CRITICAL issue for that slice

#### Scenario: Environment slice waits for the environment
- **WHEN** Slice 07 declares `Environment: 测试环境` and its evidence is stale
- **AND** its `## 待环境补测` table has a row for the current fingerprint with a filled confirmer cell
- **THEN** `evidence` reports Slice 07 as `pending-environment` in `warnings`
- **AND** Verify reports a WARNING that names the slice, the owner and the re-test plan

#### Scenario: Comment-only change after the pending row keeps the slice pending
- **WHEN** Slice 07 declares `Environment: 测试环境` and has a confirmed `## 待环境补测` row for fingerprint A
- **AND** the current fingerprint is B, and `classify` reports every file changed between A and B as comment-only
- **THEN** `evidence` still reports Slice 07 as `pending-environment` in `warnings`

#### Scenario: Pending row on a local slice has no effect
- **WHEN** a slice without an `Environment:` line has a `## 待环境补测` row for the current fingerprint
- **THEN** `evidence` still reports the slice as stale

#### Scenario: Pending row without a confirmer has no effect
- **WHEN** the confirmer cell of the only `## 待环境补测` row is empty
- **THEN** `evidence` still reports the slice as stale

### Requirement: Archive SHALL require complete review and slice evidence closure

Archive SHALL reject an enabled change when dual-axis review has an open Blocker, an applicable slice lacks fresh evidence, or Verify reports unresolved evidence-related CRITICAL issues. A slice with the status `pending-environment` SHALL NOT block Archive. Archive SHALL write each such slice, its owner and its plan in the archive summary.

#### Scenario: Archive is attempted with unresolved evidence
- **WHEN** at least one applicable slice has missing or stale evidence
- **THEN** Archive refuses to move the change to archive and reports the affected slice identifiers

#### Scenario: Archive is attempted after all checks pass
- **WHEN** both review axes pass, all applicable slice evidence is fresh, and Verify has no unresolved CRITICAL issue
- **THEN** Archive proceeds under the existing spec sync and change archive rules

#### Scenario: Archive with a pending environment slice
- **WHEN** every other check passes and Slice 07 has the status `pending-environment`
- **THEN** `implementation-gate.mjs archive` exits with code 0
- **AND** the archive summary lists Slice 07 with its owner and plan
