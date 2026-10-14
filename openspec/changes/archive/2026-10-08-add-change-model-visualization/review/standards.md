# Standards Review（add-change-model-visualization）

## 评审基线

- Change: add-change-model-visualization
- Base Commit: f2cb2448a7954549fbb2f4bbc55883db1ac2e19d
- Fingerprint: git-tree:2706d4050ae9b059bd1a041f11c4669fd5503d05
- Review Scope: f2cb2448a795..工作区（含已暂存 / 未暂存 / 未跟踪文件，排除 openspec）
- Baseline Recorded At: 2026-10-08T07:23:12.687Z

## 评审范围与执行记录

- 轮次：第 2 轮（重跑）。上一轮本轴报告基线指纹 `git-tree:e376651…`，结论「有条件通过」，条件为 STD-01。
- 已跟踪改动：`git diff f2cb244`，本变更范围内 11 个文件（5 个 `claude/commands/opsx/*.md`、5 个 `skills/*/SKILL.md`、`package.json`），另有 tasks 5.2 修改的两个在途变更 `openspec/changes/add-dual-axis-review-evidence/design.md`、`openspec/changes/ddd-visualization-data-separation/design.md`。
- 未跟踪新增：`scripts/test-change-model.mjs`、`skills/openspec-change-overview/scripts/change-model.mjs`、`assets/overview-template.html`、`shared/change-model.md`、`vendor/`（`elk.bundled.js`、`js-yaml.mjs` 不评审源码；`NOTICE`、许可证文件、`package.json` 参与评审）、`docs/adr/0004-change-model-as-diagram-source.md`。
- 第 1 轮之后的改动（Slice 05）：`change-model.mjs` 新增 `TRAILING_REMARK`（506-507 行）并在 549 行使用；`test-change-model.mjs` 新增 511-523 行用例；`shared/change-model.md:90` 写明备注规则；新增 `vendor/NOTICE`；`SKILL.md` 目录树与许可证说明引用 NOTICE；两个在途变更的 design.md 补「可视化判定」小节与变更模型。由于新增 2 行，`change-model.mjs` 506 行之后的行号比第 1 轮报告大 2，下文沿用的 finding 已按当前行号更新。
- 不在范围内：`docs/images/`、`docs/pi-mcp-exposure-comparison.md`、`openspec/changes/add-explainer-video/`。
- 测试：运行 `npm test`，全部通过；`test:change-model` 30 个用例全部通过（含 Slice 05 新增用例）。运行前后 `git status --short` 输出一致，测试没有在工作区留下文件。
- 换行符：本轮涉及的新增与修改文件均为 LF，未发现 CRLF。
- vendor 核对：`shasum -a 256` 结果与 `vendor/NOTICE` 中 4 个 sha256 一致；`npm view elkjs@0.12.0 gitHead` 返回 `ff5771d7165445c42c408bb8a090c8035272218c`，与 NOTICE:9 一致。

## 上轮闭环验证

