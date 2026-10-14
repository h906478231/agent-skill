import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { load as loadYaml } from '../skills/openspec-ste/vendor/js-yaml.mjs'

// 通过 /opsx:propose、/opsx:apply、/opsx:verify 与 Stop hook 实际调用的 ste-lint.mjs 入口验证行为；
// 每个用例在临时目录里构造项目（CONTEXT.md + 变更目录），不改动本仓库。
const lint = fileURLToPath(new URL('../skills/openspec-ste/scripts/ste-lint.mjs', import.meta.url))

/** 示例术语表：取消的禁用别名为退单、撤单。 */
const GLOSSARY = [
  '# 订单', '', '## Language', '',
  '**Cancellation（取消）**:', '整单取消。', '_Avoid_: 退单、撤单', '',
].join('\n')

/** 创建临时项目与 demo 变更目录；默认写入示例术语表。 */
function fixture(t, { glossary = GLOSSARY } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'ste-lint-'))
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
  const run = (args, input) => {
    const result = spawnSync(process.execPath, [lint, ...args], { cwd: repo, encoding: 'utf8', input })
    return { code: result.status, out: result.stdout, err: result.stderr, json: () => JSON.parse(result.stdout) }
  }
  const check = () => run(['check', changeRoot])
  const text = input => run(['text', '--repo', repo], input)
  return { repo, changeRoot, write, change, run, check, text }
}

/** 生成第 n 行为 line、其余为空行的文本，用于断言行号。 */
const atLine = (n, line) => `${'\n'.repeat(n - 1)}${line}\n`

// ---------------------------------------------------------------------------
// Slice 01：产物中的禁用别名被阻断（Seam：check / text）
// ---------------------------------------------------------------------------

test('check：design.md 第 12 行的禁用别名被阻断，报告文件、行号、规则、别名与替代词', t => {
  const f = fixture(t)
  f.change('design.md', atLine(12, '用户可以退单。'))
  const result = f.check()
  assert.equal(result.code, 1, result.err)
  const report = result.json()
  assert.equal(report.verdict, 'BLOCKED')
  assert.equal(report.blocking.length, 1)
  assert.deepEqual(
    { file: report.blocking[0].file, line: report.blocking[0].line, text: report.blocking[0].text, replacement: report.blocking[0].replacement },
    { file: 'design.md', line: 12, text: '退单', replacement: '取消' })
  assert.equal(report.blocking[0].rule, 'C-R1.11')
})

test('check：输出一个 JSON 对象，含 verdict、blocking、warnings、exemptions；无阻断项退出码 0', t => {
  const f = fixture(t)
  f.change('proposal.md', '用户可以取消。\n')
  const result = f.check()
  assert.equal(result.code, 0, result.err)
  const report = result.json()
  assert.deepEqual(Object.keys(report).sort(), ['blocking', 'exemptions', 'verdict', 'warnings'])
  assert.equal(report.verdict, 'PASS')
  assert.deepEqual(report.blocking, [])
  assert.equal(report.exemptions, 0)
})

test('check：变更目录不存在时退出码 2', t => {
  const f = fixture(t)
  const result = f.run(['check', join(f.repo, 'openspec/changes/missing')])
  assert.equal(result.code, 2)
  assert.match(result.err, /变更目录不存在/)
})

test('check：只扫描四类产物，不扫描 review、evidence、overview.md 与 archive', t => {
  const f = fixture(t)
  f.change('specs/order/spec.md', atLine(3, '用户可以撤单。'))
  f.change('tasks.md', '- [ ] 1.1 用户可以退单\n')
  f.change('review/standards.md', '退单\n')
  f.change('evidence/slice-01.md', '退单\n')
  f.change('overview.md', '退单\n')
  f.write('openspec/changes/archive/old/design.md', '退单\n')
  f.write('openspec/specs/order/spec.md', '退单\n')
  const report = f.check().json()
  assert.deepEqual(report.blocking.map(item => `${item.file}:${item.line}`).sort(), ['specs/order/spec.md:3', 'tasks.md:1'])
})

test('check：代码块、行内代码与 URL 中的别名不报告', t => {
  const f = fixture(t)
  f.change('design.md', [
    '原 `退单` 接口改名为取消。',
    '```text', '退单', '```',
    '参考 https://example.com/退单 的说明。',
  ].join('\n'))
  const result = f.check()
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(result.json().blocking, [])
})

