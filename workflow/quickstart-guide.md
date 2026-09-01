# OpenSpec 工作流 - 5分钟快速上手

> **🎯 目标**：让新手看完就能上手，不需要读完整文档

---

## 💡 三句话理解核心理念

```
1️⃣ 小改动直接改（L0豁免，不走流程）
2️⃣ 大改动先想清楚（先设计，再评审，最后写代码）
3️⃣ 改完让AI检查（门禁自动发现问题）
```

**记住这个顺序**：
```
需求澄清 → 方案设计 → 技术评审 → 代码实施 → 验证 → 归档
   ↓          ↓          ↓          ↓        ↓       ↓
proposal   design     review      代码    verify  archive
```

---

## 🚦 判断：我的变更要不要走门禁？

### 快速决策树

```
Q1: 只改文案/注释/配置/格式化？
    │
    ├─ 是 → L0豁免（直接改，记录豁免理由）
    │
    └─ 否 → Q2

Q2: 命中以下任一？
    • 异步/MQ/并发消费
    • 批量操作 ≥ 1万条
    • 新建表/改表结构
    • 对外网接口/用户上传
    • 租户隔离/权限/敏感数据
    │
    ├─ 是 → L3全量（5维度，4-8分钟，建议第二人复核）
    │
    └─ 否 → Q3

Q3: 命中以下任一？
    • 跨模块调用
    • 引入缓存
    • 新增业务流程
    │
    ├─ 是 → L2标准（4维度，3-6分钟）
    │
    └─ 否 → L1轻量（2维度，2-4分钟）
```

**判定口诀**：拿不准就升一级。

---

## 📖 完整示例：给用户表加昵称字段

### 场景

产品提需求："用户个人主页要显示昵称，请在用户表加一个 `nickname` 字段。"

---

### Step 1: 判断等级

**决策**：
- Q1: 只改文案/注释？→ 否（要加字段）
- Q2: 涉及MQ/大批量/表结构？→ 否（只是加一个字段，不改既有字段类型）
- Q3: 跨模块调用/缓存？→ 否（单表单字段）

**结论**：**L1轻量**（只跑 database + security，2-4分钟）

---

### Step 2: 需求澄清 + 方案探索

```bash
/openspec:explore add-user-nickname
```

**AI会问你问题**（你需要回答）：
- 昵称长度限制？→ 最多50个字符
- 允许重复吗？→ 允许
- 允许为空吗？→ 允许，默认显示用户名
- 需要审核吗？→ 不需要
- 有敏感词过滤吗？→ 前端已过滤，后端不再检查

**产出**：
- `openspec/changes/add-user-nickname/proposal.md`（需求澄清）
- `openspec/changes/add-user-nickname/design.md`（方案设计）

---

### Step 3: 技术评审门禁

```bash
/openspec:review add-user-nickname
```

**AI自动并行评审**（L1只跑2个维度）：
- Database Agent → 检查表结构、索引、字段类型
- Security Agent → 检查SQL注入、敏感数据

**墙钟耗时**：约 2-4 分钟（两个agent并行）

**产出**：
- `openspec/changes/add-user-nickname/review/database.md`
- `openspec/changes/add-user-nickname/review/security.md`
- `openspec/changes/add-user-nickname/review-summary.md`（汇总）

---

### Step 4: 查看评审结果

打开 `review-summary.md`，可能看到：

#### 场景A：通过（最理想）

```markdown
## 门禁裁决

✅ READY_FOR_HUMAN_APPROVAL

所有维度通过，无 Blocker。

## 下一步

人工确认后在本文档末尾写入：
Technical Review Approved: 你的名字  2026-08-23
```

**你的操作**：
1. 读完 `review-summary.md` 全文（确认没有遗漏）
2. 在末尾加一行：`Technical Review Approved: 张三  2026-08-23`
3. 保存

#### 场景B：有条件通过

```markdown
## 门禁裁决

⚠️ READY_FOR_HUMAN_APPROVAL (有条件)

## 有条件通过的条件清单

| 条件ID | 来源维度 | 条件内容 | 对应 tasks.md 任务 |
|--------|---------|---------|-------------------|
| C-01 | database | nickname 字段需加长度校验（max 50） | T-02 字段校验 |
```

**你的操作**：
1. 确认条件已映射到 `tasks.md`
2. 签字批准
3. 实施时必须完成这些条件

#### 场景C：BLOCKED（需要修改）

```markdown
## 门禁裁决

🚫 BLOCKED

## 未闭环 Blocker

| ID | 维度 | 问题 | 建议修复 |
|----|------|------|---------|
| DB-01 | database | nickname 字段未加索引，但有"按昵称搜索"需求 | 加索引：idx_nickname |
```

**你的操作**：
1. 回到 `design.md` 修改方案（加上索引设计）
2. 在 `design.md` 末尾填写**评审意见闭环记录**：

```markdown
## 评审意见闭环记录

| finding ID | 维度 | 原始问题 | 处理方式 | 落在 design 的哪一节 | 轮次 |
|-----------|------|---------|---------|-------------------|------|
| DB-01 | database | nickname 未加索引 | 增加索引：idx_nickname | §3.1 数据库设计 | R1 |
```

