---
name: opsx-technical-review
description: OpenSpec 技术评审门禁（Technical Review Gate，交叉验证 II）。在 OpenSpec Explore 阶段、技术方案已确定（design.md 完成）但尚未进入代码实现（openspec apply）之前，调度架构/并发/性能/数据库/安全五个专项评审 Agent 对同一方案做五维度交叉验证，汇总为 review-summary.md，并停在人工确认门禁。核心原则：需求未明确不分析性能，方案未确定不开始编码。用于任何 OpenSpec 变更在编码前的质量门禁。
---

# OpenSpec 技术评审门禁（Technical Review Gate）

## 定位

这是插在 OpenSpec `explore/propose` 与 `apply` 之间的**质量门禁**。方案已在 `design.md` 中确定，但**还没有进入代码实现**。本门禁调度五个专项评审 Agent，对方案做架构/并发/性能/数据库/安全多角色评审，汇总风险与修改建议，交人工确认后才允许进入 `openspec apply`。

**核心机制：交叉验证 II - 五角色多维度交叉验证同一方案**。架构/并发/性能/数据库/安全五个专业视角独立审查，互相发现盲区。

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

## 资产结构

```
opsx-technical-review/
├── SKILL.md                          # 本文件：门禁编排流程
├── shared/                           # 共用规则的唯一事实源，roles / 命令 / workflow 一律引用不复制
│   ├── finding-format.md             #   finding 七字段 + 三条硬规则 + verdict + 输出骨架
│   ├── closed-loop-verification.md   #   重走门禁时如何验证上轮 Blocker 真的闭环
│   ├── gate-policy.md                #   裁决判定 / 重走范围 / 牵连关系 / 驳回与 risk accepted
│   └── apply-gate-check.md           #   apply 前的人工签字校验（apply skill 与 command 共用）
├── roles/                            # 五个角色：只保留角色定位 + 审查清单 + 本维度差异
│   ├── architecture.md  concurrency.md  performance.md  database.md  security.md
├── hooks/check-review-approval.sh    # PreToolUse 门禁 hook（拦截未签字的 openspec apply）
├── agents/openai.yaml                # skill 接口描述
└── technical-review-gate.workflow.js # Pi Workflow：并行 fan-out 五角色 + 结构化汇总
```

## 路径约定：`<SKILL_DIR>`

本 skill 内部与外部的所有引用都写成**相对 skill 目录**的形式（如 `shared/finding-format.md`、`roles/database.md`）。**不要写死绝对路径** —— skills 根目录随 agent 而不同：

| Agent | skills 根目录 |
|-------|-------------|
| Claude Code | `~/.claude/skills/` |
| Codex CLI | `~/.codex/skills/` |
| opencode | `~/.config/opencode/skills/`（也会读 `~/.claude/skills/`） |
| Cursor | `~/.cursor/skills/` |
| Gemini CLI | `~/.gemini/skills/` |
| 项目级安装 | `<项目>/.claude/skills/` 等 |
| 直接在本仓使用 | `<仓库>/skills/` |

`<SKILL_DIR>` = 本 skill 实际所在目录，即「本 SKILL.md 所在的目录」。**主 agent 在启动子 agent 前必须先解析出它的绝对路径**，因为子 agent 拿到的是纯文本 prompt，没有「当前 skill 目录」这个上下文。

解析顺序（取第一个命中的）：

```bash
for root in "${CLAUDE_PROJECT_DIR:-.}/.claude/skills" ~/.claude/skills ~/.codex/skills \
            ~/.config/opencode/skills ~/.cursor/skills ~/.gemini/skills ./skills; do
  [ -f "$root/opsx-technical-review/SKILL.md" ] && echo "$root/opsx-technical-review" && break
done
```

都没命中时，用 Glob 搜 `**/opsx-technical-review/SKILL.md` 取其所在目录。**项目级优先于全局** —— 项目内如果放了定制版，应当用项目内那份。

## 铁律（Guardrails）

- **本阶段不写业务代码**。所有评审 Agent 只识别问题、给建议，产出评审文档。
- **前置条件**：变更必须已有 `proposal.md`（需求已澄清）和 `design.md`（方案已确定且含推荐方案）。缺任一则拒绝启动门禁，提示先补齐。
- **人工门禁不可跳过**：产出 `review-summary.md` 后必须停下，等待人工写入批准标记，禁止自动继续 `apply`。

### 门禁的真实强制力（别高估）

门禁由三道防线组成，强度递减 —— 它拦得住「忘了」，拦不住「铁了心要绕」。**三道全绕过的方式始终存在**：直接让 Agent 用 Edit/Write 改代码，不经过任何 apply 入口。所以门禁定位是**流程纪律工具，不是安全边界**。

**hook 未在 `~/.claude/settings.json` 注册时第一道防线为零。** 详见本 skill 的 `hooks/` 目录与注册说明。

