import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 技术评审门禁 workflow 的参数解析测试。
 *
 * 被测脚本：skills/openspec-technical-review/technical-review-gate.workflow.js
 * 以异步函数模拟 workflow 宿主，agent 返回固定结论，只断言「跑哪些维度、汇总提示怎么写」。
 * 评审范围一旦算错不会报错，只会产出错位的 review 文件，因此把参数边界逐个固定住。
 */
const source = await readFile(new URL('../skills/openspec-technical-review/technical-review-gate.workflow.js', import.meta.url), 'utf8')
const body = source.replace('export const meta', 'const meta')
const Workflow = Object.getPrototypeOf(async function () {}).constructor

/** 运行一次 workflow，返回结果、重跑的维度标签与汇总 prompt。 */
async function run(args, { reviewResult, capture, coverage } = {}) {
  const labels = []
  const reviewPrompts = []
  const baseline = { assumptionsValid: true, proposal: '固定方案正文', design: '固定设计正文', originalHashes: { 'proposal.md': 'a'.repeat(64), 'design.md': 'b'.repeat(64), 'tasks.md': 'c'.repeat(64) }, tasksHash: 'd'.repeat(64), registrationBase: 4 }
  let summaryPrompt = ''
  const agent = async (prompt, { label }) => {
    labels.push(label)
    if (label === 'capture-input') return { ...baseline, ...capture }
    if (label === 'check-coverage') return coverage ?? { status: 'covered', roles: args.roles ?? [], locations: ['design.md:10-11'] }
    if (label.startsWith('review:')) reviewPrompts.push(prompt)
    if (label === 'summarize') {
      summaryPrompt = prompt
      return 'ok'
    }
    return reviewResult?.(label) ?? { role: label, verdict: '通过', blockers: [], findings: [] }
  }
  const parallel = fns => Promise.all(fns.map(fn => fn()))
  const workflow = new Workflow('args', 'agent', 'parallel', 'phase', 'log', body)
  const result = await workflow(args, agent, parallel, () => {}, () => {})
  return { result, reviewed: labels.filter(l => l.startsWith('review:')).map(l => l.slice(7)), summaryPrompt, labels, reviewPrompts }
}

test('缺 change 直接报错，不回落到演示变更', async () => {
  await assert.rejects(run(undefined), /缺少必填参数 change/)
  await assert.rejects(run({ level: 'L2' }), /缺少必填参数 change/)
})

test('完整方案缺 level 或传 L0 时报错', async () => {
  await assert.rejects(run({ change: 'demo' }), /必须传 level/)
  await assert.rejects(run({ change: 'demo', level: 'L4' }), /必须传 level/)
  await assert.rejects(run({ change: 'demo', level: 'L0' }), /L0 豁免/)
})

test('按等级推导纳入维度，未纳入维度不当作沿用上轮', async () => {
  const { result, reviewed, summaryPrompt } = await run({ change: 'demo', level: 'L1' })
  assert.deepEqual(reviewed, ['database', 'security'])
  assert.equal(result.mode, 'full')
  assert.deepEqual(result.reuse, [])
  assert.deepEqual(result.notApplicable, ['architecture', 'concurrency', 'performance'])
  assert.match(summaryPrompt, /标注「未纳入」：architecture, concurrency, performance/)
  assert.doesNotMatch(summaryPrompt, /沿用上一轮结论/)
  assert.match(summaryPrompt, /Gate-Level: L1/)
})

test('L3 五维全跑', async () => {
  const { reviewed, result } = await run({ change: 'demo', level: 'L3' })
  assert.deepEqual(reviewed, ['architecture', 'concurrency', 'performance', 'database', 'security'])
  assert.deepEqual(result.notApplicable, [])
})

test('增量重走只沿用纳入维度，并给出缺上轮产物时的确定处理', async () => {
  const { result, reviewed, summaryPrompt } = await run({ change: 'demo', level: 'L1', roles: ['security'] })
  assert.deepEqual(reviewed, ['security'])
  assert.equal(result.mode, 'incremental')
  assert.deepEqual(result.reuse, ['database'])
  assert.match(summaryPrompt, /标注「沿用上轮」：database/)
  assert.match(summaryPrompt, /不要推测、不要编造上轮结论/)
})

test('roles 超出等级纳入范围或含未知维度时报错', async () => {
  await assert.rejects(run({ change: 'demo', level: 'L1', roles: ['concurrency'] }), /不在 L1 的纳入维度/)
  await assert.rejects(run({ change: 'demo', level: 'L3', roles: ['securty'] }), /未知维度/)
  await assert.rejects(run({ change: 'demo', level: 'L3', roles: 'security' }), /roles 必须是数组/)
})

test('MVP 只跑映射维度，其余不适用；不得同时传 level', async () => {
  const { result, reviewed, summaryPrompt } = await run({ change: 'demo', tier: 'mvp', roles: ['security', 'concurrency'] })
  assert.deepEqual(reviewed, ['concurrency', 'security'])
  assert.equal(result.mode, 'mvp')
  assert.equal(result.level, 'MVP')
  assert.match(summaryPrompt, /Gate-Level: MVP/)
  await assert.rejects(run({ change: 'demo', tier: 'mvp' }), /必须传 roles/)
  await assert.rejects(run({ change: 'demo', tier: 'mvp', level: 'L2', roles: ['security'] }), /不使用 L 等级/)
})

test('评审汇总写定稿轮、登记表与两种任务 SHA-256', async () => {
  const { summaryPrompt } = await run({ change: 'demo', level: 'L1' })
  for (const term of ['定稿与签字后修改', '定稿轮：R<n>', '登记表', '原始 SHA-256', '任务内容 SHA-256']) {
    assert.ok(summaryPrompt.includes(term), `汇总提示词缺少：${term}`)
  }
  assert.doesNotMatch(summaryPrompt, /git rev-parse HEAD/)
  assert.ok(summaryPrompt.indexOf('定稿与签字后修改') < summaryPrompt.indexOf('人工确认区'))
})

test('评审汇总仅从第 3 轮起写五列收敛检查', async () => {
  const { summaryPrompt } = await run({ change: 'demo', level: 'L1' })
  assert.match(summaryPrompt, /收敛检查[^\n]*第 3 轮起/)
  assert.match(summaryPrompt, /轮次 \| 纳入维度数 \| 新增 Blocker \| 新增 Major \| 开放 Blocker/)
  assert.match(summaryPrompt, /第 1、2 轮不写/)
  assert.match(summaryPrompt, /gate-policy\.md 第 6 节/)
  assert.ok(summaryPrompt.indexOf('收敛检查') < summaryPrompt.indexOf('人工确认区'))
})

test('运行假设：角色在固定设计正文中读取场景判断边界', async () => {
  const { reviewPrompts } = await run({ change: 'demo', level: 'L1' })
  for (const prompt of reviewPrompts) {
    assert.match(prompt, /第二步[^\n]*读取[^\n]*运行假设[^\n]*触发场景/)
  }
})

test('触发方式：限范围复审的缺码 Blocker 随候选交给汇总先复核', async () => {
  const pending = { id: 'SEC-05', severity: 'Blocker', trigger: '正常使用时甲租户可读取乙租户的数据', location: 'D2', impact: '跨租户泄露' }
  const { summaryPrompt, reviewPrompts } = await run({ change: 'demo', level: 'L1', roles: ['security'] }, {
    reviewResult: () => ({ role: 'security', verdict: '打回', blockers: [], findings: [], pendingTriggers: [pending] }),
  })
  assert.match(reviewPrompts[0], /触发方式代码[^\n]*缺码或错码[^\n]*pendingTriggers/)
  assert.match(reviewPrompts[0], /缺码或错码[^\n]*不先写入[^\n]*建议/)
  assert.match(summaryPrompt, /"pendingTriggers"[^]*"id": "SEC-05"[^]*跨租户泄露/)
  assert.match(summaryPrompt, /先复核[^\n]*补正代码[^\n]*再按范围分流/)
  assert.match(summaryPrompt, /足以阻断[^\n]*保持 BLOCKED/)
})

test('评审分发与汇总使用同一输入及登记基线', async () => {
  const { labels, reviewPrompts, summaryPrompt } = await run({ change: 'demo', level: 'L1' })
  assert.equal(labels[0], 'capture-input')
  for (const prompt of reviewPrompts) {
    assert.match(prompt, /固定方案正文/)
    assert.match(prompt, /固定设计正文/)
    assert.match(prompt, /不重新读取/)
  }
  assert.match(summaryPrompt, /登记基线序号/)
  assert.match(summaryPrompt, /"registrationBase":4/)
  assert.match(summaryPrompt, /转录[^\n]*不[^\n]*替换/)
  assert.match(summaryPrompt, /输入[^\n]*不一致[^\n]*BLOCKED/)
})


