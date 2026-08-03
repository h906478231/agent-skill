---
name: opsx-technical-review
description: OpenSpec 技术评审门禁（Technical Review Gate）。在 OpenSpec Explore 阶段、技术方案已确定（design.md 完成）但尚未进入代码实现（openspec apply）之前，调度架构/并发/性能/数据库/安全五个专项评审 Agent 对方案做多角色评审，汇总为 review-summary.md，并停在人工确认门禁。核心原则：需求未明确不分析性能，方案未确定不开始编码。用于任何 OpenSpec 变更在编码前的质量门禁。
---

# OpenSpec 技术评审门禁（Technical Review Gate）

## 定位

这是插在 OpenSpec `explore/propose` 与 `apply` 之间的**质量门禁**。方案已在 `design.md` 中确定，但**还没有进入代码实现**。本门禁调度五个专项评审 Agent，对方案做架构/并发/性能/数据库/安全多角色评审，汇总风险与修改建议，交人工确认后才允许进入 `openspec apply`。

```
OpenSpec Explore ──> 需求澄清 ──> 方案探索 ──> 技术方案确认(design.md)
                                                      │
                                                      ▼
                                        ┌── Technical Review Gate ──┐
                                        │  架构 / 并发 / 性能        │  ← 本 skill
                                        │  数据库 / 安全             │
                                        └───────────┬───────────────┘
                                                    ▼
                                            review-summary.md
                                                    ▼
                                          【人工确认评审结果】← 硬门禁，停在这里
                                                    ▼
                                            OpenSpec Apply ──> 代码实现 ──> 测试+审查
```

## 铁律（Guardrails）

- **本阶段不写业务代码**。所有评审 Agent 只识别问题、给建议，产出评审文档。
- **前置条件**：变更必须已有 `proposal.md`（需求已澄清）和 `design.md`（方案已确定且含推荐方案）。缺任一则拒绝启动门禁，提示先补齐。
- **人工门禁不可跳过**：产出 `review-summary.md` 后必须停下，等待人工写入批准标记，禁止自动继续 `apply`。

### 门禁的真实强制力（别高估）

门禁由三道防线组成，强度递减 —— 它拦得住「忘了」，拦不住「铁了心要绕」：

| 防线 | 覆盖 | 拦不住什么 |
|------|------|-----------|
| `hooks/check-review-approval.sh`（PreToolUse/Bash） | Bash 执行 `openspec apply` / `opsx apply` | `/opsx:apply` 斜杠命令、skill 调用（不产生 Bash 命令，hook 永不触发） |
| apply skill / command 的 Step 2 前置校验 | `/opsx:apply` 与 `openspec-apply-change` 两条调用路径 | 提示词级约束，模型可能被用户指令覆盖 |
| 人工签字 + code review | 最终把关 | 签字人不看就签 |

**三道全绕过的方式始终存在**：直接让 Agent 用 Edit/Write 改代码，不经过任何 apply 入口。所以门禁定位是**流程纪律工具，不是安全边界**；它保证「正常路径上不会漏评审」，不保证「无法绕过」。

hook 需在 `~/.claude/settings.json` 的 `PreToolUse` 中注册后才生效，未注册时第一道防线为零 —— 注册方法见 `workflow/OpenSpec-AI-研发流程.md`「门禁启用与部署」。

## 前置校验

1. 解析变更名（参数传入，或从对话上下文推断，或 `openspec list --json` 让用户选）。
2. 读取变更状态与产物路径：
   ```bash
   openspec status --change "<name>" --json
   ```
3. 确认 `proposal.md` 与 `design.md` 均存在且非空；`design.md` 含「推荐方案」。否则中止并提示补齐（体现「方案未确定，不开始编码」）。
4. 在 `changeRoot` 下创建 `review/` 目录。

## 执行步骤

### Step 1 — 并行调度五个专项评审 Agent

对以下每个角色，用 **Agent 工具**启动一个子 agent（可并行，一条消息多个 tool use）。每个子 agent 的 prompt = 对应角色提示词文件内容 + 变更的 `proposal.md`/`design.md` 全文 + 「把结论写入 review/<role>.md」。

| 角色 | 角色提示词 | 输出 |
|------|-----------|------|
| 架构评审 | `roles/architecture.md` | `review/architecture.md` |
| 并发评审 | `roles/concurrency.md` | `review/concurrency.md` |
| 性能评审 | `roles/performance.md` | `review/performance.md` |
| 数据库评审 | `roles/database.md` | `review/database.md` |
| 安全评审 | `roles/security.md` | `review/security.md` |

> 若当前环境支持 Pi Workflow，可改用 `~/.claude/skills/opsx-technical-review/technical-review-gate.workflow.js` 一次性并行 fan-out（见该脚本）。二者产出一致。
>
> 注：本 skill 已全局化到 `~/.claude/skills/opsx-technical-review/`（跨项目复用），角色提示词、workflow、门禁 hook 均位于该全局目录，不再依赖任何单个项目的 `.agents/` 目录。

