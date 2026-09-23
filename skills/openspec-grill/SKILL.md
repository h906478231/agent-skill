---
name: openspec-grill
description: OpenSpec 未决决策访谈入口：决策树分轮澄清本次范围内的假设，复用已有共识，沉淀 CONTEXT.md 与 ADR。L2/L3 检查决策充分性，有有效共识不重复访谈。事实未知交给定向 explore，无阻断未知直接 propose/update。
---

# Grill 访谈（决策树访谈 + 领域资产沉淀）

## 定位

OpenSpec Explore 是**自由模式**的思考伙伴——没有固定问题、不强制产出。它的弱点是：没人逼你消除隐含假设。用户说「加个订单导出」，explore 可能顺着做完了，但「导出给谁看、多久一次、数据量多大、失败要不要重试」这些分支全靠用户想起来说。

本 skill 用**决策树分轮访谈**补这个洞：把变更的每个决策点组织成一棵树，按轮清空 frontier，一个分支都不留静默假设。同时，访谈中冒出的领域术语与重大权衡随手沉淀为**项目级资产**（跨变更复用，不随 change 归档）。

```
（存在未决决策）/opsx:grill ──> 共识（无阻断假设）
      │                        ├──> CONTEXT.md（领域术语，统一语言）
      │                        └──> docs/adr/（重大权衡决策）
      ▼
事实待查则 explore；否则直接 propose/update 形成正式产物
```

## 入场时机与分级

| 等级 | 要求 |
|------|------|
| L0 / L1 | 可选（变更小，explore 自由模式够用） |
| L2 / L3 | **检查决策充分性**；有有效共识直接复用，仅访谈未决项 |

- **分级的唯一事实源是 `../openspec-technical-review/shared/gate-levels.md`**：本表只用其等级含义判断「要不要访谈」，不自造分级标准；判定时机在 Phase 3 门禁，本 skill 不重复定义。

- 已在 explore 会话中：主 agent 直接加载本 skill 继续，不必新开会话
- 尚未开始：先判断未决项；需要决策才运行本 skill，事实待查才进 explore，无阻断未知直接 propose

## 资产结构

```
openspec-grill/
├── SKILL.md                      # 本文件：访谈编排流程
├── shared/
│   ├── interview-rules.md        # 决策树 + frontier 分轮提问规则（访谈核心机制）
│   ├── context-format.md         # CONTEXT.md 术语表格式与更新规则
│   └── adr-format.md             # ADR 格式与三条件门槛
└── agents/openai.yaml
```

## 路径约定：`<SKILL_DIR>`

本 skill 内部与外部的所有引用都写成**相对 skill 目录**的形式。**不要写死绝对路径** —— skills 根目录随 agent 而不同（Claude Code `~/.claude/skills/`、Codex CLI `~/.codex/skills/`、opencode `~/.config/opencode/skills/`、Cursor `~/.cursor/skills/`、项目级 `.claude/skills/`、直接在本仓使用时的 `skills/`）。

`<SKILL_DIR>` = 本 SKILL.md 所在目录。解析顺序（取第一个命中的）：

```bash
for root in "${CLAUDE_PROJECT_DIR:-.}/.claude/skills" ~/.claude/skills ~/.codex/skills \
            ~/.config/opencode/skills ~/.cursor/skills ~/.gemini/skills ./skills; do
  [ -f "$root/openspec-grill/SKILL.md" ] && echo "$root/openspec-grill" && break
done
```

都没命中时，用 Glob 搜 `**/openspec-grill/SKILL.md` 取其所在目录。

## 执行步骤

### Step 0 — 前置加载

1. 读项目根的 `CONTEXT.md`（若存在）——后续所有提问与术语使用统一语言
2. 读 `docs/adr/` 中与本次变更领域相关的 ADR（若有）——已定的大决策不再重复问
3. 若已存在相关 change（`openspec list --json`），读其 proposal/design 已有内容，访谈只补盲区、不重问已定项

### Step 1 — 建决策树

以「本次变更要解决什么问题」为根，展开决策分支：

```
根问题
├── 业务边界（谁在用、什么场景、正常/异常路径）
├── 状态与生命周期（数据从哪来、到哪去、谁改状态）
├── 权限与隔离（谁能看、谁能改、租户边界）
├── 一致性与并发（重复提交、乱序、部分失败怎么办）
├── 容量与性能预期（量级、峰值、增长）
└── 运维与失败处理（失败可观测吗、能重放吗、能回滚吗）
```

