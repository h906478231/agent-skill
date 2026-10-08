## Context

- 现状：`openspec-change-overview` 第 2 块用 ASCII 画变更后的流程，没有变更前的对照，也没有和 Scenario 的关联。
- 先例：`ddd-event-storm-visualizer` 使用「模板 + JSON 数据」渲染 HTML，但 v2 模板在运行时从同目录加载 JSON，用 `file://` 打开时会被浏览器拦截。本变更沿用「模板 + 数据」的分离方式，但把数据内联进单个文件。
- 已定决策：grill 共识 Q5、Q12～Q15；ADR-0004（变更模型为事实源、并集布局、放弃 Mermaid / Graphviz / D2 / archify）。
- 前置：`add-ste-gate` 提供禁用别名检查与四个卡点的接入位置。
- 下游：`add-explainer-video` 读取本变更的布局 JSON。

## Goals / Non-Goals

**Goals:**

- 变更模型是状态图与流程图的唯一事实源，图由脚本确定性生成。
- 前后对比使用并集布局，切换视图时未变元素不移动。
- 新增或修改的迁移与步骤必须挂 Scenario，否则阻断。
- `overview.html` 离线可用，单个文件，提交 git。

**Non-Goals:**

- 不包含时序图、字段变更、代码映射（Q12）。时序图继续在 design.md 中直接写 Mermaid `sequenceDiagram`。
- 不解析 Mermaid，不从 Mermaid 反向生成变更模型。
- 不提供在线编辑；HTML 只读。
- 不追溯为历史变更生成变更模型。

## 可视化判定

- 状态变动：未命中（本变更不新增或修改状态机）
- 流程变动：命中 → flows: generate-overview

```change-model
version: 1
flows:
  - id: generate-overview
    name: 生成变更总览
    steps:
      - { id: F1, name: 读取事实源 }
      - id: F2
        name: 判断是否有变更模型
        kind: decision
        diff: added
        scenarios:
          - change-model-rendering/Overview with a change model
          - change-model-rendering/Overview without a change model
      - id: F3
        name: 运行变更模型检查
        diff: added
        scenarios: [change-model-rendering/Blocking finding exists]
      - id: F4
        name: 计算并集布局并写入 overview.html
        diff: added
        scenarios: [change-model-rendering/No external resources]
      - id: F5
        name: 写入 overview.md
        diff: changed
        before: { name: 写入 overview.md（第 2 块为 ASCII 流程） }
        scenarios: [change-model-rendering/Overview with a change model]
      - id: F6
        name: 停止并报告阻断项
        diff: added
        scenarios: [change-model-rendering/Blocking finding exists]
    edges:
      - { from: F1, to: F5, diff: removed }
      - { from: F1, to: F2, diff: added }
      - { from: F2, to: F3, label: 有, diff: added }
      - { from: F2, to: F5, label: 无, diff: added }
      - { from: F3, to: F4, label: 通过, diff: added }
      - { from: F3, to: F6, label: 阻断, diff: added }
      - { from: F4, to: F5, diff: added }
```

## Decisions

### 1. 文件归属：放进 `openspec-change-overview`

```
skills/openspec-change-overview/
├── SKILL.md                       # 修改：第 2 块与 overview.html 的生成步骤
├── shared/change-model.md         # 新增：格式说明、字段表、完整示例、6 项检查（唯一事实源）
├── scripts/change-model.mjs       # 新增：check / layout / render / mermaid 四个子命令
├── assets/overview-template.html  # 新增：HTML 模板（CSS + JS，数据占位）
└── vendor/
    ├── elk.bundled.js             # elkjs 0.12.0，EPL-2.0，原样内置
    ├── elk.LICENSE.md             # elkjs 许可证原文
    ├── js-yaml.mjs                # js-yaml 5.4.2，MIT，原样内置
    ├── js-yaml.LICENSE            # js-yaml 许可证原文
    ├── package.json               # 声明 vendor 目录为 CommonJS
    └── NOTICE                     # 第三方组件的版本、发布包来源、源码地址与 sha256
```

