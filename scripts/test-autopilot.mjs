import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, chmodSync, utimesSync, symlinkSync, realpathSync, renameSync, statSync } from 'node:fs'
import { tmpdir, uptime } from 'node:os'
import { join, dirname, resolve as resolvePath, sep as pathSep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  tempDir, initRepo, writeFiles, projectOf, writeConfig, progressDouble, claudeDouble, larkDouble, setClaudeOutput,
} from './lib/autopilot-doubles.mjs'
import { alertCard, exitCard, questionCard } from '../skills/openspec-autopilot/scripts/lib/card.mjs'

/**
 * 托管入口的测试（add-autopilot-loop Slice 01，Seam：autopilot.mjs start|cancel|status）。
 * 每个用例在临时 git 仓库与临时托管目录中运行真实的 autopilot.mjs；进度视图由替身输出，不连接网络与远端。
 */
const autopilot = fileURLToPath(new URL('../skills/openspec-autopilot/scripts/autopilot.mjs', import.meta.url))

/** 进度视图的一条变更条目；字段与 progress.mjs 的输出一致。 */
const entry = (overrides = {}) => ({
  change: 'demo',
  tier: 'MVP',
  stage: 'apply',
  tasks: { done: 0, total: 3 },
  openQuestions: { pending: 0, total: 0 },
  rule: 'R6',
  blockers: [],
  warnings: [],
  notes: [],
  reviewStale: false,
  next: '/opsx:apply demo',
  error: null,
  ...overrides,
})

/** 进度视图替身输出的进度视图。 */
const view = (overrides = {}) => ({
  root: null,
  active: [entry()],
  implementing: [],
  archived: [],
  ...overrides,
})

/**
 * 建立一个用例环境：临时 git 仓库、临时托管目录、进度视图替身与配置。
 * @param {object} t node:test 的用例上下文。
 * @param {object} options 用例选项：view 为进度视图，branch 为当前分支，userName 为 null 时不设置用户名，
 *   files 为变更目录下的额外文件（相对路径 → 内容）。
 */
function scenario(t, { progress = view(), branch = 'main', userName = 'tester', files = {} } = {}) {
  const repo = tempDir(t, 'autopilot-repo-')
  const home = tempDir(t, 'autopilot-home-')
  const git = initRepo(repo, { branch, userName })
  // 进度视图替身：输出用例写入的进度视图文件。
  const { progressBin } = progressDouble(home, { ...progress, root: repo })
  writeConfig(home, { progressBin, projects: [projectOf(repo)] })
  const changeDir = join(repo, 'openspec', 'changes', 'demo')
  mkdirSync(changeDir, { recursive: true })
  writeFiles(changeDir, files)

  const run = (args, env = {}) => {
    const result = spawnSync(process.execPath, [autopilot, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: home, ...env },
    })
    return { code: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr }
  }
  const record = () => {
    const file = join(changeDir, 'decisions', 'autopilot.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  }
  const decision = id => {
    const file = join(changeDir, 'decisions', `${id}.json`)
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  }
  return { repo, home, changeDir, run, record, decision, git }
}

// ---------------------------------------------------------------------------
// Requirement 1：把变更交给托管
// ---------------------------------------------------------------------------

test('R6 的变更交接成功，写出 active 的托管记录', t => {
  const f = scenario(t)
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 0, result.all)
  const record = f.record()
  assert.equal(record.status, 'active')
  assert.equal(record.rule, 'R6')
  assert.equal(record.tier, 'MVP')
  assert.ok(record.startedAt, '记录缺少 startedAt')
})

test('L0 变更没有技术评审也能交接', t => {
  const f = scenario(t, { progress: view({ active: [entry({ tier: 'L0' })] }) })
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.equal(f.record().status, 'active')
})

test('R5 未签字的变更被拒绝，不写文件', t => {
  const f = scenario(t, { progress: view({ active: [entry({ rule: 'R5', stage: 'approval', blockers: ['签字行空白'] })] }) })
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 1, result.all)
  assert.ok(result.all.includes('R5'), result.all)
  assert.ok(result.all.includes('签字行空白'), result.all)
  assert.equal(existsSync(join(f.changeDir, 'decisions')), false, '不该写出 decisions 目录')
})

test('已托管的变更再次交接被拒绝，记录不变', t => {
  const f = scenario(t)
  assert.equal(f.run(['start', 'demo']).code, 0)
  const before = f.record()
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 1, result.all)
  assert.deepEqual(f.record(), before)
})

test('同一检出中另一个变更已开始实现时拒绝托管', t => {
  const f = scenario(t, { progress: view({ implementing: ['other-change'] }) })
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 1, result.all)
  assert.ok(result.all.includes('other-change'), result.all)
  assert.equal(existsSync(join(f.changeDir, 'decisions')), false)
})

test('同一项目的另一个变更已在托管时拒绝托管', t => {
  const f = scenario(t)
  const other = join(f.repo, 'openspec', 'changes', 'other-change', 'decisions')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'autopilot.json'), `${JSON.stringify({ status: 'active', startedAt: '2026-11-06T10:00:00Z' })}\n`)
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 1, result.all)
  assert.ok(result.all.includes('other-change'), result.all)
})

test('进度视图没有这个变更时是参数错误', t => {
  const f = scenario(t, { progress: view({ active: [] }) })
  const result = f.run(['start', 'no-such-change'])
  assert.equal(result.code, 2, result.all)
  assert.equal(existsSync(join(f.changeDir, 'decisions')), false)
})

test('进度视图没有 implementing 数组时是环境错误，提示同步 openspec-change-progress', t => {
  const f = scenario(t)
  writeFileSync(join(f.home, 'progress-output.json'), JSON.stringify({
    root: f.repo, active: [entry()], archived: [],
  }))
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 2, result.all)
  assert.ok(result.all.includes('openspec-change-progress'), result.all)
  assert.equal(existsSync(join(f.changeDir, 'decisions')), false)
})

test('当前分支不是 baseBranch 时拒绝托管', t => {
  const f = scenario(t, { branch: 'fix/a' })
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 1, result.all)
  assert.ok(result.all.includes('fix/a'), result.all)
  assert.equal(existsSync(join(f.changeDir, 'decisions')), false)
})

test('项目没有 git 用户名时拒绝托管', t => {
  const f = scenario(t, { userName: null })
  const result = f.run(['start', 'demo'], { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
  assert.equal(result.code, 1, result.all)
  assert.ok(result.all.includes('user.name'), result.all)
  assert.equal(existsSync(join(f.changeDir, 'decisions')), false)
})

test('已撤回的变更可以重新交接，开始时间更新', t => {
  const f = scenario(t, {
    files: { 'decisions/autopilot.json': { status: 'void', startedAt: '2026-11-06T10:00:00Z', rule: 'R6', tier: 'MVP' } },
  })
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 0, result.all)
  const record = f.record()
  assert.equal(record.status, 'active')
  assert.notEqual(record.startedAt, '2026-11-06T10:00:00Z')
  assert.ok(record.startedAt > '2026-11-06T10:00:00Z', record.startedAt)
})

test('重新交接时作废上一次托管遗留的决策，不保留实现快照', t => {
  const f = scenario(t, {
    files: {
      'decisions/autopilot.json': {
        status: 'void', startedAt: '2026-11-06T10:00:00Z', rule: 'R6', tier: 'MVP',
        implSnapshot: { 'src/a.js': 'abc' },
      },
      'decisions/D-0006.json': { id: 'D-0006', kind: 'question', status: 'pending' },
    },
  })
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 0, result.all)
  const decision = f.decision('D-0006')
  assert.equal(decision.status, 'void')
  assert.equal(decision.voidReason, '上一次托管遗留')
  const record = f.record()
  assert.equal(record.status, 'active')
  assert.equal(record.implSnapshot, undefined, '新记录不该保留上一次的实现快照')
})

test('重新交接时列出遗留会话告警的核对失败项', t => {
  const f = scenario(t, {
    files: {
      'decisions/autopilot.json': { status: 'void', startedAt: '2026-11-06T10:00:00Z' },
      'decisions/D-0007.json': {
        id: 'D-0007', kind: 'alert', status: 'pending',
        request: {
          sessionId: 'sess-1',
          text: '核对不通过',
          options: ['补充说明后继续', '回会话处理'],
          checkFailures: [{ finding: 'STD-02', file: 'review/standards.md', before: 'open', after: 'risk-accepted' }],
        },
      },
    },
  })
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.equal(f.decision('D-0007').status, 'void')
  assert.ok(result.all.includes('STD-02'), result.all)
})

test('进度条目没有 reviewStale 时是环境错误，提示同步两个副本', t => {
  const f = scenario(t)
  const withoutStale = entry()
  delete withoutStale.reviewStale
  writeFileSync(join(f.home, 'progress-output.json'), JSON.stringify({
    root: f.repo, active: [withoutStale], implementing: [], archived: [],
  }))
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 2, result.all)
  assert.ok(result.all.includes('openspec-change-progress'), result.all)
  assert.ok(result.all.includes('openspec-technical-review'), result.all)
  assert.equal(existsSync(join(f.changeDir, 'decisions')), false)
})

// ---------------------------------------------------------------------------
// Requirement 2：撤回与状态
// ---------------------------------------------------------------------------

test('撤回时作废未完成的决策，文件都保留', t => {
  const f = scenario(t, {
    files: {
      'decisions/autopilot.json': { status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R6', tier: 'MVP' },
      'decisions/D-0002.json': { id: 'D-0002', kind: 'question', status: 'pending' },
    },
  })
  const result = f.run(['cancel', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.equal(f.record().status, 'void')
  assert.equal(f.record().voidReason, '用户撤回')
  assert.equal(f.decision('D-0002').status, 'void')
  assert.ok(existsSync(join(f.changeDir, 'decisions', 'D-0002.json')))
})

test('status 打印托管记录与各状态的决策数', t => {
  const f = scenario(t, {
    files: {
      'decisions/autopilot.json': { status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R6', tier: 'MVP' },
      'decisions/D-0001.json': { id: 'D-0001', kind: 'question', status: 'used' },
      'decisions/D-0002.json': { id: 'D-0002', kind: 'question', status: 'pending' },
    },
  })
  const result = f.run(['status', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.ok(result.all.includes('used: 1'), result.all)
  assert.ok(result.all.includes('pending: 1'), result.all)
  assert.ok(result.all.includes('active'), result.all)
})

test('撤回已归档的变更时找到归档目录', t => {
  const f = scenario(t, { progress: view({ active: [], archived: [{ name: 'demo', date: '2026-11-16' }] }) })
  const archiveDir = join(f.repo, 'openspec', 'changes', 'archive', '2026-11-16-demo', 'decisions')
  mkdirSync(archiveDir, { recursive: true })
  writeFileSync(join(archiveDir, 'autopilot.json'), `${JSON.stringify({ status: 'exiting', startedAt: '2026-11-06T10:00:00Z' })}\n`)
  const result = f.run(['cancel', 'demo'])
  assert.equal(result.code, 0, result.all)
  const record = JSON.parse(readFileSync(join(archiveDir, 'autopilot.json'), 'utf8'))
  assert.equal(record.status, 'void')
})

// ---------------------------------------------------------------------------
// Requirement 3：提问 hook 与权限宿主（add-autopilot-loop Slice 02）
// ---------------------------------------------------------------------------

/** 提问 hook 的路径。 */
const hook = fileURLToPath(new URL('../skills/openspec-autopilot/scripts/autopilot-hook.mjs', import.meta.url))
/** 权限宿主的路径。 */
const permHost = fileURLToPath(new URL('../skills/openspec-autopilot/scripts/perm-host.mjs', import.meta.url))

/** 实验 2 记录的提问原文与选项：作为卡片与 hook 测试的样本。 */
const QUESTION = {
  questions: [
    {
      question: 'STD-01 没有对应任务，怎么处理？',
      header: 'STD-01 没有对应任务，怎么处理？',
      multiSelect: false,
      options: [
        { label: '蓝', description: '新增任务（推荐）' },
        { label: '红', description: '接受这个风险，不修改' },
      ],
    },
  ],
}

/** 提问指纹的独立算法：JSON 文本的 SHA-256 前 12 位（design D5）。 */
function fingerprintOf(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 12)
}

/**
 * 建立一个 hook 用例环境：变更目录、托管目录与其中的配置。
 * @param {object} t node:test 的用例上下文。
 * @param {object} options options.files 为变更目录下的额外文件；ownerOpenId 为配置中的用户。
 */
function hookScenario(t, { files = {}, ownerOpenId = 'ou_owner' } = {}) {
  const repo = tempDir(t, 'autopilot-hook-repo-')
  const home = tempDir(t, 'autopilot-hook-home-')
  writeConfig(home, { ownerOpenId, projects: [projectOf(repo)] })
  const changeRoot = join(repo, 'openspec', 'changes', 'demo')
  mkdirSync(changeRoot, { recursive: true })
  writeFiles(changeRoot, files)
  const run = (input, env = {}) => {
    const result = spawnSync(process.execPath, [hook], {
      cwd: repo,
      encoding: 'utf8',
      input: `${JSON.stringify(input)}\n`,
      env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: home, OPENSPEC_AUTOPILOT_CHANGE_ROOT: changeRoot, ...env },
    })
    return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim(), json: () => JSON.parse(result.stdout) }
  }
  return { repo, home, changeRoot, run }
}

/** 构造一个已回复的提问决策文件内容。 */
const answeredQuestion = (overrides = {}) => ({
  id: 'D-0001',
  kind: 'question',
  status: 'answered',
  stage: 'quality',
  request: { sessionId: 'sess-1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION), questions: QUESTION.questions },
  answer: { operatorId: 'ou_owner', eventId: 'E1', answeredAt: '2026-11-16T10:00:00Z',
    answers: { 'STD-01 没有对应任务，怎么处理？': '新增任务（推荐）' } },
  ...overrides,
})

test('提问没有对应决策时 defer', t => {
  const f = hookScenario(t)
  const result = f.run({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'T1', tool_input: QUESTION })
  assert.equal(result.code, 0, result.err)
  assert.equal(result.json().permissionDecision, 'defer')
})

test('已回复的提问被填回答案', t => {
  const f = hookScenario(t, { files: { 'decisions/D-0001.json': answeredQuestion() } })
  const result = f.run({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'T1', tool_input: QUESTION })
  assert.equal(result.code, 0, result.err)
  const output = result.json()
  assert.equal(output.permissionDecision, 'allow')
  assert.equal(output.updatedInput.answers['STD-01 没有对应任务，怎么处理？'], '新增任务（推荐）')
  assert.deepEqual(output.updatedInput.questions, QUESTION.questions)
})

test('回复人不是本人时不填回，改为 defer', t => {
  const f = hookScenario(t, {
    files: { 'decisions/D-0001.json': answeredQuestion({ answer: { operatorId: 'ou_other', eventId: 'E1', answers: { 'STD-01 没有对应任务，怎么处理？': '新增任务（推荐）' } } }) },
  })
  const result = f.run({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'T1', tool_input: QUESTION })
  assert.equal(result.json().permissionDecision, 'defer')
})

test('提问已变化时 defer', t => {
  const f = hookScenario(t, { files: { 'decisions/D-0001.json': answeredQuestion() } })
  const changed = { questions: [{ question: '换了一个问题？', header: '换了一个问题？', multiSelect: false, options: [{ label: '好' }] }] }
  const result = f.run({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'T1', tool_input: changed })
  assert.equal(result.json().permissionDecision, 'defer')
})

test('会话告警的说明经 deny 送回模型', t => {
  const f = hookScenario(t, {
    files: {
      'decisions/D-0004.json': {
        id: 'D-0004', kind: 'alert', status: 'answered', stage: 'quality',
        request: { sessionId: 'sess-2', text: '核对不通过', options: ['补充说明后继续', '回会话处理'], deferredToolUseId: 'T2' },
        answer: { operatorId: 'ou_owner', eventId: 'E2', choice: '补充说明后继续', text: '把 STD-02 改回 open' },
      },
    },
  })
  const result = f.run({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'T2', tool_input: QUESTION })
  assert.equal(result.code, 0, result.err)
  const output = result.json()
  assert.equal(output.permissionDecision, 'deny')
  assert.ok(output.permissionDecisionReason.includes('把 STD-02 改回 open'), result.out)
})

test('归档目录中的回复也能填回', t => {
  const f = hookScenario(t)
  const archive = join(f.repo, 'openspec', 'changes', 'archive', '2026-11-06-demo', 'decisions')
  mkdirSync(archive, { recursive: true })
  writeFileSync(join(archive, 'D-0005.json'), `${JSON.stringify(answeredQuestion({ id: 'D-0005' }))}\n`)
  const result = f.run({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'T1', tool_input: QUESTION })
  assert.equal(result.code, 0, result.err)
  assert.equal(result.json().permissionDecision, 'allow')
})

test('归档回退按完整变更名匹配，不匹配更长的变更名', t => {
  const f = hookScenario(t)
  const archive = join(f.repo, 'openspec', 'changes', 'archive', '2026-10-01-add-autopilot-loop', 'decisions')
  mkdirSync(archive, { recursive: true })
  writeFileSync(join(archive, 'D-0001.json'), `${JSON.stringify(answeredQuestion())}\n`)
  const result = f.run({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'T1', tool_input: QUESTION })
  assert.equal(result.json().permissionDecision, 'defer')
})

test('缺少变更目录变量时 deny', t => {
  const f = hookScenario(t)
  const result = f.run({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'T1', tool_input: QUESTION },
    { OPENSPEC_AUTOPILOT_CHANGE_ROOT: '' })
  assert.equal(result.code, 0, result.err)
  const output = result.json()
  assert.equal(output.permissionDecision, 'deny')
  assert.ok(output.permissionDecisionReason.includes('OPENSPEC_AUTOPILOT_CHANGE_ROOT'), result.out)
})

test('写入 decisions 目录被拒绝', t => {
  const f = hookScenario(t)
  const result = f.run({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'W1',
    tool_input: { file_path: join(f.changeRoot, 'decisions', 'D-0001.json'), content: '{}' } })
  assert.equal(result.code, 0, result.err)
  assert.equal(result.json().permissionDecision, 'deny')
})

test('写入普通源文件时放行，不输出任何内容', t => {
  const f = hookScenario(t)
  const result = f.run({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'W2',
    tool_input: { file_path: join(f.repo, 'scripts', 'a.mjs'), old_string: 'a', new_string: 'b' } })
  assert.equal(result.code, 0, result.err)
  assert.equal(result.out, '')
})

test('带上级目录的路径写入 decisions 被拒绝', t => {
  const f = hookScenario(t)
  const result = f.run({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'W3',
    tool_input: { file_path: join(f.changeRoot, 'specs', '..', 'decisions', 'D-0001.json'), content: '{}' } })
  assert.equal(result.code, 0, result.err)
  assert.equal(result.json().permissionDecision, 'deny')
})

/**
 * 调用权限宿主的一个工具。
 * @param {object} t node:test 的用例上下文。
 * @param {object} args 工具调用的参数。
 * @param {object} env 额外环境变量。
 * @returns {{ code: number, messages: object[] }} 退出码与每个请求的结果。
 */
function callPermHost(t, args, env = {}) {
  const home = mkdtempSync(join(tmpdir(), 'autopilot-perm-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const request = id => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'approve', arguments: args } })}\n`
  const result = spawnSync(process.execPath, [permHost], {
    encoding: 'utf8',
    input: request(1),
    env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: home, ...env },
  })
  const lines = result.stdout.split('\n').filter(Boolean)
  const parsed = lines.map(line => JSON.parse(line))
  const call = parsed.find(item => item.id === 1)
  const payload = call && call.result && call.result.structuredContent
  return { code: result.status, payload, out: result.stdout, err: result.stderr }
}

test('权限宿主拒绝并行提问，并提示单独调用', t => {
  const r = callPermHost(t, { tool_name: 'AskUserQuestion', input: { questions: [] } })
  assert.equal(r.code, 0, r.err)
  assert.equal(r.payload.behavior, 'deny')
  assert.ok(r.payload.message.includes('AskUserQuestion'), r.out)
})

test('权限宿主拒绝不在清单内的命令，并列出允许的命令前缀', t => {
  const r = callPermHost(t, { tool_name: 'Bash', input: { command: 'git push origin main' } },
    { AUTOPILOT_ALLOWED_COMMANDS: 'node、git status' })
  assert.equal(r.payload.behavior, 'deny')
  assert.ok(r.payload.message.startsWith('托管不允许这条命令：git push origin main'), r.payload.message)
  assert.ok(r.payload.message.includes('Bash 没有被整体禁用'), r.payload.message)
  assert.ok(r.payload.message.includes('node、git status'), r.payload.message)
  assert.ok(r.payload.message.endsWith('不要因为这条拒绝询问用户。'), r.payload.message)
})

test('权限宿主拒绝清单外的读取，并写出路径', t => {
  const r = callPermHost(t, { tool_name: 'Read', input: { file_path: '/Users/u/.ssh/config' } })
  assert.equal(r.payload.behavior, 'deny')
  assert.equal(r.payload.message, '托管不允许：Read /Users/u/.ssh/config。不要因为这条拒绝询问用户，换一种允许的方式继续。')
})

test('模板文件是合法 JSON，且写出 hook 注册与拒绝规则', t => {
  const settings = JSON.parse(readFileSync(fileURLToPath(new URL('../skills/openspec-autopilot/templates/autopilot-settings.json', import.meta.url)), 'utf8'))
  const matchers = settings.hooks.PreToolUse.map(item => item.matcher)
  assert.deepEqual(matchers, ['AskUserQuestion', 'Edit|Write|MultiEdit|NotebookEdit'])
  for (const entry of settings.hooks.PreToolUse) {
    assert.equal(entry.hooks[0].onFailure, 'block', `${entry.matcher} 的 onFailure 不是 block`)
  }
  assert.equal(settings.syncClaudeAiSkills, false)
  assert.equal(settings.syncClaudeAiPlugins, false)
  const deny = settings.permissions.deny
  for (const rule of ['Edit(**/decisions/autopilot.json)', 'Edit(**/decisions/D-*.json)', 'Edit(//<AUTOPILOT_HOME>/**)']) {
    assert.ok(deny.includes(rule), `拒绝规则缺少 ${rule}`)
  }
  for (const rule of ['Bash(git commit:*)', 'Bash(git push:*)', 'Bash(git merge:*)']) {
    assert.ok(deny.includes(rule), `拒绝规则缺少 ${rule}`)
  }
  const mcp = JSON.parse(readFileSync(fileURLToPath(new URL('../skills/openspec-autopilot/templates/autopilot-mcp.json', import.meta.url)), 'utf8'))
  assert.equal(mcp.mcpServers.autopilot.env.AUTOPILOT_ALLOWED_COMMANDS, '<ALLOWED_COMMANDS>')
})

// ---------------------------------------------------------------------------
// 调度脚本的测试脚手架（add-autopilot-loop Slice 03）
// ---------------------------------------------------------------------------

/** 调度脚本的路径。 */
const scheduler = fileURLToPath(new URL('../skills/openspec-autopilot/scripts/scheduler.mjs', import.meta.url))

/** 进度视图的一条变更条目。 */
const schedEntry = (overrides = {}) => ({
  change: 'demo', tier: 'MVP', stage: 'apply', tasks: { done: 0, total: 3 },
  openQuestions: { pending: 0, total: 0 }, rule: 'R6', blockers: [], warnings: [], notes: [],
  reviewStale: false, next: '/opsx:apply demo', error: null, ...overrides,
})

/** 托管记录。 */
const managedRecord = (overrides = {}) => ({ status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R6', tier: 'MVP', ...overrides })

/**
 * 建立一个调度用例环境：临时 git 仓库、临时 HOME、临时托管目录、三个测试替身与配置。
 * @param {object} t node:test 的用例上下文。
 * @param {object} options options.view 为进度视图；options.entries 为进度视图的 active 条目；
 *   options.files 为变更目录下的文件；options.homeFiles 为 HOME 下的文件（相对路径 → 内容）；
 *   options.config 为配置的额外字段；options.claude 为 claude 替身的预设输出；options.projectRoot 为项目根。
 */
function schedScenario(t, {
  view, entries, files = {}, homeFiles = {}, config = {}, claude, lark, projects, extraEnv = {},
} = {}) {
  const repo = tempDir(t, 'autopilot-sched-repo-')
  const home = tempDir(t, 'autopilot-sched-home-')
  const userHome = tempDir(t, 'autopilot-sched-userhome-')
  const doublesDir = tempDir(t, 'autopilot-sched-doubles-')
  const git = initRepo(repo)

  const changeDir = join(repo, 'openspec', 'changes', 'demo')
  mkdirSync(changeDir, { recursive: true })
  // 默认给变更一条托管记录：调度脚本只处理有托管记录的变更。
  writeFiles(changeDir, { 'decisions/autopilot.json': managedRecord(), ...files })
  writeFiles(userHome, homeFiles)

  // 三个替身：进度视图、claude、lark-cli。
  const { viewFile, progressBin } = progressDouble(doublesDir, view || { root: repo, active: [schedEntry()], implementing: [], archived: [] })
  const { claudeBin, claudeCalls, claudeSignals } = claudeDouble(doublesDir, { output: claude })
  const { larkBin, larkCalls } = larkDouble(doublesDir, { messageId: lark || 'om_test' })
  const fullConfig = writeConfig(home, { claudeBin, larkBin, progressBin, projects: projects || [projectOf(repo)], ...config })

  const run = (args = ['--once'], env = {}) => {
    const result = spawnSync(process.execPath, [scheduler, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, HOME: userHome, OPENSPEC_AUTOPILOT_HOME: home, ...env },
    })
    return { code: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr }
  }
  const changeRecord = () => {
    const file = join(changeDir, 'decisions', 'autopilot.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
  }
  const decisions = () => {
    const dir = join(changeDir, 'decisions')
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(name => /^D-\d{4}\.json$/.test(name)).sort()
      .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')))
  }
  return { repo, home, userHome, doublesDir, changeDir, progressBin, viewFile, run, claudeCalls, claudeSignals, larkCalls, changeRecord, decisions, git, config: fullConfig }
}

// ---------------------------------------------------------------------------
// Requirement 5：运行锁（add-autopilot-loop Slice 03，Seam：scheduler.mjs --once）
// ---------------------------------------------------------------------------

/** 本机的开机时间（秒），与运行锁中的 bootTime 同口径。 */
const bootTime = () => Math.round(Date.now() / 1000 - uptime())

/** 在托管目录中写一个运行锁。 */
function writeLock(f, lock) {
  writeFileSync(join(f.home, 'run.lock'), `${JSON.stringify(lock)}\n`)
}

/** 启动一个会等待信号的长驻进程，返回其进程号。 */
function spawnSleeper(onSignal) {
  const child = spawn(process.execPath, ['-e', `
process.on('SIGTERM', () => { ${onSignal || ''} ; process.exit(0) })
setInterval(() => {}, 1000)
`], { stdio: 'ignore' })
  return child
}

test('运行锁被占用时本轮退出，不启动 claude', t => {
  const f = schedScenario(t)
  const holder = spawnSleeper()
  t.after(() => holder.kill('SIGKILL'))
  writeLock(f, { pid: holder.pid, bootTime: bootTime(), change: null, claudePid: null })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 0)
})

test('陈旧的运行锁被替换，本轮正常运行', t => {
  const f = schedScenario(t)
  writeLock(f, { pid: 999999, bootTime: bootTime(), change: null, claudePid: null })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 1)
  assert.equal(existsSync(join(f.home, 'run.lock')), false, '退出后应删除运行锁')
})

test('上次开机留下的运行锁被替换', t => {
  const f = schedScenario(t)
  const holder = spawnSleeper()
  t.after(() => holder.kill('SIGKILL'))
  writeLock(f, { pid: holder.pid, bootTime: bootTime() - 3600, change: null, claudePid: null })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 1)
})

test('锁中的 claude 进程还活着时保留锁，不启动 claude', t => {
  const f = schedScenario(t)
  const holder = spawnSleeper()
  t.after(() => holder.kill('SIGKILL'))
  writeLock(f, { pid: 999999, bootTime: bootTime(), change: null, claudePid: holder.pid })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 0)
})

test('两个调度进程同时启动时只运行一个阶段', t => {
  const f = schedScenario(t, { files: { 'decisions/autopilot.json': managedRecord() }, claude: { session_id: 's1', stop_reason: 'end_turn' } })
  const env = { ...process.env, HOME: f.userHome, OPENSPEC_AUTOPILOT_HOME: f.home, AUTOPILOT_TEST_SLEEP: '1' }
  const first = spawn(process.execPath, [scheduler, '--once'], { cwd: f.repo, env, stdio: 'ignore' })
  const second = spawn(process.execPath, [scheduler, '--once'], { cwd: f.repo, env, stdio: 'ignore' })
  t.after(() => { first.kill('SIGKILL'); second.kill('SIGKILL') })
  return new Promise(resolve => {
    let left = 2
    const done = () => { left -= 1; if (left === 0) resolve() }
    first.on('exit', done)
    second.on('exit', done)
  }).then(() => {
    assert.equal(f.claudeCalls().length, 1, '只应运行一个阶段')
  })
})

test('读不出内容的新锁按存活处理，保留锁', t => {
  const f = schedScenario(t)
  writeFileSync(join(f.home, 'run.lock'), '')
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 0)
})

test('读不出内容的旧锁按陈旧处理并替换', t => {
  const f = schedScenario(t)
  const file = join(f.home, 'run.lock')
  writeFileSync(file, '')
  const old = new Date(Date.now() - 120 * 1000)
  utimesSync(file, old, old)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 1)
})

// ---------------------------------------------------------------------------
// Requirement 6：按进度规则选择动作（add-autopilot-loop Slice 03）
// ---------------------------------------------------------------------------

test('没有托管记录的变更不运行', t => {
  const f = schedScenario(t, { files: { 'decisions/autopilot.json': null } })
  rmSync(join(f.changeDir, 'decisions', 'autopilot.json'))
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 0)
})

