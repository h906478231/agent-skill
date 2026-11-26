import { test } from './lib/test-shard.mjs'
import assert from 'node:assert/strict'
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { snapshot } from './lib/fs-snapshot.mjs'
import { GATE_TRACE_SAMPLES, STANDARD_TRACE_REPORT } from './lib/gate-trace-samples.mjs'
import { STORYBOARD_SIGNATURE_SAMPLES } from './lib/storyboard-signature-samples.mjs'
import { FULL_WIDTH_LINES, SIGNATURE_LINES, SUMMARY_SAMPLES, UNICODE_SPACE_LINES, VERDICT_LINES } from './lib/review-approval-samples.mjs'

// 通过 /opsx:quality、/opsx:apply、/opsx:verify、/opsx:archive 实际调用的确定性校验入口验证行为；
// 每个用例在临时 git 仓库里构造真实变更目录，不连接远端、不改动本仓库。
const gate = fileURLToPath(new URL('../skills/openspec-technical-review/scripts/implementation-gate.mjs', import.meta.url))

/** 创建带一次提交的临时仓库与 demo 变更目录。 */
function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'impl-gate-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const write = (rel, text) => {
    const file = join(repo, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=gate', '-c', 'user.email=gate@example.com',
      '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  write('src/order.js', 'export const create = () => 1\n')
  write('src/pay.js', 'export const pay = () => 2\n')
  write('openspec/changes/demo/proposal.md', '# demo\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  const changeRoot = join(repo, 'openspec/changes/demo')
  const runWithEnv = (env, ...args) => {
    const result = spawnSync(process.execPath, [gate, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } })
    return { code: result.status, out: result.stdout, err: result.stderr, json: () => JSON.parse(result.stdout) }
  }
  const run = (...args) => runWithEnv({}, ...args)
  return { repo, changeRoot, write, git, run, runWithEnv }
}

/** 从 baseline 输出中提取 `- Key: value` 字段。 */
function field(text, key) {
  const match = text.match(new RegExp(`^- ${key}: (.*)$`, 'm'))
  return match ? match[1].trim() : ''
}

const FINDING_HEADER = [
  '| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |',
  '|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|',
].join('\n')

/** 生成一行 finding；位置默认可定位到 `文件:行号`，Blocker 的触发场景默认带判据前缀 `[B4]`。 */
const finding = (id, severity, { location = 'src/order.js:1', status = 'open', trigger } = {}) =>
  `| ${id} | ${severity} | 创建订单 | ${location} | order.create | 白话说明 | ${trigger ?? (severity === 'Blocker' ? '[B4] 正常输入下创建订单失败' : '可复现场景')} | 具体后果 | 具体修复 | ${status} |`

const isOpenBlocker = row => / Blocker \|/.test(row) && /\| open \|$/.test(row)

const LEDGER_HEADER = ['| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |', '|----|---------|---------|------|---------|---------|'].join('\n')

/** 生成一行台账；非 open 状态默认写可定位的闭环依据。 */
const ledgerRow = (id, severity, status = 'open', evidence = status === 'open' ? '' : 'src/order.js:1') =>
  `| ${id} | ${severity} | R1 | ${status} | ${status === 'open' ? '' : 'R2'} | ${evidence} |`

/** 由 finding 行推出一致的台账行（Rules Version 2 报告的默认台账）。 */
const ledgerFrom = rows => rows.map(row => {
  const [id, severity, , , , , , , , status] = row.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
  return ledgerRow(id, severity, status)
})

/** 按规则骨架写一份原始报告；结论默认由是否有未闭环 Blocker 推出；ledger 为 null 时不写台账区块。 */
function axisReport(title, baseline, rows, verdict, ledger = ledgerFrom(rows)) {
  const computed = rows.some(isOpenBlocker) ? '打回' : '通过'
  return [`# ${title}（demo）`, '', baseline.trim(), '', '## Findings', '', FINDING_HEADER,
    ...(rows.length ? rows : ['| 无 | | | | | | | | | |']), '',
    ...(ledger ? ['## Finding 台账', '', LEDGER_HEADER, ...ledger, ''] : []),
    '## 结论', '', `${title} 结论：${verdict || computed}`, ''].join('\n')
}

/** 写入双轴原始报告与汇总；options 可覆盖某一份的基线、结论、台账或跳过某份文件。 */
function writeReview(f, baseline, { standards = [], spec = [], declared, skip = [], baselines = {}, ledgers = {}, summaryLines = [] } = {}) {
  const blocked = [...standards, ...spec].some(isOpenBlocker)
  const files = {
    'review/standards.md': axisReport('Standards Review', baselines.standards || baseline, standards, undefined,
      ledgers.standards === undefined ? ledgerFrom(standards) : ledgers.standards),
    'review/spec-fidelity.md': axisReport('Spec Fidelity Review', baselines.spec || baseline, spec, undefined,
      ledgers.spec === undefined ? ledgerFrom(spec) : ledgers.spec),
    'review/code-review-summary.md': ['# 实现后双轴评审汇总（demo）', '', (baselines.summary || baseline).trim(), '',
      ...(summaryLines.length ? [...summaryLines, ''] : []),
      '## 两轴状态', '', '| 评审轴 | 原始报告 |', '|---|---|',
      '| Standards Review | review/standards.md |', '| Spec Fidelity Review | review/spec-fidelity.md |', '',
      '## 裁决', '', `Code Review Verdict: ${declared || (blocked ? 'BLOCKED' : 'PASSED')}`, ''].join('\n'),
  }
  for (const [rel, text] of Object.entries(files)) {
    if (!skip.includes(rel)) f.write(`openspec/changes/demo/${rel}`, text)
  }
}

// ---------------------------------------------------------------------------
test('trace：在 Git 之外读取变更，并保留缺失报告的默认值', t => {
  const root = mkdtempSync(join(tmpdir(), 'gate-trace-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const result = spawnSync(process.execPath, [gate, 'trace', root], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    command: 'trace', change: root.split('/').at(-1), traceVersion: 1,
    findings: [], rulesVersion: { 'review/standards.md': null, 'review/spec-fidelity.md': null },
    sonar: [], slices: [], signOff: { approval: {}, storyboard: {}, changeHead: null, pendingEnvironment: {} },
  })
})

test('trace：分镜签署行与视频 CLI 使用同一组围栏样本', async t => {
  const f = fixture(t)
  const file = 'video/storyboard.md'
  for (const sample of STORYBOARD_SIGNATURE_SAMPLES) {
    await t.test(sample.name, () => {
      f.write(`openspec/changes/demo/${file}`, sample.lines.join('\n'))
      const trace = f.run('trace', f.changeRoot).json()
      assert.equal(trace.signOff.storyboard[file], sample.value)
    })
  }
})

test('trace：取门禁识别的最后一条签字行，忽略正文示例', t => {
  const f = fixture(t)
  const file = 'review-summary.md'
  for (const sample of SUMMARY_SAMPLES) {
    const expected = sample.lines.filter(line => line.startsWith('Technical Review Approved:')).at(-1)
    f.write(`openspec/changes/demo/${file}`, sample.lines.join('\n'))
    assert.equal(f.run('trace', f.changeRoot).json().signOff.approval[file], expected, sample.name)
  }
  for (const line of [...SIGNATURE_LINES.signed, ...FULL_WIDTH_LINES.blankSignature, ...UNICODE_SPACE_LINES.signedSignature]) {
    f.write(`openspec/changes/demo/${file}`, `${line}\n${SIGNATURE_LINES.notKeyLine.join('\n')}\n`)
    assert.equal(f.run('trace', f.changeRoot).json().signOff.approval[file], line)
  }
})

test('trace：读取变更终点原文和两张 Sonar 表，不解析 Git 提交', t => {
  const f = fixture(t)
  const head = '##  变更终点\n- 提交：尚未校验\n- 判定人：用户\n'
  f.write('openspec/changes/demo/tasks.md', `# 任务\n\n${head}\n## 其他\n`)
  f.write('openspec/changes/demo/review/sonar.md', [
    '## 本次修改行上的问题', '| 规则 | 位置 | 处理 |', '|---|---|---|', '| `js:S1` | `src/order.js:1` | 接受 |', '',
    '## 质量门', '| 条件 | 处理 |', '|---|---|', '| 新代码覆盖率 | `误报` |', '',
  ].join('\n'))
  const result = f.run('trace', f.changeRoot)
  assert.equal(result.code, 0, result.err)
  const trace = result.json()
  assert.equal(trace.signOff.changeHead, head)
  assert.deepEqual(trace.sonar, [
    { table: '本次修改行上的问题', key: 'js:S1', location: 'src/order.js:1', handling: '接受' },
    { table: '质量门', key: '新代码覆盖率', location: '', handling: '误报' },
  ])
})

test('trace：拒绝无法确认归属的资料，不输出快照或外部内容', async t => {
  const cases = [
    { file: 'review/standards.md', category: '评审报告', prepare: symlinkSync },
    { file: 'storyboard.md', category: '签署资料', prepare: linkSync },
    { file: 'evidence/slice-02.md', category: '切片证据', prepare: symlinkSync },
    { file: 'review/sonar.md', category: '评审报告', prepare: (_, file) => mkdirSync(file) },
    { file: 'review', category: '评审报告', prepare: (target, file) => symlinkSync(dirname(target), file) },
    { file: 'evidence', category: '切片证据', prepare: (target, file) => symlinkSync(dirname(target), file) },
  ]
  for (const { file, category, prepare } of cases) {
    await t.test(file, subtest => {
      const f = fixture(subtest)
      const target = join(f.repo, 'external', 'external-marker.md')
      f.write('external/external-marker.md', 'Technical Review Approved: untrusted-marker\n')
      const input = join(f.changeRoot, file)
      mkdirSync(dirname(input), { recursive: true })
      prepare(target, input)
      const result = f.run('trace', f.changeRoot)
      assert.equal(result.code, 2)
      assert.equal(result.out, '')
      assert.ok(result.err.includes(category), result.err)
      assert.doesNotMatch(result.err, /untrusted-marker|external-marker|impl-gate-/)
    })
  }
})

test('trace：拒绝跨切片的证据引用，并允许缺失的可选证据', t => {
  const f = fixture(t)
  const tasksFile = 'openspec/changes/demo/tasks.md'
  const tasks = '## Slice 02: 订单\nEnvironment: MQ\nEvidence: evidence/slice-02.md\n- [ ] 2.1 订单\n'
  f.write(tasksFile, tasks)
  assert.deepEqual(f.run('trace', f.changeRoot).json().slices, [{ id: '02', environment: 'MQ', done: 0, total: 1 }])
  f.write(tasksFile, tasks.replace('slice-02.md', 'slice-01.md'))
  const result = f.run('trace', f.changeRoot)
  assert.equal(result.code, 2)
  assert.equal(result.out, '')
  assert.match(result.err, /切片证据.*引用无效/)
})

test('trace：变更目录不存在时退出码为 2', t => {
  const f = fixture(t)
  const result = f.run('trace', join(f.repo, 'missing-change'))
  assert.equal(result.code, 2)
  assert.equal(result.out, '')
  assert.match(result.err, /变更目录不存在.*missing-change/)
})

test('trace：不区分大小写的检出与 review 读取同一报告', t => {
  const f = fixture(t)
  f.write('openspec/changes/demo/Review/STANDARDS.MD', STANDARD_TRACE_REPORT)
  const file = 'review/standards.md'
  if (!existsSync(join(f.changeRoot, file))) return t.skip('文件系统区分大小写')
  const review = f.run('review', f.changeRoot).json()
  const result = f.run('trace', f.changeRoot)
  assert.equal(result.code, 0, result.err)
  assert.deepEqual(result.json().findings.filter(row => row.file === file && row.openBlocker).map(row => row.id),
    review.axes.find(axis => axis.file === file).openBlockers)
})

// Slice 01：双轴独立 Review 报告（Seam：/opsx:quality → baseline / review 校验）

test('trace：报告行和每行的 Blocker 判定与 review 一致', async t => {
  const f = fixture(t)
  const file = 'review/standards.md'
  for (const sample of [
    { name: '未关闭 Blocker', file, text: STANDARD_TRACE_REPORT, status: 'open', severity: 'Blocker', openBlocker: true },
    ...GATE_TRACE_SAMPLES.filter(item => item.file === file),
  ]) {
    await t.test(sample.name, () => {
      f.write(`openspec/changes/demo/${file}`, sample.text)
      const review = f.run('review', f.changeRoot).json()
      const result = f.run('trace', f.changeRoot)
      assert.equal(result.code, 0, result.err)
      const trace = result.json()
      const findings = trace.findings.filter(row => row.file === file && row.source === 'findings')
      assert.deepEqual(findings.filter(row => row.openBlocker).map(row => row.id),
        review.axes.find(axis => axis.file === file).openBlockers)
      if (sample.status === undefined) assert.deepEqual(findings, [])
      else {
        assert.equal(findings[0]?.status, sample.status)
        assert.equal(findings[0]?.severity, sample.severity ?? 'Blocker')
        if (sample.openBlocker !== undefined) assert.equal(findings[0]?.openBlocker, sample.openBlocker)
      }
      assert.equal(trace.rulesVersion[file], '2')
      assert.ok(trace.findings.some(row => row.file === file && row.source === 'ledger' && row.status === 'open'))
    })
  }
})
// ---------------------------------------------------------------------------

test('baseline 为两轴生成同一基线身份，并包含 git-tree 指纹', t => {
  const f = fixture(t)
  const first = f.run('baseline', f.changeRoot)
  const second = f.run('baseline', f.changeRoot)
  assert.equal(first.code, 0, first.err)
  for (const key of ['Change', 'Base Commit', 'Fingerprint', 'Review Scope']) {
    assert.ok(field(first.out, key), `缺少基线字段 ${key}`)
    assert.equal(field(first.out, key), field(second.out, key), `${key} 两次生成不一致`)
  }
  assert.equal(field(first.out, 'Change'), 'demo')
  assert.equal(field(first.out, 'Base Commit'), f.git('rev-parse', 'HEAD'))
  assert.match(field(first.out, 'Fingerprint'), /^git-tree:[0-9a-f]{40,64}$/)
})

