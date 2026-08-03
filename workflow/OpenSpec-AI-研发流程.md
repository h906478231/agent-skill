# OpenSpec + AI Agent 研发流程

> 以 OpenSpec 作为研发流程的核心控制器（需求澄清、方案设计、变更生命周期），在进入代码实现前增加 **Technical Review Gate（技术评审门禁）**，由 AI Agent 模拟架构/并发/性能/数据库/安全评审角色。
>
> **核心原则：需求未明确，不分析性能；方案未确定，不开始编码。**

**新人从这读起**：先看「[门禁适用范围分级](#门禁适用范围分级)」判断你的变更要不要走门禁 —— 大部分日常小改动不需要。再看「[开发者速查](#开发者速查)」。

## 全景流程

```
OpenSpec Explore
      │  需求澄清（Phase 1）→ proposal.md
      │  方案探索（Phase 2）→ design.md（候选方案 + 推荐方案）
      ▼
技术方案确认（design.md 含推荐方案）
      ▼
   【分级判定】L0 豁免 ──────────────────────────┐
      │ L1/L2/L3                                │
      ▼                                         │
┌──── Technical Review Gate（Phase 3，仍属 Explore，不写代码）────┐
│  架构 Agent   → review/architecture.md                        │
│  并发 Agent   → review/concurrency.md                         │
│  性能 Agent   → review/performance.md                         │
│  数据库 Agent → review/database.md                            │
│  安全 Agent   → review/security.md                            │
└────────────────────────────┬─────────────────────────────────┘
      ▼                                                        │
评审汇总（Phase 4）→ review-summary.md（门禁裁决 + 修改建议）      │
      │                                                        │
      ├─ BLOCKED ─→ 回改 design.md（留闭环记录）─→ 重走门禁 ⟲     │
      │                                                        │
      ▼ READY_FOR_HUMAN_APPROVAL                               │
【人工确认评审结果】← 硬门禁：人工写入 "Technical Review Approved"  │
      ▼                                                        │
      ◄────────────────────────────────────────────────────────┘
OpenSpec Apply（Phase 5）→ 代码实现（Controller/Service/Repository/SQL/测试）
      ▼
验证（Phase 6）→ 单测/集测/Sonar/编译 + AI Code Review → final-review.md
      ▼
OpenSpec Archive → specs 沉淀
```

## 各阶段职责与产物

| 阶段 | 入口 | 做什么 | 产物 | 是否改代码 |
|------|------|--------|------|-----------|
| Phase 1 需求澄清 | `/opsx:explore` | 明确业务目标、边界、输入输出、数据规模、性能指标、兼容/安全要求 | `proposal.md` | 否 |
| Phase 2 方案探索 | `/opsx:explore` | 讨论实现路径，输出多个候选方案+优缺点+推荐方案+决策理由 | `design.md` | 否 |
| 分级判定 | 人工（参照下表） | 判断变更等级，决定跑哪些维度或直接豁免 | 记录在 `review-summary.md` | 否 |
| Phase 3 技术评审门禁 | `/opsx:review` | 专项 Agent 并行评审已确定方案 | `review/*.md` | 否 |
| Phase 4 评审确认 | 同上（汇总） | 汇总风险与修改建议，给出门禁裁决 | `review-summary.md` | 否 |
| 人工门禁 | 人工 | 审阅评审结论，认可后写入批准标记 | `review-summary.md` 批准区 | 否 |
| Phase 5 代码实现 | `/opsx:apply` | 按已评审通过的设计实现，不重新设计 | 代码 + `tasks.md` 勾选 | 是 |
| Phase 6 验证 | 见 Phase 6 章节 | 编译/单测/集测/静态扫描 + AI Code Review | `final-review.md` | 修复项 |
| 收口 | `/opsx:archive` | 变更归档，能力沉淀进 specs | `openspec/specs/**` | 否 |

## 门禁适用范围分级

**不是所有变更都要跑五维度门禁。** 强行全跑会让开发者放弃整套流程。按变更性质分级：

| 等级 | 典型变更 | 门禁要求 | 人工签字 |
|------|---------|---------|---------|
| **L0 豁免** | 纯文案/注释/日志文案、配置值调整、格式化、依赖小版本升级、纯测试补充 | **跳过门禁**，直接 apply | 不需要，但需在 `review-summary.md` 记一行豁免理由并签字（供 hook 放行与事后追溯） |
| **L1 轻量** | 单表单接口 CRUD、新增非核心字段、既有能力的小范围扩展 | 只跑 **database + security** | 需要 |
| **L2 标准** | 新增业务流程、跨模块调用、引入缓存、批量操作 | 跑 **architecture + database + security + performance** | 需要 |
| **L3 全量** | 涉及 MQ/异步、并发消费、分布式一致性、状态机、大数据量、新建核心表、对外开放接口 | **五维度全跑** | 需要，且建议第二人复核 |

**判定口诀：拿不准就升一级。** 漏评审的代价远高于多跑一个维度。

**触发升级的信号**（命中任一，至少 L3）：
- 出现「异步」「MQ」「并发消费」「重试」「幂等」
- 出现「批量」且量级 ≥ 1 万
- 新建表，或对既有表加唯一索引/改字段类型
- 接口对外网开放，或处理用户上传内容
- 涉及租户隔离、权限判定、敏感数据

分级结论必须写进 `review-summary.md` 开头，注明判定人 —— **分级本身也是一个需要负责的决策**。

## 门禁耗时与成本预期

开发者最关心「跑一次要多久」。实测量级（供参考，随方案文档长度与模型浮动）：

| 模式 | 并行 Agent 数 | 墙钟耗时 | 相对 token 成本 |
|------|-------------|---------|----------------|
| L1（2 维度） | 2 + 1 汇总 | 约 2–4 分钟 | 低 |
| L2（4 维度） | 4 + 1 汇总 | 约 3–6 分钟 | 中 |
| L3（5 维度全量） | 5 + 1 汇总 | 约 4–8 分钟 | 高 |
| 增量重走（1 维度） | 1 + 1 汇总 | 约 1–3 分钟 | 很低 |

五个子 agent 并行，墙钟接近「最慢的那个」而非累加。**迭代时优先用增量重走**，别每次都全量。

## 角色分工

```
OpenSpec        = 研发流程与设计文档中心（需求/设计/生命周期）
技术评审门禁     = AI 评审流程编排器（架构/并发/性能/数据库/安全）
Coding Agent    = 代码执行者（Claude / Codex / GPT），只实现已评审通过的设计
人工签字者       = 风险承担者（见「签字人的资格与责任」）
```

- **OpenSpec 不被替代**：始终是流程与文档的事实源。
- **评审编排层**：负责调度评审 Agent、并行分析、固化流程、执行质量门禁；不替代 OpenSpec。
- **代码执行者**：只在人工批准后进入 `apply`，不重新设计方案。

## 技术评审门禁（Phase 3–4）详解

门禁资产位于 skill `opsx-technical-review`（本仓 `skills/opsx-technical-review/`，安装后为 `~/.claude/skills/opsx-technical-review/`）：

```
opsx-technical-review/
├── SKILL.md                          # 门禁编排说明（前置校验/并行调度/汇总/人工门禁）
├── agents/openai.yaml                # skill 接口描述
├── hooks/check-review-approval.sh    # PreToolUse 门禁 hook（拦截未签字的 apply）
├── roles/                            # 五个评审角色提示词（各自审查清单 + 输出格式）
│   ├── architecture.md
│   ├── concurrency.md
│   ├── performance.md
│   ├── database.md
│   └── security.md
└── technical-review-gate.workflow.js # Pi Workflow：并行 fan-out 五角色 + 结构化汇总
```

两种触发方式，产物一致（`review/*.md` + `review-summary.md`）：

1. **交互式（日常）**：`/opsx:review <change>`。主 agent 读 SKILL.md，用 Agent 工具并行启动评审子 agent，每个子 agent 自读对应 `roles/<role>.md` + 变更的 `proposal.md`/`design.md`，写出 `review/<role>.md`；再汇总 `review-summary.md`。
2. **编排式（批量/自动化）**：运行 `technical-review-gate.workflow.js`（`args = { change, roles }`），并行 fan-out（结构化 schema 强约束 verdict/findings），自动汇总门禁裁决。

### 门禁裁决规则

- 任一维度 `verdict = 打回`，或存在**未闭环 Blocker** → 门禁 `BLOCKED`：回 `design.md` 闭环后重跑门禁。
- 全部 `通过 / 有条件通过` 且无未闭环 Blocker → `READY_FOR_HUMAN_APPROVAL`：交人工确认。
- **人工确认是硬门禁**：人工在 `review-summary.md` 写入 `Technical Review Approved` 前，禁止 `/opsx:apply`。

### finding 统一字段

`ID | 严重级别(Blocker/Major/Minor) | 位置 | 风险根因 | 建议修复`

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

### Blocker 闭环留痕格式

门禁 `BLOCKED` 后回改 `design.md`，**必须留闭环记录**。原因：第二轮评审的 Agent 是全新上下文，它不知道 ARCH-01 上轮提过、这轮已改 —— 没有留痕，它要么重新发现同一问题，要么完全漏掉验证。

在 `design.md` 末尾维护固定区块：

```markdown
## 评审意见闭环记录

| finding ID | 维度 | 原始问题 | 处理方式 | 落在 design 的哪一节 | 轮次 |
|-----------|------|---------|---------|-------------------|------|
| ARCH-01 | 架构 | 计数真值源不明，DB 与缓存双写漂移 | 改为 DB 为唯一真值源，缓存仅做读加速 | §3.2 一致性设计 | R1 |
| CONC-02 | 并发 | 重复消费导致计数重复累加 | 引入 msg_id 唯一索引 + 状态 CAS | §4.1 幂等设计 | R1 |
| SEC-01 | 安全 | 导出未做 CSV 公式注入转义 | 驳回：非误报但属已知接受风险，导出仅内部管理员可见 | —（risk accepted） | R1 |
```

重走门禁时，把本区块一并交给评审 Agent，要求它**先验证上轮 Blocker 是否真的闭环**，再做新一轮审查。

### 不认可评审结论（误报 / 知情接受）

AI 评审会误报。**被误报卡死不是流程的本意**，逃生通道如下：

- **不改 design 就不重走门禁** —— 输入没变，重跑只会得到同样结论。
- 在 `review/<role>.md` 对应 finding 下追加驳回记录，并在 `review-summary.md` 的裁决计数中扣除：

```markdown
> **驳回**：SEC-01
> 理由：该导出接口仅对内部管理员开放，且经 Sa-Token 角色校验，不存在外部输入路径。
> 判定：误报（非 Blocker）
> 驳回人：张三  日期：2026-07-31
```

- **知情接受风险**（问题真实但决定不修）用 `risk accepted` 而非「误报」，并写明接受理由与复查时机：

```markdown
> **risk accepted**：PERF-03
> 理由：当前数据量 3000 条，全量加载内存可控。
> 触发阈值：单次 > 5 万条时须改流式处理，届时重开变更。
> 接受人：李四  日期：2026-07-31
```

两者都必须**具名留痕**。禁止直接删除 finding —— 删掉就没有决策记录了。

### 签字人的资格与责任

这是团队推行这套流程时第一个会吵起来的问题，提前定清楚：

- **签字含义**：签字不是「我认可 AI 的结论」，而是「**我为这个方案进入实现负责**」。AI 评审是输入，不是免责声明。
- **资格**：签字人应当具备评审该变更等级的能力。L3 变更建议由该领域 owner 或架构负责人签，并由第二人复核。
- **能否自签**：L0/L1 允许作者自签。**L2/L3 不建议自签** —— 自己设计自己批准，门禁就退化成了形式。当前 hook **不校验签字人身份**（写任意非占位字符即放行），这是**依赖团队自觉的约定，不是技术强制**。
- **签字前至少要做**：读完 `review-summary.md` 全文；逐条确认 Blocker 已闭环；确认「有条件通过」的条件都进了 `tasks.md`；对驳回/risk accepted 项独立判断而非照单全收。
- **不看就签的后果**：等于取消门禁。若团队普遍出现盲签，应当调整的是分级规则（降低门禁频次、提高单次质量），而不是继续走过场。

签字格式：

```markdown
Technical Review Approved: 张三  2026-07-31
复核（L3 必填）: 李四  2026-07-31
```

## 门禁的真实强制力（重要）

**门禁是流程纪律工具，不是安全边界。** 它拦得住「忘了」，拦不住「铁了心要绕」。三道防线强度递减：

| 防线 | 覆盖范围 | 拦不住什么 |
|------|---------|-----------|
| ① `hooks/check-review-approval.sh`（PreToolUse/Bash） | Bash 执行 `openspec apply` / `opsx apply` | **`/opsx:apply` 斜杠命令与 skill 调用** —— 它们不产生 Bash 命令，PreToolUse(Bash) 永不触发 |
| ② apply skill / command 的 Step 2 前置校验 | `/opsx:apply` 与 `openspec-apply-change` 两条路径 | 提示词级约束，可能被用户明确指令覆盖 |
| ③ 人工签字 + code review | 最终把关 | 签字人不看就签 |

**始终存在的绕过路径**：直接让 Agent 用 Edit/Write 改代码，完全不经过任何 apply 入口 —— 三道防线全部看不到。

所以：**别把门禁当成「代码不可能未经评审进主干」的保证**。真正的兜底仍然是 PR review 与 CI。门禁的价值在于让正常路径上「评审」成为默认动作而非可选动作。

### 门禁启用与部署

hook **必须注册后才生效**。未注册时第一道防线为零 —— 这是最常见的「以为有门禁其实没有」的原因。

在 `~/.claude/settings.json` 中注册：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ~/.claude/skills/opsx-technical-review/hooks/check-review-approval.sh"
          }
        ]
      }
    ]
  }
}
```

验证是否生效（在一个没有 `review-summary.md` 的变更上执行，应被拒绝）：

```bash
openspec apply some-change-without-review
```

hook 依赖 `jq`，缺失时脚本会失败。确认已安装：

```bash
jq --version
```

## 重走门禁（迭代回路操作手册）

铁律：**门禁输入是 `design.md`（+ `proposal.md`）。输入变了且变在评审维度上 → 重走；没变 → 不重走。**

| 场景 | 做法 | 命令 |
|------|------|------|
| 改动牵动跨维度地基（模块归属、一致性口径、表模型） | **全量重走**，纳入范围的维度全跑 | `/opsx:review <change>` |
| 改动只碰单一维度（纯转义、纯索引调整） | **增量重走**，只重跑受影响维度，其余沿用上轮 `review/<role>.md` | `/opsx:review <change> --roles security` |
| 不认可结论（误报/知情接受） | **不重走**，留驳回痕迹，仅更新裁决计数 | — |
| 仅改文案措辞、补充说明，未动技术决策 | **不重走** | — |

- **裁决始终对全部纳入维度求值**：沿用维度若仍有未闭环 Blocker，门禁仍 `BLOCKED`。
- **判断口诀**：宁可多跑一个维度，不可漏跑被牵连的维度。

**牵连关系速查**（改了左边，右边也要重跑）：

| 改动内容 | 必须一并重跑 |
|---------|-------------|
| 表结构 / 索引 | database + performance + concurrency（幂等键依赖唯一索引） |
| 幂等 / 状态机设计 | concurrency + database |
| 同步改异步（引入 MQ） | 全部五维度 |
| 批大小 / 并发度 | performance + concurrency + database |
| 接口出入参 | security + architecture |
| 加密 / 脱敏方案 | security + database（加密字段无法直接建唯一索引） |

## 评审维度覆盖边界

当前五个维度**不覆盖**以下方面，这些恰恰是上线出事的高频原因。在 `design.md` 中自行补充，或由架构维度兼顾：

| 缺口 | 应当回答的问题 | 当前归属 |
|------|--------------|---------|
| **可观测性** | 关键路径有无日志埋点？监控指标是什么？告警阈值？出问题怎么定位？ | 未覆盖，建议并入 architecture 清单 |
| **兼容性与回滚** | 灰度怎么放？有无开关？数据能否回滚？老客户端/存量数据兼容吗？ | 未覆盖，建议并入 architecture 清单 |
| **可测试性** | 这个设计怎么写单测？外部依赖能否 mock？有无需要造的测试数据？ | 未覆盖 |
| **运维成本** | 新增了哪些需要人工干预的场景？有无对账/重跑工具？ | 未覆盖 |

**在补充角色提示词之前，签字人应当把这四项作为签字前的自查清单手动过一遍。**

## Phase 6 验证详解

Phase 6 的成熟度低于 Phase 3–4，以下为约定动作，其中静态扫描与 AI Code Review 依赖项目自身配置：

1. **编译 + 单测 + 集测**：按项目实际构建命令执行（Maven/Gradle/npm 等），全绿才继续。
2. **静态扫描**：Sonar 或等价工具，按项目质量门限判定。
3. **AI Code Review**：对本次变更的 diff 做审查，产出 `final-review.md`。
4. **条件核对**：逐条核对 `review-summary.md`「有条件通过的条件清单」是否真的实现 —— **这是门禁闭环的最后一环，最容易被跳过**。
5. **实现与设计的一致性核对**：实现是否偏离了已评审的方案。

### 修复后要不要重走门禁？

| 修复性质 | 是否重走 Phase 3 门禁 |
|---------|---------------------|
| 纯 bug 修复，未动设计 | 否，重跑 Phase 6 即可 |
| 修复过程中**改了技术方案**（换存储、改并发模型、改表结构） | **是**，回 `design.md` 更新后按牵连关系重走对应维度 |
| 发现设计缺陷但决定下个变更再改 | 否，记录为 risk accepted 并在 `final-review.md` 留痕 |

**判据与 Phase 3 一致：`design.md` 变了没有。** 代码改了但设计没变 → 不重走门禁。

`final-review.md` 建议包含：验证项清单与结果、条件核对表、遗留问题与后续计划。

## 开发者速查

```bash
# ── 日常小改动（L0）：不走门禁 ──────────────────────
/opsx:explore fix-typo-in-toast
/opsx:apply fix-typo-in-toast          # review-summary.md 记一行豁免理由并签字

