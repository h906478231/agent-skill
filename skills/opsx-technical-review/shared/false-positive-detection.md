# AI 误报自动检测规则

> 本文件定义了在汇总阶段执行的误报检测规则，供汇总 Agent 使用。
> 路径：`skills/opsx-technical-review/shared/false-positive-detection.md`

## 什么时候执行

在 `review-summary.md` 汇总阶段，读取所有 `review/<role>.md` 后，执行本文件定义的检测规则。

## 检测规则

### 规则 1：触发场景模糊 → 自动降级

**触发条件**：finding 的"触发场景"字段包含模糊词汇

**模糊词汇清单**：
- 可能
- 有时
- 偶尔
- 某些情况下
- 高并发时（未给出具体并发量）
- 大数据量时（未给出具体数据量）
- 在极端情况下

**处理**：
- Blocker → 降级为 Major
- Major → 降级为 Minor
- Minor → 保持 Minor

**输出**：在 `review-summary.md` 的"疑似误报检测"区块列出

**理由**：触发场景不具体的 Blocker，无法验证是否真的会发生。根据"写不出具体触发场景的 Blocker 一律降级为 Major"原则。

---

### 规则 2：跨维度矛盾 → 提示可能误报

**触发条件**：不同维度的结论互相矛盾

**典型场景**：

| Security 发现 | Architecture 结论 | 判定 |
|--------------|------------------|------|
| "外部输入未校验" | "该接口仅内部调用" | 矛盾 → 可能误报 |
| "SQL 注入风险" | "使用了 ORM，无拼接 SQL" | 矛盾 → 可能误报 |
| "权限绕过风险" | "该功能仅管理员可见" | 矛盾 → 可能误报 |

**处理**：
- 不自动降级（可能 Architecture 的判断也有误）
- 在"疑似误报检测"区块标记为"跨维度矛盾，需人工复核"
- 建议人工核实哪个维度的判断正确

---

### 规则 3：量级不匹配 → 提示可能过度

**触发条件**：Performance 维度报告性能问题，但数据量很小

**量级阈值**：

| 数据量 | 是否触发检测 | 建议 |
|--------|------------|------|
| < 1000 条 | 是 | 性能影响可能很小，建议降级或 risk accepted |
| 1000 - 1 万 | 视场景 | 需结合查询复杂度判断 |
| > 1 万 | 否 | 性能问题合理 |

**提取方法**：
- 从 proposal.md 或 design.md 提取数据量描述
- 正则匹配：`\d+\s*[条|行|个|万]`
- 从 finding 的"触发场景"中提取数据量

**处理**：
- 不自动降级
- 在"疑似误报检测"区块列出
- 建议："当前数据量 XXX 条，性能影响可能很小，建议降级或 risk accepted"

---

### 规则 4：已有类似实现 → 提示参考既有方案

**触发条件**：Architecture 维度报告"缺少某功能"，但代码库中已有类似实现

**检测方法**：
- 搜索代码库中是否存在相关关键词
- 例如：finding 说"缺少重试机制" → 搜索代码库是否有 `@Retry` 注解或 `retryTemplate`

**处理**：
- 不自动降级
- 在"疑似误报检测"区块提示："代码库中已有类似实现（xxx），建议复用"
- 如果是误报（既有实现已满足需求），人工标记为误报

---

### 规则 5：过度设计 → 提示简化

**触发条件**：Architecture 维度建议引入复杂方案，但当前规模不需要

**典型场景**：

| 建议 | 当前规模 | 判定 |
|------|---------|------|
| "引入分布式锁" | 单机部署 | 过度设计 |
| "引入 MQ" | QPS < 10 | 过度设计 |
| "引入缓存" | 数据量 < 1000 | 过度设计 |

**处理**：
- 不自动降级
- 在"疑似误报检测"区块提示："当前规模较小，建议的方案可能过度复杂"
- 建议："先用简单方案，达到阈值（XXX）后再引入"

---

## 输出格式

在 `review-summary.md` 中插入"疑似误报检测"区块：

```markdown
## 疑似误报检测

以下 finding 可能存在误报或过度，请人工复核：

| finding ID | 原级别 | 建议 | 检测理由 |
|-----------|-------|------|---------|
| PERF-02 | Blocker | 降级为 Major | 当前数据量 500 条，性能影响可能很小 |
| SEC-03 | Blocker | 需人工复核 | Architecture 维度标记为内部接口，与本 finding 矛盾 |
| CONC-05 | Major | 降级为 Minor | 触发场景不具体（"高并发时可能"） |
| ARCH-01 | Major | 简化方案 | 当前 QPS < 10，引入 MQ 可能过度设计 |

**如认可自动降级建议，运行**：
```bash
/opsx:review <change> --apply-suggestions
```

**如认为是误报，追加驳回记录**：
见主文档「不认可评审结论」一节。
```

---

## 实现伪代码