test('R6 运行 apply 阶段', t => {
  const f = schedScenario(t)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const calls = f.claudeCalls()
  assert.equal(calls.length, 1)
  const prompt = calls[0].args[calls[0].args.indexOf('-p') + 1]
  assert.ok(prompt.includes('openspec-apply-change'), prompt)
  assert.ok(prompt.includes('demo'), prompt)
})

test('R8 运行 quality 阶段，提示词写明已安装目录与用户名', t => {
  const f = schedScenario(t, { view: { root: null, active: [schedEntry({ rule: 'R8', stage: 'quality' })], implementing: [], archived: [] } })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const calls = f.claudeCalls()
  assert.equal(calls.length, 1)
  const prompt = calls[0].args[calls[0].args.indexOf('-p') + 1]
  assert.ok(prompt.includes('openspec-code-quality'), prompt)
  assert.ok(prompt.includes(resolvePath(f.userHome, '.claude', 'skills', 'openspec-code-quality')), prompt)
  assert.ok(prompt.includes('tigger'), prompt)
  assert.ok(prompt.includes('只用于留痕字段'), prompt)
  assert.ok(prompt.includes('不写入签署字段'), prompt)
})

test('R9 运行 verify 阶段', t => {
  const f = schedScenario(t, { view: { root: null, active: [schedEntry({ rule: 'R9', stage: 'verify' })], implementing: [], archived: [] } })
  f.run()
  const calls = f.claudeCalls()
  assert.equal(calls.length, 1)
  const prompt = calls[0].args[calls[0].args.indexOf('-p') + 1]
  assert.ok(prompt.includes('openspec-verify-change'), prompt)
})

test('R11 运行 archive 阶段，运行前写入实现快照', t => {
  const f = schedScenario(t, { view: { root: null, active: [schedEntry({ rule: 'R11', stage: 'archive' })], implementing: [], archived: [] } })
  writeFileSync(join(f.repo, 'scripts-a.js'), 'export const a = 1\n')
  mkdirSync(join(f.repo, 'scripts'), { recursive: true })
  writeFileSync(join(f.repo, 'scripts', 'a.mjs'), 'export const a = 1\n')
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const calls = f.claudeCalls()
  assert.equal(calls.length, 1)
  const prompt = calls[0].args[calls[0].args.indexOf('-p') + 1]
  assert.ok(prompt.includes('openspec-archive-change'), prompt)
  const snapshot = f.changeRecord().implSnapshot
  assert.ok(snapshot && snapshot['scripts/a.mjs'], JSON.stringify(snapshot))
  const expected = spawnSync('git', ['hash-object', 'scripts/a.mjs'], { cwd: f.repo, encoding: 'utf8' }).stdout.trim()
  assert.equal(snapshot['scripts/a.mjs'], expected)
})

test('R5 作废托管并发通知卡片', t => {
  const f = schedScenario(t, { view: { root: null, active: [schedEntry({ rule: 'R5', stage: 'approval', blockers: ['签字行空白'] })], implementing: [], archived: [] } })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const current = f.changeRecord()
  assert.equal(current.status, 'void')
  assert.ok(current.voidReason.includes('R5'), current.voidReason)
  assert.ok(current.voidReason.includes('签字行空白'), current.voidReason)
  assert.equal(f.claudeCalls().length, 0)
  const cards = f.larkCalls()
  assert.equal(cards.length, 1)
  assert.ok(cards[0].content.includes('R5'), cards[0].content)
})

test('R10 作废托管，通知卡片列出全部卡点', t => {
  const f = schedScenario(t, { view: { root: null, active: [schedEntry({ rule: 'R10', stage: 'verify', blockers: ['卡点一', '卡点二'] })], implementing: [], archived: [] } })
  f.run()
  const cards = f.larkCalls()
  assert.equal(cards.length, 1)
  assert.ok(cards[0].content.includes('卡点一') && cards[0].content.includes('卡点二'), cards[0].content)
})

test('进度条目没有 reviewStale 时作废托管，通知卡片写明两个 skill', t => {
  const withoutStale = schedEntry()
  delete withoutStale.reviewStale
  const f = schedScenario(t, { view: { root: null, active: [withoutStale], implementing: [], archived: [] } })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.changeRecord().status, 'void')
  assert.equal(f.claudeCalls().length, 0)
  const cards = f.larkCalls()
  assert.equal(cards.length, 1)
  assert.ok(cards[0].content.includes('openspec-change-progress'), cards[0].content)
  assert.ok(cards[0].content.includes('openspec-technical-review'), cards[0].content)
})

test('有待回复决策的变更本轮不运行', t => {
  const f = schedScenario(t, { files: { 'decisions/D-0001.json': { id: 'D-0001', kind: 'question', status: 'pending', card: { messageId: 'om_1' } } } })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 0)
})

test('卡片没有发出的待回复决策会重新发送卡片', t => {
  // spec autopilot-scheduler「Failed card send is retried」：重发的是原决策卡片，不是通知卡片（quality R1 SPEC-06、STD-04）。
  const f = schedScenario(t, { files: { 'decisions/D-0001.json': {
    id: 'D-0001', kind: 'question', status: 'pending', stage: 'apply',
    request: { sessionId: 'sess-1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION), questions: QUESTION.questions },
    card: { messageId: null },
  } } })
  f.run()
  const calls = f.larkCalls()
  assert.equal(calls.length, 1)
  assert.equal(f.claudeCalls().length, 0)
  const card = JSON.parse(calls[0].content)
  const elements = JSON.stringify(card.body.elements)
  assert.ok(elements.includes('select_static'), elements)
  assert.ok(elements.includes(QUESTION.questions[0].question), elements)
  assert.ok(elements.includes('"d":"D-0001"'), elements)
  assert.equal(f.decisions()[0].card.messageId, 'om_test', '发送成功后要写回 messageId')
})

// ---------------------------------------------------------------------------
// Requirement 7：启动前核对（add-autopilot-loop Slice 03）
// ---------------------------------------------------------------------------

/** 写用户级或项目级设置文件。 */
const settingsFile = (base, value) => writeFileSync(join(base, 'settings.json'), `${JSON.stringify(value, null, 2)}\n`)

test('设置文件中有清单外的允许规则时本轮不运行并通知', t => {
  const f = schedScenario(t, { homeFiles: { '.claude/settings.json': { permissions: { allow: ['Bash(curl:*)'] } } } })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 0)
  assert.equal(f.changeRecord().status, 'active')
  const cards = f.larkCalls()
  assert.equal(cards.length, 1)
  assert.ok(cards[0].content.includes('Bash(curl:*)'), cards[0].content)
  assert.ok(cards[0].content.includes('.claude/settings.json'), cards[0].content)
})

test('同样的规则清单只发一次通知卡片', t => {
  const f = schedScenario(t, { homeFiles: { '.claude/settings.json': { permissions: { allow: ['Bash(curl:*)'] } } } })
  f.run()
  f.run()
  assert.equal(f.larkCalls().length, 1)
})

test('项目设置文件中有 PreToolUse hook 时本轮不运行', t => {
  const f = schedScenario(t)
  mkdirSync(join(f.repo, '.claude'), { recursive: true })
  settingsFile(join(f.repo, '.claude'), { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'x' }] }] } })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 0)
  const cards = f.larkCalls()
  assert.equal(cards.length, 1)
  assert.ok(cards[0].content.includes('PreToolUse'), cards[0].content)
})

test('skill 文件头中有清单外的 allowed-tools 时本轮不运行', t => {
  const f = schedScenario(t, { homeFiles: { '.claude/skills/x/SKILL.md': '---\nname: x\nallowed-tools: Bash(curl *)\n---\n\n说明。\n' } })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 0)
  const cards = f.larkCalls()
  assert.equal(cards.length, 1)
  assert.ok(cards[0].content.includes('Bash(curl *)'), cards[0].content)
})

test('只能由用户手动调用的 skill 不检查 allowed-tools', t => {
  const f = schedScenario(t, { homeFiles: { '.claude/skills/x/SKILL.md': '---\nname: x\nallowed-tools: Bash(curl *)\ndisable-model-invocation: true\n---\n\n说明。\n' } })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 1)
})

test('项目 skill 文件头中有 hook 时本轮不运行', t => {
  const f = schedScenario(t, { homeFiles: { '.claude/skills/y/SKILL.md': '---\nname: y\nhooks:\n  PreToolUse:\n    - type: command\n---\n\n说明。\n' } })
  f.run()
  assert.equal(f.claudeCalls().length, 0)
  const cards = f.larkCalls()
  assert.ok(cards[0].content.includes('SKILL.md'), cards[0].content)
})

test('已回复的决策在设置文件有清单外的允许规则时不恢复会话', t => {
  // quality R1 SPEC-08：恢复会话之前也要做启动前核对（spec autopilot-scheduler 第 3 条「starts or resumes」）。
  const f = schedScenario(t, {
    files: { 'decisions/D-0001.json': answeredQuestion({ stage: 'apply' }) },
    homeFiles: { '.claude/settings.json': { permissions: { allow: ['Bash(curl:*)'] } } },
  })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 0, '核对不通过时不应恢复会话')
  assert.equal(f.decisions()[0].status, 'answered')
  const cards = f.larkCalls()
  assert.equal(cards.length, 1)
  assert.ok(cards[0].content.includes('Bash(curl:*)'), cards[0].content)
})

test('YAML 列表写法的 allowed-tools 含清单外的工具时本轮不运行', t => {
  const f = schedScenario(t, { homeFiles: {
    '.claude/skills/y/SKILL.md': '---\nname: y\nallowed-tools:\n  - Read\n  - Bash(curl:*)\n---\n\n说明。\n',
  } })
  f.run()
  assert.equal(f.claudeCalls().length, 0)
  const cards = f.larkCalls()
  assert.ok(cards.length === 1 && cards[0].content.includes('Bash(curl:*)'), JSON.stringify(cards))
})

test('空格分隔的 allowed-tools 按条目核对，括号内的空格不拆开', t => {
  const f = schedScenario(t, {
    config: { projects: undefined },
    homeFiles: { '.claude/skills/y/SKILL.md': '---\nname: y\nallowed-tools: Read Bash(git status:*) WebFetch\n---\n\n说明。\n' },
  })
  writeFileSync(join(f.home, 'config.json'), `${JSON.stringify({
    ...f.config, projects: [projectOf(f.repo, { allowedCommands: ['Bash(git status:*)'] })],
  }, null, 2)}\n`)
  f.run()
  assert.equal(f.claudeCalls().length, 0)
  const content = f.larkCalls().map(call => call.content || '').join('\n')
  assert.ok(content.includes('allowed-tools WebFetch'), content)
  assert.ok(!content.includes('allowed-tools Bash(git status:*)'), content)
})

test('allowed-tools 写了键却解析不出条目时本轮不运行', t => {
  const f = schedScenario(t, { homeFiles: { '.claude/skills/y/SKILL.md': '---\nname: y\nallowed-tools:\n---\n\n说明。\n' } })
  f.run()
  assert.equal(f.claudeCalls().length, 0)
  const content = f.larkCalls().map(call => call.content || '').join('\n')
  assert.ok(content.includes('allowed-tools 无法解析'), content)
})

test('项目中名为 worktrees 的普通目录下的 skill 也被核对', t => {
  const f = schedScenario(t)
  const skill = join(f.repo, 'tools', 'worktrees', '.claude', 'skills', 'y', 'SKILL.md')
  mkdirSync(dirname(skill), { recursive: true })
  writeFileSync(skill, '---\nname: y\nallowed-tools: Bash(curl:*)\n---\n')
  f.run()
  assert.equal(f.claudeCalls().length, 0)
  const content = f.larkCalls().map(call => call.content || '').join('\n')
  assert.ok(content.includes('tools/worktrees/.claude/skills/y/SKILL.md'), content)
})

test('项目级 skill 目录带插件清单时本轮不运行', t => {
  const f = schedScenario(t)
  const dir = join(f.repo, '.claude', 'skills', 'y')
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: y\n---\n')
  f.run()
  assert.equal(f.claudeCalls().length, 0)
  const content = f.larkCalls().map(call => call.content || '').join('\n')
  assert.ok(content.includes('.claude-plugin'), content)
})

test('运行环境检查不通过时发一张通知卡片，同一原因只发一次', t => {
  // spec autopilot-scheduler 第 4 条：larkBin 能运行且有 ownerOpenId 时，每个新原因发一张通知卡片。
  const f = schedScenario(t)
  writeFileSync(join(f.home, 'config.json'), `${JSON.stringify({ ...f.config, claudeBin: join(f.home, 'no-such-claude') }, null, 2)}\n`)
  assert.equal(f.run().code, 2)
  assert.equal(f.run().code, 2)
  const cards = f.larkCalls()
  assert.equal(cards.length, 1, JSON.stringify(cards.map(call => call.content)))
  assert.ok(cards[0].content.includes('no-such-claude'), cards[0].content)
})

test('设置文件中有 additionalDirectories 时本轮不运行', t => {
  const f = schedScenario(t, { homeFiles: { '.claude/settings.json': { permissions: { additionalDirectories: ['/tmp/extra'] } } } })
  f.run()
  assert.equal(f.claudeCalls().length, 0)
  const cards = f.larkCalls()
  assert.ok(cards[0].content.includes('/tmp/extra'), cards[0].content)
})

test('设置文件中有 disableAllHooks 时本轮不运行', t => {
  const f = schedScenario(t, { homeFiles: { '.claude/settings.json': { disableAllHooks: true } } })
  f.run()
  assert.equal(f.claudeCalls().length, 0)
  const cards = f.larkCalls()
  assert.ok(cards[0].content.includes('disableAllHooks'), cards[0].content)
})

