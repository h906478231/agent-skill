# 分级自动判定工具使用指南

## 快速开始

### 方法 1：直接运行脚本

```bash
node scripts/classify-change.js <change-name>

# 示例
node scripts/classify-change.js add-user-nickname
```

### 方法 2：使用 Shell 包装器

```bash
./scripts/classify-change.sh <change-name>

# 示例
./scripts/classify-change.sh add-user-nickname
```

### 方法 3：集成到 OpenSpec 命令（推荐）

在 `/opsx:explore` 完成后自动提示分级：

```bash
# 在 openspec-explore/SKILL.md 的末尾添加
# 或在 opsx-technical-review/SKILL.md 的前置校验中调用
```

---

## 输出示例

```
┌─────────────────────────────────────────────────────────┐
│  变更：add-user-nickname                                 │
├─────────────────────────────────────────────────────────┤
│  变更类型：L1                                            │
├─────────────────────────────────────────────────────────┤
│  判定依据：                                              │
│    ✓ L1: 新增字段, 单表CRUD                              │
│    ○ L2: 批量操作                                        │
├─────────────────────────────────────────────────────────┤
│  建议跑的维度：                                          │
│    database + security                                  │
│                                                         │
│  预计耗时：2-4 分钟                                      │
└─────────────────────────────────────────────────────────┘

💡 提示：拿不准就升一级。漏评审的代价远高于多跑一个维度。

📄 分级结果已保存到: openspec/changes/add-user-nickname/.classification.json
```

---

## 分级规则

### L0 豁免（跳过门禁）

触发条件：
- ✓ 纯文案修改
- ✓ 注释或文档
- ✓ 日志文案
- ✓ 配置值调整
- ✓ 代码格式化
- ✓ 依赖小版本升级

示例：
```markdown
# proposal.md
修正登录按钮文案"登陆"错别字改"登录"
```

---

### L3 全量门禁（5 维度）

触发条件（命中任一）：
- ✓ 异步/MQ/消息队列
- ✓ 批量操作 ≥ 1 万条
- ✓ 新建表 / 改字段类型 / 唯一索引
- ✓ 对外开放接口 / 用户上传
- ✓ 租户隔离 / 权限判定 / 敏感数据
- ✓ 分布式一致性 / 状态机

示例：
```markdown
# design.md
引入 RabbitMQ 异步消费，批量导入 10 万条用户数据
```

---

### L2 标准门禁（4 维度）

触发条件：
- ✓ 跨模块调用
- ✓ 引入缓存（Redis/Memcached）
- ✓ 批量操作（< 1 万）
- ✓ 新增业务流程

示例：
```markdown
# design.md
新增订单支付流程，调用支付模块和库存模块
引入 Redis 缓存用户信息
```

---

### L1 轻量门禁（2 维度）

触发条件：
- ✓ 单表 CRUD
- ✓ 新增非核心字段
- ✓ 既有能力的小范围扩展

示例：
```markdown
# design.md
给 users 表新增 nickname 字段，VARCHAR(50)
```

---

## 分级结果文件

工具会在变更目录下生成 `.classification.json`：

```json
{
  "level": "L1",
  "scores": {
    "L0": 0,
    "L1": 1.3,
    "L2": 0.6,
    "L3": 0
  },
  "matched": {
    "L0": [],
    "L1": ["新增字段", "单表CRUD"],
    "L2": ["批量操作"],
    "L3": []
  },
  "dimensions": ["database", "security"],
  "estimatedTime": "2-4 分钟",
  "timestamp": "2026-08-20T10:30:00.000Z"
}
```

这个文件可以被其他脚本读取，用于自动化流程。

---

## 集成到工作流

### 在 `/opsx:explore` 完成后自动提示

编辑 `skills/openspec-explore/SKILL.md`，在末尾添加：

```markdown
## Ending Discovery

...

When it feels like things are crystallizing, you might summarize:

...

**自动分级建议**（在总结后运行）：

运行分级工具：
```bash
node scripts/classify-change.js <change-name>
```

根据分级结果，提示用户：
- L0：可以直接 apply，无需门禁（但需记录豁免理由）
- L1/L2/L3：需要跑对应维度的门禁
```

### 在 `/opsx:review` 启动前再次确认

编辑 `skills/opsx-technical-review/SKILL.md`，在前置校验中添加：

```markdown
## 前置校验

...

4. **判定评审范围**：
   
   运行分级工具：
   ```bash
   node scripts/classify-change.js <change-name>
   ```
   
   读取 `.classification.json`，向用户确认：
   - 系统判定为 L2（标准门禁，4 维度）
   - 是否同意此判定？[Y/n]
   - 如需调整，请输入新的等级（L0/L1/L2/L3）
```

---

## 注意事项

### 1. 分级工具是辅助，不是强制

