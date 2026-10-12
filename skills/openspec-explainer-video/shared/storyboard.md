# 分镜格式、检查与签署（唯一事实源）

> 分镜是讲解视频的结构化脚本 `<changeRoot>/video/storyboard.md`：按段落列出旁白与镜头动作，镜头动作只引用变更模型中的元素 ID。人工签署后才能渲染。
> 编写方：`/opsx:video`（AI 编写分镜数据，不编写 Manim 代码）。检查方：`node <VIDEO> check-storyboard`。渲染方：`node <VIDEO> render`。
> 脚本 `<VIDEO>` = `../scripts/video.mjs`（相对本文件）。变更模型格式见 `../../openspec-change-overview/shared/change-model.md`。

## 文件结构

`video/storyboard.md` 包含三部分，顺序固定：

1. 标题行：`# 讲解视频分镜：<主题>`；
2. 签署行：`Storyboard Approved: ____`（AI 只写占位，不得填写）；
3. 一个 info string 为 `storyboard` 的代码块。代码块之外可以写备注，备注不参与检查与哈希。

## 代码块字段

顶层只允许 `focus`、`tts`、`segments` 三个键。

| 字段 | 必填 | 取值 |
|---|---|---|
| `focus` | 是 | 非空字符串：本视频聚焦的单一主题 |
| `tts` | 否 | `piper`（离线，默认）/ `edge`（在线，需要二次确认） |
| `segments` | 是 | 段落列表，按播放顺序排列，至少 1 段 |
| `segments[].narration` | 是 | 非空字符串：本段旁白，同时作为字幕 |
| `segments[].actions` | 是 | 镜头动作列表，可以为空列表（只播旁白，画面不变） |

一段的动画时长取本段旁白音频的时长：动作按顺序播放，动作播完而旁白未结束时停在最后画面，旁白结束后才进入下一段。

## 镜头动作表

每个动作是只有一个键的映射，键为动作名。

| 动作 | 写法 | 效果 |
|---|---|---|
| `show` | `show: { target: <图 ID>, view: before \| diff \| after }` | 绘制一个状态机或流程的指定视图；当前图换成 `target` |
| `highlight` | `highlight: [<元素 ID>, ...]` | 当前图中的元素放大描边并闪烁 |
| `trace` | `trace: { target: <图 ID>, path: [<节点 ID>, ...] }` | 光点沿路径移动；当前图换成 `target` |
| `morph` | `morph: { target: <图 ID>, from: <视图>, to: <视图> }` | 视图过渡：共有元素不动，变动元素出现、消失或变色；当前图换成 `target` |
| `focus` | `focus: [<元素 ID>, ...]` | 镜头推近到这些元素的包围框；下一个 `show` 或 `morph` 恢复全图，后续 `trace` / `highlight` 的元素不在画面内时也先恢复全图 |

- 图 ID：变更模型中 `machines` 或 `flows` 条目的 `id`。
- 视图：`before`（变更前）、`diff`（对比：新增绿色、修改黄色、删除红色虚线）、`after`（变更后）。三个视图共用并集布局，坐标与 `overview.html` 相同。
- 元素 ID：当前图中的状态 ID、迁移 ID、步骤 ID，或流程连线 `<from>-><to>`（如 `S1->S2`）。
- 当前图：按播放顺序，最近一个 `show`、`trace` 或 `morph` 的 `target`。`highlight` 与 `focus` 只能引用当前图中的元素，所以它们之前必须先有 `show`、`trace` 或 `morph`。
- `trace.path` 至少 2 个节点，相邻两个节点之间必须有一条迁移或连线（方向一致）。
- `morph` 的 `from` 与 `to` 必须不同。当前图不是 `target` 或视图不是 `from` 时，先切到 `from` 视图再过渡。

## 检查规则（`check-storyboard`，全部阻断）

| 规则 | 阻断条件 | 修正 |
|---|---|---|
| `SB-1` 格式 | 没有或多于 1 个 `storyboard` 代码块、YAML 解析失败、未知字段、缺少必填字段、取值类型错误、动作名不在动作表、`view` / `from` / `to` / `tts` 取值错误、`morph` 的 `from` 等于 `to` | 按报告的 `path` 修正 |
| `SB-2` 元素引用 | `target` 不是变更模型中的图 ID；元素 ID 不在当前图中；`highlight` / `focus` 之前没有当前图；`trace` 相邻节点之间没有迁移或连线 | 改用变更模型中存在的 ID，或先 `show` 对应的图 |
| `SB-3` 时长 | 估算时长超过 180 秒 | 删减旁白；一个视频只讲一个主题 |
| `SB-4` 旁白 STE | 旁白含 STE 阻断项（禁用别名、非受控通用词、模糊词） | 改用报告中的 `replacement` |
| `SB-5` 主题 | `focus` 缺失或为空 | 写出本视频聚焦的单一主题 |
| `SB-6` 变更模型 | 变更没有变更模型，或变更模型检查（`change-model.mjs layout`）不通过 | 先补充或修正 design.md 的变更模型 |

