# OpenSpec 工作流文档导航

> **🎯 你想做什么？选择对应的入口**

---

## 🧭 先看这个：主流程与副流程

**主流程（每次变更都跑）**

```text
explore → propose（含 tasks） → 分级判定 → （纳入范围时）review + 人工签字 → apply → quality → verify → archive
```

**副流程（按需触发，不进默认路径）**

| 副流程 | 什么时候用 |
|--------|-----------|
| `/opsx:grill` | 存在未决决策，需要分轮访谈消除假设（L2/L3 检查决策充分性，有共识只问未决项） |
| `/opsx:overview` | 字段或规则条件较多的变更（L2/L3）需要一页看懂流程与条件矩阵 |
| `/opsx:explain` | 看不明白某个 Blocker，需要展开业务场景 |
| `/opsx:video` | 需要向他人讲解含变更模型的变更 |
| 讨论回流（skill `openspec-discussion-sync`，无独立命令） | grill 派查证子 agent 后，把结论按五段契约回流并落盘；explore 不派子 agent |

拿不准该用 `/opsx:explore` 还是 `/opsx:grill`？见 [工作流选择指南](../docs/openspec-workflow-guide.md)。

**按等级选路径**

| 等级 | 典型变更 | 你要跑的 |
|------|---------|---------|
| L0 | 纯文案/注释/配置值/格式化/纯测试补充 | 直接改代码，不必为留痕单独建变更目录；已在 OpenSpec 里的变更在 `overview.md` 写一行豁免理由，不创建 `review-summary.md` |
| L1 | 单表单接口 CRUD、新增非核心字段、既有能力小范围扩展 | 主流程；编码前评审 2 维（database + security）；双轴评审推荐 |
| L2 | 新增业务流程、跨模块调用、引入缓存、批量操作 | 主流程；编码前评审 4 维（+ architecture + performance）；双轴评审必需 |
| L3 | MQ/异步、并发消费、分布式一致性、状态机、大数据量、新建核心表、对外开放接口 | 主流程；编码前评审 5 维全跑，建议第二人复核；双轴评审必需 |

拿不准就升一级。分级规则与信号清单的正式定义见 [OpenSpec-AI-研发流程.md](OpenSpec-AI-研发流程.md)「🚦 门禁适用范围分级」。

---

## 📖 我是新手，第一次使用

**直达** → [5分钟快速上手指南](quickstart-guide.md)

**内容**：
- 三句话理解核心理念
- 3个问题判断你的变更类型
- 完整示例：给用户表加字段
- 8个高频FAQ

**适合**：
- ✅ 第一次接触 OpenSpec
- ✅ 只想快速上手，不关心原理
- ✅ 遇到问题需要快速查答案

---

## 🎨 我要做方案设计（需求澄清 + 方案探索）

**直达** → [OpenSpec-AI-研发流程.md](OpenSpec-AI-研发流程.md) 第二部分「📐 Phase 1: 需求澄清」「📐 Phase 2: 方案探索」

**内容**：
- Phase 1: 需求澄清（第一性原理分析）
- Phase 2: 方案探索（候选方案交叉验证）
- Phase 3: 任务拆解（验收标准）
- 全景流程图见 [OpenSpec-AI-研发流程.md](OpenSpec-AI-研发流程.md) 的「🗺️ 全景流程」；各阶段职责与产物见同文档「📊 各阶段职责与产物」

**适合**：
- ✅ 只需要方案设计，不需要实施
- ✅ 需要深度思考和方案对比
- ✅ 通用技术方案（不限于编码项目）

**使用工具**：`/opsx:propose`（生成 proposal / design / specs / tasks）；决策未定时先用 `/opsx:grill`

---

## 🏗️ 我要完整研发流程（需求 → 评审 → 实施 → 验证 → 归档）

**直达** → [OpenSpec-AI-研发流程.md](OpenSpec-AI-研发流程.md)

**内容**：
- Phase 1-6 完整端到端流程
- 技术评审门禁（5角色并行评审）
- 分级门禁（L0/L1/L2/L3）
- 人工签字与闭环验证
- 双轴独立评审与验证
- 产物检查卡点（STE 检查、变更模型检查）

**适合**：
- ✅ 企业级项目，需要完整流程
- ✅ 需要技术评审门禁（架构/并发/性能/数据库/安全）
- ✅ 需要人工签字和责任追溯

**使用工具**：`/opsx:*` 命令（`/opsx:explore` / `/opsx:review` / `/opsx:apply` 等）

---

## 🔧 工具速查

| 工具/命令 | 用途 | 所属流程 |
|---------|------|---------|
| `/opsx:grill` | 决策访谈（消除隐含假设、沉淀 CONTEXT.md / ADR） | 完整流程 |
| `/opsx:explore` | 需求澄清 + 方案探索 | 完整流程 |
| `/opsx:propose` | 生成 proposal / design / specs / tasks；产物写完后跑 STE 与变更模型检查 | 完整流程 |
| `/opsx:update` | 修改已有产物；写入后跑 STE 与变更模型检查 | 完整流程 |
| `/opsx:overview` | 变更总览（有变更模型时另生成 overview.html） | 按需（L2/L3 推荐） |
| `/opsx:review` | 技术评审门禁（多角色） | 完整流程 |
| `/opsx:apply` | 代码实施；开始前校验签字、STE、变更模型 | 完整流程 |
| `/opsx:quality` | 双轴独立评审（Standards + Spec Fidelity） | 完整流程 |
| `/opsx:verify` | 验证（三维校验 + 证据 + 双轴裁决 + STE / 变更模型检查） | 完整流程 |
| `/opsx:archive` | 归档 | 完整流程 |
| `/opsx:explain` | 解析单个 finding | 按需 |
| `/opsx:video` | 讲解视频（人工签署分镜后渲染） | 按需 |

---

## 📚 进阶阅读

### 两个阶段的衔接

**推荐组合使用**：
1. 先用 `/opsx:grill` + `/opsx:explore` 澄清决策与关键未知
2. 再用 `/opsx:propose` 生成 proposal.md + design.md + specs + tasks.md
3. 然后走门禁与交付：`/opsx:review` → `/opsx:apply` → `/opsx:quality` → `/opsx:verify` → `/opsx:archive`

详见：[OpenSpec-AI-研发流程.md](OpenSpec-AI-研发流程.md)

---

## 💬 团队分享

如果要在团队内推广，可以参考：[团队分享会演讲稿](演讲-从一问一答到工程化工作流.md)

---

## ❓ 仍然不知道从哪开始？

**问自己这个问题**：

```
我现在要做的事情是？
  │
  ├─ 纯文案 / 注释 / 配置值 / 格式化 / 纯测试补充
  │  └─ L0：直接改，写一行豁免理由（不创建 review-summary.md）
  │
  ├─ 单表 / 单接口 / 非核心字段
  │  └─ L1：走主流程，编码前 2 维评审
  │
  ├─ 跨模块 / 引入缓存 / 新业务流程
  │  └─ L2：走主流程，编码前 4 维评审
  │
  ├─ MQ / 并发 / 状态机 / 对外接口 / 新建核心表
  │  └─ L3：走主流程，5 维评审 + 建议第二人复核
  │
  └─ 只想先想清楚方案，暂不实施
     └─ /opsx:propose（产出 proposal / design / specs / tasks）
```

**还是不确定？** 先看 [5分钟快速上手指南](quickstart-guide.md)，看完自然就知道了。
