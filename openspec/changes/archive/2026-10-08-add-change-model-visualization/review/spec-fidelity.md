# Spec Fidelity Review（add-change-model-visualization）

## 评审基线

- Change: add-change-model-visualization
- Base Commit: f2cb2448a7954549fbb2f4bbc55883db1ac2e19d
- Fingerprint: git-tree:2706d4050ae9b059bd1a041f11c4669fd5503d05
- Review Scope: f2cb2448a795..工作区（含已暂存 / 未暂存 / 未跟踪文件，排除 openspec）
- Baseline Recorded At: 2026-10-08T07:23:12.687Z

评审轮次：第 2 轮（上一轮基线指纹 `git-tree:e376651…`，结论「有条件通过」，条件 SPEC-01、SPEC-02）。

评审输入：`git diff f2cb244 -- . ':(exclude)openspec'`（11 个已跟踪文件）+ 未跟踪新增文件 `scripts/test-change-model.mjs`、`skills/openspec-change-overview/{scripts,assets,shared/change-model.md,vendor}`（vendor 只核对引入方式、NOTICE 与校验和，不评审第三方源码）、`docs/adr/0004-change-model-as-diagram-source.md`；另含 tasks 5.2 修改的 `openspec/changes/add-dual-axis-review-evidence/design.md`、`openspec/changes/ddd-visualization-data-separation/design.md`（`git diff f2cb244 -- <path>`）。对照 `proposal.md`、`design.md`、`specs/change-model/spec.md`、`specs/change-model-rendering/spec.md`、`tasks.md`、`evidence/slice-01.md` ~ `slice-05.md`。

实际执行的核对：

| 命令 | 结果 |
|------|------|
| `node skills/openspec-technical-review/scripts/implementation-gate.mjs fingerprint openspec/changes/add-change-model-visualization` | `git-tree:2706d4050ae9b059bd1a041f11c4669fd5503d05`，与基线、`evidence/slice-05.md:7` 一致 |
| `npm test` | 退出码 0；verify 168 条引用可达；15 + 24 + 22 + 41 + 30 个测试全部通过（change-model 30 个，含 Slice 05 新增用例） |
| `node change-model.mjs check` 对 5 个未归档变更（本变更、`add-dual-axis-review-evidence`、`ddd-visualization-data-separation`、`add-ste-gate`、`add-explainer-video`） | 全部 `verdict: PASS`，blocking / warnings 为空，退出码 0（第 1 轮时前三者之外的 `add-ste-gate` 报 5 条 CM-5，两个在途变更缺小节） |
| `shasum -a 256 skills/openspec-change-overview/vendor/*` 与 `vendor/NOTICE:11-12,19-20` 对比 | 4 个 sha256 逐一一致 |
| 评审前后 `git status --short` 对比 | 无变化，测试与核对没有在工作区留下文件 |

## 上轮闭环验证

| 历史 finding ID | 结论 | 判断依据 |
|----------------|------|---------|
| SPEC-01 | 已闭环 | 实现：`skills/openspec-change-overview/scripts/change-model.mjs:506-507` 新增 `TRAILING_REMARK`，`:549` 拆分 ID 前先删除行末括号备注（全角 / 半角）。测试：`scripts/test-change-model.mjs:511-523`「check：命中行末尾的括号备注不当作 ID，与未命中行一致」，覆盖全角与半角备注都通过，以及备注之外的多余 ID `refund-status` 仍报 `CM-5`；本轮实跑通过。回记：`design.md:120`（§3 第 6 步「两种行的末尾都可以用括号写备注，备注不参与 ID 解析」）、`shared/change-model.md:90`。触发场景复核：`openspec/changes/add-ste-gate/design.md:28` 未改（选用方案 A），对其运行 `check` 退出码 0 |
| SPEC-02 | 已闭环 | 回记：`design.md:221-223`（Migration Plan 第 3 条新增子项：已归档变更不受影响；在途变更必须补「可视化判定」小节、命中时补变更模型，否则被 CM-5 阻断；列出已补齐的 2 个变更与原本已有小节的 2 个变更）。落地：`openspec/changes/add-dual-axis-review-evidence/design.md:8-11` 与 `openspec/changes/ddd-visualization-data-separation/design.md:49-52` 新增「可视化判定」小节（流程变动命中，附 `change-model` 代码块）；对两个目录运行 `check` 均 `PASS`，说明小节格式可被解析，且 CM-1/3/4/6 全部通过（Scenario 引用在各自 `specs/` 中存在）。`add-explainer-video/design.md:25-28` 原本已有小节，与 design 描述一致 |
| SPEC-03 | 未闭环 | 第 1 轮为 Minor 建议项，Slice 05 未纳入。`scripts/test-change-model.mjs` 中仍无迁移 `from` / `to` 指向缺失状态、连线端点缺失、未知字段的用例（检索 `MISSING`、`未知字段`、`color` 均无结果）。沿用原 ID，`open` |
| SPEC-04 | 已闭环 | 回记：`design.md:83-87`（§1 目录树补 `elk.LICENSE.md`、`js-yaml.LICENSE`、`package.json`、`NOTICE`）、`design.md:94`（`vendor/package.json` 的原因）、`design.md:125-129`（§3「实现期回记的细节」：CM-1 失败时跳过 2/3/4/6、CM-5 照常执行；STE 告警只转发环境告警；`--repo` 参数）。「测试 Seam 决策」表仍只写 `<changeRoot>`，但 `--repo` 是可选参数且 §3 已写明，不影响 Seam 判定 |