| 历史 finding ID | 结论 | 判断依据 |
|----------------|------|---------|
| STD-01 | 已闭环 | `skills/openspec-change-overview/vendor/NOTICE:5-12` 写明 elkjs 精确版本 0.12.0、npm 发布包地址（:8）、源码仓库与 gitHead（:9，已用 `npm view` 核对一致）、ELK 算法源码地址（:10）、两个文件的 sha256（:11-12，已用 `shasum` 核对一致）；`NOTICE:14-20` 对 js-yaml 写明同样信息；`NOTICE:3` 声明未修改源码。`SKILL.md:153` 目录树列出 NOTICE，`SKILL.md:159-160` 要求分发时保留 NOTICE 并说明 EPL-2.0 源码告知见 NOTICE。打包脚本 `scripts/pack-skill.sh:54` 用 `cp -r` 复制整个 skill 目录，NOTICE 会随包分发。源码获取告知与版本核对事实源均已落地 |
| STD-02 | 未闭环（Minor，未处理） | `change-model.mjs:252` 的 `@returns` 仍为 `{ model, findings }`，357 行实际返回 `elements`、`ids`；函数仍为 249-358 行，未拆分 |
| STD-03 | 未闭环（Minor，未处理） | `change-model.mjs:304-305`、351、470 行仍各自手写元素类型列表，未提取常量 |
| STD-04 | 未闭环（Minor，未处理） | 旧标签与改路线判断仍在 `change-model.mjs:746-747`、895、1010-1013 三处各写一遍 |
| STD-05 | 未闭环（Minor，未处理） | `change-model.mjs:501` 与 503 行仍分别写两个标签；561、567 行仍用三元表达式写死中文名，`KIND_TEXT` 在 849 行 |
| STD-06 | 未闭环（Minor，未处理） | `change-model.mjs:727` 的 `+ 8`、886 行的 `y="-6"`、905 行的 `rx="3"` 仍为裸数字 |
| STD-07 | 未闭环（Minor，未处理） | `change-model.mjs:950-960` 与 `overview-template.html:17-19` 色值仍各写一份，无同步机制或测试 |
| STD-08 | 未闭环（Minor，未处理） | `change-model.mjs:477-480` 未处理 `result.error`，`JSON.parse` 未包 `try/catch` |
| STD-09 | 未闭环（Minor，未处理） | `overview-template.html:219`、226、230 行的旧路线分支仍在；273 行已把旧路线 key 换掉，这些分支仍不会执行 |
| STD-10 | 未闭环（Minor，未处理） | `overview-template.html:279`、285 行仍把 key 原样拼进属性选择器 |
| STD-11 | 未闭环（Minor，未处理） | `docs/adr/0004-change-model-as-diagram-source.md:6` 仍为「变更模型可视化（待创建）」，没有变更名 |

上轮 Minor 未处理与 `evidence/slice-05.md`「剩余风险」中「Minor 未处理；Minor 不阻断」的说明一致，没有假闭环：上轮只把 STD-01 作为条件，其余 Minor 没有声称已修。

## Findings

| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |
|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|
| STD-01 | Major | 分发 openspec-change-overview skill（第三方许可证合规） | skills/openspec-change-overview/vendor/NOTICE:5-20 | `vendor/NOTICE`、`SKILL.md`「目录与第三方许可证」 | 上轮：内置 elkjs 没有写明源码地址与可核对版本。本轮已由 NOTICE 写明版本、发布包、源码地址、gitHead 与 sha256 | 见上轮报告；本轮已核对 NOTICE 与文件、npm 记录一致 | 已闭环，无后果 | 已按建议落地（见「上轮闭环验证」） | closed |
| STD-02 | Minor | 变更模型检查（四个卡点的 check） | skills/openspec-change-overview/scripts/change-model.mjs:249-358 | `checkSchema` | `checkSchema` 一个函数约 110 行，同时做 YAML 解析、顶层键检查、元素遍历、ID 唯一、引用存在、元素索引与 ID 列表，并且注释写的返回值与实际不一致 | 维护场景：给 `checkCoverage` 或 `checkAliases` 加一个依赖元素索引的规则时，读 252 行的 `@returns` 只看到 `{ model, findings }`，看不到 357 行实际返回的 `elements`、`ids`，也看不出 261、264 行的提前返回不带这两个字段 | 后续改动者容易在提前返回分支上读 `schema.elements` 得到 `undefined`；CM-1 新增子规则时难以确认不影响其他规则 | **改哪里**：`checkSchema`。**怎么改**：1. 252 行 `@returns` 改为 `{ model, findings, elements?, ids? }` 并说明提前返回时后两项缺省；2. 拆出 `collectElements`（287-305 行）与 `checkReferences`（307-349 行），`checkSchema` 只负责编排。**为什么**：注释与代码一致，每条 CM-1 子规则有独立位置 | open |
| STD-03 | Minor | 变更模型检查（CM-2 / CM-3 / CM-4 / CM-6） | skills/openspec-change-overview/scripts/change-model.mjs:470 | `checkSchema`（304-305、351 行）、`checkCoverage`（408、420、426、428 行）、`checkAliases`（470 行） | 「状态 / 迁移 / 步骤 / 连线」这组元素类型名在 5 处以上分别手写，没有统一定义 | 维护场景：`version: 2` 新增一种子元素（如泳道 `lanes`）时，304-305 行加了遍历，但漏改 470 行的 `['states', 'transitions', 'steps', 'edges']`，新元素的 `name` 不送 STE 检查，禁用别名静默通过 | 漏改的规则会悄悄不生效，现有测试发现不了 | **改哪里**：`change-model.mjs` 顶部常量区。**怎么改**：定义 `CHILDREN = Object.freeze({ machine: [['states', 'state'], ['transitions', 'transition']], flow: [['steps', 'step'], ['edges', 'edge']] })` 与派生的 `CHILD_KEYS`；304-305、351、470 行改为读该常量。**为什么**：元素类型只在一处声明 | open |
| STD-04 | Minor | overview.html 与 overview.md 第 2 块（迁移旧路线显示） | skills/openspec-change-overview/scripts/change-model.mjs:746-747 | `machineGraph`、`edgeBeforeText`（895 行）、`mermaidMachine`（1010-1013 行） | 「迁移变更前的标签」和「迁移是否改了起点或终点」两段计算在 HTML 布局、HTML 标签、Mermaid 三处各写一遍 | 维护场景：把旧标签格式改为「触发条件 / guard」时，只改了 746 行，895 与 1013 行没改，overview.html 的标签尺寸按新格式算、SVG 文字与 Mermaid 仍是旧格式 | overview.html 与 overview.md 对同一迁移显示的旧标签不一致；尺寸与文字不一致会让文字溢出标签框 | **改哪里**：`transitionLabel`（713 行）附近。**怎么改**：新增 `beforeTransitionLabel = t => transitionLabel(beforeValue(t, 'trigger'), beforeValue(t, 'guard'))` 与 `isRerouted = t => beforeValue(t, 'from') !== t.from \|\| beforeValue(t, 'to') !== t.to`，746-747、895、1010-1013 行改为调用。**为什么**：三个出口共用一个计算 | open |
| STD-05 | Minor | 变更模型检查（CM-5 可视化判定） | skills/openspec-change-overview/scripts/change-model.mjs:503 | `DECISION_ROWS`（501 行）、`DECISION_ROW`（503 行）、`checkDecision`（561、567 行）、`KIND_TEXT`（849 行） | 判定行的两个标签在常量和正则里各写一遍；「状态机 / 流程」的中文名在 561、567 行用三元表达式写死，849 行已有同义常量 `KIND_TEXT` | 维护场景：把「流程变动」改名为「流程改动」时，只改 501 行，503 行正则仍只认旧名，新写法的行被跳过，最终误报「缺少『流程改动』一行」 | 小节格式改名要同步多处，漏改产生误报阻断 | **改哪里**：501-503、561、567 行。**怎么改**：1. `DECISION_ROW` 用 `new RegExp` 由 `Object.keys(DECISION_ROWS)` 拼出；2. `KIND_TEXT` 移到文件前部，561、567 行改为查表。**为什么**：标签与类型名各一个事实源 | open |
| STD-06 | Minor | overview.html 图形绘制 | skills/openspec-change-overview/scripts/change-model.mjs:727 | `labelSize`（727 行 `+ 8`）、`svgNode`（886 行 `y="-6"`）、`svgEdge`（905 行 `rx="3"`） | 文件已把节点尺寸、圆角提取到 `SIZE`、`SHAPE`，但标签内边距 8、异步角标偏移 -6、标签圆角 3 仍是裸数字 | 维护场景：调整连线标签内边距时在 `SIZE` 里找不到对应项，只能全文搜数字 8，容易误改其他 8 | 与 `CLAUDE.md`「不允许裸写魔法值」不一致；调整样式易漏改 | **改哪里**：`SIZE`（642-657 行）与 `SHAPE`（848 行）。**怎么改**：增加 `SIZE.LABEL_PAD_X: 8`、`SHAPE.BADGE_OFFSET_Y: -6`、`SHAPE.LABEL_RADIUS: 3` 并加中文注释，727、886、905 行引用常量。**为什么**：与文件内已有常量化做法一致 | open |
| STD-07 | Minor | overview.html 对比视图与 overview.md 第 2 块 Mermaid 的配色 | skills/openspec-change-overview/scripts/change-model.mjs:950-960 | `MERMAID_CLASSES`、`MERMAID_LINKS`；`assets/overview-template.html:17-19` 的 CSS 变量 | 「新增绿 / 修改黄 / 删除红」色值在脚本和模板各写一份，949 行注释声称「同一套配色」，没有机制保证 | 维护场景：只改模板 19 行的 `--removed`，overview.html 变了，overview.md 中 Mermaid 仍是 `#de8c8c` | 两个视图颜色不一致，需要人工对比才能发现 | **改哪里**：`change-model.mjs:950-960` 与 `overview-template.html:14-20`。**怎么改**：脚本定义唯一 `PALETTE`，Mermaid 常量由它派生，模板 `:root` 色值改为由 `renderHtml` 填充；或至少在 `test-change-model.mjs` 断言模板包含 `MERMAID_CLASSES` 的每个色值。**为什么**：色值一个事实源，或由测试保证同步 | open |
| STD-08 | Minor | 变更模型检查（CM-2 调用 STE） | skills/openspec-change-overview/scripts/change-model.mjs:477-480 | `checkAliases` | 调用 `ste-lint.mjs` 的子进程启动失败或输出不是 JSON 时，报错缺少定位原因 | 输入：`spawnSync` 启动失败时 `result.status` 为 `null`、原因在 `result.error`，478 行只输出「STE 检查失败（退出码 null）：」；或 stdout 混入非 JSON 文字时 480 行抛原生 `SyntaxError`，看不出是哪个脚本的输出出错 | 卡点以退出码 2 停止，使用者看不到真实原因，只能自己重跑排查 | **改哪里**：477-480 行。**怎么改**：1. 消息中加入 `result.error ? result.error.message : stderr`；2. `JSON.parse` 包 `try/catch`，失败时抛 `ModelError`，含 `STE_SCRIPT` 路径与 stdout 前 200 字符。**为什么**：错误信息自带原因与出错脚本 | open |
| STD-09 | Minor | overview.html 侧栏详情 | skills/openspec-change-overview/assets/overview-template.html:219 | 模板脚本 `render`（219、226、230 行）、`select`（273 行） | `render` 中处理「旧路线」的两个分支永远不会执行：`select` 在 273 行已把旧路线 key 换成所属迁移 key，`render` 只由 `select` 调用 | 维护场景：修改「这是该迁移变更前的路线。」提示文字后点击旧路线，看不到任何变化，误以为模板没有重新生成 | 死代码误导维护者 | **改哪里**：`render`。**怎么改**：删除 219 行；226 行三元表达式与 230 行 `item = source` 删除。若要提示「点击的是旧路线」，由 `select` 把原始 key 作为参数传给 `render`。**为什么**：只保留会执行的分支 | open |
| STD-10 | Minor | overview.html 点击选中与联动高亮 | skills/openspec-change-overview/assets/overview-template.html:279 | 模板脚本 `select`（279、285 行） | 选择器把元素 ID 原样拼进 `[data-key="..."]`，ID 含双引号或反斜杠时选择器语法错误，点击直接抛异常 | 输入：状态 ID 写成 `PAY"ING` 或 `A\B`（CM-1 只要求非空字符串），点击该状态时浏览器控制台报 `SyntaxError: Failed to execute 'querySelectorAll'`，侧栏不更新 | 该元素无法查看详情与高亮；不影响其他元素 | **改哪里**：279、285 行。**怎么改**：拼接前用 `CSS.escape(...)` 转义，或遍历 `[data-key]` 比较 `getAttribute('data-key') === key`。**为什么**：选择器不受 ID 内容影响 | open |
| STD-11 | Minor | ADR 追溯 | docs/adr/0004-change-model-as-diagram-source.md:6 | ADR-0004 头部「关联变更」 | 「关联变更」写的是「变更模型可视化（待创建）」，变更已创建，却没有写变更名 | 维护场景：按变更名 `grep add-change-model-visualization` 查 ADR，搜不到 0004 | ADR 与变更的追溯链断开；相邻 ADR-0003、0005 至少写了变更名 `add-ste-gate` | **改哪里**：ADR-0004 第 6 行。**怎么改**：改为「关联变更：变更模型可视化 `add-change-model-visualization`」。**为什么**：与 0003、0005 写法一致，可按变更名检索 | open |
| STD-12 | Minor | 分发 openspec-change-overview skill（第三方组件版本核对） | skills/openspec-change-overview/SKILL.md:151 | `SKILL.md` 目录树注释（151、155 行）、`vendor/NOTICE`（5、14 行） | 第三方组件的版本号在 SKILL.md 目录树注释和 NOTICE 里各写一份，NOTICE 第 3 行只要求升级时更新 NOTICE 本身 | 维护场景：把 elkjs 升级到 0.13.0 时，按 `NOTICE:3`「升级时同步更新本文件的版本、来源与校验和」改了 NOTICE，`SKILL.md:151` 仍写「elkjs 0.12.0」；没有测试核对两处版本 | SKILL.md 与 NOTICE 对同一组件给出不同版本，审计时无法判断哪个可信，削弱 STD-01 建立的「NOTICE 是版本事实源」 | **改哪里**：`SKILL.md:151`、`:155`。**怎么改**：目录树注释去掉版本号，改为「elkjs 原样分发，许可证 EPL-2.0，版本与来源见 NOTICE」「js-yaml 原样分发，许可证 MIT，版本与来源见 NOTICE」。**为什么**：版本只在 NOTICE 一处，升级只改一处 | open |

