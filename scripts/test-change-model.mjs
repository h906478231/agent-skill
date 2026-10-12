import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dump } from '../skills/openspec-change-overview/vendor/js-yaml.mjs'

// 通过四个卡点与 /opsx:overview 实际调用的 change-model.mjs 入口验证行为；
// 每个用例在临时目录里构造项目（CONTEXT.md + 变更目录），不改动本仓库。
const SKILL_DIR = fileURLToPath(new URL('../skills/openspec-change-overview', import.meta.url))
const SCRIPT = join(SKILL_DIR, 'scripts/change-model.mjs')

/** 示例术语表：取消的禁用别名为退单、撤单。 */
const GLOSSARY = [
  '# 订单', '', '## Language', '',
  '**Cancellation（取消）**:', '整单取消。', '_Avoid_: 退单、撤单', '',
].join('\n')

/** 示例 spec：两个能力，各含若干 Scenario。 */
const SPECS = {
  'order-cancel': ['已支付订单取消后进入退款中', '超时未支付订单自动取消'],
  'order-refund': ['渠道退款失败'],
}

/** 一个合法的变更模型：每个用例在此基础上修改。 */
function baseModel() {
  return {
    version: 1,
    machines: [{
      id: 'order-status',
      name: '订单状态',
      states: [
        { id: 'PENDING', name: '待支付', initial: true },
        { id: 'PAID', name: '已支付' },
        { id: 'REFUNDING', name: '退款中', diff: 'added' },
        { id: 'CANCELLED', name: '已取消', final: true },
      ],
      transitions: [
        { id: 'T1', from: 'PENDING', to: 'PAID', trigger: '支付成功' },
        { id: 'T3', from: 'PENDING', to: 'CANCELLED', trigger: '超时关闭', guard: '创建后 30 分钟',
          diff: 'changed', before: { guard: '创建后 15 分钟' }, scenarios: ['order-cancel/超时未支付订单自动取消'] },
        { id: 'T5', from: 'PAID', to: 'REFUNDING', trigger: '用户取消', diff: 'added',
          scenarios: ['order-cancel/已支付订单取消后进入退款中'] },
      ],
    }],
    flows: [{
      id: 'cancel-order',
      name: '用户取消订单',
      steps: [
        { id: 'S1', name: '接收取消请求', actor: '用户' },
        { id: 'S2', name: '判断是否已支付', kind: 'decision', diff: 'added', scenarios: ['order-cancel/已支付订单取消后进入退款中'] },
        { id: 'S5', name: '发起渠道退款', async: true, causes: ['T5'], diff: 'added',
          scenarios: ['order-cancel/已支付订单取消后进入退款中'] },
      ],
      edges: [
        { from: 'S1', to: 'S2', diff: 'added' },
        { from: 'S2', to: 'S5', label: '已支付', diff: 'added' },
      ],
    }],
  }
}

/** 由模型生成「可视化判定」小节：默认按模型中的 ID 声明命中。 */
function decisionSection(model) {
  const line = (label, key) => (model && model[key] && model[key].length
    ? `- ${label}：命中 → ${key}: ${model[key].map(item => item.id).join(', ')}`
    : `- ${label}：未命中`)
  return ['## 可视化判定', '', line('状态变动', 'machines'), line('流程变动', 'flows'), ''].join('\n')
}

/** 拼出 design.md：Context 段 + 可视化判定小节 + change-model 代码块。 */
function designText(model, { section = decisionSection(model), extra = '' } = {}) {
  const block = model === null ? '' : ['```change-model', typeof model === 'string' ? model : dump(model, { lineWidth: -1 }), '```', ''].join('\n')
  return ['## Context', '', '订单取消。', '', section, block, extra].join('\n')
}

/**
 * 创建临时项目与 demo 变更目录。
 * @param {object} options glossary：CONTEXT.md 内容，null 表示不写；specs：能力 → Scenario 名称列表；
 *   skillDir：被测脚本所在 skill 目录（默认本仓库，复制到临时目录可模拟缺少 openspec-ste）。
 */
