import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { FULL_WIDTH_LINES, SIGNATURE_LINES, UNICODE_SPACES, UNICODE_SPACE_LINES, VERDICT_LINES } from './lib/review-approval-samples.mjs'

/**
 * 人工签字门禁 hook 的判定测试。
 *
 * hook 是 apply 前的硬门禁：review-summary.md 存在但签字行仍是空白占位时必须 deny，
 * 写入了批准人姓名时才放行。判定一旦放宽就会静默放过未签字的变更，因此这里逐个固定住边界写法。
 * 被测脚本：skills/openspec-technical-review/hooks/check-review-approval.sh
 * 签字行与裁决行样本取自 scripts/lib/review-approval-samples.mjs，facts 的一致性测试用同一组样本。
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
function runHook(t, signoffLine, { withSummary = true, command = 'openspec apply demo', locale } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'approval-hook-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  if (withSummary) {
    mkdirSync(join(root, 'openspec/changes/demo'), { recursive: true })
    const body = signoffLine === null ? '# 汇总（没有签字行）\n' : `# 汇总\n\n${signoffLine}\n`
    writeFileSync(join(root, 'openspec/changes/demo/review-summary.md'), body)
  }
  const r = spawnSync('/bin/bash', [HOOK.pathname], {
    cwd: root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...(locale ? { LC_ALL: locale } : {}) },
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, `hook 应以 0 退出：${r.stderr}`)
  const denied = r.stdout.trim() === '' ? false : decisionOf(r.stdout) === 'deny'
  return { denied, stdout: r.stdout }
}

test('签字行仍是下划线占位 → deny', (t) => {
  for (const line of SIGNATURE_LINES.placeholder) assert.equal(runHook(t, line).denied, true, line)
})

test('保留占位符再补括号说明（未写批准人）→ deny', (t) => {
  // 评测里实际观察到的两种写法：占位下划线后跟「（签字 / 日期）」「（签名 / 日期）」。
  // 这类行没写任何批准人，若被当成已签字放行，等于绕过人工门禁。
  for (const line of SIGNATURE_LINES.placeholderWithNote) assert.equal(runHook(t, line).denied, true, line)
})

test('写入了批准人姓名 → 放行', (t) => {
  for (const line of SIGNATURE_LINES.signed) assert.equal(runHook(t, line).denied, false, line)
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

const UNSIGNED = SIGNATURE_LINES.placeholder[0]

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
  for (const line of VERDICT_LINES.blocked) {
    assert.equal(runHook(t, `Gate-Level: L2\n${line}\n${SIGNATURE_LINES.signed[0]}`).denied, true, JSON.stringify(line))
  }
})

test('CRLF 换行的 summary 中 Gate-Verdict: BLOCKED 仍拦截', (t) => {
  // 裁决行与签字行都以 CR 结尾，取自共享样本中以 CR 结尾的写法。
  const endsWithCr = line => line.endsWith('\r')
  assert.equal(runHook(t, `${VERDICT_LINES.blocked.find(endsWithCr)}\n${SIGNATURE_LINES.signed.find(endsWithCr)}`).denied, true)
})

// 全角空格（U+3000）在 C locale 下不算空白，在 UTF-8 locale 下算空白，hook 判定曾随 locale 变化，所以三种都跑。
const LOCALES = ['C', 'zh_CN.UTF-8', 'en_US.UTF-8']
const SIGNED = SIGNATURE_LINES.signed[0]

test('Gate-Verdict 值的前后有全角空格或全角括号说明时仍按 BLOCKED 拦截', (t) => {
  // 中文输入法下常见的三种写法：awk 不按全角空格分词，值曾被取成「BLOCKED　（未闭环）」等，BLOCKED 的评审被放行。
  for (const locale of LOCALES) {
    for (const verdictLine of FULL_WIDTH_LINES.blockedVerdict) {
      assert.equal(runHook(t, `${verdictLine}\n${SIGNED}`, { locale }).denied, true, `${locale}: ${verdictLine}`)
    }
  }
})

test('签字值只有全角空格 → deny', (t) => {
  // tr -d '[:space:]' 在 C locale 下不删除全角空格，签字值曾被当成非空而放行。
  for (const locale of LOCALES) {
    for (const signoffLine of FULL_WIDTH_LINES.blankSignature) {
      assert.equal(runHook(t, signoffLine, { locale }).denied, true, `${locale}: ${JSON.stringify(signoffLine)}`)
    }
  }
})

test('READY 后接全角说明、签名中含全角空格 → 放行', (t) => {
  // 防止处理全角空格时拦得过宽：裁决仍是 READY、签字行写了批准人时必须放行。
  for (const locale of LOCALES) {
    for (const verdictLine of FULL_WIDTH_LINES.readyVerdict) {
      assert.equal(runHook(t, `${verdictLine}\n${SIGNED}`, { locale }).denied, false, `${locale}: ${verdictLine}`)
    }
    for (const signoffLine of FULL_WIDTH_LINES.signedSignature) {
      assert.equal(runHook(t, signoffLine, { locale }).denied, false, `${locale}: ${signoffLine}`)
    }
  }
})

const hex = ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`

test('非 ASCII 空白清单与 JS \\s 相同', () => {
  // facts 与 hook 必须用同一组空白：清单少一个字符，C locale 下两边对这个字符的判定就会相反。
  // 清单在共享样本中，hook 的 UNICODE_SPACES 按 UTF-8 字节列出同一组字符，下面的测试逐个字符覆盖它们。
  const jsSpaces = []
  for (let cp = 0x80; cp <= 0xFFFF; cp++) if (/\s/.test(String.fromCharCode(cp))) jsSpaces.push(String.fromCharCode(cp))
  assert.deepEqual(UNICODE_SPACES.map(hex), jsSpaces.map(hex))
})

test('Gate-Verdict 之前有非 ASCII 空白或冒号为全角时仍按 BLOCKED 拦截', (t) => {
  // 识别裁决行的 grep 曾不设 LC_ALL=C，[[:space:]] 在 C locale 下只含 ASCII 空白：
  // 行首或列表、引用标记之后写了这类空白的 BLOCKED 裁决行不被当作裁决行，已签字时放行 apply。
  // 中文输入法下常把冒号写成全角：只认半角冒号时这类裁决行在所有 locale 下都不被识别。
  for (const locale of LOCALES) {
    for (const verdictLine of UNICODE_SPACE_LINES.blockedVerdict) {
      assert.equal(runHook(t, `${verdictLine}\n${SIGNED}`, { locale }).denied, true, `${locale}: ${JSON.stringify(verdictLine)}`)
    }
  }
})

test('签字值中只有非 ASCII 空白或空白加下划线占位 → deny', (t) => {
  // 删除签字值空白的 tr 在 C locale 下只删 ASCII 空白：只有 U+00A0 的签字值曾被当成非空而放行，
  // U+00A0 写在下划线占位之前时签字值不以两个下划线开头，也被当成已签字。
  for (const locale of LOCALES) {
    for (const signoffLine of UNICODE_SPACE_LINES.blankSignature) {
      assert.equal(runHook(t, signoffLine, { locale }).denied, true, `${locale}: ${JSON.stringify(signoffLine)}`)
    }
  }
})

test('READY 裁决行或签名中含非 ASCII 空白 → 放行', (t) => {
  // 防止处理这类空白与全角冒号时拦得过宽：READY 裁决行前有空白或冒号为全角、签名中间或前面有空白时，仍按已签字放行。
  for (const locale of LOCALES) {
    for (const verdictLine of UNICODE_SPACE_LINES.readyVerdict) {
      assert.equal(runHook(t, `${verdictLine}\n${SIGNED}`, { locale }).denied, false, `${locale}: ${JSON.stringify(verdictLine)}`)
    }
    for (const signoffLine of UNICODE_SPACE_LINES.signedSignature) {
      assert.equal(runHook(t, signoffLine, { locale }).denied, false, `${locale}: ${JSON.stringify(signoffLine)}`)
    }
  }
})

test('签字行标记的词之间是非 ASCII 空白 → 不算签字行，deny', (t) => {
  // 签字行标记按字面匹配原文，与 facts 的 includes 相同；非 ASCII 空白在定位标记之后才替换。
  // 先替换再找标记时，这一行会被当作已签字的签字行，比修复前放得更宽，facts 也找不到它。
  for (const locale of LOCALES) {
    for (const signoffLine of UNICODE_SPACE_LINES.brokenMarker) {
      assert.equal(runHook(t, signoffLine, { locale }).denied, true, `${locale}: ${JSON.stringify(signoffLine)}`)
    }
  }
})

test('超长 heredoc 命令不让 hook 报错退出', (t) => {
  // 首行取法曾走 printf | head 管道，超过管道缓冲时 SIGPIPE 会在 pipefail 下让 hook 以非 0 退出。
  const body = 'x'.repeat(200 * 1024)
  assert.equal(runHook(t, UNSIGNED, { command: `cat > big.txt <<'EOF'\n${body}\nEOF` }).denied, false)
})

test('超长 review-summary.md 不让 hook 报错退出或漏判', (t) => {
  // hook 先用 sed 替换非 ASCII 空白再交给 grep -m1：grep 读到第一个匹配就退出，超过管道缓冲时 sed 会收到 SIGPIPE，
  // pipefail 下不能因此以非 0 退出，也不能读不到裁决行与签字行。
  const body = '正文　xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n'.repeat(20000)
  assert.equal(runHook(t, `Gate-Verdict: BLOCKED\n${SIGNED}\n${body}`).denied, true)
  assert.equal(runHook(t, `Gate-Verdict: READY_FOR_HUMAN_APPROVAL\n${SIGNED}\n${body}`).denied, false)
})

test('Gate-Verdict 为 READY 或缺该行（旧版产物）时只看签字', (t) => {
  for (const line of VERDICT_LINES.notBlocked) {
    assert.equal(runHook(t, `${line}\n${SIGNATURE_LINES.signed[0]}`).denied, false, JSON.stringify(line))
    assert.equal(runHook(t, `${line}\n${SIGNATURE_LINES.placeholder[0]}`).denied, true, JSON.stringify(line))
  }
  assert.equal(runHook(t, SIGNED).denied, false)
})

test('研发流程文档的「行为验证」片段对当前 hook 输出 1', () => {
  // 文档曾要求 grep 一句已被删掉的提示文案、并在缺 summary 的变更上断言被拒，两者都与实现相反。
  // 这里直接执行文档里的片段，hook 行为或文档任一侧漂移，测试即失败。
  const doc = readFileSync(new URL('../workflow/OpenSpec-AI-研发流程.md', import.meta.url), 'utf8')
  const section = doc.split('#### 行为验证')[1]
  assert.ok(section, '流程文档缺少「行为验证」小节')
  const snippet = section.match(/```bash\n([\s\S]*?)```/)?.[1]
  assert.ok(snippet, '「行为验证」小节缺少 bash 代码块')
  const r = spawnSync('/bin/bash', ['-c', snippet], {
    env: { ...process.env, HOOK: HOOK.pathname },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), '1')
})
