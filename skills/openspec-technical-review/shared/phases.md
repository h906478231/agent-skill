# OpenSpec 研发流程 Phases 定义

> 状态路由由 coordinator 与 workflow 内置判定：本表与下图是能力地图，不是必跑顺序。L2/L3 检查决策充分性，不强制重复 grill；有待查事实才 explore，无阻断未知直接 propose/update。恢复时复核实际产物和批准版本，不从头覆盖。
>
> **按需环节**（表中标「按需」者：Grill 访谈、讨论回流、变更总览、讲解视频）只在触发条件命中时运行，不进入每次变更的默认路径。变更总览在字段或规则条件较多的变更（L2/L3）推荐生成；未生成时 Verify 直接核对 `review-summary.md` 的条件清单，不阻断。

## 各阶段职责与产物

| 阶段 | 入口                               | 做什么 | 产物 | 是否改代码 |
|------|----------------------------------|--------|------|-----------|
| Grill 访谈（按需入口） | `/opsx:grill`（仅未决项） | L2/L3 检查决策充分性，复用有效共识；同步沉淀领域术语与决策 | 共识（写入变更目录的 `discussion-log.md`）+ `CONTEXT.md` + `docs/adr/`（项目级，不随变更归档） | 否 |
| 讨论回流（grill 查证，按需） | skill `openspec-discussion-sync` | grill 派出的查证子 agent 按五段契约返回，主 agent 逐条落盘或记未采纳；explore 在主会话中讨论，不派子 agent | `discussion-log.md` | 否 |
| Phase 1 需求澄清 | `/opsx:explore`                  | 明确业务目标、边界、输入输出、数据规模、性能指标、兼容/安全要求；**应用第一性原理分析** | `proposal.md`（含第一性原理分析区块） | 否 |
| Phase 2 方案探索 | `/opsx:explore`                  | 讨论实现路径，输出多个候选方案+优缺点+推荐方案+决策理由；**候选方案四维对比矩阵交叉验证**；**确定测试 Seam** | `design.md`（含方案交叉验证矩阵 + 测试 Seam 决策区块 + 「可视化判定」小节；状态变动或流程变动命中时写 `change-model` 代码块，规则见 `../../openspec-change-overview/shared/change-model.md`） | 否 |
| 变更总览（按需） | `/opsx:overview`                 | 汇成文档地图、端到端流程、字段变更台账、规则条件可追溯矩阵；有变更模型时由脚本渲染前后对比图；由一个子 agent 整体生成，主会话只接收结论 | `overview.md`（派生视图，勿手改）；有变更模型时另生成 `overview.html` | 否 |
| 任务拆分 | `/opsx:propose`（生成 tasks artifact 时加载 `../../openspec-propose/shared/task-slicing.md`） | tasks.md 按垂直切片 + 阻塞 DAG 组织；发布前四问由用户确认 | `tasks.md`（切片结构，checkbox 兼容） | 否 |
| 产物检查（四个卡点） | `/opsx:propose`、`/opsx:update`、`/opsx:apply`、`/opsx:verify` 内置 | 先跑 STE 检查（禁用别名 / 非受控通用词 / 模糊词），再跑变更模型检查（CM-1～CM-6）；各卡点按退出码处理（`../../openspec-ste/shared/gate-check.md`）；archive 不重跑，靠 verify 的 CRITICAL 阻断 | 无独立产物；阻断项在对应卡点输出 | 否 |
| 分级判定 | 人工（参照下表）                         | 判断变更等级，决定跑哪些维度或直接豁免 | 记录在 `overview.md` 开头的分级行：L0 与 MVP 未命中信号由 propose / ff 收尾时写入，其他等级由 review 写入；走门禁时同时写入 `review-summary.md`（见 `gate-levels.md`「分级决策责任」） | 否 |
| Phase 3 技术评审门禁 | `/opsx:review`                   | 专项 Agent 并行评审已确定方案；**多角色多维度交叉验证（角色数按分级）** | `review/*.md` | 否 |
| Phase 4 评审确认 | 同上（汇总）                           | 汇总风险与修改建议，给出门禁裁决 | `review-summary.md` | 否 |
| 人工门禁 | 人工                               | 审阅评审结论，认可后写入批准标记 | `review-summary.md` 批准区 | 否 |
| Phase 5 代码实现 | `/opsx:apply`                    | 开始任何任务前依次做签字校验（`apply-gate-check.md`）、STE 检查、变更模型检查，任一项阻断即停止；按已评审通过的设计实现，不重新设计；**按切片实施 + TDD 纪律**（规则见 `../../openspec-apply-change/shared/tdd-discipline.md`）；**证据先于勾选**：每个切片记录绑定实现指纹的新鲜证据（规则见 `../../openspec-apply-change/shared/slice-evidence.md`） | 代码 + `evidence/slice-<id>.md` + `tasks.md` 勾选 | 是 |
| Phase 5.5 双轴独立评审 | `/opsx:quality`                  | 同一固定基线并行跑 Standards Review（工程规范）与 Spec Fidelity Review（规格忠实度），互不读取对方报告，汇总按任一轴未闭环 Blocker 阻断（规则见 `../../openspec-code-quality/shared/dual-axis-review.md`）；项目配置了 Sonar 时，最后用 SonarScanner 扫描，只处理本次修改行上的问题（`../../openspec-code-quality/shared/sonar-scan.md`）；**L2/L3 必跑，L0/L1 推荐** | `review/standards.md` + `review/spec-fidelity.md` + `review/code-review-summary.md`（+ `review/sonar.md`，配置 Sonar 时） | 否（只报告） |
| Phase 6 验证 | `/opsx:verify`                   | 三维校验（含实现与设计一致性）+ 条件核对 + 项目自有测试 + **切片证据新鲜度与双轴裁决核对**（见 `implementation-gate-check.md`）+ STE 检查与变更模型检查（阻断项记为 CRITICAL）；**实现与设计交叉核对**（门禁侧的条件核对与增强交叉核对清单见 `phase6-verification.md`） | `verification.md`（校验报告） | 修复项 |
| 收口 | `/opsx:archive`                  | 变更归档，能力沉淀进 specs（delta→main 由 skill `openspec-sync-specs` / `/opsx:sync` 执行，archive 调用；主 spec 有差异却跳过同步时需用户显式确认原因）；**归档前置校验**：签字缺失 / 未闭环 Blocker / verify 未通过 / MVP 与 L2/L3 双轴评审 Blocker 或报告缺失 / 切片证据缺失或过期时拒绝归档；评审、证据与讨论产物随变更整体归档；关联云舟任务时，归档后经用户确认完成任务（`../../openspec-archive-change/shared/yunzhou-task-completion.md`） | `openspec/specs/**` + `changes/archive/<name>/` | 否 |
| 讲解视频（按需，不进默认流程） | `/opsx:video`                    | 为含变更模型的变更选一个主题编写分镜，人工签署后渲染配音与中文字幕；不属于任何卡点或归档检查（规则见 `../../openspec-explainer-video/SKILL.md`） | `video/storyboard.md` + `video/explainer.srt`；`video/media/` 不进 git | 否 |