function fixture(t, { glossary = GLOSSARY, specs = SPECS, skillDir = SKILL_DIR } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'change-model-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  const write = (rel, text) => {
    const file = join(repo, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  if (glossary !== null) write('CONTEXT.md', glossary)
  const changeRoot = join(repo, 'openspec/changes/demo')
  mkdirSync(changeRoot, { recursive: true })
  const change = (rel, text) => write(`openspec/changes/demo/${rel}`, text)
  for (const [capability, names] of Object.entries(specs)) {
    change(`specs/${capability}/spec.md`, ['## ADDED Requirements', '', '### Requirement: 示例', '',
      ...names.flatMap(name => [`#### Scenario: ${name}`, '- **WHEN** 条件', '- **THEN** 结果', '']),
    ].join('\n'))
  }
  const script = join(skillDir, 'scripts/change-model.mjs')
  const run = args => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8' })
    return { code: result.status, out: result.stdout, err: result.stderr, json: () => JSON.parse(result.stdout) }
  }
  const design = (model, options) => change('design.md', designText(model, options))
  const check = () => run(['check', changeRoot])
  return { repo, changeRoot, write, change, design, run, check }
}

/** 检查项摘要：`规则:元素`，便于整体断言。 */
const findings = report => report.blocking.map(item => `${item.rule}:${item.text}`)

// ---------------------------------------------------------------------------
// Slice 01：变更模型可以被检查（Seam：check）
// ---------------------------------------------------------------------------

test('check：合法模型退出码 0，输出与 STE 检查相同字段的 JSON；没有 diff 的迁移视为未变', t => {
  const f = fixture(t)
  f.design(baseModel())
  const result = f.check()
  assert.equal(result.code, 0, result.out + result.err)
  const report = result.json()
  assert.deepEqual(Object.keys(report).sort(), ['blocking', 'exemptions', 'verdict', 'warnings'])
  assert.equal(report.verdict, 'PASS')
  assert.deepEqual(report.blocking, [])
})

test('check：顶层出现 sequences 时报 CM-1 schema 阻断', t => {
  const f = fixture(t)
  f.design({ ...baseModel(), sequences: [] })
  const result = f.check()
  assert.equal(result.code, 1, result.out + result.err)
  const report = result.json()
  assert.equal(report.verdict, 'BLOCKED')
  assert.deepEqual(findings(report), ['CM-1:sequences'])
  assert.equal(report.blocking[0].file, 'design.md')
})

test('check：变更目录不存在时退出码 2', t => {
  const f = fixture(t)
  const result = f.run(['check', join(f.repo, 'openspec/changes/missing')])
  assert.equal(result.code, 2)
  assert.match(result.err, /变更目录不存在/)
})

test('check：步骤 S5 的 causes: [T5] 指向存在的迁移时不报告；指向不存在的迁移时报 CM-1', t => {
  const f = fixture(t)
  f.design(baseModel())
  assert.deepEqual(f.check().json().blocking, [])
  const model = baseModel()
  model.flows[0].steps[2].causes = ['T9']
  f.design(model)
  const report = f.check().json()
  assert.deepEqual(findings(report), ['CM-1:S5'])
  assert.match(report.blocking[0].detail, /T9/)
})

test('check：迁移 ID 在全部状态机内重复、design.md 有两个 change-model 代码块时报 CM-1', t => {
  const f = fixture(t)
  const model = baseModel()
  model.machines.push({ id: 'refund-status', name: '退款状态', states: [{ id: 'A', name: '处理中' }],
    transitions: [{ id: 'T1', from: 'A', to: 'A', trigger: '重试' }] })
  f.design(model)
  assert.deepEqual(findings(f.check().json()), ['CM-1:T1'])
  f.design(baseModel(), { extra: ['```change-model', 'version: 1', '```', ''].join('\n') })
  assert.deepEqual(findings(f.check().json()), ['CM-1:change-model'])
})

test('check：新增迁移 T5 没有 scenarios 时退出码 1，按 CM-3 报告 T5 及其行号', t => {
  const f = fixture(t)
  const model = baseModel()
  delete model.machines[0].transitions[2].scenarios
  f.design(model)
  const result = f.check()
  assert.equal(result.code, 1)
  const report = result.json()
  assert.deepEqual(findings(report), ['CM-3:T5'])
  const lines = readFileSync(join(f.changeRoot, 'design.md'), 'utf8').split('\n')
  assert.match(lines[report.blocking[0].line - 1], /id: T5/)
})

