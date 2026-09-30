# Slice 03 新鲜证据

- Slice: 03
- Behavior: Verify 和 Archive 可以阻断无效 Review 或过期证据
- Seam: `/opsx:verify <change>` 与 `/opsx:archive <change>`（确定性部分：`implementation-gate.mjs evidence` / `review` / `archive`）
- Recorded At: 2026-09-30T10:28:41Z
- Fingerprint: git-tree:f2e89cdd97346a9a417fb83fb9099eb6417f1c4b
- Fingerprint Source: node skills/openspec-technical-review/scripts/implementation-gate.mjs fingerprint openspec/changes/add-dual-axis-review-evidence
- Result: PASS

## 变更文件
- skills/openspec-technical-review/scripts/implementation-gate.mjs（过期明细、豁免链核实、archive 子命令）
- skills/openspec-technical-review/shared/implementation-gate-check.md
- skills/openspec-technical-review/shared/phase6-verification.md
- skills/openspec-technical-review/shared/phases.md
- skills/openspec-technical-review/SKILL.md
- skills/openspec-verify-change/SKILL.md
- claude/commands/opsx/verify.md
- skills/openspec-archive-change/SKILL.md
- claude/commands/opsx/archive.md
- scripts/test-implementation-gate.mjs（Slice 03 用例）
- scripts/verify-references.mjs（新增 `scripts/*.mjs` 引用校验）
- package.json（`test:gate` 接入 `npm test`）
- workflow/OpenSpec-AI-研发流程.md、workflow/quickstart-guide.md、README.md
- docs/adr/0002-implementation-fingerprint-git-tree.md
- openspec/changes/add-dual-axis-review-evidence/design.md（Open Questions 实现期决议，规划目录内，不计入指纹）

## 验证命令
| 命令 | 结果 | 摘要 |
|------|------|------|
| `npm test` | PASS | 引用校验 124/124 可达；test:orchestration 15/15、test:migration 24/24、test:gate 22/22 全部通过（Slice 03 新增 7 个用例，实现前 6 个先红，另 1 个为豁免过宽的防护用例） |
| `node --check skills/openspec-technical-review/scripts/implementation-gate.mjs` | PASS | 语法检查通过 |
| `node <副本>/scripts/verify-references.mjs`（scratchpad 副本中把 archive 的脚本引用改错） | PASS | 如期报出 `implementation-gate-typo.mjs` 断链，证明新增的 `.mjs` 引用校验有效 |
| `node skills/openspec-technical-review/scripts/implementation-gate.mjs evidence openspec/changes/add-dual-axis-review-evidence` | PASS | 真实变更自检：Slice 03 改动共享脚本后，Slice 01/02 如期判为 stale 并列出 16 个变化文件；重跑完整套件后刷新指纹 |
| `OPENSPEC_TELEMETRY=0 openspec validate add-dual-axis-review-evidence` | PASS | Change is valid |

## 覆盖的验收行为
- Scenario: Evidence is missing → 「已勾选切片缺少证据文件时报 CRITICAL」「归档阻断路径…缺失证据」（Slice 02）
- Scenario: Evidence is stale after code changes → 「实现变化后证据过期，并列出自证据以来变化的文件」「归档阻断路径…过期证据」（Slice 01）
- Scenario: Evidence is current → 「证据指纹与当前实现一致且字段完整时判定新鲜」「归档通过路径：双轴 PASSED 且全部证据新鲜」
- Scenario: A slice has no applicable evidence requirement → 「不追溯历史变更：无 Evidence 引用或无切片时不阻断，但给出不适用理由」
- Scenario: Archive is attempted with unresolved evidence → 「归档阻断路径：Review Blocker、缺失证据或过期证据任一出现都拒绝归档」（blockers 含切片编号）
- Scenario: Archive is attempted after all checks pass → 「归档通过路径：双轴 PASSED 且全部证据新鲜」
- Scenario: One axis has an open Blocker（Archive 侧）→ 「归档阻断路径…Review Blocker」（SPEC-01）、「按新规则创建的变更缺少双轴评审产物时拒绝归档」
- 任务 3.2 豁免格式 → 「行为无关变更可按豁免记录沿用证据，支持多段豁免链」「豁免记录漏列变化文件、缺理由或指纹无法核实时按过期处理」
- 任务 3.5 不追溯 / 不外发 → `phases.md`「实现阶段证据与双轴评审的边界」、`OpenSpec-AI-研发流程.md` git 生命周期一节、`implementation-gate-check.md`「边界」（文档约束，无自动化用例）

## 剩余风险
- 脚本只覆盖双轴评审与切片证据；Verify 的其他 CRITICAL（未完成任务、需求未实现）仍依赖 archive 流程取得用户显式确认。
- Seam 覆盖与「覆盖的验收行为」是否真的对应 spec Scenario，属于语义判断，由 Verify agent 人工核对，脚本不判定。
- 启用判据基于产物存在性：新变更若 tasks.md 漏写 `Evidence:` 引用，会被判「不适用」，只能靠 Verify 报告中的不适用理由被人发现。
- 本变更自身尚未跑 `/opsx:quality`，因此 `archive` 校验当前会因缺少双轴评审产物而阻断——这是预期行为，需在 Phase 5.5 补齐。

## 豁免记录
| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |
|------------------|----------------|---------|--------------------|-------|------|