## Findings

| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |
|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|
| SPEC-01 | Major | 变更模型检查 → 可视化判定（propose / update / apply / verify 四个卡点） | skills/openspec-change-overview/scripts/change-model.mjs:506-507,549 | `checkDecision`、`TRAILING_REMARK`；`shared/change-model.md:90`；design.md:120 | 命中行带括号备注时不再把备注拆成流程 ID | 见「上轮闭环验证」 | — | 已落地，测试 `scripts/test-change-model.mjs:511-523` 覆盖 | closed |
| SPEC-02 | Major | 在途变更的 apply / verify / archive | openspec/changes/add-change-model-visualization/design.md:221-223 | design.md Migration Plan 第 3 条；两个在途变更 design.md 的「可视化判定」小节 | 迁移计划已写明在途变更要补小节，并已为两个在途变更补齐 | 见「上轮闭环验证」 | — | 已落地，两个在途变更 `check` 退出码 0 | closed |
| SPEC-03 | Minor | 变更模型检查 → CM-1 schema 与引用 | openspec/changes/add-change-model-visualization/specs/change-model/spec.md:26 | `scripts/test-change-model.mjs` Slice 01 区；实现位于 `change-model.mjs:254-358`（`checkSchema`，迁移 from / to、连线端点、ID 唯一、未知字段与类型） | 规则 1 的几项子要求已实现，但仍没有任何测试或证据覆盖 | 把迁移 `to` 改成不存在的状态、把连线 `to` 改成不存在的步骤、给状态多写一个未知字段 `color`：这三种输入都没有对应用例；`evidence/slice-01.md` 也未列出 | 以后改 `checkSchema` 时这几项退化不会被测试发现；Verify 只核对证据列出的行为，同样发现不了 | **改哪里**：`scripts/test-change-model.mjs` Slice 01 区与 `evidence/slice-01.md`。**怎么改**：补 3 个 `check` 用例：迁移 `to: MISSING` → `CM-1:<迁移 ID>`；连线 `to: S9` → `CM-1:S2->S9`；状态多写 `color` → `CM-1` 并断言 `path`；在 tasks.md 加一个勾选项承载（Minor，不阻断）。**为什么**：需求里每一条 SHALL 都要有可执行的验证 | open |
| SPEC-04 | Minor | 变更模型脚本的分发与调用 | openspec/changes/add-change-model-visualization/design.md:83-87,94,125-129 | design.md §1 目录树、§3「实现期回记的细节」 | 实现中多出的文件、参数与告警过滤已回记 design | 见「上轮闭环验证」 | — | 已回记 | closed |
| SPEC-05 | Minor | 实现后评审 → Slice 05 验收边界 | openspec/changes/add-change-model-visualization/tasks.md:45 | tasks.md Slice 05 `Seam:` 行；design.md:180-206「测试 Seam 决策」；`evidence/slice-05.md:5` | Slice 05 声明了一个「文档类条件人工核对」的验收边界，并写「见 design.md」，但 design 的测试边界表里没有这一项 | tasks.md:45 写 `Seam: ...；文档类条件人工核对（见 design.md「测试 Seam 决策」）`；design.md:184-191 的 Seam 表只有 4 个 CLI、浏览器人工验证与 skill 入口，没有文档人工核对；5.2（Migration Plan 回记、在途变更补小节）与 5.3（`vendor/NOTICE` 与 sha256）实际靠人工核对与 `shasum` 验证，记录在 `evidence/slice-05.md:26-28` | 声明的 Seam 在 design 中找不到，读 tasks 的人按引用去 design 查不到依据；Verify 核对「证据 Seam 与切片声明一致」时只能看到两者自洽，但两者都与 design 脱节 | **改哪里**：design.md「测试 Seam 决策」的 Seam 表与「每个验收行为挂哪个 Seam」，或 tasks.md:45。**怎么改**：二选一：在 design 的 Seam 表补一行「文档与第三方声明（design / shared / NOTICE）｜人工核对 + `shasum`｜评审条件中的文档回记、vendor 来源与校验和」；或把 tasks.md:45 的括号改为只引用已存在的 `check` Seam，并把文档核对写成验收方式而不是 Seam。**为什么**：切片 Seam 必须能在 design 的 Seam 决策中找到，否则 Seam 一致性无从核对 | open |