test('check：T6 引用 order-refund/渠道退款成功 而 spec 中没有该 Scenario 时报告缺失的引用', t => {
  const f = fixture(t)
  const model = baseModel()
  model.machines[0].transitions.push({ id: 'T6', from: 'REFUNDING', to: 'CANCELLED', trigger: '渠道退款成功',
    diff: 'added', scenarios: ['order-refund/渠道退款成功'] })
  f.design(model)
  const result = f.check()
  assert.equal(result.code, 1)
  const [item] = result.json().blocking
  assert.equal(`${item.rule}:${item.text}`, 'CM-3:T6')
  assert.match(item.detail, /order-refund\/渠道退款成功/)
})

test('check：order-cancel/已支付订单取消后进入退款中 匹配 spec 中 #### Scenario: 后的文本，引用有效', t => {
  const f = fixture(t, { specs: { 'order-cancel': ['已支付订单取消后进入退款中', '超时未支付订单自动取消'] } })
  f.design(baseModel())
  assert.equal(f.check().code, 0)
  // 能力目录不存在或缺少能力前缀时同样无效。
  const model = baseModel()
  model.machines[0].transitions[2].scenarios = ['已支付订单取消后进入退款中']
  f.design(model)
  assert.deepEqual(findings(f.check().json()), ['CM-3:T5'])
})

test('check：修改的迁移 T3 没有 before 时退出码 1，按 CM-4 报告 T3', t => {
  const f = fixture(t)
  const model = baseModel()
  delete model.machines[0].transitions[1].before
  f.design(model)
  const result = f.check()
  assert.equal(result.code, 1)
  assert.deepEqual(findings(result.json()), ['CM-4:T3'])
})

test('check：状态 CLOSED 已删除而未变迁移 T2 的 to 仍为 CLOSED 时，按 CM-6 报告 T2', t => {
  const f = fixture(t)
  const model = baseModel()
  model.machines[0].states.push({ id: 'CLOSED', name: '已关闭', final: true, diff: 'removed' })
  model.machines[0].transitions.push({ id: 'T2', from: 'PENDING', to: 'CLOSED', trigger: '支付超时' })
  f.design(model)
  const result = f.check()
  assert.equal(result.code, 1)
  assert.deepEqual(findings(result.json()), ['CM-6:T2'])
  // 迁移本身也标为删除时不再报告。
  model.machines[0].transitions[3].diff = 'removed'
  f.design(model)
  assert.equal(f.check().code, 0)
})

test('check：未删除的连线指向已删除的步骤时报 CM-6', t => {
  const f = fixture(t)
  const model = baseModel()
  model.flows[0].steps[0].diff = 'removed'
  f.design(model)
  assert.deepEqual(findings(f.check().json()), ['CM-6:S1->S2'])
})

test('check：design.md 存在但没有「可视化判定」小节时退出码 1，报告 CM-5', t => {
  const f = fixture(t)
  f.design(null, { section: '' })
  const result = f.check()
  assert.equal(result.code, 1)
  assert.deepEqual(result.json().blocking.map(item => item.rule), ['CM-5'])
})

test('check：小节声明状态变动命中 order-status 而模型没有该状态机时报 CM-5', t => {
  const f = fixture(t)
  f.design(null, { section: ['## 可视化判定', '', '- 状态变动：命中 → machines: order-status', '- 流程变动：未命中（不修改流程）', ''].join('\n') })
  const result = f.check()
  assert.equal(result.code, 1)
  assert.deepEqual(findings(result.json()), ['CM-5:order-status'])
})

test('check：模型中的流程没有在小节中声明、缺少某一行或格式错误时报 CM-5', t => {
  const f = fixture(t)
  const model = baseModel()
  f.design(model, { section: ['### 可视化判定', '', '- 状态变动：命中 → machines: `order-status`', '- 流程变动：未命中', ''].join('\n') })
  assert.deepEqual(findings(f.check().json()), ['CM-5:cancel-order'])
  f.design(model, { section: ['## 可视化判定', '', '- 状态变动：命中 → machines: order-status', ''].join('\n') })
  assert.deepEqual(findings(f.check().json()), ['CM-5:流程变动', 'CM-5:cancel-order'])
  f.design(model, { section: ['## 可视化判定', '', '- 状态变动：命中 → flows: order-status', '- 流程变动：命中 → flows: cancel-order', ''].join('\n') })
  assert.deepEqual(findings(f.check().json()), ['CM-5:状态变动', 'CM-5:order-status'])
})

