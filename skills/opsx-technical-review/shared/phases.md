# OpenSpec 研发流程 Phases 定义

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

## 全景流程图

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

## 核心原则

- **需求未明确，不分析性能；方案未确定，不开始编码。**
- **质量保障理念：第一性原理（Phase 1 确保方向正确）+ 交叉验证（Phase 2/3/6 多维度互证）。**