test('软链接指向的 skill 目录会被扫描', t => {
  const f = schedScenario(t)
  const store = join(f.doublesDir, 'store', 'x')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'SKILL.md'), '---\nname: x\nallowed-tools: Bash(curl *)\n---\n\n说明。\n')
  mkdirSync(join(f.userHome, '.claude', 'skills'), { recursive: true })
  symlinkSync(store, join(f.userHome, '.claude', 'skills', 'x'))
  f.run()
  assert.equal(f.claudeCalls().length, 0)
  const cards = f.larkCalls()
  assert.ok(cards[0].content.includes('Bash(curl *)'), cards[0].content)
})

test('subagent 子目录中的文件会被扫描', t => {
  const f = schedScenario(t, { homeFiles: { '.claude/agents/review/x.md': '---\nname: review\nhooks:\n  PreToolUse:\n    - type: command\n---\n\n说明。\n' } })
  f.run()
  assert.equal(f.claudeCalls().length, 0)
  const cards = f.larkCalls()
  assert.ok(cards[0].content.includes('x.md'), cards[0].content)
})

test('skill 目录带插件清单时本轮不运行', t => {
  const f = schedScenario(t, { homeFiles: { '.claude/skills/z/.claude-plugin/plugin.json': '{}\n' } })
  f.run()
  assert.equal(f.claudeCalls().length, 0)
  const cards = f.larkCalls()
  assert.ok(cards[0].content.includes('.claude-plugin'), cards[0].content)
})

// ---------------------------------------------------------------------------
// Requirement 8：headless 运行参数（add-autopilot-loop Slice 03）
// ---------------------------------------------------------------------------

test('headless 运行只传必要的环境变量与参数', t => {
  const f = schedScenario(t)
  const result = f.run(['--once'], { CLAUDE_CODE_ENTRYPOINT: 'desktop' })
  assert.equal(result.code, 0, result.all)
  const calls = f.claudeCalls()
  assert.equal(calls.length, 1)
  const env = calls[0].env
  assert.deepEqual(Object.keys(env).filter(key => key.startsWith('CLAUDE_CODE_')), [])
  const args = calls[0].args
  for (const expected of ['--model', '--setting-sources', 'user,project', '--disallowedTools', 'WebFetch WebSearch',
    '--permission-prompt-tool', 'mcp__autopilot__approve', '--max-budget-usd']) {
    assert.ok(args.includes(expected), `参数缺少 ${expected}：${args.join(' ')}`)
  }
})

test('配置没有 model 时退出码 2 且不启动 claude', t => {
  const f = schedScenario(t, { config: { model: '' } })
  const result = f.run()
  assert.equal(result.code, 2, result.all)
  assert.equal(f.claudeCalls().length, 0)
})

test('写出的设置文件指向已安装的 hook 与权限宿主', t => {
  const f = schedScenario(t)
  f.run()
  const settings = readFileSync(join(f.home, 'settings.json'), 'utf8')
  assert.ok(!settings.includes('<SKILL_DIR>') && !settings.includes('<AUTOPILOT_HOME>'), settings)
  assert.ok(settings.includes('autopilot-hook.mjs'), settings)
  assert.ok(settings.includes('onFailure'), settings)
  const mcp = readFileSync(join(f.home, 'mcp.json'), 'utf8')
  assert.ok(!mcp.includes('<ALLOWED_COMMANDS>'), mcp)
})

test('skill 目录的读取规则同时覆盖软链接路径与实际路径', t => {
  const f = schedScenario(t)
  const store = join(f.doublesDir, 'store', 'demo')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'SKILL.md'), '---\nname: demo\n---\n\n说明。\n')
  mkdirSync(join(f.userHome, '.claude', 'skills'), { recursive: true })
  symlinkSync(store, join(f.userHome, '.claude', 'skills', 'demo'))
  f.run()
  const calls = f.claudeCalls()
  assert.equal(calls.length, 1)
  const allowed = calls[0].args[calls[0].args.indexOf('--allowedTools') + 1]
  assert.ok(allowed.includes(`Read(//${resolvePath(f.userHome, '.claude', 'skills')}/**)`), allowed)
  const storeReal = realpathSync(store)
  assert.ok(allowed.includes(`Read(//${storeReal}/**)`), allowed)
  assert.ok(allowed.includes(`Grep(//${storeReal}/**)`), allowed)
  assert.ok(allowed.includes(`Glob(//${storeReal}/**)`), allowed)
  assert.ok(!allowed.includes(`Read(//${realpathSync(join(f.doublesDir, 'store'))}/**)`), allowed)
})

test('skill 条目指向主目录时退出码 2', t => {
  const f = schedScenario(t)
  mkdirSync(join(f.userHome, '.claude', 'skills'), { recursive: true })
  symlinkSync(f.userHome, join(f.userHome, '.claude', 'skills', 'demo'))
  const result = f.run()
  assert.equal(result.code, 2, result.all)
  assert.equal(f.claudeCalls().length, 0)
  const logs = readFileSync(join(f.home, 'logs', 'scheduler.log'), 'utf8')
  assert.ok(logs.includes('demo'), logs)
})

test('没有 SKILL.md 的条目不生成读取规则，但记录日志', t => {
  const f = schedScenario(t)
  const cc = join(f.doublesDir, 'cc-switch')
  mkdirSync(cc, { recursive: true })
  const store = join(f.doublesDir, 'store', 'demo')
  mkdirSync(store, { recursive: true })
  writeFileSync(join(store, 'SKILL.md'), '---\nname: demo\n---\n\n说明。\n')
  mkdirSync(join(f.userHome, '.claude', 'skills'), { recursive: true })
  symlinkSync(cc, join(f.userHome, '.claude', 'skills', 'cc'))
  symlinkSync(store, join(f.userHome, '.claude', 'skills', 'demo'))
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const calls = f.claudeCalls()
  assert.equal(calls.length, 1)
  const allowed = calls[0].args[calls[0].args.indexOf('--allowedTools') + 1]
  assert.ok(allowed.includes(`Read(//${realpathSync(store)}/**)`), allowed)
  assert.ok(!allowed.includes(realpathSync(cc)), allowed)
  const logs = readFileSync(join(f.home, 'logs', 'scheduler.log'), 'utf8')
  assert.ok(logs.includes('cc'), logs)
})

test('progressBin 在项目内时退出码 2', t => {
  const f = schedScenario(t)
  const inside = join(f.repo, 'scripts', 'progress.mjs')
  mkdirSync(join(f.repo, 'scripts'), { recursive: true })
  writeFileSync(inside, 'process.stdout.write("{}")\n')
  writeFileSync(join(f.home, 'config.json'), `${JSON.stringify({ ...f.config, progressBin: inside }, null, 2)}\n`)
  const result = f.run()
  assert.equal(result.code, 2, result.all)
  assert.equal(f.claudeCalls().length, 0)
})

test('claudeBin 不存在时退出码 2', t => {
  const f = schedScenario(t)
  writeFileSync(join(f.home, 'config.json'), `${JSON.stringify({ ...f.config, claudeBin: join(f.home, 'no-such-claude') }, null, 2)}\n`)
  const result = f.run()
  assert.equal(result.code, 2, result.all)
  assert.equal(f.claudeCalls().length, 0)
  const logs = readFileSync(join(f.home, 'logs', 'scheduler.log'), 'utf8')
  assert.ok(logs.includes('claudeBin'), logs)
})

test('allowedCommands 中有工具名时退出码 2', t => {
  const f = schedScenario(t)
  writeFileSync(join(f.home, 'config.json'), `${JSON.stringify({
    ...f.config, projects: [{ root: f.repo, allowedCommands: ['Write'], baseBranch: 'main', branchPrefix: 'fix/' }],
  }, null, 2)}\n`)
  const result = f.run()
  assert.equal(result.code, 2, result.all)
  assert.equal(f.claudeCalls().length, 0)
  const logs = readFileSync(join(f.home, 'logs', 'scheduler.log'), 'utf8')
  assert.ok(logs.includes('Write'), logs)
})

test('项目根不是仓库根时退出码 2', t => {
  const f = schedScenario(t)
  const sub = join(f.repo, 'sub')
  mkdirSync(sub, { recursive: true })
  mkdirSync(join(sub, 'openspec', 'changes'), { recursive: true })
  writeFileSync(join(f.home, 'config.json'), `${JSON.stringify({
    ...f.config, projects: [{ root: sub, allowedCommands: ['Bash(node:*)'], baseBranch: 'main', branchPrefix: 'fix/' }],
  }, null, 2)}\n`)
  const result = f.run()
  assert.equal(result.code, 2, result.all)
  assert.equal(f.claudeCalls().length, 0)
})

// ---------------------------------------------------------------------------
// Requirement 6/10：撤回时停止正在运行的阶段（add-autopilot-loop Slice 03，design D12）
// ---------------------------------------------------------------------------

/** 撤回用例的场景：托管记录、运行锁与一个等待信号的长驻进程。 */
function cancelScenario(t, { lock, recordValue = managedRecord(), cancelWaitSeconds = 5 } = {}) {
  const repo = tempDir(t, 'autopilot-cancel-repo-')
  const home = tempDir(t, 'autopilot-cancel-home-')
  initRepo(repo)
  const { progressBin } = progressDouble(home, { root: repo, active: [schedEntry()], implementing: [], archived: [] })
  writeConfig(home, { cancelWaitSeconds, progressBin, projects: [projectOf(repo)] })
  const changeDir = join(repo, 'openspec', 'changes', 'demo')
  writeFiles(changeDir, { 'decisions/autopilot.json': recordValue })
  if (lock) writeFileSync(join(home, 'run.lock'), `${JSON.stringify(lock)}\n`)

  const run = (args, env = {}) => {
    const result = spawnSync(process.execPath, [autopilot, ...args], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: home, ...env },
    })
    return { code: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr }
  }
  const record = () => JSON.parse(readFileSync(join(changeDir, 'decisions', 'autopilot.json'), 'utf8'))
  return { repo, home, changeDir, run, record }
}

/** 启动一个会在收到 SIGTERM 时执行回调并退出的进程。 */
function spawnSignalTarget(onTerm, { ignore = false } = {}) {
  const child = spawn(process.execPath, ['-e', `
${ignore ? 'process.on("SIGTERM", () => {})' : `process.on("SIGTERM", () => { ${onTerm || ''} ; process.exit(0) })`}
setInterval(() => {}, 1000)
`], { stdio: 'ignore' })
  return child
}

/**
 * 启动一个分离的辅助进程：延时后执行一段脚本再退出。用于模拟调度进程释放锁。
 * 不用测试进程内的定时器：撤回命令是 spawnSync 同步运行的，会阻塞测试进程的事件循环。
 */
function spawnHelper(script, delayMs) {
  // 脚本自行决定何时结束：脚本里的嵌套定时器（如延时删除锁）不能在回调后立刻退出。
  const child = spawn(process.execPath, ['-e', `
setTimeout(() => { ${script} }, ${delayMs})
`], { stdio: 'ignore', detached: true })
  child.unref()
  return child
}

test('撤回时向运行中的阶段进程组发 SIGTERM', t => {
  const scheduler = spawnSignalTarget()
  t.after(() => scheduler.kill('SIGKILL'))
  const f = cancelScenario(t, { lock: { pid: scheduler.pid, bootTime: bootTime(), change: 'demo', claudePid: null } })
  // 目标进程收到 SIGTERM 后删除运行锁并退出。
  const target = spawnSignalTarget(`require('node:fs').unlinkSync(${JSON.stringify(join(f.home, 'run.lock'))})`)
  t.after(() => target.kill('SIGKILL'))
  writeFileSync(join(f.home, 'run.lock'), `${JSON.stringify({
    pid: scheduler.pid, bootTime: bootTime(), change: 'demo', claudePid: target.pid,
  })}\n`)
  const result = f.run(['cancel', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.equal(f.record().status, 'void')
})

/**
 * 轮询等待条件成立。
 * @param {Function} condition 返回真值时结束等待。
 * @param {number} timeoutMs 最长等待毫秒数。
 * @returns {Promise<boolean>} 条件在超时前成立时为 true。
 */
async function waitFor(condition, timeoutMs) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (condition()) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return Boolean(condition())
}

test('调度脚本运行阶段时撤回，claude 替身收到 SIGTERM，撤回退出码 0', async t => {
  // quality R1 SPEC-01：经过调度脚本，而不是测试自己写锁。
  const f = schedScenario(t, { config: { cancelWaitSeconds: 8 } })
  writeFileSync(join(f.doublesDir, 'sleep.json'), '20')
  const env = { ...process.env, HOME: f.userHome, OPENSPEC_AUTOPILOT_HOME: f.home }
  const sched = spawn(process.execPath, [scheduler, '--once'], { cwd: f.repo, env, stdio: 'ignore' })
  t.after(() => {
    sched.kill('SIGKILL')
    for (const call of f.claudeCalls()) {
      try { process.kill(call.pid, 'SIGKILL') } catch { /* 替身已退出 */ }
    }
  })
  assert.ok(await waitFor(() => f.claudeCalls().length === 1, 10000), 'claude 替身没有启动')
  const cancel = await new Promise(resolve => {
    const child = spawn(process.execPath, [autopilot, 'cancel', 'demo'], { cwd: f.repo, env })
    let all = ''
    child.stdout.on('data', chunk => { all += chunk })
    child.stderr.on('data', chunk => { all += chunk })
    child.on('exit', code => resolve({ code, all }))
  })
  assert.equal(cancel.code, 0, cancel.all)
  assert.equal(f.claudeSignals().length, 1, '运行中的 claude 应收到一次 SIGTERM')
  assert.equal(f.changeRecord().status, 'void')
})

test('恢复会话期间撤回，恢复的 claude 收到 SIGTERM，撤回退出码 0', async t => {
  // quality R1 SPEC-04：恢复会话之前也要写锁中的 change 再复核托管记录。
  const f = schedScenario(t, {
    config: { cancelWaitSeconds: 8 },
    files: { 'decisions/D-0001.json': answeredQuestion({ stage: 'apply' }) },
  })
  writeFileSync(join(f.doublesDir, 'sleep.json'), '20')
  const env = { ...process.env, HOME: f.userHome, OPENSPEC_AUTOPILOT_HOME: f.home }
  const sched = spawn(process.execPath, [scheduler, '--once'], { cwd: f.repo, env, stdio: 'ignore' })
  t.after(() => {
    sched.kill('SIGKILL')
    for (const call of f.claudeCalls()) {
      try { process.kill(call.pid, 'SIGKILL') } catch { /* 替身已退出 */ }
    }
  })
  assert.ok(await waitFor(() => f.claudeCalls().length === 1, 10000), 'claude 替身没有启动')
  assert.ok(f.claudeCalls()[0].args.includes('--resume'), JSON.stringify(f.claudeCalls()[0].args))
  const cancel = await new Promise(resolve => {
    const child = spawn(process.execPath, [autopilot, 'cancel', 'demo'], { cwd: f.repo, env })
    let all = ''
    child.stdout.on('data', chunk => { all += chunk })
    child.stderr.on('data', chunk => { all += chunk })
    child.on('exit', code => resolve({ code, all }))
  })
  assert.equal(cancel.code, 0, cancel.all)
  assert.equal(f.claudeSignals().length, 1, '恢复的 claude 应收到一次 SIGTERM')
})

test('阶段不停止时撤回退出码为 1 并说明仍在停止', t => {
  const target = spawnSignalTarget('', { ignore: true })
  t.after(() => target.kill('SIGKILL'))
  const f = cancelScenario(t, { lock: { pid: target.pid, bootTime: bootTime(), change: 'demo', claudePid: target.pid },
    cancelWaitSeconds: 1 })
  const result = f.run(['cancel', 'demo'])
  assert.equal(result.code, 1, result.all)
  assert.ok(result.all.includes('仍在停止'), result.all)
  assert.equal(f.record().status, 'void')
})

test('锁中没有 claude 进程时撤回只等待锁释放，不发信号', t => {
  const marker = '/tmp/autopilot-cancel-signal-marker'
  rmSync(marker, { force: true })
  const scheduler = spawnSignalTarget()
  t.after(() => scheduler.kill('SIGKILL'))
  const f = cancelScenario(t, { lock: { pid: scheduler.pid, bootTime: bootTime(), change: 'demo', claudePid: null } })
  // 模拟调度进程：一秒后删除运行锁。
  spawnHelper(`require('node:fs').unlinkSync(${JSON.stringify(join(f.home, 'run.lock'))})`, 1000)
  const result = f.run(['cancel', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.equal(existsSync(marker), false, '不该向 claudePid 为 null 的情况发信号')
  assert.equal(f.record().status, 'void')
})

test('等待期间出现 claude 进程时补发一次 SIGTERM', t => {
  const marker = '/tmp/autopilot-cancel-signal-marker'
  rmSync(marker, { force: true })
  const scheduler = spawnSignalTarget()
  t.after(() => scheduler.kill('SIGKILL'))
  const f = cancelScenario(t, { lock: { pid: scheduler.pid, bootTime: bootTime(), change: 'demo', claudePid: null } })
  const target = spawnSignalTarget(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)
  t.after(() => target.kill('SIGKILL'))
  // 模拟调度进程：一秒后写入 claudePid，再删除运行锁。
  spawnHelper(`const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(join(f.home, 'run.lock'))}, JSON.stringify({ pid: ${scheduler.pid}, bootTime: ${bootTime()}, change: 'demo', claudePid: ${target.pid} }))
setTimeout(() => { fs.unlinkSync(${JSON.stringify(join(f.home, 'run.lock'))}); process.exit(0) }, 2000)`, 1000)
  const result = f.run(['cancel', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.equal(existsSync(marker), true, '等待期间出现的 claude 进程应收到 SIGTERM')
})

test('记录已是 void 时撤回仍停止正在运行的阶段，不改文件', t => {
  const scheduler = spawnSignalTarget()
  t.after(() => scheduler.kill('SIGKILL'))
  const f = cancelScenario(t, {
    lock: { pid: scheduler.pid, bootTime: bootTime(), change: 'demo', claudePid: null },
    recordValue: { status: 'void', startedAt: '2026-11-06T10:00:00Z', voidReason: '用户撤回' },
  })
  const target = spawnSignalTarget(`require('node:fs').unlinkSync(${JSON.stringify(join(f.home, 'run.lock'))})`)
  t.after(() => target.kill('SIGKILL'))
  writeFileSync(join(f.home, 'run.lock'), `${JSON.stringify({
    pid: scheduler.pid, bootTime: bootTime(), change: 'demo', claudePid: target.pid,
  })}\n`)
  const before = f.record()
  const result = f.run(['cancel', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.deepEqual(f.record(), before)
})

test('调度脚本写回记录后撤回再作废一次', t => {
  const f = cancelScenario(t, { lock: { pid: 999999, bootTime: bootTime(), change: 'demo', claudePid: null } })
  // 模拟调度脚本：撤回写入 void 之后写回 active（startedAt 不变），随后释放锁。
  spawnHelper(`const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(join(f.changeDir, 'decisions', 'autopilot.json'))}, JSON.stringify({ status: 'active', startedAt: '2026-11-06T10:00:00Z', rerunStage: 'quality' }, null, 2))
setTimeout(() => { fs.unlinkSync(${JSON.stringify(join(f.home, 'run.lock'))}); process.exit(0) }, 300)`, 500)
  const result = f.run(['cancel', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.equal(f.record().status, 'void')
})

test('阶段还在停止时拒绝重新托管', t => {
  const scheduler = spawnSignalTarget()
  t.after(() => scheduler.kill('SIGKILL'))
  const f = cancelScenario(t, {
    lock: { pid: scheduler.pid, bootTime: bootTime(), change: 'demo', claudePid: null },
    recordValue: { status: 'void', startedAt: '2026-11-06T10:00:00Z' },
  })
  const target = spawnSignalTarget()
  t.after(() => target.kill('SIGKILL'))
  writeFileSync(join(f.home, 'run.lock'), `${JSON.stringify({
    pid: scheduler.pid, bootTime: bootTime(), change: 'demo', claudePid: target.pid,
  })}\n`)
  const before = f.record()
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 1, result.all)
  assert.deepEqual(f.record(), before)
})

// ---------------------------------------------------------------------------
// Requirement 9/10：运行后重新定位变更与决策终态（add-autopilot-loop Slice 03）
// ---------------------------------------------------------------------------

/** 让调度场景的进度视图可被测试在运行中改写。 */
function mutableView(f, view) {
  writeFileSync(f.viewFile, JSON.stringify({ ...view, root: f.repo }))
}

test('归档阶段移动目录后，决策写在归档目录中', t => {
  const f = schedScenario(t, {
    view: { root: null, active: [schedEntry({ rule: 'R11', stage: 'archive' })], implementing: [], archived: [] },
    claude: { session_id: 's1', stop_reason: 'tool_deferred', is_error: true, subtype: 'error_max_budget_usd',
      deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input: QUESTION } },
  })
  // 归档阶段把变更目录移到归档目录：替身脚本在运行时移动目录。
  const archive = join(f.repo, 'openspec', 'changes', 'archive', '2026-11-06-demo')
  mkdirSync(join(f.repo, 'openspec', 'changes', 'archive'), { recursive: true })
  renameSync(f.changeDir, archive)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(existsSync(join(f.changeDir, 'decisions', 'D-0001.json')), false, '原目录不该留下决策')
  const decisionsDir = join(archive, 'decisions')
  assert.equal(existsSync(decisionsDir), true, '决策应写在归档目录')
})

test('托管被撤回后不创建决策也不发卡片', t => {
  const f = schedScenario(t, {
    claude: { session_id: 's1', stop_reason: 'tool_deferred',
      deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input: QUESTION } },
  })
  // 调度脚本运行 claude 的过程中把托管记录改为 void：进度视图替身按调用次数切换输出。
  const original = JSON.parse(readFileSync(f.viewFile, 'utf8'))
  const counter = `${f.viewFile}.count`
  writeFileSync(f.progressBin, `import { existsSync, readFileSync, writeFileSync } from 'node:fs'\n`
    + `const n = Number(existsSync(${JSON.stringify(counter)}) ? readFileSync(${JSON.stringify(counter)}, 'utf8') : 0)\n`
    + `writeFileSync(${JSON.stringify(counter)}, String(n + 1))\n`
    + `const view = n === 0 ? ${JSON.stringify(original)} : ${JSON.stringify({ ...original, active: [] })}\n`
    + `process.stdout.write(JSON.stringify(view))\n`)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.decisions().filter(item => item.kind === 'question').length, 0)
  assert.equal(f.larkCalls().length, 0)
})

test('停在提问上时创建提问决策，卡片包含问题与选项', t => {
  const f = schedScenario(t, {
    claude: { session_id: 's1', stop_reason: 'tool_deferred',
      deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input: QUESTION } },
  })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const decisions = f.decisions()
  assert.equal(decisions.length, 1)
  const decision = decisions[0]
  assert.equal(decision.status, 'pending')
  assert.equal(decision.kind, 'question')
  assert.equal(decision.request.sessionId, 's1')
  assert.equal(decision.request.toolUseId, 'T1')
  assert.match(decision.request.fingerprint, /^[0-9a-f]{12}$/)
  const cards = f.larkCalls()
  assert.equal(cards.length, 1, '应发出一张提问卡片')
  // spec「Deferred question becomes a card」：卡片文本含问题与两个选项标签（quality R1 SPEC-11）。
  assert.ok(cards[0].content.includes(QUESTION.questions[0].question), cards[0].content)
  assert.ok(cards[0].content.includes('"蓝"') && cards[0].content.includes('"红"'), cards[0].content)
})

/**
 * 统计卡片的组件：表单内与表单外各自的组件 tag。
 * @param {string} content lark-cli 替身记录的卡片内容。
 * @returns {{ form: string[], outsideButtons: number, forms: number, form0: object }} 统计结果。
 */
function cardShape(content) {
  const card = JSON.parse(content)
  const forms = card.body.elements.filter(element => element.tag === 'form')
  const form = forms[0] || { elements: [] }
  return {
    forms: forms.length,
    form: form.elements.map(element => element.tag),
    outsideButtons: card.body.elements.filter(element => element.tag === 'button').length,
    form0: form,
  }
}

test('只有一个问题时也用表单：一个下拉选择、一个输入框、一个提交按钮', t => {
  // spec autopilot-decisions「Single question uses a form with free text」（quality R1 SPEC-11）。
  const f = schedScenario(t, {
    claude: { session_id: 's1', stop_reason: 'tool_deferred',
      deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input: QUESTION } },
  })
  f.run()
  const shape = cardShape(f.larkCalls()[0].content)
  assert.equal(shape.forms, 1)
  assert.deepEqual(shape.form.filter(tag => tag !== 'markdown'), ['select_static', 'input', 'button'])
  const select = shape.form0.elements.find(element => element.tag === 'select_static')
  assert.deepEqual(select.options.map(option => option.value), ['蓝', '红'])
  assert.equal(shape.outsideButtons, 0)
})

test('两个问题、第二个多选时用一个表单', t => {
  // spec autopilot-decisions「Multiple questions use a form」（quality R1 SPEC-11）。
  const input = { questions: [
    { question: '第一个问题？', header: 'Q1', multiSelect: false, options: [{ label: '甲' }, { label: '乙' }] },
    { question: '第二个问题？', header: 'Q2', multiSelect: true, options: [{ label: '丙' }, { label: '丁' }] },
  ] }
  const f = schedScenario(t, {
    claude: { session_id: 's1', stop_reason: 'tool_deferred', deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input } },
  })
  f.run()
  const shape = cardShape(f.larkCalls()[0].content)
  assert.equal(shape.forms, 1)
  const tags = shape.form.filter(tag => tag !== 'markdown')
  assert.equal(tags.filter(tag => tag === 'select_static').length, 1)
  assert.equal(tags.filter(tag => tag === 'multi_select_static').length, 1)
  assert.equal(tags.filter(tag => tag === 'input').length, 2)
  assert.equal(tags.filter(tag => tag === 'button').length, 1)
  assert.equal(shape.outsideButtons, 0)
})

// ---------------------------------------------------------------------------
// Requirement 5/7：恢复会话与决策终态（add-autopilot-loop Slice 04）
// ---------------------------------------------------------------------------

/** 已回复的提问决策：answers 把问题映射到选项标签。 */
const answeredQuestionDecision = (overrides = {}) => ({
  id: 'D-0003',
  kind: 'question',
  status: 'answered',
  stage: 'quality',
  request: {
    sessionId: 's1',
    toolUseId: 'T1',
    fingerprint: fingerprintOf(QUESTION),
    questions: QUESTION.questions,
  },
  answer: {
    operatorId: 'ou_owner',
    eventId: 'E1',
    answeredAt: '2026-11-16T10:00:00Z',
    answers: { 'STD-01 没有对应任务，怎么处理？': '新增任务（推荐）' },
    selected: { 'STD-01 没有对应任务，怎么处理？': '新增任务（推荐）' },
    text: {},
  },
  ...overrides,
})

test('已回复的提问恢复会话，不带提示词', t => {
  const f = schedScenario(t, { files: { 'decisions/D-0003.json': answeredQuestionDecision() },
    claude: { session_id: 's1', stop_reason: 'end_turn', result: 'done' } })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const calls = f.claudeCalls()
  assert.equal(calls.length, 1)
  const args = calls[0].args
  assert.ok(args.includes('--resume'), args.join(' '))
  assert.equal(args[args.indexOf('--resume') + 1], 's1')
  assert.ok(!args.includes('-p'), '恢复已回复的提问时不带提示词')
  const decision = f.decisions().find(item => item.id === 'D-0003')
  assert.equal(decision.status, 'used')
})

test('恢复后停在同一个提问上时原决策作废并创建新决策', t => {
  const changed = { questions: [{ question: '换了一个问题？', header: '换了一个问题？', multiSelect: false, options: [{ label: '好' }] }] }
  const f = schedScenario(t, {
    files: { 'decisions/D-0003.json': answeredQuestionDecision() },
    claude: { session_id: 's1', stop_reason: 'tool_deferred',
      deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input: changed } },
  })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const old = f.decisions().find(item => item.id === 'D-0003')
  assert.equal(old.status, 'void')
  assert.equal(old.voidReason, '提问已变化')
  const created = f.decisions().find(item => item.id !== 'D-0003')
  assert.ok(created, '应创建新的决策')
  assert.equal(created.status, 'pending')
  assert.equal(created.request.toolUseId, 'T1')
  assert.equal(created.request.questions[0].header, '换了一个问题？')
})

test('会话无法恢复时决策作废，下一轮按规则重跑', t => {
  const f = schedScenario(t, {
    files: { 'decisions/D-0003.json': answeredQuestionDecision() },
    claude: { session_id: 's1', stop_reason: 'tool_deferred_unavailable' },
  })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const decision = f.decisions().find(item => item.id === 'D-0003')
  assert.equal(decision.status, 'void')
  assert.equal(decision.voidReason, '会话无法恢复')
  // spec autopilot-scheduler 第 6 条：发通知卡片说明阶段会重跑（quality R1 SPEC-10）。
  const notices = f.larkCalls().map(call => call.content || '').join('\n')
  assert.ok(notices.includes('重跑'), notices)
  // 下一轮：决策已作废，按规则重新运行阶段。
  const second = f.run()
  assert.equal(second.code, 0, second.all)
  assert.equal(f.claudeCalls().length, 2)
  const prompt = f.claudeCalls()[1].args[f.claudeCalls()[1].args.indexOf('-p') + 1]
  assert.ok(prompt.includes('openspec-apply-change'), prompt)
})

test('恢复时报找不到会话按会话无法恢复处理：写 rerunStage、发通知卡片、不创建告警', t => {
  // quality R1 SPEC-10：CLI 找不到会话时输出错误文本，不是 JSON。
  const f = schedScenario(t, {
    files: { 'decisions/D-0003.json': answeredQuestionDecision({ stage: 'quality' }) },
    view: { root: null, active: [schedEntry({ rule: 'R9', stage: 'verify' })], implementing: [], archived: [] },
    claude: 'No conversation found with session ID: sess-1',
  })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const decision = f.decisions().find(item => item.id === 'D-0003')
  assert.equal(decision.status, 'void')
  assert.equal(decision.voidReason, '会话无法恢复')
  assert.equal(f.changeRecord().rerunStage, 'quality')
  assert.equal(f.decisions().filter(item => item.id !== 'D-0003').length, 0, '不应创建会话告警')
  const notices = f.larkCalls().map(call => call.content || '').join('\n')
  assert.ok(notices.includes('重跑'), notices)
})

test('回复含回会话处理时通知卡片列出运行前后核对不通过的项', t => {
  // spec autopilot-scheduler 第 6 条第 1 项（quality R1 SPEC-10）。
  const f = schedScenario(t, {
    files: {
      'review-summary.md': 'Technical Review Approved: tigger\n',
      'decisions/D-0003.json': answeredQuestionDecision({
        answer: {
          operatorId: 'ou_owner', eventId: 'E1', answeredAt: '2026-11-16T10:00:00Z',
          answers: { 'STD-01 没有对应任务，怎么处理？': '回会话处理' },
          selected: { 'STD-01 没有对应任务，怎么处理？': '回会话处理' },
          text: {},
        },
      }),
    },
  })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([
    { file: join(f.changeDir, 'review-summary.md'), content: 'Technical Review Approved: agent\n' },
  ]))
  f.run()
  assert.equal(f.changeRecord().status, 'void')
  const notices = f.larkCalls().map(call => call.content || '').join('\n')
  assert.ok(notices.includes('Technical Review Approved'), notices)
  assert.ok(notices.includes('agent'), notices)
})

