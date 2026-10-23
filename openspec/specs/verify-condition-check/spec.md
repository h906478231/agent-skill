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

A conditional-pass condition SHALL map to a task when it needs code, a test, SQL, a configuration file or a deliverable document. A condition that needs only an edit of a planning artifact SHALL map to the line of that artifact, written as `<file>:<line>`, and SHALL NOT need a task. The edit SHALL go through `/opsx:update`. A condition that maps to no task and to no line SHALL count as a Blocker. Verify SHALL check that the mapped line exists and states the condition.

#### Scenario: Design-only condition closes by a line reference
- **WHEN** condition C2 asks to add a decision to `design.md`
- **AND** the condition list maps C2 to `design.md:120` and that line states the decision
- **THEN** verify reports C2 as closed without a task

#### Scenario: Line reference that does not state the condition stays open
- **WHEN** the condition list maps C2 to `design.md:120` and that line does not state the decision
- **THEN** verify reports C2 as an open condition

#### Scenario: Condition without a task or a line is a Blocker
- **WHEN** condition C3 maps to no task and to no line
- **THEN** the technical review counts C3 as a Blocker

### Requirement: Archive SHALL use the condition result of verify

Archive SHALL require that the latest verify result has no open condition. Archive SHALL NOT read the condition matrix of `overview.md`.

#### Scenario: Archive ignores an old overview matrix
- **WHEN** `overview.md` marks a condition as not implemented
- **AND** the latest verify result maps every condition of `review-summary.md` to a checked task or to a line that states the condition
- **THEN** archive does not block on the overview matrix

#### Scenario: Open condition blocks archive
- **WHEN** the latest verify result reports one condition without a checked task and without a line reference
- **THEN** archive refuses to move the change and names the condition