test('重走范围：位置版本与固定输入不符时丢弃旧位置，核对失败后审全文', async () => {
  const args = { change: 'demo', level: 'L1', roles: ['security'], changedLocations: {
    locations: ['design.md:91-92'], originalHashes: { 'proposal.md': 'a'.repeat(64), 'design.md': 'f'.repeat(64), 'tasks.md': 'c'.repeat(64) },
  } }
  const { labels, reviewed, reviewPrompts } = await run(args, { coverage: { status: 'unknown', roles: [], locations: [] } })
  assert.deepEqual(labels.slice(0, 2), ['capture-input', 'check-coverage'])
  assert.deepEqual(reviewed, ['database', 'security'])
  for (const prompt of reviewPrompts) {
    assert.match(prompt, /重走时的评审范围/)
    assert.match(prompt, /全文/)
    assert.doesNotMatch(prompt, /design\.md:91-92/)
    assert.match(prompt, /不读[^\n]*review-summary\.md/)
  }
})

test('重走范围：版本匹配仍须核对逐处登记，运行假设变化时审全文', async () => {
  const args = { change: 'demo', level: 'L1', roles: ['security'], changedLocations: {
    locations: ['design.md:91-92'], originalHashes: { 'proposal.md': 'a'.repeat(64), 'design.md': 'b'.repeat(64), 'tasks.md': 'c'.repeat(64) },
  } }
  const covered = await run(args, { coverage: { status: 'covered', roles: ['security'], locations: ['design.md:91-92'] } })
  assert.deepEqual(covered.reviewed, ['security'])
  assert.match(covered.reviewPrompts[0], /design\.md:91-92/)
  const changed = await run(args, { coverage: { status: 'assumptions-changed', roles: ['security'], locations: ['design.md:91-92'] } })
  assert.deepEqual(changed.reviewed, ['database', 'security'])
  assert.ok(changed.reviewPrompts.every(prompt => !prompt.includes('design.md:91-92')))
})

const writeScript = fileURLToPath(new URL('../skills/openspec-technical-review/scripts/review-write.mjs', import.meta.url))
const blocked = '# 汇总\n\nGate-Verdict: BLOCKED\nTechnical Review Approved: __________\n'
const ready = blocked.replace('BLOCKED', 'READY_FOR_HUMAN_APPROVAL')
const findingHeader = '| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |'
const original = '| SEC-01 | Blocker | 更新文档 | D1 | review | 会使用旧决定 | [T1] 并行更新 | 记录丢失 | 检查版本 | open |'
const openReport = `# 安全\n\n## Findings\n${findingHeader}\n${original}\n\n## Finding 台账\n| ID | 严重级别 | 首次轮次 | 状态 | 处理轮次 | 处理依据 |\n| SEC-01 | Blocker | R1 | open | | |\n`
const acceptedReport = openReport.replace(original + '\n', '').replace('| R1 | open | | |', '| R1 | risk-accepted | R1 | R1:SEC-01:1 |') +
  '\n## 处理记录\n\n### SEC-01 · R1:SEC-01:1\n\n- 处理方式：risk-accepted\n\n' + original + '\n'