test('quality 的提问会话无法恢复时写 rerunStage，下一轮仍运行 quality', t => {
  const f = schedScenario(t, {
    files: { 'decisions/D-0003.json': answeredQuestionDecision() },
    view: { root: null, active: [schedEntry({ rule: 'R9', stage: 'verify' })], implementing: [], archived: [] },
    claude: { session_id: 's1', stop_reason: 'tool_deferred_unavailable' },
  })
  f.run()
  assert.equal(f.changeRecord().rerunStage, 'quality')
  f.run()
  const calls = f.claudeCalls()
  const prompt = calls[calls.length - 1].args[calls[calls.length - 1].args.indexOf('-p') + 1]
  assert.ok(prompt.includes('openspec-code-quality'), prompt)
  assert.ok(!f.changeRecord().rerunStage, '重跑后应清除 rerunStage')
})

test('恢复后停在另一个提问上时原决策先转为 used 再创建新决策', t => {
  const next = { questions: [{ question: '下一批的问题？', header: '下一批的问题？', multiSelect: false, options: [{ label: '好' }] }] }
  const f = schedScenario(t, {
    files: { 'decisions/D-0003.json': answeredQuestionDecision() },
    claude: { session_id: 's1', stop_reason: 'tool_deferred',
      deferred_tool_use: { id: 'T2', name: 'AskUserQuestion', input: next } },
  })
  f.run()
  const old = f.decisions().find(item => item.id === 'D-0003')
  assert.equal(old.status, 'used')
  const created = f.decisions().find(item => item.id !== 'D-0003')
  assert.equal(created.status, 'pending')
  assert.equal(created.request.toolUseId, 'T2')
})

test('回复含回会话处理时运行结束后作废托管', t => {
  const f = schedScenario(t, {
    files: {
      'decisions/D-0003.json': answeredQuestionDecision({
        answer: {
          operatorId: 'ou_owner', eventId: 'E1', answeredAt: '2026-11-16T10:00:00Z',
          answers: { 'STD-01 没有对应任务，怎么处理？': '回会话处理' },
          selected: { 'STD-01 没有对应任务，怎么处理？': '回会话处理' },
          text: {},
        },
      }),
    },
    claude: { session_id: 's1', stop_reason: 'tool_deferred',
      deferred_tool_use: { id: 'T2', name: 'AskUserQuestion', input: QUESTION } },
  })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const decision = f.decisions().find(item => item.id === 'D-0003')
  assert.equal(decision.status, 'used')
  const record = f.changeRecord()
  assert.equal(record.status, 'void')
  assert.ok(record.voidReason.includes('STD-01'), record.voidReason)
  assert.equal(f.decisions().filter(item => item.id !== 'D-0003').length, 0, '不该为结果创建新决策')
  assert.equal(f.larkCalls().length, 1, '只发一张通知卡片')
})

test('撤回后又重新托管时，运行的结果不创建决策也不发卡片', t => {
  const f = schedScenario(t, {
    claude: { session_id: 's1', stop_reason: 'tool_deferred',
      deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input: QUESTION } },
  })
  // 进度视图替身：第二次调用起把托管记录改为 void 并重新托管（新的 startedAt）。
  const counter = `${f.viewFile}.count`
  const recordFile = join(f.changeDir, 'decisions', 'autopilot.json')
  const original = JSON.parse(readFileSync(f.viewFile, 'utf8'))
  writeFileSync(f.progressBin, `import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const n = Number(existsSync(${JSON.stringify(counter)}) ? readFileSync(${JSON.stringify(counter)}, 'utf8') : 0)
writeFileSync(${JSON.stringify(counter)}, String(n + 1))
if (n >= 1) writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ status: 'active', startedAt: '2026-11-20T10:00:00Z', rule: 'R6', tier: 'MVP' }))
process.stdout.write(JSON.stringify(${JSON.stringify(original)}))
`)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.decisions().filter(item => item.kind === 'question').length, 0)
  assert.equal(f.larkCalls().length, 0)
})

test('撤回后创建的决策被作废，不发卡片', t => {
  const f = schedScenario(t, {
    claude: { session_id: 's1', stop_reason: 'tool_deferred',
      deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input: QUESTION } },
  })
  // 进度视图替身：第三次调用（创建决策后复核托管记录时）把托管记录改为 void。
  const counter = `${f.viewFile}.count`
  const recordFile = join(f.changeDir, 'decisions', 'autopilot.json')
  const original = JSON.parse(readFileSync(f.viewFile, 'utf8'))
  writeFileSync(f.progressBin, `import { readFileSync, writeFileSync, existsSync } from 'node:fs'
const n = Number(existsSync(${JSON.stringify(counter)}) ? readFileSync(${JSON.stringify(counter)}, 'utf8') : 0)
writeFileSync(${JSON.stringify(counter)}, String(n + 1))
if (n >= 2) writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ status: 'void', startedAt: '2026-11-06T10:00:00Z', voidReason: '用户撤回' }))
process.stdout.write(JSON.stringify(${JSON.stringify(original)}))
`)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(readFileSync(`${f.viewFile}.count`, 'utf8'), '3', '进度视图应被调用三次')
  const created = f.decisions().find(item => item.kind === 'question')
  assert.ok(created, '应创建决策文件')
  assert.equal(created.status, 'void')
  assert.equal(created.voidReason, '托管已撤回')
  assert.equal(f.larkCalls().length, 0)
})

// ---------------------------------------------------------------------------
// Requirement 8：没有进展时告警（add-autopilot-loop Slice 05）
// ---------------------------------------------------------------------------

test('阶段没有进展时创建会话告警并发卡片', t => {
  const f = schedScenario(t, { claude: { session_id: 's1', stop_reason: 'end_turn', result: '我无法确定要修改的范围。' } })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const alerts = f.decisions().filter(item => item.kind === 'alert')
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].status, 'pending')
  assert.ok(alerts[0].request.text.includes('我无法确定要修改的范围。'), alerts[0].request.text)
  assert.ok(f.larkCalls().length >= 1)
})

test('会话告警卡片是一个表单：一个输入框与两个提交按钮', t => {
  // spec autopilot-decisions「Session alert uses a form」（quality R1 SPEC-11）。
  const f = schedScenario(t, { claude: { session_id: 's1', stop_reason: 'end_turn', result: '我无法确定要修改的范围。' } })
  f.run()
  const shape = cardShape(f.larkCalls()[0].content)
  assert.equal(shape.forms, 1)
  assert.deepEqual(shape.form.filter(tag => tag !== 'markdown'), ['input', 'button', 'button'])
  const buttons = shape.form0.elements.filter(element => element.tag === 'button').map(element => element.name)
  assert.deepEqual(buttons, ['补充说明后继续', '回会话处理'])
  assert.equal(shape.outsideButtons, 0)
})

test('恢复的告警再次停在提问上时，告警先转为 used，再发新提问的卡片', t => {
  // spec autopilot-scheduler「Resumed alert that stops on a question is used first」（quality R1 SPEC-11）。
  const f = schedScenario(t, {
    files: { 'decisions/D-0005.json': {
      id: 'D-0005', kind: 'alert', status: 'answered', stage: 'apply',
      request: { sessionId: 'sess-5', text: '没有进展', options: ['补充说明后继续', '回会话处理'] },
      answer: { operatorId: 'ou_owner', eventId: 'E5', choice: '补充说明后继续', text: '只改 scripts 目录' },
      card: { messageId: 'om_card_5' },
    } },
    claude: { session_id: 'sess-5', stop_reason: 'tool_deferred',
      deferred_tool_use: { id: 'T9', name: 'AskUserQuestion', input: QUESTION } },
  })
  // lark-cli 替身在收到卡片时记下 D-0005 当时的状态。
  const d5 = join(f.changeDir, 'decisions', 'D-0005.json')
  const seen = join(f.doublesDir, 'd5-at-send.txt')
  const impl = join(f.doublesDir, 'lark-cli.mjs')
  writeFileSync(impl, `import { appendFileSync, readFileSync } from 'node:fs'\n`
    + `appendFileSync(${JSON.stringify(seen)}, JSON.parse(readFileSync(${JSON.stringify(d5)}, 'utf8')).status + '\\n')\n`
    + readFileSync(impl, 'utf8').replace(/^import .*\n/, ''))
  f.run()
  const byId = Object.fromEntries(f.decisions().map(item => [item.id, item]))
  assert.equal(byId['D-0005'].status, 'used')
  assert.equal(byId['D-0006'].status, 'pending')
  assert.equal(byId['D-0006'].kind, 'question')
  assert.equal(readFileSync(seen, 'utf8').trim(), 'used', '发新卡片时 D-0005 应已是 used')
})

test('未跟踪文件的内容变化算进展，不发告警', t => {
  const f = schedScenario(t, { claude: { session_id: 's1', stop_reason: 'end_turn', result: '做完了' } })
  // claude 替身在运行时改动一个未跟踪文件：进度摘要按内容哈希计算。
  writeFileSync(join(f.repo, 'untracked.txt'), '改动\n')
  writeFileSync(join(f.doublesDir, 'effect.json'), `${JSON.stringify([
    { file: join(f.repo, 'untracked.txt'), content: '新的改动' },
  ])}\n`)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.decisions().filter(item => item.kind === 'alert').length, 0)
})

test('别的变更的新文件不算进展，发会话告警', t => {
  const f = schedScenario(t, { claude: { session_id: 's1', stop_reason: 'end_turn', result: '做完了' } })
  const other = join(f.repo, 'openspec', 'changes', 'other-change')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(f.doublesDir, 'effect.json'), `${JSON.stringify([
    { file: join(other, 'proposal.md'), content: '新提案' },
  ])}\n`)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.decisions().filter(item => item.kind === 'alert').length, 1)
})

test('输出不是 JSON 时创建只有回会话处理的告警', t => {
  const f = schedScenario(t, { claude: 'Your organization has disabled access' })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const alerts = f.decisions().filter(item => item.kind === 'alert')
  assert.equal(alerts.length, 1)
  assert.ok(!alerts[0].request.sessionId, '没有会话时不该有 sessionId')
  assert.deepEqual(alerts[0].request.options, ['回会话处理'])
  assert.ok(alerts[0].request.text.includes('Your organization has disabled access'), alerts[0].request.text)
})

test('超出预算时创建会话告警', t => {
  const f = schedScenario(t, {
    claude: { session_id: 's1', is_error: true, subtype: 'error_max_budget_usd', result: '预算用完' },
  })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const alerts = f.decisions().filter(item => item.kind === 'alert')
  assert.equal(alerts.length, 1)
  assert.ok(alerts[0].request.text.length > 0)
})

test('会话告警回复补充说明后恢复会话，告警转为 used', t => {
  const f = schedScenario(t, {
    files: {
      'decisions/D-0005.json': {
        id: 'D-0005', kind: 'alert', status: 'answered', stage: 'apply',
        request: { sessionId: 's1', text: '没有进展', options: ['补充说明后继续', '回会话处理'] },
        answer: { operatorId: 'ou_owner', eventId: 'E1', choice: '补充说明后继续', text: '只改 scripts 目录' },
      },
    },
    claude: { session_id: 's1', stop_reason: 'end_turn', result: 'done' },
  })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const calls = f.claudeCalls()
  assert.equal(calls.length, 1)
  const args = calls[0].args
  assert.equal(args[args.indexOf('--resume') + 1], 's1')
  assert.equal(args[args.indexOf('-p') + 1], '用户补充说明：只改 scripts 目录')
  const alert = f.decisions().find(item => item.id === 'D-0005')
  assert.equal(alert.status, 'used')
})

test('会话告警选择回会话处理时作废托管，不恢复会话', t => {
  const f = schedScenario(t, {
    files: {
      'decisions/D-0005.json': {
        id: 'D-0005', kind: 'alert', status: 'answered', stage: 'apply',
        request: { sessionId: 's1', text: '没有进展', options: ['补充说明后继续', '回会话处理'] },
        answer: { operatorId: 'ou_owner', eventId: 'E1', choice: '回会话处理', text: '' },
      },
    },
  })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 0)
  assert.equal(f.changeRecord().status, 'void')
  const alert = f.decisions().find(item => item.id === 'D-0005')
  assert.equal(alert.status, 'used')
})

