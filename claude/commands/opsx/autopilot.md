---
name: "OPSX: Autopilot"
description: 托管 - 签字后把变更交给本机调度脚本按进度规则运行 apply 到 archive，提问与出口动作经飞书卡片确认；--cancel 撤回，--status 查看，--pause 暂缓，--resume 恢复
allowed-tools: Bash(node:*)
disable-model-invocation: true
category: Workflow
tags: [workflow, autopilot]
---

把一个已签字（或分级不需要编码前评审）的 OpenSpec 变更交给托管，或撤回、查看托管。

**Input**：`/opsx:autopilot <变更名>` 交给托管；`/opsx:autopilot <变更名> --cancel` 撤回；`/opsx:autopilot <变更名> --status` 查看；`/opsx:autopilot <变更名> --pause <非敏感原因>` 暂缓；`/opsx:autopilot <变更名> --resume` 恢复推进意愿。

## 执行

加载 skill **`openspec-autopilot`**，按其中的「命令」一节在项目目录中运行 `autopilot.mjs`（`start`、`cancel`、`status`、`pause` 或 `resume`），不要在本文件里另行定义规则（skill 安装目录随 agent 变化，**不要写死绝对路径**）。

关键约束（详见 skill）：

- 原样显示脚本输出与退出码，不改写；被拒绝时按输出中的原因在会话中处理，不绕过前置条件。
- 不代替用户签字，不修改 `decisions/` 下的文件，不手改 `change-state.json`。
- 暂缓的原因由用户给出，不代填，提醒用户只写非敏感说明。托管中的变更先撤回再暂缓；恢复后不自动交给托管。
- 交给托管时，已暂缓的历史变更不阻止其他变更，但托管批次、运行锁与未完成核对仍阻止；目标已暂缓时先恢复。拒绝原因为未决出口时提示用户重启后重试，不手改归档托管记录；已加载的服务与当前副本不一致时按输出同步副本，不改服务配置绕过检查。
- 交接成功后提醒用户：托管期间不要在同一仓库中修改文件。

## 关联

- 托管不运行 explore、grill、propose、review、update；签字仍在会话中手写。
- 当前进度：`/opsx:progress`。
