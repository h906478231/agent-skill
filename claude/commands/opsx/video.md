---
name: "OPSX: Video"
description: 按人工要求为含变更模型的变更生成讲解视频 - 编写分镜、检查、人工签署后渲染配音与中文字幕
allowed-tools: Bash(openspec:*)
category: Workflow
tags: [workflow, video, explainer]
---

按人工要求为一个 OpenSpec 变更的单一主题生成讲解视频。视频不进入默认流程、卡点或归档检查。

**Input**: `/opsx:video <change> [focus]`。省略变更名时从对话上下文推断；模糊或有多个候选时运行 `openspec list --json` 并用 **AskUserQuestion** 让用户选。始终声明 "Using change: `<name>`"。没有 focus 且无法从明确请求中确定时，用 **AskUserQuestion** 询问。

## 执行

加载 skill **`openspec-explainer-video`**，按其中的流程执行，不要在本文件里另行定义规则。分镜格式、镜头动作、检查与签署规则的唯一事实源是该 skill 的 `shared/storyboard.md`（skill 安装目录随 agent 变化，**不要写死绝对路径**）。

关键约束（详见 skill）：

- 先运行变更模型布局；没有变更模型或检查不通过时停止，不写分镜。
- AI 只编写分镜，不编写 Manim 代码；签署行只写 `Storyboard Approved: ____`，**不得代签**。
- 分镜检查通过但未签署时停止，等待用户审阅并手工签署；签署后修改分镜代码块会使签署失效。
- 渲染前运行 `doctor`；缺失依赖时只显示安装指引，不自动安装。
- 分镜选择 `tts: edge` 时，每次增加 `--allow-online-tts` 前都用 **AskUserQuestion** 询问，并写明「旁白文本将离开本机，发送到微软 Edge 在线语音服务」。用户未确认时不渲染。

## 产物

- `<changeRoot>/video/storyboard.md`、`<changeRoot>/video/explainer.srt`：提交 git。
- `<changeRoot>/video/media/`：音频、视频与 Manim 缓存，不进 git；项目 `.gitignore` 应包含 `openspec/changes/*/video/media/`。

## 关联

- 上游：`design.md` 的变更模型；skill `openspec-change-overview` 的并集布局。
- 本命令只在人工调用时运行，不属于 `/opsx:propose`、`/opsx:apply`、`/opsx:quality`、`/opsx:verify` 或 `/opsx:archive` 的默认链路。