// ---------------------------------------------------------------------------
// Requirement 9：运行前后核对处理记录与签署字段（add-autopilot-loop Slice 05）
// ---------------------------------------------------------------------------

/** 两轴报告中的一条 finding 行。 */
const findingRow = (id, severity, status = 'open') =>
  `| ${id} | ${severity} | 创建订单 | review/standards.md:1 | order | 白话说明 | 场景 | 后果 | 修复 | ${status} |`

/** 台账中的一行。 */
const ledgerRow = (id, severity, status = 'open') =>
  `| ${id} | ${severity} | R1 | ${status} | ${status === 'open' ? '' : 'R2'} | ${status === 'open' ? '' : 'review/standards.md:1'} |`

/** 写一份两轴报告与汇总。 */
function writeAxisReports(f, { standards = [], spec = [], ledgers = {} } = {}) {
  const header = [
    '| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |',
    '|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|',
  ].join('\n')
  const ledgerHeader = [
    '| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |',
    '|----|---------|---------|------|---------|---------|',
  ].join('\n')
  const axis = (title, rows, ledgerRows) => [
    `# ${title}`, '', '## Findings', '', header,
    ...(rows.length ? rows : ['| 无 | | | | | | | | | |']), '',
    '## Finding 台账', '', ledgerHeader, ...(ledgerRows.length ? ledgerRows : []), '',
    '## 结论', '', `${title} 结论：通过`, '',
  ].join('\n')
  const ledgerOf = rows => rows.map(row => {
    const cells = row.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
    return ledgerRow(cells[0], cells[1], cells[9])
  })
  f.write('review/standards.md', axis('Standards Review', standards,
    ledgers.standards || ledgerOf(standards)))
  f.write('review/spec-fidelity.md', axis('Spec Fidelity Review', spec,
    ledgers.spec || ledgerOf(spec)))
  f.write('review/code-review-summary.md', [
    '# 实现后双轴评审汇总', '', '| 评审轴 | 原始报告 |', '|---|---|',
    '| Standards Review | review/standards.md |', '| Spec Fidelity Review | review/spec-fidelity.md |', '',
    'Code Review Verdict: PASSED', '',
  ].join('\n'))
}

test('处理记录与用户回复一致时不发告警', t => {
  const f = schedScenario(t, {
    files: {
      'review/standards.md': `# Standards Review\n\n## Findings\n\n| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |\n|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|\n${findingRow('STD-05', 'Major')}\n\n## Finding 台账\n\n| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |\n|----|---------|---------|------|---------|---------|\n${ledgerRow('STD-05', 'Major')}\n`,
      'decisions/D-0003.json': {
        id: 'D-0003', kind: 'question', status: 'answered', stage: 'quality',
        request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION),
          questions: [{ question: 'STD-05 怎么处理？', header: 'STD-05', multiSelect: false, options: [{ label: 'risk accepted' }] }] },
        answer: { operatorId: 'ou_owner', eventId: 'E1',
          answers: { 'STD-05': 'risk accepted' }, selected: { 'STD-05': 'risk accepted' }, text: {} },
      },
    },
    claude: { session_id: 's1', stop_reason: 'end_turn', result: 'done' },
  })
  // 运行中把 STD-05 的台账与 Findings 行都改为 risk-accepted。
  writeFileSync(join(f.doublesDir, 'effect.json'), `${JSON.stringify([
    { file: join(f.changeDir, 'review', 'standards.md'),
      content: `# Standards Review\n\n## Findings\n\n| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |\n|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|\n${findingRow('STD-05', 'Major', 'risk-accepted')}\n\n## Finding 台账\n\n| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |\n|----|---------|---------|------|---------|---------|\n${ledgerRow('STD-05', 'Major', 'risk-accepted')}\n` },
  ])}\n`)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const alerts = f.decisions().filter(item => item.kind === 'alert')
  assert.equal(alerts.length, 0, `不该发告警：${JSON.stringify(alerts)}`)
  const decision = f.decisions().find(item => item.id === 'D-0003')
  assert.equal(decision.status, 'used')
})

test('处理记录与用户回复不一致时发告警并列出 finding', t => {
  const f = schedScenario(t, {
    files: {
      'review/standards.md': `# Standards Review\n\n## Findings\n\n| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |\n|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|\n${findingRow('STD-02', 'Major')}\n\n## Finding 台账\n\n| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |\n|----|---------|---------|------|---------|---------|\n${ledgerRow('STD-02', 'Major')}\n`,
      'decisions/D-0003.json': {
        id: 'D-0003', kind: 'question', status: 'answered', stage: 'quality',
        request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION),
          questions: [{ question: 'STD-02 怎么处理？', header: 'STD-02', multiSelect: false, options: [{ label: '修复' }] }] },
        answer: { operatorId: 'ou_owner', eventId: 'E1',
          answers: { 'STD-02': '修复' }, selected: { 'STD-02': '修复' }, text: {} },
      },
    },
    claude: { session_id: 's1', stop_reason: 'end_turn', result: 'done' },
  })
  writeFileSync(join(f.doublesDir, 'effect.json'), `${JSON.stringify([
    { file: join(f.changeDir, 'review', 'standards.md'),
      content: `# Standards Review\n\n## Findings\n\n| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |\n|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|\n${findingRow('STD-02', 'Major', 'risk-accepted')}\n\n## Finding 台账\n\n| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |\n|----|---------|---------|------|---------|---------|\n${ledgerRow('STD-02', 'Major', 'risk-accepted')}\n` },
  ])}\n`)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const alerts = f.decisions().filter(item => item.kind === 'alert')
  assert.equal(alerts.length, 1)
  const failures = alerts[0].request.checkFailures || []
  assert.ok(failures.some(item => String(item.finding).includes('STD-02')), JSON.stringify(failures))
  assert.ok(failures.some(item => String(item.file).includes('review/standards.md')), JSON.stringify(failures))
  // spec autopilot-scheduler 第 9 条「SHALL show these items on the card」（quality R1 SPEC-03）。
  const card = f.larkCalls().map(call => call.content || '').join('\n')
  assert.ok(card.includes('STD-02'), card)
  assert.ok(card.includes('risk-accepted'), card)
})

test('只有自填文本的回复在告警卡片上写出自填原文', t => {
  // spec autopilot-scheduler「Free text answer is listed for the user」（quality R1 SPEC-03）。
  const standards = status => `# Standards Review\n\n## Findings\n\n| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |\n|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|\n${findingRow('STD-02', 'Major', status)}\n\n## Finding 台账\n\n| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |\n|----|---------|---------|------|---------|---------|\n${ledgerRow('STD-02', 'Major', status)}\n`
  const f = schedScenario(t, {
    files: {
      'review/standards.md': standards('open'),
      'decisions/D-0003.json': {
        id: 'D-0003', kind: 'question', status: 'answered', stage: 'quality',
        request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION),
          questions: [{ question: 'STD-02 怎么处理？', header: 'STD-02', multiSelect: false, options: [{ label: 'risk accepted' }] }] },
        answer: { operatorId: 'ou_owner', eventId: 'E1',
          answers: { 'STD-02': '先不改，下个迭代再看' }, selected: {}, text: { 'STD-02': '先不改，下个迭代再看' } },
      },
    },
    claude: { session_id: 's1', stop_reason: 'end_turn', result: 'done' },
  })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([
    { file: join(f.changeDir, 'review', 'standards.md'), content: standards('risk-accepted') },
  ]))
  f.run()
  const card = f.larkCalls().map(call => call.content || '').join('\n')
  assert.ok(card.includes('STD-02'), card)
  assert.ok(card.includes('先不改，下个迭代再看'), card)
})

test('只改 Findings 表的闭环状态时发告警', t => {
  const f = schedScenario(t, {
    files: {
      'review/spec-fidelity.md': `# Spec Fidelity Review\n\n## Findings\n\n| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |\n|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|\n${findingRow('SPEC-02', 'Blocker')}\n\n## Finding 台账\n\n| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |\n|----|---------|---------|------|---------|---------|\n${ledgerRow('SPEC-02', 'Blocker')}\n`,
    },
    claude: { session_id: 's1', stop_reason: 'end_turn', result: 'done' },
  })
  writeFileSync(join(f.doublesDir, 'effect.json'), `${JSON.stringify([
    { file: join(f.changeDir, 'review', 'spec-fidelity.md'),
      content: `# Spec Fidelity Review\n\n## Findings\n\n| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |\n|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|\n${findingRow('SPEC-02', 'Blocker', 'risk-accepted')}\n\n## Finding 台账\n\n| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |\n|----|---------|---------|------|---------|---------|\n${ledgerRow('SPEC-02', 'Blocker')}\n` },
  ])}\n`)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const alerts = f.decisions().filter(item => item.kind === 'alert')
  assert.equal(alerts.length, 1)
  const failures = alerts[0].request.checkFailures || []
  assert.ok(failures.some(item => String(item.finding).includes('SPEC-02')), JSON.stringify(failures))
})

test('严重级别降低时发告警', t => {
  const f = schedScenario(t, {
    files: {
      'review/standards.md': `# Standards Review\n\n## Findings\n\n| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |\n|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|\n${findingRow('STD-04', 'Blocker')}\n\n## Finding 台账\n\n| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |\n|----|---------|---------|------|---------|---------|\n${ledgerRow('STD-04', 'Blocker')}\n`,
    },
    claude: { session_id: 's1', stop_reason: 'end_turn', result: 'done' },
  })
  writeFileSync(join(f.doublesDir, 'effect.json'), `${JSON.stringify([
    { file: join(f.changeDir, 'review', 'standards.md'),
      content: `# Standards Review\n\n## Findings\n\n| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |\n|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|\n${findingRow('STD-04', 'Minor')}\n\n## Finding 台账\n\n| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |\n|----|---------|---------|------|---------|---------|\n${ledgerRow('STD-04', 'Blocker')}\n` },
  ])}\n`)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const alerts = f.decisions().filter(item => item.kind === 'alert')
  assert.equal(alerts.length, 1)
  assert.ok((alerts[0].request.checkFailures || []).some(item => String(item.finding).includes('STD-04')),
    JSON.stringify(alerts[0].request.checkFailures))
})

test('签署字段被改动时发告警', t => {
  const f = schedScenario(t, {
    files: { 'review-summary.md': '# 技术评审汇总\n\nGate-Verdict: READY_FOR_HUMAN_APPROVAL\nTechnical Review Approved: tigger\n' },
    claude: { session_id: 's1', stop_reason: 'end_turn', result: 'done' },
  })
  writeFileSync(join(f.doublesDir, 'effect.json'), `${JSON.stringify([
    { file: join(f.changeDir, 'review-summary.md'),
      content: '# 技术评审汇总\n\nGate-Verdict: READY_FOR_HUMAN_APPROVAL\nTechnical Review Approved: someone-else\n' },
  ])}\n`)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const alerts = f.decisions().filter(item => item.kind === 'alert')
  assert.equal(alerts.length, 1)
  assert.ok((alerts[0].request.checkFailures || []).length > 0, JSON.stringify(alerts[0].request))
})

/**
 * 运行一轮：运行中把变更目录的文件改成 after 的内容，返回本轮创建的会话告警的核对不通过项。
 * @param {object} t 用例上下文。
 * @param {object} before 运行前的文件（相对变更目录）。
 * @param {object} after 运行中写入的文件（相对变更目录）。
 * @param {object} [files] 其他运行前的文件，例如提问决策。
 * @returns {{ failures: object[], card: string }} 核对不通过项与卡片内容。
 */
function traceRound(t, before, after, files = {}) {
  const f = schedScenario(t, { files: { ...before, ...files }, claude: { session_id: 's1', stop_reason: 'end_turn', result: 'done' } })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify(Object.entries(after)
    .map(([rel, content]) => ({ file: join(f.changeDir, rel), content }))))
  f.run()
  const alerts = f.decisions().filter(item => item.kind === 'alert')
  return {
    failures: alerts.length ? alerts[0].request.checkFailures || [] : [],
    card: f.larkCalls().map(call => call.content || '').join('\n'),
  }
}

/** 一份只有表头、可放入若干行的 Standards 报告。 */
const standardsReport = (findings = [], ledger = []) => `# Standards Review\n\n## Findings\n\n| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |\n|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|\n${findings.join('\n')}\n\n## Finding 台账\n\n| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |\n|----|---------|---------|------|---------|---------|\n${ledger.join('\n')}\n`

test('待环境补测新增一行并填了确认人时发告警', t => {
  // spec autopilot-scheduler「Confirmer filled in a pending environment row sends an alert」（quality R1 SPEC-09）。
  const head = '# Slice 02 证据\n\n## 待环境补测\n\n| 登记指纹 | 原因 | 补测计划 | 负责人 | 确认人 | 日期 |\n|---|---|---|---|---|---|\n'
  const { failures } = traceRound(t, { 'evidence/slice-02.md': head },
    { 'evidence/slice-02.md': `${head}| git-tree:abc | 本地没有环境 | 在测试环境重跑 | tigger | tigger | 2026-11-16 |\n` })
  assert.ok(failures.some(item => item.field === '确认人' && item.after === 'tigger'), JSON.stringify(failures))
})

test('运行中删除 Blocker 的 Findings 行与台账行时发告警', t => {
  // design D5 情况 4：整行删除只能从运行前快照的视角发现（quality R1 SPEC-09、STD-05）。
  const { failures, card } = traceRound(t,
    { 'review/standards.md': standardsReport([findingRow('STD-01', 'Blocker')], [ledgerRow('STD-01', 'Blocker')]) },
    { 'review/standards.md': standardsReport() })
  assert.ok(failures.some(item => item.finding === 'STD-01' && item.after === '消失'), JSON.stringify(failures))
  assert.ok(card.includes('STD-01'), card)
})

test('运行中删除签字行时发告警', t => {
  const { failures } = traceRound(t,
    { 'review-summary.md': '# 技术评审汇总\n\nGate-Verdict: READY_FOR_HUMAN_APPROVAL\nTechnical Review Approved: tigger\n' },
    { 'review-summary.md': '# 技术评审汇总\n\nGate-Verdict: READY_FOR_HUMAN_APPROVAL\n' })
  assert.ok(failures.some(item => item.field === 'Technical Review Approved' && item.file === 'review-summary.md'),
    JSON.stringify(failures))
})

test('同一规则的两条 Sonar 问题分别对回复，没有回复的一条发告警', t => {
  // Sonar 行按「规则 + 位置」作键，对上提问决策时核对问题文本中的 file:line（quality R1 SPEC-09）。
  const sonar = handling => `# Sonar\n\n## 本次修改行上的问题\n| 规则 | 严重级别 | 位置 | 处理 | 说明 | 决策人 |\n|---|---|---|---|---|---|\n| java:S1192 | Major | src/A.java:10 | ${handling} |  |  |\n| java:S1192 | Major | src/B.java:20 | ${handling} |  |  |\n`
  const { failures } = traceRound(t, { 'review/sonar.md': sonar('') }, { 'review/sonar.md': sonar('接受') }, {
    'decisions/D-0003.json': {
      id: 'D-0003', kind: 'question', status: 'answered', stage: 'quality',
      request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION),
        questions: [{ question: 'java:S1192 src/A.java:10 怎么处理？', header: 'java:S1192', multiSelect: false,
          options: [{ label: '修复' }, { label: '误报' }, { label: '接受' }] }] },
      answer: { operatorId: 'ou_owner', eventId: 'E1',
        answers: { 'java:S1192': '接受' }, selected: { 'java:S1192': '接受' }, text: {} },
    },
  })
  assert.equal(failures.length, 1, JSON.stringify(failures))
  assert.ok(String(failures[0].finding).includes('src/B.java:20'), JSON.stringify(failures))
})

test('回复的是另一个 finding 时不算对上，发告警', t => {
  // spec autopilot-scheduler「Answer to another finding does not match」：按 header 完全相等匹配，问题正文提到其他 ID 不算（quality R1 SPEC-11）。
  const { failures } = traceRound(t,
    { 'review/standards.md': standardsReport([findingRow('STD-03', 'Major')], [ledgerRow('STD-03', 'Major')]) },
    { 'review/standards.md': standardsReport([findingRow('STD-03', 'Major', 'risk-accepted')], [ledgerRow('STD-03', 'Major', 'risk-accepted')]) },
    { 'decisions/D-0003.json': {
      id: 'D-0003', kind: 'question', status: 'answered', stage: 'quality',
      request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION), questions: [
        { question: 'STD-05 与 STD-03 相关，怎么处理？', header: 'STD-05', multiSelect: false, options: [{ label: 'risk accepted' }] },
        { question: 'STD-03 怎么处理？', header: 'STD-03', multiSelect: false, options: [{ label: '修复' }, { label: 'risk accepted' }] },
      ] },
      answer: { operatorId: 'ou_owner', eventId: 'E1',
        answers: { 'STD-05 与 STD-03 相关，怎么处理？': 'risk accepted', 'STD-03 怎么处理？': '修复' },
        selected: { 'STD-05': 'risk accepted', 'STD-03': '修复' }, text: {} },
    } })
  assert.ok(failures.some(item => item.finding === 'STD-03'), JSON.stringify(failures))
})

test('新证据文件含豁免记录表头时不发签署字段的告警', t => {
  // spec autopilot-scheduler「Evidence file with an exemption table header passes」（quality R1 SPEC-11）。
  const { failures } = traceRound(t, {}, { 'evidence/slice-01.md': '# Slice 01 新鲜证据\n\n- Result: PASS\n\n## 豁免记录\n| From Fingerprint | To Fingerprint | 变化文件 | 不影响本切片行为的理由 | 判定人 | 日期 |\n|------------------|----------------|---------|--------------------|-------|------|\n' })
  assert.deepEqual(failures, [])
})

test('核对告警补充说明后继续，恢复的运行不改台账时不再报同一项', t => {
  // spec autopilot-scheduler「Continue after a check alert does not report the same items」：
  // 以恢复前的快照为准，STD-02 在恢复前已是 risk-accepted（quality R1 SPEC-11）。
  const accepted = standardsReport([findingRow('STD-02', 'Major', 'risk-accepted')], [ledgerRow('STD-02', 'Major', 'risk-accepted')])
  const f = schedScenario(t, {
    files: {
      'review/standards.md': accepted,
      'decisions/D-0004.json': {
        id: 'D-0004', kind: 'alert', status: 'answered', stage: 'quality',
        request: { sessionId: 's1', text: '运行前后的记录不一致，请确认这些项。', options: ['补充说明后继续', '回会话处理'],
          checkFailures: [{ file: 'review/standards.md', finding: 'STD-02', field: '状态', before: 'open', after: 'risk-accepted' }] },
        answer: { operatorId: 'ou_owner', eventId: 'E4', choice: '补充说明后继续', text: '我确认过 STD-02' },
        card: { messageId: 'om_card_4' },
      },
    },
    claude: { session_id: 's1', stop_reason: 'end_turn', result: 'done' },
  })
  f.run()
  assert.equal(f.decisions().find(item => item.id === 'D-0004').status, 'used')
  const reported = f.decisions().filter(item => item.kind === 'alert' && item.id !== 'D-0004')
    .flatMap(item => item.request.checkFailures || [])
  assert.ok(!reported.some(item => item.finding === 'STD-02'), JSON.stringify(reported))
})

test('待环境补测新增空确认人的行时不发告警', t => {
  const f = schedScenario(t, {
    files: {
      'evidence/slice-02.md': '# Slice 02 证据\n\n## 待环境补测\n\n| 登记指纹 | 原因 | 补测计划 | 负责人 | 确认人 | 日期 |\n|---|---|---|---|---|---|\n',
    },
    claude: { session_id: 's1', stop_reason: 'end_turn', result: 'done' },
  })
  writeFileSync(join(f.doublesDir, 'effect.json'), `${JSON.stringify([
    { file: join(f.changeDir, 'evidence', 'slice-02.md'),
      content: '# Slice 02 证据\n\n## 待环境补测\n\n| 登记指纹 | 原因 | 补测计划 | 负责人 | 确认人 | 日期 |\n|---|---|---|---|---|---|\n| git-tree:abc | 本地没有环境 | 在测试环境重跑 | tigger |  | 2026-11-16 |\n' },
  ])}\n`)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const alerts = f.decisions().filter(item => item.kind === 'alert')
  assert.equal(alerts.length, 0, `不该发告警：${JSON.stringify(alerts.map(item => item.request))}`)
})

// ---------------------------------------------------------------------------
// Requirement 5/6：桥接脚本核对并记录用户的点选（add-autopilot-loop Slice 06）
// ---------------------------------------------------------------------------

/** 桥接脚本的路径。 */
const bridge = fileURLToPath(new URL('../skills/openspec-autopilot/scripts/bridge.mjs', import.meta.url))

/**
 * 按 card.mjs 实际生成的表单构造一次表单提交事件（quality R1 SPEC-02）：不手写组件名，
 * 卡片与桥接脚本的组件名对不上时测试会失败。字段按实验 2 记录的事件样本（event_id、operator_id、
 * message_id、action_value、token），表单提交另加 action_tag、action_name 与 form_value（评审 ARCH-14）。
 * @param {object} card card.mjs 生成的卡片。
 * @param {string} button 点的提交按钮文字。
 * @param {string[]} values 按表单中输入组件出现的顺序给出的值。
 * @returns {object} 事件中与表单有关的字段。
 */
function formSubmit(card, button, values) {
  const form = card.body.elements.find(element => element.tag === 'form')
  assert.ok(form, '卡片没有 form 容器')
  const inputs = form.elements.filter(element => element.name && element.tag !== 'button' && element.tag !== 'markdown')
  const pressed = form.elements.find(element => element.tag === 'button' && element.text.content === button)
  assert.ok(pressed, `表单中没有按钮 ${button}`)
  return {
    action_tag: 'button',
    action_name: pressed.name,
    action_value: JSON.stringify(pressed.behaviors[0].value),
    form_value: Object.fromEntries(inputs.map((element, index) => [element.name, values[index] ?? ''])),
  }
}

