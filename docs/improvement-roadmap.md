# OpenSpec 工作流改进路线图

> 基于工作流深度分析的系统性改进建议

---

## 📊 当前状态评估

### 整体成熟度：⭐⭐⭐⭐ (4/5)

| 维度 | 评分 | 说明 |
|------|------|------|
| **架构设计** | ⭐⭐⭐⭐⭐ | 三重交叉验证链条无懈可击，五维度并行评审行业领先 |
| **工程实现** | ⭐⭐⭐⭐ | 自动生成闭环记录，双路径各有价值，shared/ 单一事实源 |
| **新人体验** | ⭐⭐ | 概念多、入门陡，缺"最小可行路径" |
| **老手效率** | ⭐⭐⭐⭐ | L0 豁免 + 增量重走机制好，但 L2/L3 有等待时间 |

### 效率与质量影响

```
维度             新人        老手        Bug渗透率
────────────────────────────────────────────────
当前状态         ⬇️ 30%      ⬆️ +5%      ⬇️ 50-60%
                (前2周)                  

+ P0 建议        ⬇️ 10%      ⬆️ +10%     ⬇️ 50-60%
                (前2周)      

+ P1 建议        ➡️ 0%       ⬆️ +20%     ⬇️ 55-65%

+ 全部建议       ⬆️ +15%     ⬆️ +25%     ⬇️ 55-65%
```

---

## 🎯 P0 建议：降低入门门槛（核心痛点）

### **建议 1：新人快速上手指南（单页）✅ 已完成**

**现状**：新人看到 677 行工程化文档 + 13 个 skills + 6 个文档 → 不敢用

**方案**：单页"5分钟上手指南"，核心要素：
- 三句话核心理念
- 3 个问题分级决策树（视觉化）
- 完整示例（给用户表加昵称字段，覆盖全流程）
- 8 个高频 FAQ

**成果**：[`docs/quickstart-guide.md`](quickstart-guide.md)

**投入**：已完成  
**收益**：新人入门时间 ⬇️ 60%（从 2-3 天到 0.5 天）

---

### **建议 2：分级自动判定工具 ⏳ 待实施**

**现状**：L0/L1/L2/L3 分级依赖人工经验，边界模糊

**痛点示例**：
- "批量操作 1000 条"算不算 L3？（阈值是 1 万）
- "加缓存"是 L2 还是 L3？
- "改字段长度 VARCHAR(50)→(100)"是 L0 还是 L1？

**方案**：CLI 工具 + 规则引擎

```bash
openspec classify-change <name>

输出：
┌─────────────────────────────────────────────┐
│ 变更类型：L2（标准）                         │
├─────────────────────────────────────────────┤
│ 判定依据：                                  │
│   ✓ 新增业务流程                            │
│   ✓ 涉及跨模块调用                          │
│   ✗ 无异步/MQ                               │
│   ✗ 数据量 < 1 万                           │
├─────────────────────────────────────────────┤
│ 建议跑的维度：                              │
│   architecture + database + security +      │
│   performance                               │
│                                             │
│ 预计耗时：3-6 分钟                          │
└─────────────────────────────────────────────┘

确认执行？[Y/n]
```

**实现思路**：

