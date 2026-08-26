---
name: opsx-finding-explain
description: 为技术评审的 finding 生成详细的业务场景解析文档。输入 finding ID 或整个 review-summary.md，输出包含业务场景、代码示例、算法细节、实施步骤的详细说明文档（finding-details.md）。用于实施阶段需要深入理解技术方案时，或向团队成员解释复杂的技术问题时。支持单个 finding 展开或批量展开。
---

# Finding 详细解析生成器（opsx-finding-explain）

## 定位

这是技术评审的**后置工具**，在评审完成、需要实施修复时使用。

**核心问题**：技术评审产出的 finding 表格虽然有 9 个字段（含业务影响、代码模块），但单元格空间有限，无法展开详细说明。实施人员需要：
- 完整的业务场景描述（不只是一句话）
- 代码级别的实现示例（SQL、伪代码）
- 算法细节（状态机图、时序图）
- 分步骤的实施指南

本 skill 读取 `review-summary.md` 或单个维度的 `review/<role>.md`，为指定的 finding 生成详细解析文档。

```
技术评审（/opsx:review）
    ↓ 产出 review-summary.md
    ↓ 包含 finding 表格（9 字段）
    ↓
【人工确认】发现某些 finding 需要详细说明
    ↓
/opsx:explain --finding CONC-02      ← 本 skill
    ↓ 或
/opsx:explain --all-blockers          ← 展开所有 Blocker
    ↓
产出 review/finding-details/CONC-02.md
```

## 使用场景

### 场景 1：单个复杂 finding 需要展开
```bash
# 开发看到 CONC-02 "引入 fencing token 机制"，不知道具体怎么做
/opsx:explain --finding CONC-02
```

产出 `review/finding-details/CONC-02.md`，包含：
- 完整的业务场景（不只是"同一幂等键产生两条素材"）
- 时序图（节点 A、B 的交互）
- 代码实现示例（SQL、Java/TypeScript）
- 分步骤实施指南

### 场景 2：批量展开所有 Blocker
```bash
# 技术评审后，需要给团队讲解所有 Blocker
/opsx:explain --all-blockers
```

产出：
- `review/finding-details/CONC-02.md`
- `review/finding-details/CONC-03.md`
- `review/finding-details/SEC-01.md`
- `review/finding-details-summary.md`（汇总文档，包含目录）

### 场景 3：向非技术人员解释
```bash
# 需要向产品经理解释为什么这个问题严重
/opsx:explain --finding SEC-01 --audience non-tech
```

产出的文档会：
- 减少技术术语
- 增加业务类比（如"就像两个人同时取同一笔钱"）
- 强调业务影响而非技术细节

## 前置条件

1. 变更必须已完成技术评审，存在 `review-summary.md` 或 `review/<role>.md`
2. 指定的 finding ID 必须在评审文档中存在

## 执行步骤

### Step 1 — 解析输入参数

支持三种模式：

| 参数 | 说明 | 示例 |
|------|------|------|
| `--finding <ID>` | 展开单个 finding | `--finding CONC-02` |
| `--all-blockers` | 展开所有 Blocker 级别的 finding | - |
| `--all` | 展开所有 finding（包括 Major、Minor） | - |
| `--audience <type>` | 目标读者类型（默认 tech） | `--audience non-tech` |

**audience 类型**：
- `tech`（默认）：面向开发工程师，包含代码示例、算法细节
- `non-tech`：面向产品/项目经理，减少技术术语，强调业务影响
- `new-dev`：面向新人开发，增加背景知识、概念解释

### Step 2 — 读取 finding 信息

1. 读取 `review-summary.md` 的"已确认风险详细清单"区块
2. 找到指定 finding ID 的完整 9 字段信息：
   - ID、严重级别、影响业务功能、位置
   - 涉及代码模块、一句话白话、触发场景
   - 不修的后果、建议修复
3. 读取对应维度的详细评审文档（如 `review/concurrency.md`），获取更多上下文
4. 读取 `design.md` 中 finding 位置指向的章节

### Step 3 — 生成详细解析文档

为每个 finding 生成独立的 markdown 文档，结构如下：