/** 一次提问卡片的提交：values 依次为各问题的下拉选择与自填文本。 */
const clickEvent = ({ values = ['蓝', ''], questions = QUESTION.questions, decisionId = 'D-0001', ...overrides } = {}) => ({
  ...formSubmit(questionCard({ title: 'demo', questions, decisionId, change: 'demo' }), '提交', values),
  event_id: 'E1',
  operator_id: 'ou_owner',
  message_id: 'om_card_1',
  token: 'card_token_1',
  ...overrides,
})

/** 一次会话告警卡片的提交。 */
const alertEvent = ({ choice, note = '', options = ['补充说明后继续', '回会话处理'], ...overrides }) => ({
  ...formSubmit(alertCard({ title: 'demo', options, decisionId: 'D-0005', change: 'demo', text: '没有进展' }), choice, [note]),
  event_id: 'E5',
  operator_id: 'ou_owner',
  message_id: 'om_card_5',
  token: 'card_token_5',
  ...overrides,
})

/** 桥接脚本更新卡片时写出的卡片内容（lark-cli card update 的 --content）。 */
const updatedCards = f => f.larkCalls().filter(call => call.args[0] === 'card' && call.args[1] === 'update')
  .map(call => JSON.parse(call.content))

/**
 * 建立一个桥接用例环境：临时托管目录、变更目录、lark-cli 替身与配置。
 * @param {object} t node:test 的用例上下文。
 * @param {object} options options.files 为变更目录下的文件；options.events 为事件序列。
 */
function bridgeScenario(t, { files = {}, events = [] } = {}) {
  const repo = tempDir(t, 'autopilot-bridge-repo-')
  const home = tempDir(t, 'autopilot-bridge-home-')
  initRepo(repo)
  const { progressBin } = progressDouble(home, { root: repo, active: [schedEntry()], implementing: [], archived: [] })
  const { larkBin, larkCalls } = larkDouble(home, { events })
  writeConfig(home, { larkBin, progressBin, projects: [projectOf(repo)] })
  const changeDir = join(repo, 'openspec', 'changes', 'demo')
  mkdirSync(changeDir, { recursive: true })
  writeFiles(changeDir, files)
  const run = () => {
    const result = spawnSync(process.execPath, [bridge], {
      cwd: repo, encoding: 'utf8', env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: home }, timeout: 60000,
    })
    return { code: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr }
  }
  const decision = id => JSON.parse(readFileSync(join(changeDir, 'decisions', `${id}.json`), 'utf8'))
  return { repo, home, changeDir, run, decision, larkCalls }
}

test('本人的点选被记录为已回复并启动调度', t => {
  const f = bridgeScenario(t, {
    files: {
      'decisions/autopilot.json': managedRecord(),
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'question', status: 'pending',
        request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION), questions: QUESTION.questions },
        card: { messageId: 'om_card_1' },
      },
    },
    events: [clickEvent()],
  })
  const result = f.run()
  assert.equal(result.code, 1, result.all)
  const decision = f.decision('D-0001')
  assert.equal(decision.status, 'answered')
  assert.equal(decision.answer.operatorId, 'ou_owner')
  assert.equal(decision.answer.answers['STD-01 没有对应任务，怎么处理？'], '蓝')
  assert.equal(decision.answer.selected['STD-01 没有对应任务，怎么处理？'], '蓝')
  // 点选后卡片改成 card.mjs 生成的「已记录」卡片（quality R1 STD-03）。
  const cards = updatedCards(f)
  assert.equal(cards.length, 1, JSON.stringify(f.larkCalls()))
  assert.equal(cards[0].schema, '2.0')
  assert.equal(cards[0].header.title.content, '已记录')
  assert.ok(JSON.stringify(cards[0].body).includes('蓝'), JSON.stringify(cards[0]))
})

test('两个问题分别选了不同的处理方式时各自记录', t => {
  // quality R1 SPEC-02：header 与问题原文不同；answers 按问题原文作键（hook 填回 AskUserQuestion），
  // selected 与 text 按 header 作键（运行前后核对按 header 匹配，design D5）。
  const questions = [
    { question: 'STD-01 在 a.mjs:1，怎么处理？', header: 'STD-01', multiSelect: false,
      options: [{ label: '修复' }, { label: 'risk accepted' }, { label: '误报' }] },
    { question: 'STD-02 在 b.mjs:2，怎么处理？', header: 'STD-02', multiSelect: false,
      options: [{ label: '修复' }, { label: 'risk accepted' }, { label: '误报' }] },
  ]
  const f = bridgeScenario(t, {
    files: {
      'decisions/autopilot.json': managedRecord(),
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'question', status: 'pending',
        request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf({ questions }), questions },
        card: { messageId: 'om_card_1' },
      },
    },
    events: [clickEvent({ questions, values: ['修复', '', 'risk accepted', ''] })],
  })
  f.run()
  const decision = f.decision('D-0001')
  assert.equal(decision.status, 'answered')
  assert.deepEqual(decision.answer.answers, {
    'STD-01 在 a.mjs:1，怎么处理？': '修复', 'STD-02 在 b.mjs:2，怎么处理？': 'risk accepted',
  })
  assert.deepEqual(decision.answer.selected, { 'STD-01': '修复', 'STD-02': 'risk accepted' })
})

test('别人的点选被忽略，决策不变', t => {
  const f = bridgeScenario(t, {
    files: {
      'decisions/autopilot.json': managedRecord(),
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'question', status: 'pending',
        request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION), questions: QUESTION.questions },
        card: { messageId: 'om_card_1' },
      },
    },
    events: [clickEvent({ operator_id: 'ou_other' })],
  })
  f.run()
  assert.equal(f.decision('D-0001').status, 'pending')
})

test('重复的事件编号被忽略', t => {
  const f = bridgeScenario(t, {
    files: {
      'decisions/autopilot.json': managedRecord(),
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'question', status: 'pending',
        request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION), questions: QUESTION.questions },
        card: { messageId: 'om_card_1' },
      },
    },
    events: [clickEvent()],
  })
  f.run()
  assert.equal(f.decision('D-0001').status, 'answered')
  const events = readFileSync(join(f.home, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
  assert.deepEqual(events, ['E1'])
})

test('自填文本作为该问题的回复', t => {
  const f = bridgeScenario(t, {
    files: {
      'decisions/autopilot.json': managedRecord(),
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'question', status: 'pending',
        request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION), questions: QUESTION.questions },
        card: { messageId: 'om_card_1' },
      },
    },
    events: [clickEvent({ values: ['', '都不要'] })],
  })
  f.run()
  const decision = f.decision('D-0001')
  assert.equal(decision.answer.answers['STD-01 没有对应任务，怎么处理？'], '都不要')
  assert.equal(decision.answer.text['STD-01 没有对应任务，怎么处理？'], '都不要')
})

test('选择回会话处理时自填文本只作说明', t => {
  const f = bridgeScenario(t, {
    files: {
      'decisions/autopilot.json': managedRecord(),
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'question', status: 'pending',
        request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION), questions: QUESTION.questions },
        card: { messageId: 'om_card_1' },
      },
    },
    events: [clickEvent({
      questions: [{ ...QUESTION.questions[0], options: [...QUESTION.questions[0].options, { label: '回会话处理' }] }],
      values: ['回会话处理', '我在会话里改'],
    })],
  })
  f.run()
  const decision = f.decision('D-0001')
  assert.equal(decision.answer.answers['STD-01 没有对应任务，怎么处理？'], '回会话处理')
  assert.equal(decision.answer.notes, '我在会话里改')
})

test('会话告警表单记录选择与说明', t => {
  const f = bridgeScenario(t, {
    files: {
      'decisions/autopilot.json': managedRecord(),
      'decisions/D-0005.json': {
        id: 'D-0005', kind: 'alert', status: 'pending',
        request: { sessionId: 's1', text: '没有进展', options: ['补充说明后继续', '回会话处理'] },
        card: { messageId: 'om_card_5' },
      },
    },
    events: [alertEvent({ choice: '补充说明后继续', note: '只改 scripts 目录' })],
  })
  f.run()
  const decision = f.decision('D-0005')
  assert.equal(decision.status, 'answered')
  assert.equal(decision.answer.choice, '补充说明后继续')
  assert.equal(decision.answer.text, '只改 scripts 目录')
})

test('补充说明后继续但说明为空时不记录', t => {
  const f = bridgeScenario(t, {
    files: {
      'decisions/autopilot.json': managedRecord(),
      'decisions/D-0005.json': {
        id: 'D-0005', kind: 'alert', status: 'pending',
        request: { sessionId: 's1', text: '没有进展', options: ['补充说明后继续', '回会话处理'] },
        card: { messageId: 'om_card_5' },
      },
    },
    events: [alertEvent({ choice: '补充说明后继续', note: '' })],
  })
  f.run()
  assert.equal(f.decision('D-0005').status, 'pending')
})

test('已作废的决策点选后卡片变为已失效，决策不变', t => {
  const f = bridgeScenario(t, {
    files: {
      'decisions/autopilot.json': managedRecord(),
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'question', status: 'void', voidReason: '用户撤回',
        request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION), questions: QUESTION.questions },
        card: { messageId: 'om_card_1' },
      },
    },
    events: [clickEvent()],
  })
  f.run()
  assert.equal(f.decision('D-0001').status, 'void')
  const cards = updatedCards(f)
  assert.equal(cards.length, 1, JSON.stringify(f.larkCalls()))
  assert.equal(cards[0].schema, '2.0')
  assert.equal(cards[0].header.title.content, '已失效')
})

test('会话告警选回会话处理时记录选择，说明可以为空', t => {
  // quality R1 SPEC-02：两个按钮名称不同，桥接脚本能分出选了哪一个。
  const f = bridgeScenario(t, {
    files: {
      'decisions/autopilot.json': managedRecord(),
      'decisions/D-0005.json': {
        id: 'D-0005', kind: 'alert', status: 'pending',
        request: { sessionId: 's1', text: '没有进展', options: ['补充说明后继续', '回会话处理'] },
        card: { messageId: 'om_card_5' },
      },
    },
    events: [alertEvent({ choice: '回会话处理' })],
  })
  f.run()
  const decision = f.decision('D-0005')
  assert.equal(decision.status, 'answered')
  assert.equal(decision.answer.choice, '回会话处理')
})

test('已回复的决策重复点选时保持已记录，不改决策', t => {
  const f = bridgeScenario(t, {
    files: {
      'decisions/autopilot.json': managedRecord(),
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'question', status: 'answered',
        request: { sessionId: 's1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION), questions: QUESTION.questions },
        card: { messageId: 'om_card_1' },
        answer: { operatorId: 'ou_owner', eventId: 'E0', answers: { 'STD-01 没有对应任务，怎么处理？': '蓝' }, selected: { 'STD-01 没有对应任务，怎么处理？': '蓝' } },
      },
    },
    events: [clickEvent({ event_id: 'E2' })],
  })
  f.run()
  const decision = f.decision('D-0001')
  assert.equal(decision.status, 'answered')
  assert.equal(decision.answer.eventId, 'E0', '决策文件不该被覆盖')
})

test('出口卡片的按钮点选后出口决策记录为已回复', t => {
  // quality R2 STD-15：出口卡片的按钮与表单提交按钮用同一种回调写法（name 与 behaviors），
  // 事件按 card.mjs 实际生成的出口卡片构造，不手写回调值。
  const decision = {
    id: 'D-0001', kind: 'exit', status: 'pending', stage: 'exit',
    request: { action: 'commit-merge', branch: 'fix/x', files: ['README.md'], message: '提交说明',
      options: ['提交并合并', '只提交到分支', '暂不处理'] },
    card: { messageId: 'om_card_1' },
  }
  const card = exitCard({ title: 'demo 出口动作', decision, change: 'demo' })
  const button = card.body.elements.find(element => element.tag === 'button' && element.text.content === '提交并合并')
  assert.ok(button, JSON.stringify(card.body.elements))
  assert.match(button.name, /^[A-Za-z0-9_]+$/, `按钮名只含字母、数字与下划线：${button.name}`)
  assert.ok(Array.isArray(button.behaviors) && button.behaviors[0].type === 'callback', JSON.stringify(button))
  const f = bridgeScenario(t, {
    files: { 'decisions/autopilot.json': managedRecord({ status: 'exiting' }), 'decisions/D-0001.json': decision },
    events: [{
      event_id: 'E7', operator_id: 'ou_owner', message_id: 'om_card_1', token: 'card_token_7',
      action_tag: 'button', action_name: button.name, action_value: JSON.stringify(button.behaviors[0].value),
    }],
  })
  f.run()
  const recorded = f.decision('D-0001')
  assert.equal(recorded.status, 'answered')
  assert.equal(recorded.answer.choice, '提交并合并')
})

// ---------------------------------------------------------------------------
// Requirement 1–4：出口动作（add-autopilot-loop Slice 07）
// ---------------------------------------------------------------------------

/**
 * 把起草替身输出中的 result 写成文本：真实 CLI 的 result 是文本，不是对象。
 * @param {object} [output] 替身输出。
 * @returns {object|undefined} result 为文本的输出。
 */
function textResult(output) {
  return output && typeof output.result === 'object' && output.result !== null
    ? { ...output, result: JSON.stringify(output.result) } : output
}

/**
 * 建立一个出口动作用例环境：临时 git 仓库（含本地裸仓库作为 origin）、归档后的变更与托管记录。
 * @param {object} t node:test 的用例上下文。
 * @param {object} options options.files 为归档目录下的文件；options.plan 为起草返回的提交计划；
 *   options.record 为托管记录；options.snapshot 为实现快照；options.archived 为是否已归档。
 */
