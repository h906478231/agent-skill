# 实现后双轴评审规则（唯一事实源）

> `/opsx:quality`（skill `openspec-code-quality`）在 Phase 5.5 执行的**双轴独立评审**：轴的职责边界、固定基线、报告骨架、汇总与裁决规则。
> 本 skill 的 `SKILL.md` 与 `roles/*.md` 用 skill 内相对路径 `shared/dual-axis-review.md` 引用本文件；其他 skill 跨 skill 引用 `../openspec-code-quality/shared/dual-axis-review.md`；Glob 兜底搜 `**/openspec-code-quality/shared/dual-axis-review.md`。
> 确定性校验脚本（下文 `<GATE>`）= `../openspec-technical-review/scripts/implementation-gate.mjs`（相对本 skill 目录解析；解析不到时 Glob 搜 `**/openspec-technical-review/scripts/implementation-gate.mjs`），运行需 Node.js ≥ 16。

## 为什么拆成两个轴

实现后评审要回答两个不同的问题：「代码写得合不合格」和「实现是否忠实于需求与设计」。混在一份报告里，Blocker 来源、判断依据与责任边界都说不清；两个视角互相锚定，还会让后看的一方只复述先看的一方。所以拆成两个**并行、互不读取对方报告**的轴，各自保留原始报告，再由一份汇总只做索引与裁决。

## 两个轴的职责边界

| | Standards Review | Spec Fidelity Review |
|---|---|---|
| 回答的问题 | 代码本身写得合不合格 | 实现是否忠实于 proposal / design / specs / tasks |
| 输入 | 固定基线 diff + 项目约定（`CLAUDE.md`、既有代码风格） | 固定基线 diff + `proposal.md` / `design.md` / `specs/**` / `tasks.md`（含 `Seam:` 行）/ `evidence/` |
| 审查范围 | 重复与应复用未复用、可读性、死代码、复杂度热点、测试可维护性、项目约定 | 缺失的 requirement、未覆盖的 scenario、勾选了但没实现的任务、范围外行为、偏离 `design.md` 已记录的决策、未按声明 Seam 测试 |
| 不审什么 | 不重审 Technical Review 已审的架构 / 并发 / 性能 / 数据库 / 安全方案；不判断需求是否实现正确；不为「另一种架构也行」开 finding | 不评代码风格与可读性；不重新评判方案优劣（那是 Technical Review 的职责） |
| finding 前缀 | `STD-` | `SPEC-` |
| 角色提示词 | `roles/standards.md` | `roles/spec-fidelity.md` |
| 原始报告 | `review/standards.md` | `review/spec-fidelity.md` |

两轴报告同一实现位置属于正常现象（例如一段重复代码同时偏离了设计），**各自保留 finding**，只在汇总的「同位置关联」里关联，不合并、不删除任何一方。

## 与既有阶段的职责去重

| 阶段 | 审什么 | 与双轴的关系 |
|------|--------|-------------|
| Phase 3 Technical Review（`/opsx:review`） | 编码前 `design.md` 方案的架构 / 并发 / 性能 / 数据库 / 安全 | 双轴**不重审**方案。实现偏离了 design 决策由 Spec Fidelity 报告；是否要改 design 并重走门禁，按 `../openspec-technical-review/shared/gate-policy.md` 第 2 节判定 |
| Phase 5.5 双轴评审（本规则） | 实现代码的工程质量 + 实现对规格的忠实度，逐行、带 `文件:行号` 定位 | — |
| Phase 6 Verify（`/opsx:verify`） | 最终验收：勾选完整性、切片证据新鲜度、双轴裁决是否闭环、三维快速校验、人工核对清单 | Verify **不逐行复审**忠实度，只核对双轴汇总裁决与证据；Verify 发现的新偏离回到对应轴处置 |

## 固定基线

评审开始时由编排者（主 agent）**只运行一次**：

```bash
node <GATE> baseline <changeRoot> [--base <变更起点 commit>]
```

