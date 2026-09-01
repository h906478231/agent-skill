# OpenSpec 工作流文档导航

> **🎯 你想做什么？选择对应的入口**

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

**直达** → [OpenSpec 工作流对比](../docs/openspec-workflow-comparison.md)

**内容**：
- Phase 1: 需求澄清（第一性原理分析）
- Phase 2: 方案探索（候选方案交叉验证）
- Phase 3: 任务拆解（验收标准）
- 详细流程图见 [openspec-workflow-diagrams.md](../docs/openspec-workflow-diagrams.md)

**适合**：
- ✅ 只需要方案设计，不需要实施
- ✅ 需要深度思考和方案对比
- ✅ 通用技术方案（不限于编码项目）

**使用工具**：`openspec-architect`（三层职责分离架构）

---

## 🏗️ 我要完整研发流程（需求 → 评审 → 实施 → 验证 → 归档）

**直达** → [OpenSpec-AI-研发流程.md](OpenSpec-AI-研发流程.md)

**内容**：
- Phase 1-6 完整端到端流程
- 技术评审门禁（5角色并行评审）
- 分级门禁（L0/L1/L2/L3）
- 人工签字与闭环验证
- 代码质量评审与验证

**适合**：
- ✅ 企业级项目，需要完整流程
- ✅ 需要技术评审门禁（架构/并发/性能/数据库/安全）
- ✅ 需要人工签字和责任追溯

**使用工具**：`/openspec:*` 命令（openspec-explore / openspec-review / openspec-apply 等）

---

## 🔧 工具速查

| 工具/命令 | 用途 | 所属流程 |
|---------|------|---------|
| `openspec-architect` | 方案设计（Phase 1-3） | 新架构 |
| `/openspec:explore` | 需求澄清 + 方案探索 | 完整流程 |
| `/openspec:review` | 技术评审门禁（5角色） | 完整流程 |
| `/openspec:apply` | 代码实施 | 完整流程 |
| `/openspec:quality` | 代码质量评审 | 完整流程 |
| `/openspec:verify` | 验证（三维校验） | 完整流程 |
| `/openspec:archive` | 归档 | 完整流程 |

---

## 📚 进阶阅读

### 两个流程的关系

**可以组合使用**：
1. 用新架构做需求和方案（Phase 1-3）→ 产出 proposal.md + design.md + tasks.md
2. 用完整流程做评审和实施（Phase 3-6）→ 技术评审 + 代码实施 + 验证 + 归档

详见：[OpenSpec 工作流对比](../docs/openspec-workflow-comparison.md)

---

## 💬 团队分享

如果要在团队内推广，可以参考：[团队分享会演讲稿](../docs/team-sharing-speech.md)（15分钟，轻松实用）

---

## ❓ 仍然不知道从哪开始？

**问自己这个问题**：

```
我现在要做的事情是？
  │
  ├─ 只是改个小东西（文案/字段/配置）
  │  └─ 直接改，不用走流程
  │
  ├─ 想清楚一个技术方案该怎么做
  │  └─ 用新架构（openspec-architect）
  │
  └─ 完整的项目开发，从需求到上线
     └─ 用完整流程（/openspec:*）
```

**还是不确定？** 先看 [5分钟快速上手指南](quickstart-guide.md)，看完自然就知道了。
