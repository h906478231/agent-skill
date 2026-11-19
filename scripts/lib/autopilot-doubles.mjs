/**
 * 托管相关脚本的测试替身与用例脚手架（add-autopilot-loop design「测试 Seam 决策」）。
 *
 * 所属：仓库测试脚本。调用方：scripts/test-autopilot.mjs 的各用例脚手架。
 * 用途：临时目录与临时 git 仓库、托管配置、变更目录文件，以及代替 `progress.mjs`、`claude` 与 `lark-cli` 的替身。
 *   - progress 替身：原样输出视图文件的内容，用例改写视图文件即可改变进度视图。
 *   - claude 替身：记录参数与环境变量，按替身目录中的文件模拟运行副作用、睡眠与输出。
 *     调度脚本只给 claude 传 6 个环境变量（design D4），替身的控制项因此放在替身目录的文件中，不放在环境变量中。
 *   - lark-cli 替身：记录参数与 `--content` 文件内容；`event` 子命令输出就绪行与事件序列。
 * 替身与配置只有这一份，各脚手架组合调用，配置字段与替身行为只改一处（quality R1 STD-06）。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** claude 替身没有预设输出时的缺省输出：正常结束的一轮运行。 */
const DEFAULT_CLAUDE_OUTPUT = { session_id: 'sess-1', stop_reason: 'end_turn', result: 'done' }

/**
 * 建一个临时目录，用例结束时删除。
 * @param {object} t node:test 的用例上下文。
 * @param {string} prefix 目录名前缀。
 * @returns {string} 目录的绝对路径。
 */
export function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 在目录中初始化 git 仓库并提交一个 README.md。
 * @param {string} repo 仓库目录。
 * @param {object} options branch 为初始分支；userName 为 null 时不设置仓库的用户名（初始提交仍带用户名）。
 * @returns {Function} git(...args)：在仓库中运行 git，退出码不为 0 时断言失败，返回去掉首尾空白的标准输出。
 */
export function initRepo(repo, { branch = 'main', userName = 'tigger' } = {}) {
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' })
    assert.equal(result.status, 0, `${args.join(' ')}：${result.stderr}`)
    return result.stdout.trim()
  }
  git('init', '-q', '-b', branch)
  if (userName) {
    git('config', 'user.name', userName)
    git('config', 'user.email', `${userName}@example.com`)
  }
  writeFileSync(join(repo, 'README.md'), '# demo\n')
  git('add', '-A')
  git('-c', 'user.name=tester', '-c', 'user.email=tester@example.com', 'commit', '-qm', 'init')
  return git
}

/**
 * 按相对路径写文件：字符串原样写入，其他值写成缩进的 JSON。
 * @param {string} dir 基准目录。
 * @param {Record<string, unknown>} files 相对路径 → 内容。
 */
export function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  }
}

/**
 * 托管配置中的一个项目。
 * @param {string} root 项目根。
 * @param {object} overrides 覆盖的字段。
 * @returns {object} 项目配置。
 */
export function projectOf(root, overrides = {}) {
  return { root, allowedCommands: ['Bash(node:*)'], baseBranch: 'main', branchPrefix: 'fix/', ...overrides }
}

/**
 * 写托管配置 `config.json`：缺省字段与 design D3「配置」一致，用例只写要改的字段。
 * @param {string} home 托管目录。
 * @param {object} fields 覆盖的字段，通常含 progressBin 与 projects。
 * @returns {object} 写入的完整配置。
 */
