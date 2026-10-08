# ADR-0004: 状态图与流程图以变更模型为事实源，采用并集布局确定性渲染

- 状态：已接受
- 日期：2026-10-06
- 决策者：agent-skills 团队
- 关联变更：变更模型可视化（待创建）

## 背景

复杂变更中，状态迁移与对现有流程的改动只靠文字描述，开发者难以看出「改了什么」。需要离线可用、能标出变更前后差异（含迁移线）、可点击追溯到 Scenario、渲染确定的图，并且讲解视频要复用同一份图数据。

## 决策

**design.md 中的 `change-model` 代码块是状态图与流程图的唯一事实源。** 渲染脚本用 elkjs 对「变更前 ∪ 变更后」的并集图做一次布局，确定性生成 overview.md 中的 Mermaid、离线 overview.html（纯 SVG + 原生 JS）与讲解视频的场景数据。

- 并集布局：变更前、对比、变更后三个视图共用一套坐标，切换时未变元素不移动，只有变动元素出现、消失或变色。
- elkjs 随 skill 内置并固定版本，目标项目无需安装依赖。
- 渲染不经过 LLM；LLM 只负责编写 `change-model`，由 schema 校验与 lint 兜底。

## 备选方案

| 方案 | 否决理由 |
|------|---------|
| Mermaid + 内联 mermaid.js | stateDiagram 不能给迁移线着色；前后两次渲染布局不同；交互依赖 Mermaid 内部 DOM；离线体积约 3MB |
| Graphviz + viz.js | 前后两次渲染布局不同；无法直接复用给视频 |
| D2 | 需安装二进制；LLM 编写熟练度低；交互仅 tooltip / link |
| archify | 每张图由 LLM 编写并多视口校验，耗时且结果不确定；不保留差异着色 |

## 后果

- LLM 需按 schema 编写新格式；schema 与示例随 skill 分发。
- design.md 在 IDE 预览中只显示 YAML，图需看 overview.md 或 overview.html。
- 时序图不纳入变更模型，仍在 design.md 中直接写 Mermaid `sequenceDiagram`。
