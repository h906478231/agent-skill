---
name: openspec-change-progress
description: OpenSpec 进度视图：只读当前项目的 openspec/，为每个活跃变更输出一行分级、阶段、任务勾选数、待决定条数、卡点与下一步命令，已归档变更只列名称与日期。阶段按 progress.mjs 的 RULES 常量顺序推导，分级、签字、证据、双轴评审与 verify 报告指纹读取门禁脚本 implementation-gate.mjs facts 的输出。用于会话开始、切换会话后接续变更前，回答「每个变更走到哪、卡在哪、下一步跑哪个命令」。输出终端表格，--json 供 agent 读取。不写变更目录，不判断 verify 是否通过，不改变任何门禁。
---

# OpenSpec 进度视图（Progress View）

## 解决什么问题

切换会话后，用户与 agent 都要重新查明每个活跃变更走到哪个阶段、卡在哪里、下一步运行哪个命令。这些信号分散在变更目录的 10 类文件中，`openspec view` 只统计勾选数。本 skill 用一条命令输出这三项，`--json` 供 agent 读取后接续工作，不依赖手写的变更状态记录。

## 铁律

- **只读**。不写变更目录，不运行写入 git 引用、索引与工作区的命令。门禁脚本计算实现指纹时向 git 对象库写入不可达对象，与门禁脚本的其他子命令相同，由 `git gc` 回收。
- **推导规则只有一份**：`scripts/progress.mjs` 的 `RULES` 常量，按顺序判断，命中第一条就停。本文件不复制规则表，要了解某条规则时读该常量与它的中文注释。
- **判定规则不在本 skill 中**。分级行、`Gate-Verdict` 行、签字行、切片证据、双轴评审与 verify 报告指纹的读取规则只在门禁脚本 `implementation-gate.mjs` 中实现，本 skill 只读 `facts` 子命令的 JSON。
- **不判断 verify 是否通过**。`verification.md` 没有固定的结论行，阶段为 `archive` 时下一步写「先确认 `verification.md` 没有 CRITICAL」，由用户或 agent 打开报告确认。
- **不放行任何门禁**。apply 前的签字校验仍按 `../openspec-technical-review/shared/apply-gate-check.md` 执行，归档前的阻断仍由 `/opsx:archive` 判断。

## 脚本

`<PROGRESS>` = `<SKILL_DIR>/scripts/progress.mjs`（`<SKILL_DIR>` 为本 SKILL.md 所在目录）；读不到时用 Glob 搜 `**/openspec-change-progress/scripts/progress.mjs`。运行需 Node.js ≥ 16 与 openspec CLI，不需要 `npm install`。

```bash
node <PROGRESS> [--json] [--gate <path>]   # 在项目目录中运行
```

- 门禁脚本的缺省位置是 `../openspec-technical-review/scripts/implementation-gate.mjs`（相对本 skill 目录解析，`progress.mjs` 按同一位置查找）。缺省路径不存在（退出码 2，信息写出该路径）时，用 Glob 搜 `**/openspec-technical-review/scripts/implementation-gate.mjs`，再用 `--gate` 传入。
- 门禁脚本的用法文本中没有 `facts` 时退出码 2，提示同步 `openspec-technical-review`。已安装的 skill 是各自独立的副本，只同步本 skill、不同步门禁脚本时会出现这种情况。同步副本前先问用户。

| 退出码 | 含义 |
|---|---|
| `0` | 已输出视图。单个变更读取失败也是 `0`，原因写在该条目的 `error` |
| `2` | 参数错误、openspec CLI 无法运行、找不到项目的 `openspec/`、找不到门禁脚本，或门禁脚本不支持 `facts`。原样告诉用户原因 |

每个活跃变更约 1 秒（`openspec status` 与门禁 `facts` 各一次），按需运行一次，不轮询。

## 何时运行

- 会话开始时，用户问「现在有哪些变更、做到哪了」。
- 接续一个变更前：先运行本视图确认阶段与卡点，再运行它给出的下一步命令。
- 不在 propose、apply、quality、verify、archive 的流程中自动运行，不属于任何卡点。

## 如何阅读输出

默认输出 Markdown 表格，列为变更、分级、阶段、任务、待决定、卡点、下一步。卡点只写第一条，多于一条时附「（共 N 条）」。表格下方列出各变更的告警，最后一行写已归档变更数与最近一个。原样显示给用户，不改写。

`--json` 输出 `{ root, active, archived }`，`active` 中每个条目的字段：

| 字段 | 读法 |
|---|---|
| `change`、`tier` | 变更名与分级（`L0`–`L3`、`MVP`、`null`）。`null` 表示 `overview.md` 没有可读的分级行 |
| `stage`、`rule` | 推导出的阶段与命中的规则编号（`R1`–`R11`）。要知道为什么是这个阶段，读 `RULES` 中该编号的注释 |
| `tasks` | `{ done, total }`，与 `openspec list` 的勾选数相同 |
| `blockers` | 命中规则的卡点，全部列出 |
| `warnings` | 门禁 `archive` 检查的告警，原样复制，不参与推导。例如「评审后实现有变化，要运行 `classify`」 |
| `notes` | 说明。例如没有分级行、已有勾选的变更按历史变更处理，以及门禁的「不适用」理由 |
| `openQuestions` | `{ pending, total }`：`design.md`「## Open Questions」中的条目数与没写「结论」的条目数。**只展示，不参与推导，不作为卡点**；由用户或 agent 看过条目后判断是否阻断 |
| `next` | 下一步命令或人工动作 |
| `error` | 读取失败的原因；此时 `stage`、`rule`、`next` 为 `null`，其他变更照常推导 |

- `archived` 只有 `name` 与 `date`（目录名不是 `YYYY-MM-DD-<名称>` 时 `date` 为 `null`）。已归档变更不运行门禁：归档后的提交会让切片证据过期，在已归档变更上运行门禁只会得到假阻断项。
- `next` 是建议，不是指令。签字、变更终点、risk accepted 等只能由用户决定的动作，下一步只写「人工……」，agent 不代做。
- 已归档变更交付了什么，看完成清单（skill `openspec-change-recap`，`/opsx:recap`），本视图不汇总。

## 不负责

- HTML 页面、常驻服务、自动刷新、团队共享、推送云舟。
- 判断 verify 是否通过、修改任何门禁的阻断规则。
- 其他项目的变更：只看 `openspec list --json` 给出的当前项目根。
