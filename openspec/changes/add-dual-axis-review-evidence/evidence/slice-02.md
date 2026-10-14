# Slice 02 新鲜证据

- Slice: 02
- Behavior: 每个垂直切片可以记录与当前实现绑定的新鲜证据
- Seam: `/opsx:apply <change>` 或 `openspec-apply-change` 入口（确定性部分：`implementation-gate.mjs fingerprint` / `evidence`）
- Recorded At: 2026-09-30T10:28:41Z
- Fingerprint: git-tree:f2e89cdd97346a9a417fb83fb9099eb6417f1c4b
- Fingerprint Source: node skills/openspec-technical-review/scripts/implementation-gate.mjs fingerprint openspec/changes/add-dual-axis-review-evidence
- Result: PASS

## 变更文件
- skills/openspec-apply-change/shared/slice-evidence.md
- skills/openspec-apply-change/SKILL.md
- skills/openspec-apply-change/shared/tdd-discipline.md
- claude/commands/opsx/apply.md
- skills/openspec-propose/shared/task-slicing.md
- skills/openspec-technical-review/scripts/implementation-gate.mjs（evidence 部分）
- scripts/test-implementation-gate.mjs（Slice 02 用例）

## 验证命令
| 命令 | 结果 | 摘要 |
|------|------|------|
| `npm test` | PASS | 收尾完整套件：引用校验 124/124 可达；test:orchestration 15/15、test:migration 24/24、test:gate 22/22 全部通过 |
| `node --test scripts/test-implementation-gate.mjs` | PASS | 切片完成时（指纹 git-tree:1f4cacb…）：15 tests, 15 pass, 0 fail（Slice 02 相关 7 个用例；实现前 6 个新用例先红） |
| `OPENSPEC_TELEMETRY=0 openspec instructions apply --change add-dual-axis-review-evidence --json` | PASS | 切片完成时（指纹 git-tree:1f4cacb…）：加入 `Evidence:` 行后仍解析出 13 个任务，progress 正常 |
| `OPENSPEC_TELEMETRY=0 openspec validate add-dual-axis-review-evidence` | PASS | 切片完成时（指纹 git-tree:1f4cacb…）：Change is valid |
| `node --check skills/openspec-technical-review/scripts/implementation-gate.mjs` | PASS | 切片完成时（指纹 git-tree:1f4cacb…）：语法检查通过 |
| `npm run verify` | PASS | 切片完成时（指纹 git-tree:1f4cacb…）：103 条资产引用全部可达 |

## 覆盖的验收行为
- Scenario: A slice is completed before task checkboxes are marked → 「已勾选切片缺少证据文件时报 CRITICAL（含部分勾选：勾选先于证据）」「尚未勾选任何任务的切片暂不要求证据」
- Scenario: A task slice references evidence → openspec CLI 解析验证 +「启用证据后，未声明 Evidence 引用或路径不规范的切片报错」
- Scenario: Evidence is current → 「证据指纹与当前实现一致且字段完整时判定新鲜」
- 任务 2.4 三类情况：指纹一致（同上）、缺少证据（同上）、字段不完整 →「证据字段不完整时报 CRITICAL 并列出缺失项」「验证结果为 FAIL 的证据不能支撑已完成切片」
- 指纹口径 →「fingerprint 随实现变化，写证据/勾选/评审产物不改变指纹，且不动用户 index」

## 剩余风险
- 「证据先于勾选」的执行顺序是 apply agent 的行为约束；脚本只能在事后发现「已勾选却无证据」，不能阻止 agent 先勾选。
- 指纹对超大仓库需要全量读取工作区文件，耗时随仓库体积增长（未在大仓库实测）。

## 豁免记录
| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |
|------------------|----------------|---------|--------------------|-------|------|