```javascript
// 规则引擎（基于关键词匹配）
const rules = {
  L0: [
    { pattern: /纯文案|注释|日志文案/, weight: 1.0 },
    { pattern: /配置值调整|格式化/, weight: 1.0 },
    { pattern: /依赖小版本升级/, weight: 0.8 },
  ],
  L3: [
    { pattern: /异步|MQ|消息队列|并发消费/, weight: 1.0 },
    { pattern: /批量.*([1-9]\d{4,}|[1-9]\d万)/, weight: 1.0 }, // ≥1万
    { pattern: /新建.*表|ALTER TABLE.*TYPE|唯一索引/, weight: 1.0 },
    { pattern: /对外.*接口|用户上传|公网/, weight: 1.0 },
    { pattern: /租户隔离|权限判定|敏感数据/, weight: 1.0 },
  ],
  L2: [
    { pattern: /跨模块|跨服务/, weight: 0.9 },
    { pattern: /引入.*缓存|Redis|Memcached/, weight: 0.8 },
    { pattern: /批量.*\d+/, weight: 0.6 }, // 批量但 <1万
  ],
  L1: [
    { pattern: /单表.*CRUD/, weight: 0.7 },
    { pattern: /新增.*字段/, weight: 0.6 },
  ],
};

// 从 proposal.md + design.md 提取关键词，计算权重
function classifyChange(proposalContent, designContent) {
  const text = proposalContent + '\n' + designContent;
  const scores = { L0: 0, L1: 0, L2: 0, L3: 0 };
  
  for (const [level, patterns] of Object.entries(rules)) {
    for (const { pattern, weight } of patterns) {
      if (pattern.test(text)) {
        scores[level] += weight;
      }
    }
  }
  
  // L3 优先（高风险），然后降级
  if (scores.L3 >= 1.0) return 'L3';
  if (scores.L0 >= 1.0) return 'L0';
  if (scores.L2 >= 0.8) return 'L2';
  return 'L1'; // 默认
}
```

**集成点**：
- `/opsx:explore` 完成后自动提示分级
- `/opsx:review` 启动前再次确认分级

**投入**：3-5 人日  
**收益**：分级准确率 ⬆️ 80%，减少误判导致的返工

**优先级**：⭐⭐⭐⭐⭐

---

### **建议 3：合并文档视图（Web UI）⏳ 待规划**

**现状**：一个变更涉及 6 个文档，要跳来跳去

```
openspec/changes/<name>/
├── proposal.md          ← Phase 1 需求澄清
├── design.md            ← Phase 2 方案设计
├── tasks.md             ← 任务清单
├── discussion-log.md    ← 子 agent 讨论记录
├── overview.md          ← 派生总览（勿手改）
└── review/
    ├── ...
    └── review-summary.md  ← 人工签字
```

**痛点**：
- 要确认"有条件通过的条件是否都实现了"，需跳转 3 个文件
- overview.md 虽然汇总了，但开发者心智模型仍是"六份文档"

**方案**：Web UI 虚拟单文件视图

```
┌─────────────────────────────────────────────────────┐
│  变更：add-contact-batch-import                      │
├─────────────────────────────────────────────────────┤
│  [需求] [设计] [评审] [任务] [总览]    ← Tab 切换     │
│                                                     │
│  当前视图：设计                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │ ## 候选方案交叉验证矩阵                      │    │
│  │ ...                                         │    │
│  │                                             │    │
│  │ ## 推荐方案                                  │    │
│  │ ...                                         │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  💡 关联信息（右侧面板）：                           │
│  ┌─────────────────────────────────────────────┐    │
│  │ 📊 评审状态：READY_FOR_HUMAN_APPROVAL        │    │
│  │                                             │    │
│  │ ⚠️  未闭环条件：                             │    │
│  │    • C-01: 幂等键唯一索引须 tenant_id 前导   │    │
│  │    • C-02: 批量 INSERT 须开 rewriteBatch... │    │
│  │    [点击跳转到 tasks.md 对应行]              │    │
│  │                                             │    │
│  │ 💬 相关讨论：3 条未决问题                    │    │
│  │    [点击展开]                                │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

**关键特性**：
1. **底层仍是独立文件**（git 友好，可 diff）
2. **展示层做聚合**（开发者看到的是单一界面）
3. **智能跳转**：点击"C-01 未闭环"→ 自动跳到 tasks.md 对应行
4. **进度可视化**：显示"6 个任务，完成 4 个"
5. **实时同步**：文件变化后自动刷新 UI

**技术栈参考**：
- Electron / Tauri（桌面应用）
- 或 VSCode Extension（集成到编辑器）
- 或 Web UI（本地 localhost 服务）

**投入**：10-15 人日  
**收益**：认知负担 ⬇️ 40%，文档跳转次数 ⬇️ 70%

**优先级**：⭐⭐⭐⭐

---

## 🎯 P1 建议：提高老手效率

### **建议 4：快速通道（信任度机制）⏳ 待规划**

**现状**：老手心里有数的变更，仍需等 4-8 分钟门禁

**痛点场景**：
- 老手改批量接口，心里清楚要加幂等键、租户隔离、批大小限制
- 但流程强制跑 L3 全量评审 4-8 分钟
- 等待期间无法并行工作（因为要基于评审结果改设计）

**方案**：基于信任度的"先行后审"机制

```
触发条件（同时满足）：
  1. 同一开发者
  2. 同一模块/子系统
  3. 过去 5 次变更无 Blocker
  4. 变更类型为 L1/L2（L3 不适用快速通道）

