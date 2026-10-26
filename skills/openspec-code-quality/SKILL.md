---
name: openspec-code-quality
description: OpenSpec 实现后双轴独立评审（Phase 5.5）。在 openspec apply 编码完成之后、verify 校验之前，以同一固定代码基线并行调度 Standards Review（重复/复用、可读性、死代码、复杂度、测试可维护性、项目约定）与 Spec Fidelity Review（需求、场景、任务、设计决策、Seam 的实现忠实度）两个互不读取对方报告的评审 agent，分别产出 review/standards.md 与 review/spec-fidelity.md，再汇总为 review/code-review-summary.md 并按任一轴未闭环 Blocker 阻断归档。项目配置了 Sonar 时，最后用 SonarScanner 扫描，只处理本次修改行上的问题（review/sonar.md），Standards 不评 Sonar 已覆盖的检查项。L2/L3 必需，L0/L1 推荐（未生成不阻断归档）。只报告不改代码，修复走 tasks 勾选。
---

# 实现后双轴独立评审（Standards + Spec Fidelity）

## 定位

技术评审门禁纳入范围的各维度（架构/并发/性能/数据库/安全）审的是 **`design.md` 里的方案**，`/opsx:verify` 做的是**最终验收**。两者都不逐行看**实现出来的代码**。本 skill 补这个空档，并把实现后评审拆成两个独立的轴：

```
/opsx:apply（编码 + 切片证据）──> 【/opsx:quality 本 skill】──> /opsx:verify ──> /opsx:archive
                                    ├─ Standards Review      → review/standards.md
                                    ├─ Spec Fidelity Review  → review/spec-fidelity.md
                                    ├─ 汇总裁决              → review/code-review-summary.md
                                    └─ Sonar 扫描（项目配置时）→ review/sonar.md
```

- **输入**：同一固定基线下本次变更的 diff（第 1 轮为完整 diff，第 2 轮起为上一轮基线以来的增量）+ 变更 artifacts。
- **输出**：两份独立原始报告 + 一份只做索引与裁决的汇总。
- **不改代码**，不执行 push、PR、部署或外部任务回写。

两个轴的职责边界、与 Technical Review / Verify 的去重、基线与报告格式、裁决规则的**唯一事实源**是 `shared/dual-axis-review.md`，本文件只写编排步骤，不重复规则。

## 与内置 `/simplify` 的区别

| | `/simplify` | 本 skill |
|---|---|---|
| 动作 | 直接编辑代码 | 只报告 + 分级 + 留痕 |
| 范围 | 当前关注的代码 | 本次变更在固定基线下的完整 diff |
| 产物 | 代码改动 | `review/standards.md` + `review/spec-fidelity.md` + `review/code-review-summary.md` |
| 修复路径 | 就地改完 | 回 `tasks.md` 加勾选项再改 |

保持「评审与实现分离」：评审只出结论，修复动作有据可查、可被验收。想直接改可以另行用 `/simplify`，但那不构成本门禁的闭环证据。

## 适用范围分级

沿用 [门禁分级标准](../openspec-technical-review/shared/gate-levels.md)：**L2/L3 必须跑**；**L0/L1 推荐跑**，未生成不阻断归档。等级取变更目录 `overview.md` 的分级行；读不到等级时按 L2/L3 处理。两轴并行，墙钟接近较慢的一轴。

## 路径约定

- `<SKILL_DIR>` = 本 SKILL.md 所在目录。skills 根目录随 agent 而不同（Claude Code `~/.claude/skills/`、Codex `~/.codex/skills/`、opencode `~/.config/opencode/skills/`、Cursor `~/.cursor/skills/`、项目级 `.claude/skills/`、直接使用本仓时的 `skills/`），**不要写死绝对路径**；解析不到时用 Glob 搜 `**/openspec-code-quality/SKILL.md`。
- `<GATE>` = `<SKILL_DIR>/../openspec-technical-review/scripts/implementation-gate.mjs`（确定性校验脚本，需 Node.js ≥ 16）；解析不到时 Glob 搜 `**/openspec-technical-review/scripts/implementation-gate.mjs`。
- 子 agent 是纯文本上下文，**启动前必须把 `<SKILL_DIR>` 解析成绝对路径写进 prompt**。

## 前置

