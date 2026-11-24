import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { snapshot } from './lib/fs-snapshot.mjs'

/**
 * 进度视图的命令行测试（add-change-progress-view Slice 02，Seam：progress.mjs [--json]）。
 * 每个用例在临时 git 仓库中创建 openspec/changes/，调用真实的 openspec CLI 与门禁脚本 facts 子命令，不连接远端。
 * 找不到 openspec CLI 时测试失败并写出原因，不跳过（design 风险 R3）。
 */
const progress = fileURLToPath(new URL('../skills/openspec-change-progress/scripts/progress.mjs', import.meta.url))
const gate = fileURLToPath(new URL('../skills/openspec-technical-review/scripts/implementation-gate.mjs', import.meta.url))
/** 本仓的 skill 目录：用例在临时托管配置中登记它，进度视图才认可本仓的门禁（add-change-pause design D2，评审 SEC-12）。 */
const repoSkills = fileURLToPath(new URL('../skills/', import.meta.url))
/** 门禁在可信安装根下的约定位置。 */
const GATE_RELATIVE = 'openspec-technical-review/scripts/implementation-gate.mjs'

/** openspec CLI 每次运行都等待使用统计上报完成，断网时会卡住，因此关闭。 */
const CLI_ENV = { ...process.env, OPENSPEC_TELEMETRY: '0' }

/** 确认本机能运行 openspec CLI；不能运行时让用例失败并写出原因。 */
function requireOpenspec() {
  const result = spawnSync('openspec', ['--version'], { encoding: 'utf8', env: CLI_ENV, timeout: 60000 })
  assert.ok(!result.error && result.status === 0,
    `找不到可运行的 openspec CLI（${result.error ? result.error.message : result.stderr}）：进度视图的测试调用真实的 openspec CLI，请先安装`)
}

/**
 * 创建带一次提交的临时 git 仓库；openspec 为 false 时不创建 openspec/ 目录。
 * 同时创建临时托管目录与临时可信根：配置登记本仓 skill 目录和临时可信根，门禁替身写在临时可信根中，不在项目检出中。
 */