## 重复率专项

| 位置A ↔ 位置B | 相似行数 | 建议抽取到哪里 |
|---|---|---|
| skills/openspec-change-overview/scripts/change-model.mjs:746-747 ↔ :895 ↔ :1010-1013 | 2-4 行 × 3 处（同一计算） | 同文件 `transitionLabel`（713 行）附近新增 `beforeTransitionLabel`、`isRerouted`（见 STD-04） |
| skills/openspec-change-overview/scripts/change-model.mjs:950-960 ↔ skills/openspec-change-overview/assets/overview-template.html:17-19 | 9 个色值重复 | 脚本内唯一 `PALETTE` 常量，模板由 render 填充（见 STD-07） |
| skills/openspec-change-overview/scripts/change-model.mjs:304-305、351、408、420、426-428、470 | 元素类型列表 6 处 | 顶部 `CHILDREN` 常量（见 STD-03） |
| skills/openspec-change-overview/SKILL.md:151、155 ↔ skills/openspec-change-overview/vendor/NOTICE:5、14 | 2 个版本号 | 只保留在 NOTICE（见 STD-12） |
| skills/openspec-change-overview/assets/overview-template.html:115-120 | 6 行箭头 `marker` 高度相似 | 不抽取：静态 SVG 定义，改用脚本生成会增加复杂度，不开 finding |
| skills/openspec-change-overview/scripts/change-model.mjs:30、152、174、1059-1075、1100-1107 ↔ skills/openspec-ste/scripts/ste-lint.mjs、skills/openspec-technical-review/scripts/implementation-gate.mjs 中的同类工具 | `EXIT`、`escapeRegExp`、`isPlainObject`、`--repo` 解析、入口异常处理，各 1-12 行 | 不抽取：每个 skill 自包含分发（`scripts/pack-skill.sh:54-58` 只复制 skill 目录），跨 skill 引用公共模块会在单独安装时断链；与既有脚本做法一致，不开 finding |
| skills/openspec-change-overview/scripts/change-model.mjs:374-392 ↔ skills/openspec-ste/scripts/ste-lint.mjs 中递归遍历 `specs/` 的代码 | 约 8 行 | 不抽取：理由同上 |
| skills/openspec-{apply-change,propose,update-change,verify-change}/SKILL.md ↔ claude/commands/opsx/{apply,propose,update,verify}.md 的「变更模型检查」段落 | 每处 1 段，共 8 段 | 不抽取：沿用既有「STE 检查」段落在 skill 与 command 中各写一份的约定，规则正文集中在 `shared/change-model.md`，各段只保留卡点差异，不开 finding |
| scripts/test-change-model.mjs:209-211 ↔ :310-312 ↔ :376-378 ↔ :495-497 | 2-3 行 × 4 处（删除 T3 的 `before` 构造阻断模型） | 低于 5 行阈值，可选抽 `modelWithoutBefore()` 夹具；不开 finding |
| scripts/test-change-model.mjs:513-515 ↔ :519-521 | 3 行（Slice 05 新用例中两次拼「可视化判定」小节） | 低于 5 行阈值，且两次输入内容不同；不开 finding |

