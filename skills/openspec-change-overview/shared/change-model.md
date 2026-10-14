# 变更模型格式与检查（唯一事实源）

> 变更模型是 design.md 中的 `change-model` 代码块，用结构化数据描述本次变更涉及的状态、迁移与流程步骤及其变动标记。状态图、流程图、`overview.html` 与讲解视频的场景数据都由它确定性生成（ADR-0004）。
> 编写方：`/opsx:propose`、`/opsx:update` 写 design.md 时编写。检查方：`/opsx:propose`、`/opsx:update`、`/opsx:apply`、`/opsx:verify` 四个卡点。渲染方：`/opsx:overview`。
> 脚本 `<CM>` = `../scripts/change-model.mjs`（相对本文件）；其他 skill 用 `../openspec-change-overview/scripts/change-model.mjs` 解析，读不到时 Glob 搜 `**/openspec-change-overview/scripts/change-model.mjs`。运行需 Node.js ≥ 16，不需要 `npm install`。

## 什么时候写

design.md 存在时，必须包含「可视化判定」小节（见下文），逐条声明状态变动与流程变动是否命中：

| 条件 | 命中的判据 | 命中时 |
|---|---|---|
| 状态变动 | 新增、修改或删除状态，或新增、修改、删除状态之间的迁移 | 为每个涉及的状态机写一个 `machines` 条目 |
| 流程变动 | 新增、修改或删除现有流程的步骤、分支或顺序 | 为每个涉及的流程写一个 `flows` 条目 |

判定不依赖变更等级：propose 阶段还没有等级。两条都未命中时，不写 `change-model` 代码块。

一个 design.md 最多一个 `change-model` 代码块。时序图、字段变更、代码映射不属于变更模型：时序图继续在 design.md 中直接写 Mermaid `sequenceDiagram`，字段变更写在 overview.md 第 3 块的字段变更台账。

## 字段

顶层只允许 `version`、`machines`、`flows` 三个键，其他键（如 `sequences`）为 schema 阻断。`version` 固定为 `1`。

| 元素 | 必填 | 可选 |
|---|---|---|
| machine（状态机） | `id`、`name`、`states`、`transitions` | — |
| state（状态） | `id`、`name` | `initial`、`final`、`diff`、`before` |
| transition（迁移） | `id`、`from`、`to`、`trigger` | `guard`、`diff`、`before`、`scenarios` |
| flow（流程） | `id`、`name`、`steps`、`edges` | — |
| step（步骤） | `id`、`name` | `actor`、`kind: decision`、`async`、`causes`、`diff`、`before`、`scenarios` |
| edge（连线） | `from`、`to` | `label`、`diff`、`before` |

字段取值：

| 字段 | 取值 |
|---|---|
| `id`、`name`、`trigger`、`guard`、`label`、`actor` | 非空字符串 |
| `initial`、`final`、`async` | `true` / `false` |
| `kind` | 只能是 `decision`（判断步骤）；普通步骤不写 |
| `causes` | 迁移 ID 列表：本步骤触发的迁移，可指向任一状态机 |
| `scenarios` | Scenario 引用列表，格式见下文 |
| `diff` | `added`（新增）/ `changed`（修改）/ `removed`（删除）；不写表示未变 |
| `before` | 映射，只写被修改的字段旧值；旧值为「无」时写 `null` |

`before` 可以写的字段：

| 元素 | 可写字段 |
|---|---|
| state | `name`、`initial`、`final` |
| transition | `from`、`to`、`trigger`、`guard` |
| step | `name`、`actor`、`kind`、`async`、`causes` |
| edge | `label` |

- 只有 `diff: changed` 的元素可以写 `before`；写了 `diff: changed` 就必须写非空的 `before`。
- 迁移改了 `from` 或 `to` 时，渲染会为旧路线单独画一条线：变更前视图显示旧路线，对比视图把旧路线画成删除样式。
- 连线没有 `id`，以 `from` + `to` 标识，同一流程内不得重复。要改连线的端点，把旧连线标 `removed`，再加一条 `added` 连线。
- 删除的元素保留在模型中并标 `diff: removed`，不要直接删掉：并集布局需要它们来画变更前视图。