每条 finding 统一字段：`ID | 严重级别(Blocker/Major/Minor) | 位置 | 风险根因 | 建议修复`。
每份评审末尾给出该维度结论：`通过 / 有条件通过 / 打回`。

**重走门禁时的闭环验证（关键）**：若 `design.md` 末尾存在「## 评审意见闭环记录」区块，**必须把该区块一并放进每个子 agent 的 prompt**，并要求它先验证上轮闭环、再做本轮审查。子 agent 是全新上下文，没有上轮记忆 —— 不给该区块，它要么重复报同一问题，要么完全漏掉验证。指令要点：

- 对闭环记录中「维度」属于该角色的每一行，按「落在 design 的哪一节」去 `design.md` 核实改动是否真的落地且真正解决了原始问题。
- 已真正闭环 → 不重复报告，在 `review/<role>.md` 的「上轮闭环验证」小节记为「已闭环」。
- 声称已改但查无对应内容、或改动不足以解决原始问题 → **沿用原 finding ID** 重新报告，severity 保持 Blocker，说明「上轮声称已闭环但实际未闭环」。
- 标注 risk accepted / 驳回 → 尊重决策，不再作为 Blocker 重复报告；若认为决策依据已不成立，可降级为 Major 并说明理由。
- 本轮新问题用新 ID，避免与历史 ID 冲突。

### Step 2 — 汇总为 review-summary.md

读取 `review/*.md`，汇总写入 `review-summary.md`：

- **门禁裁决**：任一维度出现未闭环 Blocker → 门禁状态 `BLOCKED`；否则 `READY_FOR_HUMAN_APPROVAL`。
- **已确认风险**：按维度 + 严重级别汇总（Blocker/Major/Minor 计数）。
- **修改建议**：合并各维度建议，去重，标注需在 `design.md`/`tasks.md` 落实的项。
- **最终设计调整**：需要回改 design 的点（若有）。
- **上轮闭环验证结果**（仅重走门禁时）：哪些历史 finding 已闭环、哪些声称已闭环但实际未闭环。**「声称已闭环但实际未闭环」一律按未闭环 Blocker 计入裁决。**
- **人工确认区**：留一行待人工填写的批准标记。

裁决为 `BLOCKED` 时，须明确告知用户：回改 `design.md` 后必须在其末尾「## 评审意见闭环记录」区块登记每条 Blocker，格式 `finding ID | 维度 | 原始问题 | 处理方式 | 落在 design 的哪一节 | 轮次`。下一轮评审 Agent 依赖该区块验证闭环。

### Step 3 — 停在人工确认门禁

输出汇总后**停止**。提示人工：
- 审阅 `review-summary.md` 与 `review/*.md`；
- 认可后在 `review-summary.md` 的人工确认区写下 `Technical Review Approved`（可加签名/日期）；
- 之后才可运行 `/opsx:apply` 进入实现。

若门禁为 `BLOCKED`，建议先回 `design.md` 闭环 Blocker，再重跑门禁。

## 重走门禁（迭代回路）

铁律：**门禁输入是 `design.md`（+ `proposal.md`）。输入变了且变在评审 5 维度上 → 重走；没变 → 不重走。** 详见 `workflow/OpenSpec-AI-研发流程.md` 的「迭代回路操作手册」。

- **全量重走**：改动牵动跨维度地基（模块归属、计数一致性、表模型）时，5 维度全跑。
  - Workflow：`{ "change": "<name>" }`（roles 缺省）
  - 交互式：主 agent 重启 5 个评审子 agent。
- **增量重走**：改动只碰单一维度（纯安全转义、纯索引调整）时，只重跑受影响维度，其余沿用上轮 `review/<role>.md`。
  - Workflow：`{ "change": "<name>", "roles": ["security"] }` 或 `["architecture","concurrency"]`
  - 交互式：主 agent 只对指定维度重启子 agent，其余读取上轮 review 文件参与汇总。
  - **裁决仍对全部 5 维度求值**：沿用维度若仍有未闭环 Blocker，门禁仍 `BLOCKED`。
- **不认可评审结论**（误报/知情接受）：不改 design 就不重走，在 `review/<role>.md` 与 `review-summary.md` 留痕（驳回理由 / risk accepted），仅更新裁决计数。
- **判断口诀**：宁可多跑一个维度，不可漏跑被牵连的维度。

## 与整体流程的关系

- 上游：`/opsx:explore`（需求澄清+方案探索）产出 proposal.md / design.md。
- 本门禁：`/opsx:review`（本 skill）产出 review/*.md + review-summary.md，停在人工确认。
- 下游：人工批准后 `/opsx:apply` 编码 → Phase 6 验证（编译/单测/集测/静态扫描 + AI Code Review，详见 `workflow/OpenSpec-AI-研发流程.md`）→ `openspec archive`。
- 角色分工：OpenSpec = 流程与设计文档中心；本门禁 = AI 评审编排；Coding Agent = 代码执行者。
