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

/**
 * 造一个只含 review-summary.md 的临时项目，返回 hook 的判定结果。
 * signoffLine 为 null 时 summary 不写签字行；command 是 Bash 工具要执行的整条命令。
 */
function runHook(t, signoffLine, { withSummary = true, command = 'openspec apply demo' } = {}) {
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
    input: JSON.stringify({ tool_input: { command } }),
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

const UNSIGNED = 'Technical Review Approved: __________'

test('只是提到 openspec apply 的命令 → 放行', (t) => {
  // 正则曾对整条命令做子串匹配，查 git 历史、写日志、grep 统计都会被未签字的门禁误拦。
  for (const command of [
    'git log --grep=openspec apply demo',
    'echo openspec apply demo >> log.txt',
    'grep -rn "openspec apply demo" docs',
    "cat > notes.md <<'EOF'\nopenspec apply demo\nEOF",
  ]) {
    assert.equal(runHook(t, UNSIGNED, { command }).denied, false, command)
  }
})

test('在可执行位置运行 apply → 拦截', (t) => {
  for (const command of [
    'openspec apply demo',
    '/opsx:apply demo',
    'opsx apply demo',
    'cd repo && openspec apply demo',
    'echo start; openspec apply demo',
    'FOO=1 npx openspec apply demo',
    'npx -y @fission-ai/openspec@latest apply demo',
    './node_modules/.bin/openspec apply --verbose demo',
  ]) {
    assert.equal(runHook(t, UNSIGNED, { command }).denied, true, command)
  }
})

test('Gate-Verdict: BLOCKED 时即使已签字也拦截', (t) => {
  assert.equal(runHook(t, 'Gate-Level: L2\nGate-Verdict: BLOCKED\nTechnical Review Approved: 张三 2026-10-14').denied, true)
  assert.equal(runHook(t, '- Gate-Verdict: `BLOCKED`\nTechnical Review Approved: 张三 2026-10-14').denied, true)
})

test('CRLF 换行的 summary 中 Gate-Verdict: BLOCKED 仍拦截', (t) => {
  assert.equal(runHook(t, 'Gate-Verdict: BLOCKED\r\nTechnical Review Approved: 张三 2026-10-14\r').denied, true)
})

test('超长 heredoc 命令不让 hook 报错退出', (t) => {
  // 首行取法曾走 printf | head 管道，超过管道缓冲时 SIGPIPE 会在 pipefail 下让 hook 以非 0 退出。
  const body = 'x'.repeat(200 * 1024)
  assert.equal(runHook(t, UNSIGNED, { command: `cat > big.txt <<'EOF'\n${body}\nEOF` }).denied, false)
})

test('Gate-Verdict 为 READY 或缺该行（旧版产物）时只看签字', (t) => {
  assert.equal(runHook(t, 'Gate-Verdict: READY_FOR_HUMAN_APPROVAL\nTechnical Review Approved: 张三 2026-10-14').denied, false)
  assert.equal(runHook(t, 'Gate-Verdict: READY_FOR_HUMAN_APPROVAL\nTechnical Review Approved: __________').denied, true)
  assert.equal(runHook(t, 'Technical Review Approved: 张三 2026-10-14').denied, false)
})