```javascript
function detectFalsePositives(findings, allReviews, proposalContent, designContent) {
  const suspicious = [];
  
  for (const finding of findings) {
    // 规则 1：触发场景模糊
    const fuzzyKeywords = /可能|有时|偶尔|某些情况|高并发时(?!\s*\d)|大数据量时(?!\s*\d)|极端情况/i;
    if (fuzzyKeywords.test(finding.triggerScenario)) {
      suspicious.push({
        findingId: finding.id,
        originalLevel: finding.level,
        suggestion: downgradeSeverity(finding.level),
        reason: '触发场景不具体，建议降级',
        autoApply: true, // 可自动应用
      });
    }
    
    // 规则 2：跨维度矛盾
    if (finding.dimension === 'security') {
      const archReview = allReviews.find(r => r.dimension === 'architecture');
      
      // Security 说"外部输入"，但 Architecture 说"内部接口"
      if (finding.content.match(/外部.*输入|用户.*输入/) && 
          archReview.content.match(/内部.*接口|仅.*内部/)) {
        suspicious.push({
          findingId: finding.id,
          originalLevel: finding.level,
          suggestion: '需人工复核',
          reason: 'Architecture 维度标记为内部接口，与本 finding 矛盾',
          autoApply: false, // 需人工判断
        });
      }
    }
    
    // 规则 3：量级不匹配
    if (finding.dimension === 'performance') {
      const dataSize = extractDataSize(proposalContent + designContent + finding.content);
      
      if (dataSize && dataSize < 1000) {
        suspicious.push({
          findingId: finding.id,
          originalLevel: finding.level,
          suggestion: '降级或 risk accepted',
          reason: `当前数据量 ${dataSize} 条，性能影响可能很小`,
          autoApply: false,
        });
      }
    }
    
    // 规则 4：已有类似实现
    if (finding.dimension === 'architecture' && finding.content.match(/缺少|未实现/)) {
      const keyword = extractMissingFeature(finding.content); // 如"重试机制"
      if (searchCodebase(keyword)) {
        suspicious.push({
          findingId: finding.id,
          originalLevel: finding.level,
          suggestion: '需人工复核',
          reason: `代码库中已有类似实现（${keyword}），建议复用`,
          autoApply: false,
        });
      }
    }
    
    // 规则 5：过度设计
    if (finding.dimension === 'architecture') {
      if (finding.content.match(/引入.*MQ|引入.*消息队列/) && 
          extractQPS(proposalContent) < 10) {
        suspicious.push({
          findingId: finding.id,
          originalLevel: finding.level,
          suggestion: '简化方案',
          reason: '当前 QPS < 10，引入 MQ 可能过度设计',
          autoApply: false,
        });
      }
    }
  }
  
  return suspicious;
}

function downgradeSeverity(level) {
  const map = { 'Blocker': 'Major', 'Major': 'Minor', 'Minor': 'Minor' };
  return map[level] || level;
}

function extractDataSize(text) {
  const match = text.match(/(\d+)\s*[条|行|个]/);
  if (match) return parseInt(match[1]);
  
  const matchWan = text.match(/(\d+)\s*万/);
  if (matchWan) return parseInt(matchWan[1]) * 10000;
  
  return null;
}

function extractQPS(text) {
  const match = text.match(/QPS\s*[：:]\s*(\d+)|每秒\s*(\d+)\s*[个|次]/i);
  if (match) return parseInt(match[1] || match[2]);
  return null;
}

function extractMissingFeature(text) {
  // 从"缺少重试机制"中提取"重试"
  const match = text.match(/缺少|未实现\s*([^，。、]+)/);
  return match ? match[1].trim() : null;
}

function searchCodebase(keyword) {
  // 简化实现：搜索代码库是否包含关键词
  // 实际可用 grep / ripgrep
  return false; // 占位
}
```

---

## 自动应用降级建议

如果用户运行：

```bash
/opsx:review <change> --apply-suggestions
```

对所有标记为 `autoApply: true` 的建议，自动修改对应 `review/<role>.md`：

1. 在原 finding 下追加降级记录：

```markdown
> **自动降级**：CONC-05
> 理由：触发场景不具体（"高并发时可能"），根据误报检测规则自动降级
> 原级别：Major → 新级别：Minor
> 降级时间：2026-08-20T10:30:00Z
```

2. 在 finding 表格中更新级别列
3. 重新计算裁决（降级后可能从 BLOCKED 变为 READY_FOR_HUMAN_APPROVAL）

---

## 注意事项

### 1. 误报检测不是万能的

- 规则基于启发式，可能有漏检或误检
- 最终决策权在人工
- 不要盲目信任自动降级

### 2. 持续优化规则

- 收集真实误报案例
- 调整规则权重和阈值
- 补充新的检测规则

### 3. 与闭环记录的关系

- 自动降级**不等于**驳回或 risk accepted
- 降级后的 finding 仍需在 design.md 中闭环
- 只是降低了严重级别，不代表问题不存在

---

## 集成点

在 `skills/opsx-technical-review/SKILL.md` 的 Step 2（汇总阶段）调用：

```markdown
### Step 2 — 汇总为 review-summary.md

读取 `review/*.md`，执行以下步骤：

1. 汇总各维度结论
2. **执行误报检测**（新增）：按 `shared/false-positive-detection.md` 规则检测
3. 生成"疑似误报检测"区块
4. 计算门禁裁决（考虑降级后的级别）
5. ...
```

---

需要帮助？在团队群里 @技术教练 或提 Issue。