/** 使用真实文件与独立 Node 进程验证评审写入入口。 */
function writerFixture(t, report = openReport) {
  const root = mkdtempSync(join(tmpdir(), 'review-writer-'))
  const change = join(root, 'openspec/changes/demo')
  mkdirSync(join(change, 'review'), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (file, contents) => writeFileSync(join(change, file), contents)
  const get = file => readFileSync(join(change, file), 'utf8')
  for (const file of ['proposal.md', 'design.md', 'tasks.md']) put(file, '# 规划\n')
  put('review-summary.md', blocked)
  put('review/security.md', report)
  const command = (op, arg = {}, preload = [], directory = change) => {
    const r = spawnSync(process.execPath, [...preload, writeScript, op, directory], { input: JSON.stringify(arg), encoding: 'utf8', cwd: root })
    return { code: r.status, text: r.stdout + r.stderr, data: r.status === 0 ? JSON.parse(r.stdout) : null }
  }
  const snapshot = () => {
    const r = command('snapshot')
    assert.equal(r.code, 0, r.text)
    return r.data
  }
  return { root, change, put, get, command, snapshot }
}

test('受保护发布：旧 ID 被等量行替换或开放台账漏列时保留报告', t => {
  const f = writerFixture(t)
  for (const candidate of [openReport.replaceAll('SEC-01', 'SEC-02'), openReport.replace(original + '\n', '')]) {
    const result = f.command('publish', { expected: f.snapshot(), roles: ['security'], summary: ready, reports: { security: candidate } })
    assert.equal(result.code, 1, result.text)
    assert.match(result.text, /SEC-01/)
    assert.equal(f.get('review/security.md'), openReport)
    assert.equal(f.get('review-summary.md'), blocked)
  }
})

test('受保护发布：撤销先完成，旧候选不能覆写；占用保护时第二个进程不写', t => {
  const f = writerFixture(t, acceptedReport)
  const before = f.snapshot()
  const lock = join(f.change, '.review-write.lock')
  mkdirSync(lock)
  const args = { expected: before, roles: ['security'], summary: ready, reports: { security: acceptedReport } }
  const busy = f.command('publish', args)
  assert.equal(busy.code, 1, busy.text)
  assert.match(busy.text, /占用/)
  assert.equal(f.get('review-summary.md'), blocked)
  rmSync(lock, { recursive: true })
  const withdraw = f.command('withdraw', { expected: before, role: 'security', id: 'SEC-01', decision: 'R1:SEC-01:1', actor: '用户', reason: '已复核', date: '2026-11-25' })
  assert.equal(withdraw.code, 0, withdraw.text)
  assert.match(f.get('review/security.md'), /撤销人：用户/)
  assert.ok(f.get('review/security.md').split('## Finding 台账')[0].includes(original))
  assert.match(f.get('review-summary.md'), /SEC-01.*R1:SEC-01:1/)
  assert.equal(f.command('publish', args).code, 1)
  assert.match(f.get('review-summary.md'), /Gate-Verdict: BLOCKED/)
  const recover = f.command('recover', { expected: f.snapshot(), role: 'security', id: 'SEC-01', decision: 'R1:SEC-01:1', roles: ['security'] })
  assert.equal(recover.code, 0, recover.text)
  assert.doesNotMatch(f.get('review-summary.md'), /SEC-01.*R1:SEC-01:1/)
  assert.match(f.get('review-summary.md'), /Gate-Verdict: BLOCKED/)
})


test('撤销恢复：两处状态须开放，重算全部纳入维度且保留其他待完成撤销', t => {
  const f = writerFixture(t, acceptedReport)
  const major = original.replaceAll('SEC-01', 'ARCH-01').replace('Blocker', 'Major')
  f.put('review/architecture.md', `## Findings\n${findingHeader}\n${major}\n`)
  f.put('review-summary.md', `## 4. 门禁裁决\n\n旧结论\n\n## 5. 各维度结论一览表\n\n| 维度 | 结论 | Blocker | Major | Minor | 本轮范围 |\n|---|---|---|---|---|---|\n| 架构 | 通过 | 0 | 0 | 0 | 重审 |\n| 安全 | 通过 | 0 | 0 | 0 | 重审 |\n\n## 7. 已确认风险详细清单\n\n无。\n\n## 待完成的撤销\n\n| finding ID | 原决定标识 | 维度 |\n|---|---|---|\n| ARCH-02 | R1:ARCH-02:1 | architecture |\n\n## 有条件通过的条件清单\n\n| 条件ID | 来源维度 | 来源 finding ID | 条件内容 | 对应任务或行号 | 状态 |\n|---|---|---|---|---|---|\n| C01 | security | SEC-01 | 核对原记录 | 1.1 | risk-accepted |\n\n## 人工确认区\n\n${blocked.split('\n\n')[1]}`)
  const request = { role: 'security', id: 'SEC-01', decision: 'R1:SEC-01:1', actor: '用户', reason: '已复核', date: '2026-11-25' }
  const withdrawn = f.command('withdraw', { expected: f.snapshot(), ...request })
  assert.equal(withdrawn.code, 0, withdrawn.text)
  const pending = f.get('review-summary.md')
  const restored = f.get('review/security.md')
  f.put('review/security.md', restored.replace(original, original.replace(' | open |', ' | risk-accepted |')))
  const bad = f.command('recover', { expected: f.snapshot(), ...request, roles: ['security', 'architecture'] })
  assert.equal(bad.code, 1, bad.text)
  assert.equal(f.get('review-summary.md'), pending)
  f.put('review/security.md', restored)
  const result = f.command('recover', { expected: f.snapshot(), ...request, roles: ['security', 'architecture'] })
  assert.equal(result.code, 0, result.text)
  const summary = f.get('review-summary.md')
  assert.match(summary, /\| 安全 \| 打回 \| 1 \| 0 \| 0 \|/)
  assert.match(summary, /\| 架构 \| 有条件通过 \| 0 \| 1 \| 0 \|/)
  assert.ok(summary.includes(original) && summary.includes(major))
  assert.match(summary, /ARCH-02.*R1:ARCH-02:1/)
  assert.match(summary, /\| C01 .*\|\s*\| 待处理 \|/)
  assert.doesNotMatch(summary, /SEC-01.*R1:SEC-01:1/)
  assert.match(summary, /^Gate-Verdict: BLOCKED$/m)
})

test('撤销恢复：另一维度没有开放 Blocker 也保留独立打回理由', t => {
  const f = writerFixture(t, acceptedReport)
  const reason = '上一轮的恢复证据尚未核对'
  const architecture = `## Findings\n${findingHeader}\n\n## 架构评审结论：打回\n\n${reason}。\n`
  f.put('review/architecture.md', architecture)
  f.put('review-summary.md', `## 4. 门禁裁决\n\n${reason}。\n\n## 5. 各维度结论一览表\n\n| 维度 | 结论 | Blocker | Major | Minor | 本轮范围 |\n|---|---|---|---|---|---|\n| 架构 | 打回 | 0 | 0 | 0 | 重审 |\n| 安全 | 通过 | 0 | 0 | 0 | 重审 |\n\n${blocked.split('\n\n')[1]}`)
  const request = { role: 'security', id: 'SEC-01', decision: 'R1:SEC-01:1', actor: '用户', reason: '已复核', date: '2026-11-25' }
  const withdrawn = f.command('withdraw', { expected: f.snapshot(), ...request })
  assert.equal(withdrawn.code, 0, withdrawn.text)
  const result = f.command('recover', { expected: f.snapshot(), ...request, roles: ['security', 'architecture'] })
  assert.equal(result.code, 0, result.text)
  const summary = f.get('review-summary.md')
  assert.match(summary, /\| 安全 \| 打回 \| 1 \| 0 \| 0 \|/)
  assert.match(summary, /\| 架构 \| 打回 \| 0 \| 0 \| 0 \|/)
  assert.match(summary, /架构.*上一轮的恢复证据尚未核对/)
  assert.match(summary, /^Gate-Verdict: BLOCKED$/m)
  assert.equal(f.get('review/architecture.md'), architecture)
})

test('撤销恢复：同次撤销留痕缺少人员、原因或日期时不清除待完成记录', t => {
  const f = writerFixture(t, acceptedReport)
  const request = { role: 'security', id: 'SEC-01', decision: 'R1:SEC-01:1', actor: '用户', reason: '已复核', date: '2026-11-25' }
  const withdrawn = f.command('withdraw', { expected: f.snapshot(), ...request })
  assert.equal(withdrawn.code, 0, withdrawn.text)
  const pending = f.get('review-summary.md')
  const restored = f.get('review/security.md')
  for (const field of ['撤销人', '撤销原因', '撤销日期']) {
    const incomplete = restored.replace(new RegExp(`^- ${field}：[^\\n]+\\n`, 'm'), '')
    f.put('review/security.md', incomplete)
    const result = f.command('recover', { expected: f.snapshot(), ...request, roles: ['security'] })
    assert.equal(result.code, 1, `${field}：${result.text}`)
    assert.match(result.text, /撤销恢复依据不符/)
    assert.equal(f.get('review-summary.md'), pending)
    assert.equal(f.get('review/security.md'), incomplete)
  }
  f.put('review/security.md', restored)
  const recovered = f.command('recover', { expected: f.snapshot(), ...request, roles: ['security'] })
  assert.equal(recovered.code, 0, recovered.text)
  assert.equal(recovered.data.recovered, 'SEC-01')
})

test('受保护发布：再次处理不得沿用已撤销记录', t => {
  const history = acceptedReport.split('## 处理记录')[1] + '\n- 撤销人：用户\n- 撤销原因：复核\n- 撤销日期：2026-11-25\n'
  const current = openReport + '\n## 处理记录' + history
  const candidate = current.replace(original + '\n', '').replace('| R1 | open | | |', '| R1 | risk-accepted | R2 | R2:SEC-01:2 |')
  const second = '\n### SEC-01 · R2:SEC-01:2\n\n- 处理方式：risk-accepted\n- 决定人与日期：用户 / 2026-11-26\n- 来源：本轮回复\n- 理由：已复核\n- 捡起条件：条件变化\n\n' + original + '\n'
  for (const [report, code] of [[candidate, 1], [candidate + second.replace('- 理由：已复核\n', ''), 1], [candidate + second, 0]]) {
    const f = writerFixture(t, current)
    const result = f.command('publish', { expected: f.snapshot(), roles: ['security'], summary: ready, reports: { security: report } })
    assert.equal(result.code, code, result.text)
    assert.equal(f.get('review/security.md'), code ? current : report)
  }
})

test('受保护发布：前提变化后重开须有本次决定或闭环依据', t => {
  const required = '- 决定人与日期：用户 / 2026-11-26\n- 来源：本轮回复\n- 理由：已复核\n- 捡起条件：条件变化\n'
  const historical = acceptedReport.replace('- 处理方式：risk-accepted\n', `- 处理方式：risk-accepted\n${required}`)
  const history = historical.split('## 处理记录')[1]
  const reopened = openReport + '\n## 处理记录' + history
  const acceptAgain = historical
  const newDecision = `\n### SEC-01 · R2:SEC-01:2\n\n- 处理方式：risk-accepted\n${required}\n${original}\n`
  const accepted = acceptAgain.replace('| risk-accepted | R1 | R1:SEC-01:1 |', '| risk-accepted | R2 | R2:SEC-01:2 |') + newDecision
  const closeAgain = historical.replace('| risk-accepted | R1 | R1:SEC-01:1 |', '| closed | R2 | design.md:2 |')
  const newClosure = `\n### SEC-01 · R2:SEC-01:2\n\n- 处理方式：closed\n- 闭环依据：design.md:2\n\n${original}\n`
  for (const [candidate, code] of [[acceptAgain, 1], [accepted, 0], [closeAgain, 1],
    [closeAgain + newClosure.replace('design.md:2', 'design.md:3'), 1], [closeAgain + newClosure, 0]]) {
    const f = writerFixture(t, reopened)
    const result = f.command('publish', { expected: f.snapshot(), roles: ['security'], summary: ready, reports: { security: candidate } })
    assert.equal(result.code, code, result.text)
    assert.equal(f.get('review/security.md'), code ? reopened : candidate)
    if (code) assert.match(f.get('review-summary.md'), /^Gate-Verdict: BLOCKED$/m)
  }
})

test('撤销旧报告：具名决定先阻断，有完整原发现时恢复同 ID', t => {
  const legacy = `# 安全\n\n## Findings\n${findingHeader}\n|---|---|---|---|---|---|---|---|---|---|\n\n> **risk accepted**：SEC-01\n> 理由：已核对\n> 触发阈值：原条件变化\n> 接受人：用户  日期：2026-11-25\n`
  for (const withOriginal of [false, true]) {
    const f = writerFixture(t, withOriginal ? legacy.replace('\n\n> **risk accepted**', `\n${original.replace(' | open |', ' | risk-accepted |')}\n\n> **risk accepted**`) : legacy)
    f.put('review-summary.md', ready.replace('__________', '测试签字'))
    const request = { role: 'security', id: 'SEC-01', decision: 'R1:SEC-01:1', actor: '用户', reason: '已复核', date: '2026-11-26' }
    const result = f.command('withdraw', { expected: f.snapshot(), ...request })
    assert.equal(result.code, withOriginal ? 0 : 1, result.text)
    assert.match(f.get('review-summary.md'), /^Gate-Verdict: BLOCKED$/m)
    assert.match(f.get('review-summary.md'), /SEC-01.*R1:SEC-01:1/)
    if (!withOriginal) {
      assert.equal(f.get('review/security.md'), legacy)
      assert.match(result.text, /缺少完整原发现/)
    } else {
      const report = f.get('review/security.md')
      assert.ok(report.includes(original) && report.includes('> **risk accepted**：SEC-01'))
      const recovered = f.command('recover', { expected: f.snapshot(), ...request, roles: ['security'] })
      assert.equal(recovered.code, 0, recovered.text)
      assert.doesNotMatch(f.get('review-summary.md'), /SEC-01.*R1:SEC-01:1/)
    }
  }
})

test('撤销旧报告：恢复一条后可继续发布并撤销第二条具名决定', t => {
  const accepted = original.replace(' | open |', ' | risk-accepted |')
  const second = original.replaceAll('SEC-01', 'SEC-02')
  const quote = id => `> **risk accepted**：${id}\n> 理由：已核对\n> 触发阈值：原条件变化\n> 接受人：用户  日期：2026-11-25\n`
  for (const withOriginal of [true, false]) {
    const rows = withOriginal ? `${accepted}\n${second.replace(' | open |', ' | risk-accepted |')}` : accepted
    const legacy = `# 安全 R1\n\n## Findings\n${findingHeader}\n|---|---|---|---|---|---|---|---|---|---|\n${rows}\n\n${quote('SEC-01')}\n${quote('SEC-02')}`
    const f = writerFixture(t, legacy)
    const runDecision = (op, id, decision = `R1:${id}:1`) => f.command(op, { expected: f.snapshot(), role: 'security', id,
      decision, actor: '用户', reason: '已复核', date: '2026-11-26', roles: ['security'] })
    let result = runDecision('withdraw', 'SEC-01')
    assert.equal(result.code, 0, result.text)
    result = runDecision('recover', 'SEC-01')
    assert.equal(result.code, 0, result.text)
    const afterFirst = f.get('review/security.md')
    const publication = { expected: f.snapshot(), roles: ['security'], summary: f.get('review-summary.md') }
    result = f.command('publish', { ...publication, reports: { security: afterFirst.replace(quote('SEC-02'), '') } })
    assert.equal(result.code, 1, result.text)
    assert.match(result.text, /旧处理记录或原发现：SEC-02/)
    assert.equal(f.get('review/security.md'), afterFirst)
    result = f.command('publish', publication)
    assert.equal(result.code, 0, result.text)
    assert.equal(f.get('review/security.md'), afterFirst)
    const nextRound = afterFirst.replace('# 安全 R1', '# 安全 R2')
    result = f.command('publish', { ...publication, reports: { security: nextRound } })
    assert.equal(result.code, 0, result.text)
    assert.equal(f.get('review/security.md'), nextRound)
    const pendingBefore = f.get('review-summary.md')
    const current = { ...publication, expected: f.snapshot() }
    const origin = /^- 旧决定标识：R1:SEC-02:1\n/m
    assert.match(nextRound, origin)
    for (const candidate of [nextRound.replace(origin, ''), nextRound.replace(origin, '- 旧决定标识：R2:SEC-02:1\n')]) {
      result = f.command('publish', { ...current, reports: { security: candidate } })
      assert.equal(result.code, 1, result.text)
      assert.match(result.text, /候选改动了旧决定标识/)
      assert.equal(f.get('review/security.md'), nextRound)
    }
    result = runDecision('withdraw', 'SEC-02', 'R2:SEC-02:1')
    assert.equal(result.code, 1, result.text)
    assert.equal(f.get('review-summary.md'), pendingBefore)
    const unbound = writerFixture(t, nextRound.replace(origin, ''))
    result = unbound.command('withdraw', { expected: unbound.snapshot(), role: 'security', id: 'SEC-02',
      decision: 'R2:SEC-02:1', actor: '用户', reason: '已复核', date: '2026-11-26' })
    assert.equal(result.code, 1, result.text)
    assert.match(result.text, /缺少可核对的旧决定原轮次/)
    assert.equal(unbound.get('review-summary.md'), blocked)
    result = runDecision('withdraw', 'SEC-02')
    assert.equal(result.code, withOriginal ? 0 : 1, result.text)
    assert.match(f.get('review-summary.md'), /SEC-02.*R1:SEC-02:1/)
    if (withOriginal) {
      result = runDecision('recover', 'SEC-02')
      assert.equal(result.code, 0, result.text)
      const report = f.get('review/security.md')
      assert.ok(report.includes(original) && report.includes(second))
      assert.match(report, /^\| SEC-02 \| Blocker \| R1 \| open \|/m)
      assert.match(report, /### SEC-01 · R1:SEC-01:1/)
      assert.doesNotMatch(f.get('review-summary.md'), /SEC-02.*R1:SEC-02:1/)
    } else {
      assert.match(result.text, /缺少完整原发现/)
      assert.equal(f.get('review/security.md'), nextRound)
    }
  }
})

test('撤销旧报告：无轮次标题、已有处理记录节或先发布迁移时保留各条原决定标识', t => {
  const accepted = id => original.replaceAll('SEC-01', id).replace(' | open |', ' | risk-accepted |')
  const quote = id => `> **risk accepted**：${id}\n> 理由：已核对\n> 触发阈值：原条件变化\n> 接受人：用户  日期：2026-11-25\n`
  const table = `## Findings\n${findingHeader}\n|---|---|---|---|---|---|---|---|---|---|\n`
  const decide = (f, op, id, decision) => f.command(op, { expected: f.snapshot(), role: 'security', id, decision,
    actor: '用户', reason: '已复核', date: '2026-11-26', roles: ['security'] })
  const rejected = (f, id, decision) => {
    const summary = f.get('review-summary.md')
    const report = f.get('review/security.md')
    const result = decide(f, 'withdraw', id, decision)
    assert.equal(result.code, 1, `${decision}：${result.text}`)
    assert.equal(f.get('review-summary.md'), summary)
    assert.equal(f.get('review/security.md'), report)
  }
  const restore = (f, id, decision) => {
    for (const op of ['withdraw', 'recover']) {
      const result = decide(f, op, id, decision)
      assert.equal(result.code, 0, `${op} ${decision}：${result.text}`)
    }
    assert.match(f.get('review/security.md'), new RegExp(`^\\| ${id} \\| Blocker \\| ${decision.split(':')[0]} \\| open \\|`, 'm'))
  }
  const publish = (f, report) => f.command('publish', { expected: f.snapshot(), roles: ['security'],
    summary: f.get('review-summary.md'), reports: { security: report } })

  // 无轮次标题：两条决定各自的处理节写明原轮次，不用第一条的轮次推定第二条。
  const untitled = writerFixture(t, `# 安全评审（demo）\n\n${table}${accepted('SEC-01')}\n${accepted('SEC-02')}\n\n` +
    `## R1 具名风险接受\n\n${quote('SEC-01')}\n## R2 具名风险接受\n\n${quote('SEC-02')}`)
  rejected(untitled, 'SEC-01', 'R2:SEC-01:1')
  restore(untitled, 'SEC-01', 'R1:SEC-01:1')
  assert.match(untitled.get('review/security.md'), /^- 旧决定标识：R2:SEC-02:1$/m)
  for (const decision of ['R1:SEC-02:1', 'R3:SEC-02:1']) rejected(untitled, 'SEC-02', decision)
  restore(untitled, 'SEC-02', 'R2:SEC-02:1')

  // 首轮报告已有处理记录节：首次撤销仍绑定其余旧决定，换轮次后按原标识撤销。
  const recorded = writerFixture(t, `# 安全 R1\n\n${table}${accepted('SEC-01')}\n${accepted('SEC-02')}\n\n## 处理记录\n\n${quote('SEC-01')}\n${quote('SEC-02')}`)
  restore(recorded, 'SEC-01', 'R1:SEC-01:1')
  assert.match(recorded.get('review/security.md'), /^- 旧决定标识：R1:SEC-02:1$/m)
  let result = publish(recorded, recorded.get('review/security.md').replace('# 安全 R1', '# 安全 R2'))
  assert.equal(result.code, 0, result.text)
  rejected(recorded, 'SEC-02', 'R2:SEC-02:1')
  restore(recorded, 'SEC-02', 'R1:SEC-02:1')

  // 先普通发布迁入台账：写入入口按旧报告写原标识，拒绝候选改号；缺原发现时保留待完成记录。
  const legacy = `# 安全 R1\n\n${table}${accepted('SEC-01')}\n\n${quote('SEC-01')}\n${quote('SEC-02')}`
  const ledger = '\n## Finding 台账\n\n| ID | 严重级别 | 首次轮次 | 状态 | 处理轮次 | 处理依据 |\n|---|---|---|---|---|---|\n'
  const migrated = writerFixture(t, legacy)
  result = publish(migrated, `${legacy}${ledger}\n## 处理记录\n\n- 旧决定标识：R1:SEC-01:1\n- 旧决定标识：R2:SEC-02:1\n`)
  assert.equal(result.code, 1, result.text)
  assert.match(result.text, /候选改动了旧决定标识/)
  assert.equal(migrated.get('review/security.md'), legacy)
  result = publish(migrated, legacy + ledger)
  assert.equal(result.code, 0, result.text)
  const published = migrated.get('review/security.md')
  assert.ok(published.startsWith(legacy + ledger))
  assert.match(published, /^- 旧决定标识：R1:SEC-01:1$/m)
  assert.match(published, /^- 旧决定标识：R1:SEC-02:1$/m)
  result = publish(migrated, published.replace('# 安全 R1', '# 安全 R2'))
  assert.equal(result.code, 0, result.text)
  rejected(migrated, 'SEC-01', 'R2:SEC-01:1')
  restore(migrated, 'SEC-01', 'R1:SEC-01:1')
  const beforeMissing = migrated.get('review/security.md')
  result = decide(migrated, 'withdraw', 'SEC-02', 'R1:SEC-02:1')
  assert.equal(result.code, 1, result.text)
  assert.match(result.text, /缺少完整原发现/)
  assert.match(migrated.get('review-summary.md'), /SEC-02.*R1:SEC-02:1/)
  assert.equal(migrated.get('review/security.md'), beforeMissing)
})

test('撤销旧报告：原样沿用已接受的 Minor 及旧闭环行', t => {
  const accepted = original.replace(' | open |', ' | risk-accepted |')
  const minor = accepted.replaceAll('SEC-01', 'SEC-02').replace('Blocker', 'Minor')
  const closed = original.replaceAll('SEC-01', 'SEC-03').replace(' | open |', ' | closed |')
  const quote = id => `> **risk accepted**：${id}\n> 理由：已核对\n> 接受人：用户  日期：2026-11-25\n`
  const f = writerFixture(t, `# 安全 R1\n\n## Findings\n${findingHeader}\n${accepted}\n${minor}\n${closed}\n\n${quote('SEC-01')}\n${quote('SEC-02')}`)
  const request = { role: 'security', id: 'SEC-01', decision: 'R1:SEC-01:1', actor: '用户', reason: '已复核', date: '2026-11-26', roles: ['security'] }
  for (const action of ['withdraw', 'recover']) {
    const result = f.command(action, { expected: f.snapshot(), ...request })
    assert.equal(result.code, 0, result.text)
  }
  const historical = f.get('review/security.md')
  const publish = report => f.command('publish', { expected: f.snapshot(), roles: ['security'],
    summary: f.get('review-summary.md'), reports: { security: report } })
  for (const candidate of [historical.replace(minor, minor.replace('D1', 'D2')),
    historical.replace(closed, closed.replace('D1', 'D2')),
    historical.replace(closed, `${closed}\n${closed.replace('SEC-03', 'SEC-04')}`),
    historical.replace(quote('SEC-02'), quote('SEC-02').replace('已核对', '改写理由'))]) {
    const result = publish(candidate)
    assert.equal(result.code, 1, result.text)
    assert.equal(f.get('review/security.md'), historical)
  }
  const result = publish(historical)
  assert.equal(result.code, 0, result.text)
  assert.equal(f.get('review/security.md'), historical)
})

test('受保护发布：删除已核对的整份增量规格，失败时保留阻断', t => {
  for (const fail of [true, false]) {
    const f = writerFixture(t, acceptedReport)
    const spec = 'specs/example/spec.md'
    mkdirSync(join(f.change, 'specs/example'), { recursive: true })
    f.put(spec, '# 待移出的规格\n')
    f.put('review-summary.md', ready)
    const inject = join(f.root, 'fail-delete.cjs')
    writeFileSync(inject, `const fs = require('node:fs'); const { syncBuiltinESMExports } = require('node:module');
      const unlink = fs.unlinkSync; fs.unlinkSync = path => {
        if (path.endsWith(${JSON.stringify(spec)})) throw new Error('测试：规格删除失败');
        return unlink(path);
      }; syncBuiltinESMExports();`)
    const result = f.command('publish', { expected: f.snapshot(), roles: ['security'], summary: ready, planning: { [spec]: null } }, fail ? ['--require', inject] : [])
    assert.equal(result.code, fail ? 1 : 0, result.text)
    assert.equal(f.get('review-summary.md'), fail ? blocked : ready)
    if (fail) assert.match(f.get(spec), /待移出的规格/)
    else assert.throws(() => f.get(spec), { code: 'ENOENT' })
  }
})

test('受保护发布：角色写入失败时保留阻断，待完成撤销拒绝下一候选', t => {
  const f = writerFixture(t, acceptedReport)
  const expected = f.snapshot()
  f.put('review-summary.md', blocked.replace('Gate-Verdict', '## 待完成的撤销\n\n| finding ID | 原决定标识 | 维度 |\n| SEC-01 | R1:SEC-01:1 | security |\n\n## 人工确认区\n\nGate-Verdict'))
  const request = { expected: f.snapshot(), roles: ['security'], summary: ready, reports: { security: acceptedReport } }
  const result = f.command('publish', request)
  assert.equal(result.code, 1, result.text)
  assert.match(result.text, /待完成的撤销/)
  assert.notDeepEqual(expected, request.expected)
  assert.match(f.get('review-summary.md'), /Gate-Verdict: BLOCKED/)
  assert.equal(f.get('review/security.md'), acceptedReport)
})


test('受保护发布：首次阻断替换失败不写角色，角色替换失败不发布可签字裁决', t => {
  const f = writerFixture(t, acceptedReport)
  f.put('review-summary.md', ready)
  const inject = join(f.root, 'fail-rename.cjs')
  for (const target of ['review-summary.md', 'review/security.md']) {
    writeFileSync(inject, `const fs = require('node:fs'); const { syncBuiltinESMExports } = require('node:module');
      const rename = fs.renameSync; fs.renameSync = (from, to) => {
        if (to.endsWith(${JSON.stringify(target)})) throw new Error('测试：拒绝替换');
        return rename(from, to);
      }; syncBuiltinESMExports();`)
    const result = f.command('publish', { expected: f.snapshot(), roles: ['security'], summary: ready,
      reports: { security: acceptedReport + '\n本轮候选\n' } }, ['--require', inject])
    assert.equal(result.code, 1, result.text)
    assert.match(result.text, /测试：拒绝替换/)
    assert.equal(f.get('review/security.md'), acceptedReport)
    assert.equal(f.get('review-summary.md'), target === 'review-summary.md' ? ready : blocked)
  }
})

test('撤销：首写失败不碰角色；角色写入失败后不能发布可签字候选', t => {
  const f = writerFixture(t, acceptedReport)
  const signed = ready.replace('__________', '本机测试签字')
  f.put('review-summary.md', signed)
  const inject = join(f.root, 'fail-withdraw.cjs')
  const request = { role: 'security', id: 'SEC-01', decision: 'R1:SEC-01:1', actor: '用户', reason: '已复核', date: '2026-11-25' }
  for (const target of ['review-summary.md', 'review/security.md']) {
    writeFileSync(inject, `const fs = require('node:fs'); const { syncBuiltinESMExports } = require('node:module');
      const rename = fs.renameSync; fs.renameSync = (from, to) => {
        if (to.endsWith(${JSON.stringify(target)})) throw new Error('测试：拒绝替换');
        return rename(from, to);
      }; syncBuiltinESMExports();`)
    assert.equal(f.command('withdraw', { ...request, expected: f.snapshot() }, ['--require', inject]).code, 1)
    assert.equal(f.get('review/security.md'), acceptedReport)
    if (target === 'review-summary.md') assert.equal(f.get('review-summary.md'), signed)
  }
  const pending = f.get('review-summary.md')
  assert.match(pending, /SEC-01.*R1:SEC-01:1/)
  assert.match(pending, /Gate-Verdict: BLOCKED/)
  assert.match(pending, /旧批准（仅供追溯）：Technical Review Approved: 本机测试签字/)
  assert.match(pending, /^Technical Review Approved: __________$/m)
  assert.equal(f.command('publish', { expected: f.snapshot(), roles: ['security'], reports: { security: acceptedReport }, summary: pending.replace('BLOCKED', 'READY_FOR_HUMAN_APPROVAL') }).code, 1)
  assert.equal(f.command('recover', { ...request, expected: f.snapshot(), roles: ['security'] }).code, 1)
  assert.equal(f.get('review-summary.md'), pending)
})


test('受保护发布：最后复核后，另一进程不能撤销直到发布结束', t => {
  const f = writerFixture(t, acceptedReport)
  const expected = f.snapshot()
  const inject = join(f.root, 'compete.cjs')
  const outcome = join(f.root, 'competition.json')
  const request = { role: 'security', id: 'SEC-01', decision: 'R1:SEC-01:1', actor: '用户', reason: '复核', date: '2026-11-25', expected }
  writeFileSync(inject, `const fs = require('node:fs'); const { syncBuiltinESMExports } = require('node:module');
    const { spawnSync } = require('node:child_process'); const rename = fs.renameSync; let attempted = false;
    fs.renameSync = (from, to) => {
      if (!attempted && to.endsWith('review-summary.md')) {
        attempted = true;
        const result = spawnSync(process.execPath, ${JSON.stringify([writeScript, 'withdraw', f.change])}, {
          input: ${JSON.stringify(JSON.stringify(request))}, encoding: 'utf8', cwd: ${JSON.stringify(f.root)} });
        fs.writeFileSync(${JSON.stringify(outcome)}, JSON.stringify({ code: result.status, error: result.stderr }));
      }
      return rename(from, to);
    }; syncBuiltinESMExports();`)
  const result = f.command('publish', { expected, roles: ['security'], summary: ready, reports: { security: acceptedReport } }, ['--require', inject])
  assert.equal(result.code, 0, result.text)
  const competing = JSON.parse(readFileSync(outcome, 'utf8'))
  assert.equal(competing.code, 1)
  assert.match(competing.error, /占用/)
  assert.equal(f.get('review-summary.md'), ready)
  assert.equal(f.get('review/security.md'), acceptedReport)
})


test('定稿：汇总先阻断并转交待处理条件，运行假设变化不进入签字分支', async () => {
  const { summaryPrompt } = await run({ change: 'demo', level: 'L1' })
  assert.match(summaryPrompt, /新条件[^\n]*待处理[^\n]*来源 finding ID/)
  assert.match(summaryPrompt, /修复是否新增机制/)
  assert.match(summaryPrompt, /收窄[^\n]*接受风险[^\n]*先处理条件再定稿/)
  assert.match(summaryPrompt, /运行假设[^\n]*变化[^\n]*全量重审/)
  assert.match(summaryPrompt, /交主会话[^\n]*BLOCKED/)
})


const signedSummary = ready.replace('__________', '本机测试签字')
const pendingCondition = '## 有条件通过的条件清单\n\n| 条件ID | 来源维度 | 来源 finding ID | 条件内容 | 对应任务或行号 | 状态 |\n|---|---|---|---|---|---|\n| R1-C01 | security | SEC-01 | 核对原记录 | | 待处理 |\n'

test('apply 最终准入：无条件也复核撤销顺序，不写任务基线', t => {
  const f = writerFixture(t, acceptedReport)
  f.put('review-summary.md', signedSummary)
  const expected = f.snapshot()
  const admitted = f.command('admit', { expected })
  assert.equal(admitted.code, 0, admitted.text)
  assert.equal(admitted.data.admitted, true)
  const withdraw = f.command('withdraw', { expected, role: 'security', id: 'SEC-01', decision: 'R1:SEC-01:1', actor: '用户', reason: '复核', date: '2026-11-25' })
  assert.equal(withdraw.code, 0, withdraw.text)
  assert.equal(f.command('admit', { expected }).code, 1)
  assert.equal(f.command('admit', { expected: f.snapshot() }).code, 1)
  assert.equal(f.get('tasks.md'), '# 规划\n')
  assert.equal(admitted.data.admitted, true)
})

test('apply 最终准入：仅允许任务进度变化，并阻断定稿后待处理条件', t => {
  const f = writerFixture(t, acceptedReport)
  const tasks = '# 任务\n\n- [ ] 1.1 核对原记录\n'
  f.put('tasks.md', tasks)
  f.put('review-summary.md', signedSummary)
  const expected = f.snapshot()
  f.put('tasks.md', tasks.replace('# 任务\n', '# 任务\n基线任务数：1（2026-11-25 首次 apply）\n').replace('- [ ]', '- [x]'))
  assert.equal(f.command('admit', { expected }).code, 0)
  f.put('tasks.md', tasks.replace('原记录', '别的记录'))
  assert.equal(f.command('admit', { expected }).code, 1)
  f.put('review-summary.md', `${pendingCondition}\n## 定稿与签字后修改\n\n定稿轮：R1\n\n## 人工确认区\n${signedSummary.split('\n').slice(2).join('\n')}`)
  const pending = f.command('admit', { expected: f.snapshot() })
  assert.equal(pending.code, 1, pending.text)
  assert.match(pending.text, /R1-C01/)
})


const gateScript = fileURLToPath(new URL('../skills/openspec-technical-review/scripts/implementation-gate.mjs', import.meta.url))
function archiveFixture(t) {
  const f = writerFixture(t, acceptedReport)
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  writeFileSync(join(f.root, '.gitignore'), '/openspec/changes/\n')
  writeFileSync(join(f.root, 'implementation.txt'), '实现一\n')
  git('add', '.')
  git('-c', 'user.name=测试', '-c', 'user.email=test@example.invalid', 'commit', '-qm', '初始')
  const head = git('rev-parse', 'HEAD')
  f.put('review-summary.md', signedSummary)
  const fingerprint = (rev = null) => {
    const result = spawnSync(process.execPath, [gateScript, 'fingerprint', f.change, '--repo', f.root, ...(rev ? ['--rev', rev] : [])], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const verified = rev => `# 验证\n\n- Fingerprint: ${fingerprint(rev)}\n- Verify-Verdict: PASS\n- Critical-Count: 0\n\n### 评审条件\n\n无。\n`
  f.put('verification.md', verified())
  const target = join(f.root, 'openspec/changes/archive/2026-11-25-demo')
  const main = join(f.root, 'openspec/specs')
  mkdirSync(main)
  const args = requested => ({ expected: f.snapshot(), repo: f.root, target, sync: requested ?? { choice: 'not-needed' } })
  return { ...f, git, head, fingerprint, verified, target, main, args }
}

test('受支持 Node 16 不含 Object.hasOwn 时仍可准入、发布与同步', t => {
  const f = archiveFixture(t)
  const inject = join(f.root, 'node16.cjs')
  writeFileSync(inject, 'delete Object.hasOwn')
  const preload = ['--require', inject]
  const sync = syncPlan(f)
  for (const [verb, args] of [
    ['admit', { expected: f.snapshot() }],
    ['publish', { expected: f.snapshot(), roles: ['security'], summary: signedSummary }],
    ['sync', sync],
  ]) {
    const result = f.command(verb, args, preload)
    assert.equal(result.code, 0, result.text)
  }
})

test('链接规划目录与独立规划仓均按选定实现仓发布并归档', t => {
  for (const linked of [true, false]) {
    const impl = archiveFixture(t)
    const plan = writerFixture(t, acceptedReport)
    const init = spawnSync('git', ['init', '-q'], { cwd: plan.root, encoding: 'utf8' })
    assert.equal(init.status, 0, init.stderr)
    plan.put('review-summary.md', signedSummary)
    const alias = linked ? join(impl.root, 'openspec/changes/linked') : plan.change
    if (linked) symlinkSync(plan.change, alias, 'dir')
    const snapshot = plan.command('snapshot', {}, [], alias)
    assert.equal(snapshot.code, 0, snapshot.text)
    assert.equal(plan.command('admit', { expected: snapshot.data }, [], alias).code, 0)
    const fingerprint = impl.fingerprint()
    const published = plan.command('verify', { expected: snapshot.data, repo: impl.root, fingerprint, report: impl.verified() }, [], alias)
    assert.equal(published.code, 0, published.text)
    const target = join(plan.root, 'openspec/changes/archive/2026-11-26-demo')
    const archive = { expected: plan.snapshot(), repo: impl.root, target, sync: { choice: 'not-needed' } }
    writeFileSync(join(impl.root, 'implementation.txt'), '验后修改')
    assert.match(plan.command('archive', archive, [], alias).text, /指纹.*不匹配/)
    writeFileSync(join(impl.root, 'implementation.txt'), '实现一\n')
    if (linked) {
      const other = writerFixture(t, acceptedReport)
      rmSync(alias)
      symlinkSync(other.change, alias, 'dir')
      assert.equal(plan.command('archive', archive, [], alias).code, 1)
      rmSync(alias)
      symlinkSync(plan.change, alias, 'dir')
    }
    const moved = plan.command('archive', archive, [], alias)
    assert.equal(moved.code, 0, moved.text)
    assert.ok(existsSync(join(target, 'verification.md')))
    assert.ok(!existsSync(plan.change))
  }
})

test('旧五列条件按任务或规划行准入及归档，新表缺来源仍拒绝', t => {
  const f = archiveFixture(t)
  const old = '## 有条件通过的条件清单\n\n| 条件ID | 来源维度 | 条件内容 | 对应任务或行号 | 状态 |\n|---|---|---|---|---|\n| C1 | security | 核对任务 | 1.1 | 待实现 |\n| C2 | security | 核对设计 | design.md:1 | 待修改 |\n'
  const summary = `${old}\n定稿轮：R1\n\n${signedSummary}`
  f.put('review-summary.md', summary)
  f.put('tasks.md', '- [ ] 1.1 核对原记录\n')
  const admitted = f.command('admit', { expected: f.snapshot() })
  assert.equal(admitted.code, 0, admitted.text)
  assert.match(f.command('archive', f.args()).text, /未闭环.*C1/)
  f.put('review-summary.md', summary.replace('来源维度 | 条件内容', '来源维度 | 来源 finding ID | 条件内容').replaceAll('| security | 核对', '| security | | 核对').replaceAll(/待实现|待修改/g, '已写入'))
  assert.match(f.command('admit', { expected: f.snapshot() }).text, /评审条件 C1/)
  assert.match(f.command('archive', f.args()).text, /未闭环.*C1/)
  f.put('review-summary.md', summary)
  f.put('tasks.md', '- [x] 1.1 核对原记录\n')
  const verify = f.command('verify', { expected: f.snapshot(), repo: f.root, fingerprint: f.fingerprint(), report: f.verified(), conditions: [{ id: 'C1', closed: true }, { id: 'C2', closed: true }] })
  assert.equal(verify.code, 0, verify.text)
  const archived = f.command('archive', f.args())
  assert.equal(archived.code, 0, archived.text)
})

test('无定稿轮的旧五列条件按落点验证和归档，不限制状态文字', t => {
  const f = archiveFixture(t)
  const old = '## 有条件通过的条件清单\n\n| 条件ID | 来源维度 | 条件内容 | 对应任务或行号 | 状态 |\n|---|---|---|---|---|\n| C1 | security | 核对任务 | 1.1 | 人工核验完成 |\n| C2 | security | 核对设计 | design.md:1 | 已复核正文 |\n'
  const summary = `${old}\n${signedSummary}`
  f.put('tasks.md', '- [x] 1.1 核对原记录\n')
  const verify = () => f.command('verify', { expected: f.snapshot(), repo: f.root, fingerprint: f.fingerprint(),
    report: f.verified(), conditions: [{ id: 'C1', closed: true }, { id: 'C2', closed: true }] })
  const noSource = summary.replace('来源维度 | 条件内容', '来源维度 | 来源 finding ID | 条件内容')
    .replaceAll('| security | 核对', '| security | | 核对').replace(/人工核验完成|已复核正文/g, '已写入')
  for (const malformed of [summary.replace('| 1.1 |', '| |'), noSource, `${summary}\n定稿轮：R1\n`]) {
    f.put('review-summary.md', malformed)
    const result = verify()
    assert.equal(result.code, 1, result.text)
    assert.match(result.text, /verify 条件依据不匹配：C1/)
    assert.match(f.command('archive', f.args()).text, /未闭环.*C1/)
  }
  f.put('review-summary.md', summary)
  const verified = verify()
  assert.equal(verified.code, 0, verified.text)
  const archived = f.command('archive', f.args())
  assert.equal(archived.code, 0, archived.text)
  assert.ok(existsSync(join(f.target, 'verification.md')))
})

test('归档只核对本轮纳入维度，保留未纳入维度的历史报告', t => {
  const f = archiveFixture(t)
  const historical = openReport.replaceAll('SEC-01', 'CONC-01')
  f.put('review/concurrency.md', historical)
  const summary = `${signedSummary}\n## 5. 各维度结论一览表\n\n| 维度 | 结论 | Blocker | Major | Minor | 本轮范围 |\n|---|---|---|---|---|---|\n| [安全](review/security.md) | 通过 | 0 | 0 | 0 | 本轮重跑 |\n| [并发](review/concurrency.md) | 打回 | 1 | 0 | 0 | 沿用上轮 |\n`
  f.put('review-summary.md', summary)
  assert.match(f.command('archive', f.args()).text, /concurrency.*开放 Blocker/)
  f.put('review-summary.md', summary.replace('打回 | 1 | 0 | 0 | 沿用上轮', '— | — | — | — | 未纳入'))
  const result = f.command('archive', f.args())
  assert.equal(result.code, 0, result.text)
  assert.equal(readFileSync(join(f.target, 'review/concurrency.md'), 'utf8'), historical)
})

test('verify 与归档共用字段格式，发布拒绝缺字段或 PASS 计数非零', t => {
  const f = archiveFixture(t)
  const fingerprint = f.fingerprint()
  const report = f.verified().replace(`Fingerprint: ${fingerprint}`, `**Fingerprint**：\`${fingerprint}\``)
    .replace('Verify-Verdict: PASS', '**Verify-Verdict**：\`PASS\`').replace('Critical-Count: 0', '**Critical-Count**：\`0\`')
  const publish = candidate => f.command('verify', { expected: f.snapshot(), repo: f.root, fingerprint, report: candidate })
  const before = f.get('verification.md')
  for (const invalid of [report.replace(/- \*\*Critical-Count.*\n/, ''), report.replace('\`0\`', '\`1\`'), report.replace('\`0\`', '\`0.5\`')]) {
    assert.equal(publish(invalid).code, 1)
    assert.equal(f.get('verification.md'), before)
  }
  const failed = publish(report.replace('PASS', 'FAIL'))
  assert.equal(failed.code, 0, failed.text)
  assert.match(f.command('archive', f.args()).text, /报告未通过/)
  const passed = publish(report)
  assert.equal(passed.code, 0, passed.text)
  const moved = f.command('archive', f.args())
  assert.equal(moved.code, 0, moved.text)
})

test('写保护标记失败保留原错误并可重试', t => {
  const f = archiveFixture(t)
  const inject = join(f.root, 'fail-owner.cjs')
  writeFileSync(inject, `const fs = require('node:fs'); const { syncBuiltinESMExports } = require('node:module');
    const write = fs.writeFileSync; fs.writeFileSync = (target, body, options) => {
      if ((typeof target === 'string' && target.endsWith('/.review-write.lock/owner')) ||
          (typeof target === 'number' && /^\\d+ [a-f0-9-]+\\n$/.test(body))) {
        if (typeof target === 'string') write(target, '', options);
        throw Object.assign(new Error('测试：保护标记空间不足'), { code: 'ENOSPC' });
      }
      return write(target, body, options);
    }; syncBuiltinESMExports();`)
  const args = { expected: f.snapshot() }
  const result = f.command('admit', args, ['--require', inject])
  assert.equal(result.code, 1, result.text)
  assert.match(result.text, /保护标记空间不足/)
  assert.ok(!existsSync(join(f.change, '.review-write.lock')))
  assert.equal(f.command('admit', args).code, 0)
})

test('归档最后复核：报告未变但实现已变，不移动也不留下同步记录', t => {
  const f = archiveFixture(t)
  const args = f.args(syncPlan(f))
  writeFileSync(join(f.root, 'implementation.txt'), '实现二\n')
  const result = f.command('archive', args)
  assert.equal(result.code, 1, result.text)
  assert.match(result.text, /指纹.*不匹配/)
  assert.ok(existsSync(f.change))
  assert.ok(!existsSync(f.target))
  assert.ok(!existsSync(join(f.change, 'archive-sync.md')))
  assert.ok(!existsSync(join(f.main, 'alpha/spec.md')))
})

test('归档最后复核：有效变更终点与缺失报告指纹分别处理', t => {
  const f = archiveFixture(t)
  f.put('verification.md', '# 缺失指纹\n')
  assert.match(f.command('archive', f.args()).text, /指纹缺失|无法读取/)
  assert.ok(!existsSync(join(f.change, 'archive-sync.md')))
  f.put('tasks.md', `# 任务\n\n## 变更终点\n\n- 提交：${f.head}\n- 判定人：用户\n- 日期：2026-11-25\n- 依据：之后改动与本变更无关\n`)
  f.put('verification.md', f.verified(f.head))
  writeFileSync(join(f.root, 'implementation.txt'), '终点后的实现\n')
  const moved = f.command('archive', f.args())
  assert.equal(moved.code, 0, moved.text)
  assert.ok(!existsSync(f.change))
  assert.ok(existsSync(f.target))
  assert.ok(!existsSync(join(f.target, '.review-write.lock')))
})

test('verify 发布与归档：新报告拒绝旧归档，先移动时 verify 不追写', t => {
  const f = archiveFixture(t)
  const oldArchive = f.args()
  const oldVerify = { expected: f.snapshot(), repo: f.root, fingerprint: f.fingerprint(), report: f.verified() + '\n新报告\n' }
  const publish = f.command('verify', oldVerify)
  assert.equal(publish.code, 0, publish.text)
  assert.equal(f.command('archive', oldArchive).code, 1)
  assert.equal(f.command('archive', f.args()).code, 0)
  assert.equal(f.command('verify', oldVerify).code, 1)
  assert.ok(!existsSync(f.change))
  assert.match(readFileSync(join(f.target, 'verification.md'), 'utf8'), /新报告/)
})


function syncPlan(f) {
  const sha = value => createHash('sha256').update(value).digest('hex')
  const delta = {}, files = {}
  for (const name of ['alpha', 'beta']) {
    mkdirSync(join(f.change, 'specs', name), { recursive: true })
    const file = `${name}/spec.md`
    f.put(`specs/${file}`, `增量 ${name}\n`)
    delta[`specs/${file}`] = sha(`增量 ${name}\n`)
    const content = `目标 ${name}\n`
    files[file] = { before: null, target: sha(content), content }
  }
  return { choice: 'sync', delta, files }
}

test('首次归档选择跳过也保留理由，但不能据此补写主规格', t => {
  const f = archiveFixture(t)
  syncPlan(f)
  const reason = '本轮不发布主规格'
  const result = f.command('archive', f.args({ choice: 'skip', reason }))
  assert.equal(result.code, 0, result.text)
  assert.equal(result.data.sync, 'skip')
  const record = readFileSync(join(f.target, 'archive-sync.md'), 'utf8')
  assert.ok(record.includes(reason))
  assert.match(f.command('resume-sync', {}, [], f.target).text, /没有同步授权/)
  assert.ok(!existsSync(join(f.main, 'alpha/spec.md')))
})

test('归档同步：移动失败不写主规格，跳过重试不沿用上次选择', t => {
  const f = archiveFixture(t)
  const plan = syncPlan(f)
  const inject = join(f.root, 'archive-fail.cjs')
  const kind = join(f.root, 'reject-kind')
  writeFileSync(inject, `const fs = require('node:fs'); const { syncBuiltinESMExports } = require('node:module');
    const rename = fs.renameSync; fs.renameSync = (from, to) => {
      if (to.endsWith(fs.readFileSync(${JSON.stringify(kind)}, 'utf8'))) throw new Error('测试拒绝归档写入');
      return rename(from, to);
    }; syncBuiltinESMExports();`)
  for (const suffix of ['archive-sync.md', '2026-11-25-demo']) {
    writeFileSync(kind, suffix)
    f.put('verification.md', f.verified())
    const outcome = f.command('archive', f.args(plan), ['--require', inject])
    assert.equal(outcome.code, 1, outcome.text)
    assert.match(outcome.text, /测试拒绝归档写入/)
    assert.ok(existsSync(f.change) && !existsSync(f.target))
    assert.ok(!existsSync(join(f.change, '.review-write.lock')))
    assert.ok(!existsSync(join(f.main, 'alpha/spec.md')))
  }
  assert.match(f.get('archive-sync.md'), /pending/)
  assert.equal(f.command('resume-sync', {}).code, 1)
  const moved = f.command('archive', f.args({ choice: 'skip', reason: '本次不更新主规格' }))
  assert.equal(moved.code, 0, moved.text)
  assert.match(readFileSync(join(f.target, 'archive-sync.md'), 'utf8'), /状态：skip/)
  assert.equal(f.command('resume-sync', {}, [], f.target).code, 1)
  assert.ok(!existsSync(join(f.main, 'alpha/spec.md')))
})

test('归档同步：移动成功才可续办，写一半后不覆写后来版本', t => {
  const f = archiveFixture(t)
  const plan = syncPlan(f)
  const inject = join(f.root, 'sync-fail.cjs')
  writeFileSync(inject, `const fs = require('node:fs'); const { syncBuiltinESMExports } = require('node:module');
    const rename = fs.renameSync; fs.renameSync = (from, to) => {
      if (to.endsWith('/beta/spec.md')) throw new Error('测试：同步中断');
      return rename(from, to);
    }; syncBuiltinESMExports();`)
  f.put('verification.md', f.verified())
  const moved = f.command('archive', f.args(plan))
  assert.equal(moved.code, 0, moved.text)
  assert.ok(!existsSync(join(f.main, 'alpha/spec.md')))
  const busy = join(f.main, '.main-spec-sync.lock')
  mkdirSync(busy)
  assert.match(f.command('resume-sync', {}, [], f.target).text, /占用/)
  rmSync(busy, { recursive: true })
  const interrupted = f.command('resume-sync', {}, ['--require', inject], f.target)
  assert.match(interrupted.text, /同步中断/)
  assert.match(readFileSync(join(f.target, 'archive-sync.md'), 'utf8'), /状态：pending/)
  assert.equal(readFileSync(join(f.main, 'alpha/spec.md'), 'utf8'), '目标 alpha\n')
  writeFileSync(join(f.main, 'beta/spec.md'), '他人更新\n')
  assert.match(f.command('resume-sync', {}, [], f.target).text, /须重新确认/)
  assert.equal(readFileSync(join(f.main, 'beta/spec.md'), 'utf8'), '他人更新\n')
  rmSync(join(f.main, 'beta/spec.md'))
  const done = f.command('resume-sync', {}, [], f.target)
  assert.equal(done.code, 0, done.text)
  assert.match(readFileSync(join(f.target, 'archive-sync.md'), 'utf8'), /状态：synced/)
  assert.equal(readFileSync(join(f.main, 'beta/spec.md'), 'utf8'), '目标 beta\n')
  assert.ok(!existsSync(f.change))
})

test('独立同步：主规格保护占用时不写，解除后无需归档记录', t => {
  const f = archiveFixture(t)
  const plan = syncPlan(f)
  const busy = join(f.main, '.main-spec-sync.lock')
  mkdirSync(busy)
  assert.match(f.command('sync', plan).text, /占用/)
  assert.ok(!existsSync(join(f.main, 'alpha/spec.md')))
  rmSync(busy, { recursive: true })
  const done = f.command('sync', plan)
  assert.equal(done.code, 0, done.text)
  assert.equal(readFileSync(join(f.main, 'alpha/spec.md'), 'utf8'), '目标 alpha\n')
  assert.ok(existsSync(f.change) && !existsSync(join(f.change, 'archive-sync.md')))
})


test('归档复核后：并行撤销不能写，归档后两类发布均不重建原目录', t => {
  const f = archiveFixture(t)
  const injection = join(f.root, 'archive-race.cjs')
  const resultFile = join(f.change, 'competition.json')
  const withdraw = { expected: f.snapshot(), role: 'security', id: 'SEC-01', decision: 'R1:SEC-01:1', actor: '用户', reason: '复核', date: '2026-11-25' }
  writeFileSync(injection, `const fs = require('node:fs'); const { syncBuiltinESMExports } = require('node:module');
    const { spawnSync } = require('node:child_process'); const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to.endsWith('2026-11-25-demo')) {
        const result = spawnSync(process.execPath, ${JSON.stringify([writeScript, 'withdraw', f.change])}, { input: ${JSON.stringify(JSON.stringify(withdraw))}, encoding: 'utf8' });
        fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ code: result.status, error: result.stderr }));
      }
      return rename(from, to);
    }; syncBuiltinESMExports();`)
  f.put('verification.md', f.verified())
  const done = f.command('archive', f.args(), ['--require', injection])
  assert.equal(done.code, 0, done.text)
  const competed = JSON.parse(readFileSync(join(f.target, 'competition.json'), 'utf8'))
  assert.equal(competed.code, 1)
  assert.match(competed.error, /占用/)
  assert.equal(f.command('withdraw', withdraw).code, 1)
  assert.ok(!existsSync(f.change) && !existsSync(join(f.target, '.review-write.lock')))
  assert.equal(readFileSync(join(f.target, 'review/security.md'), 'utf8'), acceptedReport)
})

test('归档持有保护时第二进程不能发布 verify 报告', t => {
  const f = archiveFixture(t)
  const report = f.get('verification.md')
  const candidate = { expected: f.snapshot(), repo: f.root, fingerprint: f.fingerprint(), report: report + '\n另一个候选报告\n' }
  const inject = join(f.change, 'verify-during-archive.cjs')
  const outcome = join(f.root, 'verify-during-archive.json')
  writeFileSync(inject, `const fs = require('node:fs'); const { syncBuiltinESMExports } = require('node:module');
    const { spawnSync } = require('node:child_process'); const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to.endsWith('2026-11-25-demo')) {
        const child = spawnSync(process.execPath, ${JSON.stringify([writeScript, 'verify', f.change])}, { input: ${JSON.stringify(JSON.stringify(candidate))}, encoding: 'utf8' });
        fs.writeFileSync(${JSON.stringify(outcome)}, JSON.stringify({ code: child.status, error: child.stderr }));
      }
      return rename(from, to);
    }; syncBuiltinESMExports();`)
  const moved = f.command('archive', f.args(), ['--require', inject])
  assert.equal(moved.code, 0, moved.text)
  const second = JSON.parse(readFileSync(outcome, 'utf8'))
  assert.equal(second.code, 1)
  assert.match(second.error, /写入保护被占用/)
  assert.equal(readFileSync(join(f.target, 'verification.md'), 'utf8'), report)
})

test('归档：没有关联条件的待完成撤销也拒绝移动', t => {
  const f = archiveFixture(t)
  const request = { expected: f.snapshot(), role: 'security', id: 'SEC-01', decision: 'R1:SEC-01:1', actor: '用户', reason: '复核', date: '2026-11-25' }
  assert.equal(f.command('withdraw', request).code, 0)
  const result = f.command('archive', f.args())
  assert.match(result.text, /待完成的撤销：SEC-01/)
  assert.ok(existsSync(f.change) && !existsSync(f.target))
})


test('verify 与归档只认可当前处理记录并拒绝失效报告', t => {
  const f = archiveFixture(t)
  const condition = pendingCondition.replace('| | 待处理 |', '| review/security.md | risk-accepted |')
  f.put('review-summary.md', `${condition}\n## 定稿与签字后修改\n\n定稿轮：R1\n\n## 人工确认区\n${signedSummary.split('\n').slice(2).join('\n')}`)
  const admitted = f.command('admit', { expected: f.snapshot() })
  assert.equal(admitted.code, 0, admitted.text)
  const body = acceptedReport.split('### SEC-01 · R1:SEC-01:1\n')[1]
  const handling = { path: 'review/security.md', decision: 'R1:SEC-01:1', hash: createHash('sha256').update(body).digest('hex') }
  const conditions = [{ id: 'R1-C01', closed: true, handling }]
  const publish = f.command('verify', { expected: f.snapshot(), repo: f.root, fingerprint: f.fingerprint(), report: f.verified(), conditions })
  assert.equal(publish.code, 0, publish.text)
  assert.match(f.get('verification.md'), /Review-Conditions-SHA256:/)
  f.put('review/security.md', acceptedReport + '\n- 理由：记录有更新\n')
  const mismatch = f.command('archive', f.args())
  assert.match(mismatch.text, /条件或处理记录与 verify 报告不匹配/)
  f.put('review/security.md', acceptedReport + '\n- 撤销人：用户\n')
  assert.match(f.command('archive', f.args()).text, /未闭环.*R1-C01/)
  assert.match(f.command('admit', { expected: f.snapshot() }).text, /评审条件 R1-C01/)
  assert.ok(existsSync(f.change) && !existsSync(f.target))
})


test('运行假设：必选等级不合规时不分发，L1 不要求该区块', async () => {
  const options = { capture: { assumptionsValid: false } }
  await assert.rejects(run({ change: 'demo', level: 'L2' }, options), /运行假设[^\n]*停止分发/)
  await assert.rejects(run({ change: 'demo', tier: 'mvp', roles: ['security'] }, options), /运行假设[^\n]*停止分发/)
  assert.deepEqual((await run({ change: 'demo', level: 'L1' }, options)).reviewed, ['database', 'security'])
})
