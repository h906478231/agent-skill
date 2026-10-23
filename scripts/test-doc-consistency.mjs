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

/**
 * git 边界说明（guard-agent-git-on-artifacts）。
 * 命令与 skill 曾写「产物提交 git」，执行 agent 把这句生命周期说明当作步骤，对被 .gitignore 忽略的
 * openspec/ 执行了 git add -f。下列文件说明变更目录产物的去向时，必须逐字带这句话；改措辞时全部文件一起改。
 */
const GIT_GUARD = '不执行 `git add` 或 `git commit`。项目 `.gitignore` 忽略 `openspec/` 时，不得用 `git add -f` 加入产物。是否提交由用户决定。'
const GIT_GUARD_FILES = [
  'claude/commands/opsx/review.md',
  'claude/commands/opsx/quality.md',
  'claude/commands/opsx/overview.md',
  'claude/commands/opsx/explain.md',
  'claude/commands/opsx/video.md',
  'skills/openspec-code-quality/SKILL.md',
  'skills/openspec-code-quality/shared/dual-axis-review.md',
  'skills/openspec-apply-change/shared/slice-evidence.md',
  // 登记表与验收部署文档的规则文件各有「产物的 git 边界」一节。写字面量：CHANGE_RULES 在下文定义，此处引用会抛出 ReferenceError。
  'skills/openspec-apply-change/shared/post-implementation-changes.md',
  'skills/openspec-apply-change/shared/deployment-document.md',
  'skills/openspec-discussion-sync/SKILL.md',
  'skills/openspec-change-overview/SKILL.md',
  // 面向人的流程文档保留「门禁产物提交 git」的策略，同时写明 agent 不执行提交、以项目 .gitignore 为准。
  PROCESS_DOC,
  'workflow/quickstart-guide.md',
]
/** 扫描范围只含 agent 读取的命令与 skill；workflow/、docs/ 面向人，按策略写「提交 git」是正确内容。 */
const AGENT_READ_DIRS = ['claude/commands', 'skills']
/** 项目级资产（CONTEXT.md、docs/adr/）在 openspec/ 之外，不随变更归档，保留「提交 git」的说明。 */
const PROJECT_ASSET_MARK = '项目级资产'

/** 递归列出 dir（相对仓库根）下的文件，跳过 node_modules；不用 readdir 的 recursive 选项，兼容 Node 16。 */
async function listFiles(dir) {
  const files = []
  for (const entry of await readdir(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...(await listFiles(rel)))
    } else {
      files.push(rel)
    }
  }
  return files
}

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

test('git 边界说明：说明变更目录产物去向的文件逐字带同一句话', async () => {
  const missing = []
  for (const file of GIT_GUARD_FILES) {
    if (!(await read(file)).includes(GIT_GUARD)) missing.push(file)
  }
  assert.deepEqual(missing, [], `以下文件缺少 git 边界说明：${missing.join('、')}`)
})

test('git 边界说明：命令与 skill 不再要求提交变更目录产物', async () => {
  const hits = []
  for (const dir of AGENT_READ_DIRS) {
    for (const file of (await listFiles(dir)).filter(f => /\.(md|mjs|js)$/.test(f))) {
      const lines = (await read(file)).split('\n')
      lines.forEach((line, i) => {
        if (/提交 ?git/.test(line) && !line.includes(PROJECT_ASSET_MARK)) hits.push(`${file}:${i + 1}`)
      })
    }
  }
  assert.deepEqual(hits, [], `以下位置仍要求提交 git（改为随 openspec archive 归档并加 git 边界说明）：\n${hits.join('\n')}`)
})

/**
 * 实现后修改登记（tier-post-implementation-changes D1）。
 * post-implementation-changes.md 是唯一事实源；门禁脚本按同一组档位与区块标题读取登记表，
 * quality、closed-loop 与流程文档只引用事实源，不再写「门禁外提交先登记任务」的旧规则。
 */