## 前置校验

1. 解析变更名（参数传入，或从对话上下文推断，或 `openspec list --json` 让用户选）。
2. 读取变更状态与产物路径：
   ```bash
   openspec status --change "<name>" --json
   ```
3. 确认 `proposal.md` 与 `design.md` 均存在且非空；`design.md` 含「推荐方案」。否则中止并提示补齐（体现「方案未确定，不开始编码」）。
4. 判定评审范围：参照 [门禁分级标准](../../shared/workflow/gate-levels.md) 向用户确认跑哪些维度。明显属于 L0（纯文案/配置/注释）的变更，提示可豁免门禁直接 apply，不强行启动五角色。
5. 在 `changeRoot` 下创建 `review/` 目录。

## 执行步骤

### Step 1 — 并行调度专项评审 Agent

**交叉验证前提：每个子 agent 只读 `proposal.md` + `design.md`，不看其他维度的 `review/<role>.md`，避免锚定偏差。**

对每个纳入范围的角色，用 **Agent 工具**启动一个子 agent（可并行，一条消息多个 tool use）。

| 角色 | 角色提示词 | 输出 |
|------|-----------|------|
| 架构评审 | `roles/architecture.md` | `review/architecture.md` |
| 并发评审 | `roles/concurrency.md` | `review/concurrency.md` |
| 性能评审 | `roles/performance.md` | `review/performance.md` |
| 数据库评审 | `roles/database.md` | `review/database.md` |
| 安全评审 | `roles/security.md` | `review/security.md` |

每个子 agent 的 prompt 需包含：

1. **`<SKILL_DIR>` 的绝对路径**（按上面「路径约定」解析），并说明「下文所有 `<SKILL_DIR>/...` 路径都替换为该值」。子 agent 是纯文本上下文，不给它这个值，它就找不到 `shared/` 下的规则文件；
2. 对应 `<SKILL_DIR>/roles/<role>.md` 全文 —— 其中已声明必读的共用规则文件，子 agent 自行读取；
3. 变更的 `proposal.md` / `design.md` 全文；
4. **若 `design.md` 末尾存在「## 评审意见闭环记录」区块**（说明这是重走门禁）：把该区块一并放进 prompt，并要求子 agent 先按 `<SKILL_DIR>/shared/closed-loop-verification.md` 做上轮闭环验证、再做本轮审查。子 agent 是全新上下文，没有上轮记忆 —— 不给该区块，它要么重复报同一问题，要么完全漏掉验证；
5. 「把结论写入 `review/<role>.md`」。

finding 字段、三条硬规则（白话 / 可复现触发场景 / 不修的后果）与维度结论取值，统一见 `shared/finding-format.md`，此处不重复。

> 若当前环境支持 Pi Workflow，可改用 `technical-review-gate.workflow.js` 一次性并行 fan-out（`args = { change, roles, skillDir }`；`skillDir` 省略时脚本会让子 agent 自行探测，显式传入更省一次探测）。二者产出一致。
>
> 注：`shared/`、`roles/`、workflow、门禁 hook 全部位于 `<SKILL_DIR>` 内，随 skill 一起安装，不依赖任何单个项目的目录结构。

### Step 2 — 汇总为 review-summary.md

读取 `review/*.md`（含本轮重跑与沿用上轮的维度），汇总写入 `review-summary.md`：

1. **摘要（给非设计者看）**：三句话说清「发现了什么 / 能不能开工 / 卡在哪」，不用专有名词。
2. **业务影响地图**（新增）：按业务功能分组展示风险，让产品/项目经理快速判断影响范围：
   ```markdown
   | 业务功能 | Blocker 数 | Major 数 | Minor 数 | 主要风险 |
   |---------|-----------|---------|---------|---------|
   | 素材上传 | 2 | 1 | 0 | 并发冲突导致配额失控、暂存资源被误删 |
   | 消息收藏 | 1 | 0 | 1 | 跨租户越权访问、URL 过期 |
   ```
3. **代码改动范围**（新增）：按模块聚合需要改动的代码位置，用于工作量评估：
   ```markdown
   | 代码模块 | 改动类型 | 相关 Finding | 预估影响 |
   |---------|---------|-------------|---------|
   | MaterialService | 方法逻辑 + 事务边界 | CONC-02, CONC-03 | 中等（核心上传流程） |
   | quota_usage 表 | 表结构 + 索引 | CONC-03 | 小（加字段和索引） |
   | staging_batch 表 | 表结构 + 状态机 | CONC-06 | 大（新增状态机逻辑） |
   ```