test('check：term-allow 豁免该行的别名并计数', t => {
  const f = fixture(t)
  f.change('design.md', '迁移：退单接口改名为取消。<!-- term-allow: 退单 -->\n用户可以退单。\n')
  const report = f.check().json()
  assert.deepEqual(report.blocking.map(item => item.line), [2])
  assert.equal(report.exemptions, 1)
})

test('check：别名只出现在术语表中更长的术语内时不报告', t => {
  const f = fixture(t, { glossary: [
    '**Order（订单）**:', '一次购买请求。', '_Avoid_: 单子', '',
    '**Order Number Rule（单子编号规则）**:', '订单编号的生成规则。', '',
  ].join('\n') })
  f.change('design.md', '按单子编号规则生成。\n这个单子已支付。\n')
  const report = f.check().json()
  assert.deepEqual(report.blocking.map(item => `${item.line}:${item.text}`), ['2:单子'])
})

test('check：术语声明 _Category_: 技术动词 时，解析结果记为技术动词', t => {
  const f = fixture(t, { glossary: '**Publish（发布）**:\n对外公开。\n_Category_: 技术动词\n_Avoid_: 上架\n' })
  f.change('design.md', '运营上架商品。\n')
  const [finding] = f.check().json().blocking
  assert.equal(finding.replacement, '发布')
  assert.equal(finding.category, '技术动词')
})

test('check：1 个字的别名报环境错误，退出码 2', t => {
  const f = fixture(t, { glossary: '**Cancellation（取消）**:\n整单取消。\n_Avoid_: 退、撤单\n' })
  f.change('design.md', '用户可以取消。\n')
  const result = f.check()
  assert.equal(result.code, 2)
  assert.match(result.err, /退/)
})

test('check：存在 CONTEXT-MAP.md 时只读根 CONTEXT.md 并告警', t => {
  const f = fixture(t)
  f.write('CONTEXT-MAP.md', '# 多领域\n')
  f.change('design.md', '用户可以退单。\n')
  const result = f.check()
  assert.equal(result.code, 1)
  assert.ok(result.json().warnings.some(item => /CONTEXT-MAP\.md/.test(item.detail)))
})

test('check：没有 CONTEXT.md 时跳过禁用别名规则并告警', t => {
  const f = fixture(t, { glossary: null })
  f.change('design.md', '用户可以退单。\n')
  const result = f.check()
  assert.equal(result.code, 0, result.out)
  const report = result.json()
  assert.deepEqual(report.blocking, [])
  assert.ok(report.warnings.some(item => item.detail === '未建立术语表，一词一义无法校验'))
})

test('text：stdin 第 3 行的禁用别名被阻断，file 为 <stdin>', t => {
  const f = fixture(t)
  const result = f.text('订单已创建。\n订单已支付。\n用户退单。\n')
  assert.equal(result.code, 1, result.err)
  const [finding] = result.json().blocking
  assert.deepEqual({ file: finding.file, line: finding.line, text: finding.text, replacement: finding.replacement },
    { file: '<stdin>', line: 3, text: '退单', replacement: '取消' })
})

test('text：没有阻断项时退出码 0，blocking 为空', t => {
  const f = fixture(t)
  const result = f.text('用户取消订单。\n')
  assert.equal(result.code, 0, result.err)
  assert.deepEqual(result.json().blocking, [])
})

test('text：没有 CONTEXT.md 时与 check 相同降级', t => {
  const f = fixture(t, { glossary: null })
  const result = f.text('用户退单。\n')
  assert.equal(result.code, 0, result.err)
  assert.ok(result.json().warnings.some(item => item.detail === '未建立术语表，一词一义无法校验'))
})

// ---------------------------------------------------------------------------
// Slice 02：STE 规则表、通用受控词表与模糊词生效（Seam：check / text / config-snippet）
// ---------------------------------------------------------------------------

/** 55 个汉字的描述句：只触发句长告警，不含词表词、虚词间隔不超过 11 字。 */
const SENTENCE_55 = `${Array(5).fill('用户在列表中查看订单').join('，')}，用户在列表。`

