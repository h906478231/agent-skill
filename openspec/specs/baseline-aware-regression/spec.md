# baseline-aware-regression Specification

## Purpose
已知失败基线回归判定：项目级已知失败基线清单（默认 `docs/test-baseline.txt`）、门禁脚本对比实际失败与基线、切片证据接受 PASS_WITH_BASELINE、报告只陈述本次变更新引入的失败。
## Requirements
### Requirement: The project SHALL keep one known-failure baseline list outside the change directory

A project that has failing tests before a change starts SHALL keep a known-failure baseline list in the project repository. The default path SHALL be `docs/test-baseline.txt`. Each non-empty line that does not start with `#` SHALL identify one failing test. The list SHALL NOT be stored in a change directory, because many changes share it.

#### Scenario: Baseline list is created from the base commit
- **WHEN** the full suite fails and the project has no baseline list
- **THEN** the agent runs the failing tests on the base commit in a separate worktree
- **AND** the agent writes the tests that also fail there into `docs/test-baseline.txt`

#### Scenario: Surefire suffixes are ignored
- **WHEN** a line reads `com.a.FooTest.bar <<< FAILURE!`
- **THEN** the test identifier is `com.a.FooTest.bar`

### Requirement: The gate script SHALL compare actual failures with the baseline list

`implementation-gate.mjs regress --baseline <file> --actual <file>` SHALL output a JSON object with `introduced` (failures not in the baseline list), `baselineMatched` (count of failures in the baseline list) and `fixed` (baseline entries that no longer fail). The exit code SHALL be `0` when `introduced` is empty, `1` when it is not empty, and `2` for argument or file errors.

#### Scenario: All failures are known baseline failures
- **WHEN** the actual list has 27 failures and all 27 are in the baseline list
- **THEN** `introduced` is empty, `baselineMatched` is 27 and the exit code is 0

#### Scenario: One failure is introduced by the change
- **WHEN** the actual list contains `com.a.NewTest.x` and the baseline list does not contain it
- **THEN** `introduced` contains `com.a.NewTest.x` and the exit code is 1

#### Scenario: A baseline test now passes
- **WHEN** the baseline list contains `com.a.OldTest.y` and the actual list does not contain it
- **THEN** `fixed` contains `com.a.OldTest.y` and the exit code is not affected

### Requirement: Slice evidence SHALL accept PASS_WITH_BASELINE

The slice evidence `Result` field and each verification-command result SHALL accept `PASS`, `PASS_WITH_BASELINE` or `FAIL`. `PASS_WITH_BASELINE` SHALL require the fields `Baseline List` (an existing file path) and `Introduced Failures: 0`. The evidence check SHALL treat `PASS_WITH_BASELINE` as passed.

#### Scenario: Evidence with only baseline failures supports a completed slice
- **WHEN** a completed slice has `Result: PASS_WITH_BASELINE`, `Baseline List: docs/test-baseline.txt` and `Introduced Failures: 0`
- **THEN** the evidence check reports the slice as fresh and passed

#### Scenario: PASS_WITH_BASELINE without a baseline list is incomplete
- **WHEN** a slice has `Result: PASS_WITH_BASELINE` and no `Baseline List` field
- **THEN** the evidence check reports the missing field as CRITICAL

#### Scenario: Existing PASS and FAIL evidence stays valid
- **WHEN** an evidence file written before this change has `Result: PASS`
- **THEN** the evidence check result is the same as before this change

### Requirement: Reports SHALL state only failures introduced by the change

Slice evidence conclusions, `tasks.md` notes, `overview.md` and `verification.md` SHALL state the full-suite result as the count of failures introduced by the change. They SHALL NOT list baseline failures or their counts. When the count is not zero, they SHALL name each introduced test and the task that fixes it.

#### Scenario: Full suite has only baseline failures
- **WHEN** the full suite has 27 failures and `regress` reports none introduced
- **THEN** the report line reads "完整回归：PASS_WITH_BASELINE（本次引入的失败：0）" and no baseline test name appears

#### Scenario: Full suite has an introduced failure
- **WHEN** `regress` reports `ImCorpStorageAppTest.voiceReuse` as introduced
- **THEN** the report line reads FAIL with the test name
- **AND** `tasks.md` gets one fix task for that test
