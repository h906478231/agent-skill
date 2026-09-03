# 08: 更新云舟回写逻辑（Report phase）

**What to build:**

更新 Report/Sync phase 的云舟评论内容，包含完整的 OpenSpec 变更信息：变更文档目录、技术评审级别、PR 链接等。确保云舟任务与 OpenSpec 变更的可追溯性。

**Blocked by:** 07: 增强 Verify phase 集成 OpenSpec Verify

**Status:** ready-for-agent

## Acceptance Criteria

- [ ] 定位到当前回写云舟评论的代码位置（可能在 Commit 或 Sync phase）
- [ ] 修改评论模板，添加 OpenSpec 相关信息
- [ ] 评论内容包含：变更 ID (`yunzhou-${task.id}`)
- [ ] 评论内容包含：变更文档路径 (`openspec/changes/${changeId}/`)
- [ ] 评论内容包含：门禁级别 (`${gateLevel}`)
- [ ] 评论内容包含：评审维度（如果不是 L0）
- [ ] 评论包含 PR 链接（如果已生成）
- [ ] 使用 `--external-key "devops-loop-completion-${task.id}"` 避免重复评论
- [ ] 验证评论成功写入云舟任务