3. 重新跑门禁：`/openspec:review add-user-nickname --roles database`（只重跑被修改的维度）

---

### Step 5: 代码实施

**前置条件**：`review-summary.md` 已有人工签字

```bash
/openspec:apply add-user-nickname
```

**AI会做**：
- 生成数据库迁移脚本（DDL）
- 生成 Repository 代码
- 生成 Service 代码
- 生成 Controller 代码
- 生成单元测试
- 勾选 `tasks.md` 任务项

---

### Step 6: 代码质量评审（可选但推荐）

```bash
/openspec:quality add-user-nickname
```

**检查项**：
- 重复代码
- 可读性问题
- 死代码
- 复杂度过高
- 设计偏离

**产出**：`review/code-quality.md`（只报告，不改代码）

如果有 **未闭环 Blocker**，必须修复后才能归档。

---

### Step 7: 验证

```bash
/openspec:verify add-user-nickname
```

**三维校验**：
- Completeness：tasks.md 勾选是否完整
- Correctness：实现是否符合需求
- Coherence：实现是否偏离 design.md

**另外逐条核对条件**（如果 Step 4 有"有条件通过"）：
- 检查 C-01 的长度校验是否真的实现了

**有 CRITICAL 问题？** → 修复后重跑 `/openspec:verify`

---

### Step 8: 归档

```bash
/openspec:archive add-user-nickname
```

**做了什么**：
- 把 `changes/add-user-nickname/` 整体搬到 `changes/archive/`
- 能力沉淀进 `specs/`
- 评审文档随变更一起归档（不要手工删除）

---

## 🔥 8个高频FAQ

### Q1: 我改个字段也要跑五个Agent？

**A**: 不用。看分级：
- 加字段 → L1（只跑 database + security，2个Agent）
- 改字段类型 → L3（5个Agent）

---

### Q2: 门禁报了个Blocker但我认为是误报，被卡死了？

**A**: 两条逃生通道：
1. **误报**（问题不成立）→ 在 `review/<role>.md` 追加驳回记录
2. **risk accepted**（问题真实但不修）→ 追加 risk accepted 记录

**格式**：

```markdown
## 人工驳回记录

### DB-03 误报

- 驳回人：张三
- 驳回理由：该字段仅测试环境使用，生产不开放
- 驳回时间：2026-08-23
```

**重要**：不改 `design.md` 就不用重跑门禁。

---

### Q3: 门禁跑完了但我直接让Agent改代码，会被拦吗？

**A**: 不会。门禁只能拦正常路径（`/openspec:apply`），拦不住"直接让Agent用Edit改代码"。

**兜底靠什么**：PR review + CI。

---

### Q4: `/openspec:review` 提示缺 design.md？

**A**: 门禁前置校验要求 proposal.md 和 design.md 都存在。

**解决**：先回 `/openspec:explore` 补齐设计文档。

---

### Q5: 签字了但门禁裁决是 BLOCKED，能 apply 吗？

**A**: 不能。apply 的前置校验会拦。

**必须**：先闭环 Blocker 并重走门禁 → 变成 READY → 才能签字 → 才能 apply。

---

### Q6: 评审文档要提交git吗？开发完能删吗？

**A**: 
- ✅ 提交git
- ❌ 不删除

**理由**：
- 签字是责任凭证
- risk accepted 记录着复查触发点
- 归档时 `openspec archive` 会自动搬到 `changes/archive/<name>/`

---

### Q7: proposal / design / spec / tasks 四份文档太散，怎么确认规则条件没遗漏？

**A**: 跑一次：

```bash
/openspec:overview add-user-nickname
```

**产出**：`overview.md`，包含：
- 端到端运行流程图
- 字段变更台账
- 规则条件可追溯矩阵（合并四类来源）
- 标 `⚠️ 未落地` 的条目视同 Blocker

---

### Q8: Blocker写得全是术语，看不懂到底会出什么事？

**A**: 新版 finding 有9个字段（v2.0），必须包含：
- **一句话白话**：不得出现未解释的专有名词
- **触发场景**：必须可复现
- **不修的后果**：不写空话

**写不出具体触发场景的 Blocker 会被自动降级为 Major。**

如果仍然看不懂，可以生成详细解析：

```bash
/openspec:explain --finding DB-01
```

产出 `review/finding-details/DB-01.md`（完整业务场景 + 代码示例 + 实施指南）。

---

## 📚 下一步

### 想了解完整流程？

→ [OpenSpec-AI-研发流程.md](OpenSpec-AI-研发流程.md)（717行完整文档）

### 想了解新架构（方案设计）？

→ [OpenSpec 工作流对比](../docs/openspec-workflow-comparison.md)

### 想在团队推广？

→ [团队分享会演讲稿](../docs/team-sharing-speech.md)（15分钟PPT）

---

## 🎯 记住这三句话就够了

```
1️⃣ 小改动直接改（L0豁免）
2️⃣ 大改动先想清楚（先设计，再评审）
3️⃣ 改完让AI检查（门禁自动发现问题）
```

**还有问题？** 回到 [文档导航页](README.md) 找其他资源。