const CHANGE_RULES = 'skills/openspec-apply-change/shared/post-implementation-changes.md'
const CHANGE_RULE_REFERRERS = [
  'skills/openspec-apply-change/SKILL.md',
  'claude/commands/opsx/apply.md',
  'skills/openspec-code-quality/SKILL.md',
  'skills/openspec-code-quality/shared/dual-axis-review.md',
  'skills/openspec-technical-review/shared/closed-loop-verification.md',
  'claude/commands/opsx/quality.md',
  PROCESS_DOC,
]

/** 概述登记要点的 skill、命令副本与流程文档：必须写到登记指纹，同一文件再次修改要新增一行（design D1）。 */
const LEDGER_FINGERPRINT_REFERRERS = ['skills/openspec-apply-change/SKILL.md', 'claude/commands/opsx/apply.md', PROCESS_DOC]

test('实现后修改登记：事实源的档位与登记表标题、列和门禁脚本一致', async () => {
  const rules = await read(CHANGE_RULES)
  const gate = await read('skills/openspec-technical-review/scripts/implementation-gate.mjs')
  const tiers = [...gate.match(/const CHANGE_TIERS = \[([^\]]*)\]/)[1].matchAll(/'([^']+)'/g)].map(m => m[1])
  const title = gate.match(/const CHANGE_LEDGER_TITLE = '([^']+)'/)[1]
  assert.deepEqual(tiers, ['非行为', '等价', '行为'])
  assert.ok(rules.includes(`## ${title}\n`), `事实源缺少登记表标题 ## ${title}`)
  assert.ok(rules.includes('| 编号 | 文件 | 提交 | 登记指纹 | 档位 | 判定依据 | 验证 | 判定人 | 日期 |'), '事实源缺少登记表表头')
  // 门禁脚本按登记指纹核对登记之后是否又有修改，旧规则「同一文件再次修改时不新增一行」不再成立。
  assert.ok(!rules.includes('不新增一行'), '事实源仍写「同一文件再次修改时不新增一行」')
  for (const tier of tiers) {
    const rows = rules.split('\n').filter(line => line.startsWith(`| \`${tier}\` |`))
    assert.equal(rows.length, 2, `事实源「三档判定」与「各档最少动作」应各有一行 ${tier}`)
  }
  const missing = []
  for (const file of LEDGER_FINGERPRINT_REFERRERS) {
    if (!(await read(file)).includes('登记指纹')) missing.push(file)
  }
  assert.deepEqual(missing, [], '以下文件概述登记要点但没有写登记指纹')
})

test('实现后修改登记：各阶段规则引用事实源，不再要求门禁外提交只能新增任务', async () => {
  const missing = []
  const stale = []
  for (const file of CHANGE_RULE_REFERRERS) {
    const text = await read(file)
    if (!text.includes('post-implementation-changes.md')) missing.push(file)
    text.split('\n').forEach((line, i) => {
      // 旧规则只有「新增任务」一种登记方式；新规则按档位登记，行为档位才新增任务，因此同一行必然写到档位。
      if (/门禁外提交/.test(line) && /(?:新增|登记)(?:一个)?任务/.test(line) && !line.includes('档位')) stale.push(`${file}:${i + 1}`)
    })
  }
  assert.deepEqual(missing, [], `以下文件未引用 ${CHANGE_RULES}`)
  assert.deepEqual(stale, [], `以下位置仍是「门禁外提交先登记任务」的旧规则：\n${stale.join('\n')}`)
})

/**
 * classify 的登记判定与 issues 分类（STD-11）。
 * 登记流程读事实源「何时登记」，apply、verify 查 classify 输出时读 slice-evidence.md「命令级校验」，两处各写一遍。
 * 保留两处，由本测试逐句比较登记条件与两类 issues 的整句：只改一处而另一处没跟上时测试失败。
 * 比较范围之外的句子（如事实源的「用登记指纹核对」、slice-evidence.md 的「档位取最高档位」）允许只写在一处。
 */