test('check：两条都未命中且没有模型时通过；代码块中的同名标题不算小节', t => {
  const f = fixture(t)
  f.design(null, { section: ['## 可视化判定', '', '- 状态变动：未命中', '- 流程变动：未命中', ''].join('\n') })
  assert.equal(f.check().code, 0)
  f.design(null, { section: ['```markdown', '## 可视化判定', '- 状态变动：未命中', '- 流程变动：未命中', '```', ''].join('\n') })
  assert.deepEqual(f.check().json().blocking.map(item => item.rule), ['CM-5'])
})

test('check：没有 design.md 的变更退出码 0，不要求可视化判定', t => {
  const f = fixture(t)
  f.change('proposal.md', '## Why\n\n订单取消。\n')
  const result = f.check()
  assert.equal(result.code, 0, result.out + result.err)
  assert.deepEqual(result.json().blocking, [])
})

test('check：迁移 trigger 为「用户退单」且「退单」是禁用别名时，报告 CM-2 及替代词「取消」与所在行', t => {
  const f = fixture(t)
  const model = baseModel()
  model.machines[0].transitions[2].trigger = '用户退单'
  // before 中的旧值不检查：旧叫法正是被改掉的内容。
  model.machines[0].transitions[1].before = { guard: '创建后 15 分钟', trigger: '撤单' }
  f.design(model)
  const result = f.check()
  assert.equal(result.code, 1)
  const report = result.json()
  assert.equal(report.blocking.length, 1)
  const [item] = report.blocking
  assert.deepEqual({ rule: item.rule, text: item.text, replacement: item.replacement, steRule: item.steRule },
    { rule: 'CM-2', text: '退单', replacement: '取消', steRule: 'C-R1.11' })
  assert.equal(item.path, 'machines[0].transitions[2].trigger')
  const lines = readFileSync(join(f.changeRoot, 'design.md'), 'utf8').split('\n')
  assert.match(lines[item.line - 1], /用户退单/)
})

test('check：找不到 openspec-ste 时跳过 CM-2 并告警，其他规则照常执行', t => {
  // 只复制本 skill 到临时 skills 目录，模拟未安装 openspec-ste。
  const skills = mkdtempSync(join(tmpdir(), 'change-model-skills-'))
  t.after(() => rmSync(skills, { recursive: true, force: true }))
  const skillDir = join(skills, 'openspec-change-overview')
  cpSync(SKILL_DIR, skillDir, { recursive: true })
  const f = fixture(t, { skillDir })
  const model = baseModel()
  model.machines[0].transitions[2].trigger = '用户退单'
  delete model.machines[0].transitions[1].before
  f.design(model)
  const result = f.check()
  assert.equal(result.code, 1)
  const report = result.json()
  assert.deepEqual(findings(report), ['CM-4:T3'])
  assert.equal(report.warnings.length, 1)
  assert.equal(report.warnings[0].rule, 'CM-2')
  assert.match(report.warnings[0].detail, /CM-2.*跳过|跳过.*CM-2/)
})

// ---------------------------------------------------------------------------
// Slice 02：并集布局生成离线 overview.html（Seam：layout / render）
// ---------------------------------------------------------------------------

/** 在基础模型上加入删除的状态与改了终点的迁移，覆盖并集布局的全部情形。 */
function unionModel() {
  const model = baseModel()
  model.machines[0].states.push({ id: 'CLOSED', name: '已关闭', final: true, diff: 'removed' })
  model.machines[0].transitions[1].before = { to: 'CLOSED', guard: '创建后 15 分钟' }
  return model
}

