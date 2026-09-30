# OpenSpec 研发流程 Phases 定义

> 状态路由由 coordinator 与 workflow 内置判定：本表与下图是能力地图，不是必跑顺序。L2/L3 检查决策充分性，不强制重复 grill；有待查事实才 explore，无阻断未知直接 propose/update。恢复时复核实际产物和批准版本，不从头覆盖。

## 各阶段职责与产物

| 阶段 | 入口                               | 做什么 | 产物 | 是否改代码 |
|------|----------------------------------|--------|------|-----------|
| Grill 访谈（按需入口） | `/opsx:grill`（仅未决项） | L2/L3 检查决策充分性，复用有效共识；同步沉淀领域术语与决策 | 共识 + `CONTEXT.md` + `docs/adr/`（项目级，不随变更归档） | 否 |
| Phase 1 需求澄清 | `/opsx:explore`                  | 明确业务目标、边界、输入输出、数据规模、性能指标、兼容/安全要求；**应用第一性原理分析** | `proposal.md`（含第一性原理分析区块） | 否 |
| Phase 2 方案探索 | `/opsx:explore`                  | 讨论实现路径，输出多个候选方案+优缺点+推荐方案+决策理由；**候选方案四维对比矩阵交叉验证**；**确定测试 Seam** | `design.md`（含方案交叉验证矩阵 + 测试 Seam 决策区块） | 否 |
| （贯穿 1–2）讨论回流 | skill `openspec-discussion-sync` | 子 agent 按五段契约返回，主 agent 逐条落盘或记未采纳 | `discussion-log.md` | 否 |
| 变更总览 | `/opsx:overview`                 | 汇成文档地图、端到端流程、字段变更台账、规则条件可追溯矩阵 | `overview.md`（派生视图，勿手改） | 否 |
| 任务拆分 | `/opsx:propose`（生成 tasks artifact 时加载 `../../openspec-propose/shared/task-slicing.md`） | tasks.md 按垂直切片 + 阻塞 DAG 组织；发布前三问由用户确认 | `tasks.md`（切片结构，checkbox 兼容） | 否 |
| 分级判定 | 人工（参照下表）                         | 判断变更等级，决定跑哪些维度或直接豁免 | 记录在 `review-summary.md` | 否 |
| Phase 3 技术评审门禁 | `/opsx:review`                   | 专项 Agent 并行评审已确定方案；**多角色多维度交叉验证（角色数按分级）** | `review/*.md` | 否 |
| Phase 4 评审确认 | 同上（汇总）                           | 汇总风险与修改建议，给出门禁裁决 | `review-summary.md` | 否 |
| 人工门禁 | 人工                               | 审阅评审结论，认可后写入批准标记 | `review-summary.md` 批准区 | 否 |
| Phase 5 代码实现 | `/opsx:apply`                    | 按已评审通过的设计实现，不重新设计；**按切片实施 + TDD 纪律**（规则见 `../../openspec-apply-change/shared/tdd-discipline.md`）；**证据先于勾选**：每个切片记录绑定实现指纹的新鲜证据（规则见 `../../openspec-apply-change/shared/slice-evidence.md`） | 代码 + `evidence/slice-<id>.md` + `tasks.md` 勾选 | 是 |
| Phase 5.5 双轴独立评审 | `/opsx:quality`                  | 同一固定基线并行跑 Standards Review（工程规范）与 Spec Fidelity Review（规格忠实度），互不读取对方报告，汇总按任一轴未闭环 Blocker 阻断（规则见 `../../openspec-code-quality/shared/dual-axis-review.md`） | `review/standards.md` + `review/spec-fidelity.md` + `review/code-review-summary.md` | 否（只报告） |
| Phase 6 验证 | `/opsx:verify`                   | 三维校验（含实现与设计一致性）+ 条件核对 + 项目自有测试 + **切片证据新鲜度与双轴裁决核对**（见 `implementation-gate-check.md`）；**实现与设计交叉核对**（门禁侧的条件核对与增强交叉核对清单见 `phase6-verification.md`） | 校验报告（对话内） | 修复项 |
| 收口 | `/opsx:archive`                  | 变更归档，能力沉淀进 specs（delta→main 由 skill `openspec-sync-specs` / `/opsx:sync` 执行，archive 调用；主 spec 有差异却跳过同步时需用户显式确认原因）；**归档前置校验**：签字缺失 / 未闭环 Blocker / verify 未通过 / 双轴评审 Blocker / 切片证据缺失或过期时拒绝归档；评审、证据与讨论产物随变更整体归档 | `openspec/specs/**` + `changes/archive/<name>/` | 否 |

