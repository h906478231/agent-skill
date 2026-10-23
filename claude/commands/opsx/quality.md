---
name: "OPSX: Quality"
description: 实现后双轴独立评审（Phase 5.5）- 同一固定基线并行跑 Standards Review 与 Spec Fidelity Review，汇总裁决
allowed-tools: Bash(openspec:*), Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(node:*)
category: Workflow
tags: [workflow, review, quality]
---

在 `/opsx:apply` 编码完成之后、`/opsx:verify` 之前，对本次变更实际产生的代码做**双轴独立评审**：Standards Review 回答「代码写得合不合格」，Spec Fidelity Review 回答「实现是否忠实于需求与设计」。门禁纳入范围的各维度审的是设计，`/opsx:verify` 做最终验收，**这里逐行审实现本身**。

**IMPORTANT: 本命令不改代码。** 只报告 + 分级 + 留痕，修复动作回 `tasks.md` 加勾选项再做。想直接改用内置 `/simplify`，但那不构成闭环证据。

**Input**: 可指定变更名（如 `/opsx:quality add-auth`）。省略则从对话上下文推断；模糊时用 **AskUserQuestion** 让用户选。始终声明 "Using change: `<name>`"。

## 执行

加载 skill **`openspec-code-quality`**，按其中的前置、四个执行步骤（固定基线 → 并行调度两轴 → 汇总 → 命令级校验）与裁决闭环执行，不要在本文件里另行定义规则。规则事实源是该 skill 的 `shared/dual-axis-review.md`（skill 实际安装目录随 agent 而不同，**不要写死绝对路径**）。

关键约束（详见 skill）：

- 基线只生成一次：`node <GATE> baseline <changeRoot>`（`<GATE>` = skill `openspec-technical-review` 的 `scripts/implementation-gate.mjs`），两轴与汇总原样使用同一块；diff 为空则中止并提示先完成 `/opsx:apply`。
- 重跑前先运行 `node <GATE> classify <changeRoot> --from <上一轮 Fingerprint>`：只有注释差异时输出「无需新一轮」并停止；只在新增并已勾选的任务内修改的文件不登记，两轴按增量执行，勾选之后又有修改时照常登记，修改与任务对应不上或拿不准时照常登记（判断方法见 `post-implementation-changes.md` 登记步骤 6）；有其他未登记的文件（含门禁外提交）时，先按 skill `openspec-apply-change` 的 `shared/post-implementation-changes.md` 按档位登记到 `tasks.md` 的 `## 实现后修改登记`，再生成新基线。
- 等价增量轮：`classify` 的 `unregistered` 为空、`registered` 全部为 `等价` 时只跑 Standards，`review/spec-fidelity.md` 不修改，汇总写 `- Carried Axis: spec-fidelity`；有 `行为` 档位时两轴都重跑。
- 两个轴用两个独立子 agent 并行执行，**互不读取对方原始报告与汇总**；finding 格式沿用 skill `openspec-technical-review` 的 `shared/finding-format.md`，前缀 `STD-` / `SPEC-`，「位置」必须精确到 `文件:行号`。
- 汇总只做索引与裁决，不改写原始 finding；写完必须跑 `node <GATE> review <changeRoot>` 校验。
- L2/L3 必须跑两轴；L0/L1 推荐跑，未生成不阻断归档（等级取 `overview.md` 的分级行，读不到时按 L2/L3 处理）。
- **任一轴存在未闭环 Blocker 即 `BLOCKED`，不得 `/opsx:archive`**；「有条件通过」的条件既没有对应任务、也没有对应 `<文件>:<行号>`（只需修改规划产物时）视同 Blocker。

## 产物

`<changeRoot>/review/standards.md`、`review/spec-fidelity.md`、`review/code-review-summary.md` —— 随 `openspec archive` 归档。本命令不执行 `git add` 或 `git commit`。项目 `.gitignore` 忽略 `openspec/` 时，不得用 `git add -f` 加入产物。是否提交由用户决定。历史变更的 `review/code-quality.md` 仍被归档校验识别，不要求补跑。

## 关联

- 上游：`/opsx:apply`
- 下游：`/opsx:verify` → `/opsx:archive`
- 设计层门禁：`/opsx:review`（skill `openspec-technical-review`）
- 完整流程：`workflow/OpenSpec-AI-研发流程.md`