```markdown
# Finding 详细解析：<ID> - <一句话白话>

## 基本信息

| 字段 | 内容 |
|------|------|
| Finding ID | CONC-02 |
| 严重级别 | Blocker |
| 影响业务功能 | 素材上传 |
| 评审维度 | 并发 |
| 涉及代码模块 | MaterialUploadService.submitMaterial、idempotency_record 表 |

## 业务场景完整描述

### 功能背景
<说明这个功能是做什么的，在整个系统中的位置>

### 问题场景
<用完整的段落描述问题，不只是一句话>
<包含：谁、在什么情况下、做什么操作、会发生什么>

### 时序图 / 状态机图
<用 mermaid 或文字描述关键的时序/状态转换>

## 技术问题深入分析

### 根本原因
<为什么会出现这个问题？哪个设计假设被违反了？>

### 触发条件详解
<展开 finding 表格中的"触发场景"，给出更多细节>
<如果有多种触发路径，列举所有路径>

### 影响面分析
<展开"不修的后果"，分析对业务、用户、系统的影响>
<量化影响：频率、影响用户数、数据量>

## 解决方案详解

### 设计思路
<为什么选择这个方案？有哪些备选方案被否决？>

### 核心机制
<解释关键的技术机制，如 fencing token、CAS、状态机>
<给出算法伪代码或流程图>

### 代码实现示例

#### 数据库结构变更
\`\`\`sql
-- 变更前
CREATE TABLE idempotency_record (
  idempotency_key VARCHAR(64) PRIMARY KEY,
  status ENUM('PROCESSING', 'SUCCESS', 'FAILED'),
  created_at TIMESTAMP
);

-- 变更后
CREATE TABLE idempotency_record (
  idempotency_key VARCHAR(64) PRIMARY KEY,
  status ENUM('PROCESSING', 'SUCCESS', 'FAILED'),
  owner VARCHAR(64) DEFAULT NULL,           -- 新增：当前租约持有者
  fencing_token BIGINT NOT NULL DEFAULT 0,  -- 新增：单调递增版本号
  lease_expire_at TIMESTAMP NULL,           -- 新增：租约过期时间
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
\`\`\`

#### 代码逻辑变更

**变更前**：
\`\`\`typescript
async submitMaterial(idempotencyKey: string, materialData: any) {
  const record = await db.query(
    'SELECT status FROM idempotency_record WHERE idempotency_key = ?',
    [idempotencyKey]
  );
  
  if (record.status === 'SUCCESS') {
    return; // 已处理
  }
  
  // 创建素材
  await db.insert('material', materialData);
  await db.update('idempotency_record', 
    { status: 'SUCCESS' },
    { idempotency_key: idempotencyKey }
  );
}
\`\`\`

**问题**：节点 A 和节点 B 可能都执行到"创建素材"。

**变更后**：
\`\`\`typescript
async submitMaterial(
  idempotencyKey: string, 
  materialData: any,
  currentOwner: string,
  currentToken: number
) {
  await db.transaction(async (trx) => {
    // 1. 创建素材
    const materialId = await trx.insert('material', materialData);
    
    // 2. CAS 更新幂等记录（关键：检查 owner 和 token）
    const result = await trx.query(
      `UPDATE idempotency_record 
       SET status = 'SUCCESS', material_id = ? 
       WHERE idempotency_key = ? 
         AND owner = ? 
         AND fencing_token = ?`,
      [materialId, idempotencyKey, currentOwner, currentToken]
    );
    
    // 3. 检查 affected rows
    if (result.affectedRows === 0) {
      // token 不匹配，说明租约已被接管，回滚
      throw new Error('租约已失效，放弃提交');
    }
    
    // 提交事务
  });
}
\`\`\`

**关键点**：
- 提交时检查 `owner` 和 `fencing_token`，只有匹配才能更新
- 晚到的节点因为 token 不匹配，`affectedRows = 0`，事务回滚
- 单调递增的 token 保证晚到的永远失败

### 为什么这样改能解决问题

<建立因果链：技术手段 → 中间状态 → 业务结果>

示例：
1. **技术手段**：引入 fencing_token 单调递增字段
2. **中间状态**：每次租约转移，token 递增；晚到的提交因 token 不匹配被拒绝
3. **业务结果**：同一幂等键只能成功提交一次，避免重复素材

## 实施指南

### 改动清单

| 序号 | 改动项 | 类型 | 风险 |
|------|--------|------|------|
| 1 | idempotency_record 表增加字段 | DDL | 低（加字段，不影响现有数据） |
| 2 | MaterialUploadService.acquireLease | 代码逻辑 | 中（租约逻辑变更） |
| 3 | MaterialUploadService.submitMaterial | 代码逻辑 + 事务边界 | 高（核心提交流程） |
| 4 | 并发场景集成测试 | 测试用例 | - |

### 实施步骤

#### 第 1 步：数据库变更（预估 1 小时）
1. 在测试环境执行 DDL（见上面 SQL）
2. 验证现有代码不受影响（字段有默认值）
3. 在生产环境执行 DDL（建议非高峰期）

#### 第 2 步：实现租约逻辑（预估 4 小时）
1. 修改 `acquireLease` 方法，增加 fencing_token 递增逻辑
2. 修改 `renewLease` 方法，增加 CAS 检查
3. 单元测试：验证续租成功、续租失败（token 不匹配）

#### 第 3 步：实现提交逻辑（预估 4 小时）
1. 修改 `submitMaterial` 方法，增加 token 校验
2. 调整事务边界（素材创建 + 幂等更新在同一事务）
3. 单元测试：验证提交成功、提交失败（token 不匹配时回滚）

#### 第 4 步：集成测试（预估 4 小时）
1. 并发场景测试：两个节点同时处理同一幂等键
2. 租约接管场景测试：节点 A 超时，节点 B 接管，节点 A 晚提交
3. 压测：验证性能无明显下降

#### 第 5 步：上线部署
1. 灰度发布 10% 流量
2. 监控指标：幂等键冲突次数、事务回滚次数
3. 全量发布

### 测试用例

#### 测试用例 1：正常场景
- **前置条件**：无
- **操作**：节点 A 获取租约，处理完成，提交素材
- **预期结果**：提交成功，幂等记录状态为 SUCCESS

#### 测试用例 2：租约接管 + 晚提交
- **前置条件**：无
- **操作**：
  1. 节点 A 获取租约，token = 1
  2. 节点 A 处理超时（不续租）
  3. 节点 B 接管租约，token 递增为 2
  4. 节点 A 完成处理，尝试提交（token 仍为 1）
- **预期结果**：节点 A 提交失败，事务回滚；节点 B 提交成功

#### 测试用例 3：并发提交
- **前置条件**：无
- **操作**：节点 A 和节点 B 同时拿到 token = 1，同时提交
- **预期结果**：只有一个节点成功（数据库行锁保证），另一个节点 affected=0，回滚

### 回滚方案

如果上线后发现问题：
1. **代码回滚**：回退到旧版本代码（旧代码不使用 fencing_token 字段）
2. **数据修复**：如果产生了重复素材，执行数据清理脚本
3. **监控观察**：回滚后观察是否还有幂等冲突

### 监控指标

上线后需要关注的指标：
- `idempotency_conflict_count`：幂等键冲突次数（应该 = 0）
- `lease_takeover_count`：租约接管次数（正常业务指标）
- `transaction_rollback_count`：事务回滚次数（晚提交会触发）
- `material_duplicate_count`：重复素材数量（应该 = 0）

## 相关资源

- **相关 Finding**：CONC-03（配额并发控制，也需要 CAS 机制）
- **参考文档**：design.md §4.1 幂等设计
- **相关代码**：MaterialUploadService、IdempotencyService
- **测试用例**：test/integration/material-upload.spec.ts

## FAQ

### Q1：为什么不用数据库唯一索引代替 fencing token？
唯一索引只能防止同一幂等键插入两次，但无法防止"接管后晚提交"的场景。fencing token 是为了防止旧的处理者在租约失效后仍然提交。

### Q2：fencing_token 会一直递增吗？会不会溢出？
理论上会递增，但实际上单个幂等键只会被处理几次（正常 1 次，异常重试几次）。使用 BIGINT（最大 2^63-1）足够使用。

### Q3：如果节点 A 和节点 B 同时拿到同一个 token 怎么办？
不会发生。获取租约时用 `UPDATE ... WHERE owner IS NULL`，数据库的行锁保证只有一个节点能成功。

### Q4：这个改动对性能有影响吗？
影响很小。主要增加了一次 UPDATE 的 WHERE 条件判断，对数据库来说是微秒级操作。

---

**生成时间**：2026-08-22  
**生成工具**：opsx-finding-explain  
**目标读者**：开发工程师  
```