## 全景流程图

```
（存在未决决策时）/opsx:grill
      │  决策树分轮访谈：消除隐含假设 → 共识
      │  同步沉淀：CONTEXT.md（领域术语）+ docs/adr/（难以撤销的权衡决策）
      ▼
OpenSpec Explore
      │  需求澄清（Phase 1）→ proposal.md
      │    ※ 第一性原理分析（表面需求 vs 底层问题 / 基本约束 / 必要性验证）
      │  方案探索（Phase 2）→ design.md（候选方案 + 推荐方案）
      │    ※ 交叉验证 I：候选方案四维对比矩阵（成本/性能/复杂度/风险）
      │    ※ 测试 Seam 决策区块：从哪些公共边界验证行为
      │  ※ 子 agent 讨论结论回流 → discussion-log.md（贯穿 Phase 1–2）
      ▼
技术方案确认（design.md 含推荐方案）
      │
      ├─ tasks.md 任务拆分：垂直切片 + 阻塞 DAG（`../../openspec-propose/shared/task-slicing.md`）
      │    ※ 每个切片端到端可演示，Blocked by 显式声明，用户三问确认后定稿
      │
      ├─ /opsx:overview → overview.md（文档地图 / 端到端流程 / 字段台账 / 条件矩阵）
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
      ├─ BLOCKED ─→ 回改 design.md（留闭环记录）─→ 重走门禁 ⟲     │
      │                                                        │
      ▼ READY_FOR_HUMAN_APPROVAL                               │
【人工确认评审结果】← 硬门禁：人工写入 "Technical Review Approved"  │
      ▼                                                        │
      ◄────────────────────────────────────────────────────────┘
OpenSpec Apply（Phase 5）→ 代码实现（Controller/Service/Repository/SQL/测试）
      │  ※ 按切片实施 + TDD 纪律：只在声明的 Seam 测试，red before green（`../../openspec-apply-change/shared/tdd-discipline.md`）
      │  ※ 证据先于勾选：evidence/slice-<id>.md 绑定实现指纹（`../../openspec-apply-change/shared/slice-evidence.md`）
      ▼
双轴独立评审（Phase 5.5）→ /opsx:quality（同一固定基线，两轴并行、互不读取）
      │  Standards Review      → review/standards.md
      │  Spec Fidelity Review  → review/spec-fidelity.md
      │  汇总裁决              → review/code-review-summary.md；任一轴未闭环 Blocker 不得归档
      ▼
验证（Phase 6）→ /opsx:verify 三维校验 + 条件核对（用 overview.md 条件矩阵）+ 项目自有测试
      │  ※ 交叉验证 III：实现与设计交叉核对（Coherence 一致性校验）
      │  ※ 切片证据新鲜度 + 双轴裁决核对（`implementation-gate-check.md`）
      ▼
OpenSpec Archive → 归档前置阻断（`implementation-gate.mjs archive`）→ specs 沉淀能力；评审、证据与讨论产物随变更进 changes/archive/
```

## 实现阶段证据与双轴评审的边界

- **不追溯**：切片证据与双轴评审只对按新规则创建的变更生效（`tasks.md` 切片声明了 `Evidence:`，或已生成双轴评审产物）；历史变更与历史 archive 不补造证据、不补跑双轴，校验脚本返回「不适用」及理由。
- **不外发**：Apply / Quality / Verify / Archive 的证据与评审动作都只在本地读写变更目录，**不自动执行 git push、创建 PR、部署、发布或云舟等外部任务回写**；这些动作需用户另行授权。

## 核心原则

- **需求未明确，不分析性能；方案未确定，不开始编码。**
- **质量保障理念：第一性原理（Phase 1 确保方向正确）+ 交叉验证（Phase 2/3/6 多维度互证）。**
