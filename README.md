# agent-skills

跨 coding agent 复用的 Agent Skills 仓库。基于开放的 `SKILL.md` 标准，同一份资产可在 Claude Code、Codex CLI、opencode、Cursor 等 70+ agent 中使用。

## 目录结构

```
skills/          跨 agent 通用能力（28 个），SKILL.md 标准格式
claude/          Claude Code 专用资产（command / subagent），其他 agent 不支持
```

`skills/` 是 `npx skills` 扫描的目录；`claude/` 不会被扫描，需手动链接或复制。

## 安装

### 自己使用（符号链接，改完即时生效）

```bash
npx skills add ./ -g -a claude-code -a codex -a opencode
```

符号链接是默认模式，三个 agent 共享同一份源文件，编辑 `skills/` 后无需重装。

### 分发给他人（推送到 GitHub 后）

```bash
npx skills add <owner>/agent-skills -g -a '*'
```

`-a '*'` 表示安装到本机检测到的全部 agent。若目标环境不支持符号链接，追加 `--copy` 改为独立复制。

### 只装其中几个

```bash
npx skills add ./ -g --skill ddd-aggregate --skill ddd-overview
```

### 查看 / 更新 / 移除

```bash
npx skills list
npx skills update
npx skills remove --skill ddd-aggregate
```

安装前可用 `npx skills add ./ --list` 预览会识别到哪些 skill，不做实际写入。

## 各 agent 全局安装目录

| Agent | `-a` 取值 | 全局目录 |
|---|---|---|
| Claude Code | `claude-code` | `~/.claude/skills/` |
| Codex CLI | `codex` | `~/.codex/skills/` |
| opencode | `opencode` | `~/.config/opencode/skills/` |
| Cursor | `cursor` | `~/.cursor/skills/` |
| Gemini CLI | `gemini-cli` | `~/.gemini/skills/` |

去掉 `-g` 则安装到当前项目目录（如 `.claude/skills/`），可随项目提交、团队共享。

补充：opencode 原生兼容 Claude Code 目录，会直接读取 `~/.claude/skills/`；如需关闭，设置环境变量 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`。

## skills 清单

### DDD 建模（19 个）

`ddd-overview` `ddd-aggregate` `ddd-value-object` `ddd-domain-command` `ddd-domain-event`
`ddd-domain-service` `ddd-application-orchestration-modeling` `ddd-artifact-contract`
`ddd-coding-workflow` `ddd-modeling-workflow` `ddd-requirement-clarification`
`ddd-event-storming` `ddd-event-sourcing-lmax` `ddd-cqrs` `ddd-saga`
`ddd-persistence` `ddd-ports-adapters` `ddd-unit-testing`

### OpenSpec 工作流（8 个）

`openspec-verify-change` `openspec-ff-change`
`openspec-propose` `openspec-apply-change` `openspec-update-change`
`openspec-archive-change` `openspec-explore` `openspec-sync-specs`

### 其他

`concurrency-analysis` `opsx-technical-review`（含 roles / hooks / workflow 附属文件）

## 研发流程

`workflow/OpenSpec-AI-研发流程.md` —— OpenSpec + 技术评审门禁的完整研发流程：分级规则、门禁裁决、闭环留痕、签字责任、门禁强制力边界与部署方法。配套资产为 `skills/opsx-technical-review` 与 `claude/commands/opsx/review.md`。

门禁 hook 需在 `~/.claude/settings.json` 注册后才生效，注册方法见该文档「门禁启用与部署」。

## claude/ 专用资产

| 资产 | 说明 | 手动安装位置 |
|---|---|---|
| `commands/opsx/` | opsx 命令组（9 个），调用形式 `/opsx:propose` 等 | `~/.claude/commands/opsx/` |
| `agents/ddd-modeler.md` | DDD 建模 subagent | `~/.claude/agents/` |
| `agents/ddd-architect-claude.md` | DDD 主控 subagent | `~/.claude/agents/` |

注意：`commands/opsx/` 与 `skills/openspec-*` 是同一套 OpenSpec 能力的两种形态。command 仅 Claude Code 可用，skill 跨平台可用。两者同时安装会出现重复能力，建议按平台择一。

## 编写规范

`SKILL.md` 的 frontmatter 必须包含：

- `name`：须与所在目录名完全一致，格式 `^[a-z0-9]+(-[a-z0-9]+)*$`
- `description`：1–1024 字符，需足够具体，agent 靠它判断何时加载

不满足则 CLI 无法识别。新建 skill 可用 `npx skills init <name>` 生成模板。

技术参考：[vercel-labs/skills](https://github.com/vercel-labs/skills) · [skills.sh](https://www.skills.sh) · [opencode skills 文档](https://opencode.ai/docs/skills/)