function project({ openspec = true } = {}) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'progress-view-')))
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'progress-home-')))
  const trusted = realpathSync(mkdtempSync(join(tmpdir(), 'progress-trusted-')))
  const configure = fields => writeFileSync(join(home, 'config.json'), JSON.stringify(fields))
  configure({ trustedSkillRoots: [repoSkills, trusted] })
  const baseEnv = { ...CLI_ENV, OPENSPEC_AUTOPILOT_HOME: home }
  const write = (rel, text) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true })
    writeFileSync(join(repo, rel), text)
  }
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=gate', '-c', 'user.email=gate@example.com',
      '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  write('src/order.js', 'export const create = () => 1\n')
  if (openspec) mkdirSync(join(repo, 'openspec/changes/archive'), { recursive: true })
  git('add', '-A')
  git('commit', '-qm', 'init')
  const runScript = (script, args = [], env = {}, cwd = repo) => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...baseEnv, ...env }, timeout: 300000 })
    return { code: result.status, out: result.stdout, err: result.stderr, json: () => JSON.parse(result.stdout) }
  }
  const run = (args = [], env = {}) => runScript(progress, args, env)
  const fingerprint = () => {
    const result = spawnSync(process.execPath, [gate, 'fingerprint', join(repo, 'openspec/changes/archive')], { cwd: repo, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const cleanup = () => { for (const dir of [repo, home, trusted]) rmSync(dir, { recursive: true, force: true }) }
  return { repo, home, trusted, configure, write, git, run, runScript, fingerprint, cleanup }
}

/** 运行 --json 并解析；退出码不是 0 时直接失败。 */
function viewOf(p, args = []) {
  const result = p.run(['--json', ...args])
  assert.equal(result.code, 0, result.err)
  return result.json()
}

/** 按 slice-evidence.md 模板写 Slice 01 的证据，fingerprint 为证据绑定的实现指纹。 */
const evidence = fingerprint => [
  '# Slice 01 新鲜证据', '', '- Slice: 01', '- Behavior: 行为 01', '- Seam: POST /orders', '- Recorded At: 2026-10-30T10:00:00Z',
  `- Fingerprint: ${fingerprint}`, '- Fingerprint Source: node implementation-gate.mjs fingerprint', '- Result: PASS', '',
  '## 变更文件', '- src/order.js', '', '## 验证命令', '| 命令 | 结果 | 摘要 |', '|------|------|------|', '| `node --test` | PASS | 3 tests |', '',
  '## 覆盖的验收行为', '- Scenario: 创建订单成功 → order.test.createsOrder', '', '## 剩余风险', '- 无', '',
  '## 豁免记录', '| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |',
  '|------------------|----------------|---------|--------------------|-------|------|', '',
].join('\n')

/**
 * 写一个规划产物齐全的变更。tasks 为每个任务的勾选状态；slice 为 true 时任务写在 Slice 01 下并声明 Evidence；
 * tier 写入 overview.md 分级行；files 为变更目录下的其他文件（相对路径 → 内容）；base 为项目根相对仓库的前缀。
 */
function change(p, name, { tasks = [false], tier = null, slice = false, openQuestions = ['无。'], files = {}, base = '' } = {}) {
  const root = `${base}openspec/changes/${name}`
  p.write(`${root}/proposal.md`, '## Why\n\n测试用变更。\n\n## What Changes\n\n- 测试\n')
  p.write(`${root}/design.md`, ['## Context', '', '- 测试', '', '## Open Questions', '', ...openQuestions, ''].join('\n'))
  p.write(`${root}/specs/demo/spec.md`,
    '## ADDED Requirements\n\n### Requirement: Demo\n\nThe system SHALL work.\n\n#### Scenario: Works\n- **WHEN** x\n- **THEN** y\n')
  const lines = tasks.map((done, i) => `- [${done ? 'x' : ' '}] 1.${i + 1} 任务 ${i + 1}`)
  p.write(`${root}/tasks.md`, slice
    ? ['## Slice 01: 行为 01', 'Blocked by: 无（可立即开始）', 'Seam: POST /orders', 'Evidence: evidence/slice-01.md', '', ...lines, ''].join('\n')
    : ['# 实施任务', '', ...lines, ''].join('\n'))
  if (tier) p.write(`${root}/overview.md`, `> 分级：${tier} ｜ 判定人：tigger ｜ 日期：2026-10-30 ｜ 依据：测试\n`)
  for (const [rel, text] of Object.entries(files)) p.write(`${root}/${rel}`, text)
}

const summary = (...lines) => ['# 技术评审汇总', '', ...lines, ''].join('\n')

// ---------------------------------------------------------------------------
// R1–R11 推导：一个项目中每条规则一个变更，只运行一次视图。R10 用 verify 报告的结论字段构造（add-verify-verdict）；
// 门禁以后新增的其他阻断项，由后面「R10：…」用例用假门禁单独覆盖。
// ---------------------------------------------------------------------------

let rules
let view
let changesBefore
let gitBefore

before(() => {
  requireOpenspec()
  rules = project()
  const p = rules
  const all = n => Array(n).fill(true)
  p.write('openspec/changes/r1-planning/proposal.md', '## Why\n\n只有提案。\n')
  change(p, 'r2-new', { tasks: [false, false] })
  change(p, 'r3-blocked', { tier: 'L2', files: { 'review-summary.md': summary('Gate-Verdict: BLOCKED', 'Technical Review Approved: tigger 2026-10-30') } })
  change(p, 'r4-legacy', { tier: 'L2', files: { 'review-summary.md': summary('- 裁决：READY_FOR_HUMAN_APPROVAL', 'Technical Review Approved: tigger 2026-10-30') } })
  change(p, 'r4-unreadable', { tier: 'L2', files: { 'review-summary.md': summary('Gate-Verdict: 待定', 'Technical Review Approved: tigger 2026-10-30') } })
  change(p, 'r5-approval', { tier: 'MVP', files: { 'review-summary.md': summary('Gate-Verdict: READY_FOR_HUMAN_APPROVAL', 'Technical Review Approved: __________') } })
  change(p, 'r6-l0', { tier: 'L0', tasks: [true, false, false] })
  change(p, 'r6-historical', { tasks: [...all(64), ...Array(45).fill(false)] })
  change(p, 'oq-none', { tier: 'L0', tasks: [true, false] })
  change(p, 'oq-two', { tier: 'L0', tasks: [true, false], openQuestions: ['### Q1：入口放在哪里', '', '建议：两步说明', '', '### Q2：是否拆分', '', '- 选项 A', ''] })
  // 证据与 verify 报告绑定的指纹：stale 是修改源文件之前的指纹，current 是修改之后的指纹。
  const stale = p.fingerprint()
  p.write('src/order.js', 'export const create = () => 2\n')
  const current = p.fingerprint()
  change(p, 'r7-stale', { tier: 'L0', slice: true, tasks: all(2), files: { 'evidence/slice-01.md': evidence(stale) } })
  change(p, 'r8-quality', { tier: 'MVP', slice: true, tasks: all(2), files: { 'evidence/slice-01.md': evidence(current) } })
  change(p, 'r9-verify', { tier: 'L0', slice: true, tasks: all(2),
    files: { 'evidence/slice-01.md': evidence(current), 'verification.md': `# Verify 报告\n\n- Fingerprint: ${stale}\n` } })
  // 指纹后接说明文字时值不是合法指纹（facts 按没有指纹处理），卡点要说清原因，不能写成「没有 Fingerprint 行」。
  change(p, 'r9-note', { tier: 'L0', slice: true, tasks: all(2),
    files: { 'evidence/slice-01.md': evidence(current), 'verification.md': `# Verify 报告\n\n- Fingerprint: ${current} （终点指纹）\n` } })
  change(p, 'r11-archive', { tier: 'L0', slice: true, tasks: all(2),
    files: { 'evidence/slice-01.md': evidence(current), 'verification.md': `# Verify 报告\n\n- Fingerprint: ${current}\n` } })
  // verify 报告写有结论字段（add-verify-verdict design D6）：FAIL 时门禁 archive 有阻断项，R10 命中；PASS 时 R11 直接归档。
  const verdictReport = (verdict, count) =>
    `# Verify 报告\n\n- Fingerprint: ${current}\n- Verify-Verdict: ${verdict}\n- Critical-Count: ${count}\n`
  change(p, 'r10-verdict', { tier: 'L0', slice: true, tasks: all(2),
    files: { 'evidence/slice-01.md': evidence(current), 'verification.md': verdictReport('FAIL', 2) } })
  change(p, 'r11-verdict', { tier: 'L0', slice: true, tasks: all(2),
    files: { 'evidence/slice-01.md': evidence(current), 'verification.md': verdictReport('PASS', 0) } })
  // 已归档变更的证据已过期：视图只列名称与日期，不运行门禁。
  p.write('openspec/changes/archive/2026-10-28-old-change/tasks.md', '## Slice 01: 行为 01\nEvidence: evidence/slice-01.md\n\n- [x] 1.1 任务 1\n')
  p.write('openspec/changes/archive/2026-10-28-old-change/evidence/slice-01.md', evidence(stale))
  p.write('openspec/changes/archive/legacy-dir/proposal.md', '## Why\n\n旧目录。\n')
  changesBefore = snapshot(join(p.repo, 'openspec'))
  gitBefore = [p.git('rev-parse', 'HEAD'), p.git('status', '--porcelain'), p.git('show-ref')]
  view = viewOf(p)
})

after(() => rules && rules.cleanup())

const entry = name => {
  const found = view.active.find(item => item.change === name)
  assert.ok(found, `active 中没有 ${name}：${JSON.stringify(view.active.map(item => item.change))}`)
  return found
}

test('视图为每个活跃变更输出一个条目，字段齐全，不写变更目录，不改 git 的提交、索引与工作区', () => {
  assert.equal(view.root, rules.repo)
  assert.equal(view.active.length, 17)
  for (const item of view.active) {
    assert.deepEqual(Object.keys(item).sort(),
      ['blockers', 'change', 'changeDirectory', 'changeState', 'error', 'next', 'notes', 'openQuestions', 'reviewStale', 'rule', 'stage',
        'tasks', 'tier', 'warnings'],
      item.change)
    assert.equal(item.error, null, `${item.change}：${item.error}`)
    // 没有状态文件的变更按继续推进读取，目录身份来自门禁（add-change-pause design D4）。
    assert.equal(item.changeState.state, 'enabled', item.change)
    assert.equal(item.changeDirectory.path, join(rules.repo, 'openspec/changes', item.change))
  }
  assert.equal(view.changeStateVersion, 1)
  assert.deepEqual(entry('r6-l0').tasks, { done: 1, total: 3 })
  assert.deepEqual(snapshot(join(rules.repo, 'openspec')), changesBefore)
  assert.deepEqual([rules.git('rev-parse', 'HEAD'), rules.git('status', '--porcelain'), rules.git('show-ref')], gitBefore)
})

test('R1：规划产物不齐全时阶段为 propose，下一步以 /opsx:propose 开头，卡点写出缺少的产物', () => {
  const item = entry('r1-planning')
  assert.equal(item.stage, 'propose')
  assert.equal(item.rule, 'R1')
  assert.ok(item.next.startsWith('/opsx:propose r1-planning'), item.next)
  assert.ok(item.blockers.some(text => text.includes('tasks')), JSON.stringify(item.blockers))
})

test('R2：规划产物齐全、没有分级行、没有评审汇总、没有勾选任务时阶段为 review', () => {
  const item = entry('r2-new')
  assert.equal(item.stage, 'review')
  assert.equal(item.rule, 'R2')
  assert.equal(item.next, '/opsx:review r2-new')
})

test('R6：L0 变更不要求编码前评审，勾选 1/3 时阶段为 apply', () => {
  const item = entry('r6-l0')
  assert.equal(item.tier, 'L0')
  assert.equal(item.stage, 'apply')
  assert.equal(item.rule, 'R6')
  assert.equal(item.next, '/opsx:apply r6-l0')
  assert.ok(item.blockers.some(text => text.includes('1/3')), JSON.stringify(item.blockers))
})

test('R6：没有分级行、已勾选 64/109 的历史变更跳过 R2，notes 写明按历史变更处理', () => {
  const item = entry('r6-historical')
  assert.equal(item.tier, null)
  assert.equal(item.stage, 'apply')
  assert.equal(item.rule, 'R6')
  assert.deepEqual(item.tasks, { done: 64, total: 109 })
  assert.ok(item.notes.some(text => text.includes('没有分级行') && text.includes('历史变更')), JSON.stringify(item.notes))
})

test('R3：Gate-Verdict: BLOCKED 时即使已签字阶段也为 review，下一步先 update 再 review', () => {
  const item = entry('r3-blocked')
  assert.equal(item.stage, 'review')
  assert.equal(item.rule, 'R3')
  assert.ok(item.next.includes('/opsx:update r3-blocked') && item.next.includes('/opsx:review r3-blocked'), item.next)
})

test('R4：评审汇总没有 Gate-Verdict 行，或裁决值读不出 ASCII 词时，阶段为 review，下一步为人工核对', () => {
  for (const name of ['r4-legacy', 'r4-unreadable']) {
    const item = entry(name)
    assert.equal(item.stage, 'review', name)
    assert.equal(item.rule, 'R4', name)
    // 卡点文字取自 design.md D3 的 R4 行。
    assert.deepEqual(item.blockers, ['没有 Gate-Verdict 行（旧格式），或裁决值无法识别'], name)
    assert.ok(item.next.includes('review-summary.md'), item.next)
  }
})

test('R5：裁决为 READY_FOR_HUMAN_APPROVAL、签字行为下划线占位时阶段为 approval', () => {
  const item = entry('r5-approval')
  assert.equal(item.stage, 'approval')
  assert.equal(item.rule, 'R5')
  assert.ok(item.next.includes('签字'), item.next)
})

test('R7：任务全部勾选、切片证据指纹不是当前指纹时阶段为 apply，卡点为证据问题', () => {
  const item = entry('r7-stale')
  assert.equal(item.stage, 'apply')
  assert.equal(item.rule, 'R7')
  assert.ok(item.blockers.some(text => text.includes('Slice 01')), JSON.stringify(item.blockers))
  assert.ok(item.next.startsWith('/opsx:apply r7-stale'), item.next)
})

test('R8：MVP 变更任务全部勾选、证据新鲜、没有双轴评审汇总时阶段为 quality', () => {
  const item = entry('r8-quality')
  assert.equal(item.stage, 'quality')
  assert.equal(item.rule, 'R8')
  assert.equal(item.next, '/opsx:quality r8-quality')
  assert.ok(item.blockers.length > 0, '卡点应写出双轴评审问题')
})

test('R9：之前的规则都不命中、verify 报告指纹不是当前指纹时阶段为 verify', () => {
  const item = entry('r9-verify')
  assert.equal(item.stage, 'verify')
  assert.equal(item.rule, 'R9')
  assert.equal(item.next, '/opsx:verify r9-verify')
})

test('R9：verify 报告有 Fingerprint 行但值不是合法指纹时，卡点写没有合法的 Fingerprint', () => {
  const item = entry('r9-note')
  assert.equal(item.stage, 'verify')
  assert.equal(item.rule, 'R9')
  // 卡点文字取自 design.md D3 的 R9 行。
  assert.deepEqual(item.blockers, ['verify 报告没有合法的 Fingerprint（没有该行，或值不是 git-tree 指纹）'])
})

test('R10：verify 报告的结论为 FAIL 时阶段为 verify，卡点为「verify 报告：」开头的阻断项', () => {
  const item = entry('r10-verdict')
  assert.equal(item.stage, 'verify')
  assert.equal(item.rule, 'R10')
  // 卡点文字取自 add-verify-verdict design D3 的阻断项表。
  assert.deepEqual(item.blockers, ['verify 报告：Verify-Verdict 为 FAIL', 'verify 报告：Critical-Count 为 2'])
  assert.equal(item.next, '处理卡点后 /opsx:verify r10-verdict')
})

test('R11：verify 报告的结论为 PASS、Critical-Count 为 0 时下一步为 /opsx:archive <name>', () => {
  const item = entry('r11-verdict')
  assert.equal(item.stage, 'archive')
  assert.equal(item.rule, 'R11')
  assert.equal(item.next, '/opsx:archive r11-verdict')
  assert.deepEqual(item.blockers, [])
})

test('R11：没有结论字段的旧 verify 报告、archive 检查通过时阶段为 archive，下一步要求先确认没有 CRITICAL', () => {
  const item = entry('r11-archive')
  assert.equal(item.stage, 'archive')
  assert.equal(item.rule, 'R11')
  assert.ok(item.next.includes('CRITICAL') && item.next.indexOf('CRITICAL') < item.next.indexOf('/opsx:archive r11-archive'), item.next)
  assert.deepEqual(item.blockers, [])
})

test('Open Questions 的待决定条数只展示，不改变阶段、规则与下一步', () => {
  const none = entry('oq-none')
  const two = entry('oq-two')
  assert.deepEqual(none.openQuestions, { pending: 0, total: 0 })
  assert.deepEqual(two.openQuestions, { pending: 2, total: 2 })
  const template = item => ({ stage: item.stage, rule: item.rule, next: item.next.replace(item.change, '<name>') })
  assert.deepEqual(template(two), template(none))
})

test('implementing 列出已开始实现的变更：有勾选任务的 apply 阶段与 apply 之后的阶段；apply 之前的阶段不计入', () => {
  assert.deepEqual([...view.implementing].sort(), ['oq-none', 'oq-two', 'r10-verdict', 'r11-archive', 'r11-verdict',
    'r6-historical', 'r6-l0', 'r7-stale', 'r8-quality', 'r9-note', 'r9-verify'])
})

test('已归档变更只列名称与日期，不运行门禁：证据过期也不写卡点；目录名不是日期格式时日期为 null', () => {
  assert.deepEqual(view.archived, [{ name: 'old-change', date: '2026-10-28' }, { name: 'legacy-dir', date: null }])
  assert.ok(!view.active.some(item => item.change.includes('old-change')))
  assert.ok(!JSON.stringify(view.active).includes('old-change'))
})

// ---------------------------------------------------------------------------
// 输出格式、读取失败与环境错误：各用独立项目
// ---------------------------------------------------------------------------

test('两个活跃变更与一个已归档变更时 active 有两个条目', t => {
  const p = project()
  t.after(p.cleanup)
  change(p, 'alpha', { tier: 'L0' })
  change(p, 'beta', { tier: 'L0', tasks: [true] })
  p.write('openspec/changes/archive/2026-10-27-gamma/proposal.md', '## Why\n\n已归档。\n')
  const result = viewOf(p)
  assert.deepEqual(result.active.map(item => item.change).sort(), ['alpha', 'beta'])
  assert.deepEqual(result.archived, [{ name: 'gamma', date: '2026-10-27' }])
  // alpha 是 L0 变更，阶段为 apply 但没有勾选任务，还没开始实现：propose 之后的 L0、MVP 变更可以同时存在。
  assert.deepEqual(result.implementing, ['beta'])
})

test('两个变更已开始实现时，表格在已归档行之前输出提示，写出两个变更名；只有一个时不提示', t => {
  const p = project()
  t.after(p.cleanup)
  change(p, 'alpha', { tier: 'L0', tasks: [true, false] })
  change(p, 'beta', { tier: 'L0', tasks: [true, false] })
  const json = viewOf(p)
  assert.deepEqual(Object.keys(json).sort(), ['active', 'archived', 'changeStateVersion', 'implementing', 'root'])
  assert.deepEqual([...json.implementing].sort(), ['alpha', 'beta'])
  const result = p.run()
  assert.equal(result.code, 0, result.err)
  const lines = result.out.trimEnd().split('\n')
  const hint = lines.find(line => line.startsWith('提示：'))
  assert.ok(hint && hint.includes('alpha') && hint.includes('beta'), result.out)
  assert.ok(lines.indexOf(hint) < lines.length - 1 && lines[lines.length - 1].startsWith('已归档 '), result.out)

  p.write('openspec/changes/beta/tasks.md', '# 实施任务\n\n- [ ] 1.1 任务 1\n- [ ] 1.2 任务 2\n')
  const single = p.run()
  assert.equal(single.code, 0, single.err)
  assert.ok(!single.out.includes('提示：'), single.out)
})

test('不带 --json 时输出表格：变更名、阶段与下一步在同一行，最后一行写已归档变更数与最近一个', t => {
  const p = project()
  t.after(p.cleanup)
  change(p, 'alpha', { tier: 'L0', tasks: [true, false] })
  p.write('openspec/changes/archive/2026-10-26-older/proposal.md', '## Why\n\n已归档。\n')
  p.write('openspec/changes/archive/2026-10-28-newer/proposal.md', '## Why\n\n已归档。\n')
  const result = p.run()
  assert.equal(result.code, 0, result.err)
  const lines = result.out.trimEnd().split('\n')
  assert.ok(lines.some(line => line.includes('alpha') && line.includes('apply') && line.includes('/opsx:apply alpha')), result.out)
  assert.equal(lines[lines.length - 1], '已归档 2 个（最近：2026-10-28 newer）')
})

test('一个变更的 facts 失败时该条目写出原因、阶段为 null，其他变更照常推导，退出码 0', t => {
  const p = project()
  t.after(p.cleanup)
  const head = p.git('rev-parse', 'HEAD')
  change(p, 'broken', { tier: 'L0', files: {} })
  p.write('openspec/changes/broken/tasks.md', ['# 实施任务', '', '- [ ] 1.1 任务 1', '', '## 变更终点', '', `- 提交：${head}`, '- 判定人：', ''].join('\n'))
  change(p, 'healthy', { tier: 'L0' })
  const result = viewOf(p)
  const broken = result.active.find(item => item.change === 'broken')
  const healthy = result.active.find(item => item.change === 'healthy')
  assert.equal(broken.stage, null)
  assert.equal(broken.next, null)
  assert.ok(broken.error && broken.error.includes('变更终点'), broken.error)
  assert.equal(healthy.stage, 'apply')
  assert.equal(healthy.error, null)
})

test('--gate 指向不存在的文件时退出码 2，信息写出该路径；参数不支持时退出码 2', t => {
  const p = project()
  t.after(p.cleanup)
  const missing = join(p.repo, 'missing-gate.mjs')
  const result = p.run(['--gate', missing])
  assert.equal(result.code, 2)
  assert.ok(result.err.includes(missing), result.err)
  assert.equal(p.run(['--unknown']).code, 2)
})

test('门禁脚本的用法文本中没有 facts 时退出码 2，不输出任何条目，提示同步 openspec-technical-review', t => {
  const p = project()
  t.after(p.cleanup)
  change(p, 'alpha', { tier: 'L0' })
  const oldGate = join(p.trusted, GATE_RELATIVE)
  mkdirSync(dirname(oldGate), { recursive: true })
  writeFileSync(oldGate, "process.stderr.write('用法：node implementation-gate.mjs <fingerprint|baseline|review|evidence|archive|hygiene> <changeRoot>\\n')\nprocess.exitCode = 2\n")
  const result = p.run(['--json', '--gate', oldGate])
  assert.equal(result.code, 2)
  assert.equal(result.out, '')
  assert.ok(result.err.includes(oldGate) && result.err.includes('openspec-technical-review'), result.err)
})

/**
 * 写一个只支持 facts 的假门禁：facts 输出固定的 facts，让 R1–R9 都不命中，archive 取 { ok, blockers }。
 * verification 没有 verdict、criticalCount、legacy，与 add-verify-verdict 之前的门禁脚本输出相同。
 * contract 为 false 时不输出变更状态契约，与 add-change-pause 之前的门禁脚本输出相同。
 * @returns {string} 假门禁的路径。
 */
function fakeGate(p, { ok, blockers, review = { applicable: false, verdict: null, issues: [] }, contract = true }) {
  const fingerprint = `git-tree:${'0'.repeat(40)}`
  const facts = {
    tier: 'L0',
    technicalReview: { exists: false, gateVerdict: null, approval: 'missing' },
    verification: { exists: true, fingerprint, current: true, expectedFingerprint: fingerprint },
    openQuestions: { pending: 0, total: 0 },
    currentFingerprint: fingerprint,
    archive: { ok, blockers, warnings: [], notes: [],
      review, evidence: { issues: [] } },
    ...(contract ? { changeStateVersion: 1, changeDirectory: { path: join(p.repo, 'openspec/changes/fake'), dev: '1', ino: '1' },
      changeState: { state: 'enabled', reason: null, updatedAt: null, error: null, digest: null } } : {}),
  }
  const file = join(p.trusted, GATE_RELATIVE)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, [
    "if (process.argv[2] !== 'facts') {",
    "  process.stderr.write('用法：node implementation-gate.mjs <fingerprint|facts> <changeRoot>\\n')",
    '  process.exitCode = 2',
    `} else process.stdout.write(${JSON.stringify(JSON.stringify(facts))})`,
    '',
  ].join('\n'))
  return file
}

test('R10：门禁 archive 有其他阻断项、前面的规则都不命中时阶段为 verify，卡点原样输出 archive.blockers', t => {
  // R10 兜底门禁以后新增的阻断项：用假门禁输出固定的 facts，让 R1–R9 都不命中、只有 archive.ok 为 false，
  // 改动 RULES 的顺序或 R10 的取值时这里会失败。
  const p = project()
  t.after(p.cleanup)
  change(p, 'r10-fallback', { tier: 'L0', tasks: [true] })
  const item = viewOf(p, ['--gate', fakeGate(p, { ok: false, blockers: ['未来阻断项'] })]).active
    .find(found => found.change === 'r10-fallback')
  assert.ok(item, 'active 中没有 r10-fallback')
  assert.equal(item.rule, 'R10')
  assert.equal(item.stage, 'verify')
  assert.deepEqual(item.blockers, ['未来阻断项'])
  assert.ok(item.next.includes('/opsx:verify r10-fallback'), item.next)
})

test('R11：门禁脚本的 facts 没有 legacy 字段时按旧报告处理，下一步仍要求先确认没有 CRITICAL', t => {
  // add-verify-verdict design 风险 R3：已安装副本只同步了进度视图时，旧门禁脚本的 facts 没有 legacy，不能误放行。
  const p = project()
  t.after(p.cleanup)
  change(p, 'r11-old-gate', { tier: 'L0', tasks: [true] })
  const item = viewOf(p, ['--gate', fakeGate(p, { ok: true, blockers: [] })]).active
    .find(found => found.change === 'r11-old-gate')
  assert.ok(item, 'active 中没有 r11-old-gate')
  assert.equal(item.rule, 'R11')
  assert.ok(item.next.includes('CRITICAL') && item.next.indexOf('CRITICAL') < item.next.indexOf('/opsx:archive r11-old-gate'), item.next)
})

// ---------------------------------------------------------------------------
// add-autopilot-loop Slice 10：裁决已通过后实现又有变化时回到 quality（评审 ARCH-12，spec change-progress-view R8）
// ---------------------------------------------------------------------------

const JAVA_ORDER = ['package demo;', '', 'public class Order {', '  // 创建订单', '  int create() { return 1; }', '}', ''].join('\n')

/** 用门禁脚本 baseline 子命令的输出写一组裁决为 PASSED、没有 finding 的双轴评审报告。 */
function passedReview(p, name) {
  const root = join(p.repo, 'openspec/changes', name)
  const result = spawnSync(process.execPath, [gate, 'baseline', root], { cwd: p.repo, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const baseline = result.stdout.trim()
  const ledger = ['## Finding 台账', '', '| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |', '|----|---------|---------|------|---------|---------|', '']
  const axis = title => [`# ${title}（${name}）`, '', baseline, '', '## Findings', '',
    '| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |',
    '|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|', '| 无 | | | | | | | | | |', '',
    ...ledger, '## 结论', '', `${title} 结论：通过`, ''].join('\n')
  p.write(`openspec/changes/${name}/review/standards.md`, axis('Standards Review'))
  p.write(`openspec/changes/${name}/review/spec-fidelity.md`, axis('Spec Fidelity Review'))
  p.write(`openspec/changes/${name}/review/code-review-summary.md`, ['# 实现后双轴评审汇总', '', baseline, '',
    '| 评审轴 | 原始报告 |', '|---|---|', '| Standards Review | review/standards.md |', '| Spec Fidelity Review | review/spec-fidelity.md |', '',
    'Code Review Verdict: PASSED', ''].join('\n'))
}

test('R8：裁决 PASSED 后源文件有修改时回到 quality；只有注释修改时不回到 quality', t => {
  // spec change-progress-view「Code changed after a passed review」「Comment change after a passed review」。
  const p = project()
  t.after(p.cleanup)
  p.write('src/Order.java', JAVA_ORDER)
  change(p, 'code-changed', { tier: 'MVP', slice: true, tasks: [true, true] })
  change(p, 'comment-changed', { tier: 'MVP', slice: true, tasks: [true, true] })
  passedReview(p, 'code-changed')
  p.write('src/order.js', 'export const create = () => 2\n')
  passedReview(p, 'comment-changed')
  p.write('src/Order.java', JAVA_ORDER.replace('// 创建订单', '// 创建一笔订单'))
  const current = p.fingerprint()
  for (const name of ['code-changed', 'comment-changed']) p.write(`openspec/changes/${name}/evidence/slice-01.md`, evidence(current))
  const active = viewOf(p).active
  const code = active.find(item => item.change === 'code-changed')
  assert.equal(code.rule, 'R8', JSON.stringify(code))
  assert.equal(code.stage, 'quality')
  assert.equal(code.reviewStale, true)
  assert.ok(code.next.includes('/opsx:quality code-changed'), code.next)
  const comment = active.find(item => item.change === 'comment-changed')
  assert.notEqual(comment.rule, 'R8', JSON.stringify(comment))
  assert.equal(comment.reviewStale, false)
})

test('R8：门禁的 archive.review 没有 stale 时 reviewStale 为 null，卡点提示同步 openspec-technical-review', t => {
  // spec change-progress-view「Gate without the stale field」：门禁副本早于 Slice 10 时不知道评审是否过期，不放行（评审 ARCH-18）。
  const p = project()
  t.after(p.cleanup)
  change(p, 'old-gate-review', { tier: 'MVP', tasks: [true] })
  const review = { applicable: true, verdict: 'PASSED', issues: [] }
  const item = viewOf(p, ['--gate', fakeGate(p, { ok: true, blockers: [], review })]).active
    .find(found => found.change === 'old-gate-review')
  assert.ok(item, 'active 中没有 old-gate-review')
  assert.equal(item.rule, 'R8')
  assert.equal(item.reviewStale, null)
  assert.ok(item.blockers.some(text => text.includes('openspec-technical-review')), JSON.stringify(item.blockers))
})

test('双轴评审不适用时 reviewStale 为 false', t => {
  const p = project()
  t.after(p.cleanup)
  change(p, 'l0-change', { tier: 'L0', tasks: [true] })
  const item = viewOf(p, ['--gate', fakeGate(p, { ok: true, blockers: [] })]).active.find(found => found.change === 'l0-change')
  assert.equal(item.reviewStale, false)
})

test('找不到项目的 openspec/ 目录时退出码 2', t => {
  const p = project({ openspec: false })
  t.after(p.cleanup)
  const result = p.run(['--json'])
  assert.equal(result.code, 2)
  assert.ok(result.err.includes('openspec/'), result.err)
})

test('openspec CLI 无法运行时退出码 2，信息写出原因', t => {
  const p = project()
  t.after(p.cleanup)
  const empty = mkdtempSync(join(tmpdir(), 'progress-path-'))
  t.after(() => rmSync(empty, { recursive: true, force: true }))
  const result = p.run(['--json'], { PATH: empty })
  assert.equal(result.code, 2)
  assert.ok(result.err.includes('openspec'), result.err)
})

// ---------------------------------------------------------------------------
// add-change-pause 任务 1.4：进度视图传播变更状态，独立查询先核验门禁来源（Seam：progress.mjs [--json]）
// ---------------------------------------------------------------------------

const pausedState = reason => JSON.stringify({ version: 1, state: 'paused', reason, updatedAt: '2026-11-23T08:00:00.000Z' })

test('变更暂缓：暂缓的历史变更保留阶段、任务和 implementing，下一步提示恢复，不提示同时推进', t => {
  const p = project()
  t.after(p.cleanup)
  change(p, 'ddd', { tasks: Array.from({ length: 109 }, (_, i) => i < 64) })
  change(p, 'alpha', { tier: 'L0', tasks: [true, false] })
  p.write('openspec/changes/ddd/change-state.json', pausedState('暂缓|保留\n已有工作'))
  const before = snapshot(join(p.repo, 'openspec'))
  const json = viewOf(p)
  assert.equal(json.changeStateVersion, 1)
  assert.deepEqual([...json.implementing].sort(), ['alpha', 'ddd'])
  const ddd = json.active.find(item => item.change === 'ddd')
  assert.equal(ddd.stage, 'apply')
  assert.equal(ddd.rule, 'R6')
  assert.deepEqual(ddd.tasks, { done: 64, total: 109 })
  assert.deepEqual(ddd.blockers, ['已勾选 64/109'])
  assert.equal(ddd.changeState.state, 'paused')
  assert.equal(ddd.changeState.reason, '暂缓|保留\n已有工作')
  assert.equal(ddd.changeDirectory.path, join(p.repo, 'openspec/changes/ddd'))
  assert.equal(ddd.next, 'node <AUTOPILOT>/autopilot.mjs resume ddd')
  const alpha = json.active.find(item => item.change === 'alpha')
  assert.equal(alpha.changeState.state, 'enabled')
  assert.equal(alpha.next, '/opsx:apply alpha')
  const table = p.run()
  assert.equal(table.code, 0, table.err)
  const lines = table.out.split('\n')
  assert.ok(lines.some(line => line.startsWith('| ddd |') && line.includes('| paused |') && line.includes('autopilot.mjs resume ddd')), table.out)
  assert.ok(table.out.includes('- ddd：暂缓。原因：暂缓\\|保留\\n已有工作；时间：2026-11-23T08:00:00.000Z'), table.out)
  assert.ok(!table.out.includes('提示：'), table.out)
  assert.deepEqual(snapshot(join(p.repo, 'openspec')), before)
})

test('变更暂缓：单个变更的状态损坏时保留阶段并显示状态错误，其他变更照常，退出码 0', t => {
  const p = project()
  t.after(p.cleanup)
  change(p, 'ddd', { tasks: [true, false] })
  change(p, 'alpha', { tier: 'L0' })
  p.write('openspec/changes/ddd/change-state.json', '{')
  const before = snapshot(join(p.repo, 'openspec'))
  const json = viewOf(p)
  assert.equal(json.changeStateVersion, 1)
  const ddd = json.active.find(item => item.change === 'ddd')
  assert.equal(ddd.stage, 'apply')
  assert.equal(ddd.rule, 'R6')
  assert.equal(ddd.changeState.state, 'unknown')
  assert.match(ddd.changeState.error, /change-state\.json/)
  assert.match(ddd.next, /修复变更状态/)
  assert.doesNotMatch(ddd.next, /opsx:apply/)
  assert.equal(json.active.find(item => item.change === 'alpha').changeState.state, 'enabled')
  const table = p.run()
  assert.equal(table.code, 0, table.err)
  assert.ok(table.out.includes('- ddd：状态无法核验。'), table.out)
  assert.deepEqual(snapshot(join(p.repo, 'openspec')), before)
})

test('变更暂缓：未知字段、未知版本、超限与重复成员的状态文件都按未知显示，其他变更照常（任务 3.1）', t => {
  const p = project()
  t.after(p.cleanup)
  change(p, 'ddd', { tasks: [true, false] })
  change(p, 'alpha', { tier: 'L0' })
  const valid = { version: 1, state: 'paused', reason: '保留', updatedAt: '2026-11-23T08:00:00.000Z' }
  for (const [label, text] of [
    ['未知字段', JSON.stringify({ ...valid, extra: true })],
    ['未知版本', JSON.stringify({ ...valid, version: 2 })],
    ['超过 16 KiB', JSON.stringify(valid) + ' '.repeat(16 * 1024)],
    ['原因超过 1,024 字节', JSON.stringify({ ...valid, reason: 'x'.repeat(1025) })],
    ['顶层成员名重复', `${JSON.stringify({ ...valid, state: 'enabled' }).slice(0, -1)},"state":"paused"}`],
  ]) {
    p.write('openspec/changes/ddd/change-state.json', text)
    const json = viewOf(p)
    assert.equal(json.active.length, 2, label)
    const ddd = json.active.find(item => item.change === 'ddd')
    assert.equal(ddd.changeState.state, 'unknown', label)
    assert.equal(ddd.changeState.reason, null, label)
    assert.equal(ddd.stage, 'apply', label)
    assert.equal(ddd.rule, 'R6', label)
    assert.match(ddd.next, /修复变更状态/, label)
    const alpha = json.active.find(item => item.change === 'alpha')
    assert.equal(alpha.changeState.state, 'enabled', label)
    assert.doesNotMatch(alpha.next, /修复变更状态/, label)
  }
})

test('变更暂缓：门禁副本没有状态契约时条目状态未知并提示同步，顶层不声明版本 1', t => {
  const p = project()
  t.after(p.cleanup)
  change(p, 'alpha', { tier: 'L0', tasks: [true] })
  const json = viewOf(p, ['--gate', fakeGate(p, { ok: true, blockers: [], contract: false })])
  assert.equal(json.changeStateVersion, null)
  const item = json.active.find(found => found.change === 'alpha')
  assert.equal(item.changeState.state, 'unknown')
  assert.match(item.changeState.error, /同步 openspec-technical-review/)
  assert.equal(item.changeDirectory, null)
  assert.match(item.next, /同步 openspec-technical-review/)
  assert.equal(item.rule, 'R11')
})

test('变更暂缓：进度脚本与缺省门禁同在未登记的副本中、或门禁位于项目检出中时退出 2，不运行门禁', t => {
  const p = project()
  t.after(p.cleanup)
  change(p, 'alpha', { tier: 'L0' })
  const copy = realpathSync(mkdtempSync(join(tmpdir(), 'progress-copy-')))
  t.after(() => rmSync(copy, { recursive: true, force: true }))
  const marker = join(copy, 'ran')
  const plantGate = file => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, '跑过')\n`)
  }
  const copiedProgress = join(copy, 'openspec-change-progress/scripts/progress.mjs')
  mkdirSync(dirname(copiedProgress), { recursive: true })
  writeFileSync(copiedProgress, readFileSync(progress))
  plantGate(join(copy, GATE_RELATIVE))
  const unregistered = p.runScript(copiedProgress, ['--json'])
  assert.equal(unregistered.code, 2, unregistered.err)
  assert.match(unregistered.err, /安装来源无法核验/)
  assert.match(unregistered.err, /~\/\.tigger\/skills/)
  assert.equal(unregistered.out, '')
  const viaGate = p.run(['--json', '--gate', join(copy, GATE_RELATIVE)])
  assert.equal(viaGate.code, 2, viaGate.err)
  const inside = join(p.repo, 'vendor/skills')
  plantGate(join(inside, GATE_RELATIVE))
  p.configure({ trustedSkillRoots: [repoSkills, inside] })
  const inCheckout = p.run(['--json', '--gate', join(inside, GATE_RELATIVE)])
  assert.equal(inCheckout.code, 2, inCheckout.err)
  assert.match(inCheckout.err, /项目检出/)
  assert.equal(existsSync(marker), false)
})

test('变更暂缓：统一安装根中的门禁不需要登记；托管配置无法解析时退出 2', t => {
  const p = project()
  t.after(p.cleanup)
  change(p, 'alpha', { tier: 'L0' })
  const user = realpathSync(mkdtempSync(join(tmpdir(), 'progress-user-')))
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'progress-empty-home-')))
  t.after(() => { for (const dir of [user, empty]) rmSync(dir, { recursive: true, force: true }) })
  const installed = join(user, '.tigger/skills', GATE_RELATIVE)
  mkdirSync(dirname(installed), { recursive: true })
  writeFileSync(installed, readFileSync(gate))
  const env = { HOME: user, OPENSPEC_AUTOPILOT_HOME: empty }
  const ok = p.run(['--json', '--gate', installed], env)
  assert.equal(ok.code, 0, ok.err)
  assert.equal(ok.json().active[0].changeState.state, 'enabled')
  const repoGate = p.run(['--json', '--gate', gate], env)
  assert.equal(repoGate.code, 2, repoGate.err)
  writeFileSync(join(p.home, 'config.json'), '{')
  const broken = p.run(['--json'])
  assert.equal(broken.code, 2, broken.err)
  assert.match(broken.err, /托管配置/)
})

test('变更暂缓：项目根不是检出根时条目状态未知，下一步提示修复', t => {
  const p = project()
  t.after(p.cleanup)
  change(p, 'alpha', { tier: 'L0', tasks: [true, false], base: 'nested/' })
  mkdirSync(join(p.repo, 'nested/openspec/changes/archive'), { recursive: true })
  const result = p.runScript(progress, ['--json'], {}, join(p.repo, 'nested'))
  assert.equal(result.code, 0, result.err)
  const item = result.json().active.find(found => found.change === 'alpha')
  assert.ok(item, result.out)
  assert.equal(item.changeState.state, 'unknown')
  assert.match(item.changeState.error, /不属于选定项目/)
  assert.equal(item.changeDirectory, null)
  assert.match(item.next, /修复变更状态/)
})
