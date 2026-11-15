# verify-verdict Specification

## Purpose
verify 结论用报告头部字段记录检查结果与 CRITICAL 条数，供归档门禁、facts 和增量检查读取，并保留旧报告的处理规则。

## Requirements

### Requirement: Verify SHALL write the verdict fields in the report header

`/opsx:verify` SHALL write two field lines in `verification.md` after the `Fingerprint` line: `- Verify-Verdict: <verdict>` and `- Critical-Count: <count>`. `<count>` SHALL be the number of CRITICAL issues in the report, written as a decimal integer. `<verdict>` SHALL be `FAIL` when `<count>` is greater than 0, when the 「评审条件」 section reports an open condition, or when the report records an item of the Phase 6 manual check list as not passed. `<verdict>` SHALL be `PASS` in all other cases. Verify SHALL write the two fields after all checks of the run, and the Final Assessment SHALL agree with them. In the incremental mode, `<count>` SHALL be the number of CRITICAL issues of the checks that the run repeats.

#### Scenario: Report with critical issues
- **WHEN** verify records 2 CRITICAL issues
- **THEN** the report contains `- Verify-Verdict: FAIL` and `- Critical-Count: 2` after the `Fingerprint` line

#### Scenario: Open review condition without critical issues
- **WHEN** verify records no CRITICAL issue and the 「评审条件」 section reports condition C2 as open
- **THEN** the report contains `- Verify-Verdict: FAIL` and `- Critical-Count: 0`

#### Scenario: Report with only warnings
- **WHEN** verify records 3 WARNING issues and no CRITICAL issue, and every review condition is closed
- **THEN** the report contains `- Verify-Verdict: PASS` and `- Critical-Count: 0`

### Requirement: The archive command SHALL block on the verify verdict

The gate SHALL read the `Verify-Verdict` and `Critical-Count` field lines of `verification.md` with the same rule as the `Fingerprint` field line: a list marker, bold markers and a full-width colon SHALL be allowed, and backticks and asterisks around the value SHALL be removed. The verdict SHALL be the first word of ASCII letters and underscores in the value. The gate SHALL recognize the verdict only when it is `PASS` or `FAIL`. The count SHALL be the decimal integer at the start of the value.

When the report has at least one of the two field lines, the `archive` command SHALL add one blocker that starts with `verify 报告：` for each of these cases:

- the verdict is `FAIL`;
- the count is greater than 0;
- the `Verify-Verdict` line does not exist, or the gate does not recognize its verdict;
- the `Critical-Count` line does not exist, or its value does not start with a decimal integer.

The `archive` command SHALL exit with code 1 when it has a blocker. `facts` SHALL contain the same blockers in `archive.blockers` and SHALL exit with code 0. The gate SHALL NOT read the list of CRITICAL issues in the report. The gate SHALL NOT compare the fingerprint of the report with the current fingerprint.

#### Scenario: Failed verify blocks the archive
- **WHEN** `verification.md` contains `- Verify-Verdict: FAIL` and `- Critical-Count: 2`, and the slice evidence and the dual-axis review have no blocker
- **THEN** `archive` exits with code 1
- **AND** `blockers` contains one blocker for the verdict `FAIL` and one blocker for the count 2, and both start with `verify 报告：`
- **AND** `facts` exits with code 0 and `archive.blockers` contains the same two blockers

#### Scenario: Passed verify does not block the archive
- **WHEN** `verification.md` contains `- Verify-Verdict: PASS` and `- Critical-Count: 0`
- **THEN** `archive` has no blocker that starts with `verify 报告：`

#### Scenario: Count disagrees with a passed verdict
- **WHEN** `verification.md` contains `- Verify-Verdict: PASS` and `- Critical-Count: 1`
- **THEN** `archive` has one blocker that starts with `verify 报告：` and names the count 1

