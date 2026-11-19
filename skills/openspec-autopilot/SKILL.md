---
name: openspec-autopilot
description: OpenSpec 托管：用户在会话中完成 review 与签字后（或分级不需要编码前评审时），把一个变更交给托管。本机 launchd 定时运行调度脚本，按进度规则依次以 headless claude 运行 apply、quality、verify、archive；agent 的 AskUserQuestion 提问与告警变成飞书卡片，用户在卡片上点选后会话从原处继续；归档后的提交与合并、推送经卡片确认后由调度脚本执行。用于签字之后不想逐个输入阶段命令、或不在电脑前也要给出决策的场景。只由用户运行 /opsx:autopilot；不运行 explore、grill、propose、review、update，不代替用户签字。
---

# OpenSpec 托管（Autopilot）

## 解决什么问题

签字之后，用户在每个阶段结束时输入下一条命令，而下一条命令 `progress.mjs` 已经能算出；agent 的提问只能在终端中回答，用户离开电脑时流程停住。托管让调度脚本按进度规则运行阶段，把提问、告警与对外写入的确认变成飞书卡片（规则见本 skill 所属变更的 design，术语见 `CONTEXT.md`「托管」「托管决策」「决策卡片」「出口动作」）。

## 铁律

- 只接受进度规则为 R6–R11 的变更。签字、变更终点、待环境补测的确认人仍由用户在会话中手写，托管不代写，回复也不能代替签署字段。
- 对外写入（提交与合并、推送）只在用户点选出口卡片后由调度脚本执行，headless 运行的 agent 不能执行 `git commit`、`git merge`、`git push`、`flows-cli`、`lark-cli`。
- 托管的状态只在变更目录的 `decisions/` 与本机托管目录中；用户随时可以用 `status` 查看、用 `cancel` 撤回。
- 托管期间不要在同一仓库中修改文件：调度脚本会把你的修改算作 agent 的进展，提交前的内容核对也会失败。

## 前置条件

`autopilot.mjs start` 读取进度视图（`progress.mjs --json`）与变更目录的 `decisions/`，逐项检查，不满足时拒绝并写出原因，不写文件。启用技术评审的变更，签字写在 `review-summary.md` 中，由进度规则读取（R5 表示签字行空白）：

| 条件 | 不满足时 |
|---|---|
| 进度规则为 R6–R11 | 退出码 1，写出规则与卡点，在会话中处理 |
| 同一检出没有其他已开始实现或在托管中的变更 | 退出码 1，写出这些变更名 |
| 当前分支是项目的 `baseBranch` | 退出码 1，写出当前分支 |
| 项目的 `git config user.name` 不为空 | 退出码 1（quality 按回复写入留痕字段时用这个名字） |
| 进度视图有 `implementing` 数组、进度条目有布尔的 `reviewStale` | 退出码 2，一起同步 `openspec-change-progress` 与 `openspec-technical-review` 两个已安装副本 |
| 运行锁中不是本变更（上一次撤回的阶段已停止） | 退出码 1，等阶段停止后再托管 |

重新托管已撤回的变更时，先作废上一次托管遗留的决策；遗留会话告警中有核对失败项时逐项列出，先在会话中处理这些记录。

## 命令

脚本在本 skill 的 `scripts/` 下（skill 目录随 agent 而不同；找不到时用 Glob 搜 `**/openspec-autopilot/scripts/autopilot.mjs`）。在项目目录中运行：

```bash
node <SKILL_DIR>/scripts/autopilot.mjs start <变更名>   # 交给托管
node <SKILL_DIR>/scripts/autopilot.mjs status <变更名>  # 托管记录、各状态的决策数
node <SKILL_DIR>/scripts/autopilot.mjs cancel <变更名>  # 撤回
```

退出码：`0` 成功；`1` 被拒绝或撤回后阶段仍在停止；`2` 参数或环境错误。原样显示输出，不改写。

## 撤回

`cancel` 先把托管记录与未完成的决策改为 `void`，再等调度脚本停下本变更的阶段或出口步骤（最多 `cancelWaitSeconds` 秒，阶段的 claude 进程收到 `SIGTERM`），之后才返回。退出码为 1 时阶段仍在停止：确认停止后再修改仓库。文件都保留，决策文件是提问原文与回复的记录。

## 托管中发生什么

- 调度脚本每轮最多运行一个 claude 阶段：R6、R7 运行 apply，R8 运行 quality，R9 运行 verify，R11 先记录实现快照再运行 archive；R1–R5、R10 作废托管并发通知卡片。
- agent 单独调用 `AskUserQuestion` 时，提问 hook 把它停住，问题与选项原样变成表单卡片；用户提交后桥接脚本核对并写入回复，调度脚本恢复会话，hook 把回复填回。
- 阶段没有进展、出错、超出预算，或运行前后的处理记录、签署字段对不上用户的回复时，发会话告警卡片：写说明后继续，或回会话处理（托管作废）。
- 归档后依次是提交与合并、推送：agent 只读起草计划，调度脚本核对计划后发出口卡片，用户点选后由调度脚本执行并回读。任一项选暂不处理时跳过其余各项。本变更 `decisions/` 下的文件不进入提交，托管结束后由用户决定。

## 设置来源与启动前核对

- headless 运行只加载 user 与 project 设置来源（不加载 local），禁用 WebFetch 与 WebSearch，环境变量只保留 `HOME`、`PATH`、`USER`、`LANG` 与两个托管变量。
- 每次启动或恢复 claude 之前，核对 `~/.claude/settings.json` 与 `<项目根>/.claude/settings.json` 的允许规则、`additionalDirectories`、`disableAllHooks` 与 `PreToolUse`、`PermissionRequest` hook，以及已安装 skill、命令与 subagent 文件头的 `allowed-tools` 与 hook（跟随软链接）。有项目 `allowedCommands` 以外的条目时本轮不运行该项目，发一次通知卡片列出条目与文件。处理方法：清理条目，或把对应的 Bash 命令前缀加进 `allowedCommands`；只由用户手动运行的 skill 或命令，在文件头加 `disable-model-invocation: true`。
- `allowedCommands` 只接受 `Bash(<命令前缀>...)` 形式，并且要包含 `Bash(openspec:*)`、`Bash(node:*)`、`Bash(git status:*)`、`Bash(git diff:*)`、`Bash(git log:*)`。
- 本 skill 的文件头不写 `allowed-tools` 与 `hooks`。

## 从已安装副本安装

调度脚本要求本 skill 目录、`progressBin` 与门禁脚本都在全部项目之外，因此从已安装副本运行安装：

`<SKILL_DIR>` 取已安装副本的本 skill 目录（Claude Code 为 `~/.claude/skills/` 下的本 skill 目录），不用仓库中的这份：

```bash
node <SKILL_DIR>/scripts/install.mjs           # 只打印要写入的文件
node <SKILL_DIR>/scripts/install.mjs --write   # 写入配置模板与两个 launchd 文件
```

`--write` 不覆盖已有的 `~/.openspec-autopilot/config.json`，不运行 `launchctl`。填写配置中的 `ownerOpenId`、`model` 与 `projects` 后，由用户运行脚本打印的 `launchctl bootstrap` 加载。发布前检查、部署与回滚见本 skill 所属变更的 `deployment.md`。

## 不负责

- explore、grill、propose、review、update 与签字。
- 云舟评论与云舟完成：托管结束的通知卡片写出任务号，由用户在会话中完成任务。
- 并行运行多个变更、worktree、部署到服务器。
