import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

/** 生成一行 finding；位置默认可定位到 `文件:行号`。 */
const finding = (id, severity, { location = 'src/order.js:1', status = 'open' } = {}) =>
  `| ${id} | ${severity} | 创建订单 | ${location} | order.create | 白话说明 | 可复现场景 | 具体后果 | 具体修复 | ${status} |`

const isOpenBlocker = row => / Blocker \|/.test(row) && /\| open \|$/.test(row)

/** 按规则骨架写一份原始报告；结论默认由是否有未闭环 Blocker 推出。 */
function axisReport(title, baseline, rows, verdict) {
  const computed = rows.some(isOpenBlocker) ? '打回' : '通过'
  return [`# ${title}（demo）`, '', baseline.trim(), '', '## Findings', '', FINDING_HEADER,
    ...(rows.length ? rows : ['| 无 | | | | | | | | | |']), '', '## 结论', '', `${title} 结论：${verdict || computed}`, ''].join('\n')
}

/** 写入双轴原始报告与汇总；options 可覆盖某一份的基线、结论或跳过某份文件。 */
function writeReview(f, baseline, { standards = [], spec = [], declared, skip = [], baselines = {} } = {}) {
  const blocked = [...standards, ...spec].some(isOpenBlocker)
  const files = {
    'review/standards.md': axisReport('Standards Review', baselines.standards || baseline, standards),
    'review/spec-fidelity.md': axisReport('Spec Fidelity Review', baselines.spec || baseline, spec),
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
function evidence(id, fingerprint, { omit = [], result = 'PASS', commandResult = 'PASS', exemptions = [] } = {}) {
  const fields = { Slice: id, Behavior: `行为 ${id}`, Seam: 'POST /orders', 'Recorded At': '2026-09-30T10:00:00Z',
    Fingerprint: fingerprint, 'Fingerprint Source': 'node implementation-gate.mjs fingerprint', Result: result }
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