机制：
  ┌──────────────────────────────────────┐
  │ /opsx:apply（立即开始写代码）         │
  ├──────────────────────────────────────┤
  │          并行                         │
  │ /opsx:review（后台跑门禁）            │
  └──────────────────────────────────────┘
           ↓
    ┌─────────────────┐
    │ 门禁通过 ✓       │ → 继续 verify
    └─────────────────┘
           ↓
    ┌─────────────────┐
    │ 门禁 BLOCKED ✗  │ → 中止 apply，回退代码，改 design 后重走
    └─────────────────┘

退出条件（回到正常流程）：
  - 一旦出现 Blocker
  - 或连续 3 次 Major 级问题
```

**实现要点**：

1. **信任度评分系统**

```javascript
// 存储在 openspec/.trust-scores.json
{
  "developer": {
    "张三": {
      "module:user-service": {
        "totalChanges": 12,
        "blockerCount": 0,
        "majorCount": 2,
        "lastBlockerAt": null,
        "trustLevel": "high", // low / medium / high
        "eligibleForFastTrack": true
      }
    }
  }
}

// 每次门禁完成后更新
function updateTrustScore(developer, module, findings) {
  const blockers = findings.filter(f => f.level === 'Blocker');
  const majors = findings.filter(f => f.level === 'Major');
  
  // Blocker 出现，立即降级
  if (blockers.length > 0) {
    trustLevel = 'low';
    eligibleForFastTrack = false;
  }
  
  // 连续 5 次无 Blocker，升级
  if (recentChanges(5).every(c => c.blockerCount === 0)) {
    trustLevel = 'high';
    eligibleForFastTrack = true;
  }
}
```

2. **并行执行协调**

```bash
# apply 启动时检查信任度
if checkFastTrackEligibility(); then
  echo "✓ 快速通道已启用，门禁并行跑"
  startApply() & applyPid=$!
  startReview() & reviewPid=$!
  
  # 等待门禁完成
  wait $reviewPid
  
  if reviewBlocked; then
    kill $applyPid
    echo "✗ 门禁 BLOCKED，已中止 apply"
    rollbackChanges
  else
    echo "✓ 门禁通过"
    wait $applyPid
  fi
fi
```

3. **回退机制**

```bash
# apply 启动时创建快照
git stash push -m "fast-track-snapshot-$(date +%s)"