- 渲染结果属于变更总览，放进 overview skill，不创建新 skill。
- `openspec-propose` 用相对路径 `../openspec-change-overview/shared/change-model.md` 引用格式说明，读不到时 用 Glob 后备查找。
- js-yaml 在 `openspec-ste` 中也有一份。这里另存一份，让本 skill 在未安装 `openspec-ste` 时仍能解析变更模型。
- elkjs 是 UMD 包，脚本用 `createRequire` 加载。CLAUDE.md 禁止 CommonJS 的规定只针对 Workflow 运行环境，不影响 Node 脚本。
- `vendor/package.json` 声明 `"type": "commonjs"`：skill 安装位置的上级目录可能有 `"type": "module"` 的 package.json，没有这个声明时 `elk.bundled.js` 会按 ES 模块加载而失败。
- elkjs 是编译产物，EPL-2.0 要求说明取得源码的方式，因此 `vendor/NOTICE` 写明版本、发布包来源、源码地址与 sha256（实现期回记，来自 `/opsx:quality` 第 1 轮 STD-01）。

### 2. 格式要点

字段以 `shared/change-model.md` 为准，这里只列关键规则：

| 元素 | 必填 | 可选 |
|---|---|---|
| machine | `id`、`name`、`states`、`transitions` | — |
| state | `id`、`name` | `initial`、`final`、`diff`、`before` |
| transition | `id`、`from`、`to`、`trigger` | `guard`、`diff`、`before`、`scenarios` |
| flow | `id`、`name`、`steps`、`edges` | — |
| step | `id`、`name` | `actor`、`kind: decision`、`async`、`causes`、`diff`、`before`、`scenarios` |
| edge | `from`、`to` | `label`、`diff`、`before` |

- `before` 只写被修改的字段旧值。
- Scenario 引用格式为 `<capability>/<scenario name>`，按变更目录 `specs/<capability>/spec.md` 中 `#### Scenario:` 后的文本精确匹配。

### 3. 检查算法（`check` 子命令）

1. 从 design.md 提取全部 `change-model` 代码块；多于 1 个时报 schema 阻断。
2. 解析 YAML，按 schema 校验，检查 ID 唯一与引用存在（规则 1）。
3. 收集 `name` / `trigger` / `guard` / `label`，按行传给 `ste-lint.mjs text`（规则 2）。找不到 `openspec-ste` 时跳过并告警。
4. 扫描 `specs/**/spec.md` 创建 Scenario 索引，检查 `added` / `changed` 的迁移与步骤（规则 3）。
5. 检查 `changed` 是否有 `before`（规则 4）。
6. 解析「可视化判定」小节：每行格式为「状态变动 / 流程变动：命中 → machines|flows: <id 列表>」或「…：未命中」，两种行的末尾都可以用括号写备注，备注不参与 ID 解析。与模型双向比较（规则 5）。design.md 存在即要求该小节，不依赖变更等级，原因是 propose 阶段还没有等级。
7. 检查未删除的迁移与边是否指向已删除元素（规则 6）。

输出 JSON 与退出码与 `ste-lint.mjs check` 一致。

实现期回记的细节：

- 规则 1 不通过时模型结构不可信，规则 2、3、4、6 不执行；规则 5 照常执行，以减少修正轮次。
- 规则 2 只把 STE 的阻断项转为规则 2 阻断项；STE 告警中只转发环境告警（如缺少术语表），句长、名词串等告警不转发，原因是名称是短语而不是句子。`before` 中的旧值不送检，旧叫法正是被改掉的内容。
- `--repo <dir>` 指定项目根（读取 CONTEXT.md），缺省为 `changeRoot` 的上三级，与 `ste-lint.mjs check` 相同。

### 4. 并集布局（`layout` 子命令）

- 每个 machine 和 flow 独立布局。输入为全部元素（含 `removed`），按 ID 排序。
- 使用 ELK `layered` 算法，方向从上到下，固定 `elk.randomSeed`，固定节点尺寸计算规则（按名称字数）。
- 输出布局 JSON：节点坐标与尺寸、边的路径点与标签位置、`diff`、`before`、`causes`、`scenarios`。
- 视图切换只改变元素的显示与样式，不重新布局。

