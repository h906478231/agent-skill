---
name: openspec-explainer-video
description: 按人工要求为含变更模型的 OpenSpec 变更生成讲解视频。只在用户运行 /opsx:video 或明确要求时使用；不在 propose、apply、quality、verify、archive 或其他门禁中自动调用。AI 只编写分镜，不编写 Manim 代码；人工签署分镜后才渲染。
---

# OpenSpec 讲解视频

## 触发边界

- 只在用户运行 `/opsx:video <change> [focus]`，或明确要求生成讲解视频时运行。
- 其他 OpenSpec 命令、卡点、钩子和归档检查不得生成视频，也不得要求视频存在。
- 一个视频只讲一个主题，估算时长不超过 180 秒。
- 只支持含变更模型的变更；变更模型是画面元素与并集布局的唯一事实源。
- AI 只写 `video/storyboard.md` 中的分镜数据，不为单个变更编写或修改 Manim 场景代码。

## 脚本与事实源

下文：

- `<VIDEO>` = `scripts/video.mjs`（相对本 SKILL.md）；
- `<CM>` = `../openspec-change-overview/scripts/change-model.mjs`（相对本 SKILL.md）；
- `<changeRoot>` = `openspec status --change "<name>" --json` 输出的变更目录；
- `<repo>` = 项目根目录。

安装目录随 agent 变化，不得写死绝对路径。先按相对位置解析；读不到时 Glob 搜索 `**/openspec-explainer-video/scripts/video.mjs` 和 `**/openspec-change-overview/scripts/change-model.mjs`。

分镜格式、镜头动作、检查规则、哈希与签署格式的唯一事实源是 [shared/storyboard.md](shared/storyboard.md)。不要在其他文件复制这些规则。

## 执行流程

### 1. 解析输入

1. 解析变更名：显式参数 → 对话上下文 → `openspec list --json`。有多个候选时用 AskUserQuestion 让用户选择。
2. 始终声明 `Using change: <name>`。
3. 运行 `openspec status --change "<name>" --json`，取得 `<changeRoot>`。
4. 解析单一主题：用户传了 focus 就使用；没有传且不能从明确请求中确定时，用 AskUserQuestion 询问。不得自行合并多个主题。

### 2. 在写分镜前检查变更模型

运行：

```bash
node <CM> layout <changeRoot> --repo <repo>
```

- 退出码 `1`：逐项列出 `blocking`，停止；提示先用 `/opsx:update` 修正变更模型。
- 退出码 `2`：原样报告错误并停止。
- 退出码 `0` 但 `machines` 与 `flows` 都为空：停止，不创建 `video/` 或 `storyboard.md`；说明讲解视频需要变更模型。
- 有 machine 或 flow：保留布局 JSON，用其中的图 ID、元素 ID 和连线关系编写分镜。

### 3. 按分镜状态处理

#### 3.1 分镜不存在

1. 读取 [shared/storyboard.md](shared/storyboard.md) 后编写 `<changeRoot>/video/storyboard.md`。
2. 签署行必须写 `Storyboard Approved: ____`。只有用户能签署；AI 不得填写姓名、日期或哈希，不得代签，也不得劝用户跳过。
3. 默认写 `tts: piper`。只在用户已经明确选择在线引擎时写 `tts: edge`；这不等于允许发送旁白，渲染前仍须执行第 5 节的二次确认。
4. 镜头动作只能引用第 2 步布局输出中存在的 ID；不要创建 `scene.py` 或其他单个变更专用的渲染代码。
5. 运行第 4 节检查。

#### 3.2 分镜已存在

- 不覆盖已有分镜。
- 先运行第 4 节检查，并按报告的 `signature` 处理：
  - `unsigned`：显示检查结果并停止，等待人工签署。
  - `stale`：说明分镜代码块在签署后有变化，停止并要求重新审阅和签署。
  - `invalid`：说明签署行格式错误，停止并显示正确格式。
  - `signed`：继续第 5 节。
- 用户明确要求修改分镜时才编辑。修改代码块会使签署失效；编辑后必须重新检查并停止，等待新的人工签署。

### 4. 检查分镜并停在人工签署

运行：

```bash
node <VIDEO> check-storyboard <changeRoot> --repo <repo>
```

- 退出码 `1`：按 `blocking` 修正 AI 编写且未签署的分镜，重跑到退出码 `0`；如果分镜已有人工签署，未经用户明确要求不得修改，报告阻断项后停止。
- 退出码 `2`：原样报告错误并停止。
- 退出码 `0` 且 `signature` 不是 `signed`：输出 `hash`、`estimatedSeconds` 和 `warnings`，请用户审阅分镜，然后按事实源中的格式手工替换 `____`。停止，不运行 doctor，不渲染。
- 退出码 `0` 且 `signature` 为 `signed`：继续第 5 节。

