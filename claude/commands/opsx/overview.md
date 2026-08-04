---
name: "OPSX: Overview"
description: 生成变更总览 overview.md - 文档地图/端到端流程/字段变更台账/规则条件可追溯矩阵
allowed-tools: Bash(openspec:*)
category: Workflow
tags: [workflow, overview, traceability]
---

为一个 OpenSpec 变更生成单页总览，回答两个问题：**规则条件有没有遗漏**、**整体运行流程与过程中的字段怎么变**。

**Input**: 可指定变更名（如 `/opsx:overview add-auth`）。省略则从对话上下文推断；模糊或有多个时运行 `openspec list --json` 并用 **AskUserQuestion** 让用户选。始终声明 "Using change: `<name>`"。

## 执行

加载 skill **`opsx-change-overview`**，按其中的前置校验与五块产出结构执行，不要在本文件里另行定义规则。

关键约束（详见 skill）：

- `overview.md` 是**派生视图**，整体重新生成，**禁止手改** —— 内容有误请改事实源后重跑。
- 事实源没写的一律标 `未定义`，不得用常识补全。
- 规则条件矩阵必须覆盖 `proposal` 验收条件 / `spec` scenario / `design` 约束 / `review-summary` 的「有条件通过」条件四类来源；**映射不到 tasks 的条件标 `⚠️ 未落地`，视同 Blocker**，且未落地条数要写在文件开头。

## 产物

`<changeRoot>/overview.md` —— 提交 git，随 `openspec archive` 归档。

## 刷新时机

`design.md` 定稿后首次生成 → 门禁出 `review-summary.md` 后刷新 → `/opsx:verify` 前刷新并逐条核对条件落地情况。

## 关联

- 上游：`/opsx:explore`、`/opsx:propose`
- 下游：`/opsx:review`（评审前对齐）、`/opsx:verify`（条件核对）
- 完整流程：`workflow/OpenSpec-AI-研发流程.md`
