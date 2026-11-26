# ADR-0018：迁移脚本只维护 ~/.claude 与 ~/.agents 的工具入口

- 状态：已接受
- 日期：2026-11-26
- 决策者：用户在 2026-11-26 的 explore 对话中确认
- 关联变更：`limit-tigger-entries-to-claude-and-agents`
- 部分取代：[ADR-0013](0013-tigger-asset-home.md) 第 3、4 条

## 背景

ADR-0013 第 3 条规定各工具都通过软链接使用 `~/.tigger` 的实际文件，第 4 条规定迁移时移除 Codex 旧副本的禁用配置和重复入口。按此实现后，每次同步除了维护 `~/.claude` 与 `~/.agents`，还维护 opencode 的 78 个 skill 链接、5 个 agent 链接与 Codex 的 1 个 agent 链接，共 84 个。首次迁移还扫描并改写 `~/.codex` 与 `~/.config/opencode`，并改写 `~/.codex/config.toml`。

已查实：opencode 1.18.35 自动加载 `~/.claude/skills` 与 `~/.agents/skills`，扫描时跟随链接；Codex 读取 `~/.agents/skills`。因此两处入口已能让三个工具看到全部普通 skill。opencode 的 agent 定义只从 `~/.config/opencode/agent(s)` 读取，Codex 的 agent 定义只从 `~/.codex/agents` 读取。

## 决策

1. 日常同步与首次迁移只创建、更新和删除 `~/.claude` 与 `~/.agents` 下的入口。`~/.config/opencode` 与 `~/.codex` 中的已有链接保持原状，由用户人工删除。来源记录中两处以外的入口，核验与残留清理都跳过。
2. agent 只发布 Claude Code 格式的定义。opencode 与 Codex 格式的定义跳过并输出说明。`~/.tigger/agents/opencode` 与 `~/.tigger/agents/codex` 不再更新，脚本也不删除它们。
3. 首次迁移只扫描 `~/.cc-switch`、`~/.agents` 与 `~/.claude`。`~/.cc-switch` 只作为来源读取，其中的条目不改为链接。不读取或改写 `~/.codex/config.toml`，不删除 Codex 的重复链接。
4. 回滚仍接受本决定之前的运行记录中登记的 opencode、Codex、cc-switch 路径与 `~/.codex/config.toml`。

ADR-0013 的第 1、2、5、7 条不变。第 6 条的「其他目录」按上面第 3 条的三处执行。

## 备选方案

| 方案 | 结论 |
|---|---|
| MVP：收窄现有脚本，删除其他工具目录的代码路径 | 采用 |
| 增加工具列表参数，默认只维护两处 | 不采用。保留用户不需要的代码路径，测试要覆盖两种配置 |
| 不改脚本，每次同步后人工删除链接 | 不采用。下次同步会重新创建这些链接 |
| agent 定义例外，继续维护 opencode 与 Codex 的 agent 链接 | 不采用。用户决定 agent 定义不例外 |

## 后果

- opencode 的 5 个与 Codex 的 1 个 agent 定义失去脚本维护。用户删除对应链接后，这些 agent 在 opencode 与 Codex 中不可用。
- opencode 依赖外部 skill 自动加载。设置 `OPENCODE_DISABLE_EXTERNAL_SKILLS`、`OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` 或 `OPENCODE_DISABLE_CLAUDE_CODE` 后，opencode 看不到这些 skill。
- opencode 从两处读到同名 skill 时记录 `duplicate skill name` 警告。两处指向同一目录，加载结果不变。
- 首次迁移不再迁入 `~/.codex` 与 `~/.config/opencode` 中的独有 skill。新机器上 Codex 的旧副本禁用配置与重复链接，由用户在 Codex 中处理。
- 从旧检出运行旧版脚本会重新创建这些链接，因此只从主检出运行脚本。
- 本机同步、人工删除链接与工具加载验收见变更的 `deployment.md`。