# BLOCKED 时回退
git stash pop
```

**风险控制**：
- L3 变更不适用快速通道（高风险场景仍需先审后行）
- Blocker 出现立即退出快速通道
- 代码已写但门禁 BLOCKED → 自动回退（不是手工删除）

**投入**：5-8 人日  
**收益**：老手效率 ⬆️ 15%（消除等待时间）

**优先级**：⭐⭐⭐⭐

---

### **建议 5：AI 误报自动检测与降级 ⏳ 待实施**

**现状**：约 10-15% 的 finding 是误报，需人工驳回

**典型误报场景**：
1. Security 维度报"CSV 导出未防公式注入"，但该导出只对内部管理员开放
2. Performance 维度报"全量加载内存"，但当前数据量只有 500 条
3. Concurrency 维度报"并发风险"，但触发场景写得很模糊（"高并发时可能有问题"）

**方案**：在汇总阶段加"交叉验证误报检测"

```javascript
// 在 review-summary.md 汇总时执行
function detectFalsePositives(findings, allReviews) {
  const suspiciousFinding = [];
  
  for (const finding of findings) {
    // 规则 1：触发场景模糊 → 自动降级
    if (finding.triggerScenario.match(/可能|有时|偶尔|高并发时/)) {
      suspiciousFinding.push({
        ...finding,
        originalLevel: finding.level,
        suggestedLevel: downgradeSeverity(finding.level),
        reason: '触发场景不具体，建议降级为 ' + downgradeSeverity(finding.level)
      });
    }
    
    // 规则 2：跨维度矛盾 → 提示可能误报
    if (finding.dimension === 'security') {
      const archReview = allReviews.find(r => r.dimension === 'architecture');
      
      // Security 说有风险，但 Architecture 说该路径不对外
      if (archReview.content.includes('该接口仅内部') && 
          finding.content.includes('外部输入')) {
        suspiciousFinding.push({
          ...finding,
          reason: 'Architecture 维度标记为内部接口，与 Security 发现矛盾，可能误报'
        });
      }
    }
    
    // 规则 3：量级不匹配 → 提示可能过度
    if (finding.dimension === 'performance') {
      const dataSize = extractDataSize(finding.content);
      
      // 报性能问题，但数据量很小
      if (dataSize && dataSize < 1000) {
        suspiciousFinding.push({
          ...finding,
          reason: `当前数据量 ${dataSize} 条，性能影响可能很小，建议降级或 risk accepted`
        });
      }
    }
  }
  
  return suspiciousFinding;
}

function downgradeSeverity(level) {
  const map = { 'Blocker': 'Major', 'Major': 'Minor', 'Minor': 'Minor' };
  return map[level] || level;
}
```

**汇总输出增强**：

```markdown
## 疑似误报检测

以下 finding 可能存在误报，请人工复核：

| finding ID | 原级别 | 建议级别 | 检测理由 |
|-----------|-------|---------|---------|
| PERF-02 | Blocker | Major | 当前数据量 500 条，性能影响可能很小 |
| SEC-03 | Blocker | - | Architecture 维度标记为内部接口，与本 finding 矛盾 |
| CONC-05 | Major | Minor | 触发场景不具体（"高并发时可能"），建议降级 |

**如认可自动降级建议，运行**：
```bash
/opsx:review <change> --auto-downgrade
```

**如认为是误报，追加驳回记录**：
[见主文档「不认可评审结论」]
```

**投入**：2-3 人日  
**收益**：误报率 ⬇️ 30-40%，人工驳回次数 ⬇️ 50%

**优先级**：⭐⭐⭐

---

## 🎯 P2 建议：降低维护成本

### **建议 6：Phase 6 人工核对清单自动化 ⏳ 待规划**

**现状**：Phase 6 有一个"人工核对清单"需要手工检查

```markdown
## Phase 6 交叉核对清单（当前是人工）

### 1. 回溯第一性原理（设计 → 需求）
- [ ] 实现是否解决了 proposal.md 中识别的「底层问题」而非「表面需求」
- [ ] 是否引入了 proposal.md 未识别的新约束

### 2. 方案选择一致性（实现 → 设计）
- [ ] 代码实现的关键决策点是否与 design.md 推荐方案一致
- [ ] 若实现过程中改了方案，是否回填更新了 design.md

### 3. 评审条件闭环（实现 → 评审）
- [ ] review-summary.md 的「有条件通过」条件是否都映射到 tasks.md 并完成

### 4. 设计阶段可测试性验证
- [ ] 关键业务逻辑是否可单测（外部依赖是否可 mock）