ID 唯一范围：

| ID | 唯一范围 |
|---|---|
| machine、flow | 各自在全部状态机、全部流程内唯一 |
| state | 所属状态机内唯一 |
| transition | 全部状态机内唯一（`causes` 跨状态机引用迁移） |
| step | 所属流程内唯一 |

## Scenario 引用

格式为 `<capability>/<scenario name>`：

- `<capability>` 是变更目录 `specs/` 下的目录名；
- `<scenario name>` 与该目录 `spec.md` 中 `#### Scenario:` 后的文本精确匹配（去掉首尾空白）。

例：`specs/order-cancel/spec.md` 含 `#### Scenario: 已支付订单取消后进入退款中`，引用写 `order-cancel/已支付订单取消后进入退款中`。

`added` 与 `changed` 的迁移和步骤必须至少有 1 个 Scenario 引用。未变与删除的元素可以不写；写了的引用同样必须存在。

## 可视化判定小节

design.md 中标题为 `可视化判定` 的小节（任意级别），包含两行列表项，每行一种格式：

```markdown
## 可视化判定

- 状态变动：命中 → machines: order-status
- 流程变动：未命中（本变更不修改现有流程）
```

- 命中：`<条件>：命中 → machines: <ID 列表>`（状态变动）或 `→ flows: <ID 列表>`（流程变动）。ID 之间用 `,`、`，`、`、` 或空格分隔，ID 可以用行内代码包裹。行末可以用括号写备注，如「（四个卡点形态相同，以 propose 为代表）」，备注不参与 ID 解析。
- 未命中：`<条件>：未命中`，后面可以用括号写原因。
- 两行都必须有。声明命中的 ID 必须在模型中存在；模型中的每个状态机与流程都必须被声明。

## 完整示例

订单取消：新增「退款中」状态，修改超时关闭的 guard，删除「已关闭」状态，取消流程触发两个迁移。

````markdown
## 可视化判定

- 状态变动：命中 → machines: order-status
- 流程变动：命中 → flows: cancel-order

```change-model
version: 1
machines:
  - id: order-status
    name: 订单状态
    states:
      - { id: PENDING, name: 待支付, initial: true }
      - { id: PAID, name: 已支付 }
      - { id: REFUNDING, name: 退款中, diff: added }
      - { id: CANCELLED, name: 已取消, final: true }
      - { id: CLOSED, name: 已关闭, final: true, diff: removed }
    transitions:
      - { id: T1, from: PENDING, to: PAID, trigger: 支付成功 }
      - { id: T3, from: PENDING, to: CANCELLED, trigger: 用户取消 }
      - id: T2
        from: PENDING
        to: CANCELLED
        trigger: 超时关闭
        guard: 创建后 30 分钟
        diff: changed
        before: { to: CLOSED, guard: 创建后 15 分钟 }
        scenarios: [order-cancel/超时未支付订单自动取消]
      - id: T5
        from: PAID
        to: REFUNDING
        trigger: 用户取消
        diff: added
        scenarios: [order-cancel/已支付订单取消后进入退款中]
      - id: T6
        from: REFUNDING
        to: CANCELLED
        trigger: 渠道退款成功
        diff: added
        scenarios: [order-refund/渠道退款成功]
flows:
  - id: cancel-order
    name: 用户取消订单
    steps:
      - { id: S1, name: 接收取消请求, actor: 用户 }
      - { id: S2, name: 判断是否已支付, kind: decision, diff: added, scenarios: [order-cancel/已支付订单取消后进入退款中] }
      - { id: S3, name: 关闭未支付订单, causes: [T3] }
      - id: S5
        name: 发起渠道退款
        async: true
        causes: [T5]
        diff: added
        scenarios: [order-cancel/已支付订单取消后进入退款中]
    edges:
      - { from: S1, to: S3, diff: removed }
      - { from: S1, to: S2, diff: added }
      - { from: S2, to: S3, label: 未支付, diff: added }
      - { from: S2, to: S5, label: 已支付, diff: added }
```
````

## 6 项检查（全部阻断）