4. **执行误报检测**：按 `shared/false-positive-detection.md` 规则检测可能的误报或过度建议。生成"疑似误报检测"区块，列出需要人工复核的 finding。
5. **门禁裁决**：判定规则见 `shared/gate-policy.md`。**注意**：在计算裁决时，应考虑误报检测建议降级后的级别（如果用户选择应用自动降级）。
6. **各维度结论一览表**：维度 | 结论 | Blocker 数 | Major 数 | Minor 数 | 本轮重跑/沿用上轮。
7. **疑似误报检测**：列出可能的误报、过度建议、跨维度矛盾等，供人工复核。包含"自动降级建议"和"需人工判断"两类。
8. **已确认风险详细清单**：按维度 + 严重级别汇总，使用完整的 9 字段表格（含"影响业务功能"和"涉及代码模块"）。
9. **修改建议执行计划**：合并各维度建议，去重，明确标注：
   - 需在 `design.md` 中补充的设计细节（如状态机图、CAS 算法）
   - 需在 `tasks.md` 中新增的任务项（映射到具体 finding）
   - 建议的任务优先级（P0/P1/P2）和依赖关系
10. **跨维度冲突清单（交叉验证核心产出）**：不同维度的建议互相矛盾时列出（如性能建议与安全建议冲突）。**冲突项必须在 `design.md` 中闭环，不能让矛盾的建议同时进入 `tasks.md`。**
11. **「有条件通过」的条件清单**：`条件ID | 来源维度 | 条件内容 | 对应 tasks.md 任务 | 状态`。**映射不到 tasks 的条件视同 Blocker。**
12. **上轮闭环验证结果**（仅重走门禁时）：哪些历史 finding 已闭环、哪些声称已闭环但实际未闭环。后者一律按未闭环 Blocker 计入裁决。
13. **术语表**：只列本次评审实际出现的专有名词 → 白话解释。这是让签字人真正读懂 Blocker 的前提。
14. **人工确认区**：留一行 `Technical Review Approved: __________`（待人工填写），注明批准前禁止 apply。

裁决为 `BLOCKED` 时的告知内容与闭环记录格式，见 `shared/gate-policy.md`。

### Step 3 — 停在人工确认门禁

输出汇总后**停止**。提示人工：
- 审阅 `review-summary.md` 与 `review/*.md`；
- 认可后在人工确认区写下 `Technical Review Approved`（可加签名/日期）；
- 之后才可运行 `/opsx:apply` 进入实现。

若门禁为 `BLOCKED`，建议先回 `design.md` 闭环 Blocker，再重跑门禁。

## 重走门禁（迭代回路）

判定规则、牵连关系表、驳回与 risk accepted 留痕格式，全部见 `shared/gate-policy.md`。执行层面：

- **全量重走**：Workflow `{ "change": "<name>" }`；交互式则重启全部纳入维度的子 agent。
- **增量重走**：Workflow `{ "change": "<name>", "roles": ["security"] }`；交互式只对指定维度重启子 agent，其余读取上轮 `review/<role>.md` 参与汇总。
- **裁决始终对全部纳入维度求值**：沿用维度若仍有未闭环 Blocker，门禁仍 `BLOCKED`。

## 与整体流程的关系

- 上游：`/opsx:explore`（需求澄清 + 方案探索）产出 proposal.md（含第一性原理分析）/ design.md（含候选方案交叉验证矩阵）；`/opsx:overview` 可生成变更总览便于评审前对齐。
- **交叉验证链条**：
  - Phase 1 第一性原理 → 确保解决正确的问题
  - Phase 2 候选方案交叉验证 → 确保方案选择有依据
  - **Phase 3 五维度交叉验证（当前阶段）** → 确保方案无盲区、发现跨维度冲突
- 本门禁：`/opsx:review`（本 skill）产出 `review/*.md` + `review-summary.md`，停在人工确认。
- 下游：人工批准后 `/opsx:apply` 编码 → `/opsx:quality` 实现层代码质量评审 → `/opsx:verify`（交叉验证 III：实现与设计交叉核对）三维校验 → `openspec archive`。完整流程见 [研发流程 Phases 定义](../../shared/workflow/phases.md)。
- 角色分工：OpenSpec = 流程与设计文档中心；本门禁 = AI 评审编排；Coding Agent = 代码执行者。

## 交叉验证机制说明

**五角色独立评审**：每个子 agent 只读 `proposal.md` + `design.md`，不看其他维度的 `review/<role>.md`，避免锚定偏差。

**典型交叉验证场景**：
- 幂等设计：并发维度认为"有唯一索引就够了" → 数据库维度发现"索引缺少 tenant_id 前导，跨租户会冲突"
- 缓存一致性：性能维度建议"缓存永不过期" → 架构维度发现"无过期机制导致脏数据无法更新"
- SQL 注入：安全维度发现"拼接 SQL" → 数据库维度进一步指出"预编译之外还需输入长度校验"

**汇总阶段责任**：
- 检测跨维度冲突（如：性能建议与安全建议矛盾）
- 标记冲突项必须在 design.md 中闭环，不能让矛盾的建议同时进入 tasks.md
