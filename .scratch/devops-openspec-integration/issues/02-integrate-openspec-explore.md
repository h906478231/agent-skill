# 02: 添加 OpenSpec Explore 集成

**What to build:**

所有通过 Route 决策的任务都自动调用 OpenSpec Explore 工作流，完成需求澄清和方案设计。变更 ID 自动映射为 `yunzhou-${taskId}`，产物写入 `openspec/changes/yunzhou-${taskId}/` 目录。

**Blocked by:** 01: 精简 Analyze 为 Route（路由决策器）

**Status:** ready-for-agent

## Acceptance Criteria

- [ ] 在 Route phase 之后添加 `phase('OpenSpec Explore')`
- [ ] 定义变更 ID 映射规则：`const changeId = 'yunzhou-' + task.id`
- [ ] 调用 `await workflow('openspec-explore', { args: { change: changeId, taskInfo: task, complexity: routing.complexity } })`
- [ ] 处理 workflow 调用可能的错误情况
- [ ] 验证生成 `proposal.md` 和 `design.md` 文件存在
- [ ] 日志输出包含变更目录路径：`需求澄清与方案设计完成 → openspec/changes/${changeId}/`