## 其他审查结论（无 finding）

- **Slice 05 代码改动**：`TRAILING_REMARK`（`change-model.mjs:506-507`）有中文注释说明用途与「不参与 ID 解析」的原因，命名表意，正则提取为常量而非内联；549 行只增加一次 `replace`，未增加嵌套与分支。`shared/change-model.md:90` 写明备注规则，与代码一致。
- **Slice 05 测试**：`test-change-model.mjs:511-523` 通过 CLI `check`（声明的 Seam）观察行为，覆盖中文括号、英文括号两种备注，并验证备注之外的 ID 仍参与比较；期望值为手写的规则编号与 ID，不是重算实现；复用既有 `fixture`、`baseModel`、`findings` 夹具。
- **vendor/NOTICE**：中文说明，逐组件写明文件、许可证、发布包、源码、校验和；`vendor/package.json` 标明为本 skill 自写、不是第三方文件，避免被误认为上游文件。
- **在途变更 design.md（tasks 5.2）**：两处补写的「可视化判定」小节与 `change-model` 代码块格式与 `shared/change-model.md` 一致，对两个变更分别运行 `check` 退出码为 0（见 `evidence/slice-05.md`，本轮未重跑这两个检查）。两处插入位置前多一个空行（`## 可视化判定` 前为两个空行），只影响源文件外观，不影响渲染，不开 finding。
- **测试可维护性**：全部测试通过 CLI 子命令（check / layout / render / mermaid）观察行为，不 mock 内部函数、不测私有方法；临时目录通过 `t.after` 清理。
- **异常处理**：入口区分 `ModelError` 与非预期异常（`change-model.mjs:1103-1106`），没有空 catch 或吞异常。STD-08 是错误信息不完整，不是吞异常。
- **死代码**：脚本内常量、函数、导入都有调用方；模板死分支见 STD-09。
- **项目约定**：无 `console.log` 类调试输出；文件为 UTF-8 + LF；`package.json` 新增 `test:change-model` 并纳入 `test`，与既有 `test:ste` 写法一致。`SKILL.md:165-166` 连续两行以「下游：」开头，可读性稍差但内容不冲突，不开 finding。

## 结论

本轮没有 Blocker，没有 open 的 Major。上轮唯一的条件 STD-01（Major）已闭环：`vendor/NOTICE` 落地，版本、源码地址与 sha256 已核对一致。

open 项为 11 个 Minor（STD-02 至 STD-12，其中 STD-12 为本轮新发现），均不作为通过条件。建议合并为一个整理任务（例如在 `tasks.md` 新增「- [ ] 5.x 处理 Standards Review Minor：STD-02 至 STD-12」），或在后续变更中处理。

Standards Review 结论：通过