test('check：非受控通用词被阻断，报告规则 C-R1.1 与唯一替代词', t => {
  const f = fixture(t)
  f.change('design.md', '系统利用缓存。\n')
  const result = f.check()
  assert.equal(result.code, 1, result.out)
  const [finding] = result.json().blocking
  assert.deepEqual({ rule: finding.rule, text: finding.text, replacement: finding.replacement },
    { rule: 'C-R1.1', text: '利用', replacement: '使用' })
})

test('check：词表条目的例外短语不报告', t => {
  const f = fixture(t)
  f.change('design.md', '缓存利用率为 90%。\n')
  const result = f.check()
  assert.equal(result.code, 0, result.out)
  assert.deepEqual(result.json().blocking, [])
})

test('check：模糊词被阻断，报告规则 C-R4.1', t => {
  const f = fixture(t)
  f.change('proposal.md', '设置适当的超时时间。\n')
  const result = f.check()
  assert.equal(result.code, 1, result.out)
  assert.deepEqual(result.json().blocking.map(item => `${item.rule}:${item.text}`), ['C-R4.1:适当'])
})

test('check：没有 CONTEXT.md 时模糊词仍阻断，并告警缺少术语表', t => {
  const f = fixture(t, { glossary: null })
  f.change('proposal.md', '设置适当的超时时间。\n')
  const result = f.check()
  assert.equal(result.code, 1, result.out)
  const report = result.json()
  assert.deepEqual(report.blocking.map(item => item.text), ['适当'])
  assert.ok(report.warnings.some(item => item.detail === '未建立术语表，一词一义无法校验'))
})

test('check：55 字的描述句只告警，退出码 0', t => {
  const f = fixture(t)
  f.change('proposal.md', `${SENTENCE_55}\n`)
  const result = f.check()
  assert.equal(result.code, 0, result.out)
  const warnings = result.json().warnings
  assert.equal(warnings.length, 1, JSON.stringify(warnings))
  assert.equal(warnings[0].rule, 'C-R6.3')
  assert.match(warnings[0].detail, /55 字 > 40/)
})

test('check：没有 ste.yaml 时使用默认阈值 30 字指令句与 6 句段落，均只告警', t => {
  const f = fixture(t)
  const instruction = '用户在列表中查看订单，用户在列表中查看订单，用户在列表中查看订单，用户'
  f.change('tasks.md', `- [ ] 1.1 ${instruction}\n`)
  f.change('design.md', `${Array(7).fill('用户查看订单。').join('')}\n`)
  const result = f.check()
  assert.equal(result.code, 0, result.out)
  const rules = result.json().warnings.map(item => `${item.file}:${item.rule}`)
  assert.deepEqual(rules.sort(), ['design.md:C-R6.6', 'tasks.md:C-R5.1'])
})

test('check：名词串、被动语态、程序步骤、安全提示只告警', t => {
  const f = fixture(t)
  f.change('design.md', [
    '订单状态变更消息推送服务配置项。',
    '订单被用户取消。',
    '注意：数据库连接数上限为一百。',
  ].join('\n'))
  f.change('tasks.md', '- [ ] 1.1 编写脚本并运行测试\n')
  const result = f.check()
  assert.equal(result.code, 0, result.out)
  const rules = result.json().warnings.map(item => `${item.file}:${item.line}:${item.rule}`)
  assert.deepEqual(rules.sort(), ['design.md:1:C-R2.1', 'design.md:2:C-R3.6', 'design.md:3:C-R7.2', 'tasks.md:1:C-R5.2'])
})

test('check：「被动」「并发」不触发被动语态与程序步骤告警；以命令开头的安全提示不告警', t => {
  const f = fixture(t)
  f.change('design.md', '这是被动检查。\n警告：不要删除生产数据。\n')
  f.change('tasks.md', '- [ ] 1.1 编写并发测试\n')
  const result = f.check()
  assert.deepEqual(result.json().warnings, [])
})

test('text：词表与模糊词规则同样生效', t => {
  const f = fixture(t)
  const result = f.text('系统利用缓存。\n设置适当的超时。\n')
  assert.equal(result.code, 1, result.out)
  assert.deepEqual(result.json().blocking.map(item => `${item.line}:${item.text}`), ['1:利用', '2:适当'])
})

