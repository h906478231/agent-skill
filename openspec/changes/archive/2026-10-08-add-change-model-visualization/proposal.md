## Why

复杂变更会修改多个状态之间的迁移，也会修改现有流程。当前这些内容只用文字和 ASCII 图描述，`openspec-change-overview` 也只画变更后的流程。开发者必须自己对比前后差异，才能知道改了什么。本变更引入变更模型：用结构化数据描述状态与流程的变动，再确定性渲染为可对比、可点击追溯的离线图。

## 第一性原理分析

### 表面需求 vs 底层问题

- **用户提出的需求**：多状态变动之间的关系、对现有流程的变动，不能只有文字描述；复杂变更要用图表或交互式 HTML 直观显示。
- **真正要解决的问题**：开发者要看出「这次改了哪些状态、哪些迁移、哪些流程步骤」，并能确认每个变动都有 Scenario 覆盖。只画变更后的图不能回答「改了什么」。
- **是否存在需求误解**：图本身不是目标。如果图由 LLM 每次自由生成，图也需要人工审核，读者负担反而增加。因此图必须从同一份结构化事实源确定性生成（ADR-0004）。

### 基本约束

| 约束类型 | 具体约束 | 影响 |
|---|---|---|
| 业务约束 | HTML 必须离线可用 | 不能使用 CDN；渲染结果为单个 HTML 文件，不在运行时加载外部资源 |
| 技术约束 | 前后对比要让读者跟住差异 | 变更前与变更后必须共用一套坐标（并集布局） |
| 技术约束 | 目标项目不一定执行 `npm install` | 布局库与 YAML 解析库随 skill 内置 |
| 技术约束 | 变更等级在 Phase 3 才判定，propose 阶段拿不到 | 「可视化判定」小节的触发条件不能依赖等级 |
| 依赖约束 | 禁用别名检查由 `add-ste-gate` 提供 | 本变更依赖 `add-ste-gate` 先实现 |

### 必要性验证

- **不做会怎样**：状态与流程的变动散落在 design 文字与 spec Scenario 中。读者要自己拼出前后差异；新增迁移缺少 Scenario 时，没有任何步骤能发现。
- **做了能带来什么**：变更前、对比、变更后三个视图共用坐标，切换时只有变动元素变化；点击迁移可以看到触发条件、guard 与 Scenario；新增或修改的迁移缺少 Scenario 时被阻断。
- **是否有更简单的替代方案**：在 design.md 中直接写 Mermaid。成本最低，但 stateDiagram 不能给迁移线着色，前后两张图布局不同，也不能被讲解视频复用（ADR-0004）。
- **必要性结论**：必须做。它也是 `add-explainer-video` 的场景数据来源。

## What Changes

- 新增变更模型格式：design.md 中的 `change-model` 代码块，包含 `machines`（状态机）与 `flows`（流程），用 `causes` 联动，用 `diff` / `before` 标记变动，用 `scenarios` 挂 Scenario。第一版不包含时序图、字段变更、代码映射。
- 新增变更模型检查（6 项，全部阻断）：schema 与引用、禁用别名、Scenario 覆盖、`changed` 必须有 `before`、可视化判定一致、已删除状态无指向。
- 新增「可视化判定」小节：design.md 存在时必须包含，逐条声明状态变动、流程变动是否命中。
- 新增并集布局与渲染：内置 elkjs 计算一次布局，输出布局 JSON、派生 Mermaid 与离线 `overview.html`。
- 修改 `openspec-change-overview`：有变更模型时生成 `overview.html`，overview.md 第 2 块嵌入派生 Mermaid。
- 修改 `openspec-propose` / `openspec-update-change` / `openspec-apply-change` / `openspec-verify-change`：在 STE 检查的同一卡点运行变更模型检查。

## Capabilities

### New Capabilities

- `change-model`: 变更模型格式、可视化判定小节、6 项阻断检查与 OpenSpec 卡点调用。
- `change-model-rendering`: 并集布局、布局 JSON、派生 Mermaid、离线交互式 `overview.html`。

### Modified Capabilities

- 无。`openspec/specs/` 当前没有主规格。本变更调用 `add-ste-gate` 提供的 `ste-lint.mjs text` 子命令，不修改 `openspec-ste`。

## Impact

- **新增**：`skills/openspec-change-overview/scripts/change-model.mjs`、`shared/change-model.md`（格式说明与示例）、`assets/overview-template.html`、`vendor/elk.bundled.js`（EPL-2.0，保留许可证文件）、`vendor/js-yaml.mjs`；`scripts/test-change-model.mjs`。
- **修改**：`openspec-change-overview/SKILL.md`；四个 OpenSpec skill 的卡点段落；`openspec-propose` 的 design 编写说明。
- **变更产物**：变更目录新增 `overview.html`，提交 git，随 archive 归档。
- **依赖**：Node.js ≥ 16；前置变更 `add-ste-gate`。
- **关联决策**：ADR-0004（变更模型为事实源、并集布局）。
