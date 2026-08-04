---
name: "OPSX: Review"
description: Technical Review Gate - 编码前的架构/并发/性能/数据库/安全多角色技术评审门禁
allowed-tools: Bash(openspec:*)
category: Workflow
tags: [workflow, review, gate, experimental]
---

技术评审门禁（Technical Review Gate）。插在 `/opsx:explore` 与 `/opsx:apply` 之间：方案已在 `design.md` 定稿，但尚未进入代码实现。

**IMPORTANT: 本阶段不写任何业务代码。** 评审 Agent 只识别问题、给建议、产出评审文档；汇总后必须停在人工确认门禁，禁止自动继续 apply。

## 参数

- **变更名**（可选）：如 `/opsx:review add-auth`。省略则从对话上下文推断；仅一个活跃变更时自动选中；模糊或有多个时运行 `openspec list --json` 并用 **AskUserQuestion** 让用户选。始终声明 "Using change: `<name>`"。
- `--roles <a,b>`（可选）：增量重走，只重跑指定维度，其余沿用上轮 `review/<role>.md`。

## 执行

加载 skill **`opsx-technical-review`**，按其中的「前置校验 → Step 1 并行调度 → Step 2 汇总 → Step 3 停在人工确认」执行，不要在本文件里另行定义规则。

该 skill 及其 `shared/` 目录是以下内容的唯一事实源，本命令不复制：

| 内容 | 位置 |
|------|------|
| finding 字段、三条硬规则、维度结论取值 | `shared/finding-format.md` |
| 上轮闭环验证（重走门禁时） | `shared/closed-loop-verification.md` |
| 门禁裁决、重走范围、牵连关系、驳回留痕 | `shared/gate-policy.md` |
| 五个维度的审查清单 | `roles/<role>.md` |

## 产物

| 路径 | 内容 |
|------|------|
| `<changeRoot>/review/<role>.md` | 各维度评审详情 |
| `<changeRoot>/review-summary.md` | 摘要 / 裁决 / 风险 / 条件清单 / 术语表 / 人工确认区 |

产物提交 git，随 `openspec archive` 整体归档到 `changes/archive/<name>/`。

## 关联

- 上游：`/opsx:explore` 产出 proposal.md / design.md；`/opsx:overview` 生成变更总览
- 下游：人工批准后 `/opsx:apply` → `/opsx:quality` → `/opsx:verify`
- 完整流程与分级规则：`workflow/OpenSpec-AI-研发流程.md`