test('ste.yaml：增加模糊词、删除词表条目、增加词表条目、覆盖阈值', t => {
  const f = fixture(t)
  f.write('openspec/ste.yaml', [
    'vague:', '  add: [酌情]',
    'vocabulary:', '  remove: [利用]', '  add:', '    - { word: 下发, replacement: 发送 }',
    'thresholds:', '  descriptive: 60',
  ].join('\n'))
  f.change('design.md', `酌情处理。\n系统利用缓存。\n服务下发通知。\n${SENTENCE_55}\n`)
  const result = f.check()
  assert.equal(result.code, 1, result.out)
  const report = result.json()
  assert.deepEqual(report.blocking.map(item => `${item.line}:${item.text}:${item.replacement || ''}`), ['1:酌情:', '3:下发:发送'])
  assert.deepEqual(report.warnings, [])
})

test('ste.yaml：YAML 非法时退出码 2，并写明文件与解析错误', t => {
  const f = fixture(t)
  f.write('openspec/ste.yaml', 'vague:\n  add: [酌情\n')
  f.change('design.md', '用户取消订单。\n')
  const result = f.check()
  assert.equal(result.code, 2)
  assert.match(result.err, /ste\.yaml/)
})

test('ste.yaml：不符合 schema 时退出码 2，不静默使用默认值', t => {
  const f = fixture(t)
  f.write('openspec/ste.yaml', 'thresholds:\n  descriptive: 多\nunknown: 1\n')
  f.change('design.md', '用户取消订单。\n')
  const result = f.check()
  assert.equal(result.code, 2)
  assert.match(result.err, /ste\.yaml/)
})

test('config-snippet：生成覆盖四类产物的 rules 片段，内容跟随规则表', t => {
  const skill = mkdtempSync(join(tmpdir(), 'ste-skill-'))
  t.after(() => rmSync(skill, { recursive: true, force: true }))
  cpSync(fileURLToPath(new URL('../skills/openspec-ste', import.meta.url)), skill, { recursive: true })
  const snippet = () => spawnSync(process.execPath, [join(skill, 'scripts/ste-lint.mjs'), 'config-snippet'], { encoding: 'utf8' })

  const before = snippet()
  assert.equal(before.status, 0, before.stderr)
  for (const artifact of ['proposal', 'design', 'specs', 'tasks']) assert.match(before.stdout, new RegExp(`^  ${artifact}:`, 'm'))
  assert.match(before.stdout, /C-R1\.11/)

  const rules = join(skill, 'shared/ste-rules.md')
  writeFileSync(rules, readFileSync(rules, 'utf8').replace('一段不超过 6 句', '一段不超过 5 句（已修改）'))
  const after = snippet()
  assert.equal(after.status, 0, after.stderr)
  assert.match(after.stdout, /一段不超过 5 句（已修改）/)
  assert.doesNotMatch(after.stdout, /一段不超过 6 句/)
})

// ---------------------------------------------------------------------------
// Slice 04：Claude Code 对话回复中的禁用别名被阻断（Seam：reply-hook）
// ---------------------------------------------------------------------------

/** transcript 示例条目，结构与 Claude Code 会话 JSONL 一致。 */
const entry = {
  user: text => ({ type: 'user', message: { role: 'user', content: text } }),
  meta: text => ({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text }] } }),
  toolResult: () => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  assistant: text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  toolUse: () => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } }),
}

/** 写入 transcript 示例文件并以 Stop hook 事件调用 reply-hook。 */
function hook(f, entries, { active = false, transcript, lastMessage } = {}) {
  const file = transcript || join(f.repo, 'transcript.jsonl')
  if (!transcript) writeFileSync(file, `${entries.map(item => JSON.stringify(item)).join('\n')}\n`)
  const event = { session_id: 's1', transcript_path: file, cwd: f.repo, hook_event_name: 'Stop', stop_hook_active: active }
  if (lastMessage !== undefined) event.last_assistant_message = lastMessage
  const result = spawnSync(process.execPath, [lint, 'reply-hook'], {
    cwd: f.repo, encoding: 'utf8', input: JSON.stringify(event), env: { ...process.env, CLAUDE_PROJECT_DIR: f.repo },
  })
  const decision = result.stdout.trim() ? JSON.parse(result.stdout).decision : undefined
  return { code: result.status, out: result.stdout, err: result.stderr, decision }
}