- 时长估算：全部旁白中的文字与数字字符数（不含空白与标点）÷ 4，单位为秒。例：旁白共 800 个汉字，估算 200 秒，阻断。
- `SB-1` 或 `SB-6` 不通过时，`SB-2` 不执行（模型或分镜结构不可信）；其他规则照常执行。
- `SB-4` 调用 `openspec-ste` 的 `ste-lint.mjs text`；找不到 `openspec-ste` 时检查以退出码 2 结束，不跳过 `SB-4`。STE 告警（句长等）作为告警转发，不阻断。
- 找不到 `openspec-change-overview` 的 `change-model.mjs` 时，检查以退出码 2 结束：没有变更模型就无法核对元素 ID。

## 签署与失效

- `check-storyboard` 输出 `hash`：代码块内容（不含围栏行，换行统一为 `\n`）的 SHA-256 前 8 位。
- 签署行格式：`Storyboard Approved: <姓名> <日期> <哈希前 8 位>`，例如 `Storyboard Approved: 张三 2026-10-09 3f2a9c1b`。
- 只有人可以签署：审阅分镜与检查结果后，把 `____` 换成上面的格式。**AI 写入 `____` 占位，不得填写、不得代签。**
- `render` 在启动 Python 之前重新计算哈希：

| 签署行 | render 结果 |
|---|---|
| 缺失，或值为空、`____`、`<...>` 占位 | 退出码 1：分镜未签署，不开始渲染 |
| 最后一项不是 8 位十六进制哈希 | 退出码 1：签署行格式错误 |
| 哈希与当前代码块不一致 | 退出码 1：签署后分镜已修改，需要重新签署 |
| 哈希一致 | 继续检查与渲染 |

- 代码块之外的备注不参与哈希：修改备注不使签署失效；修改代码块的任何字符（含空格）都使签署失效。

## 命令

```bash
node <VIDEO> doctor [--repo <dir>] [--tts piper|edge]                     # 依赖自检，只给安装指引
node <VIDEO> check-storyboard <changeRoot> [--repo <dir>]                 # 分镜检查，输出哈希
node <VIDEO> render <changeRoot> [--repo <dir>] [--allow-online-tts] [--quality low|medium|high]
```

- `--repo` 缺省为 `changeRoot` 的上三级（`<repo>/openspec/changes/<name>`），用于读取 CONTEXT.md；`doctor` 缺省为当前目录。
- `check-storyboard` 输出 `{ verdict, blocking, warnings, exemptions, hash, estimatedSeconds, signature }`，检查项字段与 `ste-lint.mjs check` 相同（`file`、`line`、`rule`、`text`、`detail`），另含 `segment`（段落序号，从 1 开始），可选 `path`、`replacement`、`steRule`。`signature` 取值 `unsigned` / `signed` / `stale` / `invalid`，只作提示，签署由 `render` 判定。
- 退出码：`0` 通过；`1` 存在阻断项；`2` 参数或环境错误（变更目录或分镜文件不存在、找不到变更模型脚本等）。

## 完整示例

变更模型见 `change-model.md`「完整示例」（状态机 `order-status`、流程 `cancel-order`）。

````markdown
# 讲解视频分镜：已支付订单取消后的退款

Storyboard Approved: ____

```storyboard
focus: 已支付订单取消后的退款流程
tts: piper
segments:
  - narration: 这是变更前的订单状态。超时关闭的订单进入已关闭状态。
    actions:
      - show: { target: order-status, view: before }
      - highlight: [T2, CLOSED]
  - narration: 本次变更删除已关闭状态，新增退款中状态。
    actions:
      - morph: { target: order-status, from: before, to: after }
  - narration: 用户取消已支付的订单后，系统发起渠道退款，订单进入退款中。
    actions:
      - trace: { target: cancel-order, path: [S1, S2, S5] }
      - highlight: [S5]
```
````