function exitScenario(t, { files = {}, plan, record: recordValue, snapshot, archived = true } = {}) {
  const repo = tempDir(t, 'autopilot-exit-repo-')
  const origin = tempDir(t, 'autopilot-exit-origin-')
  const home = tempDir(t, 'autopilot-exit-home-')
  const doublesDir = tempDir(t, 'autopilot-exit-doubles-')
  const git = initRepo(repo)
  git('init', '-q', '--bare', origin)
  git('remote', 'add', 'origin', origin)
  git('push', '-q', '-u', 'origin', 'main')

  // 变更目录：已归档时在 archive 下。
  const changesDir = join(repo, 'openspec', 'changes')
  const changeDir = archived
    ? join(changesDir, 'archive', '2026-11-16-demo')
    : join(changesDir, 'demo')
  mkdirSync(changeDir, { recursive: true })
  mkdirSync(join(changesDir, 'archive'), { recursive: true })
  writeFiles(changeDir, files)
  const recordFile = join(changeDir, 'decisions', 'autopilot.json')
  writeFiles(changeDir, {
    'decisions/autopilot.json': {
      ...(recordValue || { status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' }),
      ...(snapshot ? { implSnapshot: snapshot } : {}),
    },
  })

  const { progressBin } = progressDouble(home, {
    root: repo,
    active: archived ? [] : [schedEntry({ rule: 'R11', stage: 'archive' })],
    implementing: [],
    archived: archived ? [{ name: 'demo', date: '2026-11-16' }] : [],
  })
  // claude -p --output-format json 的 result 是最终回复的文本：替身把计划写成文本形式的 JSON（quality R1 SPEC-07）。
  const { claudeBin, claudeCalls } = claudeDouble(doublesDir, { output: textResult(plan) })
  const { larkBin, larkCalls } = larkDouble(doublesDir, { messageId: 'om_card' })
  writeConfig(home, {
    claudeBin, larkBin, progressBin,
    projects: [projectOf(repo, { allowedCommands: ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'] })],
  })

  const run = (env = {}) => {
    const result = spawnSync(process.execPath, [scheduler, '--once'], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, HOME: home, OPENSPEC_AUTOPILOT_HOME: home, ...env },
      timeout: 120000,
    })
    return { code: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr }
  }
  const record = () => JSON.parse(readFileSync(recordFile, 'utf8'))
  const decisions = () => {
    const dir = join(changeDir, 'decisions')
    return readdirSync(dir).filter(name => /^D-\d{4}\.json$/.test(name)).sort()
      .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')))
  }
  const branch = () => git('symbolic-ref', '--short', 'HEAD')
  const logCommits = () => git('log', '--format=%H %s')
  return {
    repo, origin, home, doublesDir, changeDir, run, claudeCalls, larkCalls, record, decisions, branch, logCommits, git,
  }
}

test('已归档的变更进入出口阶段并起草提交计划', t => {
  const f = exitScenario(t, {
    files: { 'decisions/autopilot.json': { status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' } },
    plan: { session_id: 's1', stop_reason: 'end_turn', result: { branch: 'fix/x', files: ['README.md'], message: '提交说明' } },
  })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.record().status, 'exiting')
  const calls = f.claudeCalls()
  assert.equal(calls.length, 1, '应起草一次')
  const args = calls[0].args
  assert.ok(args.includes('--permission-mode') && args[args.indexOf('--permission-mode') + 1] === 'dontAsk', args.join(' '))
  const disallowed = args[args.indexOf('--disallowedTools') + 1]
  for (const tool of ['Edit', 'Write', 'Agent', 'Skill']) {
    assert.ok(disallowed.includes(tool), `${tool} 应在禁用列表中：${disallowed}`)
  }
  const allowed = args[args.indexOf('--allowedTools') + 1]
  for (const forbidden of ['git commit', 'git merge', 'git push', 'flows-cli']) {
    assert.ok(!allowed.includes(forbidden), `${forbidden} 不该在允许列表中：${allowed}`)
  }
})

test('起草的提示词含 git status 输出与主规格清单', t => {
  const f = exitScenario(t, {
    files: {
      'specs/x/spec.md': '## ADDED Requirements\n',
      'decisions/autopilot.json': { status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' },
    },
    plan: { session_id: 's1', stop_reason: 'end_turn', result: { branch: 'fix/x', files: ['README.md'], message: '提交说明' } },
  })
  // 主规格清单按 delta spec 的能力名在 openspec/specs/ 下找（design D11「主规格清单」）。
  mkdirSync(join(f.repo, 'openspec', 'specs', 'x'), { recursive: true })
  writeFileSync(join(f.repo, 'openspec', 'specs', 'x', 'spec.md'), '## ADDED Requirements\n')
  writeFileSync(join(f.repo, 'README.md'), '# demo 改动\n')
  f.run()
  const calls = f.claudeCalls()
  const prompt = calls[0].args[calls[0].args.indexOf('-p') + 1]
  assert.ok(prompt.includes('README.md'), prompt)
  assert.ok(prompt.includes('openspec/specs/x/spec.md'), prompt)
})

test('起草结果不是期望结构时不创建出口决策', t => {
  const f = exitScenario(t, {
    files: { 'decisions/autopilot.json': { status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' } },
    plan: { session_id: 's1', stop_reason: 'end_turn', result: '不是计划' },
  })
  f.run()
  const exits = f.decisions().filter(item => item.kind === 'exit')
  assert.equal(exits.length, 0)
})

test('计划缺少主规格时不创建出口决策', t => {
  const f = exitScenario(t, {
    files: {
      'specs/x/spec.md': '## ADDED Requirements\n',
      'decisions/autopilot.json': { status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' },
    },
    plan: { session_id: 's1', stop_reason: 'end_turn', result: { branch: 'fix/x', files: ['README.md'], message: '提交说明' } },
  })
  f.run()
  const exits = f.decisions().filter(item => item.kind === 'exit')
  assert.equal(exits.length, 0, '缺少主规格时不该创建出口决策')
})

test('计划通过后创建出口决策，卡片列出分支、文件与说明', t => {
  const f = exitScenario(t, {
    files: { 'decisions/autopilot.json': { status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' } },
    plan: { session_id: 's1', stop_reason: 'end_turn', result: { branch: 'fix/x', files: ['README.md'], message: '提交说明' } },
  })
  writeFileSync(join(f.repo, 'README.md'), '# demo 改动\n')
  const snapshot = { 'README.md': spawnSync('git', ['hash-object', 'README.md'], { cwd: f.repo, encoding: 'utf8' }).stdout.trim() }
  writeFileSync(join(f.changeDir, 'decisions', 'autopilot.json'), `${JSON.stringify({
    status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP', implSnapshot: snapshot,
  }, null, 2)}\n`)
  f.run()
  const exits = f.decisions().filter(item => item.kind === 'exit')
  assert.equal(exits.length, 1, JSON.stringify(f.decisions()))
  const decision = exits[0]
  assert.equal(decision.status, 'pending')
  assert.equal(decision.request.action, 'commit-merge')
  assert.equal(decision.request.branch, 'fix/x')
  assert.deepEqual(decision.request.files, ['README.md'])
  assert.equal(decision.request.message, '提交说明')
  assert.deepEqual(decision.request.options, ['提交并合并', '只提交到分支', '暂不处理'])
  assert.ok(decision.request.contentDigest['README.md'], '缺少内容摘要')
})

test('出口决策等待回复时连续两轮只有一个出口决策，起草只运行一次', t => {
  // quality R1 SPEC-05：已归档变更也先执行检查顺序第 1–4 步（design D6「同一变更最多一个 pending 或 answered 决策」）。
  const f = exitScenario(t, {
    plan: { session_id: 's1', stop_reason: 'end_turn', result: { branch: 'fix/x', files: ['README.md'], message: '提交说明' } },
  })
  writeFileSync(join(f.repo, 'README.md'), '# demo 改动\n')
  const snapshot = { 'README.md': spawnSync('git', ['hash-object', 'README.md'], { cwd: f.repo, encoding: 'utf8' }).stdout.trim() }
  writeFileSync(join(f.changeDir, 'decisions', 'autopilot.json'), `${JSON.stringify({
    status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP', implSnapshot: snapshot,
  }, null, 2)}\n`)
  f.run()
  f.run()
  assert.equal(f.decisions().filter(item => item.kind === 'exit').length, 1, JSON.stringify(f.decisions()))
  assert.equal(f.claudeCalls().length, 1, '起草只应运行一次')
})

/** 归档阶段留下的已回复会话告警。 */
const archiveAlert = choice => ({
  id: 'D-0001', kind: 'alert', status: 'answered', stage: 'archive',
  request: { sessionId: 'sess-archive', text: '没有进展', options: ['补充说明后继续', '回会话处理'] },
  answer: { operatorId: 'ou_owner', eventId: 'E1', choice, text: choice === '补充说明后继续' ? '继续归档' : '' },
  card: { messageId: 'om_card' },
})

test('归档后留下的会话告警选回会话处理时作废托管，不起草出口动作', t => {
  // spec autopilot-scheduler「Alert after archive moves the directory」之后的下一轮（quality R1 SPEC-05）。
  const f = exitScenario(t, { files: { 'decisions/D-0001.json': archiveAlert('回会话处理') } })
  f.run()
  assert.equal(f.record().status, 'void')
  assert.equal(f.decisions().find(item => item.id === 'D-0001').status, 'used')
  assert.equal(f.claudeCalls().length, 0)
  assert.equal(f.decisions().filter(item => item.kind === 'exit').length, 0)
})

test('归档后留下的会话告警选补充说明后继续时恢复会话，不起草出口动作', t => {
  const f = exitScenario(t, { files: { 'decisions/D-0001.json': archiveAlert('补充说明后继续') } })
  f.run()
  const calls = f.claudeCalls()
  assert.equal(calls.length, 1, JSON.stringify(calls))
  assert.ok(calls[0].args.includes('--resume') && calls[0].args.includes('sess-archive'), JSON.stringify(calls[0].args))
  assert.equal(f.decisions().filter(item => item.kind === 'exit').length, 0)
})

/** 准备一次提交与合并的起草：README.md 已改动并写入实现快照，起草替身输出 result 文本。 */
function draftWithText(t, text) {
  const f = exitScenario(t)
  writeFileSync(join(f.repo, 'README.md'), '# demo 改动\n')
  writeExitRecord(f, { status: 'active', implSnapshot: digestOf(f, ['README.md']) })
  setClaudeOutput(f.doublesDir, { session_id: 's1', stop_reason: 'end_turn', result: text })
  f.run()
  return f
}

test('起草结果是带代码块围栏的 JSON 文本时创建出口决策', t => {
  // spec autopilot-exit-actions 第 2 条「Read the plan from the JSON in result」（quality R1 SPEC-07）。
  const f = draftWithText(t, '计划如下：\n```json\n{"branch": "fix/x", "files": ["README.md"], "message": "提交说明"}\n```\n')
  const exits = f.decisions().filter(item => item.kind === 'exit')
  assert.equal(exits.length, 1, JSON.stringify(f.decisions()))
  assert.equal(exits[0].request.branch, 'fix/x')
})

test('起草结果不是 JSON 时创建出口告警', t => {
  const f = draftWithText(t, '我没法起草这个计划。')
  assert.equal(f.decisions().filter(item => item.kind === 'exit').length, 0)
  const alert = f.decisions().find(item => item.kind === 'exit-alert')
  assert.ok(alert && alert.request.text.includes('不是期望的 JSON'), JSON.stringify(f.decisions()))
})

test('暂存区有计划以外的文件时不创建出口决策', t => {
  const f = exitScenario(t, {
    files: { 'decisions/autopilot.json': { status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' } },
    plan: { session_id: 's1', stop_reason: 'end_turn', result: { branch: 'fix/x', files: ['README.md'], message: '提交说明' } },
  })
  writeFileSync(join(f.repo, 'README.md'), '# demo 改动\n')
  mkdirSync(join(f.repo, 'notes'), { recursive: true })
  writeFileSync(join(f.repo, 'notes', 'draft.md'), '草稿\n')
  f.git('add', 'notes/draft.md')
  const snapshot = { 'README.md': spawnSync('git', ['hash-object', 'README.md'], { cwd: f.repo, encoding: 'utf8' }).stdout.trim() }
  writeFileSync(join(f.changeDir, 'decisions', 'autopilot.json'), `${JSON.stringify({
    status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP', implSnapshot: snapshot,
  }, null, 2)}\n`)
  f.run()
  const exits = f.decisions().filter(item => item.kind === 'exit')
  assert.equal(exits.length, 0)
  const alerts = f.decisions().filter(item => item.kind === 'exit-alert')
  assert.equal(alerts.length, 1)
  assert.ok(alerts[0].request.text.includes('notes/draft.md'), alerts[0].request.text)
})

test('没有实现快照时不创建出口决策', t => {
  const f = exitScenario(t, {
    files: { 'decisions/autopilot.json': { status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' } },
    plan: { session_id: 's1', stop_reason: 'end_turn', result: { branch: 'fix/x', files: ['README.md'], message: '提交说明' } },
  })
  writeFileSync(join(f.repo, 'README.md'), '# demo 改动\n')
  f.run()
  assert.equal(f.decisions().filter(item => item.kind === 'exit').length, 0)
  const alerts = f.decisions().filter(item => item.kind === 'exit-alert')
  assert.equal(alerts.length, 1)
  assert.ok(alerts[0].request.text.includes('快照'), alerts[0].request.text)
})

test('分支名不合法时不创建出口决策', t => {
  const f = exitScenario(t, {
    files: { 'decisions/autopilot.json': { status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' } },
    plan: { session_id: 's1', stop_reason: 'end_turn', result: { branch: 'fix/x;touch /tmp/autopilot-p', files: ['README.md'], message: '提交说明' } },
  })
  writeFileSync(join(f.repo, 'README.md'), '# demo 改动\n')
  const snapshot = { 'README.md': spawnSync('git', ['hash-object', 'README.md'], { cwd: f.repo, encoding: 'utf8' }).stdout.trim() }
  writeFileSync(join(f.changeDir, 'decisions', 'autopilot.json'), `${JSON.stringify({
    status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP', implSnapshot: snapshot,
  }, null, 2)}\n`)
  f.run()
  assert.equal(f.decisions().filter(item => item.kind === 'exit').length, 0)
  assert.equal(f.decisions().filter(item => item.kind === 'exit-alert').length, 1)
  assert.equal(existsSync('/tmp/autopilot-p'), false)
})

test('选择暂不处理时托管结束并列出已跳过的动作', t => {
  const f = exitScenario(t, {
    files: {
      'decisions/autopilot.json': { status: 'exiting', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' },
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'exit', status: 'answered', stage: 'exit',
        request: { action: 'commit-merge', branch: 'fix/x', files: [], message: '', options: ['提交并合并', '只提交到分支', '暂不处理'] },
        answer: { operatorId: 'ou_owner', eventId: 'E1', choice: '暂不处理', text: '' },
      },
    },
  })
  const runResult = f.run()
  const logs = existsSync(join(f.home, 'logs', 'scheduler.log'))
    ? readFileSync(join(f.home, 'logs', 'scheduler.log'), 'utf8') : `（没有日志）退出码 ${runResult.code}；输出 ${runResult.out}${runResult.err}`
  assert.equal(f.record().status, 'closed', `退出码 ${runResult.code}；输出 ${runResult.all}；日志：${logs}`)
  const cards = f.larkCalls()
  const notice = cards.map(call => call.content || call.args.join(' ')).join('\n')
  assert.ok(notice.includes('commit-merge'), `通知内容：${notice}；卡片数：${cards.length}；日志：${logs}`)
  assert.ok(notice.includes('push'), notice)
})

test('云舟任务的结束通知卡片写出任务号', t => {
  const f = exitScenario(t, {
    files: {
      'proposal.md': '## Why\n\n云舟任务：123\n',
      'decisions/autopilot.json': { status: 'exiting', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' },
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'exit', status: 'answered', stage: 'exit',
        request: { action: 'commit-merge', branch: 'fix/x', files: [], message: '', options: ['提交并合并', '只提交到分支', '暂不处理'] },
        answer: { operatorId: 'ou_owner', eventId: 'E1', choice: '暂不处理', text: '' },
      },
    },
  })
  f.run()
  const notice = f.larkCalls().map(call => call.content || call.args.join(' ')).join('\n')
  assert.ok(notice.includes('123'), notice)
})

test('已回复的提交决策执行提交与合并', t => {
  const f = exitScenario(t, {
    files: {
      'decisions/autopilot.json': { status: 'exiting', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' },
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'exit', status: 'answered', stage: 'exit',
        request: {
          action: 'commit-merge', branch: 'fix/x', files: ['README.md'], message: '提交说明',
          contentDigest: {}, ignored: [], deleted: [], removed: [], mainSpecs: [], options: ['提交并合并', '只提交到分支', '暂不处理'],
        },
        answer: { operatorId: 'ou_owner', eventId: 'E1', choice: '提交并合并', text: '' },
      },
    },
  })
  writeFileSync(join(f.repo, 'README.md'), '# demo 改动\n')
  const hash = spawnSync('git', ['hash-object', 'README.md'], { cwd: f.repo, encoding: 'utf8' }).stdout.trim()
  const decisionFile = join(f.changeDir, 'decisions', 'D-0001.json')
  const decision = JSON.parse(readFileSync(decisionFile, 'utf8'))
  decision.request.contentDigest = { 'README.md': hash }
  writeFileSync(decisionFile, `${JSON.stringify(decision, null, 2)}\n`)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  const decisionAfter = JSON.parse(readFileSync(decisionFile, 'utf8'))
  assert.equal(decisionAfter.status, 'used')
  assert.equal(decisionAfter.result.ok, true, JSON.stringify(decisionAfter.result))
  const log = f.logCommits()
  assert.ok(log.includes('提交说明'), log)
  assert.equal(f.branch(), 'main')
  const parents = f.git('rev-list', '--parents', '-1', 'HEAD').split(' ')
  assert.equal(parents.length, 3, `合并提交应有两个父：${parents.join(' ')}`)
})

test('文件在卡片确认后被改动时提交失败', t => {
  const f = exitScenario(t, {
    files: {
      'decisions/autopilot.json': { status: 'exiting', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' },
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'exit', status: 'answered', stage: 'exit',
        request: {
          action: 'commit-merge', branch: 'fix/x', files: ['README.md'], message: '提交说明',
          contentDigest: { 'README.md': 'deadbeef' }, ignored: [], deleted: [], removed: [], mainSpecs: [],
          options: ['提交并合并', '只提交到分支', '暂不处理'],
        },
        answer: { operatorId: 'ou_owner', eventId: 'E1', choice: '提交并合并', text: '' },
      },
    },
  })
  writeFileSync(join(f.repo, 'README.md'), '# demo 改动\n')
  f.run()
  const decision = JSON.parse(readFileSync(join(f.changeDir, 'decisions', 'D-0001.json'), 'utf8'))
  assert.equal(decision.status, 'used')
  assert.equal(decision.result.ok, false)
  assert.ok(decision.result.error.includes('README.md'), decision.result.error)
  assert.equal(f.decisions().filter(item => item.kind === 'exit-alert').length, 1)
  assert.ok(!f.logCommits().includes('提交说明'), '不该产生提交')
})

test('只提交到分支时检出停在该分支', t => {
  const f = exitScenario(t, {
    files: {
      'decisions/autopilot.json': { status: 'exiting', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' },
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'exit', status: 'answered', stage: 'exit',
        request: {
          action: 'commit-merge', branch: 'fix/x', files: ['README.md'], message: '提交说明',
          contentDigest: {}, ignored: [], deleted: [], removed: [], mainSpecs: [], options: ['提交并合并', '只提交到分支', '暂不处理'],
        },
        answer: { operatorId: 'ou_owner', eventId: 'E1', choice: '只提交到分支', text: '' },
      },
    },
  })
  writeFileSync(join(f.repo, 'README.md'), '# demo 改动\n')
  const hash = spawnSync('git', ['hash-object', 'README.md'], { cwd: f.repo, encoding: 'utf8' }).stdout.trim()
  const decisionFile = join(f.changeDir, 'decisions', 'D-0001.json')
  const decision = JSON.parse(readFileSync(decisionFile, 'utf8'))
  decision.request.contentDigest = { 'README.md': hash }
  writeFileSync(decisionFile, `${JSON.stringify(decision, null, 2)}\n`)
  f.run()
  assert.equal(f.branch(), 'fix/x')
  assert.ok(f.logCommits().includes('提交说明'))
})

test('推送清单列出将推送的提交', t => {
  const f = exitScenario(t, {
    files: {
      'decisions/autopilot.json': { status: 'exiting', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP' },
      'decisions/D-0001.json': {
        id: 'D-0001', kind: 'exit', status: 'answered', stage: 'exit',
        request: { action: 'push', branch: 'fix/x', commits: [], options: ['推送', '暂不处理'] },
        answer: { operatorId: 'ou_owner', eventId: 'E1', choice: '暂不处理', text: '' },
      },
    },
  })
  f.run()
  const decision = JSON.parse(readFileSync(join(f.changeDir, 'decisions', 'D-0001.json'), 'utf8'))
  assert.equal(decision.status, 'used')
  assert.equal(f.record().status, 'closed')
})

// ---------------------------------------------------------------------------
// 出口动作：执行、回读、重试与推送（add-autopilot-loop Slice 07）
// ---------------------------------------------------------------------------

/** 当前工作区中各文件的 git hash-object；删除的文件记 null。 */
function digestOf(f, files) {
  return Object.fromEntries(files.map(file => [file, existsSync(join(f.repo, file))
    ? spawnSync('git', ['hash-object', file], { cwd: f.repo, encoding: 'utf8' }).stdout.trim() : null]))
}

/** 写一个已回复的提交与合并出口决策，内容摘要按当前工作区计算。 */
function answeredCommit(f, { files = ['README.md'], choice = '提交并合并', branch = 'fix/x', message = '提交说明', extra = {} } = {}) {
  writeFileSync(join(f.changeDir, 'decisions', 'D-0001.json'), `${JSON.stringify({
    id: 'D-0001', kind: 'exit', status: 'answered', stage: 'exit',
    request: {
      action: 'commit-merge', branch, files, message, contentDigest: digestOf(f, files),
      ignored: [], deleted: [], removed: [], mainSpecs: [], options: ['提交并合并', '只提交到分支', '暂不处理'], ...extra,
    },
    answer: { operatorId: 'ou_owner', eventId: 'E1', choice, text: '' },
  }, null, 2)}\n`)
}

/** 读托管记录与某个决策。 */
const decisionOf = (f, id) => JSON.parse(readFileSync(join(f.changeDir, 'decisions', `${id}.json`), 'utf8'))

/** 写托管记录（出口阶段）。 */
function writeExitRecord(f, extra = {}) {
  writeFileSync(join(f.changeDir, 'decisions', 'autopilot.json'), `${JSON.stringify({
    status: 'exiting', startedAt: '2026-11-06T10:00:00Z', rule: 'R11', tier: 'MVP', ...extra,
  }, null, 2)}\n`)
}

/** 写起草替身的计划，并把当前工作区写成实现快照。 */
function draftPlan(f, plan, snapshotFiles = plan.files.filter(file => !file.startsWith('openspec/'))) {
  setClaudeOutput(f.doublesDir, textResult({ session_id: 's1', stop_reason: 'end_turn', result: plan }))
  writeExitRecord(f, { status: 'active', implSnapshot: digestOf(f, snapshotFiles) })
}

test('合并冲突时 merge --abort，出口决策 used 且只剩一个未完成的出口告警', t => {
  const f = exitScenario(t)
  // 分支提交 C1 已在 fix/x 上，之后主分支改了同一行：回读通过后合并冲突。
  f.git('switch', '-qc', 'fix/x')
  writeFileSync(join(f.repo, 'README.md'), '# 分支上的改动\n')
  f.git('commit', '-qm', '提交说明', '--', 'README.md')
  const c1 = f.git('rev-parse', 'HEAD')
  f.git('switch', '-q', 'main')
  writeFileSync(join(f.repo, 'README.md'), '# 主分支上的改动\n')
  f.git('commit', '-qm', 'base change', '--', 'README.md')
  writeExitRecord(f, { exit: { 'commit-merge': { branch: 'fix/x', commit: c1 } } })
  answeredCommit(f, { extra: { contentDigest: { 'README.md': f.git('rev-parse', `${c1}:README.md`) } } })
  f.run()
  const decision = decisionOf(f, 'D-0001')
  assert.equal(decision.status, 'used')
  assert.equal(decision.result.ok, false, JSON.stringify(decision.result))
  assert.ok(decision.result.error.includes('合并冲突'), decision.result.error)
  assert.equal(existsSync(join(f.repo, '.git', 'MERGE_HEAD')), false, '不能留下合并中的状态')
  const open = f.decisions().filter(item => item.status === 'pending' || item.status === 'answered')
  assert.equal(open.length, 1, JSON.stringify(open))
  assert.equal(open[0].kind, 'exit-alert')
})

test('重试本项：提交已在分支上时不起草，创建只合并的出口决策，合并后分支末端不变', t => {
  const f = exitScenario(t)
  writeFileSync(join(f.repo, 'README.md'), '# 分支上的改动\n')
  f.git('switch', '-qc', 'fix/x')
  f.git('commit', '-qam', '提交说明')
  const c1 = f.git('rev-parse', 'HEAD')
  f.git('switch', '-q', 'main')
  writeExitRecord(f, { exit: { 'commit-merge': { branch: 'fix/x', commit: c1, ok: false, failed: true } } })
  writeFileSync(join(f.changeDir, 'decisions', 'D-0001.json'), `${JSON.stringify({
    id: 'D-0001', kind: 'exit', status: 'used', stage: 'exit',
    request: { action: 'commit-merge', branch: 'fix/x', files: ['README.md'], message: '提交说明',
      contentDigest: { 'README.md': f.git('rev-parse', `${c1}:README.md`) }, ignored: [], deleted: [], removed: [], mainSpecs: [],
      options: ['提交并合并', '只提交到分支', '暂不处理'] },
    result: { ok: false, error: '合并冲突', steps: ['branch', 'commit'] },
  }, null, 2)}\n`)
  writeFileSync(join(f.changeDir, 'decisions', 'D-0002.json'), `${JSON.stringify({
    id: 'D-0002', kind: 'exit-alert', status: 'answered', stage: 'exit',
    request: { exitAction: 'commit-merge', text: '合并冲突', options: ['重试本项', '暂不处理', '回会话处理'] },
    answer: { operatorId: 'ou_owner', eventId: 'E2', choice: '重试本项', text: '' },
  }, null, 2)}\n`)
  f.run()
  assert.equal(decisionOf(f, 'D-0002').status, 'used')
  f.run()
  assert.equal(f.claudeCalls().length, 0, '提交已在分支上时不起草')
  const retry = decisionOf(f, 'D-0003')
  assert.equal(retry.status, 'pending')
  assert.equal(retry.request.commitOnBranch, c1)
  const card = f.larkCalls().map(call => call.content || '').join('\n')
  assert.ok(card.includes('本次只合并'), card)
  // 用户选提交并合并：分支末端仍是 C1，主分支有以 C1 为第二父提交的合并提交。
  const answered = { ...retry, status: 'answered', answer: { operatorId: 'ou_owner', eventId: 'E3', choice: '提交并合并', text: '' } }
  writeFileSync(join(f.changeDir, 'decisions', 'D-0003.json'), `${JSON.stringify(answered, null, 2)}\n`)
  f.run()
  assert.equal(decisionOf(f, 'D-0003').result.ok, true, JSON.stringify(decisionOf(f, 'D-0003').result))
  assert.equal(f.git('rev-parse', 'fix/x'), c1)
  assert.equal(f.git('rev-parse', 'HEAD^2'), c1)
})

test('中断后分支已有同样说明的提交时不再提交，下一轮只合并', t => {
  const f = exitScenario(t)
  writeExitRecord(f)
  writeFileSync(join(f.repo, 'README.md'), '# 分支上的改动\n')
  answeredCommit(f)
  f.git('switch', '-qc', 'fix/x')
  f.git('commit', '-qam', '提交说明')
  const tip = f.git('rev-parse', 'HEAD')
  f.run()
  assert.equal(decisionOf(f, 'D-0001').result.ok, true, JSON.stringify(decisionOf(f, 'D-0001').result))
  assert.equal(f.git('rev-parse', 'fix/x'), tip, '分支末端不能有新提交')
  assert.equal(f.branch(), 'main')
  assert.equal(f.git('rev-parse', 'HEAD^2'), tip)
})

test('回读到的提交含计划以外的路径时不合并', t => {
  const f = exitScenario(t)
  writeFileSync(join(f.repo, 'README.md'), '# 分支上的改动\n')
  writeFileSync(join(f.repo, 'extra.txt'), '计划外\n')
  f.git('switch', '-qc', 'fix/x')
  f.git('add', '--', 'README.md', 'extra.txt')
  f.git('commit', '-qm', '提交说明')
  const c1 = f.git('rev-parse', 'HEAD')
  f.git('switch', '-q', 'main')
  writeExitRecord(f, { exit: { 'commit-merge': { branch: 'fix/x', commit: c1 } } })
  writeFileSync(join(f.changeDir, 'decisions', 'D-0001.json'), `${JSON.stringify({
    id: 'D-0001', kind: 'exit', status: 'answered', stage: 'exit',
    request: { action: 'commit-merge', branch: 'fix/x', files: ['README.md'], message: '提交说明',
      contentDigest: { 'README.md': f.git('rev-parse', `${c1}:README.md`) }, options: ['提交并合并', '只提交到分支', '暂不处理'] },
    answer: { operatorId: 'ou_owner', eventId: 'E1', choice: '提交并合并', text: '' },
  }, null, 2)}\n`)
  const before = f.git('rev-parse', 'main')
  f.run()
  assert.equal(decisionOf(f, 'D-0001').result.ok, false)
  assert.equal(f.git('rev-parse', 'main'), before)
})

test('删除的已跟踪文件被提交为删除，卡片单列删除的文件', t => {
  const f = exitScenario(t)
  mkdirSync(join(f.repo, 'scripts'), { recursive: true })
  writeFileSync(join(f.repo, 'scripts', 'old.mjs'), 'old\n')
  f.git('add', '-A')
  f.git('commit', '-qm', 'add old')
  f.git('push', '-q', 'origin', 'main')
  rmSync(join(f.repo, 'scripts', 'old.mjs'))
  draftPlan(f, { branch: 'fix/x', files: ['scripts/old.mjs'], message: '删除旧脚本' })
  f.run()
  const decision = f.decisions().find(item => item.kind === 'exit')
  assert.ok(decision, JSON.stringify(f.decisions()))
  assert.deepEqual(decision.request.deleted, ['scripts/old.mjs'])
  assert.ok(f.larkCalls().map(call => call.content || '').join('\n').includes('删除的文件'))
  const answered = { ...decision, status: 'answered', answer: { operatorId: 'ou_owner', eventId: 'E1', choice: '提交并合并', text: '' } }
  writeFileSync(join(f.changeDir, 'decisions', `${decision.id}.json`), `${JSON.stringify(answered, null, 2)}\n`)
  f.run()
  assert.equal(decisionOf(f, decision.id).result.ok, true, JSON.stringify(decisionOf(f, decision.id).result))
  assert.equal(f.git('status', '--porcelain', '--', 'scripts/old.mjs'), '')
  assert.ok(f.git('show', '--name-status', '--format=', 'fix/x').includes('D\tscripts/old.mjs'))
})

test('计划含别的变更的主规格时拒绝，告警写出路径', t => {
  const f = exitScenario(t, { files: { 'specs/x/spec.md': '## ADDED Requirements\n' } })
  for (const cap of ['x', 'y']) {
    mkdirSync(join(f.repo, 'openspec', 'specs', cap), { recursive: true })
    writeFileSync(join(f.repo, 'openspec', 'specs', cap, 'spec.md'), `# ${cap}\n`)
  }
  draftPlan(f, { branch: 'fix/x', files: ['openspec/specs/x/spec.md', 'openspec/specs/y/spec.md'], message: '说明' })
  f.run()
  assert.equal(f.decisions().filter(item => item.kind === 'exit').length, 0)
  const alert = f.decisions().find(item => item.kind === 'exit-alert')
  assert.ok(alert && alert.request.text.includes('openspec/specs/y/spec.md'), JSON.stringify(alert))
})

test('别的变更遗留的主规格与 .DS_Store 不进主规格清单，卡片单列为不属于本变更', t => {
  const f = exitScenario(t, { files: { 'specs/x/spec.md': '## ADDED Requirements\n' } })
  for (const cap of ['x', 'y']) {
    mkdirSync(join(f.repo, 'openspec', 'specs', cap), { recursive: true })
    writeFileSync(join(f.repo, 'openspec', 'specs', cap, 'spec.md'), `# ${cap}\n`)
  }
  writeFileSync(join(f.repo, '.gitignore'), '.DS_Store\n')
  writeFileSync(join(f.repo, 'openspec', 'specs', '.DS_Store'), 'x')
  draftPlan(f, { branch: 'fix/x', files: ['openspec/specs/x/spec.md'], message: '说明' })
  f.run()
  const prompt = f.claudeCalls()[0].args[f.claudeCalls()[0].args.indexOf('-p') + 1]
  const listed = prompt.split('主规格清单')[1].split('不要列入')[0]
  assert.ok(listed.includes('openspec/specs/x/spec.md') && !listed.includes('y/spec.md') && !listed.includes('.DS_Store'), listed)
  const card = f.larkCalls().map(call => call.content || '').join('\n')
  assert.ok(card.includes('不属于本变更') && card.includes('openspec/specs/y/spec.md') && card.includes('.DS_Store'), card)
})

test('当前分支不是 baseBranch 时拒绝计划，告警写出当前分支', t => {
  const f = exitScenario(t)
  f.git('switch', '-qc', 'fix/a')
  writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
  draftPlan(f, { branch: 'fix/x', files: ['README.md'], message: '说明' })
  f.run()
  const alert = f.decisions().find(item => item.kind === 'exit-alert')
  assert.ok(alert && alert.request.text.includes('fix/a'), JSON.stringify(f.decisions()))
})

test('计划列出目录时拒绝，分支列表不变', t => {
  const f = exitScenario(t)
  mkdirSync(join(f.repo, 'foo-service'), { recursive: true })
  writeFileSync(join(f.repo, '.gitignore'), 'application-local.yml\n')
  writeFileSync(join(f.repo, 'foo-service', 'application-local.yml'), 'password: x\n')
  draftPlan(f, { branch: 'fix/x', files: ['foo-service/'], message: '说明' }, [])
  const branches = f.git('branch', '--list')
  f.run()
  assert.equal(f.decisions().filter(item => item.kind === 'exit').length, 0)
  assert.equal(f.git('branch', '--list'), branches)
})

test('archive 阶段改过的文件与实现快照不同时拒绝', t => {
  const f = exitScenario(t)
  mkdirSync(join(f.repo, 'scripts'), { recursive: true })
  writeFileSync(join(f.repo, 'scripts', 'a.mjs'), 'v1\n')
  draftPlan(f, { branch: 'fix/x', files: ['scripts/a.mjs'], message: '说明' })
  writeFileSync(join(f.repo, 'scripts', 'a.mjs'), 'v2（archive 阶段改的）\n')
  f.run()
  assert.equal(f.decisions().filter(item => item.kind === 'exit').length, 0)
  const alert = f.decisions().find(item => item.kind === 'exit-alert')
  assert.ok(alert && alert.request.text.includes('scripts/a.mjs'), JSON.stringify(alert))
})

test('openspec 进 git 时本变更 decisions/ 的文件不进入提交，卡片单列', t => {
  const f = exitScenario(t)
  writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
  const rel = 'openspec/changes/archive/2026-11-16-demo/decisions/autopilot.json'
  draftPlan(f, { branch: 'fix/x', files: ['README.md', rel], message: '说明' }, ['README.md'])
  f.run()
  const decision = f.decisions().find(item => item.kind === 'exit')
  assert.ok(decision, JSON.stringify(f.decisions()))
  assert.deepEqual(decision.request.files, ['README.md'])
  assert.deepEqual(decision.request.removed, [rel])
  assert.ok(f.larkCalls().map(call => call.content || '').join('\n').includes('托管结束后由用户提交'))
  const answered = { ...decision, status: 'answered', answer: { operatorId: 'ou_owner', eventId: 'E1', choice: '提交并合并', text: '' } }
  writeFileSync(join(f.changeDir, 'decisions', `${decision.id}.json`), `${JSON.stringify(answered, null, 2)}\n`)
  f.run()
  assert.equal(decisionOf(f, decision.id).result.ok, true, JSON.stringify(decisionOf(f, decision.id).result))
  assert.ok(!f.git('show', '--name-only', '--format=', 'fix/x').includes('decisions/'))
})

test('推送卡片列出本地未推送的提交，推送后远端主分支指向合并提交', t => {
  const f = exitScenario(t)
  writeFileSync(join(f.repo, 'local.txt'), 'L\n')
  f.git('add', '-A')
  f.git('commit', '-qm', '本地提交 L')
  writeExitRecord(f)
  writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
  answeredCommit(f)
  f.run()
  assert.equal(decisionOf(f, 'D-0001').result.ok, true, JSON.stringify(decisionOf(f, 'D-0001').result))
  f.run()
  const push = f.decisions().find(item => item.kind === 'exit' && item.request.action === 'push')
  assert.ok(push, JSON.stringify(f.decisions()))
  assert.ok(push.request.commits.some(item => item.subject === '本地提交 L'), JSON.stringify(push.request.commits))
  const card = f.larkCalls().map(call => call.content || '').join('\n')
  assert.ok(card.includes('本地提交 L'), card)
  const answered = { ...push, status: 'answered', answer: { operatorId: 'ou_owner', eventId: 'E2', choice: '推送', text: '' } }
  writeFileSync(join(f.changeDir, 'decisions', `${push.id}.json`), `${JSON.stringify(answered, null, 2)}\n`)
  f.run()
  assert.equal(decisionOf(f, push.id).result.ok, true, JSON.stringify(decisionOf(f, push.id).result))
  const remote = spawnSync('git', ['--git-dir', f.origin, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim()
  assert.equal(remote, f.git('rev-parse', 'main'))
  assert.ok(spawnSync('git', ['--git-dir', f.origin, 'rev-parse', 'refs/heads/fix/x'], { encoding: 'utf8' }).status === 0)
  f.run()
  assert.equal(f.record().status, 'closed')
})

test('推送期间撤回时，撤回等调度释放锁后才退出，远端不变', async t => {
  // spec autopilot-exit-actions「Cancel during the push stops the remaining steps」（quality R1 SPEC-04）。
  const f = exitScenario(t)
  writeExitRecord(f)
  writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
  answeredCommit(f)
  f.run()
  f.run()
  const push = f.decisions().find(item => item.kind === 'exit' && item.request.action === 'push')
  assert.ok(push, JSON.stringify(f.decisions()))
  writeFileSync(join(f.changeDir, 'decisions', `${push.id}.json`), `${JSON.stringify({
    ...push, status: 'answered', answer: { operatorId: 'ou_owner', eventId: 'E2', choice: '推送', text: '' },
  }, null, 2)}\n`)
  const remoteBefore = spawnSync('git', ['--git-dir', f.origin, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim()
  // 让访问 origin 的每条 git 命令先等 2 秒：ext 远端先运行这个脚本，再转给真实的 git。
  const slow = join(f.doublesDir, 'slow-remote.sh')
  writeFileSync(slow, `#!/bin/sh\nsleep 2\nexec git "$1" ${JSON.stringify(f.origin)}\n`)
  chmodSync(slow, 0o755)
  f.git('config', 'protocol.ext.allow', 'always')
  f.git('remote', 'set-url', 'origin', `ext::${slow} %s`)

  const env = { ...process.env, HOME: f.home, OPENSPEC_AUTOPILOT_HOME: f.home }
  const exited = name => new Promise(resolve => {
    const child = spawn(process.execPath, name === 'scheduler' ? [scheduler, '--once'] : [autopilot, 'cancel', 'demo'],
      { cwd: f.repo, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let all = ''
    child.stdout.on('data', chunk => { all += chunk })
    child.stderr.on('data', chunk => { all += chunk })
    child.on('exit', code => resolve({ code, all, at: Date.now() }))
  })
  const sched = exited('scheduler')
  await new Promise(resolve => setTimeout(resolve, 1000))
  const cancel = await exited('cancel')
  const schedDone = await sched
  assert.equal(cancel.code, 0, cancel.all)
  assert.ok(cancel.at >= schedDone.at, '撤回应在调度进程释放锁之后才退出')
  const remoteAfter = spawnSync('git', ['--git-dir', f.origin, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim()
  assert.equal(remoteAfter, remoteBefore)
  assert.equal(f.record().status, 'void')
})

test('远端主分支前进时不推送，出口决策失败并发出口告警', t => {
  const f = exitScenario(t)
  writeExitRecord(f)
  writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
  answeredCommit(f)
  f.run()
  f.run()
  const push = f.decisions().find(item => item.kind === 'exit' && item.request.action === 'push')
  // 另一个人推了一个提交到远端主分支。
  const other = mkdtempSync(join(tmpdir(), 'autopilot-exit-other-'))
  t.after(() => rmSync(other, { recursive: true, force: true }))
  spawnSync('git', ['clone', '-q', f.origin, other])
  writeFileSync(join(other, 'other.txt'), 'x\n')
  spawnSync('git', ['-c', 'user.name=o', '-c', 'user.email=o@e.com', 'add', '-A'], { cwd: other })
  spawnSync('git', ['-c', 'user.name=o', '-c', 'user.email=o@e.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'other'], { cwd: other })
  spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: other })
  const remoteBefore = spawnSync('git', ['--git-dir', f.origin, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim()
  const answered = { ...push, status: 'answered', answer: { operatorId: 'ou_owner', eventId: 'E2', choice: '推送', text: '' } }
  writeFileSync(join(f.changeDir, 'decisions', `${push.id}.json`), `${JSON.stringify(answered, null, 2)}\n`)
  f.run()
  assert.equal(decisionOf(f, push.id).result.ok, false)
  assert.equal(spawnSync('git', ['--git-dir', f.origin, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim(), remoteBefore)
  assert.ok(f.decisions().some(item => item.kind === 'exit-alert' && item.status === 'pending'))
})

test('调度脚本源码中 git commit、merge、push 只出现在 lib/exit-actions.mjs', () => {
  const dir = fileURLToPath(new URL('../skills/openspec-autopilot/scripts/', import.meta.url))
  const files = [...readdirSync(dir).filter(name => name.endsWith('.mjs')).map(name => join(dir, name)),
    ...readdirSync(join(dir, 'lib')).filter(name => name.endsWith('.mjs')).map(name => join(dir, 'lib', name))]
  const offenders = files.filter(file => !file.endsWith('exit-actions.mjs'))
    .filter(file => /\[\s*'(commit|merge|push)'/.test(readFileSync(file, 'utf8')))
  assert.deepEqual(offenders, [])
})

test('起草改了文件时不创建出口决策，创建出口告警', t => {
  const f = exitScenario(t)
  writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
  draftPlan(f, { branch: 'fix/x', files: ['README.md'], message: '说明' })
  // 起草替身在运行时改 README.md：前后进展摘要不同。
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([{ file: join(f.repo, 'README.md'), content: '# 起草改的\n' }]))
  f.run()
  assert.equal(f.decisions().filter(item => item.kind === 'exit').length, 0)
  const alert = f.decisions().find(item => item.kind === 'exit-alert')
  assert.ok(alert && alert.status === 'pending' && alert.request.text.includes('起草修改了文件'), JSON.stringify(alert))
})

test('重试本项：没有提交时重新起草，提示词带上一次的分支名', t => {
  const f = exitScenario(t)
  writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
  draftPlan(f, { branch: 'fix/x', files: ['README.md'], message: '说明' })
  writeExitRecord(f, { status: 'exiting', implSnapshot: digestOf(f, ['README.md']),
    exit: { 'commit-merge': { branch: 'fix/x', ok: false, failed: true } } })
  writeFileSync(join(f.changeDir, 'decisions', 'D-0001.json'), `${JSON.stringify({
    id: 'D-0001', kind: 'exit', status: 'used', stage: 'exit',
    request: { action: 'commit-merge', branch: 'fix/x', files: ['README.md'], message: '说明', options: ['提交并合并', '只提交到分支', '暂不处理'] },
    result: { ok: false, error: 'git commit 失败', steps: ['branch'] },
  }, null, 2)}\n`)
  writeFileSync(join(f.changeDir, 'decisions', 'D-0002.json'), `${JSON.stringify({
    id: 'D-0002', kind: 'exit-alert', status: 'answered', stage: 'exit',
    request: { exitAction: 'commit-merge', text: 'git commit 失败', options: ['重试本项', '暂不处理', '回会话处理'] },
    answer: { operatorId: 'ou_owner', eventId: 'E2', choice: '重试本项', text: '' },
  }, null, 2)}\n`)
  f.run()
  assert.equal(decisionOf(f, 'D-0002').status, 'used')
  f.run()
  const calls = f.claudeCalls()
  assert.equal(calls.length, 1)
  const prompt = calls[0].args[calls[0].args.indexOf('-p') + 1]
  assert.ok(prompt.includes('上一次的分支名是 fix/x'), prompt)
})

test('提交前失败后重试：复用同一提交的分支，完成提交并合并', t => {
  const f = exitScenario(t)
  writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
  writeExitRecord(f)
  answeredCommit(f)
  // 第一次提交被 pre-commit hook 拒绝：分支已建，没有新提交。
  const hook = join(f.repo, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  chmodSync(hook, 0o755)
  f.run()
  assert.equal(decisionOf(f, 'D-0001').result.ok, false)
  assert.equal(f.branch(), 'main', '提交前失败时切回主分支')
  rmSync(hook)
  // 用户选重试本项后，下一轮按同样的计划创建新的出口决策（此处直接写入已回复的决策 D-0003）。
  const alert = f.decisions().find(item => item.kind === 'exit-alert')
  assert.ok(alert, JSON.stringify(f.decisions()))
  writeFileSync(join(f.changeDir, 'decisions', `${alert.id}.json`), `${JSON.stringify({ ...alert, status: 'used' }, null, 2)}\n`)
  writeFileSync(join(f.changeDir, 'decisions', 'D-0003.json'), `${JSON.stringify({
    ...decisionOf(f, 'D-0001'), id: 'D-0003', status: 'answered', result: undefined,
    answer: { operatorId: 'ou_owner', eventId: 'E3', choice: '提交并合并', text: '' },
  }, null, 2)}\n`)
  f.run()
  assert.equal(decisionOf(f, 'D-0003').result.ok, true, JSON.stringify(decisionOf(f, 'D-0003').result))
  assert.equal(f.git('rev-list', '--count', 'main..fix/x'), '0')
  assert.equal(f.git('rev-list', '--count', 'fix/x^..fix/x'), '1')
  assert.equal(f.git('rev-parse', 'HEAD^2'), f.git('rev-parse', 'fix/x'))
})

test('切回主分支后中断：下一轮不再提交，合并已有提交', t => {
  const f = exitScenario(t)
  f.git('switch', '-qc', 'fix/x')
  writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
  f.git('commit', '-qm', '提交说明', '--', 'README.md')
  const c1 = f.git('rev-parse', 'HEAD')
  f.git('switch', '-q', 'main')
  writeExitRecord(f, { exit: { 'commit-merge': { branch: 'fix/x', commit: c1 } } })
  answeredCommit(f, { extra: { contentDigest: { 'README.md': f.git('rev-parse', `${c1}:README.md`) } } })
  f.run()
  assert.equal(decisionOf(f, 'D-0001').result.ok, true, JSON.stringify(decisionOf(f, 'D-0001').result))
  assert.equal(f.git('rev-parse', 'fix/x'), c1)
  assert.equal(f.git('rev-parse', 'HEAD^2'), c1)
})

// ---------------------------------------------------------------------------
// 安装脚本（add-autopilot-loop Slice 08，Seam：install.mjs）
// ---------------------------------------------------------------------------

const install = fileURLToPath(new URL('../skills/openspec-autopilot/scripts/install.mjs', import.meta.url))

/** 在临时 HOME 下运行 install.mjs。 */
function installScenario(t) {
  const home = mkdtempSync(join(tmpdir(), 'autopilot-install-home-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const autopilotHome = join(home, '.openspec-autopilot')
  const run = (args = []) => {
    const result = spawnSync(process.execPath, [install, ...args], {
      encoding: 'utf8', env: { ...process.env, HOME: home, OPENSPEC_AUTOPILOT_HOME: autopilotHome },
    })
    return { code: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr }
  }
  const agents = join(home, 'Library', 'LaunchAgents')
  return { home, autopilotHome, agents, run }
}

test('install 默认只打印三个目标路径，不写文件', t => {
  const f = installScenario(t)
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  for (const target of [join(f.autopilotHome, 'config.json'),
    join(f.agents, 'com.openspec.autopilot.scheduler.plist'), join(f.agents, 'com.openspec.autopilot.bridge.plist')]) {
    assert.ok(result.out.includes(target), `${target}：${result.out}`)
    assert.equal(existsSync(target), false, `默认不该写出 ${target}`)
  }
  assert.ok(result.out.includes('launchctl bootstrap') && result.out.includes('launchctl bootout'), result.out)
})

test('install --write 不覆盖已有配置，两个 launchd 文件照常写出', t => {
  const f = installScenario(t)
  mkdirSync(f.autopilotHome, { recursive: true })
  writeFileSync(join(f.autopilotHome, 'config.json'), '{"ownerOpenId":"ou_keep"}\n')
  const result = f.run(['--write'])
  assert.equal(result.code, 0, result.all)
  assert.equal(readFileSync(join(f.autopilotHome, 'config.json'), 'utf8'), '{"ownerOpenId":"ou_keep"}\n')
  assert.ok(existsSync(join(f.agents, 'com.openspec.autopilot.scheduler.plist')))
  assert.ok(existsSync(join(f.agents, 'com.openspec.autopilot.bridge.plist')))
})

test('launchd 文件写出 node 绝对路径与 PATH，托管目录与配置按权限写入', t => {
  const f = installScenario(t)
  const result = f.run(['--write'])
  assert.equal(result.code, 0, result.all)
  for (const name of ['scheduler', 'bridge']) {
    const plist = readFileSync(join(f.agents, `com.openspec.autopilot.${name}.plist`), 'utf8')
    const args = [...plist.split('<key>ProgramArguments</key>')[1].split('</array>')[0].matchAll(/<string>([^<]*)<\/string>/g)].map(m => m[1])
    assert.equal(args[0], process.execPath, plist)
    assert.ok(args[1].endsWith(`${name}.mjs`), plist)
    const pathValue = plist.split('<key>PATH</key>')[1].match(/<string>([^<]*)<\/string>/)[1]
    assert.ok(pathValue.split(':').includes(dirname(process.execPath)), pathValue)
    assert.ok(pathValue.endsWith('/usr/bin:/bin:/usr/sbin:/sbin'), pathValue)
  }
  assert.ok(readFileSync(join(f.agents, 'com.openspec.autopilot.bridge.plist'), 'utf8').includes('<key>ThrottleInterval</key>'))
  assert.equal(statSync(f.autopilotHome).mode & 0o777, 0o700)
  assert.equal(statSync(join(f.autopilotHome, 'config.json')).mode & 0o777, 0o600)
})