test('layout：T3 修改时，T3 的条目含 diff: changed、路径点与 before 旧值', t => {
  const f = fixture(t)
  f.design(baseModel())
  const result = f.run(['layout', f.changeRoot])
  assert.equal(result.code, 0, result.err)
  const layout = result.json()
  const machine = layout.machines.find(item => item.id === 'order-status')
  const t3 = machine.edges.find(edge => edge.id === 'T3')
  assert.equal(t3.diff, 'changed')
  assert.deepEqual(t3.before, { guard: '创建后 15 分钟' })
  assert.ok(t3.points.length >= 2)
  for (const point of t3.points) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y))
  const t1 = machine.edges.find(edge => edge.id === 'T1')
  assert.equal(t1.diff, 'unchanged')
  assert.deepEqual(layout.flows[0].nodes.find(node => node.id === 'S5').causes, ['T5'])
  assert.deepEqual(t3.scenarios, ['order-cancel/超时未支付订单自动取消'])
})

test('layout：并集布局包含删除与新增的元素，每个元素只有一组坐标；改了终点的迁移另有旧路线', t => {
  const f = fixture(t)
  f.design(unionModel())
  const machine = f.run(['layout', f.changeRoot]).json().machines[0]
  assert.deepEqual(machine.nodes.map(node => node.id), ['CANCELLED', 'CLOSED', 'PAID', 'PENDING', 'REFUNDING'])
  const closed = machine.nodes.find(node => node.id === 'CLOSED')
  assert.equal(closed.diff, 'removed')
  assert.ok(closed.width > 0 && closed.height > 0 && Number.isFinite(closed.x))
  const ghost = machine.edges.find(edge => edge.id === 'T3@before')
  assert.deepEqual({ of: ghost.of, route: ghost.route, from: ghost.from, to: ghost.to }, { of: 'T3', route: 'before', from: 'PENDING', to: 'CLOSED' })
  assert.equal(machine.edges.filter(edge => edge.id === 'T3').length, 1)
})

test('layout：节点与连线标签输出按布局规则折好的当前与变更前文字行，超长英文词逐字拆开', t => {
  const f = fixture(t)
  const model = baseModel()
  // 34 个半角字符 × 8px = 272px，超过连线标签单行上限 140px，每行最多 17 个字符。
  model.machines[0].transitions[0].trigger = 'refundCompensationCallbackReceived'
  model.machines[0].states[1] = { id: 'PAID', name: '已支付', diff: 'changed', before: { name: '已付款' } }
  // 41 个半角字符 × 8px = 328px，超过节点文字单行上限 168px，每行最多 21 个字符。
  model.flows[0].steps[0].name = 'receiveCancellationRequestFromCustomerApp'
  f.design(model)
  const result = f.run(['layout', f.changeRoot])
  assert.equal(result.code, 0, result.out + result.err)
  const layout = result.json()
  const machine = layout.machines[0]
  const t1 = machine.edges.find(edge => edge.id === 'T1')
  assert.deepEqual(t1.lines, ['refundCompensatio', 'nCallbackReceived'])
  assert.deepEqual(t1.beforeLines, ['refundCompensatio', 'nCallbackReceived'])
  // 标签框按两行留高（行高 18px），视频按 lines 绘制即可放进框内。
  assert.equal(t1.labelBox.height, 36)
  const paid = machine.nodes.find(node => node.id === 'PAID')
  assert.deepEqual({ lines: paid.lines, beforeLines: paid.beforeLines }, { lines: ['已支付'], beforeLines: ['已付款'] })
  const flow = layout.flows[0]
  assert.deepEqual(flow.nodes.find(node => node.id === 'S1').lines, ['receiveCancellationRe', 'questFromCustomerApp'])
  // 没有标签的连线输出空行列表。
  assert.deepEqual(flow.edges.find(edge => edge.id === 'S1->S2').lines, [])
  assert.deepEqual(flow.edges.find(edge => edge.id === 'S2->S5').lines, ['已支付'])
})

test('layout：两次运行输出字节一致', t => {
  const f = fixture(t)
  f.design(unionModel())
  const first = f.run(['layout', f.changeRoot])
  const second = f.run(['layout', f.changeRoot])
  assert.equal(first.code, 0, first.err)
  assert.equal(first.out, second.out)
})

