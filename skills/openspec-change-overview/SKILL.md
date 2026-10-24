---
name: openspec-change-overview
description: 为一个 OpenSpec 变更生成单页总览 overview.md，把分散在 proposal/design/specs/tasks/review 中的信息汇成文档地图、端到端运行流程、字段变更台账、规则条件可追溯矩阵与未决问题。用于回答「规则条件有没有遗漏」「整体运行流程与过程中的字段怎么变」两类问题；按需入口：L2/L3 或字段与规则条件较多的变更推荐在 design 定稿后、门禁出结论后刷新（verify 直接核对 review-summary.md 的条件，不要求刷新总览），L0/L1 不要求（分级行只需一行，不必为它生成总览）。由一个子 agent 整体生成，主会话只接收结论。
---

# OpenSpec 变更总览（Change Overview）

## 解决什么问题

一个变更的信息散在四到五份文档里：`proposal.md` 说为什么做，`design.md` 说怎么做，`specs/*/spec.md` 说行为契约，`tasks.md` 说做哪些活，`review-summary.md` 说评审卡在哪。单看任何一份都回答不了两个高频问题：

1. **规则条件有没有遗漏** —— 验收条件、spec scenario、design 约束、评审「有条件通过」的条件，四处来源没有一个统一的核对点。
2. **整体运行流程与过程中的字段变更是什么** —— 数据从入参走到落库再走到出参，中间改了几次名、转了几次类型，没有一处能一眼看全。

本 skill 产出 `openspec/changes/<name>/overview.md` 回答这两问。

## 铁律

- **overview.md 是派生视图，不是事实源**。事实源永远是 `proposal.md` / `design.md` / `specs/*/spec.md` / `tasks.md` / `review-summary.md`。
- **整体重新生成，禁止手改**。发现内容不对，改事实源再重跑本命令。手改会造成两处不一致，且下次重跑被覆盖。`overview.html` 与第 2 块标记之间的 Mermaid 同样只由脚本生成。
- 生成的文件头必须带这段声明：

  ```markdown
  > 本文件由 `/opsx:overview` 生成，**请勿手动编辑**。
  > 事实源：proposal.md / design.md / specs/*/spec.md / tasks.md / review-summary.md。
  > 内容有误请改事实源后重新运行 `/opsx:overview <change>`。
  > 最近生成：<日期> ｜ 依据轮次：<如 R2>
  > 分级：<L0 豁免 / L1 / L2 / L3，或方案类型 MVP> ｜ 判定人：<人或 agent> ｜ 日期：<YYYY-MM-DD> ｜ 依据：<命中信号或豁免理由>
  ```

- **分级行是长期记录，重跑必须保留**。该行由分级判定产生（规则见 `../openspec-technical-review/shared/gate-levels.md`），不是从事实源推导的内容：重跑时从原 `overview.md` 原样搬过来；原文件没有该行且变更未做分级判定时，写 `> 分级：未判定 ｜ 判定人：— ｜ 日期：— ｜ 依据：—`，不要凭空补一个等级。分级行沿用 `gate-levels.md` 规定的写法（等级或方案类型 + 命中信号 + 判定人 + 日期），已按其中一种写法写过的原样保留，不要求改写。
- **只为记录分级结论（L0 豁免 / MVP 判定）而存在的 `overview.md` 只需文件头与分级行**，不必跑下面五块生成；这类文件在变更后续走完本命令时，按上一条保留分级行。

- **不臆造**。事实源没写的内容标 `未定义`，不要用常识补全 —— 标出来正是为了暴露缺口。
- **回归结论只写本次引入的失败**。引用切片证据或完整套件结果时，写成「完整回归：PASS_WITH_BASELINE（本次引入的失败：0）」或「完整回归：FAIL（本次引入：<测试名>，修复任务 <编号>）」。**禁止列出基线失败的测试名或数量**（规则见 `../openspec-apply-change/shared/slice-evidence.md`「结果取值」）。