## 各阶段的输入与新会话

各阶段从文件读取输入时，可以在新会话中开始，不必在上一阶段的会话中继续。新会话不带上一阶段读过的文件与工具输出，上下文更小。下表的「能」只表示换会话不丢信息，在同一会话中连续执行也可以。

| 阶段 | 读取的输入 | 产出 | 能否在新会话中开始 |
|------|-----------|------|-------------------|
| grill | `CONTEXT.md`、`docs/adr/`、`proposal.md`（已有时）、`design.md`（已有时） | `CONTEXT.md`、`docs/adr/`、`discussion-log.md` | 能 |
| explore | 对话；有变更时读取产物 | 无。用户要求时才写入产物 | 否。explore 是与用户的讨论，在主会话中进行，不交给子 agent，避免讨论内容缺失导致方案偏离 |
| propose / ff | 用户需求、`discussion-log.md`（grill 写入时）、已完成的产物 | `proposal.md`、`design.md`、`specs/`、`tasks.md`、`overview.md`（L0 或 MVP 未命中信号时，只写分级行） | 能。grill 没有创建变更时，共识只在 grill 的会话中，propose 要在该会话中执行 |
| update | 修改依据与全部产物。修改依据大多来自刚才的讨论 | `proposal.md`、`design.md`、`specs/`、`tasks.md` | 通常不能，在讨论的会话中执行。修改依据已完整写在指令中时能（如「design 改为用 X」） |
| review | `proposal.md`、`design.md` | `review-summary.md`、`review/` | 能 |
| apply | `proposal.md`、`specs/`、`design.md`、`tasks.md`、`review-summary.md`（启用技术评审时） | 代码、`evidence/`、`tasks.md` | 能。新会话中写明变更名 |
| quality | 固定基线 diff、产物、`evidence/` | `review/standards.md`、`review/spec-fidelity.md`、`review/code-review-summary.md`、`review/sonar.md`（配置 Sonar 时） | 能 |
| verify | 产物、门禁脚本输出、`review-summary.md`（启用技术评审时）、`verification.md`（重跑时） | `verification.md` | 能 |
| archive | `verification.md`、门禁脚本输出、`review-summary.md`（启用技术评审时） | `openspec/specs/`、`openspec/changes/archive/` | 能。没有 `verification.md` 时拒绝归档 |
| overview | 全部产物（由子 agent 读取，主会话只接收结论） | `overview.md`、`overview.html`（有变更模型时） | 能 |

