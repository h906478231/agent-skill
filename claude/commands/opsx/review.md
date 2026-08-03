---
name: "OPSX: Review"
description: Technical Review Gate - 编码前的架构/并发/性能/数据库/安全多角色技术评审门禁
allowed-tools: Bash(openspec:*)
category: Workflow
tags: [workflow, review, gate, experimental]
---

技术评审门禁（Technical Review Gate）。插在 `/opsx:explore` 与 `/opsx:apply` 之间：方案已在 `design.md` 定稿，但尚未进入代码实现。

**IMPORTANT: 本阶段不写任何业务代码。** 所有评审 Agent 只识别问题、给建议、产出评审文档。产出汇总后必须停在人工确认门禁，禁止自动继续 apply。

**Input**: 可指定变更名（如 `/opsx:review add-auth`）。省略则从对话上下文推断；模糊或有多个时必须用 **AskUserQuestion** 让用户选择。

可选参数 `--roles <a,b>`：增量重走，只重跑指定维度（见「重走门禁」）。

## Steps

### 1. 选择变更

有变更名则用之。否则：
- 从对话上下文推断
- 仅有一个活跃变更时自动选中
- 模糊时运行 `openspec list --json`，用 **AskUserQuestion** 让用户选

始终声明："Using change: <name>"。

### 2. 前置校验（硬性）

```bash
openspec status --change "<name>" --json
```

解析 `changeRoot`，确认：

1. `proposal.md` 存在且非空 —— 需求已澄清
2. `design.md` 存在且非空，且含「推荐方案」 —— 方案已确定

**任一不满足则中止**，提示先运行 `/opsx:explore` 补齐。这体现核心原则：需求未明确不分析性能，方案未确定不开始编码。

校验通过后，在 `changeRoot` 下创建 `review/` 目录。

### 3. 判定评审范围

参照 `workflow/OpenSpec-AI-研发流程.md` 的「门禁适用范围分级」，向用户确认本次跑哪些维度。若变更明显属于 L0（纯文案/配置/注释），提示可豁免门禁并直接走 apply，不强行启动五角色。

### 4. 并行调度专项评审 Agent

读取 skill `opsx-technical-review` 的角色提示词，对每个纳入范围的维度用 **Agent 工具**启动一个子 agent（一条消息内并行发起）。

每个子 agent 的 prompt = 对应 `roles/<role>.md` 全文 + 变更的 `proposal.md`/`design.md` 全文 + 「把结论写入 `review/<role>.md`」。

**若 `design.md` 末尾存在「## 评审意见闭环记录」区块（说明这是重走门禁），必须把该区块一并放进每个子 agent 的 prompt，并附上以下指令**（子 agent 是全新上下文，没有上轮记忆，不给就会重复报同一问题或漏掉验证）：

> 先做上轮闭环验证，再做本轮审查。对闭环记录中「维度」属于你的每一行，按「落在 design 的哪一节」去 design.md 核实改动是否真的落地且真正解决了原始问题。
> - 已真正闭环 → 不重复报告，在 `review/<role>.md` 的「上轮闭环验证」小节记为「已闭环」
> - 声称已改但查无对应内容、或改动不足以解决原始问题 → **沿用原 finding ID** 重新报告，severity 保持 Blocker，说明「上轮声称已闭环但实际未闭环」
> - 标注 risk accepted / 驳回 → 尊重决策不再作 Blocker 重复报告；若认为决策依据已不成立，可降级为 Major 并说明理由
>
> 本轮新问题用新 ID，避免与历史 ID 冲突。

| 维度 | 角色提示词 | 输出 |
|------|-----------|------|
| 架构 | `roles/architecture.md` | `review/architecture.md` |
| 并发 | `roles/concurrency.md` | `review/concurrency.md` |
| 性能 | `roles/performance.md` | `review/performance.md` |
| 数据库 | `roles/database.md` | `review/database.md` |
| 安全 | `roles/security.md` | `review/security.md` |

每条 finding 统一字段：`ID | 严重级别(Blocker/Major/Minor) | 位置 | 风险根因 | 建议修复`。
每份评审末尾给出维度结论：`通过 / 有条件通过 / 打回`。

若环境支持 Pi Workflow，可改用 `technical-review-gate.workflow.js`（`args = { change, roles }`）一次性并行 fan-out，产物一致。

### 5. 汇总为 review-summary.md

读取 `review/*.md`（含本轮重跑与沿用上轮的维度），写入 `review-summary.md`：

1. **门禁裁决**：任一维度 `verdict=打回` 或存在未闭环 Blocker → `BLOCKED`；否则 `READY_FOR_HUMAN_APPROVAL`
2. **各维度结论一览表**：维度 | 结论 | Blocker数 | Major数 | Minor数 | 本轮重跑/沿用上轮
3. **已确认风险**：按维度 + 严重级别汇总
4. **修改建议**：合并去重，标注需在 `design.md` / `tasks.md` 落实的项
5. **「有条件通过」的条件清单**：每条必须能映射到 `tasks.md` 的一个勾选项，否则视同 Blocker
6. **上轮闭环验证结果**（仅重走门禁时）：汇总哪些历史 finding 已闭环、哪些声称已闭环但实际未闭环。**「声称已闭环但实际未闭环」一律按未闭环 Blocker 计入裁决**
7. **人工确认区**：留一行 `Technical Review Approved: __________`（待人工填写），注明批准前禁止 apply

裁决为 `BLOCKED` 时，在输出中明确告知用户：回改 `design.md` 后必须在其末尾「## 评审意见闭环记录」区块登记每条 Blocker，格式为 `finding ID | 维度 | 原始问题 | 处理方式 | 落在 design 的哪一节 | 轮次`（本轮为 R1，下一轮 R2，依此类推）。**下一轮评审 Agent 依赖该区块验证闭环，不登记就会重复报同一问题。**

### 6. 停在人工确认门禁

输出汇总后**停止**。提示人工：

- 审阅 `review-summary.md` 与 `review/*.md`
- 认可后在人工确认区写入批准人姓名与日期
- 之后才可运行 `/opsx:apply`

若裁决为 `BLOCKED`，提示先回 `design.md` 闭环 Blocker（按闭环留痕格式记录），再重走门禁。

## 重走门禁

铁律：**门禁输入是 `design.md`（+ `proposal.md`）。输入变了且变在评审维度上 → 重走；没变 → 不重走。**

- **全量重走**：改动牵动跨维度地基（模块归属、一致性口径、表模型）→ 纳入范围的维度全跑
- **增量重走**：改动只碰单一维度（纯转义、纯索引调整）→ `--roles security`，其余沿用上轮 `review/<role>.md`
- **裁决始终对全部纳入维度求值**：沿用维度若仍有未闭环 Blocker，门禁仍 `BLOCKED`
- **不认可评审结论**（误报/知情接受）：不改 design 就不重走，在 `review/<role>.md` 与 `review-summary.md` 按驳回留痕格式记录，仅更新裁决计数
- **判断口诀**：宁可多跑一个维度，不可漏跑被牵连的维度

## 关联

- 上游：`/opsx:explore` 产出 proposal.md / design.md
- 下游：人工批准后 `/opsx:apply`
- 完整流程与分级规则：`workflow/OpenSpec-AI-研发流程.md`
- 门禁资产（roles / hook / workflow）：skill `opsx-technical-review`