## 前置（主会话）

1. 解析变更名（参数 / 上下文推断 / `openspec list --json` 让用户选）。
2. `openspec status --change "<name>" --json` 取 `changeRoot`。
3. 只为记录分级结论而写的 `overview.md`（见「铁律」）由主会话直接写，不启动子 agent。

## 执行方式：一个子 agent 生成

五块内容要读取全部事实源，读取量大，而主会话需要的结论只有几行。因此由**一个**子 agent 整体生成，主会话只接收结论，不读取 `overview.md` 全文。做法与 `/opsx:review`、`/opsx:quality` 的子 agent 相同：子 agent 把结果写入固定文件，只向主会话返回结论。

1. 主会话从原 `overview.md` 只取分级行（以 `> 分级：` 开头的一行）。没有原文件或没有该行时，用「铁律」中「未判定」的写法。
2. 用 Agent 工具启动一个子 agent。prompt 包含且只包含：
   - `<SKILL_DIR>`（本 SKILL.md 所在目录）的绝对路径，并说明下文全部 `<SKILL_DIR>/...` 都替换为该值；
   - 变更名与 `changeRoot`；
   - 第 1 步取得的分级行，要求原样写入文件头；
   - 要求：读取 `<SKILL_DIR>/SKILL.md`，按「铁律」与「产出结构」生成；读取存在的全部事实源，`design.md` 缺失时仍生成，并在开头提示「design 未定稿，总览参考价值有限」；只写 `overview.md` 与 `overview.html`，不修改事实源，不运行 git 命令，不向用户提问（未决问题写入第 5 块）；
   - 下面的返回格式。
3. 子 agent 只返回下面几段，段名固定，某段没有内容时写「无」：

   ```markdown
   ## 结果
   已生成 / 已停止：变更模型有阻断项 / 失败：<原因>
   ## 条件统计
   共 N 条条件，未落地 M 条
   ## 未落地的条件
   <条件ID>｜<来源>｜<条件内容，一句>
   ## 无来源的任务
   <任务编号>｜<任务内容，一句>
   ## 未决问题
   <问题>｜<候选选项>
   ## 变更模型阻断项
   design.md:<行号>｜<规则>｜<text>
   ```

4. 结果为「已生成」时，主会话核对，不读取全文：
   - `overview.md` 中「共 N 条条件，未落地 M 条」一行与返回的条件统计一致；
   - 分级行与第 1 步取得的一致；
   - `design.md` 有变更模型时，`overview.html` 存在，并且 `node <SKILL_DIR>/scripts/change-model.mjs check <changeRoot>` 的退出码为 `0`。

   核对不一致时如实告诉用户，不得转述为生成成功；可以重新启动一次子 agent。结果为「已停止」时，按第 2 块的规则逐项列出阻断项，建议 `/opsx:update` 修正后重跑。
5. 主会话向用户报告：文件路径、条件统计（M > 0 时写在第一句）、未落地的条件与未决问题。

- 环境不支持子 agent 时，主会话按同样的要求直接生成，并在输出中写明「主会话执行（环境不支持子 agent）」。
- 子 agent 的结果写入固定文件，不适用 skill `openspec-discussion-sync` 的五段契约。


## 产出结构

子 agent 写入 `<changeRoot>/overview.md`，固定五块。`design.md` 缺失时第 2、3 块多处标 `未定义`。

### 1. 文档地图

一行一个 artifact：

| 文档 | 回答什么问题 | 路径 | 状态 | 是否最新 |
|------|------------|------|------|---------|

- 状态：`已定稿` / `草稿` / `缺失`。
- 是否最新：与 `design.md` 的最后修改时间比较，早于它的标 `可能滞后`。

### 2. 端到端运行流程