export function writeConfig(home, fields = {}) {
  const config = {
    ownerOpenId: 'ou_owner',
    model: 'claude-sonnet-5-5',
    maxBudgetUsd: 1,
    intervalSeconds: 300,
    cancelWaitSeconds: 30,
    claudeBin: 'claude',
    larkBin: 'lark-cli',
    ...fields,
  }
  writeFileSync(join(home, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
  return config
}

/**
 * 写出进度视图替身。
 * @param {string} dir 替身目录。
 * @param {object} view 初始进度视图。
 * @returns {{ viewFile: string, progressBin: string }} 视图文件与替身的路径。
 */
export function progressDouble(dir, view) {
  const viewFile = join(dir, 'progress-output.json')
  writeFileSync(viewFile, JSON.stringify(view))
  const progressBin = join(dir, 'progress-double.mjs')
  writeFileSync(progressBin, `import { readFileSync } from 'node:fs'\n`
    + `process.stdout.write(readFileSync(${JSON.stringify(viewFile)}, 'utf8'))\n`)
  return { viewFile, progressBin }
}

/**
 * 写一个用 sh 包装的可执行入口：替身实现是 .mjs，入口让调度脚本能按命令名直接执行。
 * @param {string} bin 入口路径。
 * @param {string} impl 替身实现的路径。
 */
function writeWrapper(bin, impl) {
  writeFileSync(bin, `#!/bin/sh\nexec node ${JSON.stringify(impl)} "$@"\n`)
  chmodSync(bin, 0o755)
}

/**
 * 读取 JSON 行日志。
 * @param {string} file 日志文件。
 * @returns {object[]} 每行一个对象；文件不存在时为空数组。
 */
export function readJsonLines(file) {
  return existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
}

/**
 * 设置 claude 替身的输出：之后每次调用都输出这一项（字符串原样输出，其他值输出 JSON）。
 * @param {string} dir claude 替身所在目录。
 * @param {unknown} output 输出。
 */
export function setClaudeOutput(dir, output) {
  writeFileSync(join(dir, 'claude-output.json'), `${JSON.stringify(output)}\n`)
}

/**
 * 写出 claude 替身。替身目录中的控制文件：
 *   - claude-output.json：输出（见 setClaudeOutput），没有时输出 DEFAULT_CLAUDE_OUTPUT；
 *   - effect.json：`[{ file, content }]`，运行时写这些文件，模拟 agent 的改动；
 *   - sleep.json：睡眠秒数，睡眠期间收到 SIGTERM 时记录到 claude-signals.log 后退出。
 * 环境变量 AUTOPILOT_TEST_SLEEP 也表示睡眠秒数，只在替身直接继承调用方环境时生效。
 * @param {string} dir 替身目录。
 * @param {object} options output 为初始输出，不传时不写 claude-output.json。
 * @returns {{ claudeBin: string, claudeCalls: Function, claudeSignals: Function }} 入口路径、调用记录与信号记录。
 */
export function claudeDouble(dir, { output } = {}) {
  const log = join(dir, 'claude.log')
  const signals = join(dir, 'claude-signals.log')
  const impl = join(dir, 'claude.mjs')
  writeFileSync(impl, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
const dir = ${JSON.stringify(dir)}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, pid: process.pid }) + '\\n')
const effectFile = dir + '/effect.json'
if (existsSync(effectFile)) {
  for (const item of JSON.parse(readFileSync(effectFile, 'utf8'))) writeFileSync(item.file, item.content)
}
const sleepFile = dir + '/sleep.json'
const sleep = existsSync(sleepFile) ? Number(readFileSync(sleepFile, 'utf8')) : Number(process.env.AUTOPILOT_TEST_SLEEP || 0)
if (sleep > 0) {
  // 用定时器等待而不是忙等：忙等时进程处理不了信号，撤回的测试观察不到 SIGTERM。
  process.on('SIGTERM', () => {
    appendFileSync(${JSON.stringify(signals)}, JSON.stringify({ signal: 'SIGTERM', pid: process.pid }) + '\\n')
    process.exit(143)
  })
  await new Promise(resolve => setTimeout(resolve, sleep * 1000))
}
const outputFile = dir + '/claude-output.json'
const output = existsSync(outputFile) ? JSON.parse(readFileSync(outputFile, 'utf8')) : ${JSON.stringify(DEFAULT_CLAUDE_OUTPUT)}
process.stdout.write(typeof output === 'string' ? output : JSON.stringify(output))
`)
  const claudeBin = join(dir, 'claude')
  writeWrapper(claudeBin, impl)
  if (output !== undefined) setClaudeOutput(dir, output)
  return { claudeBin, claudeCalls: () => readJsonLines(log), claudeSignals: () => readJsonLines(signals) }
}

/**
 * 写出 lark-cli 替身：记录参数与 `--content` 指向的文件内容。
 * `event` 子命令输出就绪行与 events 中的事件后退出；其他子命令输出 `{ message_id, code: 0 }`。
 * @param {string} dir 替身目录。
 * @param {object} options messageId 为发送结果中的消息编号；events 为事件序列。
 * @returns {{ larkBin: string, larkCalls: Function }} 入口路径与调用记录。
 */
export function larkDouble(dir, { messageId = 'om_test', events = [] } = {}) {
  const log = join(dir, 'lark.log')
  const impl = join(dir, 'lark-cli.mjs')
  writeFileSync(impl, `import { appendFileSync, existsSync, readFileSync } from 'node:fs'
const args = process.argv.slice(2)
let content = null
const at = args.indexOf('--content')
if (at >= 0 && args[at + 1]) {
  const file = args[at + 1].replace(/^@/, '')
  if (existsSync(file)) content = readFileSync(file, 'utf8')
}
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, content }) + '\\n')
if (args[0] === 'event') {
  process.stdout.write('[event] ready\\n')
  for (const event of ${JSON.stringify(events)}) process.stdout.write(JSON.stringify(event) + '\\n')
  process.exit(0)
}
process.stdout.write(JSON.stringify({ message_id: ${JSON.stringify(messageId)}, code: 0 }))
`)
  const larkBin = join(dir, 'lark-cli')
  writeWrapper(larkBin, impl)
  return { larkBin, larkCalls: () => readJsonLines(log) }
}