`--base` 省略时取 `HEAD`（变更尚未提交的常见情况）；变更已提交时用 `git log` 定位变更起点 commit 传入。命令输出如下区块，**两轴原始报告与汇总报告原样粘贴同一块，不得各自重算**：

```markdown
## 评审基线

- Change: <change-name>
- Base Commit: <起点 commit 全量 SHA>
- Fingerprint: git-tree:<当前实现指纹>
- Review Scope: <起点短 SHA>..工作区（含已暂存 / 未暂存 / 未跟踪文件，排除 openspec）
- Baseline Recorded At: <ISO 时间>
```

- `Change` / `Base Commit` / `Fingerprint` / `Review Scope` 四项是基线身份，三份报告必须完全一致；`Baseline Recorded At` 仅供追溯。
- `Fingerprint` 是排除规划目录后整个工作区内容的 git tree 哈希（算法见 `<GATE>` 文件头），与切片证据使用同一口径。
- 基线生成后到两份原始报告写完之前，**不得修改实现代码**。评审中想顺手修 —— 先写完本轮报告，修复后重新生成基线再重跑。

## 独立性

- **两个轴用两个独立子 agent 并行执行**（一条消息两个 tool use）。每个子 agent 的 prompt 只包含：本 skill 目录绝对路径、基线区块、本轴角色文件全文、变更 artifacts 路径、固定基线 diff 的获取方式。
- **禁止读取另一轴的原始报告与 `review/code-review-summary.md`** —— 首轮与重跑都一样。重跑时只允许读取**本轴**上一轮报告，用于上轮闭环验证。
- 环境不支持子 agent 时，允许同一编排器按「Standards → Spec Fidelity」顺序执行两个轴，但必须在汇总「两轴状态」的「执行方式」列写明 `顺序执行（独立性降级）`，让签收人知道两轴并非完全隔离。

## 原始报告骨架

finding 字段、五条硬规则与维度结论**完全沿用** `../openspec-technical-review/shared/finding-format.md`，此处只规定本评审的差异：

- `位置` 必须写成 `文件路径:行号`（可带行号区间 `:12-20`）。Spec Fidelity 报告「缺失实现」时，指向 spec / design / tasks 中对应需求所在行。**无法定位到行的 finding 不得提交**。
- 「触发场景」对 Standards 放宽为维护场景（如「下次改这段折扣规则要同步改 3 处，漏一处就两套算法并存」），但仍须具体到「改什么会漏什么」。
- 结论行必须单独成行，只写一个取值。

```markdown
# Standards Review（<change-name>）        ← Spec Fidelity 轴标题为 # Spec Fidelity Review（<change-name>）

## 评审基线
<baseline 命令输出，原样粘贴>

## 上轮闭环验证                            ← 仅重跑时，规则见 ../openspec-technical-review/shared/closed-loop-verification.md

## Findings

| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |
|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|
| STD-01 | Major | 创建订单 | src/order/OrderService.java:42 | OrderService.create | … | … | … | … | open |

## 本轴特有内容                            ← Standards：重复率专项；Spec Fidelity：规格覆盖矩阵

## 结论

Standards Review 结论：有条件通过          ← Spec Fidelity 轴写 Spec Fidelity Review 结论：…
```

没有 finding 时保留表头并写一行「无」，结论照写。

## 汇总报告 `review/code-review-summary.md`

汇总**只做索引与裁决**：不复制、不改写 finding 正文，不修改、重排或删除原始报告中的任何内容 —— 原始报告才是 finding 的事实源。