先判断 `design.md` 是否有变更模型（`change-model` 代码块，格式见 [shared/change-model.md](shared/change-model.md)）。下文 `<CM>` = `scripts/change-model.mjs`（相对本 SKILL.md）。

**有变更模型时**：图由脚本确定性生成，不手画。

1. 运行 `node <CM> render <changeRoot>`，写入 `<changeRoot>/overview.html`（变更前 / 对比 / 变更后三个视图共用并集布局，可点击查看触发条件、guard、旧值与 Scenario）。
   - 退出码 `1`：变更模型存在阻断项。**停止**，逐项列出 `blocking`（`design.md:行号`、规则、`text`、`detail`），不写 overview.md；建议 `/opsx:update` 修正后重跑。
   - 退出码 `2`：原样报告错误并停止，不得当作通过。
2. 运行 `node <CM> mermaid <changeRoot>`，把输出**原样**插入第 2 块的固定标记之间，一个字符都不改；标记之后附 `overview.html` 链接：

   ```markdown
   <!-- change-model:begin -->
   <mermaid 子命令的输出>
   <!-- change-model:end -->

   交互式对比视图：[overview.html](overview.html)
   ```

3. 图下方用列表补充下面四项标注中图里没有的内容（变更模型只描述状态、迁移与步骤）。

**没有变更模型时**：保持现有行为，用 ASCII 画出这次变更后的实际执行路径（时序图或状态机，取更贴切的一种），不运行 `render`，不创建 `overview.html`。

两种情况都必须标注：

- 每一步的**输入与输出**；
- **同步 / 异步边界**（哪一步之后调用方就返回了）；
- **失败分支**（超时、校验不过、下游异常各走哪条路）；
- **重试与幂等点**（哪一步重复执行是安全的）。

design 里没写失败分支的，画成 `?` 并在第 5 块记为未决问题 —— 这是评审最常漏的地方。

### 3. 字段变更台账

两张表，缺一不可。

**存储侧**（表结构怎么变）：

| 表 | 字段 | 类型 | 新增/修改/废弃 | 写入方 | 读取方 | 默认值与迁移方式 | 来源(design 章节) |
|----|------|------|--------------|--------|--------|----------------|------------------|

- 「默认值与迁移方式」要能回答存量数据怎么办：给默认值 / 回填脚本 / 允许为空。写不出的标 `未定义`。

**链路侧**（同一份数据在链路上怎么改名换形）：

| 外部入参 | DTO 字段 | 领域对象字段 | 表字段 | 出参字段 | 变形说明 |
|---------|---------|------------|--------|---------|---------|

- 「变形说明」标出**改名 / 类型转换 / 单位变化 / 被丢弃 / 被合并**。
- 某一列在链路某段不存在就写 `—`。**被丢弃的字段必须单独成行**，这是排查「值怎么没了」的第一现场。

### 4. 规则条件可追溯矩阵

本节是「规则条件是否遗漏」的直接答案。把四处来源的条件抽成一张表：

| 条件ID | 来源 | 条件内容 | 落在哪个任务或行号 | 实现位置 | 状态 |
|--------|------|---------|-----------------|---------|------|

来源必须覆盖全部四类，一类都不能省：

| 来源标记 | 抽取自 |
|---------|-------|
| `PROP` | `proposal.md` 的验收条件 / 成功判据 |
| `SPEC` | `specs/*/spec.md` 每个 `#### Scenario:` |
| `DESIGN` | `design.md` 的约束、前提、非目标中的硬性条件 |
| `REVIEW` | `review-summary.md` 的「有条件通过」条件清单 |

判定规则：