树不必预先画全——每轮用户的回答会展开新分支。**纪律是每轮重算 frontier，而不是一次问完所有问题。**

### Step 2 — frontier 分轮提问

按 `<SKILL_DIR>/shared/interview-rules.md` 执行。要点：

- 一轮只问 frontier 上的问题（前置已明确的决策），依赖未定问题答案的问题留到后续轮
- 每个问题**必须附你的推荐答案**（含理由），用户只需确认或纠正
- 提问之外执行**领域语言压力测试**三个主动动作：模糊词当场逼问精确化、发明边界场景压测概念边界、用户陈述与代码行为矛盾当场指出（见 `<SKILL_DIR>/shared/interview-rules.md`）
- 一轮问完**停下等答案**，禁止自问自答继续推进

### Step 3 — 职责划分（事实 vs 决策）

- **事实**（代码里有没有现成实现、表结构长什么样、接口现状）——**agent 自己查**：派子 agent 探索，不问用户。子 agent 返回必须遵循 skill `openspec-discussion-sync` 的五段契约（结论/依据/建议落点/未决问题/弃案）
- **决策**（业务规则、取舍、优先级）——**必须问用户**，不替用户决定
- 探索中的事实问题不阻塞当轮提问：只让依赖它的问题等子 agent 回来，其余照常问

### Step 4 — 同步沉淀领域资产

访谈进行中，**不要攒到最后**：

- 术语被敲定 / 现有术语与新用法冲突 / 模糊词被精确化 → 立即更新 `CONTEXT.md`（格式见 `<SKILL_DIR>/shared/context-format.md`，文件不存在则此刻懒创建）
- 出现满足三条件（难以撤销 / 无上下文会显得反常 / 存在真实权衡）的决策 → 提议记 ADR（格式见 `<SKILL_DIR>/shared/adr-format.md`），用户同意后立即写入

### Step 5 — 结束条件（两个都要满足）

1. **本次范围内的阻断 frontier 清空**：重要决策已确认，范围外或已明确延期的问题已记录；不扩展到无关设计
2. **用户确认共识**：总结「我们定了什么 / 各自为什么」，用户显式确认

达成后输出共识摘要（定了哪些决策、弃了哪些方案、开放问题是什么），作为后续 explore/propose 的输入。

### Step 6 — 产出对接

| 访谈产出 | 落点 |
|---------|------|
| 共识（根问题、约束、必要性） | proposal.md「第一性原理分析」区块（由 explore/propose 生成时写入） |
| 领域术语 | `CONTEXT.md`（项目根，跨变更复用） |
| 重大权衡决策 | `docs/adr/NNNN-<slug>.md`（项目根） |
| 未决问题 | discussion-log.md 或带入 explore 继续 |
| 切片边界线索 | tasks.md 任务拆分（规则见 `../openspec-propose/shared/task-slicing.md`，生成 tasks 时加载） |

## 铁律

- **本阶段不写业务代码**，不产出实现——只访谈、查证、沉淀
- **不静默假设**：本次关键假设必须确认；无进展可暂停并返回未决项，不得伪装为已达成共识
- **事实不问用户**：能自己查的绝不占用用户时间
- **决策不替用户**：推荐答案只是推荐，用户不确认就不算定
- **术语随手更新**：访谈结束再补 CONTEXT.md 的，术语已经被聊散了

## 与其他 skill 的关系

- **`openspec-explore`**：本 skill 是 Phase 1 的强化入口，不是替代——explore 负责发散与产出 artifact，本 skill 负责把假设问干净
- **`openspec-discussion-sync`**：访谈中派出的每个事实探索子 agent，返回必须走五段契约
- **`ddd-requirement-clarification`**：那是 DDD 建模入口的 7 类歧义检测；本 skill 是 OpenSpec 流程的通用决策树访谈，两者不互换使用

## 产物的 git 归属

`CONTEXT.md` 与 `docs/adr/` 是**项目级资产**：提交 git、**不随 `openspec archive` 归档**——它们跨变更长期复用，这正是领域语言相对单次变更历史的价值所在。变更目录内的 discussion-log.md 照旧随 change 归档。