const LEDGER_RULE_SECTIONS = [
  [CHANGE_RULES, '何时登记'],
  ['skills/openspec-apply-change/shared/slice-evidence.md', '命令级校验'],
]
/** 两处必须逐字相同的文字；第 1 个捕获组是比较的内容，列表项的缩进与「- 」不计入。 */
const LEDGER_RULE_PARTS = [
  ['登记条件', /(`other` 中的文件算登记：[^\n]*?能证明登记。)/],
  ['行级问题', /^\s*- (行级问题：.*)$/m],
  ['文件级问题', /^\s*- (文件级问题：.*)$/m],
]
/** 比较的文字中必须含有的 3 句关键口径，防止两处同时删掉同一句。 */
const LEDGER_RULE_SENTENCES = [
  ['只有档位不是 `非行为` 的合法行能证明登记', /只有档位不是 `非行为` 的合法行能证明登记/],
  ['行级问题……只写登记编号与原因', /行级问题：[^\n]*只写登记编号与原因/],
  ['文件级问题：只写给列入 `unregistered` 的文件', /文件级问题：只写给列入 `unregistered` 的文件/],
]

/** 取二级标题 heading 的小节正文，到下一个二级标题为止。 */
function sectionBody(markdown, heading) {
  const rest = markdown.split(`\n## ${heading}\n`)[1]
  assert.ok(rest, `缺少小节：## ${heading}`)
  return rest.split('\n## ')[0]
}

test('实现后修改登记：「何时登记」与「命令级校验」的登记判定与 issues 分类逐句相同', async () => {
  const [source, copy] = await Promise.all(LEDGER_RULE_SECTIONS.map(async ([file, heading]) => {
    const body = sectionBody(await read(file), heading)
    return Object.fromEntries(LEDGER_RULE_PARTS.map(([label, pattern]) => {
      const match = body.match(pattern)
      assert.ok(match, `${file}「${heading}」缺少${label}`)
      return [label, match[1].split(/(?<=。)/)]
    }))
  }))
  for (const [label] of LEDGER_RULE_PARTS) {
    assert.deepEqual(copy[label], source[label], `「${label}」在两个小节中不是逐字相同`)
  }
  const text = Object.values(source).flat().join('')
  for (const [label, pattern] of LEDGER_RULE_SENTENCES) assert.match(text, pattern, `比较的文字中缺少：${label}`)
})

/**
 * 新增任务内修改的登记豁免（SPEC-12、SPEC-13，design D3）。
 * 豁免只给「只在」新增并已勾选的任务内修改的文件；勾选之后又有修改（如门禁外提交）时照常登记。
 * 事实源登记步骤与重跑前的 3 处判定写同一口径：漏写「只在」，门禁外提交就能借同一文件的新增任务不登记；
 * 漏写「对应不上或拿不准时照常登记」，核对不出归属的修改就会按豁免处理。
 */