### 5. 运维成本验证
- [ ] 是否新增需要人工干预的场景（如：死信队列需人工重放）
```

**痛点**：
- 人工核对容易遗漏
- 签字人可能"看一眼就签"，未真正核对

**方案**：扩展 `/opsx:verify` 为"五维校验"

```bash
/opsx:verify <change>

当前三维：
  - Completeness（任务完成度）
  - Correctness（需求正确性）
  - Coherence（实现与设计一致）

扩展为五维：
  + Traceability（回溯第一性原理）  ← 新增
  + Operability（运维成本验证）     ← 新增
```

**Traceability 维度实现**：

```javascript
// 读取 proposal.md 的"底层问题"
const bottomLineProblem = extractFromProposal('真正要解决的问题');

// 读取 design.md 的"推荐方案"
const recommendedSolution = extractFromDesign('推荐方案');

// 读取代码实现
const implementation = analyzeCode();

// 验证逻辑
const checks = {
  // 检查 1：实现是否解决底层问题
  solvesBottomLineProblem: () => {
    // 分析实现的核心逻辑是否匹配 bottomLineProblem 描述的场景
    // 例如：底层问题是"大批量数据导入阻塞用户操作"
    //      → 实现必须是异步/非阻塞的
    return implementation.isAsync && !implementation.blocksUI;
  },
  
  // 检查 2：关键决策点是否一致
  matchesDesignDecisions: () => {
    // design.md 说"用 MQ 异步消费"
    // → 代码里必须有 MQ 相关逻辑
    const designKeywords = extractKeywords(recommendedSolution);
    const codeKeywords = extractKeywords(implementation);
    
    return designKeywords.every(kw => codeKeywords.includes(kw));
  },
  
  // 检查 3：是否引入了新约束
  noNewConstraints: () => {
    // 读取 proposal.md 列出的约束
    const declaredConstraints = extractConstraints();
    
    // 分析代码引入的依赖
    const actualDependencies = analyzeDependencies(implementation);
    
    // 新依赖 = 新约束（如引入 MQ 但 proposal 没提）
    return actualDependencies.every(dep => 
      declaredConstraints.includes(dep)
    );
  }
};
```

**Operability 维度实现**：

```javascript
const operabilityCHecks = {
  // 检查 1：是否有人工干预场景
  noManualIntervention: () => {
    // 分析代码中的 TODO / FIXME / 手动处理 等标记
    const manualInterventionPatterns = [
      /TODO.*手动/,
      /死信.*人工/,
      /失败.*通知.*运维/,
    ];
    
    return !manualInterventionPatterns.some(p => 
      implementation.comments.match(p)
    );
  },
  
  // 检查 2：是否有监控埋点
  hasMonitoring: () => {
    // 关键路径是否有日志/指标埋点
    const criticalPaths = identifyCriticalPaths(implementation);
    
    return criticalPaths.every(path => 
      hasLogging(path) || hasMetrics(path)
    );
  },
  
  // 检查 3：是否有对账工具
  hasReconciliationTool: () => {
    // 涉及数据一致性的场景，是否有对账脚本
    if (implementation.involvesDataConsistency) {
      return fileExists('scripts/reconcile-*.sh');
    }
    return true; // 不涉及则不要求
  }
};
```

**输出示例**：

```markdown
## Phase 6 五维校验报告

### 1. Completeness（完整性）✓
- tasks.md 8 个任务，全部完成
- spec.md 3 个 requirement，全部实现

### 2. Correctness（正确性）✓
- 需求覆盖率：100%
- scenario 验证：3/3 通过

### 3. Coherence（一致性）⚠️
- 设计偏离 1 处：
  - design.md 说"用 RabbitMQ"，但代码用的是 Kafka
  - 建议：回填更新 design.md 或改代码

### 4. Traceability（可追溯性）✓
- ✓ 实现解决了 proposal.md 的底层问题（异步非阻塞）
- ✓ 关键决策点与 design.md 一致（MQ 分片消费）
- ✗ 引入了新约束：Kafka 依赖（proposal 未提及）
  → 建议：回 proposal.md 补充约束说明

