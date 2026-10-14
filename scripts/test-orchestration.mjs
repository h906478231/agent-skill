import { readFile, access, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// 以异步函数模拟 workflow 宿主，agent 返回固定证据；绝不连接云舟或执行 Git。
const source = await readFile(new URL('../workflow/devops-automation-loop-yunzhou.workflow.js', import.meta.url), 'utf8')
const body = source.replace('export const meta', 'const meta')
const Workflow = Object.getPrototypeOf(async function () {}).constructor
const done = extra => ({ status: 'completed', evidence: ['离线固定证据'], blockers: [], ...extra })
const route = (action = 'apply', extra = {}) => done({ action, gateLevel: 'L1', changeRoot: '/repo/openspec/changes/yunzhou-1',
  fingerprint: action, approvalValid: true, artifactsReady: true, ...extra })

test('入口不再加载独立编排 skill，必要判定内置', async () => {
  const removedSkill = 'openspec-orchestration'
  assert.ok(!source.includes(removedSkill), 'workflow 不应引用已废弃的编排 skill')

  // 入口清单动态收集，避免硬编码路径随时间失效
  // （历史上曾指向 .opencode/agents/*.md 等从未提交的文件，导致本测试长期假红）。
  const [workflows, commands, agents, skillDirs] = await Promise.all([
    readdir(new URL('../workflow/', import.meta.url)).then((fs) => fs.filter((f) => f.endsWith('.workflow.js'))),
    readdir(new URL('../claude/commands/opsx/', import.meta.url)).then((fs) => fs.filter((f) => f.endsWith('.md'))),
    readdir(new URL('../claude/agents/', import.meta.url)).then((fs) => fs.filter((f) => f.endsWith('.md'))),
    readdir(new URL('../skills/', import.meta.url)),
  ])

  // skills/ 下只有真正含 SKILL.md 的目录才是 skill，其余（空目录残留）跳过
  const skillFiles = []
  for (const dir of skillDirs) {
    const rel = `../skills/${dir}/SKILL.md`
    try {
      await access(new URL(rel, import.meta.url))
      skillFiles.push(rel)
    } catch {
      continue
    }
  }

  const entries = [
    ...workflows.map((f) => `../workflow/${f}`),
    ...commands.map((f) => `../claude/commands/opsx/${f}`),
    ...agents.map((f) => `../claude/agents/${f}`),
    ...skillFiles,
  ]

  for (const entry of entries) {
    const text = await readFile(new URL(entry, import.meta.url), 'utf8')
    assert.ok(!text.includes(removedSkill), `${entry} 不应引用已废弃的编排 skill`)
  }

  // 独立编排 skill 必须已下线，其职责改为内置于 workflow
  await assert.rejects(access(new URL(`../skills/${removedSkill}/SKILL.md`, import.meta.url)), { code: 'ENOENT' })
  for (const rule of ['L0', 'L1', 'L2', 'L3', 'needs_decision', 'discussion-log.md', '禁止代签']) {
    assert.ok(source.includes(rule), `workflow 缺少规则：${rule}`)
  }
})

/** 顺序模拟所有阶段并记录调用，防止错误返回仍进入提交。 */
async function execute(routes, overrides = {}, options = {}) {
  const calls = []
  const workflow = new Workflow('args', 'agent', 'phase', 'log', body)
  const result = await workflow({ taskId: 1, intent: 'implement', ...options }, async (prompt, { label }) => {
    calls.push(label)
    if (Object.hasOwn(overrides, label)) return overrides[label]
    if (label === 'Fetch') return done({ task: { id: 1 }, codeRepo: '/repo' })
    if (label === 'Route') return routes.shift() || done({ tasksComplete: true, approvalValid: true })
    if (label === 'GateCheck') return done({ verdict: 'READY_FOR_HUMAN_APPROVAL', humanApproved: true,
      blockerCount: 0, conditionsMapped: true, inputsCurrent: true })
    if (label === 'Verify') return done({ criticalCount: 0, testsPassed: true, testsEvidence: ['测试通过'] })
    if (label === 'Commit') return done({ commitSha: 'a'.repeat(40) })
    return done()
  }, () => {}, () => {})
  return { result, calls }
}

test('明确需求跳过访谈和调查；默认不提交', async () => {
  const { result, calls } = await execute([route()])
  assert.equal(result.status, 'completed')
  assert.deepEqual(calls, ['Fetch', 'Route', 'GateCheck', 'Apply', 'Route', 'Quality', 'Verify'])
})
test('事实未知先调查，调查后待决策就暂停', async () => {
  const { result, calls } = await execute([route('explore'), route('grill')])
  assert.equal(result.status, 'needs_decision')
  assert.deepEqual(calls, ['Fetch', 'Route', 'Explore', 'Route', 'Grill'])
})
test('JSON 或阶段证据无效时失败关闭', async () => {
  for (const invalid of ['not json', done({ evidence: [] }), { status: 'unknown' }]) {
    const { result, calls } = await execute([], { Route: invalid })
    assert.equal(result.status, 'blocked')
    assert.ok(!calls.includes('Apply'))
  }
})
test('缺产物不得实施', async () => {
  const { result, calls } = await execute([route('apply', { artifactsReady: false })])
  assert.equal(result.status, 'blocked')
  assert.ok(!calls.includes('Apply'))
})
test('批准无效返回门禁并等待用户', async () => {
  const { result, calls } = await execute([route('apply', { approvalValid: false })],
    { Gate: { status: 'needs_decision', evidence: ['未签字'], blockers: ['待批准'] } })
  assert.equal(result.status, 'needs_decision')
  assert.ok(!calls.includes('Apply'))
})
test('apply 暂停、quality 阻断、verify CRITICAL 均不提交', async () => {
  for (const stage of ['Apply', 'Quality', 'Verify']) {
    const failure = stage === 'Verify' ? done({ criticalCount: 1, testsPassed: true, testsEvidence: ['测试通过'] })
      : { status: 'blocked', evidence: ['未完成'], blockers: ['待处理'] }
    const { result, calls } = await execute([route()], { [stage]: failure }, { autoCommit: true })
    assert.equal(result.status, 'blocked')
    assert.ok(!calls.includes('Commit'))
  }
})
test('只有显式授权且验证通过才提交', async () => {
  const { result, calls } = await execute([route()], {}, { autoCommit: true })
  assert.equal(result.commit.commitSha, 'a'.repeat(40))
  assert.equal(calls.at(-1), 'Commit')
})
test('规划意图不进入实施', async () => {
  const { calls } = await execute([route()], {}, { intent: 'plan' })
  assert.ok(!calls.includes('Apply'))
})
test('重复无进展停止', async () => {
  const { result, calls } = await execute([route('explore'), route('explore')])
  assert.equal(result.status, 'blocked')
  assert.equal(calls.filter(stage => stage === 'Explore').length, 1)
})
test('恢复验证阶段不重建产物和实施', async () => {
  const { result, calls } = await execute([route('verify')])
  assert.equal(result.status, 'completed')
  assert.deepEqual(calls, ['Fetch', 'Route', 'GateCheck', 'Quality', 'Verify'])
})
test('skipAnalysis 仍运行路由和批准检查', async () => {
  const { calls } = await execute([route('apply', { approvalValid: false })],
    { Gate: { status: 'blocked', evidence: [], blockers: ['待评审'] } }, { skipAnalysis: true })
  assert.ok(calls.includes('Route'))
  assert.ok(calls.includes('Gate'))
  assert.ok(!calls.includes('Apply'))
})
test('有签字但 BLOCKED 或批准输入过期时独立拦截', async () => {
  for (const extra of [{ verdict: 'BLOCKED' }, { inputsCurrent: false }, { humanApproved: false }, { blockerCount: 1 }]) {
    const { result, calls } = await execute([route()], { GateCheck: done({ verdict: 'READY_FOR_HUMAN_APPROVAL',
      humanApproved: true, blockerCount: 0, conditionsMapped: true, inputsCurrent: true, ...extra }) })
    assert.equal(result.status, 'blocked')
    assert.ok(!calls.includes('Apply'))
  }
})
test('L0 通过明确豁免，不要求伪造人工签字', async () => {
  const { result } = await execute([route('apply', { gateLevel: 'L0' })], { GateCheck: done({ verdict: 'EXEMPT',
    exemptionValid: true, blockerCount: 0, conditionsMapped: true, inputsCurrent: true }) })
  assert.equal(result.status, 'completed')
})
test('未执行测试或缺少测试证据不能提交', async () => {
  for (const extra of [{ testsPassed: false }, { testsEvidence: [] }]) {
    const { result, calls } = await execute([route()], { Verify: done({ criticalCount: 0,
      testsPassed: true, testsEvidence: ['实际测试'], ...extra }) }, { autoCommit: true })
    assert.equal(result.status, 'blocked')
    assert.ok(!calls.includes('Commit'))
  }
})
