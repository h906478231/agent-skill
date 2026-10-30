---
name: "OPSX: Recap"
description: 为已归档变更生成完成清单 recap.md（新增/修改/删除/修复/没做与遗留）；不带参数时按主题打印跨变更总表
allowed-tools: Bash(openspec:*)
category: Workflow
tags: [workflow, recap, archive]
---

为一个已归档的 OpenSpec 变更生成完成清单，或打印全部归档变更的跨变更总表，回答「交付了什么、没有交付什么」。

**Input**:

- `/opsx:recap <变更名>`：为一个已归档变更生成或重新生成完成清单。`<变更名>` 按归档目录名精确匹配，或匹配 `YYYY-MM-DD-` 前缀之后的部分。匹配到两个及以上目录时用 **AskUserQuestion** 让用户选，用户回答前不写文件。只匹配到未归档的变更时，说明完成清单只用于已归档的变更，不写文件。
- `/opsx:recap`（不带参数）：运行 `recap.mjs list` 打印跨变更总表，原样显示输出，不启动子 agent。

## 执行

加载 skill **`openspec-change-recap`**，按其中的入口、名称解析与「生成：一个子 agent」执行，不要在本文件里另行定义规则。格式与内容来源的唯一事实源是该 skill 的 `shared/recap-format.md`（skill 安装目录随 agent 变化，**不要写死绝对路径**）。

关键约束（详见 skill）：

- 归档目录取 `openspec list --json` 输出的 `root.path` 加 `openspec/changes/archive`。
- **由一个子 agent 生成，主会话只接收结论**：子 agent 只创建或覆盖该变更归档目录中的 `recap.md`，其他归档文件只读，除 `recap.mjs list` 外不运行命令，不运行 git 命令，不向用户提问。
- 主会话运行 `recap.mjs check`，从 `header.summary` 读取摘要，不读取 `recap.md` 全文。退出码为 `1` 时交给同一个子 agent 修正一次，仍为 `1` 时如实报告生成失败。
- 重新生成时保留原 `主题` 值。产物没有写出的信息写 `未定义`。

## 产物

`changes/archive/<YYYY-MM-DD>-<变更名>/recap.md`：派生视图，可以重新生成。本命令不执行 `git add` 或 `git commit`。项目 `.gitignore` 忽略 `openspec/` 时，不得用 `git add -f` 加入产物。是否提交由用户决定。不修改 `.gitignore`，缺少规则时只告警：`check` 的 `warnings` 给出建议规则 `openspec/changes/archive/*/recap.md`，原样显示。

跨变更总表只打印，不写文件。

## 关联

- 上游：`/opsx:archive` 归档后自动生成完成清单（第 7 步）；本命令用于补生成旧的归档变更、生成失败后重新生成，以及打印跨变更总表。
- 本命令不属于四个卡点，不阻断归档。
