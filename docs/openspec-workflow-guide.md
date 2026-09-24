# OpenSpec 工作流选择指南

当你面对一个需求或问题时，应该用 `/openspec-explore` 还是 `/openspec-grill`？

本文档帮助你快速判断。

---

## 快速决策树

```text
                需求/问题出现
                     │
                     ▼
            ┌────────────────┐
            │ 方案想清楚了吗？│
            └────┬────────┬──┘
                 NO      YES
                 │        │
                 ▼        ▼
         /openspec-explore  ┌─────────────────┐
                           │ 是否高风险变更？  │
                           └────┬────────┬────┘
                               YES      NO
                                │        │
                                ▼        ▼
                      /openspec-grill  直接propose
                                │
                      ┌─────────┴─────────┐
                      │                   │
                      ▼                   ▼
                 通过Grill            拒绝Grill
                      │                   │
                      ▼                   ▼
                  propose            回到explore
```

---

## 两者的本质区别

### openspec-explore：思考伙伴

```text
定位：自由模式的设计探索
目标：想清楚要做什么、怎么做
输出：proposal.md + design.md

特点：
  ✓ 没有固定问题清单
  ✓ 不强制产出格式
  ✓ 可以随时切换方向
  ✓ 思考过程就是价值
```

### openspec-grill：质疑者

```text
定位：决策树访谈 + 假设验证
目标：消除隐含假设、识别遗漏风险
输出：discussion-log.md + CONTEXT.md + ADR

特点：
  ✓ 有明确的决策树
  ✓ 分轮清空frontier
  ✓ 强制区分事实vs决策
  ✓ 沉淀领域资产
```

---

## 详细判断标准

### 场景1: 需求刚出现，还没想清楚

| 问题 | 回答 | 应该用 |
|------|------|--------|
| 需求是什么？ | 不清楚 | explore |
| 有哪些方案？ | 没想过 | explore |
| 推荐哪个？ | 不知道 | explore |

**示例**：
```text
用户：我想做个Agent功能
你：用什么模型？做哪些能力？怎么保证权限隔离？
→ /openspec-explore
```

---

### 场景2: 方案已确定，准备实施

| 问题 | 回答 | 应该用 |
|------|------|--------|
| 方案定了吗？ | 定了 | 看风险等级 |
| 是否L2/L3？ | 是 | grill |
| 是否BREAKING？ | 是 | grill |
| 影响范围？ | 单模块/L0/L1 | 可选grill |

**示例**：
```text
设计：streaming replies已经写好了design.md
风险：L2（跨运行时、HTTP、UI）
→ /openspec-grill（强制）
```

---

### 场景3: 设计到一半发现问题

| 问题 | 回答 | 应该用 |
|------|------|--------|
| 是技术事实问题？ | 是 | explore |
| 是方向性问题？ | 是 | explore |
| 是假设验证问题？ | 是 | grill |

**示例**：
```text
情况1：做到一半发现单表扛不住
→ 回到 /openspec-explore 重新设计

情况2：设计完成，但"用户平均输入50字"这个假设没验证
→ /openspec-grill 验证假设
```

---

### 场景4: 多个技术方案不知道选哪个

```text
这是典型的explore场景：
  1. 列出候选方案（至少3个，含MVP）
  2. 四维对比（成本/性能/复杂度/风险）
  3. 推荐方案并说明理由
  
→ /openspec-explore
```

---

## 风险等级 → Grill强制性映射

| 等级 | 定义 | Grill要求 | 示例 |
|------|------|-----------|------|
| L3 | 核心变更，影响认证/授权/隔离 | **强制** | 认证流程、会话隔离 |
| L2 | 跨域变更，涉及HTTP契约/多模块 | **强制** | streaming replies、跨模块协议 |
| L1 | 单模块变更，不涉及外部接口 | 可选 | 内部重构、工具函数 |
| L0 | 文档/配置 | 不需要 | README更新、配置调整 |

**BREAKING变更无论等级，都强制Grill。**

---

## 实战案例对照

### 案例A: add-agent-streaming-replies

```text
阶段1: 需求出现
  用户：想要流式输出
  → /openspec-explore
  产出：proposal.md（第一性原理分析）

阶段2: 方案探索
  → 继续 /openspec-explore
  产出：design.md（3个候选方案对比）

阶段3: 实施前验证
  风险等级：L2
  → /openspec-grill（应该强制，但被跳过了）
  实际：用户直接授权实施
  后果：5个假设未验证（H1-H5）
```

**正确流程应该是**：
```text
explore → grill（完成访谈） → 通过门禁 → propose → 实施
```

---

### 案例B: cleanup-agent-documentation