## 全景流程图

```
（存在未决决策时）/opsx:grill
      │  决策树分轮访谈：消除隐含假设 → 共识
      │  同步沉淀：CONTEXT.md（领域术语）+ docs/adr/（难以撤销的权衡决策）
      │  写入 discussion-log.md：共识摘要 + 查证子 agent 的回流结论
      ▼
OpenSpec Explore
      │  需求澄清（Phase 1）→ proposal.md
      │    ※ 第一性原理分析（表面需求 vs 底层问题 / 基本约束 / 必要性验证）
      │  方案探索（Phase 2）→ design.md（候选方案 + 推荐方案）
      │    ※ 交叉验证 I：候选方案四维对比矩阵（成本/性能/复杂度/风险）
      │    ※ 测试 Seam 决策区块：从哪些公共边界验证行为
      │    ※ 「可视化判定」小节；状态变动或流程变动命中时写 change-model 代码块
      ▼
技术方案确认（design.md 含推荐方案）
      │
      ├─ tasks.md 任务拆分：垂直切片 + 阻塞 DAG（`../../openspec-propose/shared/task-slicing.md`）
      │    ※ 每个切片端到端可演示，Blocked by 显式声明，用户四问确认后定稿
      │    ◆ 卡点①（/opsx:propose）：STE 检查 → 变更模型检查，退出码 0 才输出总结
      │
      ├─ /opsx:overview（按需）→ overview.md（文档地图 / 端到端流程 / 字段台账 / 条件矩阵）
      │                    + overview.html（有变更模型时）
      ▼
   【分级判定】L0 豁免 ──────────────────────────┐
      │ L1/L2/L3                                │
      ▼                                         │
┌──── Technical Review Gate（Phase 3，仍属 Explore，不写代码）────┐
│  ※ 交叉验证 II：纳入范围的角色并行评审同一方案（多维度互证）      │
│  架构 Agent   → review/architecture.md                        │
│  并发 Agent   → review/concurrency.md                         │
│  性能 Agent   → review/performance.md                         │
│  数据库 Agent → review/database.md                            │
│  安全 Agent   → review/security.md                            │
└────────────────────────────┬─────────────────────────────────┘
      ▼                                                        │
评审汇总（Phase 4）→ review-summary.md（门禁裁决 + 修改建议）      │
      │                                                        │
      ├─ BLOCKED ─→ /opsx:update 回改 design.md（留闭环记录；     │
      │             ◆ 卡点②：STE + 变更模型检查）─→ 重走门禁 ⟲    │
      │                                                        │
      ▼ READY_FOR_HUMAN_APPROVAL                               │
【人工确认评审结果】← 硬门禁：人工写入 "Technical Review Approved"  │
      ▼                                                        │
      ◄────────────────────────────────────────────────────────┘
OpenSpec Apply（Phase 5）→ 代码实现（Controller/Service/Repository/SQL/测试）
      │  ◆ 卡点③：签字校验 → STE 检查 → 变更模型检查，任一项阻断即停止，不开始任务
      │  ※ 按切片实施 + TDD 纪律：只在声明的 Seam 测试，red before green（`../../openspec-apply-change/shared/tdd-discipline.md`）
      │  ※ 证据先于勾选：evidence/slice-<id>.md 绑定实现指纹（`../../openspec-apply-change/shared/slice-evidence.md`）
      ▼
双轴独立评审（Phase 5.5）→ /opsx:quality（同一固定基线，两轴并行、互不读取）
      │  Standards Review      → review/standards.md
      │  Spec Fidelity Review  → review/spec-fidelity.md
      │  汇总裁决              → review/code-review-summary.md；任一轴未闭环 Blocker 不得归档
      │  Sonar 扫描（项目配置时）→ review/sonar.md；只处理本次修改行上的问题
      ▼
验证（Phase 6）→ /opsx:verify 三维校验 + 条件核对（读取 review-summary.md）+ 项目自有测试
      │  ※ 交叉验证 III：实现与设计交叉核对（Coherence 一致性校验）
      │  ※ 切片证据新鲜度 + 双轴裁决核对（`implementation-gate-check.md`）
      │  ◆ 卡点④：STE / 变更模型检查的阻断项记为 CRITICAL
      ▼
OpenSpec Archive → 归档前置阻断（`implementation-gate.mjs archive`）→ specs 沉淀能力；评审、证据与讨论产物随变更进 changes/archive/

旁路（不进默认流程，不参与任何卡点）：
  /opsx:explain → review/finding-details/<ID>.md（解析单个 finding）
  /opsx:video   → video/storyboard.md（人工签署）→ 渲染讲解视频（需要变更模型）
```

