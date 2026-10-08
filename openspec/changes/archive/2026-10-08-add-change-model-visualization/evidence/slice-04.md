# Slice 04 新鲜证据

- Slice: 04
- Behavior: OpenSpec 卡点运行变更模型检查，design 编写说明包含变更模型
- Seam: `/opsx:propose`、`/opsx:update`、`/opsx:apply`、`/opsx:verify` skill 入口
- Recorded At: 2026-10-08T07:06:52Z
- Fingerprint: git-tree:2706d4050ae9b059bd1a041f11c4669fd5503d05
- Fingerprint Source: node skills/openspec-technical-review/scripts/implementation-gate.mjs fingerprint openspec/changes/add-change-model-visualization
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

## 验证命令
| 命令 | 结果 | 摘要 |
|------|------|------|
| `npm run -s verify` | PASS | 168 条资产引用全部可达（含新增的 `../openspec-change-overview/scripts/change-model.mjs` 与 `shared/change-model.md` 引用） |
| `bash scripts/pack-skill.sh openspec-change-overview -o /tmp/packtest` + `tar tzf` | PASS | 包内含 `assets/overview-template.html`、`vendor/elk.bundled.js`、`vendor/elk.LICENSE.md`、`vendor/js-yaml.mjs`、`vendor/js-yaml.LICENSE`、`vendor/package.json` |
| 解包后的脚本独立运行 `render` / `check`（无 node_modules、无 openspec-ste） | PASS | render 输出与仓库内运行逐字节一致；check 跳过 CM-2 并告警 |
| `node skills/openspec-change-overview/scripts/change-model.mjs check openspec/changes/add-change-model-visualization` | PASS | 退出码 0，blocking 为空（任务 4.4） |
| `node skills/openspec-ste/scripts/ste-lint.mjs check openspec/changes/add-change-model-visualization` | PASS | 退出码 0，blocking 为空 |
| 构造 CM-4 阻断的变更运行 `check`（apply / verify 卡点的输入） | PASS | 退出码 1，报告 `design.md:20`、`CM-4`、`T2`、`path` |
| `npm test` | PASS | verify 168 条引用可达；orchestration 15 + migration 24 + gate 22 + ste 41 + change-model 30，全部通过 |

## 覆盖的验收行为
- change-model / Apply with a blocking change-model finding → apply 的 SKILL 与命令在 STE 检查后运行 `check`，退出码 1 时逐项列出并停止、不开始任何任务；`check` 对阻断模型退出码 1 并给出可列出的检查项（上表 CM-4 演示）
- OpenSpec workflow SHALL run the change-model check with the STE check → propose / update / apply / verify 四个 skill 与四个命令均在 STE 检查之后紧接运行，退出码处理引用同一张 `gate-check.md` 表；verify 报告增加 Change Model 行与 CRITICAL 条目
- design.md SHALL contain a visualization decision section（编写侧）→ propose 的 SKILL 与命令「Phase 1/2 产物区块」新增「可视化判定」与变更模型编写要求
- 任务 4.4 → 本变更目录 `check` 退出码 0

## 剩余风险
- skill 入口是提示词，没有自动化测试；本次在本 apply 会话中按新的卡点口径对本变更执行了 STE 与变更模型检查（均为退出码 0），并用构造的阻断变更验证了脚本输出。下一次真实的 `/opsx:propose` / `/opsx:update` / `/opsx:verify` 运行时才会走到这些新段落。
- 已安装到 `~/.claude/skills` 的 skill 是旧版本，需要重新安装后斜杠命令才使用新卡点。

## 豁免记录
| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |
|------------------|----------------|---------|--------------------|-------|------|