### Step 4 — 生成汇总文档（批量模式）

如果是 `--all-blockers` 或 `--all` 模式，额外生成 `review/finding-details-summary.md`：

```markdown
# Finding 详细解析汇总

本文档汇总了本次技术评审中需要详细解析的 finding。

## 目录

- [CONC-02 - 同一个幂等键产生两条素材记录](finding-details/CONC-02.md)
- [CONC-03 - 并发创建突破 200 个素材上限](finding-details/CONC-03.md)
- [SEC-01 - 恶意用户可以收藏其他企业的消息](finding-details/SEC-01.md)

## 快速导航

### 按业务功能
- **素材上传**：[CONC-02](finding-details/CONC-02.md)、[CONC-03](finding-details/CONC-03.md)
- **消息收藏**：[SEC-01](finding-details/SEC-01.md)

### 按改动模块
- **MaterialService**：[CONC-02](finding-details/CONC-02.md)、[CONC-03](finding-details/CONC-03.md)
- **MessageCollectionController**：[SEC-01](finding-details/SEC-01.md)

### 按优先级
- **P0 Blocker（必须本期修复）**：CONC-02、CONC-03、SEC-01
- **P1 Major（建议本期修复）**：无
```

### Step 5 — 输出提示

输出生成的文档路径，并给出使用建议：

