# Slice 03 新鲜证据

- Slice: 03
- Behavior: OpenSpec 四个卡点调用 STE 检查
- Seam: `/opsx:propose`、`/opsx:update`、`/opsx:apply`、`/opsx:verify` skill 入口
- Recorded At: 2026-10-08T06:02:01Z
- Fingerprint: git-tree:26b9ff0be36d8ec033a14060924e9b177f2cea57
- Fingerprint Source: node skills/openspec-technical-review/scripts/implementation-gate.mjs fingerprint openspec/changes/add-ste-gate
- Result: PASS

## 变更文件
- skills/openspec-propose/SKILL.md
- skills/openspec-update-change/SKILL.md
- skills/openspec-apply-change/SKILL.md
- skills/openspec-verify-change/SKILL.md
- claude/commands/opsx/propose.md
- claude/commands/opsx/update.md
- claude/commands/opsx/apply.md
- claude/commands/opsx/verify.md
- skills/openspec-ste/shared/vocabulary.yaml（实际运行中发现的子串误报：删除「现阶段」「个数」「编制」，为 10 个词条增加例外短语）
- skills/openspec-ste/shared/ste-rules.md
- skills/openspec-ste/scripts/ste-lint.mjs（告警摘要压缩空白）

## 验证命令
| 命令 | 结果 | 摘要 |
|------|------|------|
| `npm run verify` | PASS | 全部 140 条引用可达，新增的 `../openspec-ste/scripts/ste-lint.mjs`、`../openspec-ste/shared/ste-rules.md` 引用无断链 |
| `bash scripts/pack-skill.sh openspec-ste -o /tmp/ste-pack` + 解压到 /tmp 后运行 `node <解压目录>/scripts/ste-lint.mjs check openspec/changes/add-ste-gate` | PASS | 包内含 `vendor/js-yaml.mjs` 与 `vendor/js-yaml.LICENSE`；解压副本退出码 0，`config-snippet` 正常输出 |
| `node skills/openspec-ste/scripts/ste-lint.mjs check openspec/changes/add-ste-gate` | PASS | 首次运行退出码 1（17 个阻断项）；修正产物措辞与词表误报后退出码 0：blocking 0、warnings 47、exemptions 0 |
| `npm test` | PASS | verify + orchestration 15 + migration 24 + gate 22 + ste 27，全部通过 |

| `node --test scripts/test-ste-lint.mjs` + `npm run verify`（全部切片完成后刷新指纹） | PASS | ste 41 tests 全部通过（含本切片全部用例）；153 条引用可达。完整 `npm test` 此时因另一个变更 add-change-model-visualization 进行中的 `test:change-model` 失败（4 fail），与本变更无关，未作为本切片的验证命令 |
## 覆盖的验收行为
- ste-lint / Propose fixes blocking findings → 实际运行：本次 apply 对本变更运行 `check`，按 `blocking` 修正 proposal / design / tasks / spec 措辞后重跑到退出码 0（skill 入口为提示词流程，无法自动化测试，见 design.md「测试 Seam 决策」）
- ste-lint / Apply stops on blocking findings → `openspec-apply-change` 与 `/opsx:apply` 的 Step 2 已写明退出码 1 时列出问题并停止；首次实际运行的退出码 1 即为该分支的触发条件
- ste-lint / STE skill not installed → 四个 skill 与四个 opsx 命令统一写明「STE 检查已跳过：未找到 openspec-ste（<原因>）」
- 切片行为：`openspec-verify-change` 每个阻断项记为 CRITICAL，报告摘要增加 STE 行

## 剩余风险
- skill 入口是提示词流程，卡点行为依赖 agent 按文档执行，没有自动化测试。
- 启发式告警在本变更产物上为 47 条（主要是 tasks.md 的指令句长度与「；」），只告警不阻断；噪声水平需在后续变更中观察。

## 豁免记录
| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |
|------------------|----------------|---------|--------------------|-------|------|
