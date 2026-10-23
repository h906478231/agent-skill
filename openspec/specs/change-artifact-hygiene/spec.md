# change-artifact-hygiene Specification

## Purpose
变更目录产物卫生：门禁脚本按 OpenSpec 技能声明的产物白名单对白名单外文件告警（不阻断），apply 开始后范围增长时提示拆分变更。
## Requirements
### Requirement: The gate script SHALL warn about artifacts outside the allowlist

`implementation-gate.mjs hygiene <changeRoot>` SHALL compare the files in the change directory with an allowlist built from the outputs that the OpenSpec skills declare. Supplementary files SHALL be placed under `evidence/attachments/`. Each file outside the allowlist SHALL produce one warning. The command SHALL NOT block, and the exit code SHALL be `0` unless an argument error occurs.

#### Scenario: Round copy is reported
- **WHEN** the change directory contains `review/standards-round1.md`
- **THEN** `hygiene` reports one warning for that file with the reason "round copy"

#### Scenario: Free-form report is reported
- **WHEN** the change directory contains `p0-optimization-report.md`
- **THEN** `hygiene` reports one warning for that file

#### Scenario: Supplementary file under attachments passes
- **WHEN** the change directory contains `evidence/attachments/write-scan.txt`
- **THEN** `hygiene` reports no warning for that file

### Requirement: Scope growth after apply starts SHALL prompt a split

When apply has started, `/opsx:update` and `/opsx:apply` SHALL compare the current task count with the task count recorded at the first apply. If the new tasks exceed 50% of the recorded count, or the update adds a new capability or a new top-level module, the agent SHALL ask the user to choose between a new change (recommended) and the current change. The agent SHALL record the answer in `discussion-log.md`.

#### Scenario: Migration module is added to a running change
- **WHEN** a change recorded 30 tasks at the first apply and an update adds a migration module with 16 tasks
- **THEN** the agent asks the user whether to create a new change for the migration module

#### Scenario: Small fix tasks do not prompt
- **WHEN** a change recorded 30 tasks and an update adds 3 fix tasks in existing modules
- **THEN** the agent does not prompt for a split