```
✅ Finding 详细解析已生成

📄 生成的文档：
- review/finding-details/CONC-02.md （15.2 KB）

💡 使用建议：
- 阅读"业务场景完整描述"理解问题背景
- 阅读"代码实现示例"查看具体改法
- 阅读"实施指南"按步骤执行
- 阅读"FAQ"解决常见疑问

🔗 下一步：
- 在 tasks.md 中创建对应任务，引用本文档
- 开发时遇到问题，回来查看"技术问题深入分析"
```

## 与整体流程的关系

- 上游：`/opsx:review` 产出 `review-summary.md` 和 `review/<role>.md`
- 本 skill：`/opsx:explain` 读取评审结果，生成详细解析文档
- 下游：`/opsx:apply` 实施修复时，参考详细解析文档

```
/opsx:review
    ↓ 产出 finding 表格（9 字段）
    ↓
【可选】/opsx:explain --finding CONC-02
    ↓ 产出详细解析文档（完整业务场景 + 代码示例）
    ↓
/opsx:apply
    ↓ 实施修复（参考详细文档）
```

## 实现注意事项

1. **读取 finding 信息**：需要解析 markdown 表格，提取 9 个字段
2. **读取上下文**：需要读取 design.md 对应章节，理解设计意图
3. **代码示例生成**：需要根据"涉及代码模块"推断语言（Java/TypeScript/Python）
4. **避免重复生成**：如果 `review/finding-details/<ID>.md` 已存在，询问是否覆盖
5. **模板复用**：常见问题（幂等、权限、并发）可以有模板，加速生成

## 配置选项

可在变更目录下创建 `.finding-explain.json` 配置文件：

```json
{
  "defaultAudience": "tech",
  "includeCodeExamples": true,
  "includeTimingDiagrams": true,
  "codeLanguage": "typescript",
  "maxDocumentSize": "50KB"
}
```

## 示例调用

```bash
# 单个 finding
/opsx:explain --finding CONC-02

# 所有 Blocker
/opsx:explain --all-blockers

# 面向非技术人员
/opsx:explain --finding SEC-01 --audience non-tech

# 批量生成（包括 Major）
/opsx:explain --all --severity Blocker,Major
```