## 规格覆盖矩阵

`change-model.mjs` 指 `skills/openspec-change-overview/scripts/change-model.mjs`；test 指 `scripts/test-change-model.mjs`。

| Requirement / Scenario | 实现位置 | 验证证据（测试或 evidence 文件） | 状态 |
|---|---|---|---|
| **R: The change model SHALL describe state machines and flows with change markers** | `change-model.mjs:70-90`（ELEMENTS、TOP_KEYS）、`:254-358`（checkSchema）；`shared/change-model.md` 字段表 | test「check：合法模型退出码 0 …」「check：顶层出现 sequences …」；evidence/slice-01.md | 已覆盖 |
| S: Unchanged element | `change-model.mjs` `diffOf`（未写 diff 记为 unchanged） | test「layout：T3 修改时 …」断言 T1 `diff: unchanged`；evidence/slice-01.md | 已覆盖 |
| S: Unsupported section | `change-model.mjs:89-90`、`:254-272` | test「check：顶层出现 sequences 时报 CM-1 schema 阻断」 | 已覆盖 |
| **R: Flow steps SHALL link to the transitions they cause** | `change-model.mjs:325-336` | test「check：步骤 S5 的 causes: [T5] …」 | 已覆盖 |
| S: Step causes a transition | 同上 | 同上；evidence/slice-01.md | 已覆盖 |
| **R: The change-model check SHALL enforce six blocking rules** | 规则 1 `:254-358`；规则 2 `:457-495`；规则 3/4/6 `:406-440`；规则 5 `:516-574`；汇总与退出码 `:584-615`、`:1059` | test 19 个 check 用例；evidence/slice-01.md、slice-05.md | 部分覆盖：规则 1 的迁移 from/to、连线端点缺失、未知字段无测试（SPEC-03） |
| S: Added transition without a scenario | `:406-414` | test「check：新增迁移 T5 没有 scenarios …」 | 已覆盖 |
| S: Scenario reference does not exist | `:414-420` | test「check：T6 引用 order-refund/渠道退款成功 …」 | 已覆盖 |
| S: Changed element without before | `:420-427` | test「check：修改的迁移 T3 没有 before …」 | 已覆盖 |
| S: Removed state still targeted | `:427-438` | test「check：状态 CLOSED 已删除 …」「check：未删除的连线指向已删除的步骤 …」 | 已覆盖 |
| **R: Scenario references SHALL use capability and scenario name** | `:374-392`（scenarioIndex） | test「check：order-cancel/已支付订单取消后进入退款中 …」；两个在途变更 `check` 实跑（中文 Scenario 名精确匹配） | 已覆盖 |
| S: Valid reference | 同上 | 同上 | 已覆盖 |
| **R: design.md SHALL contain a visualization decision section** | `:516-574`；`:507`、`:549`（命中行备注）；`:590-591`（没有 design.md 不检查）；propose skill / 命令的 design 编写说明；design.md:221-223 在途变更迁移 | test 5 个 CM-5 用例（含 `:511-523` 备注用例）；evidence/slice-01.md、slice-04.md、slice-05.md；本轮对 5 个未归档变更实跑 `check` 全部 PASS | 已覆盖（SPEC-01、SPEC-02 已闭环） |
| S: Missing section | `:521-527` | test「check：design.md 存在但没有「可视化判定」小节 …」 | 已覆盖 |
| S: Declared hit without a model | `:559-562` | test「check：小节声明状态变动命中 order-status …」 | 已覆盖 |
| S: No design.md | `:590-591` | test「check：没有 design.md 的变更退出码 0 …」 | 已覆盖 |
| **R: The change-model check SHALL use the STE text check for rule 2** | `:447-495`（spawn `ste-lint.mjs text`，阻断项转 CM-2，缺失时告警） | test 2 个用例；evidence/slice-01.md、slice-04.md | 已覆盖 |
| S: Forbidden alias in a trigger | 同上 | test「check：迁移 trigger 为「用户退单」…」断言替代词「取消」 | 已覆盖 |
| S: STE skill missing | 同上 | test「check：找不到 openspec-ste 时跳过 CM-2 并告警 …」 | 已覆盖 |
| **R: OpenSpec workflow SHALL run the change-model check with the STE check** | `skills/openspec-{propose,update-change,apply-change,verify-change}/SKILL.md` 与 `claude/commands/opsx/{propose,update,apply,verify}.md` 新增段落（紧接 STE 检查） | evidence/slice-04.md（`npm run verify` 引用可达；构造 CM-4 阻断实跑 check）；本轮 `npm test` 168 条引用可达 | 已覆盖（提示词流程，按 design Seam 以实际运行验证） |
| S: Apply with a blocking change-model finding | `skills/openspec-apply-change/SKILL.md` 变更模型检查段落 | evidence/slice-04.md | 已覆盖（同上） |
| **R: Rendering SHALL use one union layout for before, diff and after views** | `change-model.mjs:737-777`（并集输入含 removed 与旧路线）、`:827-836`；`assets/overview-template.html`（视图只改显示） | test「layout：并集布局包含删除与新增的元素 …」「render：… 未变元素的坐标取自同一次布局」；evidence/slice-02.md | 已覆盖 |
| S: Unchanged state keeps its position | 同上 | 同上 | 已覆盖 |
| **R: Rendering SHALL be deterministic** | `:632`（固定 randomSeed）、按 ID 排序；`renderHtml` `:932` 无时间戳 | test「layout：两次运行输出字节一致」「render：两次输出字节一致 …」 | 已覆盖 |
| S: Render twice | 同上 | 同上 | 已覆盖 |
| **R: Rendering SHALL refuse invalid models** | `:1086-1088`（先 check，阻断时只返回报告，不写文件） | test「render：模型存在阻断项时退出码 1，不创建也不覆盖 overview.html」 | 已覆盖 |
| S: Blocking finding exists | 同上 | 同上 | 已覆盖 |
| **R: The renderer SHALL output layout JSON for downstream consumers** | `:793-836`（节点坐标尺寸、路径点、标签位置、diff、before、causes、scenarios） | test「layout：T3 修改时，T3 的条目含 diff: changed、路径点与 before 旧值」 | 已覆盖 |
| S: Layout JSON contains diff data | 同上 | 同上 | 已覆盖 |
| **R: overview.html SHALL be a single offline file** | `:932-976`、`:1095`；`assets/overview-template.html`（内联 CSS / JS 与 JSON） | test「render：写入单个 overview.html … 不引用任何外部 URL …」；evidence/slice-02.md | 已覆盖 |
| S: No external resources | 同上 | 同上 | 已覆盖 |
| **R: overview.html SHALL support view switching and traceability** | `assets/overview-template.html`（三视图、差异着色、侧栏、causes 联动） | evidence/slice-02.md（浏览器驱动 + 用户确认），符合 design「测试 Seam 决策」的人工验证 | 已覆盖（人工 Seam） |
| S: Select a changed transition | 同上 | evidence/slice-02.md | 已覆盖（人工 Seam） |
| S: Select a step that causes a transition | 同上 | evidence/slice-02.md | 已覆盖（人工 Seam） |
| **R: overview.md SHALL embed derived Mermaid** | `change-model.mjs:1001-1050`（stateDiagram-v2 / flowchart TD）；`skills/openspec-change-overview/SKILL.md` 第 2 块步骤 | test 3 个 mermaid 用例；evidence/slice-03.md | 已覆盖 |
| S: Overview with a change model | `SKILL.md` 第 2 块「有变更模型时」 | evidence/slice-03.md | 已覆盖 |
| S: Overview without a change model | `SKILL.md` 第 2 块「没有变更模型时」；`change-model.mjs:1044`、`:1093` | test「render：没有变更模型时不创建 overview.html」「mermaid：… 没有变更模型时输出为空」 | 已覆盖 |