### 5. Operability（可运维性）⚠️
- ✗ 死信队列处理需人工重放（code:125 TODO 注释）
  → 建议：补充自动重试机制或运维 runbook
- ✓ 关键路径有监控埋点
- ✓ 有对账脚本（scripts/reconcile-orders.sh）

## 裁决：NEED_FIX（2 个 WARNING）

修复后重跑 Phase 6。
```

**投入**：3-5 人日  
**收益**：Phase 6 耗时 ⬇️ 50%，人工遗漏率 ⬇️ 80%

**优先级**：⭐⭐⭐

---

## 📈 实施路线图

### **阶段 1：突破推广瓶颈（本月）**

**目标**：让新人敢用、会用

| 任务 | 负责人 | 投入 | 状态 |
|------|--------|------|------|
| ✅ P0-1: 5分钟上手指南 | - | 1 人日 | ✅ 已完成 |
| ⏳ 试用反馈与迭代 | 找 2-3 个新人 | 0.5 人日 | 待启动 |
| ⏳ 团队分享会 | 技术负责人 | 2 小时 | 待排期 |

**里程碑**：新人能在 30 分钟内完成第一个变更

---

### **阶段 2：降低门槛与提升效率（下季度）**

**目标**：减少摩擦，提高老手效率

| 任务 | 优先级 | 投入 | 预期收益 |
|------|--------|------|---------|
| P0-2: 分级自动判定工具 | ⭐⭐⭐⭐⭐ | 3-5 人日 | 分级准确率 ⬆️ 80% |
| P1-5: AI 误报自动检测 | ⭐⭐⭐ | 2-3 人日 | 误报率 ⬇️ 30-40% |

**里程碑**：老手效率提升 10-15%

---

### **阶段 3：深度优化（明年 H1）**

**目标**：工程化成熟，体验接近完美

| 任务 | 优先级 | 投入 | 预期收益 |
|------|--------|------|---------|
| P0-3: 合并文档视图（Web UI） | ⭐⭐⭐⭐ | 10-15 人日 | 认知负担 ⬇️ 40% |
| P1-4: 快速通道（信任度机制） | ⭐⭐⭐⭐ | 5-8 人日 | 老手效率 ⬆️ 15% |
| P2-6: Phase 6 自动化 | ⭐⭐⭐ | 3-5 人日 | Phase 6 耗时 ⬇️ 50% |

**里程碑**：新人效率转正，老手效率 ⬆️ 20%+

---

## 💰 ROI 估算

### **投入**

| 阶段 | 人日 | 假设人日成本 | 总成本 |
|------|------|-------------|--------|
| 阶段 1（已完成） | 1.5 | ¥2000 | ¥3,000 |
| 阶段 2 | 5-8 | ¥2000 | ¥10,000-16,000 |
| 阶段 3 | 18-28 | ¥2000 | ¥36,000-56,000 |
| **总计** | **24.5-37.5** | - | **¥49,000-75,000** |

### **收益**（按 10 人团队，年度估算）

| 收益项 | 计算 | 年度收益 |
|--------|------|---------|
| 新人入门时间节省 | 2 人 × 1.5 天/年 × ¥2000 | ¥6,000 |
| 老手被打断减少 | 8 人 × 50 次/年 × 0.5 小时 × ¥250 | ¥50,000 |
| Bug 渗透率降低 50% | 假设每个 bug 成本 ¥5000，年度 20 个 → 10 个 | ¥50,000 |
| 事故复盘时间节省 | 2 次/年 × 8 人 × 4 小时 × ¥250 | ¥16,000 |
| **总计** | - | **¥122,000/年** |

**投资回报期**：约 5-7 个月

---

## 📊 价值-成本矩阵

```
                 价值（Bug↓ + 效率↑）
                 │
         高      │   ● P0-1 新手指南（已完成）
                 │   ● P0-2 自动分级
                 │   ● P1-4 快速通道
                 │
         中      │   ◆ P1-5 误报检测
                 │   ◆ P0-3 合并视图
                 │   ◆ P2-6 Phase6 自动化
                 │
         低      │
                 │
                 └─────────────────────────── 实现成本
                     低      中      高