# ── 标准变更（L1–L3）：走门禁 ──────────────────────
# Phase 1-2：澄清需求 + 探索方案（不写代码）
/opsx:explore add-contact-batch-import
#   → openspec/changes/add-contact-batch-import/proposal.md
#   → openspec/changes/add-contact-batch-import/design.md（推荐方案B：异步MQ分片消费）

# 分级判定：命中「异步/MQ/批量10万」→ L3 全量

# Phase 3-4：技术评审门禁（并行评审 + 汇总，不写代码）
/opsx:review add-contact-batch-import
#   → review/{architecture,concurrency,performance,database,security}.md
#   → review-summary.md（门禁裁决）

# 若 BLOCKED：回改 design.md + 填「评审意见闭环记录」，然后按牵连关系重走
/opsx:review add-contact-batch-import --roles concurrency,database

# 人工门禁：审阅 review-summary.md，认可后写入：
#   Technical Review Approved: 张三  2026-07-31

# Phase 5：代码实现（人工签字后才放行）
/opsx:apply add-contact-batch-import

# Phase 6：验证 + AI 审查 + 条件核对
#   → final-review.md

# 收口
/opsx:archive add-contact-batch-import
```

### 常见问题

**Q：改个字段也要跑五个 Agent？**
不用。看分级表，多数是 L0/L1。

**Q：AI 报了个 Blocker 但我认为是误报，被卡死了？**
见「不认可评审结论」。写驳回记录并具名，不改 design 就不用重走。

**Q：门禁跑完了但我直接让 Agent 改代码，会被拦吗？**
不会。见「门禁的真实强制力」—— 绕过路径始终存在，兜底靠 PR review。

**Q：`/opsx:review` 提示缺 design.md？**
门禁前置校验要求 `proposal.md` 与 `design.md` 都存在且 design 含推荐方案。先回 `/opsx:explore` 补齐 —— 这正是「方案未确定不开始编码」。

**Q：签字了但门禁裁决是 BLOCKED，能 apply 吗？**
不能。apply 的前置校验会拦。BLOCKED 必须先闭环 Blocker 并重走门禁。

## 与项目既有约定的衔接

- 沟通/注释中文、禁止魔法值、异常打印堆栈（见 `CLAUDE.md`）在各阶段 Agent 提示词中作为约束继承。
- SQL 变更规范（init 建表 / test update.sql / 禁改 upgrade）在数据库评审与 `apply` 阶段强制。
- Subagent 准则（见 `AGENTS.md`）：评审子 agent 只报告 findings 不改代码；主 agent 负责汇总、集成与最终验证。
