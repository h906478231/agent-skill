---
name: openspec-change-recap
description: 为已归档的 OpenSpec 变更生成完成清单 recap.md，按新增、修改、删除、修复、没做与遗留 5 类列出事项并写出落点，以已勾选任务、delta specs、切片证据与评审结论为准，proposal 只作参考；并用脚本按主题分组打印跨变更总表。用于回答「这个变更交付了什么、没有交付什么」与「已归档的变更都做了什么」。archive 归档后自动生成；/opsx:recap <变更名> 为旧的归档变更补生成或重新生成；/opsx:recap 不带参数时打印跨变更总表，不调用 LLM。由一个子 agent 生成，主会话只接收结论。
---

# OpenSpec 完成清单（Change Recap）

## 解决什么问题

变更归档后，产物都为门禁编写：proposal、specs、tasks、review、verification 回答「能否进入下一阶段」，不回答「交付了什么」。proposal 的 What Changes 在实现前编写，收口时移出的事项会被误当作已做。没修的 finding、Risk Accepted、待环境补测分散在多份产物与对话中，换会话后丢失。

本 skill 产出两层结果：

- 单个变更的完成清单 `changes/archive/<YYYY-MM-DD>-<变更名>/recap.md`，按 5 类列出事项，`没做与遗留` 是必须有的一节。
- 跨变更总表：`recap.mjs list` 读取全部完成清单的头部字段，按主题分组打印。只打印，不写文件。

## 铁律

- **完成清单是派生视图**。事实源是归档目录中的产物。内容有误时改事实源或重新生成，不手改正文。用户可以修改 `主题` 一行，重新生成时保留。
- **以实际结果为准**。来源、修复的口径与 Finding 状态的读法只按 `shared/recap-format.md`「内容来源」执行；proposal 只作参考。
- **不臆造**。产物没有写出的信息写 `未定义`，不用常识补全。
- **只用于已归档的变更**。未归档的变更没有完成清单。
- **git 边界**：本 skill 不执行 `git add` 或 `git commit`。项目 `.gitignore` 忽略 `openspec/` 时，不得用 `git add -f` 加入产物。是否提交由用户决定。不修改 `.gitignore`，缺少规则时只告警：`recap.mjs check` 的 `warnings` 给出建议规则 `openspec/changes/archive/*/recap.md`，原样显示给用户。

## 格式与脚本

- 文件格式、`分级` 的取值与读法、内容来源：`shared/recap-format.md`（唯一事实源）。
- 脚本 `<RECAP>` = `<SKILL_DIR>/scripts/recap.mjs`（`<SKILL_DIR>` 为本 SKILL.md 所在目录）；读不到时用 Glob 搜 `**/openspec-change-recap/scripts/recap.mjs`。运行需 Node.js ≥ 16，不需要 `npm install`。不调用 LLM，不访问网络，不写文件。

```bash
node <RECAP> check <recapFile>            # 检查一份完成清单的格式与 git 忽略状态
node <RECAP> list <archiveDir> [--json]   # 打印跨变更总表
```

| 子命令 | 输出 | 退出码 |
|---|---|---|
| `check` | JSON `{ verdict, blocking, warnings, gitIgnored, header }`。`header` 的 `change`、`archiveDate`、`tier`、`theme`、`summary` 依次是标题行的变更名、`归档日期`、`分级`、`主题`、`摘要`。`gitIgnored` 为 `true`（已忽略）、`false`（没有被忽略，`warnings` 有一条告警）或 `null`（不在 git 工作区、没有安装 git 或 git 报错） | `0` 通过；`1` 有阻断项；`2` 参数错误或文件不存在。告警不改变退出码 |
| `list` | Markdown 表格；`--json` 输出 `{ total, withRecap, themes, missing }`。头部检查不通过的目录列入「没有完成清单」并写出原因 | `0` 打印完成（有变更没有完成清单时也是 `0`）；`2` 归档目录不存在或参数错误 |

## 入口

| 入口 | 做什么 |
|---|---|
| `/opsx:archive` 第 7 步「归档后：完成清单」 | 归档成功后为刚归档的变更生成完成清单，按下文「生成」执行。失败时不回退归档 |
| `/opsx:recap <变更名>` | 为一个已归档变更生成或重新生成完成清单：先按「名称解析」找到归档目录，再按下文「生成」执行 |
| `/opsx:recap`（不带参数） | 运行 `node <RECAP> list <archiveDir>`，原样显示输出，不启动子 agent |

