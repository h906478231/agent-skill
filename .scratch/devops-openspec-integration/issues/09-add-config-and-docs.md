# 09: 添加配置项和文档

**What to build:**

在工作流文件顶部添加配置常量（门禁映射、评审维度等），便于后续调整规则。更新相关文档说明新的集成流程，包括使用指南和故障排查。

**Blocked by:** 08: 更新云舟回写逻辑（Report phase）

**Status:** ready-for-agent

## Acceptance Criteria

- [ ] 在 devops-automation-loop-yunzhou.workflow.js 文件开头（meta 之后）添加 CONFIG 对象
- [ ] CONFIG 包含：GATE_LEVEL_MAP, REVIEW_ROLES, YUNZHOU_PROFILE（从环境变量读取或默认值）, CHANGE_ID_PREFIX
- [ ] 将 Ticket 03 中硬编码的映射规则移到 CONFIG 中
- [ ] 所有引用这些映射的地方改为 `CONFIG.GATE_LEVEL_MAP[complexity]` 等
- [ ] 更新 workflow meta.description，简要说明集成流程
- [ ] 在 docs/ 目录添加或更新文档：`devops-openspec-integration-guide.md`
- [ ] 文档包含：新流程图（Fetch → Route → Explore → Gate → Review → Human Gate → Apply → Verify → Report）
- [ ] 文档包含：配置说明（如何调整门禁映射规则）
- [ ] 文档包含：常见问题（如何重新运行工作流、如何跳过某些步骤等）
