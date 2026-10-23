import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
  const run = (...args) => {
    const result = spawnSync(process.execPath, [gate, ...args], { cwd: repo, encoding: 'utf8' })
    return { code: result.status, out: result.stdout, err: result.stderr, json: () => JSON.parse(result.stdout) }
  }
  return { repo, changeRoot, write, git, run }
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
// Slice 01：双轴独立 Review 报告（Seam：/opsx:quality → baseline / review 校验）
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
    'review/standards.md', 'review-summary.md', 'evidence/slice-01.md', 'evidence/attachments/write-scan.txt',
    'overview.md', 'discussion-log.md', 'video/storyboard.md']
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

test('hygiene：变更目录不存在时退出码 2', t => {
  const f = fixture(t)
  assert.equal(f.run('hygiene', join(f.repo, 'openspec/changes/missing')).code, 2)
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
