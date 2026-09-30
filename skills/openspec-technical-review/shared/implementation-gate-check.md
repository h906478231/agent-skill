# 实现阶段门禁校验：Verify 与 Archive（唯一事实源）

> `/opsx:verify` 与 `/opsx:archive` 对**双轴评审**与**切片新鲜证据**的核对方式。`skills/openspec-verify-change/SKILL.md`、`claude/commands/opsx/verify.md`、`skills/openspec-archive-change/SKILL.md`、`claude/commands/opsx/archive.md` 四处都引用本文件，不各写一份。
> 路径：`<SKILL_DIR>/shared/implementation-gate-check.md`；校验脚本 `<GATE>` = `<SKILL_DIR>/scripts/implementation-gate.mjs`（`<SKILL_DIR>` 为 skill `openspec-technical-review` 的安装目录，解析方式见其 SKILL.md「路径约定」；解析不到时 Glob 搜 `**/openspec-technical-review/scripts/implementation-gate.mjs`），运行需 Node.js ≥ 16。
> 规则本身不在此重复：双轴评审见 `../../openspec-code-quality/shared/dual-axis-review.md`，切片证据见 `../../openspec-apply-change/shared/slice-evidence.md`。

## 适用范围与不追溯

- 脚本按产物自动判定是否适用：`tasks.md` 切片声明了 `Evidence:` 引用，即视为按新规则创建的变更，**切片证据与双轴评审产物都必需**；只有 `review/` 下出现任一双轴产物时，也会校验评审完整性。
- **不追溯历史变更**：历史变更与无切片的平铺任务清单返回 `applicable: false` 与 `reason`（以「不适用：」开头），不阻断，但 Verify 报告与归档摘要**必须原样写出该理由**，不得写成「证据通过」。
- L0 豁免双轴评审；L0 若创建了评审或证据产物，照样按完整性规则校验。
- 历史变更的 `review/code-quality.md` 仍按 archive 原有规则检查（结论不得为「打回」，未闭环 Blocker 为 0）。

## Verify（Phase 6）：证据与评审闭环

在三维校验的 Completeness 之后运行：

```bash
node <GATE> evidence <changeRoot>
node <GATE> review <changeRoot>
```

| 脚本输出 | Verify 处理 |
|---------|------------|
| `evidence.applicable = false` | 报告写「切片证据：<reason>」，不计 CRITICAL |
| 切片 `status` 为 `missing` / `incomplete` / `failed` / `no-reference`（出现在 `issues`） | **CRITICAL**，逐条列出切片编号与原因 |
| 切片 `status = stale` | **CRITICAL**。按 `changedSinceEvidence` 判断：变化可能影响本切片 → 重跑该切片验证并更新证据；确认**全部**变化与本切片行为无关 → 按 `slice-evidence.md`「豁免记录格式」登记后重跑 `evidence`；无法判断 → 按过期重跑 |
| `evidence.warnings`（切片未全部勾选时的问题） | WARNING（未完成任务本身已是 CRITICAL） |
| `review.applicable = false` | 报告写「双轴评审：<reason>」 |
| `review.verdict = BLOCKED` | **CRITICAL**，列出各轴 `openBlockers`，回 `/opsx:quality` 闭环 |
| `review.verdict = INCOMPLETE` 或 `review.issues` 非空 | **CRITICAL**，补齐或修正评审报告后重跑 |
| `review.warnings`（评审基线指纹 ≠ 当前实现） | WARNING：评审后实现有变化，判断是否需要重跑双轴 |

脚本之外，Verify 还需人工核对两点（脚本无法判断语义）：

1. **Seam 覆盖**：每份证据的 `Seam` 与 `tasks.md` 该切片 `Seam:` 行一致；「覆盖的验收行为」能对应到分配给该切片的 spec Scenario。缺失关键 Scenario 记 CRITICAL，其余不一致记 WARNING。
2. **勾选与证据对应**：已勾选任务在证据的验证命令或覆盖行为中有对应项，抽查不到的记 WARNING。

修复时**禁止**为了通过而改写证据结果、删除 `Evidence:` 引用或删除原始 finding；证据只能通过真实重跑来刷新。

## Archive：归档前置阻断

在移动变更目录之前运行：

```bash
node <GATE> archive <changeRoot>
```

| 退出码 | 处理 |
|--------|------|
| `0` | 本项通过；把 `notes`（不适用理由）与 `warnings` 写进归档摘要，继续 archive 其余前置校验 |
| `1` | **拒绝归档**，向用户列出 `blockers`（含切片编号或 finding ID），回到对应阶段处理：评审 Blocker → `/opsx:quality`；缺失 / 过期证据 → 重跑切片验证（`/opsx:apply` 的证据规则）后 `/opsx:verify` |
| `2` | 参数或环境错误（非 git 仓库、缺 Node.js 等）：**不得视为通过**，修复环境后重跑；证据新鲜度无法核实即按过期处理 |

本脚本只覆盖双轴评审与切片证据。Verify 的其他 CRITICAL（未完成任务、需求未实现等）不在脚本判定范围，仍按 archive 原有规则：CRITICAL 清零并取得用户「验证已通过」的显式确认。

## 边界

- 校验只读：不改代码、不改评审报告与证据，不代替用户做豁免判断。
- 不自动执行 git push、创建 PR、部署、发布或云舟等外部任务回写；这些动作需用户另行授权。