```text
需求：整理文档，减少重复
风险等级：L0（纯文档）
是否需要grill：不需要

流程：
  /openspec-explore（分析文档结构）
  → 直接 propose
  → 实施
```

---

### 案例C: separate-agent-conversations-and-business-tasks

```text
需求：会话与任务分离
风险等级：L3（改变身份关联、确认路由）
BREAKING：是

流程：
  /openspec-explore（设计分离方案）
  → /openspec-grill（验证假设）✓ 应该做
  → 通过门禁
  → propose
  → 实施
```

**实际情况**：看起来没有独立的grill change，可能在explore中完成了假设验证。

---

## 两者的协作模式

### 模式1: 串行（推荐）

```text
explore → grill → propose → 实施
  ↓        ↓
产出方案  验证假设
```

**适用于**: L2/L3变更、BREAKING变更

---

### 模式2: 迭代

```text
explore → grill → 发现问题 → 回到explore修改 → 再grill
```

**适用于**: 复杂变更，第一次设计可能不完善

---

### 模式3: 跳过grill（仅限低风险）

```text
explore → propose → 实施
```

**适用于**: L0/L1变更、内部重构

---

## Grill的具体产出

很多人以为grill会产出 `grill-<name>/proposal.md`，但实际不是：

### 实际产出位置

```text
grill-<name>/
└── discussion-log.md  ← 访谈记录

项目根/
├── CONTEXT.md         ← 领域术语（跨变更复用）
└── docs/adr/          ← 重大决策（跨变更复用）
    └── 0001-xxx.md
```

### discussion-log.md 必须包含

```markdown
## Grill总结

### ✓ 已验证的假设
- 假设1: XXX [证据]

### ✗ 未验证的假设
- 假设2: XXX [风险等级]

### 建议行动
1. 立即修复（阻塞实施）
2. 发布前修复（不阻塞开发）

### Grill门禁决策
- 状态: ✓ 通过 / ✗ 拒绝 / ⚠️ 附加条件
- 签字: [执行人]
- 日期: [YYYY-MM-DD]
```

---

## 常见误区

### 误区1: "我已经想清楚了，不需要explore"

❌ 错误思维：
```text
我心里有答案 → 直接写design.md
```

✅ 正确流程：
```text
我心里有答案 → /openspec-explore（可能发现新视角）
→ 调整方案或确认方案 → design.md
```

**explore不是"想不清楚才用"，而是"帮助想得更清楚"。**

---

### 误区2: "grill就是写验证文档"

❌ 错误理解：
```text
grill = 写一堆测试用例和边界场景
```

✅ 正确理解：
```text
grill = 决策树访谈 + 消除隐含假设 + 沉淀领域资产

不是你写什么，而是你问了什么、用户回答了什么
```

---

### 误区3: "低风险变更不需要explore，直接写代码"

❌ 危险思维：
```text
改个配置 → 直接改 → 提交
```

✅ 推荐流程：
```text
改个配置 → 想清楚影响范围 → 简单explore或直接propose → 改 → 提交
```

**即使是L0变更，也建议过一遍思考流程。**

---

## 实用检查清单

### Explore结束检查

在结束explore之前，确认：
- [ ] 问题的根本原因清楚了吗？（第一性原理）
- [ ] 至少有3个候选方案吗？（含MVP）
- [ ] 做了四维对比吗？（成本/性能/复杂度/风险）
- [ ] 推荐方案有理由吗？（为什么不选其他）
- [ ] 可以写proposal.md和design.md了吗？

---

### Grill结束检查

在结束grill之前，确认：
- [ ] Q1-Q3的关键决策都回答了吗？
- [ ] 识别的假设都验证了吗？
- [ ] HIGH风险假设都有测试计划吗？
- [ ] discussion-log.md有Grill总结吗？
- [ ] 需要的术语写入CONTEXT.md了吗？
- [ ] 需要的ADR创建了吗？

---

## 快速参考卡片

打印或收藏这个决策表：

| 问题 | 回答 | 用什么 |
|------|------|--------|
| 需求不清楚 | 是 | explore |
| 方案未确定 | 是 | explore |
| 需要对比方案 | 是 | explore |
| 设计已完成 | 是 | 看风险 ↓ |
| 是L2/L3吗 | 是 | grill（强制） |
| 是BREAKING吗 | 是 | grill（强制） |
| 有隐含假设吗 | 是 | grill |
| 风险LOW | 是 | 直接propose |

---

## 总结

记住这三句话：

1. **explore 帮你想清楚方案**
2. **grill 帮你验证假设**
3. **低风险跳过grill，高风险强制grill**

当你不确定时，问自己：
- "我现在是在想方案，还是在验证假设？"
- "这个变更如果出错，影响有多大？"

根据答案选择工具。

---

最后更新：2026-09-23
维护者：lokra团队