```markdown
# 实现后双轴评审汇总（<change-name>）

## 评审基线
<同一基线区块>

## 两轴状态

| 评审轴 | 原始报告 | 结论 | 未闭环 Blocker | Major | Minor | 执行方式 |
|--------|---------|------|---------------|-------|-------|---------|
| Standards Review | review/standards.md | 通过 | 0 | 1 | 0 | 独立子 agent |
| Spec Fidelity Review | review/spec-fidelity.md | 打回 | 1 | 0 | 0 | 独立子 agent |

## 未闭环 Blocker 索引

| ID | 评审轴 | 原始报告 |
|----|--------|---------|
| SPEC-01 | Spec Fidelity Review | review/spec-fidelity.md |

## 同位置关联（可选）

| 实现位置 | 关联 finding | 说明 |
|---------|-------------|------|

## 裁决

Code Review Verdict: BLOCKED
```

## 裁决规则

| 条件 | 裁决 |
|------|------|
| 任一轴存在未闭环 Blocker（`严重级别 = Blocker` 且 `闭环状态 = open`，含缺省） | `BLOCKED` |
| 两份原始报告齐全、基线一致、finding 均可定位，且两轴都没有未闭环 Blocker | `PASSED` |

- 原始报告缺失、基线不一致、finding 无法定位或前缀与轴不符，说明**评审本身不完整**，不得给出 `PASSED`，补齐后重跑。
- 「有条件通过」的每个条件必须映射到 `tasks.md` 的一个勾选项，映射不到视同 Blocker（沿用 `../openspec-technical-review/shared/gate-policy.md`）。
- 误报与 risk accepted 按 `gate-policy.md` 第 4 节在**对应轴的原始报告**里具名留痕，并把该 finding 的闭环状态改为 `false-positive` / `risk-accepted`（保留该行）。
- **任一轴未闭环 Blocker 未清零时不得 `/opsx:archive`**。

## 命令级校验

汇总写完后必须运行一次：

```bash
node <GATE> review <changeRoot>
```

输出 JSON：`verdict`（由原始报告重新计算，不采信汇总自述；`PASSED` / `BLOCKED` / `INCOMPLETE`，后者表示没有 Blocker 但报告结构不完整）、各轴 `openBlockers`、`issues`（结构问题）与 `warnings`。退出码 `0` = `PASSED` 且无结构问题；`1` = `BLOCKED` 或存在结构问题；`2` = 参数或环境错误。它校验：

1. 三份文件齐全，且汇总引用了两份原始报告路径；
2. 三份文件的基线身份四项完全一致；
3. finding ID 前缀与所在轴一致，`位置` 含 `文件:行号`；
4. 各轴结论行与未闭环 Blocker 一致（有未闭环 Blocker 却写「通过」即报错）；
5. 汇总 `Code Review Verdict` 与重新计算的裁决一致；
6. 基线 `Fingerprint` 与当前实现不一致时给出 warning（评审之后代码又变了，需判断是否重跑）。

`issues` 非空时修正报告再重跑，不得带着结构问题进入 `/opsx:verify`。

## 修复与重跑

- 修复动作回 `tasks.md` 新增勾选项再做；修复即改代码，因此修复后**重新生成基线、两轴都重跑**（两轴必须落在同一新基线上）。两轴并行，墙钟接近较慢的一轴。
- 重跑时对上轮 Blocker 逐条核实，要指到具体行确认已落地，只看提交说明不算闭环（规则同 `closed-loop-verification.md`）。

## 适用范围与兼容

- 分级沿用 `../openspec-technical-review/shared/gate-levels.md`：**L0 豁免**；L1 及以上两轴都跑。L0 若仍创建了任一双轴产物，则必须按本规则完整产出。
- **启用判据**（校验脚本据此判定）：`review/` 下存在任一双轴产物，或 `tasks.md` 任一切片声明了 `Evidence:` 引用（按新规则创建的变更）即视为启用；启用后三份文件缺一不可。
- **不追溯历史变更**：本规则之前产出的 `review/code-quality.md` 继续按原规则被 `/opsx:archive` 识别，不要求补跑双轴。

## 产物的 git 归属

三份报告提交 git，随 `openspec archive` 整体进 `changes/archive/<name>/`，不进 `specs/`。本评审**只报告不改代码**，也不执行 push、PR、部署或任何外部任务回写。