test('layout：模型存在阻断项时输出检查报告并退出码 1', t => {
  const f = fixture(t)
  const model = baseModel()
  delete model.machines[0].transitions[1].before
  f.design(model)
  const result = f.run(['layout', f.changeRoot])
  assert.equal(result.code, 1)
  assert.equal(result.json().verdict, 'BLOCKED')
})

/** 读出 overview.html 中内联的布局 JSON。 */
function inlineLayout(html) {
  const match = /<script type="application\/json" id="cm-data">([\s\S]*?)<\/script>/.exec(html)
  assert.ok(match, '缺少内联布局 JSON')
  return JSON.parse(match[1])
}

test('render：写入单个 overview.html，内联 SVG 与布局 JSON，不引用任何外部 URL、字体、脚本或样式表', t => {
  const f = fixture(t)
  f.design(unionModel())
  const result = f.run(['render', f.changeRoot])
  assert.equal(result.code, 0, result.out + result.err)
  const html = readFileSync(join(f.changeRoot, 'overview.html'), 'utf8')
  assert.doesNotMatch(html, /https?:\/\//)
  assert.doesNotMatch(html, /<link\b|<script[^>]+src=|@import|url\((?!#)/)
  assert.match(html, /<svg class="graph"/)
  assert.deepEqual(inlineLayout(html), f.run(['layout', f.changeRoot]).json())
})

test('render：两次输出字节一致；每个元素在 SVG 中只出现一次，未变元素的坐标取自同一次布局', t => {
  const f = fixture(t)
  f.design(unionModel())
  f.run(['render', f.changeRoot])
  const first = readFileSync(join(f.changeRoot, 'overview.html'), 'utf8')
  f.run(['render', f.changeRoot])
  assert.equal(readFileSync(join(f.changeRoot, 'overview.html'), 'utf8'), first)
  const layout = inlineLayout(first)
  for (const node of layout.machines[0].nodes) {
    const groups = first.match(new RegExp(`<g class="cm-el cm-node[^"]*" data-key="machine/order-status/${node.id}"[^>]*>`, 'g'))
    assert.equal(groups.length, 1, node.id)
    assert.match(groups[0], new RegExp(`transform="translate\\(${node.x},${node.y}\\)"`))
  }
  assert.match(first, /data-key="machine\/order-status\/T3@before"/)
})

test('render：模型存在阻断项时退出码 1，不创建也不覆盖 overview.html', t => {
  const f = fixture(t)
  const model = baseModel()
  delete model.machines[0].transitions[2].scenarios
  f.design(model)
  const result = f.run(['render', f.changeRoot])
  assert.equal(result.code, 1)
  assert.equal(result.json().verdict, 'BLOCKED')
  assert.equal(existsSync(join(f.changeRoot, 'overview.html')), false)
  f.change('overview.html', '旧文件')
  assert.equal(f.run(['render', f.changeRoot]).code, 1)
  assert.equal(readFileSync(join(f.changeRoot, 'overview.html'), 'utf8'), '旧文件')
})

test('render：没有变更模型时不创建 overview.html，退出码 0', t => {
  const f = fixture(t)
  f.design(null)
  const result = f.run(['render', f.changeRoot])
  assert.equal(result.code, 0, result.out + result.err)
  assert.equal(existsSync(join(f.changeRoot, 'overview.html')), false)
})

// ---------------------------------------------------------------------------
// Slice 03：overview.md 嵌入派生 Mermaid（Seam：mermaid）
// ---------------------------------------------------------------------------

/** 取 mermaid 输出中某张图的代码块内容（按行，去掉缩进）。 */
function mermaidBlock(out, heading) {
  const start = out.indexOf(heading)
  assert.ok(start >= 0, `缺少 ${heading}`)
  const body = out.slice(out.indexOf('```mermaid', start) + '```mermaid'.length)
  return body.slice(0, body.indexOf('```')).split('\n').map(line => line.trim()).filter(Boolean)
}

test('mermaid：状态机输出 stateDiagram-v2，变动状态用 classDef 着色，迁移标签带 ➕ / ✏️ / ❌ 前缀', t => {
  const f = fixture(t)
  f.design(unionModel())
  const result = f.run(['mermaid', f.changeRoot])
  assert.equal(result.code, 0, result.out + result.err)
  const lines = mermaidBlock(result.out, '#### 状态机：订单状态（order-status）')
  assert.equal(lines[0], 'stateDiagram-v2')
  for (const diff of ['added', 'changed', 'removed']) assert.ok(lines.some(line => line.startsWith(`classDef ${diff} `)), diff)
  assert.ok(lines.includes('state "待支付" as PENDING'))
  assert.ok(lines.includes('[*] --> PENDING'))
  assert.ok(lines.includes('CANCELLED --> [*]'))
  assert.ok(lines.includes('PENDING --> PAID : 支付成功'))
  assert.ok(lines.includes('PAID --> REFUNDING : ➕ 用户取消'))
  assert.ok(lines.includes('PENDING --> CANCELLED : ✏️ 超时关闭 [创建后 30 分钟]'))
  // 改了终点的迁移：旧路线按删除画出。
  assert.ok(lines.includes('PENDING --> CLOSED : ❌ 超时关闭 [创建后 15 分钟]'))
  assert.ok(lines.includes('class REFUNDING added'))
  assert.ok(lines.includes('class CLOSED removed'))
})

test('mermaid：流程输出 flowchart TD，节点用 classDef 着色，连线按顺序用 linkStyle 着色', t => {
  const f = fixture(t)
  const model = baseModel()
  model.flows[0].steps.push({ id: 'S3', name: '关闭未支付订单' })
  model.flows[0].edges.unshift({ from: 'S1', to: 'S3', diff: 'removed' })
  f.design(model)
  const lines = mermaidBlock(f.run(['mermaid', f.changeRoot]).out, '#### 流程：用户取消订单（cancel-order）')
  assert.equal(lines[0], 'flowchart TD')
  assert.ok(lines.includes('S1["接收取消请求"]'))
  assert.ok(lines.includes('S2{"判断是否已支付"}'))
  assert.deepEqual(lines.filter(line => line.includes('-->') || line.includes('-.->')),
    ['S1 -.-> S3', 'S1 --> S2', 'S2 -->|已支付| S5'])
  assert.ok(lines.some(line => /^linkStyle 0 stroke:#de8c8c.*stroke-dasharray/.test(line)))
  assert.ok(lines.some(line => /^linkStyle 1 stroke:#6bb486/.test(line)))
  assert.ok(lines.some(line => /^linkStyle 2 stroke:#6bb486/.test(line)))
  assert.ok(lines.includes('class S2,S5 added'))
})

test('mermaid：两次输出一致；模型存在阻断项时输出检查报告并退出码 1；没有变更模型时输出为空', t => {
  const f = fixture(t)
  f.design(unionModel())
  assert.equal(f.run(['mermaid', f.changeRoot]).out, f.run(['mermaid', f.changeRoot]).out)
  const model = baseModel()
  delete model.machines[0].transitions[1].before
  f.design(model)
  const blocked = f.run(['mermaid', f.changeRoot])
  assert.equal(blocked.code, 1)
  assert.equal(blocked.json().verdict, 'BLOCKED')
  f.design(null)
  const empty = f.run(['mermaid', f.changeRoot])
  assert.equal(empty.code, 0)
  assert.equal(empty.out, '')
})

// ---------------------------------------------------------------------------
// Slice 05：双轴评审条件闭环（Seam：check）
// ---------------------------------------------------------------------------

test('check：命中行末尾的括号备注不当作 ID，与未命中行一致', t => {
  const f = fixture(t)
  f.design(baseModel(), { section: ['## 可视化判定', '',
    '- 状态变动：命中 → machines: order-status（只涉及订单状态）',
    '- 流程变动：命中 → flows: cancel-order (以取消流程为代表)', ''].join('\n') })
  const result = f.check()
  assert.equal(result.code, 0, result.out)
  // 备注之外的 ID 仍然要与模型一致。
  f.design(baseModel(), { section: ['## 可视化判定', '',
    '- 状态变动：命中 → machines: order-status, refund-status（含退款单）',
    '- 流程变动：命中 → flows: cancel-order', ''].join('\n') })
  assert.deepEqual(findings(f.check().json()), ['CM-5:refund-status'])
})