const firstLine = prefix => text => text.split('\n').find(line => line.startsWith(prefix))
/** 判断方法的事实源：登记步骤第 6 步。用具名常量取，数组顺序改变时检查对象不变（STD-13）。 */
const TASK_EXEMPTION_SOURCE = [CHANGE_RULES, '登记步骤第 6 步', firstLine('6. 再次运行 `classify`')]
const TASK_EXEMPTION_SITES = [
  TASK_EXEMPTION_SOURCE,
  ['skills/openspec-code-quality/SKILL.md', '前置', text => sectionBody(text, '前置')],
  ['claude/commands/opsx/quality.md', '重跑前的 classify', firstLine('- 重跑前先运行')],
  ['skills/openspec-technical-review/shared/closed-loop-verification.md', '门禁外提交', firstLine('- **门禁外提交**')],
]
const TASK_EXEMPTION_PHRASES = ['只在新增并已勾选的任务内修改', '勾选之后又有修改时照常登记', '对应不上或拿不准时照常登记']
/**
 * 判断方法只写在登记步骤第 6 步，其他 3 处引用它（SPEC-13、STD-12）。
 * 完整套件刷新证据时会覆盖 `Fingerprint`，勾选时的指纹之后读不到，所以不能以它为 `--from`；改为逐处核对修改内容。
 * 旧方法在 4 处都不得出现：引用方写回旧方法时，测试同样失败。
 * `git diff` 默认输出 3 行上下文，两处修改之间不超过 6 行未修改的行时合成一个 `@@` 区块，「处」没有单位；
 * 第 6 步必须用 `-U0` 并写明每个区块算一处（STD-14）。
 * 引用方不得复制命令：占位符 `修改前指纹的 sha` 只出现在第 6 步的命令中，复制后第 6 步再改写时副本会过期。
 * 不用 `git diff` 作禁止项，原因是 SKILL.md「前置」第 2 步有 `git diff --stat`。
 * 禁止项按整个文件检查：两个引用方的取值区域只有 1 行，只查区域时，写到相邻行的文字查不出来（STD-01）。
 */
const TASK_EXEMPTION_METHOD = {
  required: ['逐处核对', 'git diff -U0', '每个 `@@` 区块算一处'],
  forbidden: '勾选时切片证据',
  referrerForbidden: '修改前指纹的 sha',
}

test('实现后修改登记：新增任务内修改的登记豁免在事实源与重跑判定中都限定为「只在」任务内修改', async () => {
  const problems = []
  let step
  for (const site of TASK_EXEMPTION_SITES) {
    const [file, label, pick] = site
    const text = await read(file)
    const region = pick(text)
    assert.ok(region, `${file} 缺少「${label}」`)
    if (site === TASK_EXEMPTION_SOURCE) step = region
    else if (text.includes(TASK_EXEMPTION_METHOD.referrerForbidden)) {
      problems.push(`${file}：复制了第 6 步的命令（含「${TASK_EXEMPTION_METHOD.referrerForbidden}」）`)
    }
    for (const phrase of TASK_EXEMPTION_PHRASES) {
      if (!region.includes(phrase)) problems.push(`${file}「${label}」：${phrase}`)
    }
    if (text.includes(TASK_EXEMPTION_METHOD.forbidden)) problems.push(`${file}：仍写「${TASK_EXEMPTION_METHOD.forbidden}」`)
  }
  const [file, label] = TASK_EXEMPTION_SOURCE
  for (const phrase of TASK_EXEMPTION_METHOD.required) {
    if (!step.includes(phrase)) problems.push(`${file}「${label}」：${phrase}`)
  }
  assert.deepEqual(problems, [], '以下位置的登记豁免口径与登记步骤第 6 步不一致')
})

test('沿用轮：Carried Axis 写法在规则、skill、命令副本与流程文档中与门禁脚本一致', async () => {
  const gate = await read('skills/openspec-technical-review/scripts/implementation-gate.mjs')
  const key = gate.match(/const CARRIED_AXIS_KEY = '([^']+)'/)[1]
  const value = gate.match(/const CARRIABLE_AXIS = Object\.freeze\(\{ value: '([^']+)'/)[1]
  const line = `${key}: ${value}`
  const missing = []
  for (const file of ['skills/openspec-code-quality/shared/dual-axis-review.md', 'skills/openspec-code-quality/SKILL.md',
    'claude/commands/opsx/quality.md', PROCESS_DOC]) {
    if (!(await read(file)).includes(line)) missing.push(file)
  }
  assert.deepEqual(missing, [], `以下文件缺少沿用轮写法 ${line}`)
})

/**
 * 勾选项的阶段边界（tier-post-implementation-changes D6）。
 * task-slicing.md 是排除清单的唯一事实源；写入或修改 tasks 的入口按清单自查，verify 把 taskIssues 记为 CRITICAL。
 * 「发布前三问」增加第 4 问后改名为「发布前四问」，旧名不得残留。
 */