- 能映射到 `tasks.md` 某一项 → 状态取该任务的勾选情况：`未开始` / `进行中` / `已完成`。
- `REVIEW` 条件只需修改规划产物时，可以映射到该产物的 `<文件>:<行号>`：该行写明了条件 → `已完成`，否则 `未开始`。
- **任务与行号都没有 → 状态标 `⚠️ 未落地`，视同 Blocker**。详见 [Phase 3 技术评审门禁](shared/phase3-gate.md) 中「有条件通过的条件必须落地」规则。
- 表末给一行统计：`共 N 条条件，未落地 M 条`。**M > 0 时在文件开头显著位置写明，不能只藏在表里。**
- 反向也要查一次：`tasks.md` 中存在、但四处来源都追溯不到的任务，列在表下方「无来源的任务」小节 —— 可能是过度实现，也可能是漏写的需求。

### 5. 未决问题与假设

- **未决问题**：事实源里标了 TODO / 待定 / `?` 的点，以及第 2 块画不出的失败分支。每条给出候选选项，便于一次性向用户确认。
- **隐含假设**：生成过程中不得不做的推断（如「未说明则认为同步返回」），逐条列出。**假设被写下来才能被推翻。**

## 刷新时机

本命令是**按需入口**：L2/L3 或字段与规则条件较多的变更，推荐在下列时机各刷新一次；L0/L1 与未生成 `overview.md` 的变更不要求。Verify 不刷新总览，直接核对 `review-summary.md` 的条件清单（见 `../openspec-technical-review/shared/phase6-verification.md`）。

| 时机 | 目的 |
|------|------|
| `design.md` 定稿后首次生成 | 让评审者进门禁前先看懂全貌 |
| 门禁产出 `review-summary.md` 后 | 把「有条件通过」的条件并入第 4 块矩阵 |

每次都整体重新生成。文件头的「依据轮次」要更新为当前门禁轮次。有变更模型时同时重新运行 `render` 与 `mermaid`：`design.md` 改了而 `overview.html` 没重跑，两者就会不一致。

## 目录与第三方许可证

```
openspec-change-overview/
├── SKILL.md
├── shared/change-model.md          # 变更模型格式、6 项检查与卡点处理（唯一事实源）
├── shared/phase3-gate.md
├── scripts/change-model.mjs        # check / layout / render / mermaid，Node.js ≥ 16，无需 npm install
├── assets/overview-template.html   # overview.html 模板（CSS + 原生 JavaScript，无外部资源）
└── vendor/
    ├── elk.bundled.js              # elkjs 0.12.0 原样分发，许可证 EPL-2.0（上游为 EPL-2.0 OR GPL-3.0-or-later，按 EPL-2.0 使用）
    ├── elk.LICENSE.md              # elkjs 许可证原文
    ├── package.json                # 声明 vendor 目录为 CommonJS，保证 elkjs（UMD 包）在任何安装位置都能被 createRequire 加载
    ├── NOTICE                      # 第三方组件的版本、发布包来源、源码地址与 sha256
    ├── js-yaml.mjs                 # js-yaml 5.4.2 原样分发，许可证 MIT
    └── js-yaml.LICENSE             # js-yaml 许可证原文
```

- vendor 中的第三方文件不修改源码；升级版本视为 skill 版本变化（布局结果可能改变）。
- 分发本 skill 时必须保留 `NOTICE`、`elk.LICENSE.md` 与 `js-yaml.LICENSE`。elkjs 是编译产物，EPL-2.0 要求告知取得源码的方式，见 `vendor/NOTICE`。

## 与其他环节的关系

- 上游：`/opsx:explore`、`/opsx:propose` 产出事实源。
- 下游：`/opsx:review` 评审者用它对齐；`/opsx:verify` 用第 4 块做条件核对。
- 下游：讲解视频读取 `node <CM> layout <changeRoot>` 输出的布局 JSON，与 `overview.html` 画面一致。
- 产物（`overview.md`，有变更模型时还有 `overview.html`）随 `openspec archive` 归档到 `changes/archive/<name>/`。本 skill 不执行 `git add` 或 `git commit`。项目 `.gitignore` 忽略 `openspec/` 时，不得用 `git add -f` 加入产物。是否提交由用户决定。