- 工具给出建议，最终决策权在人
- 拿不准就升一级
- 可以人工覆盖工具的判定

### 2. 规则会随实践调整

当前规则基于关键词匹配，可能有误判。遇到误判时：

1. 在 `scripts/classify-change.js` 的 `RULES` 中调整权重
2. 或补充新的匹配规则
3. 提交 PR 并注明调整理由

### 3. 边界情况处理

**接近阈值时会给出警告**：

```
⚠️  警告：接近 L3 阈值，建议人工复核是否需要升级到 L3。
```

遇到警告时，建议：
- 读一遍 proposal.md 和 design.md
- 参考 `shared/workflow/gate-levels.md` 的判定口诀
- 如果包含 L3 的触发信号（异步/MQ/大批量/表结构...），升级到 L3

---

## 常见问题

### Q1：工具判定为 L1，但我觉得应该是 L2？

**可以人工覆盖**。运行 `/opsx:review` 时，手动指定维度：

```bash
/opsx:review <change> --roles architecture,database,security,performance
```

或在 `.classification.json` 手工改 `level` 字段。

### Q2：proposal.md 或 design.md 不存在怎么办？

工具会给出警告，但仍会尝试基于现有文件判定。建议：
- 先运行 `/opsx:explore` 补全文档
- 再运行分级工具

### Q3：关键词匹配会不会误判？

**会**。当前是 MVP 版本，基于简单的正则匹配。

已知局限：
- "批量操作 500 条"可能被误判为 L2（虽然 < 1 万）
- "注释掉旧的 MQ 代码"可能被误判为 L3（虽然是删除而非新增）

**改进方向**（未来版本）：
- 引入 NLP 语义分析
- 基于历史数据训练分类模型
- 支持自定义规则配置

### Q4：能否自动跑门禁，不用人工确认？

**不建议**。原因：
- 分级工具可能误判
- 某些边界场景需要人工判断
- 人在回路中（human-in-the-loop）是质量保障的一环

但可以在 CI/CD 中集成，作为提示而非强制。

---

## 贡献规则调整

如果你发现分级规则不准确，欢迎提交改进：

1. **编辑规则**：修改 `scripts/classify-change.js` 的 `RULES` 对象
2. **测试**：用几个真实变更测试新规则
3. **文档**：更新本文档的"分级规则"部分
4. **提交 PR**：注明调整理由和测试案例

**示例 PR 描述**：

```
调整 L3 规则：降低"异步"关键词权重

**问题**：
当前"异步"关键词权重 0.8，导致"异步日志输出"被误判为 L3。

**调整**：
- 将"异步"权重从 0.8 降到 0.6
- 新增"异步.*MQ|异步.*消费"权重 1.0（更精确）

**测试**：
- ✓ "异步日志输出" → L1（正确）
- ✓ "异步 MQ 消费" → L3（正确）
```

---

## 后续改进计划

见 [`docs/improvement-roadmap.md`](improvement-roadmap.md) 的 P0-2。

**近期计划**：
- [ ] 收集 100 个真实变更的分级数据
- [ ] 基于数据调整规则权重
- [ ] 支持自定义配置文件（`.openspec/classification-rules.json`）

**中期计划**：
- [ ] 引入 NLP 语义分析
- [ ] 支持多语言（英文/中文）
- [ ] 集成到 VSCode/Cursor 插件

---

## 技术细节

### 判定算法

```javascript
// 1. 计算每个级别的得分
for (const [level, patterns] of Object.entries(RULES)) {
  for (const { pattern, weight } of patterns) {
    if (pattern.test(text)) {
      scores[level] += weight;
    }
  }
}

// 2. 判定逻辑（优先级：L3 > L0 > L2 > L1）
if (scores.L3 >= 1.0) return 'L3';       // 高风险优先
if (scores.L0 >= 1.0) return 'L0';       // 豁免其次
if (scores.L2 >= 0.8) return 'L2';       // 标准门禁
return 'L1';                              // 默认轻量
```

### 为什么 L3 优先于 L0？

**场景**：proposal.md 写"调整配置文件中的 MQ 连接串"

- 匹配到 L0 规则：配置值调整（权重 0.9）
- 匹配到 L3 规则：MQ（权重 1.0）

如果 L0 优先，会被误判为"豁免"，但实际涉及 MQ 配置应该是 L3。

**因此**：L3（高风险）优先级最高。

### 阈值为什么是 1.0 / 0.8？

基于经验值，未来会根据实际数据调整：

- L3 阈值 1.0：必须命中至少一个强特征（MQ/大批量/表结构...）
- L0 阈值 1.0：必须命中至少一个豁免特征
- L2 阈值 0.8：允许多个中等特征累加

---

需要帮助？在团队群里 @技术教练 或提 Issue。