const TASK_RULES = 'skills/openspec-propose/shared/task-slicing.md'
/** verify 的规则文件：除引用排除清单外，还要写 taskIssues 的处理。 */
const TASK_ISSUE_REFERRERS = [
  'skills/openspec-verify-change/SKILL.md',
  'claude/commands/opsx/verify.md',
  'skills/openspec-technical-review/shared/implementation-gate-check.md',
]
const TASK_RULE_REFERRERS = [
  'skills/openspec-propose/SKILL.md',
  'claude/commands/opsx/propose.md',
  'claude/commands/opsx/ff.md',
  'skills/openspec-update-change/SKILL.md',
  'claude/commands/opsx/update.md',
  ...TASK_ISSUE_REFERRERS,
]

test('排除清单：task-slicing.md 列出 E1–E9 及去处，写入 tasks 的入口与 verify 引用排除清单', async () => {
  const rules = await read(TASK_RULES)
  const rows = rules.split('\n').filter(line => /^\| E\d \|/.test(line))
  assert.deepEqual(rows.map(line => line.slice(2, 4)), ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8', 'E9'])
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim())
    assert.ok(cells.length === 3 && cells.every(Boolean), `排除清单行应有编号、内容与去处三列：${row}`)
  }
  assert.ok(rules.includes('## 发布前四问'), `${TASK_RULES} 缺少「发布前四问」`)
  const missing = []
  for (const file of TASK_RULE_REFERRERS) {
    if (!(await read(file)).includes('排除清单')) missing.push(file)
  }
  assert.deepEqual(missing, [], '以下文件未引用排除清单')
  const noTaskIssues = []
  for (const file of TASK_ISSUE_REFERRERS) {
    if (!(await read(file)).includes('taskIssues')) noTaskIssues.push(file)
  }
  assert.deepEqual(noTaskIssues, [], '以下 verify 规则未写 taskIssues 的处理')
  const stale = await findStale([...AGENT_READ_DIRS, 'workflow'], /\.md$/, [/三问/])
  assert.deepEqual(stale, [], `以下位置仍写「三问」：\n${stale.join('\n')}`)
})

/**
 * verify 直接核对评审条件（tier-post-implementation-changes D4、D7）。
 * verify 不再先刷新 overview：条件以 review-summary.md 为准，结果写进 verification.md「评审条件」，archive 读取该小节。
 * 条件只需修改规划产物时，可以映射到 `<文件>:<行号>` 闭环；任务与行号都没有时才视同 Blocker。
 */
const VERIFY_REPORT_FILES = ['skills/openspec-verify-change/SKILL.md', 'claude/commands/opsx/verify.md']
const ARCHIVE_FILES = ['skills/openspec-archive-change/SKILL.md', 'claude/commands/opsx/archive.md']
const CONDITION_COLUMNS = '| 条件 | 映射任务或行号 | 状态 |'
const LINE_REFERENCE = '<文件>:<行号>'
/** 条件清单表格的列名必须为「对应任务或行号」的文件：技术评审 SKILL.md Step 2 与它的 workflow 副本。 */
const CONDITION_COLUMN_FILES = [
  'skills/openspec-technical-review/SKILL.md',
  'skills/openspec-technical-review/technical-review-gate.workflow.js',
]
/** 写有「有条件通过」条件映射规则的文件：design D7 列出的 5 个文件与同步文件，以及该规则在其他 skill、命令副本与流程文档中的副本。 */
const CONDITION_MAPPING_FILES = [
  'skills/openspec-technical-review/shared/gate-policy.md',
  ...CONDITION_COLUMN_FILES,
  'skills/openspec-code-quality/shared/dual-axis-review.md',
  'skills/openspec-technical-review/shared/phase6-verification.md',
  TASK_RULES,
  'skills/openspec-code-quality/SKILL.md',
  'skills/openspec-technical-review/shared/finding-format.md',
  'skills/openspec-change-overview/shared/phase3-gate.md',
  'skills/openspec-change-overview/SKILL.md',
  'claude/commands/opsx/overview.md',
  'claude/commands/opsx/quality.md',
  PROCESS_DOC,
  'workflow/quickstart-guide.md',
]
/** verify 之前刷新 overview、按 overview 条件矩阵核对的旧写法。 */
const STALE_REFRESH = [
  /verify`?\s*(?:之前|前)刷新/,
  /^\|\s*`\/opsx:verify` 之前\s*\|/,
  /先(?:跑|运行)[^。；\n]*\/opsx:overview/,
  /先刷新条件矩阵/,
  /核对条件矩阵/,
  /(?:用|按)\s*`?overview\.md`?\s*(?:的)?条件矩阵/,
  /用其条件矩阵/,
  /`overview\.md` 条件矩阵中标/,
]
/** 条件只能映射到任务的旧写法。 */
const STALE_MAPPING = [
  /(?:映射不到|无法映射到|必须(?:能)?映射到|都映射到|已映射到)\s*(?:任何\s*)?`?tasks/,
  /对应 tasks\.md 任务/,
]

