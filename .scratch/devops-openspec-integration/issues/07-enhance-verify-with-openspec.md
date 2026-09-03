# 07: 增强 Verify phase 集成 OpenSpec Verify

**What to build:**

在现有的项目测试之前，先调用 OpenSpec Verify 工作流执行三维校验（Completeness/Correctness/Coherence）。确保实现与设计文档的一致性，然后再运行项目自有测试。

**Blocked by:** 06: 替换 Develop phase 为 OpenSpec Apply 调用

**Status:** ready-for-agent

## Acceptance Criteria

- [ ] 在 Verify phase 开始时，先添加 `phase('OpenSpec Verify')` 或在现有 Verify phase 开头添加调用
- [ ] 调用 `await workflow('openspec-verify', { args: { change: changeId } })`
- [ ] 处理 workflow 调用可能的错误情况
- [ ] OpenSpec verify 失败时，记录错误并阻止继续执行（可以 return 或 throw）
- [ ] 保留原有的项目测试执行逻辑（如果存在）
- [ ] 日志输出 OpenSpec 验证结果：`OpenSpec 三维校验完成`
- [ ] 两个验证都通过才进入下一阶段（Commit/Sync）
