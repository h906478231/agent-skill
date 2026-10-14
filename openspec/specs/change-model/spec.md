# change-model Specification

## Purpose
变更模型格式、可视化判定小节、6 项阻断检查（CM-1～CM-6）与 OpenSpec 四个卡点的调用：design.md 中的 `change-model` 代码块是状态图与流程图的唯一事实源，新增或修改的迁移与步骤必须挂 Scenario。
## Requirements
### Requirement: The change model SHALL describe state machines and flows with change markers

A change model SHALL be a fenced code block with the info string `change-model` in `design.md`. It SHALL contain `version`, and MAY contain `machines` and `flows`. A machine SHALL contain `states` and `transitions`. A flow SHALL contain `steps` and `edges`. Each state, transition, step and edge MAY carry `diff` with one of `added`, `changed` or `removed`; an element without `diff` is unchanged. Sequence diagrams, field changes and code mappings SHALL NOT be part of the change model.

#### Scenario: Unchanged element
- **WHEN** a transition has no `diff` field
- **THEN** the change model treats the transition as unchanged

#### Scenario: Unsupported section
- **WHEN** a change model contains a top-level key `sequences`
- **THEN** the change-model check reports a blocking schema finding

### Requirement: Flow steps SHALL link to the transitions they cause

A flow step MAY declare `causes` with a list of transition IDs. Each ID SHALL refer to a transition in any machine of the same change model.

#### Scenario: Step causes a transition
- **WHEN** step `S5` declares `causes: [T5]` and transition `T5` exists
- **THEN** the change-model check reports no finding for this link

### Requirement: The change-model check SHALL enforce six blocking rules

The check SHALL report a blocking finding when any of the following holds:
1. The model does not match the schema, an ID is not unique within its kind, or `from`, `to`, `causes` or an edge endpoint refers to a missing element.
2. A `name`, `trigger`, `guard` or `label` value contains a forbidden alias.
3. An `added` or `changed` transition or step has no `scenarios`, or a listed scenario does not exist in the change's specs.
4. A `changed` element has no `before` object.
5. The visualization decision section declares a hit that has no matching model, or a model exists that the section does not declare.
6. A non-removed transition or edge points to a removed state or step.

The check SHALL exit with code 1 on any blocking finding, code 0 otherwise, and code 2 on argument or environment errors, and SHALL print one JSON object with the same fields as the STE check.

#### Scenario: Added transition without a scenario
- **WHEN** transition `T5` has `diff: added` and no `scenarios`
- **THEN** the check exits with code 1 and reports `T5` with rule 3

#### Scenario: Scenario reference does not exist
- **WHEN** transition `T6` lists `order-refund/渠道退款成功` and `specs/order-refund/spec.md` has no scenario with that name
- **THEN** the check exits with code 1 and reports the missing reference

#### Scenario: Changed element without before
- **WHEN** transition `T3` has `diff: changed` and no `before`
- **THEN** the check exits with code 1 and reports `T3` with rule 4

#### Scenario: Removed state still targeted
- **WHEN** state `CLOSED` has `diff: removed` and unchanged transition `T2` has `to: CLOSED`
- **THEN** the check exits with code 1 and reports `T2` with rule 6

### Requirement: Scenario references SHALL use capability and scenario name

A scenario reference SHALL have the form `<capability>/<scenario name>`, where `<capability>` is a folder under the change's `specs/` and `<scenario name>` matches the text after `#### Scenario:` in that spec file.

#### Scenario: Valid reference
- **WHEN** `specs/order-cancel/spec.md` contains `#### Scenario: 已支付订单取消后进入退款中`
- **THEN** the reference `order-cancel/已支付订单取消后进入退款中` is valid

### Requirement: design.md SHALL contain a visualization decision section

When a change has `design.md`, it SHALL contain a section titled `可视化判定`. The section SHALL state for state changes and for flow changes whether the condition is hit, and SHALL name the machine or flow IDs that cover each hit. When the change has no `design.md`, the section is not required.

#### Scenario: Missing section
- **WHEN** `design.md` exists and has no `可视化判定` section
- **THEN** the check exits with code 1 and reports rule 5

#### Scenario: Declared hit without a model
- **WHEN** the section declares a state-change hit for `order-status` and the change model has no machine `order-status`
- **THEN** the check exits with code 1 and reports rule 5

#### Scenario: No design.md
- **WHEN** a change has no `design.md`
- **THEN** the check exits with code 0 for rule 5

### Requirement: The change-model check SHALL use the STE text check for rule 2

The change-model check SHALL pass the `name`, `trigger`, `guard` and `label` values to the `text` subcommand of the `openspec-ste` check script, which `add-ste-gate` provides, and SHALL report its blocking findings as rule 2 findings. When `openspec-ste` is not installed, the change-model check SHALL skip rule 2 and SHALL add a warning that names the skipped rule.

#### Scenario: Forbidden alias in a trigger
- **WHEN** a transition trigger is `用户退单` and `退单` is a forbidden alias
- **THEN** the change-model check reports a rule 2 finding with the replacement `取消`

#### Scenario: STE skill missing
- **WHEN** the change-model check cannot find `openspec-ste`
- **THEN** the check skips rule 2 and adds a warning

### Requirement: OpenSpec workflow SHALL run the change-model check with the STE check

The `openspec-propose`, `openspec-update-change`, `openspec-apply-change` and `openspec-verify-change` skills SHALL run the change-model check at the same points and with the same blocking behavior as the STE check.

#### Scenario: Apply with a blocking change-model finding
- **WHEN** `/opsx:apply` starts and the change-model check exits with code 1
- **THEN** the skill lists the findings and does not start any task