#### Scenario: Fields with bold markers and a full-width colon
- **WHEN** `verification.md` contains `- **Verify-Verdict**：FAIL` and `- **Critical-Count**：0`
- **THEN** `archive` has one blocker for the verdict `FAIL`

#### Scenario: Verdict that the gate does not recognize
- **WHEN** `verification.md` contains `- Verify-Verdict: 通过` and `- Critical-Count: 0`
- **THEN** `archive` has one blocker that starts with `verify 报告：` and contains the value `通过`

#### Scenario: Report with only one verdict field
- **WHEN** `verification.md` contains `- Verify-Verdict: PASS` and no `Critical-Count` line
- **THEN** `archive` has one blocker that starts with `verify 报告：` for the missing `Critical-Count` line

### Requirement: A verify report without verdict fields SHALL NOT block the archive

When `verification.md` has no `Verify-Verdict` line and no `Critical-Count` line, the gate SHALL treat it as a legacy report. The gate SHALL NOT add a blocker for the verdict. `archive.notes` SHALL contain a note that the report has no verdict fields and that `/opsx:archive` confirms the CRITICAL issues by reading the report. When `verification.md` does not exist, the gate SHALL NOT add a blocker or a note for the verdict.

#### Scenario: Legacy report does not block the archive
- **WHEN** `verification.md` contains `- Fingerprint: <current fingerprint>` and a list of CRITICAL issues, has no verdict field, and the slice evidence and the dual-axis review have no blocker
- **THEN** `archive` exits with code 0
- **AND** `notes` contains the note about the legacy report

#### Scenario: Change without a verify report
- **WHEN** the change has no `verification.md`
- **THEN** `archive` has no blocker that starts with `verify 报告：` and no note about a legacy report

### Requirement: Archive SHALL check the verdict fields against the report

`/opsx:archive` SHALL refuse to archive when the `archive` command lists a blocker that starts with `verify 报告：`, and SHALL name the blockers. Archive SHALL still read `verification.md` and SHALL require that the report lists no CRITICAL issue. When the report contains `- Verify-Verdict: PASS` and `- Critical-Count: 0` but lists a CRITICAL issue, archive SHALL refuse to archive and SHALL tell the user to run `/opsx:verify` again. The archive summary SHALL contain the values of `Verify-Verdict` and `Critical-Count`, or SHALL state that the report is a legacy report without verdict fields.

#### Scenario: Failed verdict refuses the archive
- **WHEN** `verification.md` contains `- Verify-Verdict: FAIL` and `- Critical-Count: 1`
- **THEN** archive refuses to move the change and names the blockers that start with `verify 报告：`

#### Scenario: Fields disagree with the report body
- **WHEN** `verification.md` contains `- Verify-Verdict: PASS` and `- Critical-Count: 0` and lists one CRITICAL issue
- **THEN** archive refuses to move the change and tells the user to run `/opsx:verify` again

#### Scenario: Legacy report with a critical issue
- **WHEN** `verification.md` has no verdict field and lists one CRITICAL issue
- **THEN** archive refuses to move the change, as before this change

### Requirement: Verify SHALL read the verdict of the previous report for the incremental mode

The first condition of the incremental mode SHALL be that the previous `verification.md` has a `Fingerprint`, `Verify-Verdict: PASS` and `Critical-Count: 0`. When the previous report has no verdict field, the first condition SHALL be that the report has a `Fingerprint` and lists no CRITICAL issue.

#### Scenario: Previous failed report without critical issues
- **WHEN** the previous report contains `- Verify-Verdict: FAIL` and `- Critical-Count: 0` because of an open review condition, and `classify` lists no unregistered file
- **THEN** verify runs in the full mode

#### Scenario: Previous passed report
- **WHEN** the previous report contains `- Verify-Verdict: PASS` and `- Critical-Count: 0`, `classify` exits with code 0, and `registered` has no row with the class `行为`
- **THEN** verify runs in the incremental mode