test('两份原始报告齐全、基线一致且无 Blocker 时裁决 PASSED', t => {
  const f = fixture(t)
  writeReview(f, f.run('baseline', f.changeRoot).out, { standards: [finding('STD-01', 'Minor')] })
  const result = f.run('review', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  assert.equal(report.verdict, 'PASSED')
  assert.deepEqual(report.issues, [])
})

test('缺少任一原始报告或汇总时评审不完整', t => {
  for (const missing of ['review/standards.md', 'review/spec-fidelity.md', 'review/code-review-summary.md']) {
    const f = fixture(t)
    writeReview(f, f.run('baseline', f.changeRoot).out, { skip: [missing] })
    const result = f.run('review', f.changeRoot)
    assert.equal(result.code, 1)
    assert.ok(result.json().issues.some(issue => issue.includes(missing)), `未指出缺失的 ${missing}`)
  }
})

test('两轴或汇总基线不一致时报错', t => {
  const f = fixture(t)
  const baseline = f.run('baseline', f.changeRoot).out
  const drifted = baseline.replace(/Fingerprint: git-tree:[0-9a-f]+/, 'Fingerprint: git-tree:0000000000000000000000000000000000000000')
  writeReview(f, baseline, { baselines: { spec: drifted } })
  const result = f.run('review', f.changeRoot)
  assert.equal(result.code, 1)
  assert.ok(result.json().issues.some(issue => issue.includes('基线') && issue.includes('Fingerprint')))
})

test('finding 无法定位到文件行号或前缀与评审轴不符时报错', t => {
  const f = fixture(t)
  writeReview(f, f.run('baseline', f.changeRoot).out, {
    standards: [finding('STD-01', 'Minor', { location: 'OrderService 类里' }), finding('SPEC-09', 'Minor')],
  })
  const issues = f.run('review', f.changeRoot).json().issues
  assert.ok(issues.some(issue => issue.includes('STD-01') && issue.includes('文件:行号')))
  assert.ok(issues.some(issue => issue.includes('SPEC-09') && issue.includes('前缀')))
})

test('任一评审轴存在未闭环 Blocker 时裁决 BLOCKED', t => {
  for (const axis of ['standards', 'spec']) {
    const f = fixture(t)
    const id = axis === 'standards' ? 'STD-01' : 'SPEC-01'
    writeReview(f, f.run('baseline', f.changeRoot).out, { [axis]: [finding(id, 'Blocker')] })
    const result = f.run('review', f.changeRoot)
    assert.equal(result.code, 1)
    const report = result.json()
    assert.equal(report.verdict, 'BLOCKED')
    assert.deepEqual(report.issues, [])
    assert.ok(report.axes.some(item => item.openBlockers.includes(id)))
  }
})

test('已闭环、risk-accepted、误报的 Blocker 不计入裁决', t => {
  const f = fixture(t)
  writeReview(f, f.run('baseline', f.changeRoot).out, {
    standards: [finding('STD-01', 'Blocker', { status: 'closed' }), finding('STD-02', 'Blocker', { status: 'risk-accepted' })],
    spec: [finding('SPEC-01', 'Blocker', { status: 'false-positive' })],
  })
  const result = f.run('review', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  assert.equal(result.json().verdict, 'PASSED')
})

test('汇总自述裁决与原始报告不一致时报错', t => {
  const f = fixture(t)
  writeReview(f, f.run('baseline', f.changeRoot).out, { spec: [finding('SPEC-01', 'Blocker')], declared: 'PASSED' })
  const report = f.run('review', f.changeRoot).json()
  assert.equal(report.verdict, 'BLOCKED')
  assert.ok(report.issues.some(issue => issue.includes('汇总') && issue.includes('PASSED')))
})

// ---------------------------------------------------------------------------
// Slice 02：切片新鲜证据（Seam：/opsx:apply → fingerprint / evidence 校验）
// ---------------------------------------------------------------------------

/** 按切片格式写 tasks.md；evidence=false 表示该切片不声明 Evidence 引用，environment 写入 Environment 行。 */
function writeTasks(f, slices) {
  const text = slices.map(slice => [
    `## Slice ${slice.id}: 行为 ${slice.id}`, 'Blocked by: 无（可立即开始）', 'Seam: POST /orders',
    ...(slice.evidence === false ? [] : [`Evidence: ${slice.evidence || `evidence/slice-${slice.id}.md`}`]),
    ...(slice.environment ? [`Environment: ${slice.environment}`] : []), '',
    ...slice.done.map((checked, i) => `- [${checked ? 'x' : ' '}] ${slice.id}.${i + 1} 任务 ${i + 1}`), '',
  ].join('\n')).join('\n')
  f.write('openspec/changes/demo/tasks.md', text)
}

/** 按 slice-evidence.md 模板生成证据；omit 可去掉字段或整段，exemptions 为豁免记录行，pending 为待环境补测行。 */
function evidence(id, fingerprint, { omit = [], result = 'PASS', commandResult = 'PASS', exemptions = [], pending = [], extra = {} } = {}) {
  const fields = { Slice: id, Behavior: `行为 ${id}`, Seam: 'POST /orders', 'Recorded At': '2026-09-30T10:00:00Z',
    Fingerprint: fingerprint, 'Fingerprint Source': 'node implementation-gate.mjs fingerprint', Result: result, ...extra }
  const sections = {
    变更文件: ['- src/order.js'],
    验证命令: ['| 命令 | 结果 | 摘要 |', '|------|------|------|', `| \`node --test\` | ${commandResult} | 3 tests |`],
    覆盖的验收行为: ['- Scenario: 创建订单成功 → order.test.createsOrder'],
    剩余风险: ['- 无'],
  }
  const lines = [`# Slice ${id} 新鲜证据`, '']
  for (const [key, value] of Object.entries(fields)) if (!omit.includes(key)) lines.push(`- ${key}: ${value}`)
  for (const [title, body] of Object.entries(sections)) if (!omit.includes(title)) lines.push('', `## ${title}`, ...body)
  if (pending.length) {
    lines.push('', '## 待环境补测', '| 登记指纹 | 原因 | 补测计划 | 负责人 | 确认人 | 日期 |', '|---|---|---|---|---|---|',
      ...pending.map(row => `| ${row.join(' | ')} |`))
  }
  lines.push('', '## 豁免记录', '| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |',
    '|------------------|----------------|---------|--------------------|-------|------|',
    ...exemptions.map(row => `| ${row.join(' | ')} |`))
  return `${lines.join('\n')}\n`
}

const fingerprintOf = f => {
  const result = f.run('fingerprint', f.changeRoot)
  assert.equal(result.code, 0, result.err)
  return result.out.trim()
}

test('fingerprint 随实现变化，写证据/勾选/评审产物不改变指纹，且不动用户 index', t => {
  const f = fixture(t)
  const initial = fingerprintOf(f)
  assert.match(initial, /^git-tree:[0-9a-f]{40,64}$/)
  assert.equal(fingerprintOf(f), initial)
  f.write('openspec/changes/demo/evidence/slice-01.md', '# 证据\n')
  f.write('openspec/changes/demo/tasks.md', '- [x] 1.1 任务\n')
  assert.equal(fingerprintOf(f), initial, '规划目录内的写入不应改变实现指纹')
  f.write('src/order.js', 'export const create = () => 3\n')
  const modified = fingerprintOf(f)
  assert.notEqual(modified, initial)
  f.write('src/new-file.js', 'export const added = true\n')
  assert.notEqual(fingerprintOf(f), modified, '未跟踪的新文件也属于当前实现')
  assert.equal(f.git('diff', '--cached', '--name-only'), '', '不得改动用户的暂存区')
})

test('证据指纹与当前实现一致且字段完整时判定新鲜', t => {
  const f = fixture(t)
  writeTasks(f, [{ id: '01', done: [true, true] }])
  f.write('openspec/changes/demo/evidence/slice-01.md', evidence('01', fingerprintOf(f)))
  const result = f.run('evidence', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  assert.equal(report.applicable, true)
  assert.equal(report.slices[0].status, 'fresh')
  assert.deepEqual(report.slices[0].tasks, { done: 2, total: 2 })
  assert.deepEqual(report.issues, [])
})

test('已勾选切片缺少证据文件时报 CRITICAL（含部分勾选：勾选先于证据）', t => {
  for (const done of [[true, true], [true, false]]) {
    const f = fixture(t)
    writeTasks(f, [{ id: '01', done }])
    const result = f.run('evidence', f.changeRoot)
    assert.equal(result.code, 1)
    const report = result.json()
    assert.equal(report.slices[0].status, 'missing')
    assert.ok(report.issues.some(issue => issue.includes('Slice 01') && issue.includes('evidence/slice-01.md')))
  }
})

test('尚未勾选任何任务的切片暂不要求证据', t => {
  const f = fixture(t)
  writeTasks(f, [{ id: '01', done: [false, false] }])
  const result = f.run('evidence', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  assert.equal(result.json().slices[0].status, 'pending')
})

test('证据字段不完整时报 CRITICAL 并列出缺失项', t => {
  const f = fixture(t)
  writeTasks(f, [{ id: '01', done: [true] }])
  f.write('openspec/changes/demo/evidence/slice-01.md', evidence('01', fingerprintOf(f), { omit: ['Seam', '验证命令'] }))
  const result = f.run('evidence', f.changeRoot)
  assert.equal(result.code, 1)
  const report = result.json()
  assert.equal(report.slices[0].status, 'incomplete')
  const issue = report.issues.find(item => item.includes('Slice 01'))
  assert.ok(issue && issue.includes('Seam') && issue.includes('验证命令'), JSON.stringify(report.issues))
})

test('验证结果为 FAIL 的证据不能支撑已完成切片', t => {
  for (const options of [{ result: 'FAIL', commandResult: 'FAIL' }, { commandResult: 'FAIL' }]) {
    const f = fixture(t)
    writeTasks(f, [{ id: '01', done: [true] }])
    f.write('openspec/changes/demo/evidence/slice-01.md', evidence('01', fingerprintOf(f), options))
    const result = f.run('evidence', f.changeRoot)
    assert.equal(result.code, 1)
    assert.equal(result.json().slices[0].status, 'failed')
  }
})

test('启用证据后，未声明 Evidence 引用或路径不规范的切片报错', t => {
  const f = fixture(t)
  writeTasks(f, [{ id: '01', done: [false] }, { id: '02', done: [false], evidence: false },
    { id: '03', done: [false], evidence: 'proof/03.md' }])
  const report = f.run('evidence', f.changeRoot).json()
  assert.equal(report.slices[1].status, 'no-reference')
  assert.ok(report.issues.some(issue => issue.includes('Slice 02') && issue.includes('Evidence')))
  assert.ok(report.issues.some(issue => issue.includes('Slice 03') && issue.includes('evidence/slice-03.md')))
})

// ---------------------------------------------------------------------------
// Slice 03：Verify 与 Archive 阻断（Seam：/opsx:verify → evidence；/opsx:archive → archive）
// ---------------------------------------------------------------------------

/** 构造「已完成且证据新鲜」的变更，返回记录证据时的指纹。 */
function completedChange(f, slices = ['01', '02']) {
  writeTasks(f, slices.map(id => ({ id, done: [true, true] })))
  const fingerprint = fingerprintOf(f)
  for (const id of slices) f.write(`openspec/changes/demo/evidence/slice-${id}.md`, evidence(id, fingerprint))
  return fingerprint
}

test('实现变化后证据过期，并列出自证据以来变化的文件', t => {
  const f = fixture(t)
  completedChange(f, ['01'])
  f.write('src/order.js', 'export const create = () => 42\n')
  const result = f.run('evidence', f.changeRoot)
  assert.equal(result.code, 1)
  const [slice] = result.json().slices
  assert.equal(slice.status, 'stale')
  assert.deepEqual(slice.changedSinceEvidence, ['src/order.js'])
  assert.ok(result.json().issues.some(issue => issue.includes('Slice 01') && issue.includes('过期')))
})

test('行为无关变更可按豁免记录沿用证据，支持多段豁免链', t => {
  const f = fixture(t)
  const recorded = completedChange(f, ['01'])
  f.write('README.md', '# 文档\n')
  const middle = fingerprintOf(f)
  f.write('docs/usage.md', '用法说明\n')
  const current = fingerprintOf(f)
  f.write('openspec/changes/demo/evidence/slice-01.md', evidence('01', recorded, { exemptions: [
    [recorded, middle, 'README.md', '仅新增说明文档，不参与订单创建逻辑', '/opsx:verify（agent）', '2026-09-30'],
    [middle, current, '`docs/usage.md`', '仅文档', '/opsx:verify（agent）', '2026-09-30'],
  ] }))
  const result = f.run('evidence', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  assert.equal(result.json().slices[0].status, 'exempted')
})

test('豁免记录漏列变化文件、缺理由或指纹无法核实时按过期处理', t => {
  const cases = [
    (recorded, current) => [recorded, current, 'README.md', '仅文档', 'agent', '2026-09-30'],
    (recorded, current) => [recorded, current, 'README.md、src/order.js', '', 'agent', '2026-09-30'],
    (recorded, current) => [recorded, 'git-tree:--output=/tmp/x', 'README.md、src/order.js', '仅文档', 'agent', '2026-09-30'],
  ]
  for (const makeRow of cases) {
    const f = fixture(t)
    const recorded = completedChange(f, ['01'])
    f.write('README.md', '# 文档\n')
    f.write('src/order.js', 'export const create = () => 7\n')
    const current = fingerprintOf(f)
    f.write('openspec/changes/demo/evidence/slice-01.md', evidence('01', recorded, { exemptions: [makeRow(recorded, current)] }))
    const result = f.run('evidence', f.changeRoot)
    assert.equal(result.code, 1)
    assert.equal(result.json().slices[0].status, 'stale')
  }
})

test('归档通过路径：双轴 PASSED 且全部证据新鲜', t => {
  const f = fixture(t)
  completedChange(f)
  writeReview(f, f.run('baseline', f.changeRoot).out)
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  assert.equal(report.ok, true)
  assert.deepEqual(report.blockers, [])
  assert.equal(report.review.verdict, 'PASSED')
})

test('归档阻断路径：Review Blocker、缺失证据或过期证据任一出现都拒绝归档', t => {
  const scenarios = {
    'SPEC-01': f => writeReview(f, f.run('baseline', f.changeRoot).out, { spec: [finding('SPEC-01', 'Blocker')] }),
    'Slice 02': f => {
      writeReview(f, f.run('baseline', f.changeRoot).out)
      rmSync(join(f.changeRoot, 'evidence/slice-02.md'))
    },
    'Slice 01': f => {
      writeReview(f, f.run('baseline', f.changeRoot).out)
      f.write('src/order.js', 'export const create = () => 99\n')
    },
  }
  for (const [marker, arrange] of Object.entries(scenarios)) {
    const f = fixture(t)
    completedChange(f)
    arrange(f)
    const result = f.run('archive', f.changeRoot)
    assert.equal(result.code, 1, `${marker} 场景应阻断归档`)
    assert.ok(result.json().blockers.some(item => item.includes(marker)), `${marker}: ${JSON.stringify(result.json().blockers)}`)
  }
})

test('按新规则创建的变更缺少双轴评审产物时拒绝归档', t => {
  const f = fixture(t)
  completedChange(f)
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 1)
  assert.ok(result.json().blockers.some(item => item.includes('review/standards.md')))
})

test('分级为 L1 的变更缺少双轴评审产物时不阻断归档（L1 只推荐）', t => {
  const f = fixture(t)
  completedChange(f)
  f.write('openspec/changes/demo/overview.md',
    '> 分级：L1 轻量 ｜ 判定人：用户 ｜ 日期：2026-10-14 ｜ 依据：单表单字段改动\n')
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  assert.equal(report.review.applicable, false)
  assert.ok(report.review.reason.includes('L1'), report.review.reason)
  assert.equal(report.evidence.applicable, true)
})

test('分级为空或未判定时按保守口径要求双轴评审产物', t => {
  const lines = {
    L2: '> 分级：L2 标准 ｜ 判定人：用户 ｜ 日期：2026-10-14 ｜ 依据：跨模块调用\n',
    未判定: '> 分级：未判定 ｜ 判定人：— ｜ 日期：— ｜ 依据：—\n',
  }
  for (const [name, line] of Object.entries(lines)) {
    const f = fixture(t)
    completedChange(f)
    f.write('openspec/changes/demo/overview.md', line)
    const result = f.run('archive', f.changeRoot)
    assert.equal(result.code, 1, `${name}: ${result.out}`)
    assert.ok(result.json().blockers.some(item => item.includes('review/standards.md')), name)
  }
})

test('不追溯历史变更：无 Evidence 引用或无切片时不阻断，但给出不适用理由', t => {
  const layouts = {
    历史变更: f => writeTasks(f, [{ id: '01', done: [true], evidence: false }]),
    平铺清单: f => f.write('openspec/changes/demo/tasks.md', '- [x] 1.1 调整日志文案\n'),
  }
  for (const [name, arrange] of Object.entries(layouts)) {
    const f = fixture(t)
    arrange(f)
    const result = f.run('archive', f.changeRoot)
    assert.equal(result.code, 0, `${name}: ${result.out}`)
    const report = result.json()
    assert.equal(report.evidence.applicable, false)
    assert.ok(report.notes.some(note => note.startsWith('不适用')), `${name} 应给出不适用理由`)
  }
})

/** 平铺任务清单：没有切片，也没有 Evidence 引用。 */
const flatTasks = f => f.write('openspec/changes/demo/tasks.md', '# Tasks\n\n- [x] 1.1 修改订单创建\n')

test('分级行为 MVP、L2、L3 时，平铺任务清单缺少双轴评审产物也拒绝归档', t => {
  const lines = {
    MVP: '> 分级：方案类型 MVP；升级信号：无 ｜ 判定人：/opsx:propose（agent） ｜ 日期：2026-10-28 ｜ 依据：复用既有接口\n',
    'MVP 旧写法': '方案类型：MVP；升级信号：无；判定人：agent；日期：2026-10-28\n',
    'MVP 依据提到 L1': '> 分级：方案类型 MVP；升级信号：无 ｜ 判定人：用户 ｜ 日期：2026-10-28 ｜ 依据：不涉及 L1 以上的信号\n',
    L2: '> 分级：L2 标准 ｜ 判定人：用户 ｜ 日期：2026-10-28 ｜ 依据：新增业务流程\n',
    L3: '> 分级：L3 全量 ｜ 判定人：用户 ｜ 日期：2026-10-28 ｜ 依据：MQ 重试\n',
  }
  for (const [name, line] of Object.entries(lines)) {
    const f = fixture(t)
    flatTasks(f)
    f.write('openspec/changes/demo/overview.md', line)
    const archive = f.run('archive', f.changeRoot)
    assert.equal(archive.code, 1, `${name}: ${archive.out}`)
    const report = archive.json()
    assert.ok(report.blockers.some(item => item.includes('review/standards.md')), `${name}: ${JSON.stringify(report.blockers)}`)
    assert.equal(report.evidence.applicable, false, `${name}：切片证据仍按切片判定`)
    // verify 读取同一判定：review 命令同样报出缺少的评审产物
    const review = f.run('review', f.changeRoot)
    assert.equal(review.code, 1, `${name}: ${review.out}`)
    assert.equal(review.json().applicable, true, name)
  }
})

test('平铺任务清单的 L0、L1 与没有分级行的变更不要求双轴评审，理由写明判定依据', t => {
  const cases = {
    L0: { line: '> 分级：L0 豁免 ｜ 判定人：/opsx:propose（agent） ｜ 日期：2026-10-28 ｜ 依据：只改日志文案\n', reason: 'L0' },
    L1: { line: '> 分级：L1 轻量 ｜ 判定人：用户 ｜ 日期：2026-10-28 ｜ 依据：单表字段\n', reason: 'L1' },
    没有分级行: { line: null, reason: '没有可读的分级行' },
    未判定: { line: '> 分级：未判定 ｜ 判定人：— ｜ 日期：— ｜ 依据：—\n', reason: '没有可读的分级行' },
  }
  for (const [name, { line, reason }] of Object.entries(cases)) {
    const f = fixture(t)
    flatTasks(f)
    if (line) f.write('openspec/changes/demo/overview.md', line)
    const result = f.run('archive', f.changeRoot)
    assert.equal(result.code, 0, `${name}: ${result.out}`)
    const report = result.json()
    assert.equal(report.review.applicable, false, name)
    assert.ok(report.review.reason.includes(reason), `${name}: ${report.review.reason}`)
    assert.ok(!report.review.reason.includes('L0 豁免，或'), `${name}：不再把原因笼统写成 L0 豁免`)
  }
})

// ---------------------------------------------------------------------------
// streamline-openspec-gates Slice 01：基线差分回归（Seam：regress / evidence）
// ---------------------------------------------------------------------------

/** 写一份失败清单（相对仓库根），返回绝对路径。 */
function failureList(f, rel, lines) {
  f.write(rel, `${lines.join('\n')}\n`)
  return join(f.repo, rel)
}

test('regress：实际失败全部在基线清单中时 introduced 为空、退出码 0', t => {
  const f = fixture(t)
  const known = Array.from({ length: 27 }, (_, i) => `com.a.KnownTest.case${i + 1}`)
  const baseline = failureList(f, 'docs/test-baseline.txt', ['# 已知基线失败', '', ...known])
  const actual = failureList(f, 'build/actual.txt', known.map(id => `${id} <<< FAILURE!`))
  const result = f.run('regress', '--baseline', baseline, '--actual', actual)
  assert.equal(result.code, 0, result.out + result.err)
  const report = result.json()
  assert.deepEqual(report.introduced, [])
  assert.equal(report.baselineMatched, 27)
  assert.deepEqual(report.fixed, [])
})

test('regress：基线外的失败记为 introduced，退出码 1；不再失败的基线项记为 fixed，不影响退出码', t => {
  const f = fixture(t)
  const baseline = failureList(f, 'docs/test-baseline.txt', ['com.a.FooTest.bar', 'com.a.OldTest.y'])
  const actual = failureList(f, 'build/actual.txt', ['  com.a.FooTest.bar <<< ERROR!  ', 'com.a.NewTest.x <<< FAILURE!'])
  const result = f.run('regress', '--baseline', baseline, '--actual', actual)
  assert.equal(result.code, 1)
  const report = result.json()
  assert.deepEqual(report.introduced, ['com.a.NewTest.x'])
  assert.equal(report.baselineMatched, 1)
  assert.deepEqual(report.fixed, ['com.a.OldTest.y'])

  const onlyFixed = failureList(f, 'build/fixed.txt', ['com.a.FooTest.bar'])
  const fixedRun = f.run('regress', '--baseline', baseline, '--actual', onlyFixed)
  assert.equal(fixedRun.code, 0, fixedRun.out)
  assert.deepEqual(fixedRun.json().fixed, ['com.a.OldTest.y'])
})

test('regress：缺少参数或文件不存在时退出码 2', t => {
  const f = fixture(t)
  const baseline = failureList(f, 'docs/test-baseline.txt', ['com.a.FooTest.bar'])
  assert.equal(f.run('regress', '--baseline', baseline).code, 2)
  assert.equal(f.run('regress', '--baseline', baseline, '--actual', join(f.repo, 'missing.txt')).code, 2)
})

/** 写入基线清单与 PASS_WITH_BASELINE 证据的已完成切片；返回 evidence 命令结果。 */
function baselineEvidence(f, extra, { listOnDisk = true } = {}) {
  if (listOnDisk) failureList(f, 'docs/test-baseline.txt', ['com.a.KnownTest.case1'])
  writeTasks(f, [{ id: '01', done: [true] }])
  f.write('openspec/changes/demo/evidence/slice-01.md', evidence('01', fingerprintOf(f),
    { result: 'PASS_WITH_BASELINE', commandResult: 'PASS_WITH_BASELINE', extra }))
  return f.run('evidence', f.changeRoot)
}

test('PASS_WITH_BASELINE 证据带基线清单且本次引入失败为 0 时判定新鲜并通过', t => {
  const f = fixture(t)
  const result = baselineEvidence(f, { 'Baseline List': 'docs/test-baseline.txt', 'Introduced Failures': '0' })
  assert.equal(result.code, 0, result.out)
  assert.equal(result.json().slices[0].status, 'fresh')
})

test('PASS_WITH_BASELINE 缺少 Baseline List、清单文件不存在或缺少 Introduced Failures 时报 CRITICAL', t => {
  const cases = [
    [{ 'Introduced Failures': '0' }, true, 'Baseline List'],
    [{ 'Baseline List': 'docs/test-baseline.txt', 'Introduced Failures': '0' }, false, 'Baseline List'],
    [{ 'Baseline List': 'docs/test-baseline.txt' }, true, 'Introduced Failures'],
  ]
  for (const [extra, listOnDisk, marker] of cases) {
    const f = fixture(t)
    const result = baselineEvidence(f, extra, { listOnDisk })
    assert.equal(result.code, 1, `${marker}: ${result.out}`)
    const report = result.json()
    assert.equal(report.slices[0].status, 'incomplete')
    assert.ok(report.issues.some(issue => issue.includes(marker)), JSON.stringify(report.issues))
  }
})

test('PASS_WITH_BASELINE 但本次引入失败不为 0 时证据未通过', t => {
  const f = fixture(t)
  const result = baselineEvidence(f, { 'Baseline List': 'docs/test-baseline.txt', 'Introduced Failures': '1' })
  assert.equal(result.code, 1)
  assert.equal(result.json().slices[0].status, 'failed')
})

// ---------------------------------------------------------------------------
// streamline-openspec-gates Slice 02：Blocker 判据与累计台账（Seam：baseline / review）
// ---------------------------------------------------------------------------

/** 去掉基线中的 Rules Version 行，模拟本变更之前生成的旧报告。 */
const legacyBaseline = baseline => baseline.replace(/^- Rules Version: .*\n/m, '')

test('baseline 输出 Rules Version: 2', t => {
  const f = fixture(t)
  assert.equal(field(f.run('baseline', f.changeRoot).out, 'Rules Version'), '2')
})

test('Rules Version 2：Blocker 触发场景不以 [B1]–[B5] 开头时报结构问题，带判据时不报', t => {
  const f = fixture(t)
  writeReview(f, f.run('baseline', f.changeRoot).out, {
    standards: [finding('STD-01', 'Blocker', { trigger: '复用路径可能失败' })],
    spec: [finding('SPEC-01', 'Blocker', { trigger: '[B3] 任务 2.1 已勾选但无实现' })],
  })
  const report = f.run('review', f.changeRoot).json()
  assert.ok(report.issues.some(issue => issue.includes('STD-01') && issue.includes('判据')), JSON.stringify(report.issues))
  assert.ok(!report.issues.some(issue => issue.includes('SPEC-01')), JSON.stringify(report.issues))
})

test('Rules Version 2：台账缺失、closed 行缺闭环依据、open 行不在 Findings、Findings 行不在台账时报结构问题', t => {
  const cases = {
    'Finding 台账': { standards: [finding('STD-01', 'Minor')], ledgers: { standards: null } },
    'STD-02': { standards: [finding('STD-01', 'Minor')],
      ledgers: { standards: [ledgerRow('STD-01', 'Minor'), ledgerRow('STD-02', 'Major', 'closed', '')] } },
    'STD-03': { standards: [finding('STD-01', 'Minor')],
      ledgers: { standards: [ledgerRow('STD-01', 'Minor'), ledgerRow('STD-03', 'Major', 'open')] } },
    'SPEC-04': { spec: [finding('SPEC-04', 'Minor')], ledgers: { spec: [] } },
  }
  for (const [marker, options] of Object.entries(cases)) {
    const f = fixture(t)
    writeReview(f, f.run('baseline', f.changeRoot).out, options)
    const result = f.run('review', f.changeRoot)
    assert.equal(result.code, 1, `${marker}: ${result.out}`)
    assert.ok(result.json().issues.some(issue => issue.includes(marker)), `${marker}: ${JSON.stringify(result.json().issues)}`)
  }
})

test('Rules Version 2：台账中已闭环的 Blocker 不计入裁决，台账行不当作 finding', t => {
  const f = fixture(t)
  writeReview(f, f.run('baseline', f.changeRoot).out, {
    spec: [finding('SPEC-02', 'Minor')],
    ledgers: { spec: [ledgerRow('SPEC-01', 'Blocker', 'closed', 'src/order.js:1 OrderTest.createsOrder'), ledgerRow('SPEC-02', 'Minor')] },
  })
  const result = f.run('review', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  assert.equal(result.json().verdict, 'PASSED')
})

test('Rules Version 2：「## 建议」列表不计入 finding；写成带 ID 的表格时按 finding 要求登记台账', t => {
  // 第 2 轮起增量轮新发现的 Minor 写进「## 建议」列表，不编 ID、不进台账（dual-axis-review.md「修复与重跑」）。
  const withAdvice = (f, lines) => {
    const file = join(f.repo, 'openspec/changes/demo/review/standards.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('## 结论', ['## 建议', '', ...lines, '', '## 结论'].join('\n')))
  }
  const listed = fixture(t)
  writeReview(listed, listed.run('baseline', listed.changeRoot).out)
  withAdvice(listed, ['- R2 src/order.js:1 常量名不表意 → 改为 MAX_RETRY'])
  const passed = listed.run('review', listed.changeRoot)
  assert.equal(passed.code, 0, passed.out)
  assert.deepEqual(passed.json().issues, [])

  const tabled = fixture(t)
  writeReview(tabled, tabled.run('baseline', tabled.changeRoot).out)
  withAdvice(tabled, [FINDING_HEADER, finding('STD-09', 'Minor')])
  const result = tabled.run('review', tabled.changeRoot)
  assert.equal(result.code, 1, result.out)
  assert.ok(result.json().issues.some(issue => issue.includes('STD-09') && issue.includes('台账')), JSON.stringify(result.json().issues))
})

test('没有 Rules Version 的旧报告不要求判据前缀与台账', t => {
  const f = fixture(t)
  writeReview(f, legacyBaseline(f.run('baseline', f.changeRoot).out), {
    spec: [finding('SPEC-01', 'Blocker', { trigger: '复用路径可能失败' })], ledgers: { standards: null, spec: null },
  })
  const report = f.run('review', f.changeRoot).json()
  assert.equal(report.verdict, 'BLOCKED')
  assert.deepEqual(report.issues, [])
})

test('三份报告的 Rules Version 不一致时报结构问题', t => {
  const f = fixture(t)
  const baseline = f.run('baseline', f.changeRoot).out
  writeReview(f, baseline, { baselines: { spec: legacyBaseline(baseline) } })
  const issues = f.run('review', f.changeRoot).json().issues
  assert.ok(issues.some(issue => issue.includes('Rules Version')), JSON.stringify(issues))
})

test('评审后实现有变化（门禁外提交）时提示运行 classify 并按档位登记再重跑', t => {
  const f = fixture(t)
  writeReview(f, f.run('baseline', f.changeRoot).out)
  f.write('src/order.js', 'export const create = () => 5\n')
  const warnings = f.run('review', f.changeRoot).json().warnings
  const stale = warnings.find(item => item.includes('Fingerprint'))
  assert.ok(stale, JSON.stringify(warnings))
  for (const word of ['classify', 'tasks.md', '实现后修改登记', '档位']) assert.ok(stale.includes(word), `${word}：${stale}`)
})

// ---------------------------------------------------------------------------
// streamline-openspec-gates Slice 03：增量基线（Seam：baseline --since / review）
// ---------------------------------------------------------------------------

/** 读取 baseline 输出中 `- Delta Files:` 下的文件列表。 */
const deltaFiles = text => [...text.matchAll(/^ {2}- (.+)$/gm)].map(match => match[1].trim())

test('baseline --since 输出 Delta Since 行，只列出上一指纹以来变化的文件', t => {
  const f = fixture(t)
  const previous = fingerprintOf(f)
  f.write('src/order.js', 'export const create = () => 11\n')
  f.write('src/refund.js', 'export const refund = () => 0\n')
  const result = f.run('baseline', f.changeRoot, '--since', previous)
  assert.equal(result.code, 0, result.err)
  assert.equal(field(result.out, 'Delta Since'), previous)
  assert.deepEqual(deltaFiles(result.out).sort(), ['src/order.js', 'src/refund.js'])
})

test('baseline --since 的 tree 对象不存在时回退为全量审查并输出 warning', t => {
  const f = fixture(t)
  const result = f.run('baseline', f.changeRoot, '--since', `git-tree:${'ab'.repeat(20)}`)
  assert.equal(result.code, 0, result.err)
  assert.equal(field(result.out, 'Delta Since'), '')
  assert.ok(field(result.out, 'Fingerprint'), '回退后仍输出完整基线')
  assert.match(result.err, /warning/i)
})

test('三份报告的 Delta Since 不一致时报结构问题', t => {
  const f = fixture(t)
  const previous = fingerprintOf(f)
  f.write('src/order.js', 'export const create = () => 12\n')
  const delta = f.run('baseline', f.changeRoot, '--since', previous).out
  writeReview(f, delta, { baselines: { summary: f.run('baseline', f.changeRoot).out } })
  const issues = f.run('review', f.changeRoot).json().issues
  assert.ok(issues.some(issue => issue.includes('Delta Since')), JSON.stringify(issues))
})

// ---------------------------------------------------------------------------
// streamline-openspec-gates Slice 04：产物允许清单（Seam：hygiene）
// ---------------------------------------------------------------------------

test('hygiene：允许清单内的产物不报 warning，清单外的文件各报一条且不阻断', t => {
  const f = fixture(t)
  const allowed = ['.openspec.yaml', 'design.md', 'tasks.md', 'specs/gate/spec.md', 'review/security.md',
    'review/standards.md', 'review/sonar.md', 'review-summary.md', 'evidence/slice-01.md', 'evidence/attachments/write-scan.txt',
    'overview.md', 'discussion-log.md', 'research.md', 'video/storyboard.md']
  for (const rel of allowed) f.write(`openspec/changes/demo/${rel}`, 'x\n')
  f.write('openspec/changes/demo/review/standards-round1.md', 'x\n')
  f.write('openspec/changes/demo/verification-r2.md', 'x\n')
  f.write('openspec/changes/demo/p0-optimization-report.md', 'x\n')
  const result = f.run('hygiene', f.changeRoot)
  assert.equal(result.code, 0, result.out + result.err)
  const { warnings } = result.json()
  assert.deepEqual(warnings.map(item => item.file).sort(),
    ['p0-optimization-report.md', 'review/standards-round1.md', 'verification-r2.md'])
  assert.equal(warnings.find(item => item.file === 'review/standards-round1.md').reason, 'round copy')
  assert.equal(warnings.find(item => item.file === 'verification-r2.md').reason, 'round copy')
  assert.notEqual(warnings.find(item => item.file === 'p0-optimization-report.md').reason, 'round copy')
})

test('hygiene：托管文件（decisions/autopilot.json 与 decisions/D-0001.json）不报 warning', t => {
  // spec autopilot-entry「Autopilot files pass hygiene」。
  const f = fixture(t)
  f.write('openspec/changes/demo/decisions/autopilot.json', '{"status":"active"}\n')
  f.write('openspec/changes/demo/decisions/D-0001.json', '{"id":"D-0001","status":"pending"}\n')
  const result = f.run('hygiene', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  const reported = result.json().warnings.filter(item => item.file.startsWith('decisions/'))
  assert.deepEqual(reported, [], JSON.stringify(reported))
})

test('hygiene：decisions 目录中其他文件报一条 warning', t => {
  // spec autopilot-entry「Other file under decisions is reported」。
  const f = fixture(t)
  f.write('openspec/changes/demo/decisions/notes.md', 'x\n')
  const result = f.run('hygiene', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  const reported = result.json().warnings.filter(item => item.file === 'decisions/notes.md')
  assert.equal(reported.length, 1, JSON.stringify(result.json().warnings))
})

test('hygiene：变更目录不存在时退出码 2', t => {
  const f = fixture(t)
  assert.equal(f.run('hygiene', join(f.repo, 'openspec/changes/missing')).code, 2)
})

// add-change-recap Slice 04：完成清单进入产物允许清单（Seam：hygiene）
test('hygiene：变更目录根下的 recap.md 不报 warning；其他目录中的 recap.md 仍报告', t => {
  const f = fixture(t)
  f.write('openspec/changes/demo/recap.md', 'x\n')
  f.write('openspec/changes/demo/review/recap.md', 'x\n')
  const result = f.run('hygiene', f.changeRoot)
  assert.equal(result.code, 0, result.out + result.err)
  assert.deepEqual(result.json().warnings.map(item => item.file), ['review/recap.md'])
})

// move-fact-research-to-research-md Slice 04：事实预调研的 research.md 进入产物允许清单（Seam：hygiene）
test('hygiene：变更目录根下的 research.md 不报 warning；其他目录中的 research.md 仍报告', t => {
  // spec fact-research「research.md passes hygiene」「research.md in a sub-directory」。
  const f = fixture(t)
  f.write('openspec/changes/demo/research.md', 'x\n')
  f.write('openspec/changes/demo/evidence/research.md', 'x\n')
  const result = f.run('hygiene', f.changeRoot)
  assert.equal(result.code, 0, result.out + result.err)
  assert.deepEqual(result.json().warnings.map(item => item.file), ['evidence/research.md'])
})

// add-deployment-to-allowlist：验收部署文档的 deployment.md 进入产物允许清单（Seam：hygiene）
test('hygiene：变更目录根下的 deployment.md 不报 warning；子目录中的 deployment.md 仍报告', t => {
  const f = fixture(t)
  f.write('openspec/changes/demo/deployment.md', 'x\n')
  f.write('openspec/changes/demo/evidence/deployment.md', 'x\n')
  const result = f.run('hygiene', f.changeRoot)
  assert.equal(result.code, 0, result.out + result.err)
  assert.deepEqual(result.json().warnings.map(item => item.file), ['evidence/deployment.md'])
})

// ---------------------------------------------------------------------------
// streamline-openspec-gates Slice 07：双轴评审 R1 修复（Seam：参数解析 / hygiene / review）
// ---------------------------------------------------------------------------

test('子命令不支持的参数返回退出码 2，不静默忽略', t => {
  const f = fixture(t)
  const previous = fingerprintOf(f)
  assert.equal(f.run('review', f.changeRoot, '--since', previous).code, 2)
  assert.equal(f.run('baseline', f.changeRoot, '--actual', 'x.txt').code, 2)
  assert.equal(f.run('hygiene', f.changeRoot, '--repo', f.repo).code, 2)
  assert.equal(f.run('regress', '--baseline', 'a', '--actual', 'b', '--base', 'HEAD').code, 2)
  assert.equal(f.run('baseline', f.changeRoot, '--since', previous).code, 0)
})

test('hygiene：切片证据的 round 副本报 round copy', t => {
  const f = fixture(t)
  f.write('openspec/changes/demo/evidence/slice-01.md', 'x\n')
  f.write('openspec/changes/demo/evidence/slice-01-r2.md', 'x\n')
  f.write('openspec/changes/demo/evidence/slice-02-round1.md', 'x\n')
  const { warnings } = f.run('hygiene', f.changeRoot).json()
  assert.deepEqual(warnings.map(item => [item.file, item.reason]).sort(),
    [['evidence/slice-01-r2.md', 'round copy'], ['evidence/slice-02-round1.md', 'round copy']])
})

test('Rules Version 2：台账闭环依据不是 文件:行号 或测试名时报结构问题', t => {
  const cases = {
    '已修复': false, 'src/order.js': false, 'src/order.js:12': true, 'OrderTest.createsOrder': true,
    'src/order/OrderService.java': false, 'README.md': false, '已修复，见 OrderService.java': false,
  }
  for (const [closure, valid] of Object.entries(cases)) {
    const f = fixture(t)
    writeReview(f, f.run('baseline', f.changeRoot).out, {
      spec: [finding('SPEC-02', 'Minor')],
      ledgers: { spec: [ledgerRow('SPEC-01', 'Major', 'closed', closure), ledgerRow('SPEC-02', 'Minor')] },
    })
    const issues = f.run('review', f.changeRoot).json().issues
    assert.equal(issues.some(issue => issue.includes('SPEC-01')), !valid, `${closure}: ${JSON.stringify(issues)}`)
  }
})

// ---------------------------------------------------------------------------
// streamline-openspec-gates Slice 08：双轴评审 R2 修复（Seam：review / hygiene / 参数解析）
// ---------------------------------------------------------------------------

test('R2 形态报告：「上轮闭环验证」表中的已闭环 ID 不当作 finding', t => {
  const f = fixture(t)
  const closure = ['## 上轮闭环验证', '', '| ID | 修复任务 | 核实位置 | 核实结果 |', '|----|---------|---------|---------|',
    '| SPEC-01 | tasks.md 7.1 | src/order.js:1 已修复 | closed |', ''].join('\n')
  writeReview(f, f.run('baseline', f.changeRoot).out, {
    spec: [finding('SPEC-02', 'Minor')],
    ledgers: { spec: [ledgerRow('SPEC-01', 'Major', 'closed', 'src/order.js:1'), ledgerRow('SPEC-02', 'Minor')] },
  })
  const file = join(f.changeRoot, 'review/spec-fidelity.md')
  f.write('openspec/changes/demo/review/spec-fidelity.md', readFileSync(file, 'utf8').replace('## Findings', `${closure}\n## Findings`))
  const result = f.run('review', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  assert.equal(result.json().axes.find(axis => axis.file === 'review/spec-fidelity.md').findings, 1)
})

test('参数缺少取值时提示缺少取值，而不是不支持的参数', t => {
  const f = fixture(t)
  const result = f.run('baseline', f.changeRoot, '--base')
  assert.equal(result.code, 2)
  assert.match(result.err, /缺少取值/)
})

test('hygiene：evidence/attachments/ 与 video/media/ 下的文件名不按 round 副本判定', t => {
  const f = fixture(t)
  f.write('openspec/changes/demo/evidence/attachments/jdk-r17.log', 'x\n')
  f.write('openspec/changes/demo/video/media/scene-r2.mp4', 'x\n')
  f.write('openspec/changes/demo/review/standards-r2.md', 'x\n')
  const { warnings } = f.run('hygiene', f.changeRoot).json()
  assert.deepEqual(warnings.map(item => [item.file, item.reason]), [['review/standards-r2.md', 'round copy']])
})

// ---------------------------------------------------------------------------
// tier-post-implementation-changes Slice 01：注释差异识别（Seam：classify / evidence / review）
// ---------------------------------------------------------------------------

/** 写入 before 后取指纹，再写入 after，运行 classify --from <before 指纹>。 */
function classifyCase(t, before, after) {
  const f = fixture(t)
  for (const [rel, text] of Object.entries(before)) f.write(rel, text)
  const from = fingerprintOf(f)
  for (const [rel, text] of Object.entries(after)) f.write(rel, text)
  return { f, from, result: f.run('classify', f.changeRoot, '--from', from) }
}

const JAVA_ORDER = [
  'package demo;', '', '/**', ' * 订单。', ' */', 'public class Order {', '  // 创建订单',
  '  int create() { return 1; }', '}', '',
].join('\n')

test('classify：Java 只改 // 注释与 Javadoc 时列入 commentOnly，退出码 0', t => {
  const after = JAVA_ORDER.replace(' * 订单。', ' * 订单聚合。\n *\n * <p>负责创建。').replace('// 创建订单', '// 创建一笔订单')
  const { f, from, result } = classifyCase(t, { 'src/Order.java': JAVA_ORDER }, { 'src/Order.java': after })
  assert.equal(result.code, 0, result.out + result.err)
  const report = result.json()
  assert.equal(report.from, from)
  assert.equal(report.to, fingerprintOf(f))
  assert.deepEqual(report.commentOnly, ['src/Order.java'])
  assert.deepEqual(report.other, [])
  assert.deepEqual(report.unregistered, [])
  const explicit = f.run('classify', f.changeRoot, '--from', from, '--to', fingerprintOf(f))
  assert.deepEqual(explicit.json().commentOnly, ['src/Order.java'])
})

test('classify：字符串中的 // 是代码，修改后列入 other 与 unregistered，退出码 1', t => {
  const before = 'class Url {\n  String a = "http://a"; // 地址\n}\n'
  const { result } = classifyCase(t, { 'src/Url.java': before }, { 'src/Url.java': before.replace('http://a', 'http://b') })
  assert.equal(result.code, 1, result.out)
  const report = result.json()
  assert.deepEqual(report.commentOnly, [])
  assert.deepEqual(report.other, ['src/Url.java'])
  assert.deepEqual(report.unregistered, ['src/Url.java'])
})

test('classify：SQL 的 -- 注释是注释，MySQL hint 与可执行注释是代码', t => {
  const hint = 'SELECT /*+ INDEX(t idx_a) */ id FROM t;\n'
  const executable = 'SELECT /*!50000 SQL_NO_CACHE */ id FROM t;\n'
  const plain = '-- 查询订单\nSELECT id FROM t WHERE a = \'--x\';\n'
  const { result } = classifyCase(t,
    { 'sql/hint.sql': hint, 'sql/exec.sql': executable, 'sql/plain.sql': plain },
    { 'sql/hint.sql': hint.replace('idx_a', 'idx_b'), 'sql/exec.sql': executable.replace('SQL_NO_CACHE', 'SQL_CACHE'),
      'sql/plain.sql': plain.replace('-- 查询订单', '-- 按状态查询订单\n/* 说明 */') })
  const report = result.json()
  assert.deepEqual(report.commentOnly, ['sql/plain.sql'])
  assert.deepEqual(report.other.sort(), ['sql/exec.sql', 'sql/hint.sql'])
})

test('classify：不支持的文件类型与新增文件一律列入 other', t => {
  const { result } = classifyCase(t, { 'src/util.mjs': '// 工具\nexport const a = 1\n' },
    { 'src/util.mjs': '// 工具函数\nexport const a = 1\n', 'src/New.java': 'class New {}\n' })
  assert.equal(result.code, 1)
  const report = result.json()
  assert.deepEqual(report.commentOnly, [])
  assert.deepEqual(report.other.sort(), ['src/New.java', 'src/util.mjs'])
})

test('classify：Java 注释含 Unicode 转义时整个文件列入 other', t => {
  const before = 'class A {\n  // 说明 \\u000a int x = 1;\n  // 说明 \\uuu000d int y = 1;\n}\n'
  const { result } = classifyCase(t, { 'src/A.java': before }, { 'src/A.java': before.replace('x = 1', 'x = 2') })
  assert.deepEqual(result.json().other, ['src/A.java'])
})

test('classify：Kotlin 保留换行，可嵌套块注释的修改是注释差异', t => {
  const joined = 'fun total(): Int {\n  val a = 1\n  + 2\n  return a\n}\n'
  const comments = 'fun f() = 1 /* 外 /* 内 */ 外 */ // 尾注释\n'
  const { result } = classifyCase(t, { 'src/Total.kt': joined, 'src/F.kts': comments },
    { 'src/Total.kt': joined.replace('val a = 1\n  + 2', 'val a = 1 + 2'),
      'src/F.kts': comments.replace('/* 外 /* 内 */ 外 */', '/* 外层 /* 内层 */ 外层 */').replace('尾注释', '说明') })
  const report = result.json()
  assert.deepEqual(report.commentOnly, ['src/F.kts'])
  assert.deepEqual(report.other, ['src/Total.kt'])
})

test('classify：properties 的注释行是注释，续行中的 # 是值', t => {
  const config = '# 超时秒数\ntimeout=30\nnames=a,\\\n  # b\n'
  const { result } = classifyCase(t, { 'conf/a.properties': config, 'conf/b.properties': config },
    { 'conf/a.properties': config.replace('# 超时秒数', '# 请求超时秒数\n\n! 说明'),
      'conf/b.properties': config.replace('  # b', '  # c') })
  const report = result.json()
  assert.deepEqual(report.commentOnly, ['conf/a.properties'])
  assert.deepEqual(report.other, ['conf/b.properties'])
})

test('classify：XML 注释是注释，CDATA 与属性值是代码', t => {
  const mapper = '<mapper>\n  <!-- 查询 -->\n  <select id="a"><![CDATA[ SELECT 1 <!-- x --> ]]></select>\n</mapper>\n'
  const { result } = classifyCase(t, { 'res/a.xml': mapper, 'res/b.xml': mapper, 'res/c.xml': mapper },
    { 'res/a.xml': mapper.replace('<!-- 查询 -->', '<!-- 按编号查询 -->'),
      'res/b.xml': mapper.replace('<!-- x -->', '<!-- y -->'), 'res/c.xml': mapper.replace('id="a"', 'id="b"') })
  const report = result.json()
  assert.deepEqual(report.commentOnly, ['res/a.xml'])
  assert.deepEqual(report.other.sort(), ['res/b.xml', 'res/c.xml'])
})

test('classify：未闭合的注释或字符串让整个文件列入 other', t => {
  const before = 'class B {\n  int b = 1; /* 说明\n}\n'
  const { result } = classifyCase(t, { 'src/B.java': before }, { 'src/B.java': before.replace('说明', '备注') })
  assert.deepEqual(result.json().other, ['src/B.java'])
})

test('classify：参数错误、指纹格式错误或 tree 对象不存在时退出码 2', t => {
  const f = fixture(t)
  assert.equal(f.run('classify', f.changeRoot).code, 2)
  assert.equal(f.run('classify', f.changeRoot, '--from', 'abc').code, 2)
  const missing = f.run('classify', f.changeRoot, '--from', `git-tree:${'ab'.repeat(20)}`)
  assert.equal(missing.code, 2)
  assert.match(missing.err, /tree/)
})

test('classify：SQL 方言有歧义时整份文件列入 other', t => {
  const cases = {
    'sql/backslash.sql': "SELECT 'a\\' || '-- x';\n",
    'sql/pound.sql': "# it's\nSELECT 'a -- x';\n",
    'sql/dash.sql': "SELECT 1--'x\n';\n",
    'sql/nested.sql': "/* a /* b */ SELECT '-- x';\n",
  }
  const after = Object.fromEntries(Object.entries(cases).map(([rel, text]) => [rel, text.replace('x', 'y')]))
  const { result } = classifyCase(t, cases, after)
  assert.deepEqual(result.json().other.sort(), Object.keys(cases).sort())
})

test('classify：Kotlin 字符串模板中的注释标记属于字面量', t => {
  const before = 'val s = "a ${ f("}") /* x */ } // y"\nval r = """raw // z"""" \n'
  const { result } = classifyCase(t, { 'src/S.kt': before, 'src/R.kt': before },
    { 'src/S.kt': before.replace('/* x */', '/* w */'), 'src/R.kt': before.replace('// z', '// v') })
  assert.deepEqual(result.json().other.sort(), ['src/R.kt', 'src/S.kt'])
})

/** 在已完成的变更中加入 Java 文件后记录证据，返回证据指纹。 */
function completedJavaChange(f) {
  f.write('src/Order.java', JAVA_ORDER)
  return completedChange(f, ['01'])
}

const javaCommentEdit = text => text.replace('// 创建订单', '// 创建一笔订单')

test('evidence：自证据以来只有注释差异时切片为 exempted（comment-only），不需要豁免记录', t => {
  const f = fixture(t)
  completedJavaChange(f)
  f.write('src/Order.java', javaCommentEdit(JAVA_ORDER))
  const result = f.run('evidence', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  const [slice] = result.json().slices
  assert.equal(slice.status, 'exempted')
  assert.equal(slice.exemptedBy, 'comment-only')
  assert.deepEqual(slice.commentOnly, ['src/Order.java'])
  assert.deepEqual(result.json().issues, [])
})

test('evidence：豁免记录之后接只有注释差异的修改时豁免链成立', t => {
  const f = fixture(t)
  const recorded = completedJavaChange(f)
  f.write('README.md', '# 文档\n')
  const middle = fingerprintOf(f)
  f.write('src/Order.java', javaCommentEdit(JAVA_ORDER))
  f.write('openspec/changes/demo/evidence/slice-01.md', evidence('01', recorded, { exemptions: [
    [recorded, middle, 'README.md', '仅新增说明文档', '/opsx:verify（agent）', '2026-10-20'],
  ] }))
  const result = f.run('evidence', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  const [slice] = result.json().slices
  assert.equal(slice.status, 'exempted')
  assert.equal(slice.exemptedBy, 'comment-only')
})

test('evidence：注释差异之外还有其他差异时仍为 stale', t => {
  const f = fixture(t)
  completedJavaChange(f)
  f.write('src/Order.java', javaCommentEdit(JAVA_ORDER))
  f.write('src/order.js', 'export const create = () => 9\n')
  const result = f.run('evidence', f.changeRoot)
  assert.equal(result.code, 1)
  const [slice] = result.json().slices
  assert.equal(slice.status, 'stale')
  assert.deepEqual(slice.changedSinceEvidence.sort(), ['src/Order.java', 'src/order.js'])
})

test('review：评审基线与当前实现之间只有注释差异时不输出基线陈旧 warning', t => {
  const f = fixture(t)
  f.write('src/Order.java', JAVA_ORDER)
  writeReview(f, f.run('baseline', f.changeRoot).out)
  f.write('src/Order.java', javaCommentEdit(JAVA_ORDER))
  const result = f.run('review', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(result.json().warnings, [])
  f.write('src/Order.java', javaCommentEdit(JAVA_ORDER).replace('return 1', 'return 2'))
  assert.ok(f.run('review', f.changeRoot).json().warnings.some(item => item.includes('Fingerprint')))
})

test('evidence 与 classify：文件名含双引号或制表符时列出相同的原始文件名', t => {
  const f = fixture(t)
  const name = 'src/say "hi"\tnow.js'
  f.write(name, 'export const a = 1\n')
  const recorded = completedChange(f, ['01'])
  f.write(name, 'export const a = 2\n')
  const [slice] = f.run('evidence', f.changeRoot).json().slices
  assert.equal(slice.status, 'stale')
  assert.deepEqual(slice.changedSinceEvidence, [name])
  assert.deepEqual(f.run('classify', f.changeRoot, '--from', recorded).json().other, [name])
})

// ---------------------------------------------------------------------------
// tier-post-implementation-changes Slice 02：实现后修改登记（Seam：classify 的 registered / unregistered）
// ---------------------------------------------------------------------------

/** 写入只含实现后修改登记表的 tasks.md；rows 为 [编号, 文件, 档位, 登记指纹]，省略登记指纹时取当前指纹。 */
function writeChangeLedger(f, rows) {
  const current = fingerprintOf(f)
  f.write('openspec/changes/demo/tasks.md', [
    '# 实施任务', '', '## 实现后修改登记', '',
    '| 编号 | 文件 | 提交 | 登记指纹 | 档位 | 判定依据 | 验证 | 判定人 | 日期 |', '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(([id, files, tier, fingerprint = current]) =>
      `| ${id} | ${files} | abc1234 | ${fingerprint} | ${tier} | 说明 | 编译通过 | 用户（确认档位） | 2026-10-20 |`), '',
  ].join('\n'))
}

const javaLogic = text => text.replace('return 1', 'return 2')
const javaRename = text => text.replace('int create()', 'int make()')

test('classify：登记表列出的文件写入 registered 并带档位，全部登记时退出码 0', t => {
  const { f, from } = classifyCase(t, { 'src/Order.java': JAVA_ORDER }, { 'src/Order.java': javaLogic(JAVA_ORDER) })
  writeChangeLedger(f, [['M1', '`src/Order.java`', '等价']])
  const result = f.run('classify', f.changeRoot, '--from', from)
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  assert.deepEqual(report.registered, [{ file: 'src/Order.java', id: 'M1', tier: '等价' }])
  assert.deepEqual(report.unregistered, [])
  assert.deepEqual(report.issues, [])
})

test('classify：未登记的文件写入 unregistered，退出码 1；同一文件登记多行时取最高档位', t => {
  const { f, from } = classifyCase(t, { 'src/Order.java': JAVA_ORDER, 'src/Pay.java': JAVA_ORDER },
    { 'src/Order.java': javaLogic(JAVA_ORDER), 'src/Pay.java': javaLogic(JAVA_ORDER) })
  writeChangeLedger(f, [['M1', 'src/Order.java', '等价'], ['M2', 'src/Order.java、README.md', '行为']])
  const result = f.run('classify', f.changeRoot, '--from', from)
  assert.equal(result.code, 1)
  const report = result.json()
  assert.deepEqual(report.registered, [{ file: 'src/Order.java', id: 'M2', tier: '行为' }])
  assert.deepEqual(report.unregistered, ['src/Pay.java'])
})

test('classify：档位不合法的行报问题且不算登记；只登记为非行为的其他差异文件按未登记处理', t => {
  const { f, from } = classifyCase(t, { 'src/Order.java': JAVA_ORDER, 'src/Pay.java': JAVA_ORDER },
    { 'src/Order.java': javaLogic(JAVA_ORDER), 'src/Pay.java': javaLogic(JAVA_ORDER) })
  writeChangeLedger(f, [['M1', 'src/Order.java', '低风险'], ['M2', 'src/Pay.java', '非行为']])
  const result = f.run('classify', f.changeRoot, '--from', from)
  assert.equal(result.code, 1)
  const report = result.json()
  assert.deepEqual(report.registered, [])
  assert.deepEqual(report.unregistered, ['src/Order.java', 'src/Pay.java'])
  assert.ok(report.issues.some(item => item.includes('M1') && item.includes('低风险')), JSON.stringify(report.issues))
  assert.ok(report.issues.some(item => item.includes('M2') && item.includes('src/Pay.java')), JSON.stringify(report.issues))
})

test('classify：登记后同一文件又有非注释修改时列入 unregistered，issues 写出登记编号与原因；新增登记行后算登记', t => {
  const { f, from } = classifyCase(t, { 'src/Order.java': JAVA_ORDER }, { 'src/Order.java': javaLogic(JAVA_ORDER) })
  const registeredAt = fingerprintOf(f)
  writeChangeLedger(f, [['M2', 'src/Order.java', '等价']])
  f.write('src/Order.java', javaRename(javaLogic(JAVA_ORDER)))
  const result = f.run('classify', f.changeRoot, '--from', from)
  assert.equal(result.code, 1, result.out)
  const report = result.json()
  assert.deepEqual(report.registered, [])
  assert.deepEqual(report.unregistered, ['src/Order.java'])
  assert.ok(report.issues.some(item => item.includes('src/Order.java') && item.includes('M2') && item.includes('之后又有非注释修改')),
    JSON.stringify(report.issues))
  writeChangeLedger(f, [['M2', 'src/Order.java', '等价', registeredAt], ['M3', 'src/Order.java', '行为']])
  const again = f.run('classify', f.changeRoot, '--from', from)
  assert.equal(again.code, 0, again.out)
  assert.deepEqual(again.json().registered, [{ file: 'src/Order.java', id: 'M3', tier: '行为' }])
  assert.deepEqual(again.json().issues, [])
})

test('classify：等价行登记后又有非注释修改，之后只新增非行为行时列入 unregistered，issues 写出两个登记编号', t => {
  const { f, from } = classifyCase(t, { 'src/Order.java': JAVA_ORDER }, { 'src/Order.java': javaLogic(JAVA_ORDER) })
  const equivalentAt = fingerprintOf(f)
  // 登记之后的行为修改没有登记，随后只修正一行注释并登记为非行为：非行为行不能证明 other 中的文件已登记。
  f.write('src/Order.java', javaRename(javaLogic(JAVA_ORDER)))
  f.write('src/Order.java', javaCommentEdit(javaRename(javaLogic(JAVA_ORDER))))
  writeChangeLedger(f, [['M1', 'src/Order.java', '等价', equivalentAt], ['M2', 'src/Order.java', '非行为']])
  const result = f.run('classify', f.changeRoot, '--from', from, '--to', fingerprintOf(f))
  assert.equal(result.code, 1, result.out)
  const report = result.json()
  assert.deepEqual(report.registered, [])
  assert.deepEqual(report.unregistered, ['src/Order.java'])
  assert.ok(report.issues.some(item => item.includes('src/Order.java') && item.includes('M1') && item.includes('之后又有非注释修改')),
    JSON.stringify(report.issues))
  assert.ok(report.issues.some(item => item.includes('src/Order.java') && item.includes('M2') && item.includes('非行为')),
    JSON.stringify(report.issues))
})

test('classify：登记后同一文件只有注释差异时仍在 registered', t => {
  const { f, from } = classifyCase(t, { 'src/Order.java': JAVA_ORDER }, { 'src/Order.java': javaLogic(JAVA_ORDER) })
  writeChangeLedger(f, [['M2', 'src/Order.java', '等价']])
  f.write('src/Order.java', javaCommentEdit(javaLogic(JAVA_ORDER)))
  const result = f.run('classify', f.changeRoot, '--from', from)
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(result.json().registered, [{ file: 'src/Order.java', id: 'M2', tier: '等价' }])
  assert.deepEqual(result.json().issues, [])
})

test('classify：仅测试行只能证明测试路径下的文件已登记，生产代码列入 unregistered 并写出原因', t => {
  const tests = {
    'src/test/java/demo/OrderIT.java': JAVA_ORDER,
    'web/order.spec.ts': 'export const a = 1\n',
    'scripts/test-gate.mjs': 'export const a = 1\n',
    'pkg/order_test.go': 'package pkg\n',
  }
  const production = { 'src/main/java/demo/SpeedTest.java': JAVA_ORDER, 'web/order.ts': 'export const a = 1\n' }
  const { f, from } = classifyCase(t, {}, { ...tests, ...production })
  writeChangeLedger(f, [['M1', Object.keys({ ...tests, ...production }).join('、'), '仅测试']])
  const result = f.run('classify', f.changeRoot, '--from', from)
  assert.equal(result.code, 1)
  const report = result.json()
  assert.deepEqual(report.registered.map(item => item.file).sort(), Object.keys(tests).sort())
  assert.ok(report.registered.every(item => item.tier === '仅测试' && item.id === 'M1'))
  assert.deepEqual(report.unregistered.sort(), Object.keys(production).sort())
  for (const file of Object.keys(production)) {
    assert.ok(report.issues.some(item => item.includes(file) && item.includes('仅测试') && item.includes('测试路径')),
      JSON.stringify(report.issues))
  }
})

test('classify：登记指纹为空、格式不合法或 tree 对象不存在时该行不算登记，issues 写出原因', t => {
  const missing = `git-tree:${'0'.repeat(40)}`
  const files = ['src/A.java', 'src/B.java', 'src/C.java']
  const { f, from } = classifyCase(t, Object.fromEntries(files.map(file => [file, JAVA_ORDER])),
    Object.fromEntries(files.map(file => [file, javaLogic(JAVA_ORDER)])))
  writeChangeLedger(f, [['M1', 'src/A.java', '等价', ''], ['M2', 'src/B.java', '等价', 'abc'], ['M3', 'src/C.java', '等价', missing]])
  const result = f.run('classify', f.changeRoot, '--from', from)
  assert.equal(result.code, 1, result.out)
  const report = result.json()
  assert.deepEqual(report.registered, [])
  assert.deepEqual(report.unregistered, files)
  assert.ok(report.issues.some(item => item.includes('M1') && item.includes('登记指纹')), JSON.stringify(report.issues))
  assert.ok(report.issues.some(item => item.includes('M2') && item.includes('abc')), JSON.stringify(report.issues))
  assert.ok(report.issues.some(item => item.includes('M3') && item.includes('src/C.java') && item.includes('tree')), JSON.stringify(report.issues))
})

// ---------------------------------------------------------------------------
// tier-post-implementation-changes Slice 03：等价修改的增量轮只跑 Standards（Seam：review）
// ---------------------------------------------------------------------------

const CARRIED = ['- Carried Axis: spec-fidelity']

/**
 * 沿用轮：第 1 轮基线 A 之后修改 changes 中的文件，再生成增量基线 B。
 * Standards 与汇总用 B，Spec Fidelity 保留 A；rows 为 [编号, 文件, 档位] 登记行。
 */
function carriedRound(t, changes, rows, options = {}) {
  const f = fixture(t)
  f.write('src/Order.java', JAVA_ORDER)
  f.git('add', '-A')
  f.git('commit', '-qm', 'java')
  const first = f.run('baseline', f.changeRoot).out
  for (const [rel, text] of Object.entries(changes)) f.write(rel, text)
  writeChangeLedger(f, rows)
  const second = f.run('baseline', f.changeRoot, '--since', field(first, 'Fingerprint')).out
  writeReview(f, second, { summaryLines: CARRIED, ...options, baselines: { spec: first, ...options.baselines } })
  return { f, first, second, result: f.run('review', f.changeRoot) }
}

test('review：Carried Axis 沿用 Spec Fidelity，增量文件只有注释差异或登记为等价时通过', t => {
  const { result } = carriedRound(t,
    { 'src/Order.java': javaCommentEdit(JAVA_ORDER), 'src/order.js': 'export const create = () => 1 // log\n' },
    [['M1', 'src/order.js', '等价']])
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  assert.equal(report.verdict, 'PASSED')
  assert.deepEqual(report.issues, [])
  assert.equal(report.carried.axis, 'spec-fidelity')
  assert.deepEqual(report.carried.files, ['src/Order.java', 'src/order.js'])
})

test('review：沿用基线之后有未登记或登记为行为的文件时报结构问题并写出文件名', t => {
  const { result } = carriedRound(t,
    { 'src/order.js': 'export const create = () => 5\n', 'src/pay.js': 'export const pay = () => 3\n' },
    [['M1', 'src/order.js', '行为']])
  assert.equal(result.code, 1, result.out)
  const report = result.json()
  assert.equal(report.verdict, 'INCOMPLETE')
  for (const file of ['src/order.js', 'src/pay.js']) {
    assert.ok(report.issues.some(issue => issue.includes('Carried Axis') && issue.includes(file)), JSON.stringify(report.issues))
  }
})

test('review：沿用轮的增量文件登记为仅测试时沿用成立', t => {
  const { result } = carriedRound(t,
    { 'src/order.js': 'export const create = () => 1 // log\n', 'test/order.test.js': 'export const ok = true\n' },
    [['M1', 'src/order.js', '等价'], ['M2', 'test/order.test.js', '仅测试']])
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(result.json().issues, [])
  assert.deepEqual(result.json().carried.files, ['src/order.js', 'test/order.test.js'])
})

test('review：评审后注释差异之外的文件全部登记为仅测试时不输出基线陈旧 warning，有等价行时照常输出', t => {
  const f = fixture(t)
  f.write('src/Order.java', JAVA_ORDER)
  writeReview(f, f.run('baseline', f.changeRoot).out)
  f.write('src/Order.java', javaCommentEdit(JAVA_ORDER))
  f.write('src/test/java/demo/OrderTest.java', JAVA_ORDER)
  writeChangeLedger(f, [['M1', 'src/test/java/demo/OrderTest.java', '仅测试']])
  const quiet = f.run('review', f.changeRoot)
  assert.equal(quiet.code, 0, quiet.out)
  assert.deepEqual(quiet.json().warnings, [])
  f.write('src/order.js', 'export const create = () => 1 // log\n')
  writeChangeLedger(f, [['M1', 'src/test/java/demo/OrderTest.java', '仅测试'], ['M2', 'src/order.js', '等价']])
  assert.ok(f.run('review', f.changeRoot).json().warnings.some(item => item.includes('Fingerprint')))
})

test('review：沿用的 Spec Fidelity 报告中的 open Blocker 仍计入裁决', t => {
  const { result } = carriedRound(t, { 'src/order.js': 'export const create = () => 1 // log\n' },
    [['M1', 'src/order.js', '等价']], { spec: [finding('SPEC-01', 'Blocker')] })
  const report = result.json()
  assert.equal(report.verdict, 'BLOCKED', result.out)
  assert.deepEqual(report.axes.find(axis => axis.axis === 'Spec Fidelity Review').openBlockers, ['SPEC-01'])
})

test('review：没有 Carried Axis 或取值不是 spec-fidelity 时按原规则比较三份基线', t => {
  for (const summaryLines of [[], ['- Carried Axis: standards']]) {
    const { result } = carriedRound(t, { 'src/order.js': 'export const create = () => 1 // log\n' },
      [['M1', 'src/order.js', '等价']], { summaryLines })
    const report = result.json()
    assert.equal(report.verdict, 'INCOMPLETE', result.out)
    assert.ok(report.issues.some(issue => issue.includes('review/spec-fidelity.md') && issue.includes('Fingerprint')), JSON.stringify(report.issues))
    if (summaryLines.length) assert.ok(report.issues.some(issue => issue.includes('Carried Axis') && issue.includes('standards')), JSON.stringify(report.issues))
  }
})

test('review：沿用基线的 tree 对象不存在时无法核对沿用条件，报结构问题', t => {
  const missing = `git-tree:${'0'.repeat(40)}`
  const f = fixture(t)
  const base = f.run('baseline', f.changeRoot).out
  writeReview(f, base, { summaryLines: CARRIED, baselines: { spec: base.replace(field(base, 'Fingerprint'), missing) } })
  const report = f.run('review', f.changeRoot).json()
  assert.equal(report.verdict, 'INCOMPLETE')
  assert.ok(report.issues.some(issue => issue.includes('Carried Axis') && issue.includes(missing)), JSON.stringify(report.issues))
})

test('review：沿用轮中登记后又有非注释修改的文件报结构问题，写出文件名与原因', t => {
  const f = fixture(t)
  const first = f.run('baseline', f.changeRoot).out
  f.write('src/order.js', 'export const create = () => 1 // log\n')
  writeChangeLedger(f, [['M1', 'src/order.js', '等价']])
  f.write('src/order.js', 'export const create = () => 5 // log\n')
  const second = f.run('baseline', f.changeRoot, '--since', field(first, 'Fingerprint')).out
  writeReview(f, second, { summaryLines: CARRIED, baselines: { spec: first } })
  const result = f.run('review', f.changeRoot)
  assert.equal(result.code, 1, result.out)
  const report = result.json()
  assert.equal(report.verdict, 'INCOMPLETE')
  assert.ok(report.issues.some(issue => issue.includes('Carried Axis') && issue.includes('src/order.js')
    && issue.includes('M1') && issue.includes('之后又有非注释修改')), JSON.stringify(report.issues))
})

test('review：沿用轮中登记行档位不合法时输出档位不合法的提示，不只输出未登记', t => {
  const { result } = carriedRound(t, { 'src/order.js': 'export const create = () => 5\n' }, [['M1', 'src/order.js', '等效']])
  const report = result.json()
  assert.equal(report.verdict, 'INCOMPLETE', result.out)
  assert.ok(report.issues.some(issue => issue.includes('Carried Axis') && issue.includes('M1') && issue.includes('等效')),
    JSON.stringify(report.issues))
})

test('review：沿用轮中另一行档位不合法、没有列出变化文件时沿用也不成立，报结构问题写出该行编号', t => {
  // 不合法的行可能就是某个变化文件的登记，因此即使它没有列出变化文件，沿用也不成立。
  const { result } = carriedRound(t, { 'src/order.js': 'export const create = () => 1 // log\n' },
    [['M1', 'src/order.js', '等价'], ['M2', 'src/pay.js', '等效']])
  assert.equal(result.code, 1, result.out)
  const report = result.json()
  assert.equal(report.verdict, 'INCOMPLETE')
  assert.ok(report.issues.some(issue => issue.includes('Carried Axis') && issue.includes('M2') && issue.includes('等效')),
    JSON.stringify(report.issues))
  assert.ok(!report.issues.some(issue => issue.includes('src/order.js')), JSON.stringify(report.issues))
})

// ---------------------------------------------------------------------------
// tier-post-implementation-changes Slice 04：待环境补测（Seam：evidence / archive）
// ---------------------------------------------------------------------------

const PENDING_PLAN = '测试环境部署后重跑 OrderApiTest'
const PENDING_OWNER = '开发负责人'

/** 待环境补测行；confirmer 为空表示用户尚未确认。 */
const pendingRow = (fingerprint, confirmer = '用户') => [fingerprint, '本地没有测试环境的支付网关', PENDING_PLAN, PENDING_OWNER, confirmer, '2026-10-20']

/** 记录 Slice 07 的证据后修改实现，使证据过期；返回证据指纹与当前指纹。 */
function environmentChange(f, { environment = '测试环境' } = {}) {
  writeTasks(f, [{ id: '07', done: [true, true], environment }])
  const recorded = fingerprintOf(f)
  f.write('src/order.js', 'export const create = () => 42\n')
  return { recorded, current: fingerprintOf(f) }
}

test('evidence：Environment 切片证据过期且有当前指纹的已确认登记时为 pending-environment，问题写入 warnings', t => {
  const f = fixture(t)
  const { recorded, current } = environmentChange(f)
  f.write('openspec/changes/demo/evidence/slice-07.md', evidence('07', recorded, { pending: [pendingRow(current)] }))
  const result = f.run('evidence', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  assert.equal(report.slices[0].status, 'pending-environment')
  assert.deepEqual(report.issues, [])
  const warning = report.warnings.find(item => item.includes('Slice 07'))
  assert.ok(warning && warning.includes(PENDING_OWNER) && warning.includes(PENDING_PLAN), JSON.stringify(report.warnings))
})

test('evidence：没有 Environment 行或确认人为空时待环境补测登记无效，仍为 stale', t => {
  for (const { environment, confirmer } of [{ environment: '', confirmer: '用户' }, { environment: '测试环境', confirmer: '' }]) {
    const f = fixture(t)
    const { recorded, current } = environmentChange(f, { environment })
    f.write('openspec/changes/demo/evidence/slice-07.md', evidence('07', recorded, { pending: [pendingRow(current, confirmer)] }))
    const result = f.run('evidence', f.changeRoot)
    assert.equal(result.code, 1, result.out)
    assert.equal(result.json().slices[0].status, 'stale')
  }
})

test('evidence：登记后只有注释差异时仍为 pending-environment；登记后有其他修改时为 stale', t => {
  const f = fixture(t)
  f.write('src/Order.java', JAVA_ORDER)
  const { recorded, current: registered } = environmentChange(f)
  f.write('openspec/changes/demo/evidence/slice-07.md', evidence('07', recorded, { pending: [pendingRow(registered)] }))
  f.write('src/Order.java', javaCommentEdit(JAVA_ORDER))
  const commentOnly = f.run('evidence', f.changeRoot)
  assert.equal(commentOnly.code, 0, commentOnly.out)
  assert.equal(commentOnly.json().slices[0].status, 'pending-environment')
  f.write('src/order.js', 'export const create = () => 43\n')
  const changed = f.run('evidence', f.changeRoot)
  assert.equal(changed.code, 1, changed.out)
  assert.equal(changed.json().slices[0].status, 'stale')
})

/** 写入 Slice 07 的 tasks.md 与新鲜证据；证据带一行登记指纹等于证据指纹的待环境补测（记录证据时集成测试没有运行）。 */
function deferredAtRecording(f, { environment = '测试环境', confirmer = '用户' } = {}) {
  writeTasks(f, [{ id: '07', done: [true, true], environment }])
  const recorded = fingerprintOf(f)
  f.write('openspec/changes/demo/evidence/slice-07.md', evidence('07', recorded, { pending: [pendingRow(recorded, confirmer)] }))
  return f.run('evidence', f.changeRoot)
}

test('trace：切片计数和登记确认人与 evidence 一致', async t => {
  const file = 'evidence/slice-02.md'
  for (const sample of GATE_TRACE_SAMPLES.filter(item => item.file === file)) {
    await t.test(sample.name, subtest => {
      const f = fixture(subtest)
      writeTasks(f, [{ id: '02', done: [true, false, true], environment: 'MQ' }])
      const fingerprint = fingerprintOf(f)
      const text = evidence('02', fingerprint).replace(/^## 待环境补测[\s\S]*$/m, '')
      f.write(`openspec/changes/demo/${file}`, `${text}\n${sample.text.replaceAll('@FINGERPRINT@', fingerprint)}`)
      f.write('openspec/changes/demo/review/standards.md', STANDARD_TRACE_REPORT)
      const checked = f.run('evidence', f.changeRoot).json().slices[0]
      const review = f.run('review', f.changeRoot).json()
      const trace = f.run('trace', f.changeRoot).json()
      assert.deepEqual(trace.findings.filter(row => row.openBlocker).map(row => row.id),
        review.axes.flatMap(axis => axis.openBlockers))
      assert.deepEqual(trace.slices, [{ id: '02', environment: 'MQ', done: 2, total: 3,
        evidence: file, fingerprint, deferred: { confirmed: true, unconfirmed: Boolean(sample.twoRows) } }])
      assert.equal(checked.status, 'pending-environment')
      assert.deepEqual(trace.signOff.pendingEnvironment[file][fingerprint], sample.twoRows ? ['测试用户', ''] : ['测试用户'])
      assert.ok(trace.signOff.pendingEnvironment[file][fingerprint].includes(checked.pendingEnvironment.confirmer))
    })
  }
})

test('trace：只读取证据头部的指纹，也保留仅有空确认人的登记', t => {
  const f = fixture(t)
  writeTasks(f, [{ id: '02', done: [true], environment: 'MQ' }])
  const file = 'evidence/slice-02.md'
  const fingerprint = 'git-tree:abc'
  f.write(`openspec/changes/demo/${file}`, [
    '- Fingerprint: git-tree:abc', '## 验证命令', '- Fingerprint: git-tree:other',
    '## 待环境补测', '| 登记指纹 | 确认人 |', '|---|---|', '| git-tree:abc | |', '',
  ].join('\n'))
  const trace = f.run('trace', f.changeRoot).json()
  assert.equal(trace.slices[0].fingerprint, fingerprint)
  assert.deepEqual(trace.slices[0].deferred, { confirmed: false, unconfirmed: true })
  assert.deepEqual(trace.signOff.pendingEnvironment[file], { [fingerprint]: [''] })
})

test('evidence：Environment 切片证据新鲜，记录证据时的登记已确认时为 pending-environment，问题写入 warnings', t => {
  const result = deferredAtRecording(fixture(t))
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  assert.equal(report.slices[0].status, 'pending-environment')
  assert.deepEqual(report.issues, [])
  const warning = report.warnings.find(item => item.includes('Slice 07'))
  assert.ok(warning && warning.includes(PENDING_OWNER) && warning.includes(PENDING_PLAN), JSON.stringify(report.warnings))
})

test('evidence：记录证据时的登记缺少确认人时为 incomplete 并记 CRITICAL', t => {
  const result = deferredAtRecording(fixture(t), { confirmer: '' })
  assert.equal(result.code, 1, result.out)
  const report = result.json()
  assert.equal(report.slices[0].status, 'incomplete')
  assert.ok(report.issues.some(item => item.includes('Slice 07') && item.includes('确认人')), JSON.stringify(report.issues))
})

test('evidence：没有 Environment 行时记录证据时的登记不起作用，切片仍为 fresh', t => {
  const result = deferredAtRecording(fixture(t), { environment: '' })
  assert.equal(result.code, 0, result.out)
  assert.equal(result.json().slices[0].status, 'fresh')
})

test('archive：其他检查通过且切片为 pending-environment 时退出码 0，notes 列出切片、负责人与补测计划', t => {
  const f = fixture(t)
  const { recorded, current } = environmentChange(f)
  f.write('openspec/changes/demo/evidence/slice-07.md', evidence('07', recorded, { pending: [pendingRow(current)] }))
  writeReview(f, f.run('baseline', f.changeRoot).out)
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  assert.equal(report.ok, true)
  const note = report.notes.find(item => item.includes('Slice 07'))
  assert.ok(note && note.includes(PENDING_OWNER) && note.includes(PENDING_PLAN), JSON.stringify(report.notes))
})

// ---------------------------------------------------------------------------
// tier-post-implementation-changes Slice 05：勾选项的阶段边界（Seam：evidence 的 taskIssues）
// ---------------------------------------------------------------------------

/** 写入一个切片的 tasks.md；lines 为切片内的任务行（含勾选框与续行）。 */
function writeSliceTasks(f, lines) {
  f.write('openspec/changes/demo/tasks.md', ['## Slice 09: 回归', 'Blocked by: 无（可立即开始）', 'Seam: POST /orders',
    'Evidence: evidence/slice-09.md', '', ...lines, ''].join('\n'))
}

test('evidence：未勾选任务要求重跑阶段命令或等阶段通过后勾选时报 phase-action，要求执行 git push 时报 git-action', t => {
  const f = fixture(t)
  writeSliceTasks(f, [
    '- [ ] 9.4 回归与复核：离线执行 `OrderApiTest`，留存输出到 evidence/slice-09.md；重跑 `/opsx:verify`，并按需刷新 overview。',
    '  - 回归已完成；`/opsx:verify` 通过后再勾选本项。',
    '- [ ] 9.6 执行 `git push` 推送分支',
  ])
  const report = f.run('evidence', f.changeRoot).json()
  const issues = report.taskIssues.map(({ task, kind }) => `${task}:${kind}`)
  assert.deepEqual(issues, ['9.4:phase-action', '9.6:git-action'], JSON.stringify(report.taskIssues))
  assert.ok(report.taskIssues[0].text.includes('/opsx:verify'), JSON.stringify(report.taskIssues))
  assert.ok(report.taskIssues[1].text.includes('git push'), JSON.stringify(report.taskIssues))
})

test('evidence：否定的 git 命令、已勾选的任务、修改阶段 skill 文件的任务不报 taskIssues', t => {
  const f = fixture(t)
  writeSliceTasks(f, [
    '- [ ] 9.1 写明记录证据时不执行 `git commit`',
    '- [x] 9.2 运行 `/opsx:verify`',
    '- [ ] 9.3 修改 `openspec-verify-change/SKILL.md` 第 9 步，同步 `claude/commands/opsx/verify.md`',
  ])
  assert.deepEqual(f.run('evidence', f.changeRoot).json().taskIssues, [])
})

test('evidence：任务含「不同」「不再」等普通词，同时要求运行阶段命令时仍报 phase-action', t => {
  const f = fixture(t)
  writeSliceTasks(f, [
    '- [ ] 9.7 补充不同场景的测试后运行 `/opsx:verify`',
    '- [ ] 9.8 确认不再报错后重跑 `/opsx:verify`',
  ])
  const report = f.run('evidence', f.changeRoot).json()
  assert.deepEqual(report.taskIssues.map(({ task, kind }) => `${task}:${kind}`), ['9.7:phase-action', '9.8:phase-action'],
    JSON.stringify(report.taskIssues))
})

test('evidence：任务含「不必要」「不得不」，同时要求运行阶段命令时仍报 phase-action；「不必」「不得」仍是否定', t => {
  const f = fixture(t)
  writeSliceTasks(f, [
    '- [ ] 9.9 删除不必要的日志后运行 `/opsx:verify`',
    '- [ ] 9.10 改完后不得不重跑 `/opsx:verify`',
    '- [ ] 9.11 写明本切片不必运行 `/opsx:overview`',
    '- [ ] 9.12 写明记录证据时不得执行 `git push`',
  ])
  const report = f.run('evidence', f.changeRoot).json()
  assert.deepEqual(report.taskIssues.map(({ task, kind }) => `${task}:${kind}`), ['9.9:phase-action', '9.10:phase-action'],
    JSON.stringify(report.taskIssues))
})

test('evidence：没有切片的平铺任务清单也计算 taskIssues', t => {
  const f = fixture(t)
  f.write('openspec/changes/demo/tasks.md', '# Tasks\n\n- [ ] 1.1 运行 `/opsx:overview` 刷新变更总览\n')
  const report = f.run('evidence', f.changeRoot).json()
  assert.equal(report.applicable, false)
  assert.deepEqual(report.taskIssues.map(({ task, kind }) => `${task}:${kind}`), ['1.1:phase-action'])
})

// ---------------------------------------------------------------------------
// add-change-head Slice 01：变更终点（Seam：fingerprint --rev、classify）
// ---------------------------------------------------------------------------

/** 提交工作区的全部修改，返回提交的全量 SHA。 */
function commitAll(f, message) {
  f.git('add', '-A')
  f.git('commit', '-qm', message)
  return f.git('rev-parse', 'HEAD')
}

/** 按 add-change-head design D1 在 tasks.md 末尾写「## 变更终点」区块；decider 为空串时写空的判定人。 */
function writeChangeHead(f, commit, { decider = 'tigger', before = '# 实施任务\n' } = {}) {
  f.write('openspec/changes/demo/tasks.md', [before, '## 变更终点', '', `- 提交：${commit}`, `- 判定人：${decider}`,
    '- 日期：2026-10-26', '- 依据：之后的提交属于其他变更', ''].join('\n'))
}

const revFingerprint = (f, rev) => {
  const result = f.run('fingerprint', f.changeRoot, '--rev', rev)
  assert.equal(result.code, 0, result.err)
  return result.out.trim()
}

test('fingerprint --rev：干净工作区时与 fingerprint 输出相同，未提交的修改不影响输出', t => {
  const f = fixture(t)
  assert.equal(revFingerprint(f, 'HEAD'), fingerprintOf(f))
  const committed = fingerprintOf(f)
  f.write('src/order.js', 'export const create = () => 7\n')
  assert.equal(revFingerprint(f, 'HEAD'), committed)
  assert.notEqual(fingerprintOf(f), committed)
})

test('fingerprint --rev：之后的提交不影响输出，两个指纹之间只差之后修改的文件', t => {
  const f = fixture(t)
  const a = f.git('rev-parse', 'HEAD')
  f.write('src/b.mjs', 'export const b = 1\n')
  commitAll(f, 'B')
  const fromA = revFingerprint(f, a)
  const result = f.run('classify', f.changeRoot, '--from', fromA, '--to', fingerprintOf(f))
  assert.deepEqual(result.json().other, ['src/b.mjs'])
})

test('fingerprint --rev：提交跟踪了规划目录且与工作区不同时仍能计算，规划目录不计入指纹', t => {
  const f = fixture(t)
  const a = f.git('rev-parse', 'HEAD')
  f.write('openspec/changes/demo/proposal.md', '# demo v2\n')
  commitAll(f, 'planning only')
  f.write('openspec/changes/demo/proposal.md', '# demo v3\n')
  assert.equal(revFingerprint(f, a), fingerprintOf(f))
})

test('fingerprint 与 fingerprint --rev：同一棵树两条路径的指纹相同，提交跟踪了变更目录外的规划目录与命中 .gitignore 的文件时也相同', t => {
  const f = fixture(t)
  // 夹具只有变更目录内的规划文件；排除规则或种子只在一条路径上修改时，下面这些文件让两个指纹不再相等。
  f.write('openspec/specs/order/spec.md', '# order\n')
  f.write('.gitignore', 'build/\n')
  f.write('build/keep.txt', 'tracked\n')
  f.git('add', '-f', 'build/keep.txt')
  commitAll(f, 'planning and ignored')
  // 未提交的修改：修改、删除、未跟踪新增、命中 .gitignore 的未跟踪文件，以及规划目录内的修改。
  f.write('src/order.js', 'export const create = () => 11\n')
  rmSync(join(f.repo, 'src/pay.js'))
  f.write('src/new.js', 'export const added = true\n')
  f.write('build/out.txt', 'ignored\n')
  f.write('openspec/specs/order/spec.md', '# order v2\n')
  const worktree = fingerprintOf(f)
  const c = commitAll(f, 'C')
  assert.equal(revFingerprint(f, c), worktree, '提交前的工作区指纹应等于该提交的指纹')
  // 之后只改规划目录：提交 C 跟踪的规划目录与 HEAD、工作区都不同。
  f.write('openspec/specs/order/spec.md', '# order v3\n')
  f.write('openspec/changes/demo/proposal.md', '# demo v2\n')
  commitAll(f, 'planning only')
  f.write('openspec/specs/order/spec.md', '# order v4\n')
  assert.equal(revFingerprint(f, c), worktree)
  assert.equal(revFingerprint(f, 'HEAD'), worktree)
  assert.equal(fingerprintOf(f), worktree)
})

test('fingerprint --rev：无法解析的值或以 - 开头的值退出码 2', t => {
  const f = fixture(t)
  for (const rev of ['no-such-rev', '-x']) {
    const result = f.run('fingerprint', f.changeRoot, '--rev', rev)
    assert.equal(result.code, 2, `${rev}: ${result.out}`)
    assert.ok(result.err.includes(rev), result.err)
  }
})

test('变更终点：有效时 classify 输出 changeHead.commit 为全量 SHA', t => {
  const f = fixture(t)
  f.write('src/order.js', 'export const create = () => 10\n')
  const c = commitAll(f, 'C')
  writeChangeHead(f, c)
  const result = f.run('classify', f.changeRoot, '--from', revFingerprint(f, c))
  assert.equal(result.code, 0, result.err || result.out)
  assert.equal(result.json().changeHead.commit, c)
  assert.equal(result.json().changeHead.fingerprint, revFingerprint(f, c))
})

test('变更终点：不是 HEAD 的祖先、不是全量 SHA 或提交不存在时，baseline、classify、review、archive 退出码 2', t => {
  const f = fixture(t)
  const main = f.git('rev-parse', '--abbrev-ref', 'HEAD')
  f.git('checkout', '-qb', 'side')
  f.write('src/side.js', 'export const side = 1\n')
  const side = commitAll(f, 'side')
  f.git('checkout', '-q', main)
  const cases = {
    [side]: '不是 HEAD 的祖先',
    [side.slice(0, 12)]: '全量 SHA',
    ['0'.repeat(40)]: '不存在',
  }
  for (const [commit, reason] of Object.entries(cases)) {
    writeChangeHead(f, commit)
    for (const command of ['baseline', 'classify', 'review', 'archive']) {
      const args = command === 'classify' ? ['--from', fingerprintOf(f)] : []
      const result = f.run(command, f.changeRoot, ...args)
      assert.equal(result.code, 2, `${command} ${commit}: ${result.out}`)
      assert.ok(result.err.includes(commit) && result.err.includes(reason), `${command}: ${result.err}`)
    }
  }
})

test('变更终点：判定人为空时 archive 退出码 2，并写明判定人为空', t => {
  const f = fixture(t)
  writeChangeHead(f, f.git('rev-parse', 'HEAD'), { decider: '' })
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 2, result.out)
  assert.ok(result.err.includes('判定人为空'), result.err)
})

test('变更终点：没有区块时 classify 仍与当前指纹比较，输出没有 changeHead', t => {
  const f = fixture(t)
  const from = fingerprintOf(f)
  f.write('src/order.js', 'export const create = () => 11\n')
  commitAll(f, 'D')
  const report = f.run('classify', f.changeRoot, '--from', from).json()
  assert.equal(report.to, fingerprintOf(f))
  assert.deepEqual(report.other, ['src/order.js'])
  assert.equal(report.changeHead, undefined)
})

test('变更终点：终点之后其他变更的提交不列为未登记，afterHead 列出这些文件', t => {
  const f = fixture(t)
  f.write('src/order.js', 'export const create = () => 12\n')
  const c = commitAll(f, 'C')
  f.write('src/order.js', 'export const create = () => 13\n')
  f.write('src/pay.js', 'export const pay = () => 14\n')
  f.write('src/other.js', 'export const other = 1\n')
  commitAll(f, 'D')
  writeChangeHead(f, c)
  const result = f.run('classify', f.changeRoot, '--from', revFingerprint(f, c))
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  assert.deepEqual(report.other, [])
  assert.deepEqual(report.unregistered, [])
  assert.deepEqual(report.changeHead.afterHead, ['src/order.js', 'src/other.js', 'src/pay.js'])
})

test('变更终点：评审之后、终点之前本变更的修改没有登记时列为未登记，退出码 1', t => {
  const f = fixture(t)
  const reviewed = fingerprintOf(f)
  f.write('src/a.mjs', 'export const a = 1\n')
  const c = commitAll(f, 'C')
  f.write('src/pay.js', 'export const pay = () => 15\n')
  commitAll(f, 'D')
  writeChangeHead(f, c)
  const result = f.run('classify', f.changeRoot, '--from', reviewed)
  assert.equal(result.code, 1, result.out)
  assert.deepEqual(result.json().unregistered, ['src/a.mjs'])
})

test('变更终点：修复直接提交在其他变更的提交之后，终点改为修复提交时两者的文件都列入 other', t => {
  const f = fixture(t)
  f.write('src/order.js', 'export const create = () => 16\n')
  const c = commitAll(f, 'C')
  f.write('src/pay.js', 'export const pay = () => 17\n')
  commitAll(f, 'D')
  f.write('src/order.js', 'export const create = () => 18\n')
  const fix = commitAll(f, 'F')
  writeChangeHead(f, fix)
  const report = f.run('classify', f.changeRoot, '--from', revFingerprint(f, c)).json()
  assert.deepEqual(report.other, ['src/order.js', 'src/pay.js'])
})

test('变更终点：未提交的修改列入 uncommitted 与 afterHead，不列为未登记', t => {
  const f = fixture(t)
  f.write('src/b.mjs', 'export const b = 1\n')
  const c = commitAll(f, 'C')
  f.write('src/b.mjs', 'export const b = 2\n')
  writeChangeHead(f, c)
  const result = f.run('classify', f.changeRoot, '--from', revFingerprint(f, c))
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  assert.deepEqual(report.changeHead.uncommitted, ['src/b.mjs'])
  assert.deepEqual(report.changeHead.afterHead, ['src/b.mjs'])
  assert.deepEqual(report.unregistered, [])
})

test('变更终点：不传 --to 时与终点指纹比较，传了 --to 时用传入的值', t => {
  const f = fixture(t)
  const from = fingerprintOf(f)
  f.write('src/order.js', 'export const create = () => 19\n')
  const c = commitAll(f, 'C')
  f.write('src/pay.js', 'export const pay = () => 20\n')
  commitAll(f, 'D')
  writeChangeHead(f, c)
  const byDefault = f.run('classify', f.changeRoot, '--from', from).json()
  assert.equal(byDefault.to, revFingerprint(f, c))
  assert.deepEqual(byDefault.other, ['src/order.js'])
  const explicit = f.run('classify', f.changeRoot, '--from', from, '--to', fingerprintOf(f)).json()
  assert.deepEqual(explicit.other, ['src/order.js', 'src/pay.js'])
})

test('变更终点：切片标题含「变更终点」时不当作变更终点区块', t => {
  const f = fixture(t)
  const from = fingerprintOf(f)
  f.write('openspec/changes/demo/tasks.md', '# 实施任务\n\n## Slice 01: 声明变更终点后的行为\n\n- 提交：not-a-sha\n')
  const result = f.run('classify', f.changeRoot, '--from', from)
  assert.equal(result.code, 0, result.err || result.out)
  assert.equal(result.json().changeHead, undefined)
})

// ---------------------------------------------------------------------------
// add-change-head Slice 02：评审基线截止到变更终点（Seam：baseline、review）
// ---------------------------------------------------------------------------

/** 构造「提交 C 修改 2 个文件，之后另一个变更的提交 D 修改 3 个其他文件」的仓库，返回 C、D 的全量 SHA。 */
function lateReviewRepo(f) {
  f.write('src/order.js', 'export const create = () => 21\n')
  f.write('src/pay.js', 'export const pay = () => 22\n')
  const c = commitAll(f, 'C')
  for (const name of ['x', 'y', 'z']) f.write(`src/${name}.js`, `export const ${name} = 1\n`)
  const d = commitAll(f, 'D')
  return { c, d }
}

test('变更终点：晚评审的基线范围为 Base..变更终点，指纹为终点指纹，并写出 Change Head', t => {
  const f = fixture(t)
  const { c } = lateReviewRepo(f)
  writeChangeHead(f, c)
  const result = f.run('baseline', f.changeRoot, '--base', `${c}^`)
  assert.equal(result.code, 0, result.err)
  const base = f.git('rev-parse', `${c}^`)
  assert.equal(field(result.out, 'Review Scope'), `${base.slice(0, 12)}..${c.slice(0, 12)}（排除 openspec）`)
  assert.equal(field(result.out, 'Fingerprint'), revFingerprint(f, c))
  assert.equal(field(result.out, 'Change Head'), c)
})

test('变更终点：Base Commit 在变更终点之后时 baseline 退出码 2', t => {
  const f = fixture(t)
  const { c, d } = lateReviewRepo(f)
  writeChangeHead(f, c)
  const result = f.run('baseline', f.changeRoot, '--base', d)
  assert.equal(result.code, 2, result.out)
  assert.ok(result.err.includes(d.slice(0, 12)) || result.err.includes(d), result.err)
})

test('变更终点：从终点开分支提交的修复合并后改为终点，baseline --since 只列出修复的文件', t => {
  const f = fixture(t)
  const { c } = lateReviewRepo(f)
  const main = f.git('rev-parse', '--abbrev-ref', 'HEAD')
  f.git('checkout', '-qb', 'fix', c)
  f.write('src/a.mjs', 'export const a = 1\n')
  const e = commitAll(f, 'E')
  f.git('checkout', '-q', main)
  f.git('-c', 'core.editor=true', 'merge', '--no-ff', '-q', '-m', 'merge fix', 'fix')
  writeChangeHead(f, e)
  const result = f.run('baseline', f.changeRoot, '--base', `${c}^`, '--since', revFingerprint(f, c))
  assert.equal(result.code, 0, result.err)
  assert.deepEqual(deltaFiles(result.out), ['src/a.mjs'])
})

test('变更终点：评审基线在变更终点、之后有其他变更的提交时，review 不输出陈旧提醒', t => {
  const f = fixture(t)
  const { c } = lateReviewRepo(f)
  writeChangeHead(f, c)
  writeReview(f, f.run('baseline', f.changeRoot, '--base', `${c}^`).out)
  const result = f.run('review', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(result.json().warnings, [])
})

test('变更终点：评审基线到变更终点之间本变更有修改时，review 的陈旧提醒写出变更终点', t => {
  const f = fixture(t)
  // 先生成评审基线、再声明变更终点：起点等于终点时 baseline 退出码 2（STD-01），不能用终点等于起点的基线。
  writeReview(f, f.run('baseline', f.changeRoot).out)
  f.write('src/order.js', 'export const create = () => 23\n')
  const c = commitAll(f, 'C')
  writeChangeHead(f, c)
  const warnings = f.run('review', f.changeRoot).json().warnings
  assert.equal(warnings.length, 1, JSON.stringify(warnings))
  assert.ok(warnings[0].includes('变更终点') && warnings[0].includes(revFingerprint(f, c)), warnings[0])
})

test('变更终点：三份报告的 Change Head 不一致时报结构问题', t => {
  const f = fixture(t)
  const { c } = lateReviewRepo(f)
  writeChangeHead(f, c)
  const baseline = f.run('baseline', f.changeRoot, '--base', `${c}^`).out
  writeReview(f, baseline, { baselines: { summary: baseline.replace(/^- Change Head: .*\n/m, '') } })
  const report = f.run('review', f.changeRoot).json()
  assert.ok(report.issues.some(issue => issue.includes('Change Head')), JSON.stringify(report.issues))
})

// ---------------------------------------------------------------------------
// add-change-head Slice 03：verify 与 archive 按变更终点核对（Seam：evidence、archive）
// ---------------------------------------------------------------------------

/** 在已有 tasks.md（切片与证据引用）之后追加「## 变更终点」区块。 */
const appendChangeHead = (f, commit) =>
  writeChangeHead(f, commit, { before: readFileSync(join(f.changeRoot, 'tasks.md'), 'utf8') })

test('变更终点：终点之后的提交让证据过期，重跑切片验证后为 fresh', t => {
  const f = fixture(t)
  f.write('src/order.js', 'export const create = () => 24\n')
  const c = commitAll(f, 'C')
  completedChange(f, ['01'])
  appendChangeHead(f, c)
  f.write('src/x.js', 'export const x = 1\n')
  commitAll(f, 'D')
  const stale = f.run('evidence', f.changeRoot).json()
  assert.equal(stale.slices[0].status, 'stale')
  assert.deepEqual(stale.slices[0].changedSinceEvidence, ['src/x.js'])
  f.write('openspec/changes/demo/evidence/slice-01.md', evidence('01', fingerprintOf(f)))
  assert.equal(f.run('evidence', f.changeRoot).json().slices[0].status, 'fresh')
})

test('变更终点：未提交的文件不阻断归档，notes 写出变更终点与判定人，warnings 列出未提交的文件', t => {
  const f = fixture(t)
  f.write('src/order.js', 'export const create = () => 25\n')
  const c = commitAll(f, 'C')
  f.write('src/x.js', 'export const x = 1\n')
  commitAll(f, 'D')
  f.write('src/c.mjs', 'export const c = 1\n')
  completedChange(f)
  appendChangeHead(f, c)
  writeReview(f, f.run('baseline', f.changeRoot, '--base', `${c}^`).out)
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  const note = report.notes.find(item => item.includes(c))
  assert.ok(note && note.includes('tigger') && note.includes('2 个'), JSON.stringify(report.notes))
  assert.ok(report.warnings.some(item => item.includes('src/c.mjs')), JSON.stringify(report.warnings))
  assert.ok(!report.warnings.some(item => item.includes('评审基线 Fingerprint')), JSON.stringify(report.warnings))
  assert.deepEqual(report.changeHead.uncommitted, ['src/c.mjs'])
})

test('变更终点：没有未提交的文件时 archive 不输出变更终点的 warning', t => {
  const f = fixture(t)
  f.write('src/order.js', 'export const create = () => 26\n')
  const c = commitAll(f, 'C')
  completedChange(f)
  appendChangeHead(f, c)
  writeReview(f, f.run('baseline', f.changeRoot, '--base', `${c}^`).out)
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(result.json().warnings, [])
  assert.ok(result.json().notes.some(item => item.includes(c) && item.includes('0 个')), JSON.stringify(result.json().notes))
})

// ---------------------------------------------------------------------------
// add-change-head 双轴评审 R1 修复（STD-01、SPEC-02）
// ---------------------------------------------------------------------------

test('变更终点：Base Commit 等于变更终点时 baseline 退出码 2，并写明评审范围为空', t => {
  const f = fixture(t)
  f.write('src/order.js', 'export const create = () => 27\n')
  const c = commitAll(f, 'C')
  writeChangeHead(f, c)
  for (const args of [[], ['--base', c]]) {
    const result = f.run('baseline', f.changeRoot, ...args)
    assert.equal(result.code, 2, `baseline ${args.join(' ')}: ${result.out}`)
    assert.ok(result.err.includes('评审范围为空') && result.err.includes('--base'), result.err)
  }
})

test('变更终点：区块无效时 evidence 不读取区块，退出码与切片结果和没有区块时相同', t => {
  const f = fixture(t)
  completedChange(f, ['01'])
  const without = f.run('evidence', f.changeRoot)
  appendChangeHead(f, 'not-a-full-sha')
  const withInvalid = f.run('evidence', f.changeRoot)
  assert.equal(withInvalid.code, without.code, withInvalid.err)
  assert.deepEqual(withInvalid.json().slices, without.json().slices)
  // 同一个区块让读取变更终点的命令退出码 2，说明区块确实无效。
  assert.equal(f.run('classify', f.changeRoot, '--from', fingerprintOf(f)).code, 2)
})

// ---------------------------------------------------------------------------
// add-change-progress-view Slice 01：facts 输出一个变更的事实（Seam：implementation-gate.mjs facts）
// ---------------------------------------------------------------------------

/** 运行 facts 并解析 JSON；退出码不是 0 时直接失败，并写出 stderr。 */
const factsOf = f => {
  const result = f.run('facts', f.changeRoot)
  assert.equal(result.code, 0, result.err)
  return result.json()
}

/** 写 review-summary.md，lines 为正文行。 */
const writeSummary = (f, ...lines) =>
  f.write('openspec/changes/demo/review-summary.md', ['# 技术评审汇总（demo）', '', ...lines, ''].join('\n'))

/** 写 verification.md；fingerprint 为 null 时不写 Fingerprint 行，verdictLines 为 Fingerprint 行之后的结论字段行。 */
const writeVerification = (f, fingerprint, verdictLines = []) => f.write('openspec/changes/demo/verification.md',
  ['# Verify 报告（demo）', '', ...(fingerprint ? [`- Fingerprint: ${fingerprint}`] : []), ...verdictLines, '- Verify Mode: 全量', '']
    .join('\n'))

/** 没有结论字段的旧报告在 facts.verification 中的结论字段（add-verify-verdict design D5）。 */
const LEGACY_VERDICT = { verdict: null, criticalCount: null, legacy: true }

/** 没有 verify 报告时 facts.verification 中的结论字段。 */
const NO_REPORT_VERDICT = { verdict: null, criticalCount: null, legacy: null }

/** 写 design.md：lines 为 Open Questions 一节的正文。前后各有一节带列表项，确认只统计该节。 */
const writeDesign = (f, lines, heading = '## Open Questions') => f.write('openspec/changes/demo/design.md',
  ['## Context', '', '- 背景说明', '', heading, '', ...lines, '', '## 评审意见闭环记录', '', '- 不是待决定事项', ''].join('\n'))

test('facts：存在阻断项时退出码 0，archive 与 archive 子命令的输出相同，不写变更目录', t => {
  const f = fixture(t)
  completedChange(f, ['01'])
  f.write('src/order.js', 'export const create = () => 42\n')
  const before = snapshot(f.changeRoot)
  const result = f.run('facts', f.changeRoot)
  assert.equal(result.code, 0, result.err)
  const facts = result.json()
  assert.deepEqual(Object.keys(facts).sort(),
    ['archive', 'change', 'changeDirectory', 'changeState', 'changeStateVersion', 'command', 'currentFingerprint', 'openQuestions', 'technicalReview', 'tier', 'verification'])
  assert.equal(facts.command, 'facts')
  assert.equal(facts.change, 'demo')
  assert.equal(facts.currentFingerprint, fingerprintOf(f))
  assert.equal(facts.archive.ok, false)
  assert.ok(facts.archive.blockers.some(item => item.includes('Slice 01') && item.includes('过期')), JSON.stringify(facts.archive.blockers))
  const archive = f.run('archive', f.changeRoot).json()
  delete archive.command
  delete archive.change
  assert.deepEqual(facts.archive, archive)
  assert.deepEqual(snapshot(f.changeRoot), before)
})

test('facts 暂缓：已核验的目录缺少状态文件时继续推进，不创建文件', t => {
  const f = fixture(t)
  const before = snapshot(f.changeRoot)
  const facts = factsOf(f)
  assert.equal(facts.changeStateVersion, 1)
  assert.deepEqual(facts.changeState, { state: 'enabled', reason: null, updatedAt: null, error: null, digest: null })
  assert.match(facts.changeDirectory.path, /\/openspec\/changes\/demo$/)
  assert.match(facts.changeDirectory.dev, /^\d+$/)
  assert.match(facts.changeDirectory.ino, /^\d+$/)
  assert.deepEqual(snapshot(f.changeRoot), before)
})

const stateRelative = 'openspec/changes/demo/change-state.json'
const pausedState = { version: 1, state: 'paused', reason: '保留已有工作', updatedAt: '2026-11-23T08:00:00.000Z' }

test('STD-01：未提供 Array.prototype.at 时仍能查询活跃和归档变更', t => {
  const f = fixture(t)
  const archived = 'openspec/changes/archive/2026-11-23-demo'
  f.write(`${archived}/change-state.json`, JSON.stringify(pausedState))
  // 仅在门禁子进程模拟 Node.js 16.0–16.5 缺少的 API，不改变测试进程。
  f.write('node16.cjs', 'delete Array.prototype.at\n')
  const env = { NODE_OPTIONS: `--require "${join(f.repo, 'node16.cjs')}"` }
  for (const command of ['state', 'facts']) {
    for (const [dir, expected] of [[f.changeRoot, 'enabled'], [join(f.repo, archived), 'paused']]) {
      const result = f.runWithEnv(env, command, dir)
      assert.equal(result.code, 0, result.err)
      assert.equal(result.json().changeState.state, expected, `${command}: ${dir}`)
    }
  }
})

test('facts 暂缓：合法文件保留状态，摘要覆盖原始字节', t => {
  const f = fixture(t)
  const text = JSON.stringify(pausedState)
  f.write(stateRelative, `${text}\n`)
  const first = factsOf(f).changeState
  assert.deepEqual(first, {
    state: 'paused', reason: pausedState.reason, updatedAt: pausedState.updatedAt,
    error: null, digest: '9686df70072fc40606d9e039838b133cbcd5df1dda6bb7946fa0f4d47828ad9a',
  })
  assert.deepEqual(factsOf(f).changeState, first)
  f.write(stateRelative, text)
  assert.notEqual(factsOf(f).changeState.digest, first.digest)
})

test('facts 暂缓：根目录的状态文件允许保留，归档阻断和实现指纹不变', t => {
  const f = fixture(t)
  const fingerprint = fingerprintOf(f)
  writeVerification(f, fingerprint, ['- Verify-Verdict: FAIL', '- Critical-Count: 1'])
  const before = f.run('archive', f.changeRoot)
  const text = `${JSON.stringify(pausedState)}\n`
  f.write(stateRelative, text)
  f.write('openspec/changes/demo/other/change-state.json', text)
  const hygiene = f.run('hygiene', f.changeRoot).json()
  assert.deepEqual(hygiene.warnings.map(item => item.file), ['other/change-state.json'])
  assert.equal(fingerprintOf(f), fingerprint)
  const after = f.run('archive', f.changeRoot)
  assert.equal(after.code, 1)
  assert.deepEqual(after.json(), before.json())
  assert.ok(after.json().blockers.some(item => item.startsWith('verify 报告：')))
})

test('facts 暂缓：状态内容无效时保留原裁决和原始摘要，不输出原因', t => {
  const f = fixture(t)
  writeSummary(f, 'Gate-Verdict: BLOCKED')
  for (const text of [
    '{', Buffer.from([0xff]), `${JSON.stringify(pausedState)}\r\n`,
    JSON.stringify({ ...pausedState, extra: true }), JSON.stringify({ ...pausedState, version: 2 }),
    JSON.stringify({ ...pausedState, state: 'unknown' }), JSON.stringify({ ...pausedState, reason: '　' }),
    JSON.stringify({ ...pausedState, updatedAt: '2026-02-30T08:00:00Z' }),
    JSON.stringify({ ...pausedState, updatedAt: '2026-11-23T08:00:00+08:00' }),
  ]) {
    f.write(stateRelative, text)
    const facts = factsOf(f)
    assert.equal(facts.technicalReview.gateVerdict, 'BLOCKED')
    assert.equal(facts.changeState.state, 'unknown')
    assert.equal(facts.changeState.reason, null)
    assert.equal(facts.changeState.updatedAt, null)
    assert.match(facts.changeState.error, /change-state\.json/u)
    assert.match(facts.changeState.digest, /^[a-f0-9]{64}$/u)
  }
})

test('facts 暂缓：顶层成员名重复时状态未知，错误含文件路径，仍输出原始摘要（DB-15）', t => {
  const f = fixture(t)
  const { version, reason, updatedAt } = pausedState
  const members = (...pairs) => `{${pairs.map(([key, value]) => `${key}:${JSON.stringify(value)}`).join(',')}}\n`
  // JSON.parse 只保留重复成员的后一个值，键集合仍为四项；两种键顺序与转义写法的成员名都要识别。
  for (const text of [
    members(['"version"', version], ['"state"', 'enabled'], ['"reason"', reason], ['"updatedAt"', updatedAt], ['"state"', 'paused']),
    members(['"state"', 'paused'], ['"version"', version], ['"reason"', reason], ['"updatedAt"', updatedAt], ['"state"', 'enabled']),
    members(['"version"', version], ['"state"', 'enabled'], ['"reason"', reason], ['"updatedAt"', updatedAt], ['"st\\u0061te"', 'paused']),
  ]) {
    f.write(stateRelative, text)
    for (const command of ['facts', 'state']) {
      const result = f.run(command, f.changeRoot)
      assert.equal(result.code, 0, result.err)
      const { changeState } = result.json()
      assert.equal(changeState.state, 'unknown', `${command}：${text}`)
      assert.equal(changeState.reason, null)
      assert.match(changeState.error, /change-state\.json.*重复/u)
      assert.equal(changeState.digest, createHash('sha256').update(text).digest('hex'))
    }
  }
  // 对照：原因文本中出现的成员名不是顶层成员，合法文件仍按暂缓读取。
  f.write(stateRelative, members(['"version"', version], ['"state"', 'paused'], ['"reason"', '"state":重复'], ['"updatedAt"', updatedAt]))
  assert.equal(factsOf(f).changeState.state, 'paused')
})

test('facts 暂缓：文件与原因的上限按字节计算，超限不返回截断摘要', t => {
  const f = fixture(t)
  const reason = '界'.repeat(341) + 'A'
  const json = JSON.stringify({ ...pausedState, reason: ` ${reason} ` })
  const atLimit = json + ' '.repeat(16 * 1024 - Buffer.byteLength(json))
  f.write(stateRelative, atLimit)
  const facts = factsOf(f)
  assert.equal(facts.changeState.state, 'paused')
  assert.equal(facts.changeState.reason, ` ${reason} `)
  f.write(stateRelative, atLimit + '\n')
  const large = factsOf(f)
  assert.equal(large.changeState.state, 'unknown')
  assert.equal(large.changeState.digest, null)
  assert.equal(large.currentFingerprint, facts.currentFingerprint)
  f.write(stateRelative, JSON.stringify({ ...pausedState, reason: reason + 'B' }))
  const reasonLarge = factsOf(f).changeState
  assert.equal(reasonLarge.state, 'unknown')
  assert.match(reasonLarge.digest, /^[a-f0-9]{64}$/u)
})

test('facts 暂缓：软链接与非普通状态文件不读取内容', t => {
  const f = fixture(t)
  const target = join(f.changeRoot, 'change-state.json')
  f.write('src/state.json', JSON.stringify(pausedState))
  symlinkSync(join(f.repo, 'src/state.json'), target)
  assert.equal(factsOf(f).changeState.state, 'unknown')
  assert.equal(factsOf(f).changeState.digest, null)
  rmSync(target)
  mkdirSync(target)
  assert.equal(factsOf(f).changeState.state, 'unknown')
  assert.equal(factsOf(f).changeState.digest, null)
})

test('facts 暂缓：调用方选择项目，拒绝跨项目和目录软链接，仅读取合法归档项', t => {
  const f = fixture(t)
  const other = fixture(t)
  other.write(stateRelative, JSON.stringify(pausedState))
  const crossed = f.run('facts', other.changeRoot, '--repo', f.repo).json()
  assert.equal(crossed.changeDirectory, null)
  assert.equal(crossed.changeState.state, 'unknown')
  assert.equal(crossed.changeState.digest, null)
  const link = join(f.repo, 'openspec/changes/alias')
  symlinkSync(other.changeRoot, link)
  const linked = f.run('facts', link, '--repo', f.repo).json()
  assert.equal(linked.changeDirectory, null)
  assert.equal(linked.changeState.state, 'unknown')
  f.write('openspec/changes/archive/2026-11-23-demo/change-state.json', JSON.stringify(pausedState))
  const archived = f.run('facts', join(f.repo, 'openspec/changes/archive/2026-11-23-demo'), '--repo', f.repo).json()
  assert.equal(archived.changeState.state, 'paused')
  assert.match(archived.changeDirectory.path, /\/archive\/2026-11-23-demo$/u)
})

test('facts 暂缓：读取期间目录实例改变时丢弃状态和摘要', t => {
  const f = fixture(t)
  f.write(stateRelative, JSON.stringify(pausedState))
  f.write('move.cjs', `const fs = require('node:fs')
const open = fs.openSync
let moved = false
fs.openSync = (file, ...args) => {
  const fd = open(file, ...args)
  if (!moved && String(file).endsWith('/change-state.json')) {
    moved = true
    const target = require('node:path').dirname(file)
    fs.renameSync(target, target + '-moved')
    fs.mkdirSync(target)
  }
  return fd
}
require('node:module').syncBuiltinESMExports()
`)
  const result = f.runWithEnv({ NODE_OPTIONS: `--require ${join(f.repo, 'move.cjs')}` }, 'facts', f.changeRoot)
  assert.equal(result.code, 0, result.err)
  assert.equal(result.json().changeDirectory, null)
  assert.equal(result.json().changeState.state, 'unknown')
  assert.equal(result.json().changeState.digest, null)
})

/** 对象库中的松散对象与打包对象合计；用于证明只读查询没有写入 Git 对象。 */
function objectCount(f) {
  const stats = Object.fromEntries(f.git('count-objects', '-v').split('\n').map(line => line.split(': ')))
  return Number(stats.count) + Number(stats['in-pack'])
}

test('state 暂缓：只读子命令与 facts 的状态字段相同，且不写 Git 对象', t => {
  const f = fixture(t)
  f.write(stateRelative, JSON.stringify(pausedState))
  f.write('src/unrecorded.js', 'export const unrecorded = true\n')
  const before = objectCount(f)
  const result = f.run('state', f.changeRoot, '--repo', f.repo)
  assert.equal(result.code, 0, result.err)
  assert.equal(objectCount(f), before)
  const state = result.json()
  assert.deepEqual(Object.keys(state).sort(), ['change', 'changeDirectory', 'changeState', 'changeStateVersion', 'command'])
  assert.equal(state.command, 'state')
  assert.equal(state.changeState.state, 'paused')
  const facts = factsOf(f)
  for (const key of ['changeStateVersion', 'changeDirectory', 'changeState']) assert.deepEqual(state[key], facts[key])
  const other = fixture(t)
  const crossed = f.run('state', other.changeRoot, '--repo', f.repo)
  assert.equal(crossed.code, 0, crossed.err)
  assert.equal(crossed.json().changeDirectory, null)
  assert.equal(crossed.json().changeState.state, 'unknown')
  assert.equal(f.run('state', f.changeRoot, '--rev', 'HEAD').code, 2)
})

test('facts：tier 读取 overview.md 的分级行，没有 overview.md 时为 null', t => {
  const f = fixture(t)
  assert.equal(factsOf(f).tier, null)
  f.write('openspec/changes/demo/overview.md', '> 分级：L2 标准 ｜ 判定人：tigger ｜ 日期：2026-10-30 ｜ 依据：新增业务流程\n')
  assert.equal(factsOf(f).tier, 'L2')
})

test('facts：变更目录不存在、缺少变更目录或参数不支持时退出码 2 并写出原因', t => {
  const f = fixture(t)
  const missing = join(f.repo, 'openspec/changes/missing')
  const result = f.run('facts', missing)
  assert.equal(result.code, 2)
  assert.ok(result.err.includes('变更目录不存在') && result.err.includes(missing), result.err)
  assert.equal(f.run('facts').code, 2)
  const unsupported = f.run('facts', f.changeRoot, '--rev', 'HEAD')
  assert.equal(unsupported.code, 2)
  assert.ok(unsupported.err.includes('--rev'), unsupported.err)
})

test('facts：Gate-Verdict: BLOCKED 时 gateVerdict 为 BLOCKED', t => {
  const f = fixture(t)
  writeSummary(f, 'Gate-Level: L2', '- Gate-Verdict: `BLOCKED`', 'Technical Review Approved: tigger 2026-10-30')
  assert.deepEqual(factsOf(f).technicalReview, { exists: true, gateVerdict: 'BLOCKED', approval: 'signed' })
})

test('facts：裁决值取最后一个 Gate-Verdict: 之后第一个由 ASCII 字母与下划线组成的词，没有这样的词时为 null', t => {
  const f = fixture(t)
  // 期望值来自 spec 场景与修复后 hook（提交 75eb718）的规则：全角空格、全角括号与加粗都不影响取到的词。
  for (const [line, expected] of [
    ['Gate-Verdict: BLOCKED　（未闭环）', 'BLOCKED'],
    ['Gate-Verdict: BLOCKED（未闭环）', 'BLOCKED'],
    ['Gate-Verdict:　BLOCKED', 'BLOCKED'],
    ['Gate-Verdict: **BLOCKED**（未闭环）', 'BLOCKED'],
    ['Gate-Verdict: READY_FOR_HUMAN_APPROVAL　（说明）', 'READY_FOR_HUMAN_APPROVAL'],
    ['Gate-Verdict: 待定', null],
  ]) {
    writeSummary(f, line, SIGNATURE_LINES.signed[0])
    assert.equal(factsOf(f).technicalReview.gateVerdict, expected, line)
  }
})

test('facts：签字行是下划线占位后补说明时 approval 为 blank', t => {
  const f = fixture(t)
  writeSummary(f, 'Gate-Verdict: READY_FOR_HUMAN_APPROVAL', 'Technical Review Approved: __________ （签字 / 日期）')
  assert.deepEqual(factsOf(f).technicalReview, { exists: true, gateVerdict: 'READY_FOR_HUMAN_APPROVAL', approval: 'blank' })
})

test('facts：签字行写了批准人时 approval 为 signed', t => {
  const f = fixture(t)
  writeSummary(f, 'Gate-Verdict: READY_FOR_HUMAN_APPROVAL', 'Technical Review Approved: tigger 2026-10-30')
  assert.equal(factsOf(f).technicalReview.approval, 'signed')
})

test('facts：没有 Gate-Verdict 行的旧版汇总 gateVerdict 为 null；没有汇总时 exists 为 false、approval 为 missing', t => {
  const f = fixture(t)
  assert.deepEqual(factsOf(f).technicalReview, { exists: false, gateVerdict: null, approval: 'missing' })
  writeSummary(f, '## 4. 门禁裁决', '', '- 裁决：READY_FOR_HUMAN_APPROVAL', '', 'Technical Review Approved: tigger 2026-10-30')
  assert.deepEqual(factsOf(f).technicalReview, { exists: true, gateVerdict: null, approval: 'signed' })
})

test('facts：verify 报告的指纹等于当前指纹时 current 为 true', t => {
  const f = fixture(t)
  const current = fingerprintOf(f)
  writeVerification(f, current)
  assert.deepEqual(factsOf(f).verification, { exists: true, fingerprint: current, current: true, expectedFingerprint: current,
    ...LEGACY_VERDICT })
})

test('facts：verify 报告之后源文件有修改时 current 为 false；没有报告或报告没有指纹时 current 为 null', t => {
  const f = fixture(t)
  const reported = fingerprintOf(f)
  writeVerification(f, reported)
  f.write('src/order.js', 'export const create = () => 43\n')
  const changed = fingerprintOf(f)
  assert.notEqual(changed, reported)
  assert.deepEqual(factsOf(f).verification, { exists: true, fingerprint: reported, current: false, expectedFingerprint: changed,
    ...LEGACY_VERDICT })
  writeVerification(f, null)
  assert.deepEqual(factsOf(f).verification, { exists: true, fingerprint: null, current: null, expectedFingerprint: changed,
    ...LEGACY_VERDICT })
  rmSync(join(f.changeRoot, 'verification.md'))
  assert.deepEqual(factsOf(f).verification, { exists: false, fingerprint: null, current: null, expectedFingerprint: changed,
    ...NO_REPORT_VERDICT })
})

test('facts：verify 报告的 Fingerprint 字段用加粗、全角冒号或反引号时也能读出；指纹后接说明文字时为 null', t => {
  const f = fixture(t)
  const current = fingerprintOf(f)
  const writeReport = line => f.write('openspec/changes/demo/verification.md', ['# Verify 报告（demo）', '', line, ''].join('\n'))
  for (const line of [`- **Fingerprint**: ${current}`, `- Fingerprint：${current}`, `- Fingerprint: \`${current}\``]) {
    writeReport(line)
    assert.deepEqual(factsOf(f).verification, { exists: true, fingerprint: current, current: true, expectedFingerprint: current,
      ...LEGACY_VERDICT }, line)
  }
  // 说明文字让值不再是合法指纹：与其他指纹字段的校验相同，不截取前面的哈希部分。
  writeReport(`- Fingerprint: ${current} （终点指纹）`)
  assert.deepEqual(factsOf(f).verification, { exists: true, fingerprint: null, current: null, expectedFingerprint: current,
    ...LEGACY_VERDICT })
})

test('facts：声明了变更终点时与终点指纹比较，终点之后其他提交修改源文件不影响 current', t => {
  const f = fixture(t)
  f.write('src/order.js', 'export const create = () => 30\n')
  const c = commitAll(f, 'C')
  writeChangeHead(f, c)
  f.write('src/x.js', 'export const x = 1\n')
  commitAll(f, 'D')
  const head = revFingerprint(f, c)
  writeVerification(f, head)
  const facts = factsOf(f)
  assert.equal(facts.verification.expectedFingerprint, head)
  assert.notEqual(facts.verification.expectedFingerprint, facts.currentFingerprint)
  assert.equal(facts.verification.current, true)
})

test('facts：变更终点无效时退出码 2 并写出原因', t => {
  const f = fixture(t)
  writeChangeHead(f, 'not-a-full-sha')
  const result = f.run('facts', f.changeRoot)
  assert.equal(result.code, 2)
  assert.ok(result.err.includes('变更终点'), result.err)
})

test('facts：Open Questions 用 ### 标题列出问题，标题下有选项列表与「建议」、没有「结论」时都算待决定', t => {
  const f = fixture(t)
  writeDesign(f, ['1', '2', '3', '4'].flatMap(n =>
    [`### Q${n}：入口放在哪里`, '', '- 选项 A：两步说明', '- 选项 B：依次调用', '', '建议：选项 A', '']))
  assert.deepEqual(factsOf(f).openQuestions, { pending: 4, total: 4 })
})

test('facts：Open Questions 的顶层列表项写了「结论」时算已决，子列表与代码块中的行不算条目，标题不区分大小写', t => {
  const f = fixture(t)
  const items = decided => ['1', '2', '3'].flatMap(n =>
    [`- Q${n} 是否拆分？${decided.includes(n) ? '**结论（2026-10-07）**：不拆。' : '待讨论。'}`, '  - 依据：两个变更修改同一批文件'])
  const codeBlock = ['', '```text', '- 代码块中的行不是条目', '### 也不是条目', '```']
  writeDesign(f, [...items(['1', '2', '3']), ...codeBlock], '## Open questions')
  assert.deepEqual(factsOf(f).openQuestions, { pending: 0, total: 3 })
  writeDesign(f, [...items(['1', '3']), ...codeBlock], '## Open questions')
  assert.deepEqual(factsOf(f).openQuestions, { pending: 1, total: 3 })
})

test('facts：Open Questions 只写「无。」、没有该节或没有 design.md 时条数为 0', t => {
  const f = fixture(t)
  assert.deepEqual(factsOf(f).openQuestions, { pending: 0, total: 0 })
  writeDesign(f, ['无。'])
  assert.deepEqual(factsOf(f).openQuestions, { pending: 0, total: 0 })
  writeDesign(f, ['- 不是 Open Questions 一节的条目'], '## Decisions')
  assert.deepEqual(factsOf(f).openQuestions, { pending: 0, total: 0 })
})

const approvalHook = fileURLToPath(new URL('../skills/openspec-technical-review/hooks/check-review-approval.sh', import.meta.url))

/**
 * 签字行样本：开头是 hook 测试也使用的共享样本（scripts/lib/review-approval-samples.mjs，含全角与非 ASCII 空白写法），null 表示没有签字行，
 * 其余覆盖 hook 的其他判定分支：空值、单个下划线、模板占位符、「签署人」之后的内容不算签字值、行首有列表与加粗标记，
 * 以及替换非 ASCII 空白后才出现的第二个标记：签字值取原文中最后一个标记之后的内容，替换空白不能改变标记位置。
 */
const SIGNATURE_SAMPLES = [
  ...SIGNATURE_LINES.placeholder,
  ...SIGNATURE_LINES.placeholderWithNote,
  ...SIGNATURE_LINES.signed,
  ...SIGNATURE_LINES.notKeyLine,
  ...FULL_WIDTH_LINES.blankSignature,
  ...FULL_WIDTH_LINES.signedSignature,
  ...UNICODE_SPACE_LINES.blankSignature,
  ...UNICODE_SPACE_LINES.signedSignature,
  ...UNICODE_SPACE_LINES.brokenMarker,
  null,
  'Technical Review Approved:',
  'Technical Review Approved: _',
  'Technical Review Approved: <签名> 2026-10-30',
  'Technical Review Approved: ＜签名＞',
  'Technical Review Approved: __________ 签署人：张三',
  'Technical Review Approved: 签署人：张三',
  '- **Technical Review Approved:** 张三 2026-10-30',
  'Technical Review Approved: 张三 Technical\u00A0Review Approved: __________',
]

/** 一致性测试运行 hook 的 locale：C locale 下 grep 与 tr 只把 ASCII 空白当作空白，hook 曾只在 C locale 下与 facts 判定相反（STD-07）。 */
const HOOK_LOCALES = ['C', 'zh_CN.UTF-8']

/** 在 locale 下用 apply 前的签字 hook 判定 demo 变更（hook 以项目根为 cwd）：返回 true 表示放行。 */
function hookAllows(f, locale) {
  const result = spawnSync('/bin/bash', [approvalHook], {
    cwd: f.repo,
    env: { ...process.env, CLAUDE_PROJECT_DIR: f.repo, LC_ALL: locale },
    input: JSON.stringify({ tool_input: { command: 'openspec apply demo' } }),
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim() === ''
}

test('facts：签字行判定与 apply 前的签字 hook 一致，hook 放行的样本为 signed，拦截的样本为 blank 或 missing', t => {
  const f = fixture(t)
  const outcomes = SIGNATURE_SAMPLES.flatMap(sample => {
    writeSummary(f, ...(sample === null ? [] : [sample]))
    const approval = factsOf(f).technicalReview.approval
    if (SIGNATURE_LINES.notKeyLine.includes(sample)) assert.equal(approval, 'missing', sample)
    return HOOK_LOCALES.map(locale => {
      const allowed = hookAllows(f, locale)
      const label = `${locale}: ${JSON.stringify(sample)}`
      if (allowed) assert.equal(approval, 'signed', label)
      else assert.ok(['blank', 'missing'].includes(approval), `${label}：hook 拦截，facts 为 ${approval}`)
      return { sample, allowed, approval }
    })
  })
  // 两种结果都要出现，避免 hook 或 facts 对全部样本给出同一结果时测试仍通过。
  assert.deepEqual([...new Set(outcomes.map(item => item.allowed))].sort(), [false, true])
  assert.equal(outcomes.find(item => item.sample === null).approval, 'missing')
})

test('facts：整份汇总的签字与裁决符合共用样本，hook 在两种 locale 下给出相同结论', t => {
  const f = fixture(t)
  // 期望同时来自完整汇总样本，避免 hook 与 facts 以相同方式误读却仍通过一致性检查。
  for (const sample of SUMMARY_SAMPLES) {
    writeSummary(f, ...sample.lines)
    const actual = factsOf(f).technicalReview
    assert.equal(actual.approval, sample.approval, `${sample.name} / approval`)
    assert.equal(actual.gateVerdict, sample.gateVerdict, `${sample.name} / gateVerdict`)
    for (const locale of HOOK_LOCALES) {
      const allowed = hookAllows(f, locale)
      assert.equal(allowed, sample.allowed, `${sample.name} / ${locale}`)
      assert.equal(allowed, actual.approval === 'signed' && actual.gateVerdict !== 'BLOCKED', `${sample.name} / ${locale} / facts`)
    }
  }
})

test('facts：裁决行判定与 apply 前的签字 hook 一致，hook 因 BLOCKED 拦截当且仅当 gateVerdict 为 BLOCKED', t => {
  const f = fixture(t)
  const samples = [...VERDICT_LINES.blocked.map(line => [line, true]), ...VERDICT_LINES.notBlocked.map(line => [line, false])]
  for (const [line, blocked] of samples) {
    // 签字行已签：hook 拦截只能来自裁决行。期望结论取自样本分组，不由任何一份实现推算。
    writeSummary(f, line, SIGNATURE_LINES.signed[0])
    for (const locale of HOOK_LOCALES) assert.equal(hookAllows(f, locale), !blocked, `hook ${locale}：${JSON.stringify(line)}`)
    assert.equal(factsOf(f).technicalReview.gateVerdict === 'BLOCKED', blocked, `facts：${JSON.stringify(line)}`)
  }
})

// ---------------------------------------------------------------------------
// add-verify-verdict Slice 01：门禁按 verify 结论阻断归档，旧报告不阻断（Seam：implementation-gate.mjs archive、facts）
// ---------------------------------------------------------------------------

/** verify 结论阻断项的前缀（add-verify-verdict design D3）。 */
const VERDICT_PREFIX = 'verify 报告：'

/** 旧报告写入 archive.notes 的说明（design D4）。 */
const LEGACY_VERDICT_NOTE = 'verify 报告没有结论字段（旧格式）：CRITICAL 由 /opsx:archive 读取报告确认'

/**
 * 双轴评审 PASSED、切片证据新鲜的已完成变更，再写一份带 verdictLines 的 verify 报告。
 * verdictLines 为 null 时不写报告。报告指纹默认为当前指纹，reportFingerprint 可改写。
 */
function verdictChange(t, verdictLines, reportFingerprint) {
  const f = fixture(t)
  const fingerprint = completedChange(f)
  writeReview(f, f.run('baseline', f.changeRoot).out)
  if (verdictLines !== null) writeVerification(f, reportFingerprint || fingerprint, verdictLines)
  return f
}

const verdictBlockersOf = report => report.blockers.filter(item => item.startsWith(VERDICT_PREFIX))

test('verify 结论：FAIL 与 Critical-Count 2 时 archive 退出码 1，两条阻断项以「verify 报告：」开头；facts 退出码 0、阻断项相同', t => {
  const f = verdictChange(t, ['- Verify-Verdict: FAIL', '- Critical-Count: 2'])
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 1, result.out)
  const archive = result.json()
  // 期望值取自 design D3 的阻断项表；切片证据与双轴评审没有阻断项，blockers 只有这两条。
  assert.deepEqual(archive.blockers, ['verify 报告：Verify-Verdict 为 FAIL', 'verify 报告：Critical-Count 为 2'])
  assert.equal(archive.ok, false)
  const facts = factsOf(f)
  delete archive.command
  delete archive.change
  assert.deepEqual(facts.archive, archive)
})

test('verify 结论：PASS 与 Critical-Count 0 时没有「verify 报告：」阻断项，也没有旧报告说明', t => {
  const f = verdictChange(t, ['- Verify-Verdict: PASS', '- Critical-Count: 0'])
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(verdictBlockersOf(result.json()), [])
  assert.ok(!result.json().notes.includes(LEGACY_VERDICT_NOTE), JSON.stringify(result.json().notes))
})

test('verify 结论：PASS 与 Critical-Count 1 时只有一条写出条数 1 的阻断项', t => {
  const f = verdictChange(t, ['- Verify-Verdict: PASS', '- Critical-Count: 1'])
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 1, result.out)
  assert.deepEqual(verdictBlockersOf(result.json()), ['verify 报告：Critical-Count 为 1'])
})

test('verify 结论：字段用加粗与全角冒号时也能读出', t => {
  const f = verdictChange(t, ['- **Verify-Verdict**：FAIL', '- **Critical-Count**：0'])
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 1, result.out)
  assert.deepEqual(verdictBlockersOf(result.json()), ['verify 报告：Verify-Verdict 为 FAIL'])
})

test('verify 结论：取值无法识别时阻断并写出读到的值；结论取第一个 ASCII 词，条数取开头的整数', t => {
  // 期望值取自 spec「The archive command SHALL block on the verify verdict」与 design D3：只接受 PASS、FAIL，大小写不同也无法识别。
  for (const [lines, expected] of [
    [['- Verify-Verdict: 通过', '- Critical-Count: 0'], ['verify 报告：Verify-Verdict 缺失或无法识别（通过）']],
    [['- Verify-Verdict: pass', '- Critical-Count: 0'], ['verify 报告：Verify-Verdict 缺失或无法识别（pass）']],
    [['- Verify-Verdict:', '- Critical-Count: 0'], ['verify 报告：Verify-Verdict 缺失或无法识别（空）']],
    [['- Verify-Verdict: PASS', '- Critical-Count: 无'], ['verify 报告：Critical-Count 缺失或无法识别（无）']],
    [['- Verify-Verdict: `PASS`（全部检查通过）', '- Critical-Count: 0 条'], []],
    [['- Verify-Verdict: FAIL（评审条件 C2 未闭环）', '- Critical-Count: `3`'],
      ['verify 报告：Verify-Verdict 为 FAIL', 'verify 报告：Critical-Count 为 3']],
  ]) {
    const f = verdictChange(t, lines)
    assert.deepEqual(verdictBlockersOf(f.run('archive', f.changeRoot).json()), expected, lines.join(' / '))
  }
})

test('verify 结论：只有一个结论字段时按新格式校验，缺少的字段记一条阻断项', t => {
  for (const [lines, expected] of [
    [['- Verify-Verdict: PASS'], ['verify 报告：Critical-Count 缺失或无法识别（没有该行）']],
    [['- Critical-Count: 0'], ['verify 报告：Verify-Verdict 缺失或无法识别（没有该行）']],
  ]) {
    const f = verdictChange(t, lines)
    const result = f.run('archive', f.changeRoot)
    assert.equal(result.code, 1, result.out)
    assert.deepEqual(verdictBlockersOf(result.json()), expected, lines.join(' / '))
    assert.ok(!result.json().notes.includes(LEGACY_VERDICT_NOTE), '有一个结论字段时不是旧报告')
  }
})

test('verify 结论：门禁不比较报告指纹，旧代码上的 FAIL 仍阻断', t => {
  const f = verdictChange(t, ['- Verify-Verdict: FAIL', '- Critical-Count: 1'], `git-tree:${'0'.repeat(40)}`)
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 1, result.out)
  assert.deepEqual(verdictBlockersOf(result.json()), ['verify 报告：Verify-Verdict 为 FAIL', 'verify 报告：Critical-Count 为 1'])
})

test('verify 结论：没有结论字段的旧报告列出 CRITICAL 也不阻断，notes 写出旧报告说明', t => {
  const f = verdictChange(t, ['', '## Issues', '', '### CRITICAL', '', '1. 任务 1.2 未完成'])
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(verdictBlockersOf(result.json()), [])
  assert.ok(result.json().notes.includes(LEGACY_VERDICT_NOTE), JSON.stringify(result.json().notes))
})

test('verify 结论：没有 verification.md 时没有「verify 报告：」阻断项，也没有旧报告说明', t => {
  const f = verdictChange(t, null)
  const result = f.run('archive', f.changeRoot)
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(verdictBlockersOf(result.json()), [])
  assert.ok(!result.json().notes.includes(LEGACY_VERDICT_NOTE), JSON.stringify(result.json().notes))
})

test('facts：verification 输出 verify 报告的 verdict、criticalCount 与 legacy', t => {
  const f = fixture(t)
  const current = fingerprintOf(f)
  const verdictOf = () => {
    const { verdict, criticalCount, legacy } = factsOf(f).verification
    return { verdict, criticalCount, legacy }
  }
  // 期望值取自 spec change-progress-facts「The facts command SHALL report the verdict fields of the verify report」的 3 个场景。
  writeVerification(f, current, ['- Verify-Verdict: FAIL', '- Critical-Count: 2'])
  assert.deepEqual(verdictOf(), { verdict: 'FAIL', criticalCount: 2, legacy: false })
  writeVerification(f, current)
  assert.deepEqual(verdictOf(), LEGACY_VERDICT)
  rmSync(join(f.changeRoot, 'verification.md'))
  assert.deepEqual(verdictOf(), NO_REPORT_VERDICT)
  // 无法识别或缺少一行时为 null，legacy 仍为 false。
  writeVerification(f, current, ['- Verify-Verdict: 通过'])
  assert.deepEqual(verdictOf(), { verdict: null, criticalCount: null, legacy: false })
})

// ---------------------------------------------------------------------------
// add-autopilot-loop Slice 10：裁决已通过后实现又有变化（Seam：implementation-gate.mjs facts，评审 ARCH-12）
// ---------------------------------------------------------------------------

test('facts：评审后源文件有修改时 archive.review.stale 为 true，archive.warnings 有评审后实现有变化的提醒', t => {
  // spec change-progress-facts「Review is stale after a code change」。
  const f = fixture(t)
  writeReview(f, f.run('baseline', f.changeRoot).out)
  assert.equal(factsOf(f).archive.review.stale, false, '评审基线就是当前实现时不陈旧')
  f.write('src/order.js', 'export const create = () => 5\n')
  const facts = factsOf(f)
  assert.equal(facts.archive.review.stale, true)
  assert.ok(facts.archive.warnings.some(item => item.includes('评审后实现有变化')), JSON.stringify(facts.archive.warnings))
  assert.equal(f.run('archive', f.changeRoot).json().review.stale, true, 'archive 子命令输出同一个 stale')
})

test('facts：评审后只有注释修改时 archive.review.stale 为 false', t => {
  // spec change-progress-facts「Review is not stale after a comment change」。
  const f = fixture(t)
  f.write('src/Order.java', JAVA_ORDER)
  writeReview(f, f.run('baseline', f.changeRoot).out)
  f.write('src/Order.java', javaCommentEdit(JAVA_ORDER))
  const facts = factsOf(f)
  assert.equal(facts.archive.review.stale, false)
  assert.ok(!facts.archive.warnings.some(item => item.includes('评审后实现有变化')), JSON.stringify(facts.archive.warnings))
})
