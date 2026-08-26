---
name: "OPSX: Review"
description: Technical Review Gate - 编码前的架构/并发/性能/数据库/安全多角色技术评审门禁（交叉验证 II）
allowed-tools: Bash(openspec:*)
category: Workflow
tags: [workflow, review, gate, experimental, cross-validation]
---

技术评审门禁（Technical Review Gate）。插在 `/opsx:explore` 与 `/opsx:apply` 之间：方案已在 `design.md` 定稿，但尚未进入代码实现。

**核心机制：交叉验证 II - 五角色多维度交叉验证同一方案**。架构/并发/性能/数据库/安全五个专业视角独立审查，互相发现盲区。

**IMPORTANT: 本阶段不写任何业务代码。** 评审 Agent 只识别问题、给建议、产出评审文档；汇总后必须停在人工确认门禁，禁止自动继续 apply。

## 参数

- **变更名**（可选）：如 `/opsx:review add-auth`。省略则从对话上下文推断；仅一个活跃变更时自动选中；模糊或有多个时运行 `openspec list --json` 并用 **AskUserQuestion** 让用户选。始终声明 "Using change: `<name>`"。
- `--roles <a,b>`（可选）：增量重走，只重跑指定维度，其余沿用上轮 `review/<role>.md`。

## 执行

加载 skill **`openspec-technical-review`**，按其中的「前置校验 → Step 1 并行调度 → Step 2 汇总 → Step 3 停在人工确认」执行，不要在本文件里另行定义规则。

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

- 上游：`/opsx:explore` 产出 proposal.md（含第一性原理分析）/ design.md（含候选方案交叉验证矩阵）；`/opsx:overview` 生成变更总览
- **交叉验证链条**：
  - Phase 1 第一性原理 → 确保解决正确的问题
  - Phase 2 候选方案交叉验证 → 确保方案选择有依据
  - **Phase 3 五维度交叉验证（当前阶段）** → 确保方案无盲区、发现跨维度冲突
- 下游：人工批准后 `/opsx:apply` → `/opsx:quality` → `/opsx:verify`（交叉验证 III：实现与设计交叉核对）
- 完整流程与分级规则：`workflow/OpenSpec-AI-研发流程.md`

## 交叉验证机制说明

**五角色独立评审**：每个子 agent 只读 `proposal.md` + `design.md`，不看其他维度的 `review/<role>.md`，避免锚定偏差。

**典型交叉验证场景**：
- 幂等设计：并发维度认为"有唯一索引就够了" → 数据库维度发现"索引缺少 tenant_id 前导，跨租户会冲突"
- 缓存一致性：性能维度建议"缓存永不过期" → 架构维度发现"无过期机制导致脏数据无法更新"
- SQL 注入：安全维度发现"拼接 SQL" → 数据库维度进一步指出"预编译之外还需输入长度校验"

**汇总阶段责任**：
- 检测跨维度冲突（如：性能建议与安全建议矛盾）
- 标记冲突项必须在 design.md 中闭环，不能让矛盾的建议同时进入 tasks.md