1. 解析变更名，`openspec status --change "<name>" --json` 取 `changeRoot`。
2. 确认有 diff：`git status --short` 与 `git diff --stat`（变更已提交时用变更起点到 HEAD 的范围，`git log` 定位起点 commit。`tasks.md` 声明了 `## 变更终点` 时，用变更起点到变更终点的范围）。**diff 为空则中止**，提示先完成 `/opsx:apply`。
3. 在 `changeRoot` 下创建 `review/` 目录。
4. **重跑时按档位登记实现后修改**：运行 `node <GATE> classify <changeRoot> --from <上一轮报告基线的 Fingerprint>`，按 `<SKILL_DIR>/../openspec-apply-change/shared/post-implementation-changes.md` 处理结果：
   - `other` 为空（全部文件只有注释差异）：输出「无需新一轮：自上一轮基线以来只有注释差异」并停止，不生成新基线，报告保持不变。
   - 只在新增并已勾选的任务内修改的文件（按 apply 规则勾选，切片证据新鲜）：`classify` 仍把它们列入 `unregistered`，但它们不是实现后修改（事实源「定义」），不登记；勾选之后又有修改时照常登记，修改与任务对应不上或拿不准时照常登记，判断方法见事实源登记步骤 6。上一轮之后的修改全部属于这类时，进入 Step 1，两轴按增量执行。
   - 其他情况下 `unregistered` 或 `issues` 不为空（含门禁外提交）：先按档位登记到 `tasks.md` 的 `## 实现后修改登记`，再进入 Step 1。不属于上述文件的条目照常登记。`行为` 档位同时新增任务，写明提交 SHA 或文件；`等价` 档位先经用户确认。
   - 退出码 `2`（上一轮 tree 对象已被回收）：无法核对登记，自上一轮以来修改的文件按 `行为` 登记，本轮按第 1 轮审查完整 diff。
5. **判定 Sonar 状态**：按 `shared/sonar-scan.md`「何时适用」判定为 `已配置` 或 `不适用：<原因>`。本轮 Step 2 与 Step 5 使用同一个判定。

## 执行步骤

### Step 1 — 固定基线（只做一次）

```bash
node <GATE> baseline <changeRoot> [--base <变更起点 commit>]                              # 第 1 轮
node <GATE> baseline <changeRoot> [--base <变更起点 commit>] --since <上一轮 Fingerprint>  # 第 2 轮起
```

把输出的「## 评审基线」区块原样保存，Step 2 两个子 agent 与 Step 3 汇总都使用**同一块**。从此刻到两份原始报告写完，不得修改实现代码。

- 第 2 轮起，`<上一轮 Fingerprint>` 取上一轮报告基线中的 `Fingerprint`。输出带 `Delta Since` 与 `Delta Files`，本轮只审查这些文件。
- 命令在 stderr 输出 warning（上一轮 tree 对象已被回收）时，基线不带 `Delta Since`，本轮按第 1 轮审查完整 diff。
- `tasks.md` 声明了 `## 变更终点` 时（规则见 `<SKILL_DIR>/../openspec-apply-change/shared/post-implementation-changes.md`「变更终点」），用 `--base` 传本变更的起点提交。基线的 `Review Scope` 为起点到变更终点，`Fingerprint` 为终点指纹，并带 `Change Head` 行；`--since` 的 `Delta Files` 比到终点指纹。

### Step 2 — 并行调度两个隔离的评审 agent

用 **Agent 工具**在同一条消息里启动两个子 agent（并行）：

| 评审轴 | 角色提示词 | 输出 |
|--------|-----------|------|
| Standards Review | `roles/standards.md` | `review/standards.md` |
| Spec Fidelity Review | `roles/spec-fidelity.md` | `review/spec-fidelity.md` |

每个子 agent 的 prompt 包含且只包含：

1. `<SKILL_DIR>` 的绝对路径，并说明「下文所有 `<SKILL_DIR>/...` 路径都替换为该值」；
2. 对应角色文件全文（其中已声明必读的共用规则，子 agent 自行读取）；
3. Step 1 的基线区块，并要求「报告开头原样粘贴」。评审范围：第 1 轮以 `Base Commit` 到工作区为准，基线带 `Change Head` 时以 `git diff <Base Commit> <Change Head>` 为准；基线带 `Delta Since` 时只审查 `Delta Files` 列出的文件；
4. `changeRoot` 与 artifacts 路径；
5. **重跑时**：本轴上一轮报告路径，要求先对台账中 `open` 的项做上轮闭环验证，原地覆盖报告并累计台账；Spec Fidelity 的规格覆盖矩阵沿用上一轮，只更新 delta 涉及的行；
6. 明确禁止读取另一轴的原始报告与 `review/code-review-summary.md`；
7. 只给 Standards 子 agent：前置第 5 步的 Sonar 状态。`已配置` 时，项目的质量配置关闭了 `shared/sonar-scan.md`「Standards 跳过的检查项」中的规则时，写明这些项不跳过。

环境不支持子 agent 时，按「Standards → Spec Fidelity」顺序执行，并在汇总「执行方式」列标注 `顺序执行（独立性降级）`（规则见 `shared/dual-axis-review.md`「独立性」）。

