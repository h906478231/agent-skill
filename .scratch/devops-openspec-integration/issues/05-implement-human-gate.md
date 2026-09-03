# 05: 实现人工门禁等待机制

**What to build:**

在技术评审（或 L0 豁免记录生成）后，工作流暂停等待人工在 `review-summary.md` 中签字。检测到签字后自动继续流程。未签字时工作流返回并提示开发者。

**Blocked by:** 04: 集成 OpenSpec Review 调用

**Status:** ready-for-agent

## Acceptance Criteria

- [ ] 添加 `phase('Human Gate')`
- [ ] 日志输出等待提示：`⏸️ 等待人工签字确认...`，包含文件路径和签字格式示例
- [ ] 使用 agent 读取 `openspec/changes/${changeId}/review-summary.md` 检查是否包含 `Technical Review Approved:` 且非占位符 `__________`
- [ ] 未签字时，输出提示信息并 `return` 终止工作流，返回值包含状态和提示
- [ ] 已签字时，日志输出 `✅ 人工门禁已通过，继续自动化流程`
- [ ] 提示信息清晰说明开发者需要做什么以及如何重新运行工作流