任务真实完成核对：tasks.md 全部 21 个 `- [x]` 都能在 diff 或证据中找到对应改动。Slice 01～04 的 18 项与第 1 轮一致，代码未回退。Slice 05：5.1 见 `change-model.mjs:506-507,549`、`test-change-model.mjs:511-523`、`design.md:120`、`shared/change-model.md:90`；5.2 见 `design.md:221-223` 与两个在途变更 design.md 新增小节（「经用户确认」只能从 `evidence/slice-05.md:33` 取证，本评审无法独立核实确认过程）；5.3 见 `vendor/NOTICE:1-23`（版本、发布包地址、源码地址、gitHead、4 个 sha256 与实测一致）、`skills/openspec-change-overview/SKILL.md:154,160`、`design.md:87,95`。未发现假勾选。

Seam 一致性核对：Slice 05 新增测试 `test-change-model.mjs:511-523` 经 `spawnSync` 调用 `check` 子命令，与 tasks.md:45 声明的 `check` Seam 一致；`evidence/slice-05.md:5` 的 Seam 与 tasks.md:45 原样一致，`Fingerprint` 与本轮基线一致。tasks.md:45 的「文档类条件人工核对」在 design「测试 Seam 决策」中没有对应项（SPEC-05）。

## 设计偏离清单

