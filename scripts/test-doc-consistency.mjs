import { readFile, readdir } from 'node:fs/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 规则副本与事实源的一致性测试。
 *
 * 流程文档（workflow/）是面向人的完整汇总，刻意复制了部分规则正文；workflow 脚本也把分级映射写成常量。
 * 此前 finding 字段数、汇总项数、矩阵维度都因「只改了一处」而漂移。这里把带「📌 同步副本」标注的区块
 * 与对应事实源逐项比对，任一侧改动而另一侧没跟上，测试即失败。
 */
const read = rel => readFile(new URL(`../${rel}`, import.meta.url), 'utf8')

const GATE_LEVELS = 'skills/openspec-technical-review/shared/gate-levels.md'
const PROCESS_DOC = 'workflow/OpenSpec-AI-研发流程.md'
const ROLE_KEYS = ['architecture', 'concurrency', 'performance', 'database', 'security']

/** 从分级表中取 L1–L3 各自的纳入维度；「五维度全跑」视为全部维度。 */
function levelRoles(markdown) {
  const result = {}
  for (const level of ['L1', 'L2', 'L3']) {
    const row = markdown.split('\n').find(line => line.startsWith(`| **${level} `))
    assert.ok(row, `分级表缺少 ${level} 行`)
    const cell = row.split('|')[3]
    result[level] = cell.includes('五维度全跑') ? [...ROLE_KEYS] : ROLE_KEYS.filter(k => cell.includes(k))
  }
  return result
}

/** 取标题之后第一段以 prefix 开头的连续行（列表或表格）。 */
function firstRun(markdown, heading, prefix) {
  const rest = markdown.split(heading)[1]
  assert.ok(rest, `缺少标题：${heading}`)
  const lines = rest.split('\n')
  const start = lines.findIndex(l => l.startsWith(prefix))
  assert.ok(start >= 0, `${heading} 之后没有以 ${prefix} 开头的行`)
  const end = lines.findIndex((l, i) => i > start && !l.startsWith(prefix))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

/** 取以 firstLine 开头的 ```markdown 代码块正文。 */
function fencedBlock(markdown, firstLine) {
  const match = [...markdown.matchAll(/```markdown\n([\s\S]*?)```/g)].find(m => m[1].startsWith(firstLine))
  assert.ok(match, `缺少以「${firstLine}」开头的 markdown 代码块`)
  return match[1]
}

test('分级维度：gate-levels.md、workflow 脚本常量、流程文档三处一致', async () => {
  const [source, doc, workflow] = await Promise.all([
    read(GATE_LEVELS),
    read(PROCESS_DOC),
    read('skills/openspec-technical-review/technical-review-gate.workflow.js'),
  ])
  const expected = levelRoles(source)
  const literal = workflow.match(/const LEVEL_ROLES = (\{[\s\S]*?\n\})/)
  assert.ok(literal, 'workflow 脚本缺少 LEVEL_ROLES 常量')
  const constant = Function(`return ${literal[1]}`)()
  for (const level of Object.keys(expected)) {
    assert.deepEqual([...constant[level]].sort(), [...expected[level]].sort(), `workflow LEVEL_ROLES.${level} 与 gate-levels.md 不一致`)
  }
  assert.deepEqual(levelRoles(doc), expected, '流程文档「分级对照表」与 gate-levels.md 不一致')
})

test('升级信号：流程文档清单与 gate-levels.md 逐条一致，判定流程图条数一致', async () => {
  const [source, doc] = await Promise.all([read(GATE_LEVELS), read(PROCESS_DOC)])
  const expected = firstRun(source, '## 触发升级的信号', '- ')
  assert.equal(firstRun(doc, '### 触发升级的信号', '- '), expected)
  const chart = doc.split('### 快速判定流程图')[1].split('```')[1]
  const bullets = chart.split('\n').filter(l => l.includes('•'))
  assert.equal(bullets.length, expected.split('\n').length, '流程图中的升级信号条数与 gate-levels.md 不一致')
})

test('第一性原理与交叉验证：模板和判据表与事实源逐字一致', async () => {
  const doc = await read(PROCESS_DOC)
  for (const [file, templateHead, criteriaHeading] of [
    ['skills/openspec-explore/shared/first-principles.md', '## 第一性原理分析\n', '第一性原理分析的判据'],
    ['skills/openspec-explore/shared/cross-validation.md', '## 候选方案交叉验证矩阵\n', '方案交叉验证的判据'],
  ]) {
    const source = await read(file)
    assert.equal(fencedBlock(doc, templateHead), fencedBlock(source, templateHead), `流程文档的模板与 ${file} 不一致`)
    assert.equal(
      firstRun(doc, `### ${criteriaHeading}`, '|'),
      firstRun(source, `## ${criteriaHeading}`, '|'),
      `流程文档的判据表与 ${file} 不一致`,
    )
  }
})

test('finding 字段数：各文档写的数量与 finding-format.md 一致', async () => {
  const format = await read('skills/openspec-technical-review/shared/finding-format.md')
  const declared = format.match(/\*\*(\d+) 个字段\*\*/)
  assert.ok(declared, 'finding-format.md 缺少「**N 个字段**」声明')
  const files = [
    ...(await readdir(new URL('../workflow/', import.meta.url))).filter(f => f.endsWith('.md')).map(f => `workflow/${f}`),
    ...(await readdir(new URL('../docs/', import.meta.url))).filter(f => f.endsWith('.md')).map(f => `docs/${f}`),
    'README.md',
    'skills/openspec-finding-explain/SKILL.md',
  ]
  for (const file of files) {
    const lines = (await read(file)).split('\n')
    lines.forEach((line, i) => {
      if (!/finding/i.test(line)) return
      for (const m of line.matchAll(/(\d+)\s*个字段/g)) {
        assert.equal(m[1], declared[1], `${file}:${i + 1} 写的是 ${m[1]} 个字段，事实源为 ${declared[1]} 个`)
      }
    })
  }
})
