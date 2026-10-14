# 03: 实现门禁分级决策逻辑

**What to build:**

根据 Route 阶段判定的复杂度，自动决定技术评审门禁级别（L0/L1/L2/L3）。L0 任务创建豁免记录；L1-L3 任务准备相应的评审维度列表。完成后，每个任务都有明确的门禁级别和对应的评审维度。

**Blocked by:** 02: 添加 OpenSpec Explore 集成

**Status:** ready-for-agent

## Acceptance Criteria

- [ ] 添加 `phase('Gate Decision')`
- [ ] 定义配置对象 `GATE_LEVEL_MAP = { trivial: 'L0', simple: 'L1', medium: 'L2', complex: 'L3', epic: 'L3' }`
- [ ] 定义配置对象 `REVIEW_ROLES = { L0: [], L1: ['database', 'security'], L2: ['architecture', 'database', 'security', 'performance'], L3: ['architecture', 'concurrency', 'performance', 'database', 'security'] }`
- [ ] 根据 `routing.complexity` 计算 `gateLevel`
- [ ] L0 级别时，生成豁免记录到 `openspec/changes/${changeId}/review-summary.md`，包含豁免理由、时间、机器人签名
- [ ] L1-L3 级别时，准备 `roles` 数组
- [ ] 日志输出门禁级别和评审维度：`执行 ${gateLevel} 门禁，评审维度：${roles.join(', ')}`
