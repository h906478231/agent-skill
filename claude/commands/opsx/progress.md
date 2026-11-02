---
name: "OPSX: Progress"
description: 进度视图 - 当前项目每个活跃变更的分级、阶段、任务勾选数、待决定条数、卡点与下一步命令；已归档变更只列名称与日期
allowed-tools: Bash(openspec:*), Bash(node:*)
category: Workflow
tags: [workflow, progress, status]
---

为当前项目的每个活跃 OpenSpec 变更列出阶段、卡点与下一步命令，用于会话开始或接续变更前。

**Input**：不带参数。`/opsx:progress --json` 时输出 JSON（供 agent 读取）。

## 执行

加载 skill **`openspec-change-progress`**，按其中的「脚本」一节运行 `progress.mjs`，不要在本文件里另行定义规则。推导规则的唯一事实源是该 skill 的 `scripts/progress.mjs` 中的 `RULES` 常量（skill 安装目录随 agent 变化，**不要写死绝对路径**）。

关键约束（详见 skill）：

- 在项目目录中运行，原样显示脚本输出，不改写，不另做推导。
- 退出码为 `2` 时原样告诉用户原因：找不到门禁脚本时按 skill 用 Glob 搜到后用 `--gate` 重跑一次；门禁脚本不支持 `facts` 时提示同步 `openspec-technical-review`，同步前先问用户。
- 只读：不写变更目录，不运行写入 git 的命令。

## 关联

- 本命令是旁路，不属于任何阶段或卡点，不阻断任何流程。
- 已归档变更交付了什么：`/opsx:recap`。
