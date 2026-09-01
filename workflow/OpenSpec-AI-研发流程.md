# OpenSpec + AI Agent 研发流程

> **📖 文档说明**  
> 本文档是面向**人类阅读**的完整汇总版本，包含流程说明、部署指南、FAQ 等。  
> **AI skills 使用的是模块化版本**，位于 [`shared/workflow/`](../shared/workflow/) 目录，按主题拆分为 8 个独立模块。  
> 如需修改流程规则，请编辑 `shared/workflow/` 模块，本文档定期同步更新。

> 以 OpenSpec 作为研发流程的核心控制器（需求澄清、方案设计、变更生命周期），在进入代码实现前增加 **Technical Review Gate（技术评审门禁）**，由 AI Agent 模拟架构/并发/性能/数据库/安全评审角色。
>
> **核心原则：需求未明确，不分析性能；方案未确定，不开始编码。**
>
> **质量保障理念：第一性原理（Phase 1 确保方向正确）+ 交叉验证（Phase 2/3/6 多维度互证）。**

---

# ═══════════════════════════════════════════
# 第一部分：快速开始（新手必读）
# ═══════════════════════════════════════════

## 💡 新手从这开始

### 第一次使用？

**强烈建议先看** → [5分钟快速上手指南](quickstart-guide.md)

**那份指南包含**：
- 三句话理解核心理念
- 3个问题判断你的变更类型
- 完整示例：给用户表加昵称字段
- 8个高频FAQ

**看完再回来**，理解会深得多。

---

### 用过但忘了命令？

