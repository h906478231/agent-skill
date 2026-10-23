# gate-risk-tiering Specification

## Purpose
门禁风险分级：编码前技术评审范围由方案类型（MVP/完整）与升级信号共同决定，升级信号映射到固定评审维度，编码后双轴评审独立于编码前分级。
## Requirements
### Requirement: The pre-coding review scope SHALL depend on both solution type and upgrade signals

The technical review SHALL classify a change by two inputs: the solution type selected in `design.md` (MVP or full) and the upgrade signals listed in `gate-levels.md`. The classification SHALL decide the pre-coding review scope as follows:

| Solution type | Upgrade signals | Pre-coding review scope |
|---|---|---|
| MVP | none | Skip the technical review. Do not create `review-summary.md`. |
| MVP | one or more | Run only the dimensions mapped from the matched signals, with the MVP review standard. |
| Full | any | Keep the existing L1–L3 rules. |

When the classification is uncertain, the reviewer SHALL use the higher scope.

#### Scenario: MVP change without upgrade signals skips the technical review
- **WHEN** `design.md` selects an MVP solution and the change matches no upgrade signal
- **THEN** the technical review is skipped and no `review-summary.md` is created
- **AND** the first lines of `overview.md` record the solution type, the matched signals (none), the decision maker and the date

#### Scenario: MVP change with tenant isolation and MQ retry runs two dimensions
- **WHEN** `design.md` selects an MVP solution and the change matches the signals "tenant isolation" and "MQ retry"
- **THEN** the technical review runs only the security and concurrency dimensions with the MVP review standard
- **AND** `review-summary.md` lists the other three dimensions as not applicable with the matched-signal table as the reason

#### Scenario: Full solution keeps the existing level rules
- **WHEN** `design.md` selects a full solution and the change matches the signal "MQ retry"
- **THEN** the technical review runs all five dimensions as level L3

### Requirement: Upgrade signals SHALL map to fixed review dimensions

`gate-levels.md` SHALL define one mapping table from upgrade signals to review dimensions. The MVP-with-signals scope SHALL be the union of the dimensions mapped from all matched signals.

#### Scenario: Signal mapping produces the dimension set
- **WHEN** the matched signals are "new table" and "batch of 10,000 rows or more"
- **THEN** the review dimensions are database and performance

### Requirement: The post-coding dual-axis review SHALL stay independent of the pre-coding tier

Skipping or reducing the pre-coding technical review SHALL NOT change the applicability of the dual-axis review. Only level L0 stays exempt from the dual-axis review.

#### Scenario: Skipped technical review still runs the dual-axis review
- **WHEN** an MVP change without upgrade signals finishes apply
- **THEN** `/opsx:quality` runs both review axes
