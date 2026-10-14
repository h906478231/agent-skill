import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 上游副本中的本仓增强检测。
 *
 * skills/openspec-{explore,propose,…}/SKILL.md 与 claude/commands/opsx/*.md 由 OpenSpec CLI 生成（当前 1.6.0），
 * 本仓在其中追加了门禁、STE、切片证据等增强。升级 OpenSpec 重新生成这些文件时，增强会被整文件覆盖，
 * 且混在大段上游 diff 里不易察觉。这里为每个增强主题登记一句锚点原文：锚点消失即说明增强丢失。
 *
 * 锚点取自本仓增强、且不出现在上游原文中（登记时已对照 OpenSpec 1.6.0 生成结果核对）。
 * 有意增删增强时同步更新本清单；测试失败时用 git diff 找回丢失内容，再与新版上游合并。
 */
const ANCHORS = {
  'skills/openspec-explore/SKILL.md': [
    'Phase 1: 需求澄清 - 应用第一性原理',
    '**区分表面需求与底层问题**',
    'Phase 2: 方案探索 - 交叉验证',
    '**方案 MVP（必选）**',
    '质量检查点（本仓自加）',
    '要把第一性原理分析写入 proposal.md 吗？',
    '## 质量保障原则（本仓自加，非上游原文）',
  ],
  'claude/commands/opsx/explore.md': [
    'Phase 1: 需求澄清 - 应用第一性原理',
    '**区分表面需求与底层问题**',
    'Phase 2: 方案探索 - 交叉验证',
    '质量检查点（本仓自加）',
    '要把第一性原理分析写入 proposal.md 吗？',
    '### 质量保障原则（本仓自加',
  ],
  'skills/openspec-propose/SKILL.md': [
    '先按下文 Output 一节的门禁提示',
    '**Task slicing discipline',
    '**Phase 1/2 产物区块',
    '**STE 检查（本仓自加',
    '**变更模型检查（本仓自加',
    '**门禁提示（本仓自加',
    'follow the slicing rules in `shared/task-slicing.md`',
  ],
  'claude/commands/opsx/propose.md': [
    '先按下文 Output 一节的门禁提示',
    '**任务切片纪律',
    '**Phase 1/2 产物区块',
    '**STE 检查（本仓自加',
    '**变更模型检查（本仓自加',
    '**门禁提示（本仓自加',
  ],
  'claude/commands/opsx/ff.md': [
    '**门禁提示（本仓自加',
    '**本仓自加的产物规则（非上游原文）**',
  ],
  'skills/openspec-apply-change/SKILL.md': [
    '**Technical Review Gate check (BLOCKING',
    'shared/apply-gate-check.md',
    '**STE 检查（BLOCKING，本仓自加',
    '**变更模型检查（BLOCKING，本仓自加',
    '**基线任务数（本仓自加',
    '**TDD 实施纪律',
    '**切片新鲜证据（本仓自加',
    '**完整套件存在失败时（本仓自加）**',
    '**实现全部完成后进入质量评审与验证，不得直接归档**',
  ],
  'claude/commands/opsx/apply.md': [
    '**技术评审门禁校验（BLOCKING',
    'shared/apply-gate-check.md',
    '**STE 检查（BLOCKING，本仓自加',
    '**变更模型检查（BLOCKING，本仓自加',
    '**基线任务数（本仓自加）**',
    '**TDD 实施纪律',
    '**切片新鲜证据（本仓自加',
    '**完整套件存在失败时（本仓自加）**',
    '**实现全部完成后进入质量评审与验证，不得直接归档**',
  ],
  'skills/openspec-update-change/SKILL.md': [
    'keep the repository-mandated blocks intact',
    '**范围扩展拆分提示（本仓自加',
    '**STE 检查（本仓自加',
    '**变更模型检查（本仓自加',
  ],
  'claude/commands/opsx/update.md': [
    'keep the repository-mandated blocks intact',
    '**范围扩展拆分提示（本仓自加',
    '**STE 检查（本仓自加',
    '**变更模型检查（本仓自加',
  ],
  'skills/openspec-archive-change/SKILL.md': [
    'Implementation gate result',
    '**归档前置校验（本仓自加，非上游原文）**',
    '**门禁类问题必须阻断，不得只告警**',
  ],
  'claude/commands/opsx/archive.md': [
    'Implementation gate result',
    '**归档前置校验（本仓自加，非上游原文）**',
    '**门禁类问题必须阻断，不得只告警**',
  ],
  'skills/openspec-verify-change/SKILL.md': [
    '**核心机制：交叉验证 III',
    '**切片证据与双轴评审闭环（本仓自加',
    '<changeRoot>/verification.md',
    '| Evidence     |',
    'Artifacts outside the allowlist',
    '**交叉验证 III：人工核对清单',
    '**完整的交叉验证链条**',
  ],
  'claude/commands/opsx/verify.md': [
    '**核心机制：交叉验证 III',
    '**切片证据与双轴评审闭环（本仓自加',
    '<changeRoot>/verification.md',
    '| Evidence     |',
    'Artifacts outside the allowlist',
    '**交叉验证 III：人工核对清单',
    '**完整的交叉验证链条**',
  ],
}

for (const [file, anchors] of Object.entries(ANCHORS)) {
  test(`${file} 保留全部本仓增强`, async () => {
    const text = await readFile(new URL(`../${file}`, import.meta.url), 'utf8')
    const missing = anchors.filter(a => !text.includes(a))
    assert.deepEqual(missing, [], `${file} 缺少本仓增强（疑似被上游重新生成覆盖），用 git diff 找回后再合并：${missing.join(' / ')}`)
  })
}