## 产物检查卡点

- **两项检查、同一套处理口径**：STE 检查（`../../openspec-ste/scripts/ste-lint.mjs check`）与变更模型检查（`../../openspec-change-overview/scripts/change-model.mjs check`）在 propose / update / apply / verify 四个卡点依次运行，退出码处理只以 `../../openspec-ste/shared/gate-check.md` 为准，本文不复制。
- **找不到脚本**：各卡点输出「已跳过 + 原因」后按卡点规则继续，不得静默跳过。
- **对话回复**：STE 规则对回复的约束见 `../../openspec-ste/shared/reply-rules.md`；只有 Claude Code 能用 Stop hook 阻断，需手动注册（`../../openspec-ste/SKILL.md`「对话回复检查」）。

## 实现阶段证据与双轴评审的边界

- **不追溯**：切片证据与双轴评审只对按新规则创建的变更生效（`tasks.md` 切片声明了 `Evidence:`，或已生成双轴评审产物；双轴评审还包括 `overview.md` 分级行为 MVP、L2、L3 的变更，分级行晚于双轴评审引入）；历史变更与历史 archive 不补造证据、不补跑双轴，校验脚本返回「不适用」及理由。
- **不外发**：Apply / Quality / Verify / Archive 的证据与评审动作都只在本地读写变更目录，**不自动执行 git push、创建 PR、部署、发布或云舟等外部任务回写**；这些动作需用户另行授权。

## 核心原则

- **需求未明确，不分析性能；方案未确定，不开始编码。**
- **质量保障理念：第一性原理（Phase 1 确保方向正确）+ 交叉验证（Phase 2/3/6 多维度互证）。**
