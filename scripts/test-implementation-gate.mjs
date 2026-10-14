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
function writeReview(f, baseline, { standards = [], spec = [], declared, skip = [], baselines = {}, ledgers = {} } = {}) {
  const blocked = [...standards, ...spec].some(isOpenBlocker)
  const files = {
    'review/standards.md': axisReport('Standards Review', baselines.standards || baseline, standards, undefined,
      ledgers.standards === undefined ? ledgerFrom(standards) : ledgers.standards),
    'review/spec-fidelity.md': axisReport('Spec Fidelity Review', baselines.spec || baseline, spec, undefined,
      ledgers.spec === undefined ? ledgerFrom(spec) : ledgers.spec),
    'review/code-review-summary.md': ['# 实现后双轴评审汇总（demo）', '', (baselines.summary || baseline).trim(), '',
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

/** 按切片格式写 tasks.md；evidence=false 表示该切片不声明 Evidence 引用。 */
function writeTasks(f, slices) {
  const text = slices.map(slice => [
    `## Slice ${slice.id}: 行为 ${slice.id}`, 'Blocked by: 无（可立即开始）', 'Seam: POST /orders',
    ...(slice.evidence === false ? [] : [`Evidence: ${slice.evidence || `evidence/slice-${slice.id}.md`}`]), '',
    ...slice.done.map((checked, i) => `- [${checked ? 'x' : ' '}] ${slice.id}.${i + 1} 任务 ${i + 1}`), '',
  ].join('\n')).join('\n')
  f.write('openspec/changes/demo/tasks.md', text)
}

/** 按 slice-evidence.md 模板生成证据；omit 可去掉字段或整段，exemptions 为豁免记录行。 */
function evidence(id, fingerprint, { omit = [], result = 'PASS', commandResult = 'PASS', exemptions = [], extra = {} } = {}) {
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

test('评审后实现有变化（门禁外提交）时提示先登记任务再重跑', t => {
  const f = fixture(t)
  writeReview(f, f.run('baseline', f.changeRoot).out)
  f.write('src/order.js', 'export const create = () => 5\n')
  const warnings = f.run('review', f.changeRoot).json().warnings
  assert.ok(warnings.some(item => item.includes('tasks.md') && item.includes('登记')), JSON.stringify(warnings))
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
