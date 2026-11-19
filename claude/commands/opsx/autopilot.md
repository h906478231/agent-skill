---
name: "OPSX: Autopilot"
description: 托管 - 签字后把变更交给本机调度脚本按进度规则运行 apply 到 archive，提问与出口动作经飞书卡片确认；--cancel 撤回，--status 查看
allowed-tools: Bash(node:*)
disable-model-invocation: true
category: Workflow
tags: [workflow, autopilot]
---

把一个已签字（或分级不需要编码前评审）的 OpenSpec 变更交给托管，或撤回、查看托管。

**Input**：`/opsx:autopilot <变更名>` 交给托管；`/opsx:autopilot <变更名> --cancel` 撤回；`/opsx:autopilot <变更名> --status` 查看。

## 执行

加载 skill **`openspec-autopilot`**，按其中的「命令」一节在项目目录中运行 `autopilot.mjs`（`start`、`cancel` 或 `status`），不要在本文件里另行定义规则（skill 安装目录随 agent 变化，**不要写死绝对路径**）。

关键约束（详见 skill）：

- 原样显示脚本输出与退出码，不改写；被拒绝时按输出中的原因在会话中处理，不绕过前置条件。
- 不代替用户签字，不修改 `decisions/` 下的文件。
- 交接成功后提醒用户：托管期间不要在同一仓库中修改文件。

## 关联

- 托管不运行 explore、grill、propose、review、update；签字仍在会话中手写。
- 当前进度：`/opsx:progress`。