| 偏离项 | design 中有无 | 建议：回记 design / 撤销实现 |
|---|---|---|
| 新增 `vendor/package.json`、两个 LICENSE、`vendor/NOTICE` | 有（design.md:83-87、:94-95，本轮已回记） | 无需处理 |
| 四个子命令的 `--repo <dir>` 参数 | 有（design.md:129） | 无需处理 |
| STE 告警只转发环境告警；`before` 旧值不送检 | 有（design.md:128） | 无需处理 |
| CM-1 不通过时跳过 CM-2/3/4/6，CM-5 照常执行 | 有（design.md:127） | 无需处理 |
| 「命中」行允许行末括号备注 | 有（design.md:120，本轮已回记） | 无需处理 |
| 在途变更需补「可视化判定」小节，已为 2 个在途变更补齐 | 有（design.md:221-223，本轮已回记） | 无需处理 |
| 为在途变更补的不只是两行判定，还新增了完整 `change-model` 代码块（`add-dual-axis-review-evidence/design.md:13-67`、`ddd-visualization-data-separation/design.md:54-99`） | 有（design.md:223「命中时同时补变更模型」） | 无需处理；这两个变更的 overview 是否刷新由各自流程决定 |
| Slice 05 的「文档类条件人工核对」Seam | 无（design.md:184-191 未列） | 回记 design Seam 表或修正 tasks.md:45（SPEC-05） |
| 额外 schema 约束：只有 `changed` 元素可写 `before`、连线 from+to 不得重复、`before.from` / `before.to` 引用检查 | design §2 指定以 `shared/change-model.md` 为准，shared 已写明 | 无需处理（属于规则 1「不符合 schema」的范围） |

范围外行为：未发现。修改两个在途变更的 design.md 属于 tasks 5.2 与 design Migration Plan 第 3 条明确承担的迁移动作；`vendor/NOTICE` 属于 5.3 与 design §1 的回记范围。

其他观察（不计入 finding）：

- `design.md:221` 的小标题仍是「历史变更不受影响」，紧接的子项 `:223` 说在途变更会被阻断，读者需看完子项才能理解；可顺手改为「已归档与没有 design.md 的变更不受影响」。
- `TRAILING_REMARK`（`change-model.mjs:507`）不支持备注内嵌套括号，如「（以 propose（代表）为例）」仍会被拆成 ID；spec 未要求，现有在途变更也没有这种写法。
- 两个在途变更 design.md 的新小节前多出一个空行（`add-dual-axis-review-evidence/design.md:7`、`ddd-visualization-data-separation/design.md:48`），不影响解析。
- `docs/adr/0004-change-model-as-diagram-source.md:6` 的「关联变更：变更模型可视化（待创建）」已过时，可改为 `add-change-model-visualization`（第 1 轮已提出，仍未处理）。

## 结论

上轮两个条件 SPEC-01、SPEC-02 已真正闭环（实现行、测试与 design 小节均可指出，两个在途变更实跑 `check` 通过）；SPEC-04 已回记闭环。本轮无 Blocker、无 open Major；open Minor 2 个（SPEC-03 沿用、SPEC-05 新增），不阻断，建议在 tasks.md 增加勾选项后同批处理：

| Minor | 建议的 tasks.md 勾选项 |
|---|---|
| SPEC-03 | `- [ ] 补 CM-1 用例：迁移 from/to 指向缺失状态、连线端点缺失、未知字段，更新 evidence/slice-01.md` |
| SPEC-05 | `- [ ] design「测试 Seam 决策」补「文档与第三方声明人工核对」一行，或修正 tasks.md Slice 05 的 Seam 行` |

Spec Fidelity Review 结论：通过
