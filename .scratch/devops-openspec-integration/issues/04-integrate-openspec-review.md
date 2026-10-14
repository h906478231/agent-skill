# 04: 集成 OpenSpec Review 调用

**What to build:**

对于 L1-L3 级别的任务，自动调用 OpenSpec Review 工作流执行技术评审。评审完成后生成 `review/*.md` 和 `review-summary.md`。L0 任务跳过此步骤。

**Blocked by:** 03: 实现门禁分级决策逻辑

**Status:** ready-for-agent

## Acceptance Criteria

- [ ] 在 Gate Decision 判断后，L1-L3 级别添加 `phase('OpenSpec Review')`
- [ ] L0 级别输出日志 `L0 豁免：跳过技术门禁，直接进入实施阶段` 并跳过 Review
- [ ] 调用 `await workflow('openspec-review', { args: { change: changeId, roles: roles } })`
- [ ] 处理 workflow 调用可能的错误情况
- [ ] 验证生成评审产物文件存在（至少 review-summary.md）
- [ ] 日志输出评审完成状态：`技术评审完成 → openspec/changes/${changeId}/review-summary.md`