/** 在 dirs 下扩展名匹配 pattern 的文件中逐行查找旧写法，返回 `文件:行号`。 */
async function findStale(dirs, filePattern, patterns) {
  const stale = []
  for (const dir of dirs) {
    for (const file of (await listFiles(dir)).filter(f => filePattern.test(f))) {
      (await read(file)).split('\n').forEach((line, i) => {
        if (patterns.some(pattern => pattern.test(line))) stale.push(`${file}:${i + 1}`)
      })
    }
  }
  return stale
}

test('verify 条件核对：不再要求 verify 之前刷新 overview，archive 读取 verification.md「评审条件」', async () => {
  const stale = await findStale([...AGENT_READ_DIRS, 'workflow'], /\.md$/, STALE_REFRESH)
  assert.deepEqual(stale, [], `以下位置仍要求 verify 之前刷新 overview 或按条件矩阵核对：\n${stale.join('\n')}`)
  assert.ok((await read('skills/openspec-technical-review/shared/phases.md')).includes('条件核对（读取 review-summary.md）'),
    'phases.md 的 Phase 6 流程图应改为「条件核对（读取 review-summary.md）」')
  for (const file of ARCHIVE_FILES) {
    const text = await read(file)
    assert.ok(text.includes('「评审条件」'), `${file} 应读取 verification.md「评审条件」`)
    assert.ok(!text.includes('条件矩阵'), `${file} 不应再读取 overview 条件矩阵`)
  }
})

test('verify 报告：模板含 Fingerprint、Verify Mode 与「评审条件」，写明增量复核条件', async () => {
  for (const file of VERIFY_REPORT_FILES) {
    const text = await read(file)
    for (const expected of ['- Fingerprint: git-tree:', '- Verify Mode:', '### 评审条件', CONDITION_COLUMNS, 'classify', '--from', 'unregistered', '增量']) {
      assert.ok(text.includes(expected), `${file} 缺少「${expected}」`)
    }
  }
})

test('条件映射：只需修改规划产物的条件可以映射到 <文件>:<行号>，只认任务的旧写法不得残留', async () => {
  const missing = []
  for (const file of CONDITION_MAPPING_FILES) {
    if (!(await read(file)).includes(LINE_REFERENCE)) missing.push(file)
  }
  assert.deepEqual(missing, [], `以下文件的条件映射规则未写 ${LINE_REFERENCE}`)
  for (const file of CONDITION_COLUMN_FILES) {
    assert.ok((await read(file)).includes('对应任务或行号'), `${file} 的条件清单列名应为「对应任务或行号」`)
  }
  const stale = await findStale([...AGENT_READ_DIRS, 'workflow'], /\.md$|\.workflow\.js$/, STALE_MAPPING)
  assert.deepEqual(stale, [], `以下位置仍要求条件只能映射到 tasks：\n${stale.join('\n')}`)
})