### 归档目录与名称解析

- 归档目录 `<archiveDir>` = `openspec list --json` 输出的 `root.path` 加 `openspec/changes/archive`。不支持 store。
- 带变更名时，先按归档目录名精确匹配，再匹配 `YYYY-MM-DD-` 前缀之后的部分。
- 匹配到两个及以上目录时，用 AskUserQuestion 让用户选择。用户回答前不写文件。
- 没有归档目录匹配、但有同名的未归档变更（`openspec list --json` 的 `changes`）时，说明完成清单只用于已归档的变更，不写文件。
- 都没有匹配时，报告变更不存在。

## 生成：一个子 agent

生成一个变更的完成清单要读取 6–10 份产物，而主会话需要的结论只有几行。因此由**一个**子 agent 生成，主会话只接收结论，不读取 `recap.md` 全文。

1. 主会话准备：变更的归档目录 `<changeArchive>` 的绝对路径；原 `recap.md` 存在时，只读取它的 `主题` 一行的值（重新生成时保留）。
2. 用 Agent 工具启动一个子 agent。prompt 包含且只包含：
   - `<SKILL_DIR>` 的绝对路径，并说明下文全部 `<SKILL_DIR>/...` 都替换为该值；
   - `<archiveDir>` 与 `<changeArchive>` 的绝对路径；
   - 原 `主题` 值（有时），要求原样写入；
   - 要求：读取 `<SKILL_DIR>/shared/recap-format.md`，按「文件格式」与「内容来源」生成；按下文「主题」选择主题；遵守下文「子 agent 的读写范围」；
   - 下面的返回格式。
3. 子 agent 只返回下面几段，段名固定，某段没有内容时写「无」：

   ```markdown
   ## 结果
   已生成：<recap.md 的路径> / 失败：<原因>
   ## 主题
   <主题值>｜复用 / 新主题 / 保留原主题
   ## 未定义
   <写成「未定义」的字段或落点>
   ## 没做与遗留
   共 N 条
   ```

4. 主会话运行 `node <RECAP> check <changeArchive>/recap.md`，从输出 JSON 的 `header.summary` 读取摘要，不读取 `recap.md` 全文：
   - 退出码 `0`：向用户报告 `recap.md` 的路径与摘要；`warnings` 不为空时原样显示告警与建议规则。
   - 退出码 `1`：把 `blocking` 交给**同一个**子 agent 修正一次，再运行 `check`。仍为 `1` 时按生成失败处理。
   - 退出码 `2` 或子 agent 返回「失败」：按生成失败处理。
5. 生成失败时如实告诉用户，给出 `/opsx:recap <变更名>` 重新生成，不得转述为生成成功。

- 环境不支持子 agent 时，主会话按同样的要求直接生成，并在输出中写明「主会话执行（环境不支持子 agent）」。
- 子 agent 的结果写入固定文件，不适用 skill `openspec-discussion-sync` 的五段契约。

### 子 agent 的读写范围

写法与 `openspec-change-overview` 的子 agent 契约一致。修正一次、主会话直接生成时，范围相同：

- 只创建或覆盖 `<changeArchive>/recap.md`。归档目录中的其他文件只读：归档目录是门禁结论的唯一记录，忽略 `/openspec` 的项目中归档目录不进 git，被修改后无法恢复。
- 除 `node <RECAP> list <archiveDir> --json`（读取已有主题）外不运行命令，不运行 git 命令。列出与读取文件用文件工具（文件读取、Glob 等），不用 `ls`、`cat`、`find` 等 shell 命令。
- 不向用户提问。产物没有写出的信息写 `未定义`。

## 主题

- 子 agent 先运行 `node <RECAP> list <archiveDir> --json`，读取 `themes` 中已有的主题。
- 变更的主要范围与已有主题一致时，使用已有主题；没有一致的主题时，才写新主题。返回的 `## 主题` 一段写明「复用」或「新主题」。
- 重新生成时，原 `主题` 值不为空则原样保留，返回「保留原主题」。用户想换主题时，修改这一行即可。
- 主题发散时（变更数接近主题数），总表的每组变更数会暴露问题，由用户修改主题行。

## 关联

- 上游：`/opsx:archive`（第 7 步调用本 skill 的「生成」）。
- 不进入四个卡点的 STE 检查与变更模型检查，也不阻断归档。
- 团队与云舟任务的说明由 `flows-role-comment` 负责，本 skill 只写给开发者本人回看。