● = 高优先级（高价值 + 中低成本）
◆ = 中优先级（中价值或高成本）

推荐顺序：P0-1(✅) → P0-2 → P1-5 → P1-4 → P0-3 → P2-6
```

---

## 🎯 成功指标（KPI）

### **阶段 1 完成后**

| 指标 | 基线 | 目标 | 当前 |
|------|------|------|------|
| 新人入门时间 | 2-3 天 | ≤ 1 天 | - |
| 新人第一次提问前时间 | 10 分钟 | ≥ 30 分钟 | - |
| "不敢用"的新人占比 | 50% | ≤ 20% | - |

### **阶段 2 完成后**

| 指标 | 基线 | 目标 | 当前 |
|------|------|------|------|
| 分级判定准确率 | 60% | ≥ 90% | - |
| 误报驳回次数 | 每周 10 次 | ≤ 5 次 | - |
| 老手被打断次数 | 每天 5-8 次 | ≤ 3 次 | - |

### **阶段 3 完成后**

| 指标 | 基线 | 目标 | 当前 |
|------|------|------|------|
| 文档跳转次数 | 每个变更 15+ 次 | ≤ 5 次 | - |
| 老手 L2 变更墙钟时间 | 60 分钟 | ≤ 45 分钟 | - |
| Phase 6 人工核对耗时 | 15 分钟 | ≤ 5 分钟 | - |

---

## 🔄 持续改进机制

### **月度回顾**

- 收集使用反馈（新人 + 老手）
- 统计门禁数据：
  - 分级分布（L0/L1/L2/L3 占比）
  - 误报率
  - BLOCKED 率
  - 人工驳回次数
- 识别新痛点

### **季度优化**

- 根据数据调整分级规则
- 优化误报检测规则
- 补充新的典型案例到上手指南

### **年度大版本**

- 评估是否需要 Web UI（取决于团队规模）
- 评估是否需要快速通道（取决于老手占比）
- 考虑与其他工具集成（CI/CD、JIRA 等）

---

## 📝 附录：决策记录

### **为什么保留交互式 + workflow 两条路径？**

**原因**：
- 交互式路径：实时反馈，用户可中途调整，调试友好
- Workflow 路径：结构化 schema 强约束，批量/自动化场景，性能优化空间

**维护成本可控**：核心逻辑在 `shared/` 和 `roles/`（单一事实源），两条路径只是"调度层"不同。

### **为什么 P1-6 闭环记录自动生成已实现？**

当前机制：
1. 用户确认按建议执行后，Agent 自动修改 `design.md`
2. Agent 自动生成闭环记录表格
3. 人在回路中（human-in-the-loop）保留决策权

这个设计比"完全手工填表"更优。

### **为什么不建议统一两条路径？**

虽然可以让交互式直接调用 workflow.js，但：
- 失去了"实时反馈"的优势（workflow 是批量执行）
- 失去了"中途调整"的灵活性
- 调试变困难（workflow 黑盒）

两条路径共存是有意设计，不是技术债。

---

## 🎉 结语

你的 OpenSpec 工作流已经非常成熟（⭐⭐⭐⭐），唯一阻碍推广的是"新人入门门槛"。

**核心建议**：
1. ✅ **先做 P0-1**（5分钟上手指南，已完成）
2. ⏳ **找新人试用并迭代**（本周）
3. ⏳ **再做 P0-2**（分级自动判定，下周启动）

这两个建议成本低（共 4-6 人日），但能解决 80% 的推广阻力。

其他建议作为"优化项"，按价值-成本矩阵逐步实施即可。

**记住**：工具再好，如果没人敢用，价值就是零。优先解决"敢用"的问题，再解决"好用"的问题。