test('reply-hook：回复含禁用别名时输出 block 决策，原因列出「别名 → 术语」', t => {
  const f = fixture(t)
  const result = hook(f, [entry.user('怎么处理？'), entry.assistant('用户可以退单。')])
  assert.equal(result.code, 0, result.err)
  assert.equal(result.decision, 'block')
  assert.match(JSON.parse(result.out).reason, /退单 → 取消/)
})

test('reply-hook：回复没有禁用别名时退出码 0，不输出 block 决策', t => {
  const f = fixture(t)
  const result = hook(f, [entry.user('怎么处理？'), entry.assistant('用户可以取消。')])
  assert.equal(result.code, 0, result.err)
  assert.equal(result.decision, undefined)
})

test('reply-hook：只检查最后一条用户消息之后的 assistant 文本，tool_result 与 meta 条目不算用户消息', t => {
  const f = fixture(t)
  const earlier = [entry.user('第一问'), entry.assistant('上一轮提到退单。')]
  const allow = hook(f, [...earlier, entry.user('第二问'), entry.assistant('用户可以取消。')])
  assert.equal(allow.decision, undefined)
  const block = hook(f, [...earlier, entry.user('第二问'), entry.meta('注入的说明'), entry.assistant('先查看。'),
    entry.toolUse(), entry.toolResult(), entry.assistant('结论：用户可以撤单。')])
  assert.equal(block.decision, 'block')
  assert.match(JSON.parse(block.out).reason, /撤单 → 取消/)
})

test('reply-hook：最后一条回复尚未写入 transcript 时，检查事件中的 last_assistant_message', t => {
  const f = fixture(t)
  const result = hook(f, [entry.user('怎么处理？'), entry.assistant('先查看。')], { lastMessage: '结论：用户可以退单。' })
  assert.equal(result.code, 0, result.err)
  assert.equal(result.decision, 'block')
  assert.match(JSON.parse(result.out).reason, /退单 → 取消/)
})

test('reply-hook：stop_hook_active 为 true 时放行，最多重试一次', t => {
  const f = fixture(t)
  const result = hook(f, [entry.user('怎么处理？'), entry.assistant('用户还是退单。')], { active: true })
  assert.equal(result.code, 0, result.err)
  assert.equal(result.decision, undefined)
})

test('reply-hook：模糊词与非受控通用词只告警，不阻断', t => {
  const f = fixture(t)
  const result = hook(f, [entry.user('怎么处理？'), entry.assistant('设置适当的超时，利用缓存。')])
  assert.equal(result.code, 0, result.err)
  assert.equal(result.decision, undefined)
  const { systemMessage } = JSON.parse(result.out)
  assert.match(systemMessage, /利用 → 使用/)
  assert.match(systemMessage, /适当/)
})

test('reply-hook：引用块、代码块与行内代码中的别名不报告', t => {
  const f = fixture(t)
  const reply = ['> 用户原话：我要退单', '', '旧接口 `cancelOrder` 原名 `退单`。', '```', '退单()', '```', '已改为取消。'].join('\n')
  const result = hook(f, [entry.user('我要退单'), entry.assistant(reply)])
  assert.equal(result.code, 0, result.err)
  assert.equal(result.decision, undefined, result.out)
})

test('reply-hook：transcript 不存在、无法解析或没有 CONTEXT.md 时放行', t => {
  const f = fixture(t)
  const missing = hook(f, [], { transcript: join(f.repo, 'missing.jsonl') })
  assert.equal(missing.code, 0)
  assert.equal(missing.decision, undefined)

  const broken = join(f.repo, 'broken.jsonl')
  writeFileSync(broken, '{不是 JSON\n')
  const unparsable = hook(f, [], { transcript: broken })
  assert.equal(unparsable.code, 0)
  assert.equal(unparsable.decision, undefined)

  const g = fixture(t, { glossary: null })
  const noGlossary = hook(g, [entry.user('怎么处理？'), entry.assistant('用户可以退单。')])
  assert.equal(noGlossary.code, 0)
  assert.equal(noGlossary.decision, undefined)
})

