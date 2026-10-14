import { readFile } from 'node:fs/promises'
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
async function run(args) {
  const labels = []
  let summaryPrompt = ''
  const agent = async (prompt, { label }) => {
    labels.push(label)
    if (label === 'summarize') {
      summaryPrompt = prompt
      return 'ok'
    }
    return { role: label, verdict: '通过', blockers: [], findings: [] }
  }
  const parallel = fns => Promise.all(fns.map(fn => fn()))
  const workflow = new Workflow('args', 'agent', 'parallel', 'phase', 'log', body)
  const result = await workflow(args, agent, parallel, () => {}, () => {})
  return { result, reviewed: labels.filter(l => l.startsWith('review:')).map(l => l.slice(7)), summaryPrompt }
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
