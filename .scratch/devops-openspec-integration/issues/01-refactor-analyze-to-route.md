# 01: 精简 Analyze 为 Route（路由决策器）

**What to build:** 

将当前的深度分析逻辑精简为快速路由决策。Route phase 只判断任务信息完整性、复杂度分类（trivial/simple/medium/complex/epic）和基本的 proceed/clarify/reject 决策。移除技术可行性深度分析和详细风险识别（这些交给 OpenSpec）。完成后，Route phase 在 5 分钟内完成决策。

**Blocked by:** None (可以立即开始)

**Status:** ready-for-agent

## Acceptance Criteria

- [ ] 将 `phase('Analyze')` 重命名为 `phase('Route')`
- [ ] 修改 ANALYSIS_SCHEMA 为 ROUTING_SCHEMA，字段简化为 `{ decision, complexity, reasoning, missingInfo? }`
- [ ] Agent 提示词精简，移除技术可行性和风险识别部分，只保留快速分类逻辑
- [ ] 保留 clarify 和 reject 的云舟评论回写逻辑
- [ ] 日志输出改为 `任务路由完成：${routing.complexity}`
- [ ] 提示词中明确说明不要深入分析技术方案和风险（交给 OpenSpec）
