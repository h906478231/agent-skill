---
name: openspec-code-quality
description: OpenSpec 实现后双轴独立评审（Phase 5.5）。在 openspec apply 编码完成之后、verify 校验之前，以同一固定代码基线并行调度 Standards Review（重复/复用、可读性、死代码、复杂度、测试可维护性、项目约定）与 Spec Fidelity Review（需求、场景、任务、设计决策、Seam 的实现忠实度）两个互不读取对方报告的评审 agent，分别产出 review/standards.md 与 review/spec-fidelity.md，再汇总为 review/code-review-summary.md 并按任一轴未闭环 Blocker 阻断归档。只报告不改代码，修复走 tasks 勾选。
---

# 实现后双轴独立评审（Standards + Spec Fidelity）

## 定位

技术评审门禁纳入范围的各维度（架构/并发/性能/数据库/安全）审的是 **`design.md` 里的方案**，`/opsx:verify` 做的是**最终验收**。两者都不逐行看**实现出来的代码**。本 skill 补这个空档，并把实现后评审拆成两个独立的轴：

```
/opsx:apply（编码 + 切片证据）──> 【/opsx:quality 本 skill】──> /opsx:verify ──> /opsx:archive
                                    ├─ Standards Review      → review/standards.md
                                    ├─ Spec Fidelity Review  → review/spec-fidelity.md
                                    └─ 汇总裁决              → review/code-review-summary.md
```

- **输入**：同一固定基线下本次变更的完整 diff + 变更 artifacts。
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

沿用 [门禁分级标准](../openspec-technical-review/shared/gate-levels.md)：**L0（纯文案/配置/注释/纯测试补充）豁免；L1 及以上两轴都跑**。两轴并行，墙钟接近较慢的一轴。

## 路径约定

- `<SKILL_DIR>` = 本 SKILL.md 所在目录。skills 根目录随 agent 而不同（Claude Code `~/.claude/skills/`、Codex `~/.codex/skills/`、opencode `~/.config/opencode/skills/`、Cursor `~/.cursor/skills/`、项目级 `.claude/skills/`、直接使用本仓时的 `skills/`），**不要写死绝对路径**；解析不到时用 Glob 搜 `**/openspec-code-quality/SKILL.md`。
- `<GATE>` = `<SKILL_DIR>/../openspec-technical-review/scripts/implementation-gate.mjs`（确定性校验脚本，需 Node.js ≥ 16）；解析不到时 Glob 搜 `**/openspec-technical-review/scripts/implementation-gate.mjs`。
- 子 agent 是纯文本上下文，**启动前必须把 `<SKILL_DIR>` 解析成绝对路径写进 prompt**。

## 前置

1. 解析变更名，`openspec status --change "<name>" --json` 取 `changeRoot`。
2. 确认有 diff：`git status --short` 与 `git diff --stat`（变更已提交时用变更起点到 HEAD 的范围，`git log` 定位起点 commit）。**diff 为空则中止**，提示先完成 `/opsx:apply`。
3. 在 `changeRoot` 下创建 `review/` 目录。

## 执行步骤

### Step 1 — 固定基线（只做一次）

```bash
node <GATE> baseline <changeRoot> [--base <变更起点 commit>]
```

把输出的「## 评审基线」区块原样保存，Step 2 两个子 agent 与 Step 3 汇总都使用**同一块**。从此刻到两份原始报告写完，不得修改实现代码。

### Step 2 — 并行调度两个隔离的评审 agent

用 **Agent 工具**在同一条消息里启动两个子 agent（并行）：

| 评审轴 | 角色提示词 | 输出 |
|--------|-----------|------|
| Standards Review | `roles/standards.md` | `review/standards.md` |
| Spec Fidelity Review | `roles/spec-fidelity.md` | `review/spec-fidelity.md` |

每个子 agent 的 prompt 包含且只包含：

1. `<SKILL_DIR>` 的绝对路径，并说明「下文所有 `<SKILL_DIR>/...` 路径都替换为该值」；
2. 对应角色文件全文（其中已声明必读的共用规则，子 agent 自行读取）；
3. Step 1 的基线区块，并要求「报告开头原样粘贴，评审范围以 `Base Commit` 到工作区为准」；
4. `changeRoot` 与 artifacts 路径；
5. **重跑时**：本轴上一轮报告路径，要求先做上轮闭环验证；
6. 明确禁止读取另一轴的原始报告与 `review/code-review-summary.md`。

环境不支持子 agent 时，按「Standards → Spec Fidelity」顺序执行，并在汇总「执行方式」列标注 `顺序执行（独立性降级）`（规则见 `shared/dual-axis-review.md`「独立性」）。

### Step 3 — 汇总与裁决

读取两份原始报告，按 `shared/dual-axis-review.md`「汇总报告」骨架写入 `review/code-review-summary.md`：基线区块 → 两轴状态 → 未闭环 Blocker 索引 → 同位置关联（可选） → `Code Review Verdict: PASSED / BLOCKED`。汇总只引用 finding ID 与原始报告路径，**不复制、不改写、不删除**原始 finding。

### Step 4 — 命令级校验

```bash
node <GATE> review <changeRoot>
```

- 退出码 `0`：裁决 `PASSED` 且报告结构完整，可进入 `/opsx:verify`。
- 退出码 `1` 且 `issues` 非空：报告结构有问题（缺文件、基线不一致、finding 不可定位、结论与 Blocker 矛盾、汇总自述裁决不符），修正后重跑本步骤。
- 退出码 `1` 且 `verdict = BLOCKED`：向用户列出各轴 `openBlockers`，按下方「裁决与闭环」处理。
- `warnings` 中的基线陈旧提醒：评审后代码又变了，判断是否重跑双轴。

## 裁决与闭环

- 裁决规则见 `shared/dual-axis-review.md`「裁决规则」：**任一轴存在未闭环 Blocker 即 `BLOCKED`，不得 `/opsx:archive`**。
- 「有条件通过」的每个条件必须映射到 `tasks.md` 的一个勾选项，**映射不到视同 Blocker**。
- 修复即改代码：修复后**重新生成基线、两轴都重跑**，对上轮 Blocker 逐条核实 —— 要指到具体行确认已落地，只看提交说明不算闭环。
- 误报或知情接受：按 `../openspec-technical-review/shared/gate-policy.md` 第 4 节的驳回 / risk accepted 格式记录在**对应轴的原始报告**，写明决策人与理由，不改代码就不重跑。

## 兼容

- 历史变更已产出的 `review/code-quality.md` 继续按原规则被 `/opsx:archive` 识别，**不要求补跑双轴**。
- 本 skill 不追溯改写任何历史 archive。

## 产物的 git 归属

与门禁产物同策略：三份报告提交 git，随 `openspec archive` 整体进 `changes/archive/<name>/`，不进 `specs/`。
