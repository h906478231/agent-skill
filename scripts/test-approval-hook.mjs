import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * 人工签字门禁 hook 的判定测试。
 *
 * hook 是 apply 前的硬门禁：review-summary.md 存在但签字行仍是空白占位时必须 deny，
 * 写入了批准人姓名时才放行。判定一旦放宽就会静默放过未签字的变更，因此这里逐个固定住边界写法。
 * 被测脚本：skills/openspec-technical-review/hooks/check-review-approval.sh
 */
const HOOK = new URL('../skills/openspec-technical-review/hooks/check-review-approval.sh', import.meta.url)

/** 从 hook 的 stdout 解析 permissionDecision；输出不是 JSON 时抛错。 */
function decisionOf(stdout) {
  const parsed = JSON.parse(stdout)
  return parsed?.hookSpecificOutput?.permissionDecision ?? null
}

/** 造一个只含 review-summary.md 的临时项目，返回 hook 的判定结果。 */
function runHook(t, signoffLine, { withSummary = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'approval-hook-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  if (withSummary) {
    mkdirSync(join(root, 'openspec/changes/demo'), { recursive: true })
    const body = signoffLine === null ? '# 汇总（没有签字行）\n' : `# 汇总\n\n${signoffLine}\n`
    writeFileSync(join(root, 'openspec/changes/demo/review-summary.md'), body)
  }
  const r = spawnSync('/bin/bash', [HOOK.pathname], {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    input: JSON.stringify({ tool_input: { command: 'openspec apply demo' } }),
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `hook 应以 0 退出：${r.stderr}`)
  const denied = r.stdout.trim() === '' ? false : decisionOf(r.stdout) === 'deny'
  return { denied, stdout: r.stdout }
}

test('签字行仍是下划线占位 → deny', (t) => {
  assert.equal(runHook(t, 'Technical Review Approved: __________').denied, true)
})

test('保留占位符再补括号说明（未写批准人）→ deny', (t) => {
  // 评测里实际观察到的两种写法：占位下划线后跟「（签字 / 日期）」「（签名 / 日期）」。
  // 这类行没写任何批准人，若被当成已签字放行，等于绕过人工门禁。
  assert.equal(runHook(t, 'Technical Review Approved: __________ （签字 / 日期）').denied, true)
  assert.equal(runHook(t, 'Technical Review Approved: ____________________    （签名 / 日期）').denied, true)
  assert.equal(runHook(t, 'Technical Review Approved: ＿＿＿（签名）').denied, true)
})

test('写入了批准人姓名 → 放行', (t) => {
  assert.equal(runHook(t, 'Technical Review Approved: 张三  2026-10-14').denied, false)
  assert.equal(runHook(t, 'Technical Review Approved: 张三（研发负责人） 2026-10-14').denied, false)
})

test('review-summary.md 不存在（未启用门禁）→ 放行', (t) => {
  assert.equal(runHook(t, null, { withSummary: false }).denied, false)
})

test('review-summary.md 存在但缺签字行 → deny', (t) => {
  assert.equal(runHook(t, null).denied, true)
})

test('非 apply 命令一律放行', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'approval-hook-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const r = spawnSync('/bin/bash', [HOOK.pathname], {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    input: JSON.stringify({ tool_input: { command: 'openspec list' } }),
    encoding: 'utf8',
  })
  assert.equal(r.status, 0)
  assert.equal(r.stdout.includes('deny'), false)
})
