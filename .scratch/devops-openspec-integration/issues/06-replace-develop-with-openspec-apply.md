# 06: 替换 Develop phase 为 OpenSpec Apply 调用

**What to build:**

移除当前 Develop phase 中的自定义编码逻辑（包括 L0 直接编码和 L1-L3 的 OpenSpec 手动调用），统一改为调用 OpenSpec Apply 工作流。所有代码实施都通过标准的 OpenSpec 流程完成，确保实施与设计一致。

**Blocked by:** 05: 实现人工门禁等待机制

**Status:** ready-for-agent

## Acceptance Criteria

- [ ] 删除 Develop phase 中的所有条件分支逻辑（L0/L1/L2/L3 判断）
- [ ] 删除自定义的编码 agent 提示词
- [ ] 简化为统一调用 `await workflow('openspec-apply', { args: { change: changeId } })`
- [ ] 保留 `phase('Develop')` 名称（或考虑重命名为更准确的名称如 `phase('OpenSpec Apply')`）
- [ ] 处理 workflow 调用可能的错误情况
- [ ] 日志输出代码实施完成状态：`代码实现完成`
- [ ] 确保 absoluteCodeRepo 路径在 workflow 调用中正确传递（如果 openspec-apply 需要）