### 5. HTML 渲染（`render` 子命令）

- 先运行 `check`，退出码非 0 时不写任何文件。
- Node 端根据布局 JSON 生成 SVG 字符串；模板中的 CSS 与原生 JavaScript 负责视图切换与点击交互。
- 布局 JSON 以 `<script type="application/json">` 内联，SVG 内联，不引用任何外部资源。
- 颜色约定：新增绿色、修改黄色、删除红色虚线；连线同样着色。
- 选中元素时，侧栏显示触发条件、guard、`before` 旧值、Scenario 引用；通过 `causes` 联动高亮另一张图中的元素。

### 6. 派生 Mermaid（`mermaid` 子命令）与 overview 集成

- machine 输出 `stateDiagram-v2`：变动状态用 `classDef` 着色，迁移标签加 `➕` / `✏️` / `❌` 前缀。
- flow 输出 `flowchart TD`：节点用 `classDef` 着色，连线用 `linkStyle` 着色。
- `openspec-change-overview` 有变更模型时：运行 `render`，把 `mermaid` 输出原样插入 overview.md 第 2 块的固定标记之间（`<!-- change-model:begin -->` / `<!-- change-model:end -->`），并附 `overview.html` 链接。没有变更模型时保持现有 ASCII 行为。

### 7. 卡点接入

在 `add-ste-gate` 定义的四个卡点上，紧接 STE 检查运行 `change-model.mjs check`，阻断行为相同。

## 候选方案交叉验证矩阵

| 维度 | 方案 MVP：design.md 直接写 Mermaid | 方案 A：变更模型 + elkjs 并集布局 + 纯 SVG（推荐） | 方案 B：Mermaid + 内联 mermaid.js 交互 | 方案 C：archify 编写 |
|---|---|---|---|---|
| **成本** | 0.5 人日 | 6～8 人日 | 4 人日 | 每次生成都由 LLM 编写，运行成本高 |
| **性能** | 无渲染 | 渲染 < 2 秒；HTML 几十 KB | 浏览器端渲染；HTML 约 3MB | 多视口校验循环，分钟级 |
| **复杂度** | 低 | 中：schema、布局、SVG、交互 | 中：依赖 Mermaid 内部 DOM | 低开发，高运行 |
| **风险** | 迁移线不能着色；前后布局不同；无法校验 Scenario 覆盖 | LLM 需学新格式（schema + 示例 + 检查后备） | Mermaid 升级会破坏交互；前后布局不同 | 结果不确定，不保留差异着色 |
| **可测试性** | 不可测 | 高：CLI 输出可断言、可比较字节 | 低：需浏览器 | 低 |
| **视频复用** | 否 | 是：布局 JSON | 否 | 部分（WebM 动画，没有旁白） |
| **上线时间** | 1 天 | 2～3 周 | 1～2 周 | — |

### 推荐方案及决策依据

- **推荐**：方案 A。
- **决策依据**：
  1. 并集布局是「看出改了什么」的关键，只有自己控制布局才能保证前后坐标一致。
  2. 结构化模型可以机械检查 Scenario 覆盖，直接暴露方案中遗漏的分支。
  3. 布局 JSON 同时供 HTML 与讲解视频使用，画面一致。
- **为什么不选 MVP**：迁移线不能着色，不能做前后对比，不能检查 Scenario 覆盖，不解决底层问题。
- **为什么不选方案 B**：前后两次渲染布局不同；交互依赖 Mermaid 内部 DOM，版本升级即失效；离线体积约 3MB。
- **为什么不选方案 C**：结果不确定，图本身需要人工审核，违背「图不增加审核负担」的前提（ADR-0004）。
- **回溯第一性原理**：底层问题是「开发者看不出改了什么，也不知道变动是否被 Scenario 覆盖」。方案 A 用并集布局显示差异，用检查保证覆盖。

## 测试 Seam 决策

### 选定的 Seam