// ---------------------------------------------------------------------------
// Slice 05：双轴评审条件闭环（Seam：check / reply-hook）
// ---------------------------------------------------------------------------

/** 订单术语表：「单子」与英文「purchase」是禁用别名。 */
const ORDER_GLOSSARY = '**Order（订单）**:\n一次购买请求。\n_Avoid_: 单子、purchase\n'

test('check：含中文段的路径与文件名不报告；不含英文字母的「订单/单子」仍报告', t => {
  const f = fixture(t, { glossary: ORDER_GLOSSARY })
  f.change('design.md', '说明见 docs/单子/readme 与 单子.md。\n写法统一为订单/单子二选一。\n')
  const report = f.check().json()
  assert.deepEqual(report.blocking.map(item => `${item.line}:${item.text}`), ['2:单子'])
})

test('check：驼峰、下划线、点调用形式的标识符不报告；正文中的英文别名仍报告', t => {
  const f = fixture(t, { glossary: ORDER_GLOSSARY })
  f.change('design.md', '调用 purchaseService 与 purchase_id 字段，再调用 order.purchase。\n用户 purchase 一件商品。\n')
  const report = f.check().json()
  assert.deepEqual(report.blocking.map(item => `${item.line}:${item.text}`), ['2:purchase'])
})

test('reply-hook：回复中路径与标识符里的别名不阻断', t => {
  const f = fixture(t, { glossary: ORDER_GLOSSARY })
  const result = hook(f, [entry.user('日志在哪？'), entry.assistant('日志在 logs/单子/app.log，入口是 purchaseService。')])
  assert.equal(result.code, 0, result.err)
  assert.equal(result.decision, undefined, result.out)
})

test('reply-hook：ste.yaml 非法时仍阻断禁用别名，词表告警降级为不检查', t => {
  const f = fixture(t)
  f.write('openspec/ste.yaml', 'bogus: 1\n')
  const alias = hook(f, [entry.user('怎么处理？'), entry.assistant('用户可以退单。')])
  assert.equal(alias.code, 0, alias.err)
  assert.equal(alias.decision, 'block')
  const vocabulary = hook(f, [entry.user('怎么处理？'), entry.assistant('系统利用缓存。')])
  assert.equal(vocabulary.code, 0, vocabulary.err)
  assert.equal(vocabulary.out, '')
})

test('规则表中的阈值与 vocabulary.yaml、名词串判定一致（config.yaml 规则与实际检查同口径）', t => {
  const read = rel => readFileSync(fileURLToPath(new URL(`../skills/openspec-ste/${rel}`, import.meta.url)), 'utf8')
  const rules = read('shared/ste-rules.md')
  const number = id => Number(new RegExp(`^\\| ${id.replace('.', '\\.')} \\|[^|]*\\|[^|]*?(\\d+)`, 'm').exec(rules)[1])
  const { thresholds } = loadYaml(read('shared/vocabulary.yaml'))
  assert.equal(number('C-R5.1'), thresholds.instruction)
  assert.equal(number('C-R6.3'), thresholds.descriptive)
  assert.equal(number('C-R6.6'), thresholds.paragraph)

  const f = fixture(t)
  const minimum = number('C-R2.1')
  const cluster = '订单状态变更消息推送服务配置项目'
  const rulesOf = text => f.text(`${text}。\n`).json().warnings.map(item => item.rule)
  assert.ok(rulesOf(cluster.slice(0, minimum)).includes('C-R2.1'))
  assert.ok(!rulesOf(cluster.slice(0, minimum - 1)).includes('C-R2.1'))
})

// ---------------------------------------------------------------------------
// Slice 06：双轴评审第 2 轮条件闭环（Seam：check）
// ---------------------------------------------------------------------------

test('check：首段不是英文路径段的「/」并列写法不算路径，其中的别名仍报告', t => {
  const f = fixture(t)
  f.change('design.md', '用户A/用户B退单后通知。\n退单/refund 两种写法。\n日志在 logs/退单/app.log。\n')
  const report = f.check().json()
  assert.deepEqual(report.blocking.map(item => `${item.line}:${item.text}`), ['1:退单', '2:退单'])
})