### 5. 检查环境与在线 TTS 二次确认

从已检查的分镜读取 TTS 引擎，运行：

```bash
node <VIDEO> doctor --repo <repo> --tts <piper|edge>
```

- `doctor` 只检查并输出安装指引，不安装软件、不创建环境、不修改 `.gitignore`。
- 退出码 `1`：列出 `missing` 项及 `install` 指引，停止。只有 `gitignore` 为 `warn` 时可以继续，但必须显示告警。
- 退出码 `2`：原样报告错误并停止。

若分镜使用 `tts: edge`，每次准备增加 `--allow-online-tts` 前必须用 AskUserQuestion 询问，问题中明确写：

> 旁白文本将离开本机，发送到微软 Edge 在线语音服务。是否允许本次渲染？

- 用户拒绝或没有确认：不增加参数，不渲染。可以建议改回 `tts: piper`；改变分镜后需要重新签署。
- 用户确认：只授权本次渲染，增加 `--allow-online-tts`。先前会话或先前渲染的确认不能复用。

### 6. 渲染与报告

离线 Piper：

```bash
node <VIDEO> render <changeRoot> --repo <repo>
```

已获本次确认的 edge-tts：

```bash
node <VIDEO> render <changeRoot> --repo <repo> --allow-online-tts
```

- 退出码 `1`：报告签署、分镜或在线 TTS 阻断原因并停止。
- 退出码 `2`：原样报告环境或渲染错误并停止。
- 退出码 `0`：报告 `video`、`srt`、实际 `duration`、字幕条数与 `warnings`；打开或给出视频路径，请用户观看确认。
- 不把视频存在当成任何其他 OpenSpec 流程的前提。

## 产物与 Git 边界

| 路径 | 内容 | 是否提交 |
|---|---|---|
| `<changeRoot>/video/storyboard.md` | 分镜与人工签署 | 是 |
| `<changeRoot>/video/explainer.srt` | 可复现的中文字幕 | 是 |
| `<changeRoot>/video/media/` | 音频、mp4、Manim 缓存与渲染输入 | 否 |

项目 `.gitignore` 应包含：

```gitignore
openspec/changes/*/video/media/
```

skill 不自动修改项目 `.gitignore`。`doctor` 发现缺少规则时只告警。

## 依赖安装

运行下面的命令获取本机适用的逐项状态与安装指引：

```bash
node <VIDEO> doctor --repo <repo> --tts piper
# 或检查在线引擎
node <VIDEO> doctor --repo <repo> --tts edge
```

运行环境要求：

- uv；
- Python 3.10～3.12，由 uv 按 `python/uv.lock` 管理；
- Manim Community、manim-voiceover 与选择的 TTS 引擎；
- 带 libass `subtitles` 滤镜的 ffmpeg；
- 中文字体；
- Piper 默认音色 `zh_CN-huayan-medium` 的 `.onnx` 与 `.onnx.json`。

依赖安装到用户缓存目录。`render` 设置 `UV_PROJECT_ENVIRONMENT`，不在 skill 下创建 `.venv`，也不安装系统包。缓存位置可以用 `OPENSPEC_VIDEO_CACHE` 覆盖；Piper 音色名可以用 `OPENSPEC_VIDEO_PIPER_VOICE` 覆盖。

## 第三方许可证

- `piper-tts` 1.8.0：GPL-3.0-or-later。由 uv 安装到用户缓存目录，不随本 skill 分发。
- `edge-tts` 7.2.8：LGPLv3。由 uv 安装到用户缓存目录，不随本 skill 分发。
- `manim` 0.19.2、`manim-voiceover` 0.3.7：MIT。由 uv 安装到用户缓存目录，不随本 skill 分发。
- `vendor/js-yaml.mjs`：js-yaml 5.4.2，MIT，随本 skill 分发。分发本 skill 时必须保留 `vendor/js-yaml.LICENSE`。
- Piper 音色模型的许可证以上游音色说明为准；使用前由用户核对，不把模型打包进本 skill。

## 与其他步骤的关系

- 上游：变更的 `design.md` 提供变更模型；`openspec-change-overview` 提供并集布局。
- 本命令是人工按需产物，不属于 propose、review、apply、quality、verify、archive 的默认链路。
- `storyboard.md` 与 `explainer.srt` 随变更归档；`video/media/` 不进 git。
