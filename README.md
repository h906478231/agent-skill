# agent-skills

跨 coding agent 复用的 Agent Skills 仓库。基于开放的 `SKILL.md` 标准，同一份资产可在 Claude Code、Codex CLI、opencode、Cursor 等 70+ agent 中使用。

## 目录结构

```
skills/          跨 agent 通用能力（31 个），SKILL.md 标准格式
claude/          Claude Code 专用资产（command / subagent），其他 agent 不支持
```

`skills/` 是 `npx skills` 扫描的目录；`claude/` 不会被扫描，需手动链接或复制。

## 快速开始

[![skill.sh](https://img.shields.io/badge/skill.sh-agent--skills-blue?logo=github)](https://github.com/h906478231/agent-skill)
[![License](https://img.shields.io/badge/license-Apache%202.0-green.svg)](LICENSE)

### 前置要求

- ✅ Git（已添加到系统 PATH）
- ✅ Node.js >= 16
- ✅ 网络可访问 GitHub

### 一键安装（推荐）

安装所有 33 个 skills 到支持的 AI 编码工具：

```bash
npx skills add h906478231/agent-skill -g -a '*'
```

> 💡 如遇问题，请查看 [故障排除指南](docs/skill-sh-troubleshooting.md)

### 安装到特定 agent

```bash
# Claude Code
npx skills add h906478231/agent-skill -g -a claude-code

# Cursor
npx skills add h906478231/agent-skill -g -a cursor

# Codex CLI
npx skills add h906478231/agent-skill -g -a codex

# opencode
npx skills add h906478231/agent-skill -g -a opencode
```

### 自己开发使用（符号链接，改完即时生效）

```bash
npx skills add ./ -g -a claude-code -a codex -a opencode
```

符号链接是默认模式，三个 agent 共享同一份源文件，编辑 `skills/` 后无需重装。

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

### OpenSpec 流程增强（4 个）

| skill                      | 作用 | 命令 |
|----------------------------|---|---|
| `openspec-technical-review`    | 编码前五维度技术评审门禁（含 `shared/` 规则事实源、roles、hook、workflow） | `/opsx:review` |
| `openspec-change-overview` | 变更总览：文档地图 / 端到端流程 / 字段变更台账 / 规则条件可追溯矩阵 | `/opsx:overview` |
| `openspec-code-quality`    | 实现层代码质量评审：对 diff 查重复率 / 可读性 / 死代码 / 复杂度 / 设计偏离 | `/opsx:quality` |
| `openspec-discussion-sync` | 子 agent 讨论结论回流契约与落盘规则 | 无（由主 agent 加载） |

### 其他

`concurrency-analysis`

## 研发流程

`workflow/OpenSpec-AI-研发流程.md` —— OpenSpec + 技术评审门禁的完整研发流程：分级规则、门禁裁决、闭环留痕、签字责任、**门禁产物的 git 归属与生命周期**、门禁强制力边界与部署方法。

规则的事实源划分：**面向人的策略**（分级 / 签字责任 / 强制力边界 / git 生命周期）只写在该流程文档；**面向 agent 的执行规则**（finding 字段 / 闭环验证 / 裁决判定 / apply 签字校验）只写在 `skills/openspec-technical-review/shared/`。其余文件一律引用，不复制 —— 改规则时只改事实源那一处。

门禁 hook 需在 `~/.claude/settings.json` 注册后才生效，注册方法见该文档「门禁启用与部署」。

## claude/ 专用资产

| 资产 | 说明 | 手动安装位置 |
|---|---|---|
| `commands/opsx/` | opsx 命令组（11 个），调用形式 `/opsx:propose` 等 | `~/.claude/commands/opsx/` |
| `agents/ddd-modeler.md` | DDD 建模 subagent | `~/.claude/agents/` |
| `agents/ddd-architect-claude.md` | DDD 主控 subagent（含子 agent 结论回流规则） | `~/.claude/agents/` |

注意：`commands/opsx/` 与 `skills/openspec-*` 是同一套 OpenSpec 能力的两种形态。command 仅 Claude Code 可用，skill 跨平台可用。两者同时安装会出现重复能力，建议按平台择一。

### 关于 vendored 资产的重复

`skills/openspec-*/SKILL.md` 与 `claude/commands/opsx/{explore,propose,apply,update,sync,archive,verify,ff}.md` 是 OpenSpec CLI 生成的上游副本（frontmatter 标 `generatedBy`），两两高度重复。**这部分刻意不做去重** —— 改动会在上游升级时产生冲突。

唯一例外是 apply 的技术评审门禁校验块（本仓自加，非上游原文），已抽到 `skills/openspec-technical-review/shared/apply-gate-check.md`，两处改为引用。

本仓自建资产（`opsx-*` 四个 skill 与 `review/overview/quality` 三个命令）则严格遵守单一事实源，命令文件均为薄壳。

## 编写规范

`SKILL.md` 的 frontmatter 必须包含：

- `name`：须与所在目录名完全一致，格式 `^[a-z0-9]+(-[a-z0-9]+)*$`
- `description`：1–1024 字符，需足够具体，agent 靠它判断何时加载

不满足则 CLI 无法识别。新建 skill 可用 `npx skills init <name>` 生成模板。

技术参考：[vercel-labs/skills](https://github.com/vercel-labs/skills) · [skills.sh](https://www.skills.sh) · [opencode skills 文档](https://opencode.ai/docs/skills/)