**直接跳到** → [开发者速查](#开发者速查)

---

### 想了解完整原理和细节？

**继续往下读**，本文档包含所有技术细节。

---

## 🎯 核心原则（必读3句话）

```
需求未明确，不分析性能
方案未确定，不开始编码

质量保障 = 第一性原理 + 交叉验证
```

**三层质量保障**：
1. **Phase 1 第一性原理**：确保解决正确的问题（表面需求 vs 底层问题）
2. **Phase 2 交叉验证 I**：至少2个候选方案四维对比（成本/性能/复杂度/风险）
3. **Phase 3 交叉验证 II**：5角色并行评审同一方案（多维度互证）
4. **Phase 6 交叉验证 III**：实现与设计一致性核对（Coherence）

---

## 🚦 门禁适用范围分级

**不是所有变更都要跑五维度门禁。** 强行全跑会让开发者放弃整套流程。

### 快速判定流程图

```
你的变更是？
    │
    ├─ 纯文案/注释/配置/格式化
    │  └─→ L0豁免 ─→ 跳过门禁（记豁免理由）
    │
    ├─ 命中升级信号？
    │  • 异步/MQ/并发消费/重试/幂等
    │  • 批量 ≥ 1万条
    │  • 新建核心表/改字段类型/加唯一索引
    │  • 对外网接口/用户上传内容
    │  • 租户隔离/权限判定/敏感数据
    │  └─→ L3全量（5维度，4-8分钟，建议第二人复核）
    │
    ├─ 新增业务流程/跨模块调用/引入缓存/批量操作
    │  └─→ L2标准（4维度，3-6分钟）
    │
    └─ 单表CRUD/新增非核心字段/既有能力小扩展
       └─→ L1轻量（2维度，2-4分钟）
```

**判定口诀**：拿不准就升一级。漏评审的代价远高于多跑一个维度。

---

### 分级对照表

| 等级 | 典型变更 | 门禁要求 | 人工签字 |
|------|---------|---------|---------|
| **L0 豁免** | 纯文案/注释/日志文案、配置值调整、格式化、依赖小版本升级、纯测试补充 | **跳过门禁**，直接apply | 不需要，但需在某处记豁免理由（供hook放行与事后追溯） |
| **L1 轻量** | 单表单接口CRUD、新增非核心字段、既有能力的小范围扩展 | 只跑 **database + security** | 需要 |
| **L2 标准** | 新增业务流程、跨模块调用、引入缓存、批量操作 | 跑 **architecture + database + security + performance** | 需要 |
| **L3 全量** | 涉及MQ/异步、并发消费、分布式一致性、状态机、大数据量、新建核心表、对外开放接口 | **五维度全跑** | 需要，且建议第二人复核 |

---

### 触发升级的信号（命中任一，至少L3）

- 出现「异步」「MQ」「并发消费」「重试」「幂等」
- 出现「批量」且量级 ≥ 1万
- 新建表，或对既有表加唯一索引/改字段类型
- 接口对外网开放，或处理用户上传内容
- 涉及租户隔离、权限判定、敏感数据

**分级结论必须写进 `review-summary.md` 开头，注明判定人 —— 分级本身也是一个需要负责的决策。**

---

## ⏱️ 门禁耗时与成本预期

开发者最关心「跑一次要多久」。实测量级（供参考，随方案文档长度与模型浮动）：

| 模式 | 并行Agent数 | 墙钟耗时 | 相对token成本 |
|------|-----------|---------|---------------|
| L1（2维度） | 2 + 1汇总 | 约 2–4 分钟 | 低 |
| L2（4维度） | 4 + 1汇总 | 约 3–6 分钟 | 中 |
| L3（5维度全量） | 5 + 1汇总 | 约 4–8 分钟 | 高 |
| 增量重走（1维度） | 1 + 1汇总 | 约 1–3 分钟 | 很低 |

五个子agent并行，墙钟接近「最慢的那个」而非累加。**迭代时优先用增量重走**，别每次都全量。

---

## 📋 开发者速查

> 💡 这是最实用的部分，可以直接复制粘贴命令

### L0 豁免（日常小改动）

```bash
# ── L0豁免：不走门禁 ──────────────────────
# 直接改代码，但需在某处记录豁免理由（供hook放行与事后追溯）
```

**豁免场景**：
- 纯文案/注释/日志文案
- 配置值调整
- 代码格式化
- 依赖小版本升级
- 纯测试补充

**注意**：需在 `review-summary.md` 记一行豁免理由并签字，格式：

```markdown
L0豁免：调整日志级别配置，不涉及业务逻辑
豁免人：张三  2026-08-26
```

---

### L1-L3 标准流程

```bash
# ── Phase 1-2：需求澄清 + 方案探索 ──────────────────────
/openspec:explore <change-name>
#   → openspec/changes/<change-name>/proposal.md
#      ※ 必含「第一性原理分析」区块（表面需求 vs 底层问题 / 基本约束 / 必要性验证）
#   → openspec/changes/<change-name>/design.md
#      ※ 必含「候选方案交叉验证矩阵」（至少2个候选方案 × 四维对比）
#   → discussion-log.md（子agent讨论结论回流，见skill openspec-discussion-sync）

# ── 生成变更总览（可选但推荐）──────────────────────────
/openspec:overview <change-name>
#   → overview.md（文档地图 / 端到端流程 / 字段台账 / 条件矩阵）
#   一页看懂流程、字段变更与规则条件是否遗漏
#   标 ⚠️ 未落地 的条目视同 Blocker

# ── 分级判定 ────────────────────────────────────────
# 根据上面的决策树判断：L0 / L1 / L2 / L3

# ── Phase 3-4：技术评审门禁 ──────────────────────────
/openspec:review <change-name>
#   → review/{architecture,concurrency,performance,database,security}.md
#      ※ 五角色独立评审，交叉验证同一方案（多维度互证）
#   → review-summary.md（门禁裁决 + 跨维度冲突检测）

# 若 BLOCKED → 回改 design.md + 填「评审意见闭环记录」，然后按牵连关系重走
/openspec:review <change-name> --roles concurrency,database

# ── 人工门禁：硬门禁 ──────────────────────────────────
# 审阅 review-summary.md，认可后在末尾写入：
#   Technical Review Approved: 张三  2026-08-26
#   复核（L3必填）: 李四  2026-08-26

# ── Phase 5：代码实施 ────────────────────────────────
/openspec:apply <change-name>
#   参考 review-summary.md 的「涉及代码模块」和「建议修复」
#   按已评审通过的设计实现，不重新设计

# ── Phase 5.5：代码质量评审 ──────────────────────────
/openspec:quality <change-name>
#   → review/code-quality.md
#   查 diff 的重复率/可读性/死代码/复杂度/设计偏离
#   未闭环 Blocker 不得归档

# ── Phase 6：验证 ──────────────────────────────────
/openspec:overview <change-name>     # 先刷新条件矩阵
/openspec:verify <change-name>
#   → 三维校验（Completeness / Correctness / Coherence）
#      ※ Coherence 维度：实现与设计交叉核对
#   → 再逐条核对 overview.md 的条件矩阵，⚠️ 未落地项视同 Blocker
#   → 补充人工核对清单（回溯第一性原理 / 方案选择一致性 / 可测试性 / 运维成本）

# ── 收口 ─────────────────────────────────────────────
/openspec:archive <change-name>
#   变更归档，能力沉淀进 specs
#   评审/讨论/总览产物随变更整体归档到 changes/archive/<name>/
```

---

### 常见分支场景

#### 场景1：门禁BLOCKED

```bash
# 1. 回到 design.md 修改方案（闭环Blocker）
# 2. 在 design.md 末尾填写「评审意见闭环记录」

## 评审意见闭环记录

| finding ID | 维度 | 原始问题 | 处理方式 | 落在design的哪一节 | 轮次 |
|-----------|------|---------|---------|-------------------|------|
| ARCH-01 | 架构 | 计数真值源不明 | 改为DB为唯一真值源 | §3.2 一致性设计 | R1 |

# 3. 重走门禁（只跑被修改的维度）
/openspec:review <change-name> --roles architecture,database
```

---

#### 场景2：误报或risk accepted

在 `review/<role>.md` 追加驳回记录：

```markdown
## 人工驳回记录

### DB-03 误报

- 驳回人：张三
- 驳回理由：该字段仅测试环境使用，生产不开放
- 驳回时间：2026-08-26

---

### SEC-01 risk accepted

- 承担人：李四
- 接受理由：导出仅内部管理员可见，风险可控
- 复查触发阈值：外部用户数 > 1000
- 记录时间：2026-08-26
```

**重要**：不改 `design.md` 就不用重跑门禁。误报和risk accepted是对评审结果的反馈，不是对设计的修改。

---

#### 场景3：verify有CRITICAL

```bash
# 修复后重跑
/openspec:verify <change-name>

# 如果修复过程改了设计 → 重走对应维度的门禁
/openspec:review <change-name> --roles <维度>
```

---

#### 场景4：复杂finding需要详细解析

```bash
# 单个finding
/openspec:explain --finding CONC-02

# 所有Blocker
/openspec:explain --all-blockers

# 面向非技术人员
/openspec:explain --finding SEC-01 --audience non-tech
```

**产出**：`review/finding-details/<ID>.md`，包含完整业务场景、代码示例、实施步骤、FAQ。

---

## ⚠️ 新手常见错误

| 错误做法 | 为什么错 | 正确做法 |
|---------|---------|---------|
| 先写代码，再补design.md | "倒推"的文档不是设计，门禁会发现矛盾 | 先explore确定方案，再review，最后apply |
| 看到Blocker直接改代码 | 改了代码但design未更新 → 重跑仍报错 | 先回design.md闭环并填「评审意见闭环记录」 |
| 「有条件通过」看完就忘 | 条件未落地等于失效 | 条件必须映射到tasks.md，Phase 6逐条核对 |
| review-summary.md随便签名 | 签字是"我负责"不是"我看过" | L2/L3不建议自签，签字前至少读完全文 |
| 开发完删掉review/*.md | 删掉决策记录，半年后无人知道为什么这么定 | 提交git，archive自动归档到changes/archive/ |

---

## ❓ 高频FAQ（13个）

<details>
<summary><strong>Q1: 改个字段也要跑五个Agent？</strong></summary>

**A**: 不用。看分级表，多数是L0/L1。

加字段通常是L1（只跑database+security，2个Agent，2-4分钟）。

改字段类型或加唯一索引 → L3全量。
</details>

<details>
<summary><strong>Q2: AI报了个Blocker但我认为是误报，被卡死了？</strong></summary>

**A**: 见「常见分支场景 - 场景2」。

写驳回记录并具名，不改design就不用重走。

两条逃生通道：
- **误报**（问题不成立）→ 追加「驳回」记录
- **risk accepted**（问题真实但不修）→ 追加「risk accepted」记录 + 复查触发阈值
</details>

<details>
<summary><strong>Q3: 门禁跑完了但我直接让Agent改代码，会被拦吗？</strong></summary>

**A**: 不会。

门禁只能拦正常路径（`/openspec:apply`），拦不住"直接让Agent用Edit/Write改代码"。

**真正的兜底**：PR review与CI。
</details>

<details>
<summary><strong>Q4: /openspec:review 提示缺 design.md？</strong></summary>

**A**: 门禁前置校验要求 proposal.md 与 design.md 都存在且design含推荐方案。

先回 `/openspec:explore` 补齐 —— 这正是「方案未确定不开始编码」。
</details>

<details>
<summary><strong>Q5: 签字了但门禁裁决是BLOCKED，能apply吗？</strong></summary>

**A**: 不能。apply的前置校验会拦。

BLOCKED必须先闭环Blocker并重走门禁 → 变成READY → 才能签字 → 才能apply。
</details>

<details>
<summary><strong>Q6: 评审文档要提交git吗？开发完能删吗？</strong></summary>

**A**: 提交，不删。

**理由**：
- 签字是责任凭证
- risk accepted记录着复查触发点
- 归档时 `openspec archive` 自动搬到 `changes/archive/<name>/`

详见「门禁产物的git归属与生命周期」章节。
</details>

<details>
<summary><strong>Q7: proposal/design/spec/tasks四份文档太散，怎么确认规则条件没遗漏？</strong></summary>

**A**: 跑 `/openspec:overview <change>`。

「规则条件可追溯矩阵」把四类来源（proposal验收条件、spec scenario、design约束、review的「有条件通过」）合成一张表。

映射不到 `tasks.md` 的条目会标 `⚠️ 未落地`，视同Blocker。
</details>

<details>
<summary><strong>Q8: 怎么确保方案选择是有依据的，不是拍脑袋？</strong></summary>

**A**: Phase 2必须输出「候选方案交叉验证矩阵」。

至少2个候选方案从成本/性能/复杂度/风险四维对比，推荐方案必须回答「为什么不选其他方案」。

未通过交叉验证的design不得进入门禁。
</details>

<details>
<summary><strong>Q9: 怎么防止解决了错误的问题？</strong></summary>

**A**: Phase 1必须完成「第一性原理分析」。

区分表面需求与底层问题，识别基本约束，验证必要性。

Phase 6验证时会回溯检查实现是否解决了「底层问题」而非「表面需求」。
</details>

<details>
<summary><strong>Q10: Blocker写得全是术语，看不懂到底会出什么事？</strong></summary>

**A**: 新版finding强制带9个字段（v2.0），包括：
- **一句话白话**：不得出现未解释的专有名词
- **触发场景**：必须可复现
- **不修的后果**：不写空话

**写不出具体触发场景的Blocker会被自动降级为Major。**

如仍看不懂，用 `/openspec:explain --finding <ID>` 生成详细解析。
</details>

<details>
<summary><strong>Q11: 子agent讨论完的结论怎么不丢？</strong></summary>

**A**: 按skill `openspec-discussion-sync`：

子agent返回固定五段（结论/依据/建议落点/未决问题/弃案），主agent必须把每条建议落点落到artifact或记为「未采纳 + 理由」，并追加 `discussion-log.md`。

结束本轮前有防丢自检。
</details>

<details>
<summary><strong>Q12: 我能跳过门禁直接写代码吗？</strong></summary>

**A**: L0豁免可以。

其他等级不建议 —— 虽然技术上能绕过（直接让Agent改代码），但失去了评审保护。

门禁的价值在于让评审成为默认动作。
</details>

<details>
<summary><strong>Q13: 门禁卡住了整个开发流程，能不能快一点？</strong></summary>

**A**: 三个提速方法：
- 用增量重走（`--roles <维度>`）而非全量
- 准确分级（别把L1误判为L3）
- 并行跑门禁和准备代码框架（门禁通过后快速实施）
</details>

---

# ═══════════════════════════════════════════
# 第二部分：完整流程（专家参考）
# ═══════════════════════════════════════════

## 🗺️ 全景流程

```
OpenSpec Explore
      │  需求澄清（Phase 1）→ proposal.md
      │    ※ 第一性原理分析（表面需求 vs 底层问题 / 基本约束 / 必要性验证）
      │  方案探索（Phase 2）→ design.md（候选方案 + 推荐方案）
      │    ※ 交叉验证 I：候选方案四维对比矩阵（成本/性能/复杂度/风险）
      │  ※ 子 agent 讨论结论回流 → discussion-log.md（贯穿 Phase 1–2）
      ▼
技术方案确认（design.md 含推荐方案）
      │
      ├─ /openspec:overview → overview.md（文档地图 / 端到端流程 / 字段台账 / 条件矩阵）
      ▼
   【分级判定】L0 豁免 ──────────────────────────┐
      │ L1/L2/L3                                │
      ▼                                         │
┌──── Technical Review Gate（Phase 3，仍属 Explore，不写代码）────┐
│  ※ 交叉验证 II：五角色并行评审同一方案（多维度互证）              │
│  架构 Agent   → review/architecture.md                        │
│  并发 Agent   → review/concurrency.md                         │
│  性能 Agent   → review/performance.md                         │
│  数据库 Agent → review/database.md                            │
│  安全 Agent   → review/security.md                            │
└────────────────────────────┬─────────────────────────────────┘
      ▼                                                        │
评审汇总（Phase 4）→ review-summary.md（门禁裁决 + 修改建议）      │
      │  含业务影响地图、代码改动范围（v2.0）                     │
      │                                                        │
      ├─ BLOCKED ─→ 回改 design.md（留闭环记录）─→ 重走门禁 ⟲     │
      │                                                        │
      ├─【可选】/openspec:explain --finding <ID>                    │
      │         → review/finding-details/<ID>.md（详细解析）     │
      │                                                        │
      ▼ READY_FOR_HUMAN_APPROVAL                               │
【人工确认评审结果】← 硬门禁：人工写入 "Technical Review Approved"  │
      ▼                                                        │
      ◄────────────────────────────────────────────────────────┘
OpenSpec Apply（Phase 5）→ 代码实现（Controller/Service/Repository/SQL/测试）
      │  参考 review-summary.md 的"涉及代码模块"和"建议修复"      │
      ▼
代码质量评审（Phase 5.5）→ /openspec:quality → review/code-quality.md
      │  查 diff 的重复率/可读性/死代码/复杂度/设计偏离；未闭环 Blocker 不得归档
      ▼
验证（Phase 6）→ /openspec:verify 三维校验 + 条件核对（用 overview.md 条件矩阵）+ 项目自有测试
      │  ※ 交叉验证 III：实现与设计交叉核对（Coherence 一致性校验）
      ▼
OpenSpec Archive → specs 沉淀能力；评审与讨论产物随变更进 changes/archive/
```

---

## 📊 各阶段职责与产物

| 阶段 | 入口 | 做什么 | 产物 | 是否改代码 |
|------|------|--------|------|-----------|
| Phase 1 需求澄清 | `/openspec:explore` | 明确业务目标、边界、输入输出、数据规模、性能指标、兼容/安全要求；**应用第一性原理分析** | `proposal.md`（含第一性原理分析区块） | 否 |
| Phase 2 方案探索 | `/openspec:explore` | 讨论实现路径，输出多个候选方案+优缺点+推荐方案+决策理由；**候选方案四维对比矩阵交叉验证** | `design.md`（含方案交叉验证矩阵） | 否 |
| （贯穿 1–2）讨论回流 | skill `openspec-discussion-sync` | 子 agent 按五段契约返回，主 agent 逐条落盘或记未采纳 | `discussion-log.md` | 否 |
| 变更总览 | `/openspec:overview` | 汇成文档地图、端到端流程、字段变更台账、规则条件可追溯矩阵 | `overview.md`（派生视图，勿手改） | 否 |
| 分级判定 | 人工（参照分级表） | 判断变更等级，决定跑哪些维度或直接豁免 | 记录在 `review-summary.md` | 否 |
| Phase 3 技术评审门禁 | `/openspec:review` | 专项 Agent 并行评审已确定方案；**五角色多维度交叉验证** | `review/*.md` | 否 |
| Phase 4 评审确认 | 同上（汇总） | 汇总风险与修改建议，给出门禁裁决 | `review-summary.md` | 否 |
| 人工门禁 | 人工 | 审阅评审结论，认可后写入批准标记 | `review-summary.md` 批准区 | 否 |
| Phase 5 代码实现 | `/openspec:apply` | 按已评审通过的设计实现，不重新设计 | 代码 + `tasks.md` 勾选 | 是 |
| Phase 5.5 代码质量评审 | `/openspec:quality` | 对本次 diff 查重复率/可读性/死代码/复杂度/设计偏离 | `review/code-quality.md` | 否（只报告） |
| Phase 6 验证 | `/openspec:verify` | 三维校验（含实现与设计一致性）+ 条件核对 + 项目自有测试；**实现与设计交叉核对** | 校验报告（对话内） | 修复项 |
| 收口 | `/openspec:archive` | 变更归档，能力沉淀进 specs；评审与讨论产物随变更整体归档 | `openspec/specs/**` + `changes/archive/<name>/` | 否 |

---

## 👥 角色分工

```
OpenSpec        = 研发流程与设计文档中心（需求/设计/生命周期）
技术评审门禁     = AI 评审流程编排器（架构/并发/性能/数据库/安全）
Coding Agent    = 代码执行者（Claude / Codex / GPT），只实现已评审通过的设计
人工签字者       = 风险承担者（见「签字人的资格与责任」）
```

- **OpenSpec 不被替代**：始终是流程与文档的事实源。
- **评审编排层**：负责调度评审 Agent、并行分析、固化流程、执行质量门禁；不替代 OpenSpec。
- **代码执行者**：只在人工批准后进入 `apply`，不重新设计方案。

---

## 📐 Phase 1: 需求澄清（第一性原理分析）

### 核心任务

Phase 1 的核心任务是**确保方向正确**。在明确业务目标、边界、输入输出等常规需求信息之外，必须应用第一性原理分析，避免解决错误的问题。

### proposal.md 必须包含的区块

```markdown
## 第一性原理分析

### 表面需求 vs 底层问题
- **用户提出的需求**：[用户原始表述]
- **真正要解决的问题**：[追问 5 个为什么后的本质问题]
- **是否存在需求误解**：[表面需求与底层问题的差异分析]

### 基本约束（不可绕过的事实）
| 约束类型 | 具体约束 | 影响 |
|---------|---------|------|
| 物理约束 | 如：网络延迟下界、存储 IOPS 上限 | [对方案的限制] |
| 业务约束 | 如：监管要求、SLA 承诺、遗留系统兼容 | [对方案的限制] |
| 资源约束 | 如：团队规模、时间窗口、预算上限 | [对方案的限制] |

### 必要性验证
- **不做会怎样**：[现状痛点的量化影响]
- **做了能带来什么**：[预期收益的量化目标]
- **是否有更简单的替代方案**：[如：配置调整、流程优化、文档说明]
- **必要性结论**：[必须做 / 有更优替代 / 建议推迟]
```

### 第一性原理分析的判据

| 判据 | 通过标准 | 不通过示例 |
|------|---------|-----------|
| **问题真实性** | 能量化现状痛点（如：每天人工处理 500 笔，耗时 4 小时） | 「用户体验不好」「可能会有问题」 |
| **约束完整性** | 识别出至少 1 个物理/业务/资源约束 | 只列出功能需求，未识别约束 |
| **替代方案探索** | 至少考虑过 1 种非技术方案或更简单的技术方案 | 直接认定「必须开发新功能」 |
| **必要性量化** | 能回答「投入产出比是否合理」 | 「领导要求」「友商有」 |

**不通过第一性原理分析的 proposal 不得进入 Phase 2。** 否则会出现「技术方案设计得很好，但解决了错误的问题」。

---

## 📐 Phase 2: 方案探索（候选方案交叉验证）

### 核心任务

Phase 2 的核心任务是**在多个候选方案之间做出有依据的选择**。单一方案无法交叉验证，至少需要 2 个候选方案。

### design.md 必须包含的矩阵

```markdown
## 候选方案交叉验证矩阵

| 维度 | 方案 A（如：同步批量插入） | 方案 B（如：异步 MQ 分片消费） | 方案 C（如：ETL 离线导入） |
|------|------------------------|---------------------------|----------------------|
| **成本** | 开发 2 人日 / 无额外资源 | 开发 5 人日 / 需引入 MQ | 开发 3 人日 / 需 ETL 调度平台 |
| **性能** | 10 万条需 5 分钟，阻塞 | 10 万条需 2 分钟，非阻塞 | 10 万条需 10 分钟，离线无感知 |
| **复杂度** | 低：单体同步逻辑 | 高：需处理消息重试/死信/幂等 | 中：需配置 ETL 任务与监控 |
| **风险** | 超时风险高，无法扩展 | MQ 依赖引入新故障点 | ETL 平台依赖，实时性差 |

### 推荐方案及决策依据
- **推荐**：方案 B（异步 MQ 分片消费）
- **决策依据**：
  1. 性能满足需求（2 分钟 < 目标 3 分钟），且非阻塞不影响用户操作
  2. 复杂度虽高但可复用现有 MQ 基础设施（已有 RabbitMQ 集群）
  3. 可扩展性强，未来百万级数据只需加消费者实例
  4. 风险可控：MQ 故障有降级方案（回退到方案 A 的同步小批量）
- **为什么不选方案 A**：超时风险无法接受（当前已有 5 万条数据，方案 A 需 2.5 分钟，接近超时边界）
- **为什么不选方案 C**：业务要求 5 分钟内可见（实时性要求），离线 ETL 不满足
- **回溯第一性原理**：本质问题是「大批量数据导入不能阻塞用户操作」，方案 B 直接解决此问题；方案 A 仍会阻塞；方案 C 虽不阻塞但实时性不足
```

### 方案交叉验证的判据

| 判据 | 通过标准 | 不通过示例 |
|------|---------|-----------|
| **候选数量** | 至少 2 个有实质差异的方案 | 只有 1 个方案，或多个方案只是参数微调 |
| **维度完整性** | 至少覆盖成本/性能/复杂度/风险四维 | 只比较「哪个更快」 |
| **决策可追溯** | 能回答「为什么不选其他方案」 | 只说「方案 B 最好」，未说明为什么 |
| **回溯验证** | 推荐方案确实解决 proposal.md 中的底层问题 | 推荐方案偏离了第一性原理分析的结论 |

**未通过交叉验证的 design 不得进入 Phase 3 门禁。**

---

## 📐 Phase 3-4: 技术评审门禁

### 门禁流程概览

门禁由五个专项Agent并行评审：架构/并发/性能/数据库/安全。

**产出**：
- `review/*.md`（5个评审报告）
- `review-summary.md`（门禁裁决）

**人工门禁**：审阅 `review-summary.md`，认可后写入批准标记。

---

### 门禁资产结构

门禁资产位于 skill `openspec-technical-review`：

```
openspec-technical-review/
├── SKILL.md                          # 门禁编排说明
├── shared/                           # agent 执行规则的唯一事实源
│   ├── finding-format.md             #   finding 九字段 + 五条硬规则
│   ├── closed-loop-verification.md   #   重走门禁时如何验证闭环
│   ├── gate-policy.md                #   裁决判定 / 重走范围 / 驳回留痕
│   └── apply-gate-check.md           #   apply 前的签字校验
├── roles/                            # 五个评审角色
│   ├── architecture.md  concurrency.md  performance.md
│   ├── database.md      security.md
└── hooks/check-review-approval.sh    # PreToolUse 门禁 hook
```

**事实源划分**：

| 内容类型 | 唯一事实源 | 例子 |
|---------|-----------|------|
| 面向**人**的策略 | **本文档** | 分级规则、签字资格、门禁强制力边界 |
| 面向**agent**的执行规则 | `shared/` | finding字段、闭环验证、裁决判定 |

---

### finding 统一字段（v2.0）

9字段：

```
ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复
```

**关键字段说明**：
- **影响业务功能**：用户视角的功能名称（如"素材上传"、"消息收藏"）
- **涉及代码模块**：需要修改的具体代码位置，精确到类/方法/表

**五条硬规则**：
1. 「影响业务功能」必须用用户视角的功能名称
2. 「涉及代码模块」必须精确到类/方法/表
3. 「一句话白话」不得出现未解释的专有名词
4. 「触发场景」必须可复现，写不出来的 Blocker 一律降级为 Major
5. 「不修的后果」不写空话

---

### 门禁裁决规则

| 条件 | 裁决结果 | 下一步 |
|------|---------|--------|
| 任一维度 `verdict = 打回` **或** 有未闭环Blocker | 🚫 BLOCKED | 回改design.md + 填闭环记录 + 重走门禁 |
| 全部 `通过/有条件通过` **且** 无未闭环Blocker | ✅ READY_FOR_HUMAN_APPROVAL | 人工签字确认 |

⚠️ **人工确认是硬门禁**：人工在 `review-summary.md` 写入 `Technical Review Approved` 前，禁止 `/openspec:apply`。

完整判定表与边界情形见 `skills/openspec-technical-review/shared/gate-policy.md`。

---

<details>
<summary>🔧 展开查看门禁技术细节</summary>

### 「有条件通过」的条件必须落地

「有条件通过」不等于「通过」。**每一条「条件」必须映射到 `tasks.md` 的一个可勾选任务项**，否则条件写完就没人管，等同于失效。

汇总时在 `review-summary.md` 中列出：

```markdown
## 有条件通过的条件清单

| 条件ID | 来源维度 | 条件内容 | 对应 tasks.md 任务 | 状态 |
|--------|---------|---------|-------------------|------|
| C-01 | database | 幂等键唯一索引须 tenant_id 前导 | T-03 建表 DDL | 待实现 |
| C-02 | performance | 批量 INSERT 须开 rewriteBatchedStatements | T-05 数据写入 | 待实现 |
```

**无法映射到 tasks 的条件，视同 Blocker 处理** —— 因为它没有落地路径。

Phase 6 验证时逐条核对条件是否真的满足，未满足不得归档。

---

### Blocker 闭环留痕格式

门禁 `BLOCKED` 后回改 `design.md`，**必须留闭环记录**。

在 `design.md` 末尾维护固定区块：

```markdown
## 评审意见闭环记录

| finding ID | 维度 | 原始问题 | 处理方式 | 落在 design 的哪一节 | 轮次 |
|-----------|------|---------|---------|-------------------|------|
| ARCH-01 | 架构 | 计数真值源不明 | 改为 DB 为唯一真值源 | §3.2 一致性设计 | R1 |
| CONC-02 | 并发 | 重复消费导致计数重复累加 | 引入 msg_id 唯一索引 | §4.1 幂等设计 | R1 |
```

重走门禁时，把本区块一并交给评审 Agent，要求它**先验证上轮 Blocker 是否真的闭环**，再做新一轮审查。

---

### 不认可评审结论（误报 / risk accepted）

AI 评审会误报。**被误报卡死不是流程的本意**，两条逃生通道：

- **误报**（问题不成立）→ 在 `review/<role>.md` 追加「驳回」记录
- **risk accepted**（问题真实但决定不修）→ 追加「risk accepted」记录 + 复查触发阈值

两者不能混用：**问题不成立叫误报，问题成立但不修叫 risk accepted**。

都必须**具名留痕**，禁止直接删除 finding。

前提：**不改 `design.md` 就不重走门禁**，输入没变重跑只会得到同样结论。

---

### 按需生成详细解析文档

**skill：openspec-finding-explain**

对于复杂的 finding，可以按需生成详细解析文档：

```bash
# 单个 finding
/openspec:explain --finding CONC-02

# 所有 Blocker
/openspec:explain --all-blockers

# 面向非技术人员
/openspec:explain --finding SEC-01 --audience non-tech
```

**产出**：`review/finding-details/<ID>.md`，包含完整业务场景、代码示例、实施步骤、FAQ。

**两层产出设计**：
- **第一层**：finding 表格（9字段）- 评审阶段快速判断
- **第二层**：详细解析文档 - 实施阶段深入理解，按需生成避免信息过载

</details>

---

## 📐 Phase 5: 代码实施

**入口**：`/openspec:apply <change-name>`

**前置条件**：
- `review-summary.md` 已有人工签字 `Technical Review Approved`
- 门禁裁决为 `READY_FOR_HUMAN_APPROVAL`

**做什么**：
按已评审通过的设计实现，不重新设计方案。参考 `review-summary.md` 的「涉及代码模块」和「建议修复」。

**产出**：
- 代码（Controller/Service/Repository/SQL/测试）
- `tasks.md` 勾选

---

## 📐 Phase 5.5: 代码质量评审

**入口**：`/openspec:quality <change-name>`

**做什么**：
对本次 diff 查重复率/可读性/死代码/复杂度/设计偏离。

**产出**：
- `review/code-quality.md`（只报告，不改代码）

**要求**：
- 未闭环 Blocker 不得归档
- 修复走 `tasks.md` 勾选

---

## 📐 Phase 6: 验证

### 核心流程

**入口**：`/openspec:verify <change-name>`

**三维校验**：
- **Completeness**：`tasks.md` 勾选是否完整、spec 中的 requirement 是否都已实现
- **Correctness**：requirement ↔ 代码实现映射、scenario 是否被覆盖
- **Coherence**：**实现是否偏离 `design.md` 的既定决策**、代码风格与项目模式是否一致

**产出**：
校验报告（对话内），按 CRITICAL / WARNING / SUGGESTION 分级。

**存在 CRITICAL 时不得归档。**

---

### 门禁特有的补充：条件核对

`/openspec:verify` 不认识 `review-summary.md`（那是门禁产物，非 OpenSpec 原生 artifact），因此它**不会**核对「有条件通过」的条件。

**必须单独做**：

1. 先跑一次 `/openspec:overview <change>` 刷新「规则条件可追溯矩阵」
2. 再逐条核对矩阵中每项是否真的实现

矩阵已把 `proposal` 验收条件、`spec` scenario、`design` 约束、`review-summary` 的「有条件通过」四类来源合并到一张表。

标 `⚠️ 未落地` 的行视同 Blocker，不得归档。

---

### 项目自有的验证动作

编译、单测、集测、静态扫描（Sonar 等）按**项目自身规范**执行，本文档不做约定。

全绿才可归档。

---

### 修复后要不要重走门禁？

| 修复性质 | 是否重走 Phase 3 门禁 |
|---------|---------------------|
| 纯 bug 修复，未动设计 | 否，重跑 Phase 6 即可 |
| 修复过程中**改了技术方案**（换存储、改并发模型、改表结构） | **是**，回 `design.md` 更新后按牵连关系重走对应维度 |
| 发现设计缺陷但决定下个变更再改 | 否，记录为 risk accepted 并在 `review-summary.md` 留痕 |

**判据与 Phase 3 一致：`design.md` 变了没有。**

---

<details>
<summary>📚 展开查看 Phase 6 详细核对清单</summary>

## Phase 6 交叉核对清单

在 `/openspec:verify` 的标准三维校验基础上，补充以下人工核对项（这些是 `/openspec:verify` 不检查的）：

### 1. 回溯第一性原理（设计 → 需求）
- [ ] 实现是否解决了 `proposal.md` 中识别的「底层问题」而非「表面需求」
- [ ] 是否引入了 `proposal.md` 未识别的新约束（如：新依赖、新运维成本）

### 2. 方案选择一致性（实现 → 设计）
- [ ] 代码实现的关键决策点（如：存储选型、并发模型）是否与 `design.md` 推荐方案一致
- [ ] 若实现过程中改了方案，是否回填更新了 `design.md` 并重走门禁

### 3. 评审条件闭环（实现 → 评审）
- [ ] `review-summary.md` 的「有条件通过」条件是否都映射到 `tasks.md` 并完成
- [ ] 用 `overview.md` 的条件矩阵逐行核对，标 `⚠️ 未落地` 的行视同 Blocker

### 4. 设计阶段可测试性验证（补充设计盲区）
- [ ] 关键业务逻辑是否可单测（外部依赖是否可 mock）
- [ ] 是否需要造测试数据，若需要是否已提供脚本

### 5. 运维成本验证（补充设计盲区）
- [ ] 是否新增需要人工干预的场景（如：死信队列需人工重放）
- [ ] 监控/告警/对账工具是否就位

**有任一未通过项不得归档。** 修复后重跑 Phase 6，若修复过程改了设计则需重走对应维度的 Phase 3 门禁。

</details>

---

## 📐 质量保障理念总结

| 阶段 | 核心机制 | 防止什么问题 |
|------|---------|------------|
| Phase 1 | **第一性原理分析** | 解决错误的问题、过度设计、需求误解 |
| Phase 2 | **候选方案交叉验证** | 锚定单一方案、未考虑权衡、决策不可追溯 |
| Phase 3 | **五角色多维度交叉验证** | 单一视角盲区、跨维度冲突未发现 |
| Phase 6 | **实现与设计交叉核对** | 实现偏离设计、评审条件未闭环、可测试性/运维成本被遗忘 |

**三个交叉验证点形成闭环**：Phase 2 的候选方案对比 → Phase 3 的五维度互证 → Phase 6 的实现回溯设计。任一环节断裂都会导致质量缺口。

---

## 📋 评审维度覆盖边界

设计层五维度 + 实现层代码质量维度之外，仍有以下缺口 —— 这些恰恰是上线出事的高频原因。在 `design.md` 中自行补充，或由架构维度兼顾：

| 缺口 | 应当回答的问题 | 当前归属 |
|------|--------------|---------|
| **可观测性** | 关键路径有无日志埋点？监控指标是什么？告警阈值？出问题怎么定位？ | 已并入 architecture 清单 |
| **兼容性与回滚** | 灰度怎么放？有无开关？数据能否回滚？老客户端/存量数据兼容吗？ | 已并入 architecture 清单 |
| **可测试性** | 这个设计怎么写单测？外部依赖能否 mock？有无需要造的测试数据？ | **Phase 6 人工核对清单已补充** |
| **运维成本** | 新增了哪些需要人工干预的场景？有无对账/重跑工具？ | **Phase 6 人工核对清单已补充** |

**签字人应当把 Phase 6 的「设计阶段可测试性」与「运维成本」两项作为签字前的自查清单手动过一遍。**

---

# ═══════════════════════════════════════════
# 第三部分：治理与运维（管理者关注）
# ═══════════════════════════════════════════

## 🔐 签字人的资格与责任

这是团队推行这套流程时第一个会吵起来的问题，提前定清楚：

- **签字含义**：签字不是「我认可 AI 的结论」，而是「**我为这个方案进入实现负责**」。AI 评审是输入，不是免责声明。

- **资格**：签字人应当具备评审该变更等级的能力。L3 变更建议由该领域 owner 或架构负责人签，并由第二人复核。

- **能否自签**：L0/L1 允许作者自签。**L2/L3 不建议自签** —— 自己设计自己批准，门禁就退化成了形式。当前 hook **不校验签字人身份**（写任意非占位字符即放行），这是**依赖团队自觉的约定，不是技术强制**。

- **签字前至少要做**：
  - 读完 `review-summary.md` 全文
  - 逐条确认 Blocker 已闭环
  - 确认「有条件通过」的条件都进了 `tasks.md`
  - 对驳回/risk accepted 项独立判断而非照单全收

- **不看就签的后果**：等于取消门禁。若团队普遍出现盲签，应当调整的是分级规则（降低门禁频次、提高单次质量），而不是继续走过场。

**签字格式**：

```markdown
Technical Review Approved: 张三  2026-08-26
复核（L3 必填）: 李四  2026-08-26
```

---

## 📂 门禁产物的git归属与生命周期

**结论先说：门禁产物提交git，随变更归档，不删除。**

| 产物 | 提交git | 归档后去向 | 是否进 `specs/` |
|------|---------|-----------|----------------|
| `review/<role>.md` | 是 | `openspec/changes/archive/<name>/review/` | 否 |
| `review-summary.md`（含签字行） | 是 | `openspec/changes/archive/<name>/` | 否 |
| `review/code-quality.md` | 是 | 同上 | 否 |
| `discussion-log.md` | 是 | 同上 | 否 |
| `overview.md` | 是 | 同上 | 否 |

`openspec archive` 把整个 `changes/<name>/` 目录搬到 `changes/archive/<name>/`，上述文件**自动随之归档，不需要额外操作，也不要在归档前手工删除**。

---

<details>
<summary>📚 为什么这么设计？（管理者视角）</summary>

### 为什么不是「开发完就删」

- **签字是责任凭证**。`Technical Review Approved: 张三 2026-08-26` 删掉之后，就没有任何记录能回答「这个方案当初谁批的、基于什么结论批的」。签字人承担的责任需要有据可查。

- **驳回与 risk accepted 是决策记录**。`SEC-01 判定误报` / `PERF-03 risk accepted，触发阈值 5 万条` 这类记录，价值恰恰在出事之后 —— 半年后数据量涨到 5 万条时，只有这份记录能告诉你当初约定的复查触发点。

- **弃案防止重复劳动**。`discussion-log.md` 里「考虑过 X 方案，因为 Y 否掉」，是下一个接手的人（或下一轮全新上下文的 AI）不再把死路重走一遍的唯一依据。

- **体积可忽略**。全是纯文本 Markdown，一个变更几十 KB 量级，不构成仓库负担。

### 为什么不进 `specs/`

`specs/` 沉淀的是**系统当前应该具备的能力**，是「现在是什么样」。评审记录是**过程决策**，是「当时为什么这么定」。两者混在一起会让 spec 越读越乱 —— spec 要能被当作契约直接读，不该夹带历史评审意见。

### 落地检查

确认 `.gitignore` 没有排除这些路径：

```bash
git check-ignore -v openspec/changes/*/review-summary.md openspec/changes/*/review/ || echo "未被忽略，正常"
```

有输出说明被 `.gitignore` 排除了，需要移除对应规则 —— 否则签字凭证只存在于本地，等同于没有。

</details>

---

## ⚙️ 门禁的真实强制力（重要）

**门禁是流程纪律工具，不是安全边界。** 它拦得住「忘了」，拦不住「铁了心要绕」。

### 三道防线

| 防线 | 覆盖范围 | 拦不住什么 |
|------|---------|-----------|
| ① `hooks/check-review-approval.sh`（PreToolUse/Bash） | Bash 执行 `openspec apply` / `openspec apply` | **`/openspec:apply` 斜杠命令与 skill 调用** —— 它们不产生 Bash 命令，PreToolUse(Bash) 永不触发 |
| ② apply skill / command 的前置校验 | `/openspec:apply` 与 `openspec-apply-change` 两条路径 | 提示词级约束，可能被用户明确指令覆盖 |
| ③ 人工签字 + PR review | 最终把关 | 签字人不看就签 |

**始终存在的绕过路径**：直接让 Agent 用 Edit/Write 改代码，完全不经过任何 apply 入口 —— 三道防线全部看不到。

**所以**：别把门禁当成「代码不可能未经评审进主干」的保证。**真正的兜底仍然是 PR review 与 CI。** 门禁的价值在于让正常路径上「评审」成为默认动作而非可选动作。

---

<details>
<summary>🔧 门禁启用与部署（点击展开）</summary>

### hook 必须注册后才生效

未注册时第一道防线为零 —— 这是最常见的「以为有门禁其实没有」的原因。

> hook 注册是 **Claude Code 特有机制**（`~/.claude/settings.json`），下面的注册步骤仅适用于 Claude Code。其他 agent（Codex / opencode / Cursor / Gemini）没有等价的 PreToolUse 拦截，第一道防线天然为零，只剩第②③道 —— 这些环境下更要靠 apply skill 的前置校验与人工签字。

#### 先确认要注册哪个路径

skills 根目录随 agent 而不同，且其中的同名目录很可能是符号链接，指向别处的独立副本。**那些副本未必包含本仓的门禁修复** —— 指过去等于启用了一个看似生效、实则放行的旧版 hook。

先查清楚（把路径换成你实际的 skills 根目录）：

```bash
ls -ld ~/.claude/skills/openspec-technical-review
```

若输出以 `l` 开头（符号链接）且箭头指向非本仓路径，**改为直接指向本仓源文件**，或先把本仓内容同步过去。

用下面这条命令得到确切路径（在本仓根目录执行）：

```bash
realpath skills/openspec-technical-review/hooks/check-review-approval.sh
```

#### 在 settings.json 中注册

在 `~/.claude/settings.json` 中注册（把 `<上一步的输出>` 替换为实际绝对路径，此处不能用 `~` 以外的相对路径）：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash <上一步的输出>"
          }
        ]
      }
    ]
  }
}
```

#### 注册后必须验证内容版本

只看「有没有 hooks 字段」不够 —— 旧版 hook 在缺 `review-summary.md` 时会放行：

```bash
grep -c '技术评审门禁尚未执行' "$(jq -r '.hooks.PreToolUse[0].hooks[0].command' ~/.claude/settings.json | sed 's/^bash //')"
```

输出 `1` 才是含 fail-open 修复的版本；输出 `0` 说明指向了旧副本，必须改路径。

#### 行为验证

在一个没有 `review-summary.md` 的变更上执行，应被拒绝：

```bash
openspec apply some-change-without-review
```

#### 依赖检查

hook 依赖 `jq`，缺失时脚本会失败。确认已安装：

```bash
jq --version
```

</details>

---

## 🔄 重走门禁（迭代回路操作手册）

**铁律**：门禁输入是 `design.md`（+ `proposal.md`）。输入变了且变在评审维度上 → 重走；没变 → 不重走。

**判断口诀**：宁可多跑一个维度，不可漏跑被牵连的维度。

完整的场景判定表与**牵连关系速查表**（改了表结构要连带重跑哪些维度等）见 `skills/openspec-technical-review/shared/gate-policy.md` 第 2、3 节 —— 那是唯一事实源，本文不复制。

### 操作命令

```bash
/openspec:review <change>                          # 全量重走
/openspec:review <change> --roles security         # 增量重走，其余沿用上轮 review/<role>.md
```

**裁决始终对全部纳入维度求值**：沿用维度若仍有未闭环 Blocker，门禁仍 `BLOCKED`。

---

# ═══════════════════════════════════════════
# 第四部分：项目衔接
# ═══════════════════════════════════════════

## 🤝 与项目既有约定的衔接

- 沟通/注释中文、禁止魔法值、异常打印堆栈（见 `CLAUDE.md`）在各阶段 Agent 提示词中作为约束继承。
- SQL 变更规范（init 建表 / test update.sql / 禁改 upgrade）在数据库评审与 `apply` 阶段强制。
- Subagent 准则（见 `AGENTS.md`）：评审子 agent 只报告 findings 不改代码；主 agent 负责汇总、集成与最终验证。

---

**最后更新**：2026-08-26  
**文档版本**：v2.0（重组版）  
**维护者**：[AI Skills 开发团队]

---

## 📚 扩展阅读

- **快速上手指南**：[quickstart-guide.md](quickstart-guide.md)（新手必读）
- **文档导航页**：[README.md](README.md)（三个场景入口）
- **技术评审改进总结**：[../docs/technical-review-improvement-summary.md](../docs/technical-review-improvement-summary.md)
- **业务映射说明**：[../docs/technical-review-business-mapping.md](../docs/technical-review-business-mapping.md)