| 规则 | 阻断条件 | 修正 |
|---|---|---|
| `CM-1` schema 与引用 | 代码块多于 1 个、YAML 解析失败、未知字段、缺少必填字段、取值类型错误、ID 不唯一、`from` / `to` / `causes` / 连线端点 / `before.from` / `before.to` 指向不存在的元素、非 `changed` 元素写了 `before` | 按报告的 `path` 修正该字段 |
| `CM-2` 禁用别名 | `name`、`trigger`、`guard`、`label` 的值含 STE 阻断项（禁用别名、非受控通用词、模糊词） | 改用报告中的 `replacement`；`before` 中的旧值不检查 |
| `CM-3` Scenario 覆盖 | `added` / `changed` 的迁移或步骤没有 `scenarios`，或引用的 Scenario 在变更的 specs 中不存在 | 补引用；Scenario 确实缺失时先在 spec 中补 Scenario |
| `CM-4` 修改必须有旧值 | `diff: changed` 的元素没有 `before` 或 `before` 为空 | 写出被修改字段的旧值 |
| `CM-5` 可视化判定一致 | design.md 没有「可视化判定」小节、缺少某一行、格式错误、声明命中的 ID 在模型中不存在、模型中的状态机或流程没有被声明 | 修正小节或模型，使两者一致 |
| `CM-6` 已删除元素无指向 | 未删除的迁移的 `from` / `to` 指向已删除的状态，或未删除的连线指向已删除的步骤 | 删除或改写该迁移、连线 |

`CM-1` 不通过时模型结构不可信，`CM-2`、`CM-3`、`CM-4`、`CM-6` 不执行，先修正 `CM-1` 再重跑；`CM-5` 照常执行。没有 design.md 的变更不检查（退出码 `0`）。`CM-2` 调用 `openspec-ste` 的 `ste-lint.mjs text`；找不到 `openspec-ste` 时跳过 `CM-2` 并输出告警，其他规则照常执行。

## 命令

```bash
node <CM> check <changeRoot> [--repo <dir>]     # 6 项检查
node <CM> layout <changeRoot> [--repo <dir>]    # 并集布局 JSON（供讲解视频等下游使用）
node <CM> render <changeRoot> [--repo <dir>]    # 写入 <changeRoot>/overview.html
node <CM> mermaid <changeRoot> [--repo <dir>]   # 派生 Mermaid（对比视图），供 overview.md 第 2 块
```

- `--repo` 缺省为 `changeRoot` 的上三级（`<repo>/openspec/changes/<name>`），用于读取 CONTEXT.md。
- `check` 输出一个 JSON 对象 `{ verdict, blocking, warnings, exemptions }`，与 `ste-lint.mjs check` 相同；每个检查项含 `file`、`line`、`rule`、`text`（元素 ID 或命中词）、`detail`，可选 `path`（字段位置，如 `machines[0].transitions[1].scenarios`）、`replacement`、`steRule`。
- `layout`、`render`、`mermaid` 先运行 `check`：检查不通过时输出检查报告并以相同退出码结束，不写任何文件。没有变更模型时，`render` 不写 `overview.html`，`layout` 与 `mermaid` 输出空结果。
- 退出码：`0` 通过；`1` 存在阻断项；`2` 参数或环境错误（变更目录不存在、CONTEXT.md 非法等）。

## 卡点处理

四个卡点在 STE 检查之后紧接运行 `node <CM> check <changeRoot>`，退出码的处理与 STE 检查完全相同：按 `../../openspec-ste/shared/gate-check.md`「各卡点的处理」表中对应卡点的列执行，阻断项的修正方式见上文「6 项检查」表。报告阻断项时写 `design.md:行号`、规则、`text` 与 `detail`。

找不到脚本时（各卡点的引用行自带这条提示）：输出「变更模型检查已跳过：未找到 openspec-change-overview（<原因>）」，不得静默跳过。

## 编写约定

- `overview.html` 只由 `render` 生成，禁止手改；design.md 修改后重跑 `/opsx:overview`。
- 名称写成短语（如「发起渠道退款」），不写句子；名称同样受 STE 规则与 CONTEXT.md 术语约束。
- 讲解视频的分镜只引用变更模型中的元素 ID。