**等价增量轮**：前置第 4 步 `classify` 的 `unregistered` 为空、`registered` 全部为 `等价` 时，只启动 Standards 子 agent；`review/spec-fidelity.md` 不修改，保留上一轮基线区块；Step 3 汇总写 `- Carried Axis: spec-fidelity`（规则见 `shared/dual-axis-review.md`「修复与重跑」）。`registered` 中有 `行为` 档位时两轴都启动。

### Step 3 — 汇总与裁决

读取两份原始报告，按 `shared/dual-axis-review.md`「汇总报告」骨架写入 `review/code-review-summary.md`：基线区块 → 两轴状态 → 未闭环 Blocker 索引 → 同位置关联（可选） → `Code Review Verdict: PASSED / BLOCKED`。汇总只引用 finding ID 与原始报告路径，**不复制、不改写、不删除**原始 finding。等价增量轮在「两轴状态」之前写 `- Carried Axis: spec-fidelity`，Spec Fidelity 行的执行方式写 `沿用（基线 <spec-fidelity.md 的 Fingerprint>）`。

### Step 4 — 命令级校验

```bash
node <GATE> review <changeRoot>
```

- 退出码 `0`：裁决 `PASSED` 且报告结构完整。Sonar 状态为 `已配置` 时执行 Step 5，否则可进入 `/opsx:verify`。
- 退出码 `1` 且 `issues` 非空：报告结构有问题（缺文件、基线不一致、finding 不可定位、结论与 Blocker 矛盾、汇总自述裁决不符、Blocker 缺少 `[B1]`–`[B5]` 判据、Finding 台账缺失或不一致、`Carried Axis` 沿用条件不成立），修正后重跑本步骤。沿用条件不成立时，按档位登记或两轴都重跑。
- 退出码 `1` 且 `verdict = BLOCKED`：向用户列出各轴 `openBlockers`，按下方「裁决与闭环」处理。
- `warnings` 中的基线陈旧提醒：评审后代码又变了，判断是否重跑双轴。

### Step 5 — Sonar 扫描（Sonar 状态为 `已配置` 时）

按 `shared/sonar-scan.md` 扫描，只保留本次修改行上的问题，写入 `review/sonar.md`。

- 本次修改行上的问题与质量门失败的条件，处理都是「误报」或「接受」（决策人由用户填写），或者没有这类问题时：可进入 `/opsx:verify`。
- 还有要修复的问题时：向用户列出，在 `tasks.md` 新增修复任务；修复后重跑本命令，增量评审与重新扫描在同一轮完成。
- 扫描无法运行时：在 `review/sonar.md` 写 `Quality Gate: 无法运行：<原因>`，告诉用户 Standards 跳过的检查项没有被检查。
- Sonar 状态为 `不适用` 时跳过本步，在输出中写明原因。

## 裁决与闭环

- 裁决规则见 `shared/dual-axis-review.md`「裁决规则」：**任一轴存在未闭环 Blocker 即 `BLOCKED`，不得 `/opsx:archive`**。
- 「有条件通过」的每个条件必须对应 `tasks.md` 的一个勾选项，或者（只需修改规划产物时）对应该产物的 `<文件>:<行号>`；**两者都没有时视同 Blocker**。
- Blocker 只能按 `shared/dual-axis-review.md`「Blocker 判据（B1–B5）」判定；只在依赖故障或边界输入下出现的问题定为 Major。
- 修复即改代码：修复后用 `--since` **重新生成增量基线、两轴都重跑**（只审查 delta；等价增量轮只跑 Standards，见 Step 2），对上轮 Blocker 逐条核实 —— 要指到具体行确认已落地，只看提交说明不算闭环。
- 已闭环项写入本轴 `## Finding 台账`（`closed` + 闭环轮次 + `文件:行号` 或测试名），不再放进 Findings 表；报告原地覆盖，**禁止**生成 `-roundN` 副本（规则见 `../openspec-technical-review/shared/closed-loop-verification.md`「实现后双轴评审的差异」）。
- 误报或知情接受：按 `../openspec-technical-review/shared/gate-policy.md` 第 4 节的驳回 / risk accepted 格式记录在**对应轴的原始报告**，写明决策人与理由，不改代码就不重跑。

## 兼容

- 历史变更已产出的 `review/code-quality.md` 继续按原规则被 `/opsx:archive` 识别，**不要求补跑双轴**。
- 本 skill 不追溯改写任何历史 archive。

## 产物的 git 归属

与门禁产物同策略：三份报告与 `review/sonar.md` 随 `openspec archive` 整体进 `changes/archive/<name>/`，不进 `specs/`。本 skill 不执行 `git add` 或 `git commit`。项目 `.gitignore` 忽略 `openspec/` 时，不得用 `git add -f` 加入产物。是否提交由用户决定。
