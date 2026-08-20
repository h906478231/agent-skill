# 分级工具测试用例

## 测试目的

验证 `scripts/classify-change.js` 的分级准确性。

## 测试用例

### 用例 1：L0 豁免 - 纯文案修改

**proposal.md 内容**：
```markdown
修正登录按钮文案"登陆"错别字改"登录"
```

**预期结果**：L0  
**实际结果**：待测试

---

### 用例 2：L1 轻量 - 新增字段

**proposal.md 内容**：
```markdown
给 users 表新增 nickname 字段，用于显示在个人主页
```

**design.md 内容**：
```markdown
## 技术方案
ALTER TABLE users ADD COLUMN nickname VARCHAR(50) NOT NULL DEFAULT '';
单表 CRUD，不涉及跨模块调用
```

**预期结果**：L1（database + security）  
**实际结果**：待测试

---

### 用例 3：L2 标准 - 跨模块调用 + 引入缓存

**proposal.md 内容**：
```markdown
新增订单支付流程，调用支付模块和库存模块
引入 Redis 缓存用户信息
```

**design.md 内容**：
```markdown
## 技术方案
跨模块调用：订单模块 → 支付模块 → 库存模块
引入 Redis 缓存，减少数据库查询
```

**预期结果**：L2（architecture + database + security + performance）  
**实际结果**：待测试

---

### 用例 4：L3 全量 - MQ + 批量操作

**proposal.md 内容**：
```markdown
批量导入 10 万条用户数据
引入 RabbitMQ 异步消费
```

**design.md 内容**：
```markdown
## 技术方案
使用 RabbitMQ 异步消费，批量导入 10 万条用户数据
分片消费，保证幂等性
```

**预期结果**：L3（5 维度全跑）  
**实际结果**：待测试

---

### 用例 5：边界情况 - 批量 1000 条（接近但未达 L3 阈值）

**proposal.md 内容**：
```markdown
批量导入 1000 条用户数据
```

**design.md 内容**：
```markdown
## 技术方案
同步批量插入，循环 1000 次
```

**预期结果**：L2（批量操作，但 < 1 万）  
**实际结果**：待测试

---

### 用例 6：误判场景 - 注释掉旧的 MQ 代码

**proposal.md 内容**：
```markdown
注释掉旧的 RabbitMQ 消费逻辑
```

**design.md 内容**：
```markdown
## 技术方案
注释掉以下代码：
// 旧的 RabbitMQ 消费逻辑
// @RabbitListener(queues = "old-queue")
// public void consume(Message msg) { ... }
```

**预期结果**：L0（注释/文档）  
**实际结果**：可能误判为 L3（因为包含"RabbitMQ"关键词）  
**备注**：这是已知局限，需要后续改进（引入语义分析）

---

### 用例 7：L3 触发信号 - 权限判定 + 敏感数据

**proposal.md 内容**：
```markdown
实现多租户隔离
用户数据需要脱敏处理
```

**design.md 内容**：
```markdown
## 技术方案
基于 tenant_id 做租户隔离
敏感数据（手机号、身份证号）入库前加密
```

**预期结果**：L3（涉及租户隔离 + 敏感数据）  
**实际结果**：待测试

---

## 测试执行

### 准备工作

```bash
# 创建测试变更目录
mkdir -p openspec/changes/test-l0-typo
mkdir -p openspec/changes/test-l1-add-field
mkdir -p openspec/changes/test-l2-cross-module
mkdir -p openspec/changes/test-l3-mq-batch
mkdir -p openspec/changes/test-boundary-batch-1k
mkdir -p openspec/changes/test-false-positive-comment
mkdir -p openspec/changes/test-l3-tenant-sensitive
```

### 写入测试数据

```bash
# 用例 1
echo "修正登录按钮文案\"登陆\"错别字改\"登录\"" > openspec/changes/test-l0-typo/proposal.md

# 用例 2
cat > openspec/changes/test-l1-add-field/proposal.md << 'EOF'
给 users 表新增 nickname 字段，用于显示在个人主页
EOF

cat > openspec/changes/test-l1-add-field/design.md << 'EOF'
## 技术方案
ALTER TABLE users ADD COLUMN nickname VARCHAR(50) NOT NULL DEFAULT '';
单表 CRUD，不涉及跨模块调用
EOF

# ... (其他用例类似)
```

### 运行测试

```bash
# 用例 1
node scripts/classify-change.js test-l0-typo

# 用例 2
node scripts/classify-change.js test-l1-add-field

# 用例 3
node scripts/classify-change.js test-l2-cross-module

# 用例 4
node scripts/classify-change.js test-l3-mq-batch

# 用例 5
node scripts/classify-change.js test-boundary-batch-1k

# 用例 6
node scripts/classify-change.js test-false-positive-comment

# 用例 7
node scripts/classify-change.js test-l3-tenant-sensitive
```

### 记录结果

将实际结果填入上方"实际结果"栏。

---

## 测试结果总结

| 用例 | 预期 | 实际 | 通过 | 备注 |
|------|------|------|------|------|
| 1. L0 纯文案 | L0 | - | - | - |
| 2. L1 新增字段 | L1 | - | - | - |
| 3. L2 跨模块 | L2 | - | - | - |
| 4. L3 MQ+批量 | L3 | - | - | - |
| 5. 边界批量1k | L2 | - | - | - |
| 6. 误判注释MQ | L0 | - | - | 已知局限 |
| 7. L3 租户敏感 | L3 | - | - | - |

**准确率**：待计算

---

## 改进建议

基于测试结果，可能需要调整的规则：

1. **用例 6（误判场景）**：
   - 问题：包含"注释"和"MQ"，但L0和L3权重冲突
   - 建议：在RULES中增加排除规则，如"注释.*MQ"权重给L0而非L3

2. **其他待发现的问题**：待测试后补充

---

## 下一步

1. 运行测试并记录结果
2. 根据结果调整 `RULES` 权重
3. 补充更多边界测试用例
4. 收集真实变更数据，建立测试集