/**
 * 验收部署文档（tier-post-implementation-changes D8）。
 * deployment-document.md 是 deployment.md 的唯一事实源：四节表格都带「负责人」与「状态」，不用 checkbox，
 * 避免与 tasks.md 的进度混淆。排除清单 E6–E8 的去处、propose 的创建条件、verify 的核对项都只引用该文件。
 */
const DEPLOYMENT_RULES = 'skills/openspec-apply-change/shared/deployment-document.md'
const DEPLOYMENT_SECTIONS = {
  发布前检查: ['检查', '通过条件', '负责人', '状态'],
  部署与回滚: ['步骤', '负责人', '状态'],
  上线后验收: ['指标', '窗口', '达标条件', '未达标处理', '负责人', '状态'],
  交接项: ['动作', '负责人', '不做的后果', '状态'],
}
const DEPLOYMENT_REFERRERS = [
  'skills/openspec-propose/SKILL.md',
  'claude/commands/opsx/propose.md',
  'claude/commands/opsx/ff.md',
  ...VERIFY_REPORT_FILES,
  'skills/openspec-apply-change/shared/slice-evidence.md',
]

/** 取 verify 第 8 步报告模板（从「## Verification Report」到代码块结束）。 */
function reportTemplate(markdown) {
  const rest = markdown.split('## Verification Report: <change-name>')[1]
  assert.ok(rest, '缺少 verify 报告模板')
  return rest.split('```')[0]
}

test('验收部署文档：骨架四节表格都有负责人与状态列，不用 checkbox', async () => {
  const rules = await read(DEPLOYMENT_RULES)
  assert.ok(!/- \[[ x]\]/.test(rules), `${DEPLOYMENT_RULES} 不得使用 checkbox`)
  const skeleton = fencedBlock(rules, '# 验收部署文档：<change-name>\n')
  for (const [section, columns] of Object.entries(DEPLOYMENT_SECTIONS)) {
    const body = skeleton.split(`## ${section}\n`)[1]
    assert.ok(body, `骨架缺少小节「${section}」`)
    const header = body.split('\n')[0].split('|').slice(1, -1).map(cell => cell.trim())
    assert.deepEqual(header, columns, `「${section}」的表头应为 ${columns.join(' | ')}`)
  }
  for (const status of ['`未开始`', '`已完成`', '`不适用`']) {
    assert.ok(rules.includes(status), `${DEPLOYMENT_RULES} 缺少状态取值 ${status}`)
  }
  assert.ok(rules.includes('待环境补测'), `${DEPLOYMENT_RULES} 应写明待环境补测的补测计划写入「发布前检查」`)
})

test('验收部署文档：排除清单 E6–E8、propose 创建条件、verify 核对项都引用 deployment-document.md', async () => {
  const rows = (await read(TASK_RULES)).split('\n').filter(line => /^\| E[678] \|/.test(line))
  assert.equal(rows.length, 3)
  for (const row of rows) assert.ok(row.includes('deployment-document.md'), `排除清单行的去处应引用 deployment-document.md：${row}`)
  const missing = []
  for (const file of DEPLOYMENT_REFERRERS) {
    if (!(await read(file)).includes('deployment-document.md')) missing.push(file)
  }
  assert.deepEqual(missing, [], '以下文件未引用 deployment-document.md')
})

test('验收部署文档：verify 报告模板只写一行指向 deployment.md，不列出上线后的事项', async () => {
  for (const file of VERIFY_REPORT_FILES) {
    const lines = reportTemplate(await read(file)).split('\n')
    assert.equal(lines.filter(line => line.includes('deployment.md')).length, 1, `${file} 报告模板应只有一行指向 deployment.md`)
    for (const section of Object.keys(DEPLOYMENT_SECTIONS)) {
      assert.ok(!lines.some(line => line.includes(section)), `${file} 报告模板不应列出「${section}」`)
    }
  }
})
