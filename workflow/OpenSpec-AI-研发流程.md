# OpenSpec + AI Agent 研发流程

> 以 OpenSpec 作为研发流程的核心控制器（需求澄清、方案设计、变更生命周期），在进入代码实现前增加 **Technical Review Gate（技术评审门禁）**，由 AI Agent 模拟架构/并发/性能/数据库/安全评审角色。
>
> **核心原则：需求未明确，不分析性能；方案未确定，不开始编码。**
>
> **质量保障理念：第一性原理（Phase 1 确保方向正确）+ 交叉验证（Phase 2/3/6 多维度互证）。**

**新人从这读起**：先看「[门禁适用范围分级](#门禁适用范围分级)」判断你的变更要不要走门禁 —— 大部分日常小改动不需要。再看「[开发者速查](#开发者速查)」。

## 全景流程

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
      ├─ /opsx:overview → overview.md（文档地图 / 端到端流程 / 字段台账 / 条件矩阵）
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
      │                                                        │
      ├─ BLOCKED ─→ 回改 design.md（留闭环记录）─→ 重走门禁 ⟲     │
      │                                                        │
      ▼ READY_FOR_HUMAN_APPROVAL                               │
【人工确认评审结果】← 硬门禁：人工写入 "Technical Review Approved"  │
      ▼                                                        │
      ◄────────────────────────────────────────────────────────┘
OpenSpec Apply（Phase 5）→ 代码实现（Controller/Service/Repository/SQL/测试）
      ▼
代码质量评审（Phase 5.5）→ /opsx:quality → review/code-quality.md
      │  查 diff 的重复率/可读性/死代码/复杂度/设计偏离；未闭环 Blocker 不得归档
      ▼
验证（Phase 6）→ /opsx:verify 三维校验 + 条件核对（用 overview.md 条件矩阵）+ 项目自有测试
      │  ※ 交叉验证 III：实现与设计交叉核对（Coherence 一致性校验）
      ▼
OpenSpec Archive → specs 沉淀能力；评审与讨论产物随变更进 changes/archive/
```

## 各阶段职责与产物

| 阶段 | 入口 | 做什么 | 产物 | 是否改代码 |
|------|------|--------|------|-----------|
| Phase 1 需求澄清 | `/opsx:explore` | 明确业务目标、边界、输入输出、数据规模、性能指标、兼容/安全要求；**应用第一性原理分析** | `proposal.md`（含第一性原理分析区块） | 否 |
| Phase 2 方案探索 | `/opsx:explore` | 讨论实现路径，输出多个候选方案+优缺点+推荐方案+决策理由；**候选方案四维对比矩阵交叉验证** | `design.md`（含方案交叉验证矩阵） | 否 |
| （贯穿 1–2）讨论回流 | skill `opsx-discussion-sync` | 子 agent 按五段契约返回，主 agent 逐条落盘或记未采纳 | `discussion-log.md` | 否 |
| 变更总览 | `/opsx:overview` | 汇成文档地图、端到端流程、字段变更台账、规则条件可追溯矩阵 | `overview.md`（派生视图，勿手改） | 否 |
| 分级判定 | 人工（参照下表） | 判断变更等级，决定跑哪些维度或直接豁免 | 记录在 `review-summary.md` | 否 |
| Phase 3 技术评审门禁 | `/opsx:review` | 专项 Agent 并行评审已确定方案；**五角色多维度交叉验证** | `review/*.md` | 否 |
| Phase 4 评审确认 | 同上（汇总） | 汇总风险与修改建议，给出门禁裁决 | `review-summary.md` | 否 |
| 人工门禁 | 人工 | 审阅评审结论，认可后写入批准标记 | `review-summary.md` 批准区 | 否 |
| Phase 5 代码实现 | `/opsx:apply` | 按已评审通过的设计实现，不重新设计 | 代码 + `tasks.md` 勾选 | 是 |
| Phase 5.5 代码质量评审 | `/opsx:quality` | 对本次 diff 查重复率/可读性/死代码/复杂度/设计偏离 | `review/code-quality.md` | 否（只报告） |
| Phase 6 验证 | `/opsx:verify` | 三维校验（含实现与设计一致性）+ 条件核对 + 项目自有测试；**实现与设计交叉核对** | 校验报告（对话内） | 修复项 |
| 收口 | `/opsx:archive` | 变更归档，能力沉淀进 specs；评审与讨论产物随变更整体归档 | `openspec/specs/**` + `changes/archive/<name>/` | 否 |

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

门禁资产位于 skill `opsx-technical-review`（本仓源码在 `skills/opsx-technical-review/`；安装后落在**你所用 agent 的 skills 根目录**下 —— Claude Code 为 `~/.claude/skills/`，Codex 为 `~/.codex/skills/`，项目级安装为 `<项目>/.claude/skills/`，详见 README「各 agent 全局安装目录」。文档与提示词中一律用相对路径或 `<SKILL_DIR>` 占位，不写死绝对路径）：

```
opsx-technical-review/
├── SKILL.md                          # 门禁编排说明（前置校验/并行调度/汇总/人工门禁）
├── shared/                           # agent 执行规则的唯一事实源，roles/命令/workflow 一律引用不复制
│   ├── finding-format.md             #   finding 七字段 + 三条硬规则 + verdict + 输出骨架
│   ├── closed-loop-verification.md   #   重走门禁时如何验证上轮 Blocker 真的闭环
│   ├── gate-policy.md                #   裁决判定 / 重走范围 / 牵连关系 / 驳回与 risk accepted
│   └── apply-gate-check.md           #   apply 前的人工签字校验
├── roles/                            # 五个评审角色：角色定位 + 审查清单 + 本维度差异
│   ├── architecture.md  concurrency.md  performance.md  database.md  security.md
├── agents/openai.yaml                # skill 接口描述
├── hooks/check-review-approval.sh    # PreToolUse 门禁 hook（拦截未签字的 apply）
└── technical-review-gate.workflow.js # Pi Workflow：并行 fan-out 五角色 + 结构化汇总
```

**事实源划分**（改文档前先看这条，避免又写出两份互相矛盾的规则）：

| 内容类型 | 唯一事实源 | 例子 |
|---------|-----------|------|
| 面向**人**的策略 | **本文档** | 分级规则、签字资格与责任、门禁强制力边界、产物 git 生命周期 |
| 面向 **agent** 的执行规则 | `skills/opsx-technical-review/shared/` | finding 字段、闭环验证步骤、裁决判定、驳回留痕格式 |

其余文件（roles、`/opsx:*` 命令、workflow.js）一律**引用**，不复制。

两种触发方式，产物一致（`review/*.md` + `review-summary.md`）：

1. **交互式（日常）**：`/opsx:review <change>`。主 agent 读 SKILL.md，用 Agent 工具并行启动评审子 agent，每个子 agent 自读对应 `roles/<role>.md` + 变更的 `proposal.md`/`design.md`，写出 `review/<role>.md`；再汇总 `review-summary.md`。
2. **编排式（批量/自动化）**：运行 `technical-review-gate.workflow.js`（`args = { change, roles }`），并行 fan-out（结构化 schema 强约束 verdict/findings），自动汇总门禁裁决。

### 门禁裁决规则

- 任一维度 `verdict = 打回`，或存在**未闭环 Blocker** → 门禁 `BLOCKED`：回 `design.md` 闭环后重跑门禁。
- 全部 `通过 / 有条件通过` 且无未闭环 Blocker → `READY_FOR_HUMAN_APPROVAL`：交人工确认。
- **人工确认是硬门禁**：人工在 `review-summary.md` 写入 `Technical Review Approved` 前，禁止 `/opsx:apply`。

完整判定表与边界情形（声称已闭环但实际未闭环、条件映射不到 tasks 等）见 `skills/opsx-technical-review/shared/gate-policy.md`。

### finding 统一字段

```
ID | 严重级别(Blocker/Major/Minor) | 位置 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复
```

后三个字段是为了解决「Blocker 术语太多，没参与设计的人看不懂到底会出什么事」：

| 字段 | 要求 | 反例 |
|------|------|------|
| **一句话白话** | 不得出现未解释的专有名词 | 「幂等键缺失导致 CAS 失效」 |
| **触发场景** | 什么输入/时序/数据量/故障 → 什么可观测现象 | 「并发高时可能有问题」 |
| **不修的后果** | 影响面（哪些用户/数据/接口）+ 严重度 | 「可能有风险」 |

**写不出具体触发场景的 Blocker 一律降级为 Major** —— 这条同时治两个病：术语堆砌看不懂，以及 AI 误报把门禁卡死。

字段定义与输出骨架的事实源在 `shared/finding-format.md`，本节只作说明。`review-summary.md` 另需给出**摘要（给非设计者的三句话）**与**术语表**，让签字人读得懂自己签的是什么。

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

AI 评审会误报。**被误报卡死不是流程的本意**，两条逃生通道：

- **误报**（问题不成立）→ 在 `review/<role>.md` 追加「驳回」记录。
- **risk accepted**（问题真实但决定不修）→ 追加「risk accepted」记录，并写明**复查触发阈值**。

两者不能混用：**问题不成立叫误报，问题成立但不修叫 risk accepted**。混用会让后续复查失去线索。都必须**具名留痕**，禁止直接删除 finding —— 删掉就没有决策记录了。

前提：**不改 `design.md` 就不重走门禁**，输入没变重跑只会得到同样结论。

留痕的确切格式与示例见 `skills/opsx-technical-review/shared/gate-policy.md` 第 4 节。

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

## 门禁产物的 git 归属与生命周期

**结论先说：门禁产物提交 git，随变更归档，不删除。**

| 产物 | 提交 git | 归档后去向 | 是否进 `specs/` |
|------|---------|-----------|----------------|
| `review/<role>.md` | 是 | `openspec/changes/archive/<name>/review/` | 否 |
| `review-summary.md`（含签字行） | 是 | `openspec/changes/archive/<name>/` | 否 |
| `review/code-quality.md` | 是 | 同上 | 否 |
| `discussion-log.md` | 是 | 同上 | 否 |
| `overview.md` | 是 | 同上 | 否 |

`openspec archive` 把整个 `changes/<name>/` 目录搬到 `changes/archive/<name>/`，上述文件**自动随之归档，不需要额外操作，也不要在归档前手工删除**。

### 为什么不是「开发完就删」

- **签字是责任凭证**。`Technical Review Approved: 张三 2026-07-31` 删掉之后，就没有任何记录能回答「这个方案当初谁批的、基于什么结论批的」。签字人承担的责任需要有据可查。
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

## 门禁的真实强制力（重要）

**门禁是流程纪律工具，不是安全边界。** 它拦得住「忘了」，拦不住「铁了心要绕」。三道防线强度递减：

| 防线 | 覆盖范围 | 拦不住什么 |
|------|---------|-----------|
| ① `hooks/check-review-approval.sh`（PreToolUse/Bash） | Bash 执行 `openspec apply` / `opsx apply` | **`/opsx:apply` 斜杠命令与 skill 调用** —— 它们不产生 Bash 命令，PreToolUse(Bash) 永不触发；**且注册指向旧版副本时会静默放行**（见「门禁启用与部署」） |
| ② apply skill / command 的 Step 2 前置校验 | `/opsx:apply` 与 `openspec-apply-change` 两条路径 | 提示词级约束，可能被用户明确指令覆盖 |
| ③ 人工签字 + code review | 最终把关 | 签字人不看就签 |

**始终存在的绕过路径**：直接让 Agent 用 Edit/Write 改代码，完全不经过任何 apply 入口 —— 三道防线全部看不到。

所以：**别把门禁当成「代码不可能未经评审进主干」的保证**。真正的兜底仍然是 PR review 与 CI。门禁的价值在于让正常路径上「评审」成为默认动作而非可选动作。

### 门禁启用与部署

hook **必须注册后才生效**。未注册时第一道防线为零 —— 这是最常见的「以为有门禁其实没有」的原因。

> hook 注册是 **Claude Code 特有机制**（`~/.claude/settings.json`），下面的注册步骤仅适用于 Claude Code。其他 agent（Codex / opencode / Cursor / Gemini）没有等价的 PreToolUse 拦截，第一道防线天然为零，只剩第②③道 —— 这些环境下更要靠 apply skill 的前置校验与人工签字。

**先确认要注册哪个路径**。skills 根目录随 agent 而不同（Claude Code `~/.claude/skills/`、Codex `~/.codex/skills/`、项目级 `<项目>/.claude/skills/` 等，见 README），且其中的同名目录很可能是符号链接，指向别处的独立副本（如 `~/.cc-switch/skills/`、其他 skill 管理器的仓库）。**那些副本未必包含本仓的门禁修复** —— 指过去等于启用了一个看似生效、实则放行的旧版 hook，比不注册更危险。先查清楚（把路径换成你实际的 skills 根目录）：

```bash
ls -ld ~/.claude/skills/opsx-technical-review
```

若输出以 `l` 开头（符号链接）且箭头指向非本仓路径，**改为直接指向本仓源文件**，或先把本仓内容同步过去。用下面这条命令得到确切路径（在本仓根目录执行）：

```bash
realpath skills/opsx-technical-review/hooks/check-review-approval.sh
```

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

**注册后必须验证内容版本**，只看「有没有 hooks 字段」不够 —— 旧版 hook 在缺 `review-summary.md` 时会放行：

```bash
grep -c '技术评审门禁尚未执行' "$(jq -r '.hooks.PreToolUse[0].hooks[0].command' ~/.claude/settings.json | sed 's/^bash //')"
```

输出 `1` 才是含 fail-open 修复的版本；输出 `0` 说明指向了旧副本，必须改路径。

再做行为验证（在一个没有 `review-summary.md` 的变更上执行，应被拒绝）：

```bash
openspec apply some-change-without-review
```

hook 依赖 `jq`，缺失时脚本会失败。确认已安装：

```bash
jq --version
```

## 重走门禁（迭代回路操作手册）

铁律：**门禁输入是 `design.md`（+ `proposal.md`）。输入变了且变在评审维度上 → 重走；没变 → 不重走。**

判断口诀：**宁可多跑一个维度，不可漏跑被牵连的维度。**

完整的场景判定表与**牵连关系速查表**（改了表结构要连带重跑哪些维度等）见 `skills/opsx-technical-review/shared/gate-policy.md` 第 2、3 节 —— 那是唯一事实源，本文不复制一份以免两处失配。

操作命令：

```bash
/opsx:review <change>                          # 全量重走
/opsx:review <change> --roles security         # 增量重走，其余沿用上轮 review/<role>.md
```

**裁决始终对全部纳入维度求值**：沿用维度若仍有未闭环 Blocker，门禁仍 `BLOCKED`。

## Phase 1 需求澄清：第一性原理分析

Phase 1 的核心任务是**确保方向正确**。在明确业务目标、边界、输入输出等常规需求信息之外，必须应用第一性原理分析，避免解决错误的问题。

### proposal.md 必须包含的第一性原理分析区块

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

## Phase 2 方案探索：候选方案交叉验证

Phase 2 的核心任务是**在多个候选方案之间做出有依据的选择**。单一方案无法交叉验证，至少需要 2 个候选方案。

### design.md 必须包含的方案交叉验证矩阵

```markdown
## 候选方案交叉验证矩阵

| 维度 | 方案 A（如：同步批量插入） | 方案 B（如：异步 MQ 分片消费） | 方案 C（如：ETL 离线导入） |
|------|------------------------|---------------------------|----------------------|
| **成本** | 开发 2 人日 / 无额外资源 | 开发 5 人日 / 需引入 MQ | 开发 3 人日 / 需 ETL 调度平台 |
| **性能** | 10 万条需 5 分钟，阻塞 | 10 万条需 2 分钟，非阻塞 | 10 万条需 10 分钟，离线无感知 |
| **复杂度** | 低：单体同步逻辑 | 高：需处理消息重试/死信/幂等 | 中：需配置 ETL 任务与监控 |
| **风险** | 超时风险高，无法扩展 | MQ 依赖引入新故障点 | ETL 平台依赖，实时性差 |
| **可测试性** | 易：单元测试即可 | 中：需 mock MQ 或集成测试 | 易：离线任务易回归 |
| **运维成本** | 低：无新组件 | 高：MQ 监控/告警/容量规划 | 中：ETL 任务监控 |

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

## Phase 3 技术评审门禁：多维度交叉验证

Phase 3 的五角色并行评审本身就是交叉验证机制：同一方案被五个不同专业视角审查，互相发现盲区。

### 交叉验证的典型场景

| 场景 | 单一维度可能漏掉 | 交叉验证如何发现 |
|------|---------------|----------------|
| 幂等设计 | 并发维度认为「有唯一索引就够了」 | 数据库维度发现「索引缺少 tenant_id 前导，跨租户会冲突」 |
| 缓存一致性 | 性能维度建议「缓存永不过期」 | 架构维度发现「无过期机制导致脏数据无法更新」 |
| SQL 注入 | 安全维度发现「拼接 SQL」 | 数据库维度进一步指出「预编译之外还需输入长度校验」 |

### 交叉验证的落地机制

1. **五个维度独立评审**：每个子 agent 只读 `proposal.md` + `design.md`，不看其他维度的 `review/<role>.md`，避免锚定偏差
2. **汇总阶段做冲突检测**：`review-summary.md` 必须列出「跨维度冲突项」（如：性能建议与安全建议矛盾）
3. **冲突必须在 design.md 中闭环**：不能让矛盾的建议同时进入 `tasks.md`

---

## Phase 6 验证：实现与设计交叉核对

Phase 6 的 Coherence 维度（`/opsx:verify` 的三维校验之一）就是交叉验证：用 `design.md` 验证代码实现。

### 增强交叉核对清单

在 `/opsx:verify` 的标准三维校验基础上，补充以下人工核对项（这些是 `/opsx:verify` 不检查的）：

```markdown
## Phase 6 交叉核对清单

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
```

**有任一未通过项不得归档。** 修复后重跑 Phase 6，若修复过程改了设计则需重走对应维度的 Phase 3 门禁。

---

## 质量保障理念总结

| 阶段 | 核心机制 | 防止什么问题 |
|------|---------|------------|
| Phase 1 | **第一性原理分析** | 解决错误的问题、过度设计、需求误解 |
| Phase 2 | **候选方案交叉验证** | 锚定单一方案、未考虑权衡、决策不可追溯 |
| Phase 3 | **五角色多维度交叉验证** | 单一视角盲区、跨维度冲突未发现 |
| Phase 6 | **实现与设计交叉核对** | 实现偏离设计、评审条件未闭环、可测试性/运维成本被遗忘 |

**三个交叉验证点形成闭环**：Phase 2 的候选方案对比 → Phase 3 的五维度互证 → Phase 6 的实现回溯设计。任一环节断裂都会导致质量缺口。

---

## 评审维度覆盖边界

设计层五维度 + 实现层代码质量维度之外，仍有以下缺口 —— 这些恰恰是上线出事的高频原因。在 `design.md` 中自行补充，或由架构维度兼顾：

| 缺口 | 应当回答的问题 | 当前归属 |
|------|--------------|---------|
| **可观测性** | 关键路径有无日志埋点？监控指标是什么？告警阈值？出问题怎么定位？ | 已并入 architecture 清单 |
| **兼容性与回滚** | 灰度怎么放？有无开关？数据能否回滚？老客户端/存量数据兼容吗？ | 已并入 architecture 清单 |
| **可测试性** | 这个设计怎么写单测？外部依赖能否 mock？有无需要造的测试数据？ | **部分覆盖** —— Phase 5.5 代码质量维度查「难以单测的构造」（静态调用链、隐藏依赖、构造函数里干活），但那是实现之后；**Phase 6 人工核对清单已补充「设计阶段可测试性验证」** |
| **运维成本** | 新增了哪些需要人工干预的场景？有无对账/重跑工具？ | **Phase 6 人工核对清单已补充「运维成本验证」** |

**签字人应当把 Phase 6 的「设计阶段可测试性」与「运维成本」两项作为签字前的自查清单手动过一遍。**

## Phase 6 验证详解

核心是一条命令 —— `/opsx:verify`（OpenSpec 上游命令，非本仓自建）：

```bash
/opsx:verify <change-name>
```

它对实现做三维校验，其中 **Coherence 正是「实现与设计的一致性核对」**：

| 维度 | 校验内容 |
|------|---------|
| Completeness | `tasks.md` 勾选是否完整、spec 中的 requirement 是否都已实现 |
| Correctness | requirement ↔ 代码实现映射、scenario 是否被覆盖 |
| **Coherence** | **实现是否偏离 `design.md` 的既定决策**、代码风格与项目模式是否一致 |

输出为对话内的评分卡 + 按 CRITICAL / WARNING / SUGGESTION 分级的问题清单。**存在 CRITICAL 时不得归档。**

### 门禁特有的补充：条件核对

`/opsx:verify` 不认识 `review-summary.md`（那是本门禁的产物，非 OpenSpec 原生 artifact），因此它**不会**核对「有条件通过」的条件。这一步需单独做：

先跑一次 `/opsx:overview <change>` 刷新「规则条件可追溯矩阵」，再逐条核对矩阵中每项是否真的实现 —— **这是门禁闭环的最后一环，也最容易被跳过**。矩阵已把 `proposal` 验收条件、`spec` scenario、`design` 约束、`review-summary` 的「有条件通过」四类来源合并到一张表，逐行看即可，不必再翻四份文档。标 `⚠️ 未落地` 的行视同 Blocker，不得归档。

条件既然映射到了 `tasks.md` 的勾选项，此处即核对这些任务是否真的完成而非只是打了勾。

### 项目自有的验证动作

编译、单测、集测、静态扫描（Sonar 等）按**项目自身规范**执行，本仓不做约定（这是跨项目 skill 仓，写死构建命令没有意义）。全绿才可归档。

### 修复后要不要重走门禁？

| 修复性质 | 是否重走 Phase 3 门禁 |
|---------|---------------------|
| 纯 bug 修复，未动设计 | 否，重跑 Phase 6 即可 |
| 修复过程中**改了技术方案**（换存储、改并发模型、改表结构） | **是**，回 `design.md` 更新后按牵连关系重走对应维度 |
| 发现设计缺陷但决定下个变更再改 | 否，记录为 risk accepted 并在 `review-summary.md` 留痕（见「不认可评审结论」） |

**判据与 Phase 3 一致：`design.md` 变了没有。** 代码改了但设计没变 → 不重走门禁。

## 开发者速查

```bash
# ── 日常小改动（L0）：不走门禁 ──────────────────────
/opsx:explore fix-typo-in-toast
/opsx:apply fix-typo-in-toast          # review-summary.md 记一行豁免理由并签字

# ── 标准变更（L1–L3）：走门禁 ──────────────────────
# Phase 1-2：澄清需求 + 探索方案（不写代码）
/opsx:explore add-contact-batch-import
#   → openspec/changes/add-contact-batch-import/proposal.md
#      ※ 必含「第一性原理分析」区块（表面需求 vs 底层问题 / 基本约束 / 必要性验证）
#   → openspec/changes/add-contact-batch-import/design.md（推荐方案B：异步MQ分片消费）
#      ※ 必含「候选方案交叉验证矩阵」（至少2个候选方案 × 四维对比）
#   → discussion-log.md（子 agent 讨论结论回流，见 skill opsx-discussion-sync）

# 生成变更总览：一页看懂流程、字段变更与规则条件是否遗漏
/opsx:overview add-contact-batch-import
#   → overview.md（派生视图，勿手改；标 ⚠️ 未落地的条件视同 Blocker）

# 分级判定：命中「异步/MQ/批量10万」→ L3 全量

# Phase 3-4：技术评审门禁（并行评审 + 汇总，不写代码）
/opsx:review add-contact-batch-import
#   → review/{architecture,concurrency,performance,database,security}.md
#      ※ 五角色独立评审，交叉验证同一方案（多维度互证）
#   → review-summary.md（门禁裁决 + 跨维度冲突检测）

# 若 BLOCKED：回改 design.md + 填「评审意见闭环记录」，然后按牵连关系重走
/opsx:review add-contact-batch-import --roles concurrency,database

# 人工门禁：审阅 review-summary.md，认可后写入：
#   Technical Review Approved: 张三  2026-07-31

# Phase 5：代码实现（人工签字后才放行）
/opsx:apply add-contact-batch-import

# Phase 5.5：实现层代码质量评审（只报告不改代码）
/opsx:quality add-contact-batch-import
#   → review/code-quality.md（重复率/可读性/死代码/复杂度/设计偏离）
#   → 未闭环 Blocker 不得归档；修复走 tasks.md 勾选

# Phase 6：验证（实现与设计一致性 + 条件核对）
/opsx:overview add-contact-batch-import   # 先刷新条件矩阵
/opsx:verify add-contact-batch-import
#   → 三维校验报告（Completeness / Correctness / Coherence）；有 CRITICAL 则修复后重跑
#      ※ Coherence 维度：实现与设计交叉核对
#   → 再逐条核对 overview.md 的条件矩阵，⚠️ 未落地项视同 Blocker
#   → 补充人工核对清单（回溯第一性原理 / 方案选择一致性 / 可测试性 / 运维成本）

# 收口（评审/讨论/总览产物随变更整体归档，不要手工删除）
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

**Q：评审文档要提交 git 吗？开发完能删吗？**
提交，不删。见「门禁产物的 git 归属与生命周期」—— 签字是责任凭证，risk accepted 记录着复查触发点，删掉就没有决策记录了。归档时 `openspec archive` 会自动把它们随变更搬进 `changes/archive/<name>/`。

**Q：proposal / design / spec / tasks 四份文档太散，怎么确认规则条件没遗漏？**
跑 `/opsx:overview <change>`。它的「规则条件可追溯矩阵」把四类来源（proposal 验收条件、spec scenario、design 约束、review 的「有条件通过」）合成一张表，映射不到 `tasks.md` 的条目会标 `⚠️ 未落地`。同一份 `overview.md` 里还有端到端运行流程图与字段变更台账。

**Q：怎么确保方案选择是有依据的，不是拍脑袋？**
Phase 2 必须输出「候选方案交叉验证矩阵」，至少 2 个候选方案从成本/性能/复杂度/风险四维对比，推荐方案必须回答「为什么不选其他方案」。未通过交叉验证的 design 不得进入门禁。

**Q：怎么防止解决了错误的问题？**
Phase 1 必须完成「第一性原理分析」，区分表面需求与底层问题，识别基本约束，验证必要性。Phase 6 验证时会回溯检查实现是否解决了「底层问题」而非「表面需求」。

**Q：Blocker 写得全是术语，看不懂到底会出什么事？**
新版 finding 强制带「一句话白话 / 触发场景 / 不修的后果」三列，`review-summary.md` 另有摘要与术语表。**写不出具体触发场景的 Blocker 会被自动降级为 Major** —— 若仍看到看不懂的 Blocker，那本身就是评审质量问题，可以要求重写而不是硬猜。

**Q：子 agent 讨论完的结论怎么不丢？**
按 skill `opsx-discussion-sync`：子 agent 返回固定五段（结论/依据/建议落点/未决问题/弃案），主 agent 必须把每条建议落点落到 artifact 或记为「未采纳 + 理由」，并追加 `discussion-log.md`。结束本轮前有防丢自检。

## 与项目既有约定的衔接

- 沟通/注释中文、禁止魔法值、异常打印堆栈（见 `CLAUDE.md`）在各阶段 Agent 提示词中作为约束继承。
- SQL 变更规范（init 建表 / test update.sql / 禁改 upgrade）在数据库评审与 `apply` 阶段强制。
- Subagent 准则（见 `AGENTS.md`）：评审子 agent 只报告 findings 不改代码；主 agent 负责汇总、集成与最终验证。