| Seam | 类型 | 覆盖的行为 |
|---|---|---|
| `node change-model.mjs check <changeRoot>` | CLI（JSON + 退出码） | 6 项检查、可视化判定、STE 跳过告警 |
| `node change-model.mjs layout <changeRoot>` | CLI（JSON） | 并集布局、确定性、布局 JSON 字段 |
| `node change-model.mjs render <changeRoot>` | CLI（写文件） | 拒绝无效模型、离线单文件、内联数据 |
| `node change-model.mjs mermaid <changeRoot>` | CLI（文本） | 派生 Mermaid 的着色与前缀 |
| `overview.html` 浏览器打开 | 人工验证 | 视图切换、点击侧栏、`causes` 联动 |
| `/opsx:overview`、四个卡点 skill 入口 | 提示词流程 | overview 集成与卡点调用 |

### 为什么是这些 Seam

- 四个 CLI Seam 沿用 `implementation-gate.mjs` 的测试写法，新增 `scripts/test-change-model.mjs`，在临时目录构造变更。
- 浏览器交互没有现成的自动化测试设施，引入浏览器测试框架的成本大于收益。交互由人工打开本变更生成的 `overview.html` 验证。
- skill 入口是提示词，用本变更自身的 design.md（含变更模型）做实际运行验证。

### 每个验收行为挂哪个 Seam

- 6 项检查、Scenario 引用格式、可视化判定、STE 跳过 → `check`
- 并集布局坐标一致、两次输出相同、布局 JSON 字段 → `layout`
- 无效模型不写文件、无外部 URL、内联数据 → `render`
- Mermaid 着色与前缀 → `mermaid`
- 视图切换、侧栏、`causes` 高亮 → 浏览器人工验证
- overview.md 嵌入、无模型保持 ASCII、卡点调用 → skill 入口实际运行

## Risks / Trade-offs

- [LLM 编写的变更模型格式出错] → `shared/change-model.md` 给出完整示例；检查报告精确到字段，AI 按报告修正。
- [ELK 版本升级改变布局] → elkjs 原样内置并固定版本；升级视为 skill 版本变化。
- [节点名称很长导致布局拥挤] → 节点宽度按字数计算并设上限，超出部分换行；名称本身受 STE 句长约束。
- [elkjs 为 EPL-2.0] → 原样分发并保留 LICENSE，不修改源码；在 SKILL.md 中写明许可证。
- [流程中的 decision 节点太多导致图过宽] → 第一版接受；在 Open Questions 中记录。
- [overview.html 与 design.md 不一致] → overview.html 只由 `render` 生成，禁止手改；design.md 修改后重跑 `/opsx:overview`。

## Migration Plan

1. 先完成 `add-ste-gate`。
2. 发布 `openspec-change-overview` 的新增脚本、模板、vendor 与 SKILL.md 修改；发布四个卡点与 `openspec-propose` 的 design 编写说明修改。
3. 历史变更与在途变更：没有 design.md 的变更不要求可视化判定；没有变更模型的变更保持 ASCII 流程。
   - 已归档的变更不再运行卡点，不受影响。
   - 已有 design.md、尚未归档的在途变更，必须补「可视化判定」小节（命中时同时补变更模型），否则 apply 与 verify 被 CM-5 阻断。本变更上线时已为 `add-dual-axis-review-evidence` 与 `ddd-visualization-data-separation` 补齐（经用户确认）；`add-ste-gate` 与 `add-explainer-video` 原本已有该小节。
4. 回退：删除卡点段落与 overview 的渲染步骤；已生成的 `overview.html` 可以保留，不影响其他产物。

## Open Questions

- 已确认（2026-10-08）：`overview.html` 默认白底，其余元素用低对比度配色，文字字重 500、标题字重 600；不跟随系统深色模式。派生 Mermaid 使用同一套配色。
- 已确认（2026-10-08）：视图切换用标签页（变更前 / 对比 / 变更后）。
- 已确认（2026-10-08）：一个变更包含多个 machine 与 flow 时，全部图纵向排在同一页，顶部放跳转链接。原因：`causes` 跨图联动高亮可以同时看到；一图一页的方案中，被高亮的元素常在看不到的标签页上。
