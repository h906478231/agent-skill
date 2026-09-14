---
name: "OPSX: Grill"
description: 未决决策的分轮访谈，复用有效共识，沉淀 CONTEXT.md 与 ADR；事实待查用 explore
allowed-tools: Bash(openspec:*)
category: Workflow
tags: [workflow, interview, domain-modeling, experimental]
---

Grill 访谈：只处理本次范围内的未决决策。L2/L3 检查决策充分性，已有有效共识不重复访谈。事实待查用 explore，无阻断未知直接 propose/update。

**IMPORTANT: 本阶段不写任何业务代码。** 只访谈、查证、沉淀。

## 参数

- **主题或变更名**（可选）：如 `/opsx:grill 订单导出` 或 `/opsx:grill add-order-export`。省略则询问用户要澄清什么。

## 执行

加载 skill **`openspec-grill`**，按其中的「Step 0 前置加载 → Step 1 建决策树 → Step 2 frontier 分轮 → Step 3 职责划分 → Step 4 沉淀资产 → Step 5 结束条件 → Step 6 产出对接」执行，不要在本文件里另行定义规则。

该 skill 及其 `shared/` 目录是以下内容的唯一事实源，本命令不复制：

| 内容 | 位置 |
|------|------|
| 决策树 / frontier / 分轮格式 / 结束条件 | `shared/interview-rules.md` |
| CONTEXT.md 术语表格式与更新规则 | `shared/context-format.md` |
| ADR 格式与三条件门槛 | `shared/adr-format.md` |

## 产物

| 路径 | 内容 | 归档 |
|------|------|------|
| `CONTEXT.md`（项目根） | 领域术语表（统一语言） | **不随变更归档**（项目级资产，跨变更复用） |
| `docs/adr/NNNN-<slug>.md` | 难以撤销的重大权衡决策 | **不随变更归档**（项目级资产） |
| 共识摘要（对话内） | 已定决策 / 弃案 / 开放问题 | 由后续 explore/propose 落入 proposal.md 第一性原理区块 |

## 关联

- 下游：`/opsx:explore`（带着共识产出 proposal.md + design.md）→ `/opsx:propose` 生成 tasks.md 时按垂直切片拆分（skill `openspec-propose` 的 `shared/task-slicing.md`）
- 事实探索子 agent 的返回走 skill `openspec-discussion-sync` 五段契约
- 完整流程与分级规则：`workflow/OpenSpec-AI-研发流程.md`
