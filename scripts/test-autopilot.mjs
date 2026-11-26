import { test } from './lib/test-shard.mjs'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, chmodSync, utimesSync, truncateSync, symlinkSync, realpathSync, renameSync, statSync } from 'node:fs'
import { tmpdir, uptime } from 'node:os'
import { join, dirname, delimiter, resolve as resolvePath, sep as pathSep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import {
  tempDir, initRepo, writeFiles, projectOf, writeConfig, progressDouble, claudeDouble, larkDouble, setClaudeOutput,
  launchdDouble, LAUNCHD_LABELS, readJsonLines,
} from './lib/autopilot-doubles.mjs'
import { GATE_TRACE_SAMPLES, STANDARD_TRACE_REPORT } from './lib/gate-trace-samples.mjs'
import { snapshot } from './lib/fs-snapshot.mjs'
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
  // 进度视图替身：输出用例写入的进度视图文件。托管入口只运行可信安装根中的进度脚本（add-change-pause design D2），
  // 替身因此放在临时安装根的约定位置，并登记到 trustedSkillRoots。
  const { root: skillRoot, progressBin } = admissionProgress(home, { ...progress, root: repo })
  writeConfig(home, { progressBin, trustedSkillRoots: [skillRoot], projects: [projectOf(repo)] })
  // 托管准入查询当前用户域已加载的服务（design D4）：用例只看到 launchctl 替身，不接触本机真实服务。
  const launchd = launchdDouble(home, home)
  const changeDir = join(repo, 'openspec', 'changes', 'demo')
  mkdirSync(changeDir, { recursive: true })
  writeFiles(changeDir, files)

  const run = (args, env = {}) => {
    const result = spawnSync(process.execPath, [autopilot, ...args], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: home, PATH: `${launchd.bin}${delimiter}${process.env.PATH}`, ...env },
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
  return { repo, home, changeDir, run, record, decision, git, launchd }
}

/**
 * 写出准入用的进度视图替身：放在临时安装根中 `openspec-change-progress` 的约定位置，输出用例写入的视图文件。
 * 条目没有写 `changeState` 或 `changeDirectory` 时，替身用托管入口传来的已核验门禁 `state` 子命令补齐，
 * 顶层没有写 `changeStateVersion` 时补为 1，与实际进度视图一样只复制门禁的读取结果（add-change-pause design D2、D4）。
 * 视图写 `raw: true` 时原样输出（去掉该标记），用于构造旧副本或缺字段的进度视图。
 * @param {string} home 托管目录，安装根为其下的 skills/。
 * @param {object} progress 初始进度视图。
 * @returns {{ root: string, progressBin: string, viewFile: string }} 安装根、替身与视图文件。
 */
function admissionProgress(home, progress) {
  const root = join(home, 'skills')
  const progressBin = join(root, 'openspec-change-progress/scripts/progress.mjs')
  const viewFile = join(home, 'progress-output.json')
  mkdirSync(dirname(progressBin), { recursive: true })
  writeFileSync(viewFile, JSON.stringify(progress))
  writeFileSync(progressBin, `import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
const view = JSON.parse(readFileSync(${JSON.stringify(viewFile)}, 'utf8'))
const raw = view.raw === true
delete view.raw
const at = process.argv.indexOf('--gate')
if (!raw && at > 0) {
  for (const item of view.active || []) {
    if ('changeState' in item && 'changeDirectory' in item) continue
    const target = path.join(process.cwd(), 'openspec', 'changes', item.change)
    const read = spawnSync(process.execPath, [process.argv[at + 1], 'state', target, '--repo', process.cwd()], { encoding: 'utf8' })
    const value = JSON.parse(read.stdout)
    if (!('changeState' in item)) item.changeState = value.changeState
    if (!('changeDirectory' in item)) item.changeDirectory = value.changeDirectory
  }
  if (!('changeStateVersion' in view)) view.changeStateVersion = 1
}
process.stdout.write(JSON.stringify(view))
`)
  return { root, progressBin, viewFile }
}

/** 通过临时安装根运行实际门禁。只有模拟进度或并发替身才能替换脚本。 */
function pauseScenario(t, options) {
  const f = scenario(t, options)
  const root = join(f.home, 'skills')
  const localGate = join(root, 'openspec-technical-review/scripts/implementation-gate.mjs')
  const progressBin = join(root, 'openspec-change-progress/scripts/progress.mjs')
  const configFile = join(f.home, 'config.json')
  const previous = JSON.parse(readFileSync(configFile, 'utf8'))
  writeFiles(root, {
    'openspec-technical-review/scripts/implementation-gate.mjs': readFileSync(gateBin, 'utf8'),
    'openspec-change-progress/scripts/progress.mjs': readFileSync(previous.progressBin, 'utf8'),
  })
  const config = writeConfig(f.home, { ...previous, progressBin, gateBin: localGate, trustedSkillRoots: [root] })
  // 恢复后刷新的条目须带原目录实例（add-change-pause design D3 第 3 步，评审 DB-05）：替身输出的 demo 条目补上它。
  const viewFile = join(f.home, 'progress-output.json')
  const output = JSON.parse(readFileSync(viewFile, 'utf8'))
  for (const item of output.active) if (item.change === 'demo' && !('changeDirectory' in item)) item.changeDirectory = directoryIdentity(f.changeDir)
  writeFileSync(viewFile, JSON.stringify(output))
  return { ...f, config, localGate, progressBin, viewFile, stateFile: join(f.changeDir, 'change-state.json') }
}

/** 目录实例的身份，格式与门禁 facts 的 changeDirectory 相同。 */
function directoryIdentity(directory) {
  const stat = statSync(directory, { bigint: true })
  return { path: realpathSync.native(directory), dev: String(stat.dev), ino: String(stat.ino) }
}

const PAUSE_ARGS = ['pause', 'demo', '--reason', '保留已有工作']
const PAUSE_VALUE = { version: 1, state: 'paused', reason: PAUSE_ARGS[3], updatedAt: '2026-11-23T08:00:00.000Z' }

/**
 * 无效的状态文件（add-change-pause design D1，任务 3.1）：门禁都读成 unknown，不能当作已核实的暂缓。
 * 重复成员一项先写 enabled、后写 paused：只按 JSON.parse 的结果读取时会误读为暂缓（评审 DB-15）。
 */
const INVALID_STATES = [
  ['无效 JSON', '{ 损坏'],
  ['未知字段', `${JSON.stringify({ ...PAUSE_VALUE, extra: true })}\n`],
  ['未知版本', `${JSON.stringify({ ...PAUSE_VALUE, version: 2 })}\n`],
  ['超过 16 KiB', `${JSON.stringify(PAUSE_VALUE)}${' '.repeat(16 * 1024)}\n`],
  ['原因超过 1,024 字节', `${JSON.stringify({ ...PAUSE_VALUE, reason: 'x'.repeat(1025) })}\n`],
  ['顶层成员名重复', `${JSON.stringify({ ...PAUSE_VALUE, state: 'enabled' }).slice(0, -1)},"state":"paused"}\n`],
]

test('变更暂缓：没有托管记录时写入推进意愿，同原因重试不改写', t => {
  const f = pauseScenario(t, { files: { 'tasks.md': '- [x] 已实现的任务\n' } })
  const result = f.run(['pause', 'demo', '--reason', ' 保留已有工作 '])
  assert.equal(result.code, 0, result.all)
  const file = join(f.changeDir, 'change-state.json')
  const before = readFileSync(file, 'utf8')
  const value = JSON.parse(before)
  assert.deepEqual(value, { version: 1, state: 'paused', reason: '保留已有工作', updatedAt: value.updatedAt })
  assert.match(value.updatedAt, /Z$/u)
  const identity = statSync(file).ino
  assert.equal(f.run(['pause', 'demo', '--reason', value.reason]).code, 0)
  assert.equal(statSync(file).ino, identity)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(readFileSync(join(f.changeDir, 'tasks.md'), 'utf8'), '- [x] 已实现的任务\n')
  assert.equal(f.record(), null)
})

test('变更暂缓：恢复保留评审卡点，且不托管；失败的刷新不回滚', t => {
  const f = pauseScenario(t, { progress: view({ active: [entry({ rule: 'R3', stage: 'review', blockers: ['Gate-Verdict: BLOCKED'] })] }) })
  let result = f.run(['resume', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.equal(existsSync(f.stateFile), false)
  assert.equal(f.run(PAUSE_ARGS).code, 0)
  result = f.run(['resume', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.match(result.out, /R3.*BLOCKED/)
  const value = JSON.parse(readFileSync(f.stateFile))
  assert.deepEqual(value, { ...PAUSE_VALUE, state: 'enabled', reason: '用户恢复推进', updatedAt: value.updatedAt })
  assert.equal(f.record(), null)
  assert.equal(f.run(PAUSE_ARGS).code, 0)
  writeFileSync(f.progressBin, 'process.exitCode = 2\n')
  result = f.run(['resume', 'demo'])
  assert.equal(result.code, 2, result.all)
  assert.match(result.err, /已恢复.*读取当前进度失败/)
  assert.equal(JSON.parse(readFileSync(f.stateFile)).state, 'enabled')
})

test('变更暂缓：拒绝原因超限、非普通文件和归档托管占用', t => {
  const f = pauseScenario(t)
  assert.equal(f.run(['pause', 'demo', '--reason', '']).code, 2)
  assert.equal(f.run(['pause', 'demo', '--reason', '秒'.repeat(342)]).code, 2)
  assert.equal(existsSync(f.stateFile), false)
  writeFileSync(join(f.changeDir, 'other.json'), JSON.stringify(PAUSE_VALUE))
  symlinkSync('other.json', f.stateFile)
  assert.equal(f.run(PAUSE_ARGS).code, 2)
  rmSync(f.stateFile)
  mkdirSync(f.stateFile)
  assert.equal(f.run(PAUSE_ARGS).code, 2)
  rmSync(f.stateFile, { recursive: true })
  writeFiles(join(f.repo, 'openspec/changes/archive/2026-11-23-other'), { 'decisions/autopilot.json': managedRecord({ status: 'exiting' }) })
  const occupied = f.run(PAUSE_ARGS)
  assert.equal(occupied.code, 1, occupied.all)
  assert.match(occupied.err, /2026-11-23-other.*仍在托管/)
  assert.equal(existsSync(f.stateFile), false)
})

test('变更暂缓：残留只清理目标普通临时文件，目录数超限时不清理', t => {
  const f = pauseScenario(t)
  const temp = name => join(f.changeDir, `change-state.json.tmp.23.${name}bcdef12-0000-4000-8000-400000000000`)
  writeFileSync(temp('a'), '')
  symlinkSync(temp('a'), temp('b'))
  mkdirSync(temp('c'))
  const archive = join(f.repo, 'openspec/changes/archive')
  mkdirSync(archive)
  for (let i = 0; i < 1_023; i++) writeFileSync(join(archive, `item-${i}`), '')
  const limited = f.run(PAUSE_ARGS)
  assert.equal(limited.code, 1, limited.all)
  assert.match(limited.err, /已检查 1024 个条目/)
  assert.equal(existsSync(f.stateFile), false)
  assert.equal(existsSync(temp('a')), true)
  rmSync(join(archive, 'item-0'))
  const written = f.run(PAUSE_ARGS)
  assert.equal(written.code, 0, written.all)
  assert.equal(existsSync(temp('a')), false)
  assert.ok(readdirSync(f.changeDir).includes(temp('b').slice(f.changeDir.length + 1)))
  assert.equal(statSync(temp('c')).isDirectory(), true)
})

test('变更暂缓：在调用门禁前拒绝未经登记的脚本来源', t => {
  const f = pauseScenario(t)
  const unregistered = join(f.home, 'other/openspec-technical-review/scripts/implementation-gate.mjs')
  const marker = join(f.home, 'ran')
  writeFiles(dirname(unregistered), { 'implementation-gate.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, '跑过')\n` })
  writeConfig(f.home, { ...f.config, gateBin: unregistered })
  const failed = f.run(PAUSE_ARGS)
  assert.equal(failed.code, 2, failed.all)
  assert.match(failed.err, /安装来源无法核验/)
  assert.equal(existsSync(marker), false)
  assert.equal(existsSync(f.stateFile), false)
})

test('变更暂缓：首次定位后或快照返回前迁移目录，不写同名替代目录', async t => {
  for (const beforeFacts of [true, false]) {
    await t.test(beforeFacts ? '快照之前退出 2' : '快照之后退出 1', sub => {
      const f = pauseScenario(sub)
      const original = `${f.changeDir}-moved`
      const residue = 'change-state.json.tmp.23.abcdef12-0000-4000-8000-400000000000'
      writeFileSync(join(f.changeDir, residue), '原目录临时文件')
      const switchDirectory = `renameSync(${JSON.stringify(f.changeDir)}, ${JSON.stringify(original)})\n`
        + `mkdirSync(${JSON.stringify(f.changeDir)})\n`
        + `writeFileSync(${JSON.stringify(join(f.changeDir, residue))}, '新目录临时文件')\n`
      writeFileSync(f.localGate, `import { renameSync, mkdirSync, writeFileSync } from 'node:fs'\n`
        + `import { spawnSync } from 'node:child_process'\n`
        + (beforeFacts ? switchDirectory : '')
        + `const result = spawnSync(process.execPath, [${JSON.stringify(gateBin)}, ...process.argv.slice(2)])\n`
        + (beforeFacts ? '' : switchDirectory)
        + `process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status\n`)
      const result = f.run(PAUSE_ARGS)
      assert.equal(result.code, beforeFacts ? 2 : 1, result.all)
      assert.equal(readFileSync(join(original, residue), 'utf8'), '原目录临时文件')
      assert.equal(readFileSync(join(f.changeDir, residue), 'utf8'), '新目录临时文件')
      assert.equal(existsSync(f.stateFile), false)
      assert.equal(existsSync(join(original, 'change-state.json')), false)
      if (beforeFacts) assert.equal(existsSync(join(f.home, 'project-locks')), false)
    })
  }
})

test('变更暂缓：快照后的状态文件不被原请求覆盖', t => {
  const f = pauseScenario(t)
  const newContents = JSON.stringify({ ...PAUSE_VALUE, reason: '另一次状态写入' })
  writeFileSync(f.localGate, `import { writeFileSync } from 'node:fs'\n`
    + `import { spawnSync } from 'node:child_process'\n`
    + `const result = spawnSync(process.execPath, [${JSON.stringify(gateBin)}, ...process.argv.slice(2)])\n`
    + `writeFileSync(${JSON.stringify(f.stateFile)}, ${JSON.stringify(newContents)})\n`
    + `process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status\n`)
  const result = f.run(PAUSE_ARGS)
  assert.equal(result.code, 1, result.all)
  assert.match(result.all, /状态文件在读取后已修改/)
  assert.equal(readFileSync(f.stateFile, 'utf8'), newContents)
})

test('变更暂缓：原子替换前已耗尽保护时间时保留状态并清理本次临时文件', t => {
  const f = pauseScenario(t, { files: { 'change-state.json': PAUSE_VALUE } })
  const before = readFileSync(f.stateFile)
  const clock = join(f.home, 'state-clock.cjs')
  writeFileSync(clock, `if (process.argv[1]?.endsWith('/autopilot.mjs')) {
  const fs = require('node:fs')
  const { performance } = require('node:perf_hooks')
  const open = fs.openSync
  const write = fs.writeFileSync
  let temporaryFd
  let prepared = false
  Object.defineProperty(performance, 'now', { value: () => prepared ? 2001 : 0 })
  fs.openSync = (file, ...args) => {
    const fd = open(file, ...args)
    if (String(file).startsWith('change-state.json.tmp.')) temporaryFd = fd
    return fd
  }
  fs.writeFileSync = (file, ...args) => {
    const result = write(file, ...args)
    if (file === temporaryFd) prepared = true
    return result
  }
  require('node:module').syncBuiltinESMExports()
}\n`)
  const result = f.run(['pause', 'demo', '--reason', '不同原因'], { NODE_OPTIONS: `--require ${clock}` })
  assert.equal(result.code, 1, result.all)
  assert.match(result.all, /核验时间已用完/)
  assert.deepEqual(readFileSync(f.stateFile), before)
  assert.equal(readdirSync(f.changeDir).some(name => name.startsWith('change-state.json.tmp.')), false)
})

test('变更暂缓：拒绝跨项目同名且不改写任一变更', t => {
  const f = pauseScenario(t)
  const other = scenario(t)
  writeConfig(f.home, { ...f.config, projects: [projectOf(f.repo), projectOf(other.repo)] })
  const result = f.run(PAUSE_ARGS)
  assert.equal(result.code, 2, result.all)
  assert.match(result.all, /多个项目存在活跃变更/)
  assert.ok(result.all.includes(f.repo) && result.all.includes(other.repo))
  assert.equal(existsSync(f.stateFile), false)
  assert.equal(existsSync(join(other.changeDir, 'change-state.json')), false)
})

test('变更暂缓：读出撤回记录后仍受运行者核验和同一个项目截止时间约束', t => {
  const f = pauseScenario(t, { files: { 'decisions/autopilot.json': managedRecord({ status: 'void' }) } })
  let lock = { pid: process.pid, projectRoot: realpathSync.native(f.repo), change: 'demo',
    startedAt: f.record().startedAt, runId: 'test-run', claudePid: process.pid }
  writeFileSync(join(f.home, 'run.lock'), JSON.stringify(lock))
  let result = f.run(PAUSE_ARGS)
  // 锁缺 bootTime 时不论进程是否存活都按无法核验拒绝（add-change-pause design D0，评审 DB-12）。
  assert.equal(result.code, 1, result.all)
  assert.match(result.all, /阶段仍在运行或无法核验/)
  assert.equal(existsSync(f.stateFile), false)
  if (process.platform !== 'darwin') return
  const marker = join(f.home, 'probe-timeout.json')
  const probe = join(f.home, 'state-probe.cjs')
  // 锁进程已退出、只剩已发布的写者时，存活与否须经写者探测确认，探测受同一个项目截止时间约束。
  const exited = spawnSync(process.execPath, ['-e', '']).pid
  const { claudePid, ...bound } = lock
  lock = { ...bound, pid: exited, bootTime: Math.round(Date.now() / 1000 - uptime()),
    writer: { state: 'published', pid: process.pid, bootId: 'test-boot', instance: 'test-instance' } }
  writeFileSync(join(f.home, 'run.lock'), JSON.stringify(lock))
  writeFileSync(probe, `if (process.argv[1]?.endsWith('/autopilot.mjs')) {
  const fs = require('node:fs')
  const cp = require('node:child_process')
  const { performance } = require('node:perf_hooks')
  let calls = 0
  let protectedClock = false
  const open = fs.opendirSync
  fs.opendirSync = (dir, ...args) => {
    if (String(dir).endsWith('/openspec/changes')) protectedClock = true
    return open(dir, ...args)
  }
  const spawn = cp.spawnSync
  // 取得保护后才前进到 1,650 ms，剩余的 350 ms 应限制下一次进程探测。
  Object.defineProperty(performance, 'now', { value: () => protectedClock ? 1650 : 0 })
  cp.spawnSync = (command, args, options) => {
    if (command === '/bin/ps' || command === '/usr/sbin/sysctl') {
      calls++
      if (calls === 3) {
        fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(options.timeout))
        return { status: null, stdout: '', error: { code: 'ETIMEDOUT' } }
      }
    }
    return spawn(command, args, options)
  }
  require('node:module').syncBuiltinESMExports()
}\n`)
  result = f.run(PAUSE_ARGS, { NODE_OPTIONS: `--require ${probe}` })
  assert.equal(result.code, 1, result.all)
  assert.equal(JSON.parse(readFileSync(marker, 'utf8')), 350)
  assert.equal(existsSync(f.stateFile), false)
})

test('变更暂缓：恢复后刷新到同名新目录或条目缺少目录身份时退出 2，不显示新目录的进度，不回滚', async t => {
  await t.test('刷新前原目录归档并出现同名新目录', sub => {
    const f = pauseScenario(sub, { files: { 'change-state.json': PAUSE_VALUE } })
    const archived = join(f.repo, 'openspec/changes/archive/2026-11-24-demo')
    const output = { root: f.repo, active: [entry({ next: '新目录的下一步' })], implementing: [], archived: [] }
    writeFileSync(f.progressBin, `import { mkdirSync, renameSync, realpathSync, statSync } from 'node:fs'\n`
      + `mkdirSync(${JSON.stringify(dirname(archived))}, { recursive: true })\n`
      + `renameSync(${JSON.stringify(f.changeDir)}, ${JSON.stringify(archived)})\n`
      + `mkdirSync(${JSON.stringify(f.changeDir)})\n`
      + `const stat = statSync(${JSON.stringify(f.changeDir)}, { bigint: true })\n`
      + `const view = ${JSON.stringify(output)}\n`
      + `view.active[0].changeDirectory = { path: realpathSync.native(${JSON.stringify(f.changeDir)}), dev: String(stat.dev), ino: String(stat.ino) }\n`
      + `process.stdout.write(JSON.stringify(view))\n`)
    const result = f.run(['resume', 'demo'])
    assert.equal(result.code, 2, result.all)
    assert.match(result.err, /已恢复 demo 的推进意愿.*刷新到的进度条目不是原变更目录/)
    assert.ok(!result.all.includes('新目录的下一步'), result.all)
    assert.equal(JSON.parse(readFileSync(join(archived, 'change-state.json'))).state, 'enabled')
    assert.equal(existsSync(f.stateFile), false)
  })
  await t.test('条目缺少目录身份', sub => {
    const f = pauseScenario(sub, { files: { 'change-state.json': PAUSE_VALUE } })
    // raw 让进度替身原样输出，不经门禁补齐目录身份。
    writeFileSync(f.viewFile, JSON.stringify({ ...view(), raw: true }))
    const result = f.run(['resume', 'demo'])
    assert.equal(result.code, 2, result.all)
    assert.match(result.err, /刷新到的进度条目不是原变更目录/)
    assert.equal(JSON.parse(readFileSync(f.stateFile)).state, 'enabled')
  })
})

test('变更暂缓：残留清理失败不阻止写入，但不能把替换失败报告为成功', t => {
  const f = pauseScenario(t)
  const residue = 'change-state.json.tmp.23.abcdef12-0000-4000-8000-400000000000'
  writeFileSync(join(f.changeDir, residue), '残留')
  const faults = join(f.home, 'state-io.cjs')
  writeFileSync(faults, `if (process.argv[1]?.endsWith('/autopilot.mjs')) {
  const fs = require('node:fs')
  const unlink = fs.unlinkSync
  const rename = fs.renameSync
  const refused = () => Object.assign(new Error('测试 I/O 失败'), { code: 'EACCES' })
  fs.unlinkSync = (file, ...args) => {
    if (file === ${JSON.stringify(residue)}) throw refused()
    return unlink(file, ...args)
  }
  fs.renameSync = (from, to) => {
    if (to === 'change-state.json' && process.env.TEST_REPLACE_ERROR) throw refused()
    return rename(from, to)
  }
  require('node:module').syncBuiltinESMExports()
}\n`)
  const env = { NODE_OPTIONS: `--require ${faults}` }
  const first = f.run(PAUSE_ARGS, env)
  assert.equal(first.code, 0, first.all)
  assert.equal(readFileSync(join(f.changeDir, residue), 'utf8'), '残留')
  const before = readFileSync(f.stateFile)
  const second = f.run(['pause', 'demo', '--reason', '不同原因'], { ...env, TEST_REPLACE_ERROR: '1' })
  assert.equal(second.code, 2, second.all)
  assert.match(second.err, /测试 I\/O 失败/)
  assert.deepEqual(readFileSync(f.stateFile), before)
  assert.equal(readdirSync(f.changeDir).filter(name => name.startsWith('change-state.json.tmp.')).length, 1)
})

/** 对象库中的松散对象与打包对象合计；用于证明状态查询没有写入 Git 对象。 */
function objectCount(git) {
  const stats = Object.fromEntries(git('count-objects', '-v').split('\n').map(line => line.split(': ')))
  return Number(stats.count) + Number(stats['in-pack'])
}

/** 让临时安装根的门禁先运行 before 中的语句，再转交实际门禁；返回读取调用参数的函数。 */
function wrapGate(f, before = '') {
  const calls = join(f.home, 'gate-calls')
  writeFileSync(f.localGate, `import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'\n`
    + `import { spawnSync } from 'node:child_process'\n`
    + `appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(' ') + '\\n')\n`
    + before
    + `const result = spawnSync(process.execPath, [${JSON.stringify(gateBin)}, ...process.argv.slice(2)])\n`
    + `process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exitCode = result.status\n`)
  return () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [])
}

test('状态查询：未托管的暂缓变更显示原因与未托管，不写文件或 Git 对象', t => {
  const f = pauseScenario(t, { files: { 'change-state.json': { ...PAUSE_VALUE, reason: '保留|已有\n工作' } } })
  writeFileSync(join(f.repo, 'unrecorded.txt'), '未入库的修改\n')
  const calls = wrapGate(f)
  const files = snapshot(f.changeDir)
  const objects = objectCount(f.git)
  const result = f.run(['status', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.match(result.out, /变更状态：paused/)
  assert.ok(result.out.includes('状态原因：保留\\|已有\\n工作'), result.out)
  assert.match(result.out, /托管记录：未托管/)
  const directory = realpathSync.native(f.changeDir)
  assert.deepEqual(calls(), [`state ${directory} --repo ${realpathSync.native(f.repo)}`])
  assert.equal(objectCount(f.git), objects)
  assert.deepEqual(snapshot(f.changeDir), files)
})

test('状态查询（STD-05）：无候选退出 1，记录不可读退出 2', t => {
  const f = pauseScenario(t, { files: { 'decisions/autopilot.json': '{' } })
  const missing = f.run(['status', 'other'])
  assert.equal(missing.code, 1, missing.all)
  assert.match(missing.all, /没有可查询/)
  const before = snapshot(f.changeDir)
  const broken = f.run(['status', 'demo'])
  assert.equal(broken.code, 2, broken.all)
  assert.match(broken.all, /demo/)
  assert.deepEqual(snapshot(f.changeDir), before)
})

test('状态查询：状态损坏时显示错误与可读的托管信息，退出 2', t => {
  const f = pauseScenario(t, { files: { 'decisions/autopilot.json': managedRecord(), 'change-state.json': '{' } })
  const result = f.run(['status', 'demo'])
  assert.equal(result.code, 2, result.all)
  assert.match(result.all, /变更状态：无法核验（.*change-state\.json/)
  assert.match(result.all, /批次：2026-11-06T10:00:00Z/)
  assert.match(result.all, /阶段运行中：否/)
})

test('状态查询：所选归档批次读取归档目录的状态，不读同名活跃目录', t => {
  const f = pauseScenario(t, { files: { 'change-state.json': { ...PAUSE_VALUE, reason: '活跃目录的原因' } } })
  const archive = join(f.repo, 'openspec/changes/archive/2026-11-19-demo')
  writeFiles(archive, { 'decisions/autopilot.json': managedRecord({ status: 'exiting' }) })
  const result = f.run(['status', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.ok(result.out.includes(realpathSync.native(archive)), result.out)
  assert.match(result.out, /变更状态：enabled/)
  assert.ok(!result.out.includes('活跃目录的原因'), result.out)
})

test('状态查询：门禁来源无法核实时不运行门禁，退出 2，保留本机托管信息', t => {
  const f = pauseScenario(t, { files: { 'decisions/autopilot.json': managedRecord() } })
  const unregistered = join(f.home, 'other/openspec-technical-review/scripts/implementation-gate.mjs')
  const marker = join(f.home, 'ran')
  writeFiles(dirname(unregistered), { 'implementation-gate.mjs': `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, '跑过')\n` })
  writeConfig(f.home, { ...f.config, gateBin: unregistered })
  const result = f.run(['status', 'demo'])
  assert.equal(result.code, 2, result.all)
  assert.match(result.all, /安装来源无法核验/)
  assert.match(result.all, /批次：2026-11-06T10:00:00Z/)
  assert.equal(existsSync(marker), false)
})

test('状态查询：读取状态时原目录换成同名新目录或写入新批次，退出 2', async t => {
  await t.test('原目录换成同名新目录', sub => {
    const f = pauseScenario(sub, { files: { 'decisions/autopilot.json': managedRecord() } })
    wrapGate(f, `renameSync(${JSON.stringify(f.changeDir)}, ${JSON.stringify(`${f.changeDir}-moved`)})\n`
      + `mkdirSync(${JSON.stringify(f.changeDir)})\n`
      + `writeFileSync(${JSON.stringify(f.stateFile)}, ${JSON.stringify(JSON.stringify({ ...PAUSE_VALUE, reason: '新目录的原因' }))})\n`)
    const result = f.run(['status', 'demo'])
    assert.equal(result.code, 2, result.all)
    assert.match(result.all, /批次：2026-11-06T10:00:00Z/)
    assert.ok(!result.all.includes('新目录的原因'), result.all)
    assert.doesNotMatch(result.all, /变更状态：paused/)
  })
  await t.test('选定未托管后写入新批次', sub => {
    const f = pauseScenario(sub)
    const record = join(f.changeDir, 'decisions', 'autopilot.json')
    wrapGate(f, `mkdirSync(${JSON.stringify(dirname(record))})\n`
      + `writeFileSync(${JSON.stringify(record)}, ${JSON.stringify(JSON.stringify(managedRecord()))})\n`)
    const result = f.run(['status', 'demo'])
    assert.equal(result.code, 2, result.all)
    assert.match(result.all, /托管记录已改变/)
    assert.doesNotMatch(result.all, /托管记录：未托管/)
  })
})

test('状态查询：配置检出外共用条目上限，确定唯一候选后只运行一次门禁', t => {
  const f = pauseScenario(t)
  const other = scenario(t)
  rmSync(other.changeDir, { recursive: true })
  const calls = wrapGate(f)
  writeConfig(f.home, { ...f.config, projects: [projectOf(other.repo), projectOf(f.repo)] })
  const outside = tempDir(t, 'autopilot-outside-')
  const run = () => spawnSync(process.execPath, [autopilot, 'status', 'demo'], { encoding: 'utf8', cwd: outside,
    env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: f.home } })
  const found = run()
  assert.equal(found.status, 0, found.stderr)
  assert.match(found.stdout, /托管记录：未托管/)
  assert.equal(calls().length, 1)
  for (const [root, count] of [[other.repo, 600], [f.repo, 500]]) {
    const archive = join(root, 'openspec/changes/archive')
    mkdirSync(archive, { recursive: true })
    for (let i = 0; i < count; i++) writeFileSync(join(archive, `item-${i}`), '')
  }
  const limited = run()
  assert.equal(limited.status, 2, limited.stderr)
  assert.match(limited.stderr, /已完成 1 个项目、600 个条目/)
  assert.match(limited.stderr, /已检查 424 个条目/)
  assert.equal(calls().length, 1)
})

test('状态查询：配置项目根位于另一检出之内时状态未知，退出 2', t => {
  const f = pauseScenario(t)
  const inner = join(f.repo, 'nested')
  mkdirSync(join(inner, 'openspec/changes/demo'), { recursive: true })
  writeConfig(f.home, { ...f.config, projects: [projectOf(inner)] })
  const result = f.run(['status', 'demo'])
  assert.equal(result.code, 2, result.all)
  assert.match(result.all, /变更状态：无法核验（.*不属于选定项目/)
  assert.doesNotMatch(result.all, /变更状态：enabled/)
})

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
  // implementing 中的名称须对应一个可读条目（add-change-pause design D4「准入快照」）。
  const f = scenario(t, {
    progress: view({ active: [entry(), entry({ change: 'other-change', tasks: { done: 1, total: 3 } })], implementing: ['other-change'] }),
  })
  mkdirSync(join(f.repo, 'openspec', 'changes', 'other-change'))
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 1, result.all)
  assert.ok(result.all.includes('other-change'), result.all)
  assert.equal(existsSync(join(f.changeDir, 'decisions')), false)
})

test('同一项目的另一个变更已在托管时拒绝托管', t => {
  // 最终准入复核活跃目录集合与进度快照一致（add-change-pause design D4），另一个变更须在进度视图中。
  const f = scenario(t, { progress: view({ active: [entry(), entry({ change: 'other-change' })] }) })
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
// add-change-pause Slice 02：暂缓的历史变更不阻止其他变更进入托管（Seam S3 start、S4 scheduler）
// ---------------------------------------------------------------------------

/**
 * 准入用例：demo 为目标（R6），ddd 为已开始实现的历史变更（64/109），按需写入 ddd 的状态文件。
 * 条目的 changeState 与 changeDirectory 由进度替身经实际门禁的 state 子命令补齐（add-change-pause design D4）。
 */
function admissionScenario(t, { ddd = PAUSE_VALUE, active = [], implementing = [], files = {} } = {}) {
  const f = scenario(t, {
    progress: view({
      active: [entry(), entry({ change: 'ddd', tasks: { done: 64, total: 109 }, next: '/opsx:apply ddd' }), ...active],
      implementing: ['ddd', ...implementing],
    }),
    files,
  })
  const changes = join(f.repo, 'openspec', 'changes')
  const dddDir = join(changes, 'ddd')
  writeFiles(dddDir, { 'tasks.md': '- [x] 已实现的任务\n', ...(ddd ? { 'change-state.json': ddd } : {}) })
  for (const item of active) mkdirSync(join(changes, item.change), { recursive: true })
  return { ...f, changes, dddDir, viewFile: join(f.home, 'progress-output.json') }
}

const noDecisions = f => assert.equal(existsSync(join(f.changeDir, 'decisions')), false, '不该写出 decisions 目录')

/** 改写 launchctl 替身输出的已加载服务。 */
function editServices(f, edit) {
  const services = f.launchd.services()
  edit(services)
  writeFileSync(f.launchd.servicesFile, JSON.stringify(services))
}

/** 写一份未完成核对文件；条目字段与 lib/pending-trace.mjs 的校验一致。 */
function writePendingTrace(home, entries) {
  const rows = entries.map(item => [JSON.stringify([item.root, item.name, item.startedAt]), item])
  writeFileSync(join(home, 'pending-trace.json'), JSON.stringify({ version: 1, entries: Object.fromEntries(rows) }))
}

/** 一条阶段核对条目，写者缺省为已退出。 */
function stageEntry(f, name, overrides = {}) {
  return {
    root: realpathSync.native(f.repo), name, startedAt: '2026-11-06T10:00:00Z',
    directory: realpathSync.native(join(f.repo, 'openspec', 'changes', name)), location: 'active',
    mode: 'stage', stage: 'apply', runId: 'fixture-run', writer: { state: 'exited' }, traceBefore: { resumedDecisionIds: [] },
    ...overrides,
  }
}

/** 同一检出中一个已撤回的归档批次；exit 为该批次保存的出口结果，mtime 为托管记录的修改时间（秒）。 */
function archivedBatch(f, { name = 'old', status = 'void', exit, mtime } = {}) {
  const dir = join(f.repo, 'openspec', 'changes', 'archive', `2026-11-20-${name}`)
  writeFiles(dir, { 'decisions/autopilot.json': managedRecord({ status, ...(exit === undefined ? {} : { exit }) }) })
  if (mtime !== undefined) utimesSync(join(dir, 'decisions', 'autopilot.json'), mtime, mtime)
  return dir
}

test('准入：暂缓的历史变更不占用托管入口，历史变更的任务与状态不变', t => {
  const f = admissionScenario(t)
  const before = snapshot(f.dddDir)
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.equal(f.record().status, 'active')
  assert.deepEqual(snapshot(f.dddDir), before)
})

test('准入：目标暂缓时退出 1，提示先恢复推进，不创建托管记录', t => {
  const f = scenario(t, { files: { 'change-state.json': PAUSE_VALUE } })
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 1, result.all)
  assert.match(result.all, /demo 已暂缓.*resume/)
  noDecisions(f)
})

test('准入：暂缓不能覆盖另一项未暂缓的实现中变更', t => {
  const f = admissionScenario(t, {
    active: [entry({ change: 'migrate-assets-to-tigger', tasks: { done: 3, total: 9 } })], implementing: ['migrate-assets-to-tigger'],
  })
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 1, result.all)
  assert.match(result.all, /同一检出中这些变更已开始实现：migrate-assets-to-tigger$/m)
  noDecisions(f)
})

test('准入：旧进度契约不能识别暂缓，退出 2 并提示配套同步副本，不写文件', async t => {
  await t.test('进度视图缺少 changeStateVersion', sub => {
    const f = scenario(sub)
    writeFileSync(join(f.home, 'progress-output.json'), JSON.stringify({ ...view({ root: f.repo }), raw: true }))
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 2, result.all)
    assert.match(result.all, /同步/)
    noDecisions(f)
  })
  await t.test('条目没有 changeState', sub => {
    const f = scenario(sub)
    writeFileSync(join(f.home, 'progress-output.json'), JSON.stringify({ ...view({ root: f.repo }), changeStateVersion: 1, raw: true }))
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 2, result.all)
    assert.match(result.all, /demo/)
    noDecisions(f)
  })
})

test('准入：其他活跃变更的状态无法确认或事实读取失败时退出 2，列出该变更，不当作可排除项', async t => {
  await t.test('状态文件损坏', sub => {
    const f = admissionScenario(sub, { ddd: '{ 损坏' })
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 2, result.all)
    assert.match(result.all, /ddd/)
    noDecisions(f)
  })
  await t.test('事实读取失败', sub => {
    const f = admissionScenario(sub)
    const progress = JSON.parse(readFileSync(f.viewFile, 'utf8'))
    progress.active[1] = { ...progress.active[1], stage: null, rule: null, next: null, error: 'facts 失败：测试',
      changeState: null, changeDirectory: null }
    writeFileSync(f.viewFile, JSON.stringify(progress))
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 2, result.all)
    assert.match(result.all, /ddd.*facts 失败：测试/)
    noDecisions(f)
  })
  await t.test('implementing 中的名称没有对应条目', sub => {
    const f = scenario(sub, { progress: view({ implementing: ['ghost'] }) })
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 2, result.all)
    assert.match(result.all, /ghost/)
    noDecisions(f)
  })
})

test('准入：其他活跃变更的状态文件无效或门禁副本没有状态契约时退出 2，不当作可排除的暂缓项（任务 3.1）', async t => {
  for (const [label, text] of INVALID_STATES) {
    await t.test(label, sub => {
      const f = admissionScenario(sub, { ddd: text })
      const before = snapshot(f.dddDir)
      const result = f.run(['start', 'demo'])
      assert.equal(result.code, 2, result.all)
      assert.match(result.all, /ddd/)
      noDecisions(f)
      assert.deepEqual(snapshot(f.dddDir), before)
    })
  }
  await t.test('门禁副本没有状态契约', sub => {
    const f = admissionScenario(sub)
    // 实际进度视图配旧门禁时的输出：顶层不声明版本 1，条目状态未知且没有目录身份（任务 1.4 的 S2 用例）。
    const progress = JSON.parse(readFileSync(f.viewFile, 'utf8'))
    for (const item of progress.active) {
      item.changeState = { state: 'unknown', reason: null, updatedAt: null, error: '门禁副本没有状态契约 1，请同步 openspec-technical-review', digest: null }
      item.changeDirectory = null
    }
    writeFileSync(f.viewFile, JSON.stringify({ ...progress, changeStateVersion: null, raw: true }))
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 2, result.all)
    assert.match(result.all, /同步/)
    noDecisions(f)
  })
})

test('准入：进度脚本来源无法核实时退出 2，不运行该脚本', t => {
  const f = scenario(t)
  const marker = join(f.home, 'progress-ran')
  const outside = join(f.home, 'progress-double.mjs')
  writeFileSync(outside, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\n`)
  writeConfig(f.home, { ...JSON.parse(readFileSync(join(f.home, 'config.json'), 'utf8')), progressBin: outside })
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 2, result.all)
  assert.match(result.all, /progressBin 的安装来源无法核验/)
  assert.equal(existsSync(marker), false)
  noDecisions(f)
})

test('准入：已加载的定时或桥接入口与当前托管副本不一致时退出 2，不登记', async t => {
  const other = tempDir(t, 'autopilot-other-copy-')
  writeFileSync(join(other, 'scheduler.mjs'), '')
  const cases = [
    ['定时入口指向另一份副本', services => { services[LAUNCHD_LABELS.scheduler].arguments[1] = join(other, 'scheduler.mjs') }, /定时服务/],
    ['定时入口缺少 --once', services => { services[LAUNCHD_LABELS.scheduler].arguments.pop() }, /定时服务/],
    ['桥接入口带额外的 Node.js 参数', services => { services[LAUNCHD_LABELS.bridge].arguments.splice(1, 0, '--import=./x.mjs') }, /桥接服务/],
    ['桥接服务没有加载', services => { delete services[LAUNCHD_LABELS.bridge] }, /桥接服务/],
    ['定时服务使用另一个托管目录', services => { services[LAUNCHD_LABELS.scheduler].environment.OPENSPEC_AUTOPILOT_HOME = other }, /定时服务.*托管目录/],
    ['桥接服务的环境变量会改变模块选择', services => { services[LAUNCHD_LABELS.bridge].environment.NODE_OPTIONS = '--require x' }, /桥接服务.*NODE_OPTIONS/],
  ]
  for (const [title, edit, message] of cases) {
    await t.test(title, sub => {
      const f = scenario(sub)
      editServices(f, edit)
      const result = f.run(['start', 'demo'])
      assert.equal(result.code, 2, result.all)
      assert.match(result.all, message)
      noDecisions(f)
    })
  }
})

test('STD-03：桥接入口缺失或是目录时不登记新批次', t => {
  const f = scenario(t)
  const copy = join(f.home, 'scripts')
  // 只在测试副本中移除桥接入口；定时脚本及其只读版本探测保持可用。
  writeFiles(copy, Object.fromEntries(['autopilot.mjs', 'scheduler.mjs'].map(name => [name, readFileSync(join(dirname(autopilot), name), 'utf8')])))
  symlinkSync(join(dirname(autopilot), 'lib'), join(copy, 'lib'), 'dir')
  editServices(f, services => {
    for (const [name, label] of Object.entries(LAUNCHD_LABELS)) services[label].arguments[1] = join(copy, `${name}.mjs`)
  })
  for (const directory of [false, true]) {
    if (directory) mkdirSync(join(copy, 'bridge.mjs'))
    const result = spawnSync(process.execPath, [join(copy, 'autopilot.mjs'), 'start', 'demo'], { cwd: f.repo, encoding: 'utf8',
      env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: f.home, PATH: `${f.launchd.bin}${delimiter}${process.env.PATH}` } })
    assert.equal(result.status, 2, result.stdout + result.stderr)
    assert.match(result.stderr, /桥接服务/)
    noDecisions(f)
  }
})

test('准入：后台解释器与管理进程的 Node.js 不同时退出 2，不执行从服务读取的命令', t => {
  const f = scenario(t)
  const marker = join(f.home, 'other-node-ran')
  const otherNode = join(f.home, 'node')
  writeFileSync(otherNode, `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\n`)
  chmodSync(otherNode, 0o755)
  editServices(f, services => {
    for (const label of Object.values(LAUNCHD_LABELS)) {
      services[label].program = otherNode
      services[label].arguments[0] = otherNode
    }
  })
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 2, result.all)
  assert.match(result.all, /Node\.js/)
  assert.equal(existsSync(marker), false)
  noDecisions(f)
})

test('准入：服务查询或只读版本探测超时、超过合计 5 秒或返回非预期内容时退出 2，不登记', async t => {
  const probeHook = home => {
    const file = join(home, 'probe-hook.cjs')
    writeFileSync(file, `if (process.argv.includes('--change-state-version')) {
  const mode = process.env.TEST_PROBE_MODE
  if (mode === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)
  if (mode === 'extra') { process.stdout.write('{"changeStateVersion":1,"extra":true}\\n'); process.exit(0) }
  if (mode === 'text') { process.stdout.write('ok {"changeStateVersion":1}\\n'); process.exit(0) }
  if (mode === 'fail') process.exit(1)
}\n`)
    return { NODE_OPTIONS: `--require ${file}` }
  }
  await t.test('单次服务查询超过 2 秒', sub => {
    const f = scenario(sub)
    editServices(f, services => { services[LAUNCHD_LABELS.scheduler].delayMs = 2600 })
    const started = Date.now()
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 2, result.all)
    assert.match(result.all, /定时服务.*超时/)
    assert.ok(Date.now() - started < 4500, `单次查询应在 2 秒时停止：${Date.now() - started}`)
    noDecisions(f)
  })
  await t.test('两次查询与一次探测合计超过 5 秒', sub => {
    const f = scenario(sub)
    // 替身从自身进程启动起计时，Node.js 启动时间不计入余量：每次查询必然超过 1.5 秒，两次合计必然超过 3 秒，
    // 探测只能使用合计剩余的不足 2 秒；单次离 2 秒上限还有约 500 毫秒，留给替身启动前后的进程开销。
    editServices(f, services => {
      services[LAUNCHD_LABELS.scheduler].delayMs = 1500
      services[LAUNCHD_LABELS.bridge].delayMs = 1500
    })
    const started = Date.now()
    const result = f.run(['start', 'demo'], { ...probeHook(f.home), TEST_PROBE_MODE: 'slow' })
    const elapsed = Date.now() - started
    assert.equal(result.code, 2, result.all)
    const timeout = /只读版本探测超时（(\d+) 毫秒）/.exec(result.all)
    assert.ok(timeout, result.all)
    assert.ok(Number(timeout[1]) < 2000, `探测应按合计剩余时间停止：${timeout[1]}`)
    assert.ok(elapsed >= 4500 && elapsed < 7000, `应在合计 5 秒时停止：${elapsed}`)
    noDecisions(f)
  })
  for (const mode of ['extra', 'text', 'fail']) {
    await t.test(`探测输出不符：${mode}`, sub => {
      const f = scenario(sub)
      const result = f.run(['start', 'demo'], { ...probeHook(f.home), TEST_PROBE_MODE: mode })
      assert.equal(result.code, 2, result.all)
      assert.match(result.all, /只读版本探测/)
      noDecisions(f)
    })
  }
})

test('调度只读探测：单独使用 --change-state-version 时在读配置前输出契约版本，不取锁；与其他参数混用时拒绝', t => {
  const home = tempDir(t, 'autopilot-probe-')
  const scheduler = fileURLToPath(new URL('../skills/openspec-autopilot/scripts/scheduler.mjs', import.meta.url))
  const run = args => spawnSync(process.execPath, [scheduler, ...args], {
    encoding: 'utf8', env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: home },
  })
  const probe = run(['--change-state-version'])
  assert.equal(probe.status, 0, probe.stderr)
  assert.equal(probe.stdout, '{"changeStateVersion":1}\n')
  assert.deepEqual(readdirSync(home), [])
  for (const args of [['--change-state-version', '--once'], ['--once', '--change-state-version']]) {
    const mixed = run(args)
    assert.equal(mixed.status, 2, mixed.stderr)
    assert.equal(mixed.stdout, '')
    assert.deepEqual(readdirSync(home), [])
  }
})

test('准入：暂缓不能覆盖实际占用，未完成核对与其他批次照常拒绝', async t => {
  await t.test('同一项目另一个已归档变更的批次仍为 exiting（CONC-09）', sub => {
    const f = admissionScenario(sub)
    archivedBatch(f, { status: 'exiting' })
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /2026-11-20-old/)
    noDecisions(f)
  })
  await t.test('按暂缓排除的 ddd 有写者已退出的阶段核对条目（DB-13）', sub => {
    const f = admissionScenario(sub)
    writePendingTrace(f.home, [stageEntry(f, 'ddd')])
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /ddd 仍有未完成核对/)
    noDecisions(f)
  })
  await t.test('按暂缓排除的 ddd 有 version-handoff 条目（DB-13）', sub => {
    const f = admissionScenario(sub)
    const { stage, runId, writer, traceBefore, ...base } = stageEntry(f, 'ddd')
    writePendingTrace(f.home, [{ ...base, mode: 'version-handoff', sourceDecisionId: 'D-0001', alertId: 'D-0002', traceBefore: {} }])
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /ddd 仍有未完成核对/)
    noDecisions(f)
  })
  await t.test('核对文件不可读时不登记', sub => {
    const f = admissionScenario(sub)
    writeFileSync(join(f.home, 'pending-trace.json'), '{ 损坏')
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /未完成核对文件无法验证/)
    noDecisions(f)
  })
})

test('准入：未决出口只在依靠暂缓排除时检查，终态历史和未标记 ok 的提交不构成未决出口（CONC-16 对照）', async t => {
  const now = Date.now() / 1000
  await t.test('完整扫描只发现无未决出口的终态历史', sub => {
    const f = admissionScenario(sub)
    archivedBatch(f, { name: 'closed-one', status: 'closed' })
    archivedBatch(f, { name: 'void-one' })
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 0, result.all)
  })
  await t.test('提交与合并未标记 ok 的已撤回批次', sub => {
    const f = admissionScenario(sub)
    archivedBatch(f, { exit: { 'commit-merge': { branch: 'fix/old', commit: 'abc123' } }, mtime: now })
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 0, result.all)
  })
  await t.test('不依靠暂缓排除时不增加未决出口检查', sub => {
    const f = scenario(sub)
    const dir = archivedBatch(f, { exit: { 'commit-merge': { ok: true, commit: 'abc123' } }, mtime: now })
    const before = snapshot(dir)
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 0, result.all)
    assert.deepEqual(snapshot(dir), before)
  })
})

// ---------------------------------------------------------------------------
// add-change-pause 任务 2.2：项目写保护内的复核与占用（S3 管理命令、S4 调度）
// 本组用例修改任务 1.2 已实现的暂缓与恢复代码（共用占用判定、等待保护、写者身份与读取额度），新增管理回归记在 Slice 02。
// ---------------------------------------------------------------------------

/**
 * 三个管理命令在 admissionScenario 中的写法：pause 写 demo 的状态，resume 恢复已暂缓的 ddd，start 托管 demo。
 * written 判断该命令是否已写入状态或托管记录。
 */
const MANAGEMENT_COMMANDS = [
  { name: 'pause', run: f => f.run(['pause', 'demo', '--reason', '另一个原因']), written: f => existsSync(join(f.changeDir, 'change-state.json')) },
  { name: 'resume', run: f => f.run(['resume', 'ddd']), written: f => JSON.parse(readFileSync(join(f.dddDir, 'change-state.json'), 'utf8')).state !== 'paused' },
  { name: 'start', run: f => f.run(['start', 'demo']), written: f => f.record()?.status === 'active' },
]

/** 对三个管理命令各建一个新环境运行同一组断言。 */
async function eachCommand(t, setup, check) {
  for (const command of MANAGEMENT_COMMANDS) {
    await t.test(command.name, sub => {
      const f = setup(sub)
      check(f, command, command.run(f))
    })
  }
}

/** 本项目写保护文件的路径，与 lib/batch.mjs 的 withProjectProtection 相同。 */
const protectionFile = f => join(f.home, 'project-locks', `${createHash('sha256').update(realpathSync.native(f.repo)).digest('hex')}.lock`)

/** 另一进程持有项目写保护 ms 毫秒后释放。返回已就绪的持有进程。 */
async function holdProtection(t, file, ms) {
  mkdirSync(dirname(file), { recursive: true })
  const child = spawn(process.execPath, ['-e', `const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({ pid: process.pid, token: 'holder', bootId: 'holder-boot', instance: 'holder-instance' }))
process.stdout.write('ready\\n')
setTimeout(() => { fs.unlinkSync(${JSON.stringify(file)}); process.exit(0) }, ${ms})`], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => child.kill('SIGKILL'))
  await once(child.stdout, 'data')
  return child
}

/** 一个已退出进程的进程号。 */
const exitedPid = () => spawnSync(process.execPath, ['-e', '']).pid

/** 在 autopilot.mjs 的指定子命令中注入一段预加载脚本，返回 NODE_OPTIONS。 */
function commandHook(f, command, body) {
  const file = join(f.home, `${command}-hook-${Math.random().toString(16).slice(2)}.cjs`)
  writeFileSync(file, `if (process.argv[1]?.endsWith('/autopilot.mjs') && process.argv[2] === ${JSON.stringify(command)}) {
${body}
  require('node:module').syncBuiltinESMExports()
}\n`)
  return { NODE_OPTIONS: `--require ${file}` }
}

/** 进入项目写保护之前（首次 link 保护文件时）运行一次 action。 */
const beforeProtection = (f, command, action) => commandHook(f, command, `  const fs = require('node:fs')
  const link = fs.linkSync
  let done = false
  fs.linkSync = (from, to) => {
    if (!done && String(to).includes('/project-locks/')) {
      done = true
      ${action}
    }
    return link(from, to)
  }`)

test('准入：存活的出口锁绑定同一检出的已撤回批次时，三个命令均退出 1，不等待、不发信号、不清理（CONC-15）', async t => {
  const holder = spawnSignalTarget()
  t.after(() => holder.kill('SIGKILL'))
  const residue = 'change-state.json.tmp.23.abcdef12-0000-4000-8000-400000000000'
  const setup = (sub, projectRoot) => {
    const f = admissionScenario(sub, {
      files: { 'decisions/autopilot.json': managedRecord({ status: 'void' }), 'decisions/D-0006.json': { id: 'D-0006', kind: 'question', status: 'pending' },
        [residue]: '残留' },
    })
    archivedBatch(f, { name: 'old' })
    writeLock(f, { pid: holder.pid, bootTime: bootTime(), change: 'old', projectRoot: projectRoot(f),
      startedAt: '2026-11-06T10:00:00Z', runId: 'exit-run' })
    return f
  }
  await t.test('锁属于本项目', async sub => {
    await eachCommand(sub, inner => setup(inner, f => realpathSync.native(f.repo)), (f, command, result) => {
      assert.equal(result.code, 1, result.all)
      assert.match(result.all, /阶段仍在运行或无法核验/)
      assert.equal(command.written(f), false)
      assert.equal(f.decision('D-0006').status, 'pending')
      assert.equal(existsSync(join(f.changeDir, residue)), true)
    })
  })
  await t.test('锁已核实属于其他项目', async sub => {
    const other = tempDir(sub, 'autopilot-other-project-')
    await eachCommand(sub, inner => setup(inner, () => other), (f, command, result) => {
      assert.equal(result.code, 0, result.all)
      assert.equal(command.written(f), true)
    })
  })
  process.kill(holder.pid, 0)
})

test('准入：调度刚取得、未绑定批次的存活锁不单独阻断；含绑定字段但无法核实属于其他项目时三个命令退出 1（CONC-18）', async t => {
  const holder = spawnSignalTarget()
  t.after(() => holder.kill('SIGKILL'))
  await t.test('未绑定批次', async sub => {
    await eachCommand(sub, inner => {
      const f = admissionScenario(inner)
      writeLock(f, { pid: holder.pid, bootTime: bootTime(), change: null, projectRoot: null, startedAt: null, runId: null })
      return f
    }, (f, command, result) => {
      assert.equal(result.code, 0, result.all)
      assert.equal(command.written(f), true)
    })
  })
  await t.test('只写了变更名', async sub => {
    await eachCommand(sub, inner => {
      const f = admissionScenario(inner)
      writeLock(f, { pid: holder.pid, bootTime: bootTime(), change: 'old' })
      return f
    }, (f, command, result) => {
      assert.equal(result.code, 1, result.all)
      assert.match(result.all, /阶段仍在运行或无法核验/)
      assert.equal(command.written(f), false)
    })
  })
})

test('准入：运行锁无法核验时三个命令均退出 1，不写入（DB-12）', async t => {
  const holder = spawnSignalTarget()
  t.after(() => holder.kill('SIGKILL'))
  const bound = f => ({ change: 'old', projectRoot: realpathSync.native(f.repo), startedAt: '2026-11-06T10:00:00Z', runId: 'exit-run' })
  const cases = [
    ['无法解析且修改时间超过 60 秒', f => {
      writeFileSync(join(f.home, 'run.lock'), '{ 损坏')
      const old = Date.now() / 1000 - 120
      utimesSync(join(f.home, 'run.lock'), old, old)
    }],
    ['缺 pid', f => writeLock(f, { bootTime: bootTime(), ...bound(f) })],
    ['缺 bootTime', f => writeLock(f, { pid: holder.pid, ...bound(f) })],
    ['projectRoot 无法解析', f => writeLock(f, { pid: holder.pid, bootTime: bootTime(), ...bound(f), projectRoot: join(f.home, 'missing-project') })],
    ['writer 已发布但缺 bootId', f => writeLock(f, { pid: exitedPid(), bootTime: bootTime(), ...bound(f),
      writer: { state: 'published', pid: holder.pid, instance: 'fixture-instance' } })],
  ]
  for (const [title, writeRunLock] of cases) {
    await t.test(title, async sub => {
      await eachCommand(sub, inner => {
        const f = admissionScenario(inner)
        writeRunLock(f)
        return f
      }, (f, command, result) => {
        assert.equal(result.code, 1, result.all)
        assert.match(result.all, /阶段仍在运行或无法核验/)
        assert.equal(command.written(f), false)
      })
    })
  }
})

test('准入：托管记录与待核对文件累计读取超过 16 MiB 时三个命令均退出 1，报告已检查条目数（PERF-12）', async t => {
  const large = `{"version":1,"entries":{},"pad":"${'x'.repeat(17 * 1024 * 1024)}"}`
  await t.test('待核对文件', async sub => {
    await eachCommand(sub, inner => {
      const f = admissionScenario(inner)
      writeFileSync(join(f.home, 'pending-trace.json'), large)
      return f
    }, (f, command, result) => {
      assert.equal(result.code, 1, result.all)
      assert.match(result.all, /已检查 \d+ 个条目.*16 MiB/)
      assert.equal(command.written(f), false)
    })
  })
  await t.test('归档托管记录', sub => {
    const f = admissionScenario(sub)
    const dir = archivedBatch(f, { status: 'closed' })
    writeFileSync(join(dir, 'decisions', 'autopilot.json'), `{"status":"closed","startedAt":"2026-11-06T10:00:00Z","pad":"${'x'.repeat(17 * 1024 * 1024)}"}`)
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /已检查 \d+ 个条目.*16 MiB/)
    noDecisions(f)
  })
})

test('准入：依靠暂缓排除时，已撤回批次有提交结果且未证明重启则退出 1，原批次与目标资料不变（CONC-16）', async t => {
  const variants = [
    ['锁缺失，有提交结果但还没有推送托管决策', () => {}, { 'commit-merge': { branch: 'fix/old', commit: 'abc123', ok: true, mode: 'branch-only' } }],
    ['锁陈旧，有原推送确认但不能核实第二次拉取停止', f => writeLock(f, { pid: exitedPid(), bootTime: bootTime() - 100_000, change: 'old',
      projectRoot: realpathSync.native(f.repo), startedAt: '2026-11-06T10:00:00Z', runId: 'exit-run' }),
    { 'commit-merge': { branch: 'fix/old', commit: 'abc123', mergeCommit: 'def456', ok: true, mode: 'merge' }, push: { ok: true } }],
  ]
  for (const [title, writeRunLock, exit] of variants) {
    await t.test(title, sub => {
      const f = admissionScenario(sub)
      writeRunLock(f)
      const dir = archivedBatch(f, { exit, mtime: Date.now() / 1000 })
      const archived = snapshot(dir)
      const target = snapshot(f.changeDir)
      const result = f.run(['start', 'demo'])
      assert.equal(result.code, 1, result.all)
      assert.match(result.all, /2026-11-20-old.*未决出口.*重启/)
      assert.deepEqual(snapshot(dir), archived)
      assert.deepEqual(snapshot(f.changeDir), target)
    })
  }
})

test('准入：以本次开机时间证明未决出口已停止，修改时间晚于当前时间时拒绝，不读决策目录（CONC-17）', async t => {
  const exit = { 'commit-merge': { branch: 'fix/old', commit: 'abc123', ok: true, mode: 'branch-only' } }
  const cases = [
    ['开机晚于托管记录修改时间 60 秒以上', bootTime() - 120, 0, null],
    ['开机不晚于修改时间加 60 秒', Date.now() / 1000, 1, /重启后重试/],
    ['修改时间晚于当前时间', Date.now() / 1000 + 3600, 1, /晚于当前时间/],
  ]
  for (const [title, mtime, code, message] of cases) {
    await t.test(title, sub => {
      const f = admissionScenario(sub)
      const dir = archivedBatch(f, { exit })
      // 决策目录中的损坏文件：读取决策目录就会失败。
      writeFileSync(join(dir, 'decisions', 'D-0001.json'), '{ 损坏')
      utimesSync(join(dir, 'decisions', 'autopilot.json'), mtime, mtime)
      const archived = snapshot(dir)
      const result = f.run(['start', 'demo'])
      assert.equal(result.code, code, result.all)
      if (message) assert.match(result.all, message)
      assert.deepEqual(snapshot(dir), archived)
      assert.equal(f.record()?.status ?? null, code === 0 ? 'active' : null)
    })
  }
})

test('准入：已撤回归档批次的出口结果字段类型无效时，依靠暂缓的 start 退出 1（DB-17）', async t => {
  const cases = [
    ['exit.commit-merge 不是对象', { 'commit-merge': [] }],
    ['ok 不是布尔值', { 'commit-merge': { ok: 'true', commit: 'abc123' } }],
  ]
  for (const [title, exit] of cases) {
    await t.test(title, sub => {
      const f = admissionScenario(sub)
      archivedBatch(f, { exit, mtime: bootTime() - 120 })
      const result = f.run(['start', 'demo'])
      assert.equal(result.code, 1, result.all)
      assert.match(result.all, /出口结果无法核验/)
      noDecisions(f)
    })
  }
})

test('准入：另一进程持有项目写保护 1.5 秒时三个命令等待后完成；超过 2.5 秒时退出 1，不写入（CONC-19）', async t => {
  await t.test('持有 1.5 秒', async sub => {
    for (const command of MANAGEMENT_COMMANDS) {
      await sub.test(command.name, async inner => {
        const f = admissionScenario(inner)
        await holdProtection(inner, protectionFile(f), 1500)
        const result = command.run(f)
        assert.equal(result.code, 0, result.all)
        assert.equal(command.written(f), true)
      })
    }
  })
  await t.test('持有 60 秒', async sub => {
    for (const command of MANAGEMENT_COMMANDS) {
      await sub.test(command.name, async inner => {
        const f = admissionScenario(inner)
        // 持有时间须远超 2.5 秒的等待上限：等待从命令首次尝试取得保护时才开始计时，机器繁忙时命令启动与准入核对
        // 可能先用去 2 秒以上；原来只持有 4.5 秒，保护会在等待期内释放，命令取得保护后退出 0。持有方在用例结束时被结束。
        await holdProtection(inner, protectionFile(f), 60_000)
        const result = command.run(f)
        assert.equal(result.code, 1, result.all)
        assert.match(result.all, /未能取得项目写入保护/)
        assert.equal(command.written(f), false)
      })
    }
  })
})

test('调度出口：另一进程持有项目写保护 1.5 秒时 writeExitState 仍记录分支（CONC-19，S4）', t => {
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
  // 建分支之后、写入分支之前，另一进程取得项目写保护并持有 1.5 秒。
  const lock = protectionFile(f)
  const hook = join(f.home, 'hold-at-branch.cjs')
  writeFileSync(hook, `if (process.argv[1]?.endsWith('/scheduler.mjs')) {
  const cp = require('node:child_process')
  const fs = require('node:fs')
  const run = cp.spawnSync
  let held = false
  cp.spawnSync = (command, args, options) => {
    const result = run(command, args, options)
    if (!held && command === 'git' && args.includes('switch') && args.includes('-c')) {
      held = true
      fs.mkdirSync(${JSON.stringify(dirname(lock))}, { recursive: true })
      cp.spawn(process.execPath, ['-e', \`const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(lock)}, JSON.stringify({ pid: process.pid, token: 'holder', bootId: 'holder-boot', instance: 'holder-instance' }))
setTimeout(() => fs.unlinkSync(${JSON.stringify(lock)}), 1500)\`], { stdio: 'ignore', detached: true }).unref()
      while (!fs.existsSync(${JSON.stringify(lock)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    return result
  }
  require('node:module').syncBuiltinESMExports()
}\n`)
  const result = f.run({ NODE_OPTIONS: `--require ${hook}` })
  assert.equal(result.code, 0, result.all)
  assert.equal(f.record().exit['commit-merge'].branch, 'fix/x')
  const after = JSON.parse(readFileSync(decisionFile, 'utf8'))
  assert.equal(after.status, 'used')
  assert.equal(after.result.ok, true, JSON.stringify(after.result))
})

test('准入：两个请求按项目写保护内的复核顺序完成，旧快照不能解除占用（S3 双进程）', async t => {
  await t.test('暂缓项在 start 取得保护前被恢复', sub => {
    const f = admissionScenario(sub)
    const env = beforeProtection(f, 'start', `require('node:child_process').spawnSync(process.execPath, [process.argv[1], 'resume', 'ddd'], { stdio: 'ignore' })`)
    const result = f.run(['start', 'demo'], env)
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /ddd 的状态无法复核/)
    assert.equal(JSON.parse(readFileSync(join(f.dddDir, 'change-state.json'), 'utf8')).state, 'enabled')
    noDecisions(f)
  })
  await t.test('活跃目录集合在快照后变化', sub => {
    const f = admissionScenario(sub)
    const env = beforeProtection(f, 'start', `fs.mkdirSync(${JSON.stringify(join(f.repo, 'openspec', 'changes', 'newcomer'))})`)
    const result = f.run(['start', 'demo'], env)
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /活跃变更目录与进度快照不一致/)
    noDecisions(f)
  })
  await t.test('start 先完成登记，随后的 pause 看到新批次', sub => {
    const f = admissionScenario(sub)
    const env = beforeProtection(f, 'pause', `require('node:child_process').spawnSync(process.execPath, [process.argv[1], 'start', 'demo'], { stdio: 'ignore' })`)
    const result = f.run(['pause', 'demo', '--reason', '另一个原因'], env)
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /仍在托管/)
    assert.equal(f.record().status, 'active')
    assert.equal(existsSync(join(f.changeDir, 'change-state.json')), false)
  })
  await t.test('目录实例在快照后被同名新目录替换', sub => {
    const f = admissionScenario(sub)
    const moved = join(f.home, 'ddd-original')
    const env = beforeProtection(f, 'start', `fs.renameSync(${JSON.stringify(f.dddDir)}, ${JSON.stringify(moved)})
      fs.mkdirSync(${JSON.stringify(f.dddDir)})
      fs.copyFileSync(${JSON.stringify(join(moved, 'change-state.json'))}, ${JSON.stringify(join(f.dddDir, 'change-state.json'))})`)
    const result = f.run(['start', 'demo'], env)
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /ddd 的变更目录实例与进度快照不同/)
    noDecisions(f)
  })
  await t.test('目录归属在快照后改为软链接', sub => {
    const f = admissionScenario(sub)
    const moved = join(f.home, 'ddd-original')
    const env = beforeProtection(f, 'start', `fs.renameSync(${JSON.stringify(f.dddDir)}, ${JSON.stringify(moved)})
      fs.symlinkSync(${JSON.stringify(moved)}, ${JSON.stringify(f.dddDir)})`)
    const result = f.run(['start', 'demo'], env)
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /归属无效/)
    noDecisions(f)
  })
})

test('准入：扫描期间发生归档移动时退出 1；登记后目标被归档并出现同名新目录时 start 退出 2（CONC-09、CONC-06）', async t => {
  for (const command of ['start', 'pause']) {
    await t.test(`${command}：扫描期间归档移动`, sub => {
      const f = admissionScenario(sub, { active: [entry({ change: 'gamma' })] })
      const gamma = join(f.changes, 'gamma')
      const archive = join(f.changes, 'archive')
      mkdirSync(archive)
      const env = commandHook(f, command, `  const fs = require('node:fs')
  const open = fs.opendirSync
  let moved = false
  fs.opendirSync = (dir, ...args) => {
    if (!moved && String(dir).endsWith('/openspec/changes/archive')) {
      moved = true
      fs.renameSync(${JSON.stringify(gamma)}, ${JSON.stringify(join(archive, '2026-11-24-gamma'))})
    }
    return open(dir, ...args)
  }`)
      const result = command === 'start' ? f.run(['start', 'demo'], env) : f.run(['pause', 'demo', '--reason', '另一个原因'], env)
      assert.equal(result.code, 1, result.all)
      assert.equal(f.record(), null)
      assert.equal(existsSync(join(f.changeDir, 'change-state.json')), false)
    })
  }
  await t.test('start：登记后目标离开活跃位置', sub => {
    const f = admissionScenario(sub)
    const archived = join(f.changes, 'archive', '2026-11-24-demo')
    const env = commandHook(f, 'start', `  const fs = require('node:fs')
  const rename = fs.renameSync
  let moved = false
  fs.renameSync = (from, to) => {
    const result = rename(from, to)
    if (!moved && to === 'autopilot.json') {
      moved = true
      fs.mkdirSync(${JSON.stringify(dirname(archived))}, { recursive: true })
      rename(${JSON.stringify(f.changeDir)}, ${JSON.stringify(archived)})
      fs.mkdirSync(${JSON.stringify(f.changeDir)})
    }
    return result
  }`)
    const result = f.run(['start', 'demo'], env)
    assert.equal(result.code, 2, result.all)
    assert.match(result.all, /已在原变更目录.*离开活跃位置/)
    assert.equal(JSON.parse(readFileSync(join(archived, 'decisions', 'autopilot.json'), 'utf8')).status, 'active')
    assert.deepEqual(readdirSync(f.changeDir), [])
  })
})

test('准入：超出目录数、2 秒期限或 4 MiB 状态读取额度时 start 退出 1，不登记', async t => {
  await t.test('目录条目超过 1,024', sub => {
    const f = admissionScenario(sub)
    const archive = join(f.changes, 'archive')
    mkdirSync(archive)
    for (let i = 0; i < 1_030; i++) writeFileSync(join(archive, `item-${i}`), '')
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /已检查 1024 个条目/)
    noDecisions(f)
  })
  await t.test('保护内用完 2 秒', sub => {
    const f = admissionScenario(sub)
    const env = commandHook(f, 'start', `  const fs = require('node:fs')
  const { performance } = require('node:perf_hooks')
  const open = fs.opendirSync
  let late = false
  Object.defineProperty(performance, 'now', { value: () => late ? 2001 : 0 })
  fs.opendirSync = (dir, ...args) => {
    if (String(dir).endsWith('/openspec/changes')) late = true
    return open(dir, ...args)
  }`)
    const result = f.run(['start', 'demo'], env)
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /核验时间已用完/)
    noDecisions(f)
  })
  await t.test('状态文件累计读取超过 4 MiB', sub => {
    const f = scenario(sub)
    const root = realpathSync.native(f.repo)
    const fillers = []
    for (let i = 0; i < 260; i++) {
      const change = `filler-${String(i).padStart(3, '0')}`
      const dir = join(f.repo, 'openspec', 'changes', change)
      mkdirSync(dir)
      const head = JSON.stringify({ version: 1, state: 'enabled', reason: '填充', updatedAt: '2026-11-24T00:00:00.000Z' })
      const contents = Buffer.from(head + ' '.repeat(16 * 1024 - Buffer.byteLength(head)))
      writeFileSync(join(dir, 'change-state.json'), contents)
      const stat = statSync(dir, { bigint: true })
      fillers.push(entry({ change, rule: 'R1', stage: 'proposal', next: `/opsx:propose ${change}`,
        changeState: { state: 'enabled', reason: '填充', updatedAt: '2026-11-24T00:00:00.000Z', error: null,
          digest: createHash('sha256').update(contents).digest('hex') },
        changeDirectory: { path: join(root, 'openspec', 'changes', change), dev: String(stat.dev), ino: String(stat.ino) } }))
    }
    const viewFile = join(f.home, 'progress-output.json')
    const progress = JSON.parse(readFileSync(viewFile, 'utf8'))
    writeFileSync(viewFile, JSON.stringify({ ...progress, active: [...progress.active, ...fillers] }))
    const result = f.run(['start', 'demo'])
    assert.equal(result.code, 1, result.all)
    assert.match(result.all, /4 MiB/)
    noDecisions(f)
  })
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

test('查询托管状态区分本批次没有运行与存活旧锁无法核验', t => {
  const f = cancelScenario(t)
  const clean = f.run(['status', 'demo'])
  assert.equal(clean.code, 0, clean.all)
  assert.match(clean.out, /阶段运行中：否/)
  writeLock(f, { pid: process.pid, bootTime: bootTime(), change: 'demo', claudePid: null })
  const unknown = f.run(['status', 'demo'])
  assert.equal(unknown.code, 0, unknown.all)
  assert.match(unknown.out, /阶段运行中：无法确定/)
})

test('查询锁状态忽略其他批次并识别已核验的同批次写者', t => {
  const f = cancelScenario(t)
  const writer = spawnSignalTarget()
  t.after(() => writer.kill('SIGKILL'))
  const lock = managedLock(f, process.pid, writer.pid)
  writeLock(f, { ...lock, startedAt: '2026-11-05T10:00:00Z' })
  assert.match(f.run(['status', 'demo']).out, /阶段运行中：否/)
  writeLock(f, lock)
  assert.match(f.run(['status', 'demo']).out, /阶段运行中：是/)
  writeFileSync(join(f.home, 'run.lock'), '未写完')
  assert.match(f.run(['status', 'demo']).out, /阶段运行中：无法确定/)
  const stale = new Date(Date.now() - 120_000)
  utimesSync(join(f.home, 'run.lock'), stale, stale)
  assert.match(f.run(['status', 'demo']).out, /阶段运行中：否/)
})

test('查询和撤回在同名空活跃目录后定位归档批次', t => {
  const f = scenario(t)
  const archive = join(f.repo, 'openspec', 'changes', 'archive', '2026-11-19-demo')
  writeFiles(archive, { 'decisions/autopilot.json': managedRecord({ status: 'exiting' }),
    'decisions/D-0001.json': { id: 'D-0001', kind: 'alert', status: 'pending' } })
  const result = f.run(['status', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.ok(result.out.includes(realpathSync.native(archive)))
  assert.match(result.out, /阶段运行中：否/)
  assert.equal(f.run(['cancel', 'demo']).code, 0)
  assert.equal(JSON.parse(readFileSync(join(archive, 'decisions', 'D-0001.json'), 'utf8')).status, 'void')
})

test('两个配置项目有同名批次时按当前检出查询和撤回', t => {
  const f = scenario(t, { files: { 'decisions/autopilot.json': managedRecord() } })
  const otherRoot = tempDir(t, 'autopilot-other-repo-')
  initRepo(otherRoot)
  const other = join(otherRoot, 'openspec', 'changes', 'demo')
  writeFiles(other, { 'decisions/autopilot.json': managedRecord({ startedAt: '2026-11-19T10:00:00Z' }) })
  const file = join(f.home, 'config.json')
  writeConfig(f.home, { ...JSON.parse(readFileSync(file)), projects: [projectOf(otherRoot), projectOf(f.repo)] })
  const status = f.run(['status', 'demo'])
  assert.equal(status.code, 0, status.all)
  assert.ok(status.out.includes(realpathSync.native(f.changeDir)))
  assert.equal(f.run(['cancel', 'demo']).code, 0)
  assert.equal(f.record().status, 'void')
  assert.equal(JSON.parse(readFileSync(join(other, 'decisions', 'autopilot.json'))).status, 'active')
  const outside = tempDir(t, 'autopilot-outside-')
  const ambiguous = spawnSync(process.execPath, [autopilot, 'status', 'demo'], { encoding: 'utf8', cwd: outside,
    env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: f.home } })
  assert.equal(ambiguous.status, 2)
  assert.match(ambiguous.stderr, /存在多个可选批次/)
})

test('管理命令拒绝歧义的归档批次且保留记录', t => {
  const f = scenario(t)
  const archives = ['2026-11-18-demo', '2026-11-19-demo'].map(name => join(f.repo, 'openspec', 'changes', 'archive', name))
  for (const directory of archives) writeFiles(directory, { 'decisions/autopilot.json': managedRecord() })
  for (const command of ['status', 'cancel', 'start']) assert.notEqual(f.run([command, 'demo']).code, 0)
  for (const dir of archives) assert.equal(JSON.parse(readFileSync(join(dir, 'decisions', 'autopilot.json'), 'utf8')).status, 'active')
})

test('重复撤回清理旧待答决策且不重写 void 记录', t => {
  const f = cancelScenario(t, { recordValue: managedRecord({ status: 'void', voidReason: '用户撤回' }) })
  const record = join(f.changeDir, 'decisions', 'autopilot.json')
  writeFiles(f.changeDir, { 'decisions/D-0001.json': { id: 'D-0001', kind: 'alert', status: 'pending' } })
  const identity = statSync(record).ino
  assert.equal(f.run(['cancel', 'demo']).code, 0)
  assert.equal(statSync(record).ino, identity)
  assert.equal(JSON.parse(readFileSync(join(f.changeDir, 'decisions', 'D-0001.json'), 'utf8')).status, 'void')
  assert.equal(f.run(['cancel', 'demo']).code, 0)
  assert.equal(statSync(record).ino, identity)
})

test('撤回保护已核验的回会话交接并清理其他待答决策', t => {
  const f = cancelScenario(t, { recordValue: managedRecord({ status: 'void', returnHandoff: 'D-0001' }) })
  const handoff = { id: 'D-0001', kind: 'alert', status: 'answered', answer: { operatorId: 'ou_owner', choice: '回会话处理' } }
  writeFiles(f.changeDir, { 'decisions/D-0001.json': handoff,
    'decisions/D-0002.json': { id: 'D-0002', kind: 'exit', status: 'pending' } })
  const result = f.run(['cancel', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.match(result.out, /D-0001 仍待核验交接/)
  const decision = id => JSON.parse(readFileSync(join(f.changeDir, 'decisions', `${id}.json`), 'utf8'))
  assert.deepEqual(decision('D-0001'), handoff)
  assert.equal(decision('D-0002').status, 'void')
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
  const bind = (id, directory = changeRoot) => {
    const writer = spawnSignalTarget()
    t.after(() => writer.kill('SIGKILL'))
    const root = realpathSync.native(repo)
    const batch = managedRecord()
    writeFiles(directory, { 'decisions/autopilot.json': batch })
    const runId = 'hook-fixture-run'
    const instance = writerIdentity(writer.pid)
    writeLock({ home }, { pid: process.pid, bootTime: bootTime(), projectRoot: root, change: 'demo', startedAt: batch.startedAt,
      runId, claudePid: writer.pid, writer: instance })
    const key = JSON.stringify([root, 'demo', batch.startedAt])
    writeFiles(home, { 'pending-trace.json': { version: 1, entries: { [key]: {
      mode: 'stage', root, name: 'demo', startedAt: batch.startedAt, directory: realpathSync.native(changeRoot), location: 'active',
      stage: 'quality', runId, consumedDecisionId: id, writer: instance, traceBefore: { traceVersion: 1, resumedDecisionIds: [id] },
    } } } })
  }
  const [decision] = Object.keys(files).filter(file => /^decisions\/D-\d{4}\.json$/.test(file))
  if (decision) bind(decision.slice(10, -5))
  const run = (input, env = {}) => {
    const result = spawnSync(process.execPath, [hook], {
      cwd: repo,
      encoding: 'utf8',
      input: `${JSON.stringify(input)}\n`,
      env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: home, OPENSPEC_AUTOPILOT_CHANGE_ROOT: changeRoot, ...env },
    })
    return { code: result.status, out: result.stdout.trim(), err: result.stderr.trim(), json: () => JSON.parse(result.stdout) }
  }
  return { repo, home, changeRoot, run, bind }
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

for (const field of ['startedAt', 'runId']) {
  test(`提问回复的${field}无法归属本次运行时保持挂起`, t => {
    const f = hookScenario(t, { files: { 'decisions/D-0001.json': answeredQuestion() } })
    const lockFile = join(f.home, 'run.lock')
    const original = JSON.parse(readFileSync(lockFile, 'utf8'))
    writeFileSync(lockFile, JSON.stringify({ ...original, [field]: 'different-instance' }))
    const input = { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'T1', tool_input: QUESTION }
    const result = f.run(input)
    assert.equal(result.code, 0, result.err)
    assert.equal(result.json().permissionDecision, 'defer')
    assert.equal(result.json().updatedInput, undefined)
    writeFileSync(lockFile, JSON.stringify(original))
    assert.equal(f.run(input).json().permissionDecision, 'allow')
  })
}

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
  f.bind('D-0005', join(archive, '..'))
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

test('托管写入保护使用决策目录在磁盘上的实际大小写', t => {
  const f = hookScenario(t, { files: { 'decisions/D-0001.json': answeredQuestion() } })
  const differentlyCased = join(f.changeRoot, 'DECISIONS', 'D-0001.json')
  if (!existsSync(differentlyCased)) return t.skip('文件系统区分大小写')
  for (const target of [differentlyCased, join(f.changeRoot, 'Decisions', 'D-0001.json'),
    join(dirname(f.changeRoot), 'DEMO', 'decisions', 'D-0001.json')]) {
    const result = f.run({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'W1',
      tool_input: { file_path: target, content: '{}' } })
    assert.equal(result.code, 0, result.err)
    assert.equal(result.json().permissionDecision, 'deny')
  }
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
const gateBin = fileURLToPath(new URL('../skills/openspec-technical-review/scripts/implementation-gate.mjs', import.meta.url))

/** 进度视图的一条变更条目。 */
const schedEntry = (overrides = {}) => ({
  change: 'demo', tier: 'MVP', stage: 'apply', tasks: { done: 0, total: 3 },
  openQuestions: { pending: 0, total: 0 }, rule: 'R6', blockers: [], warnings: [], notes: [],
  reviewStale: false, next: '/opsx:apply demo', error: null, ...overrides,
})

/** 托管记录。 */
const managedRecord = (overrides = {}) => ({ status: 'active', startedAt: '2026-11-06T10:00:00Z', rule: 'R6', tier: 'MVP', ...overrides })

/**
 * 用例自写进度替身时使用的视图：当前视图文件的内容补上状态契约 1，活跃条目为继续推进并带目录实例。
 * 调度在执行边界核对状态（add-change-pause design D5），缺少契约的视图不再领取新动作。
 */
function enabledView(f) {
  const value = JSON.parse(readFileSync(f.viewFile, 'utf8'))
  return { ...value, changeStateVersion: 1, active: value.active.map(item => ({ ...item,
    changeState: { state: 'enabled', reason: null, updatedAt: null, error: null, digest: null },
    changeDirectory: directoryIdentity(join(f.repo, 'openspec', 'changes', item.change)) })) }
}

/** 临时门禁替身与进度替身使用同一登记根；未登记与项目内路径另由拒绝用例提供。 */
function gateDoublePath(f) {
  const file = join(f.config.trustedSkillRoots[0], 'openspec-technical-review/scripts/implementation-gate.mjs')
  mkdirSync(dirname(file), { recursive: true })
  return file
}

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
  const { viewFile, progressBin, skillRoot } = progressDouble(doublesDir, view || { root: repo, active: [schedEntry()], implementing: [], archived: [] })
  const { claudeBin, claudeCalls, claudeSignals } = claudeDouble(doublesDir, { output: claude })
  const { larkBin, larkCalls } = larkDouble(doublesDir, { messageId: lark || 'om_test' })
  const fullConfig = writeConfig(home, { claudeBin, larkBin, progressBin, gateBin, trustedSkillRoots: [skillRoot], projects: projects || [projectOf(repo)], ...config })

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
  // 进度替身补齐状态契约：契约完整、只缺 reviewStale 时沿用原作废规则（add-change-pause 评审 DB-14）。
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

// 「Failed card send is retried」改由 add-change-pause 任务 2.3 的发卡用例覆盖：只有确认未发出（not-sent）或尚未领取时才发送原决策卡片。

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
  // start 只运行可信安装根中的进度脚本，并核对已加载的服务（add-change-pause design D2、D4）：与 scenario 使用同一组替身。
  const { root: skillRoot, progressBin } = admissionProgress(home, { root: repo, active: [schedEntry()], implementing: [], archived: [] })
  writeConfig(home, { cancelWaitSeconds, progressBin, trustedSkillRoots: [skillRoot], projects: [projectOf(repo)] })
  const launchd = launchdDouble(home, home)
  const changeDir = join(repo, 'openspec', 'changes', 'demo')
  writeFiles(changeDir, { 'decisions/autopilot.json': recordValue })
  if (lock) writeFileSync(join(home, 'run.lock'), `${JSON.stringify(lock)}\n`)

  const run = (args, env = {}) => {
    const result = spawnSync(process.execPath, [autopilot, ...args], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: home, PATH: `${launchd.bin}${delimiter}${process.env.PATH}`, ...env },
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
`], { stdio: 'ignore', detached: true })
  return child
}

/** 读取替身的实际组实例，供 CLI 夹具写入运行锁。 */
function writerIdentity(pid) {
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return { state: 'published', pid, bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
      instance: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }
  }
  const bootId = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8' }).stdout.trim()
  const instance = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).stdout.trim()
  return { state: 'published', pid, bootId, instance }
}

function managedLock(f, pid, claudePid = null) {
  const record = f.record()
  return { pid, claudePid, bootTime: bootTime(), change: 'demo', projectRoot: realpathSync.native(f.repo),
    startedAt: record.startedAt, runId: 'cancel-fixture-run', ...(claudePid ? { writer: writerIdentity(claudePid) } : {}) }
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
  writeLock(f, managedLock(f, scheduler.pid, target.pid))
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
  const f = cancelScenario(t, { cancelWaitSeconds: 1 })
  writeLock(f, managedLock(f, target.pid, target.pid))
  const result = f.run(['cancel', 'demo'])
  assert.equal(result.code, 1, result.all)
  assert.ok(result.all.includes('仍在停止'), result.all)
  assert.equal(f.record().status, 'void')
})

test('锁中没有 claude 进程时撤回只等待锁释放，不发信号', t => {
  const scheduler = spawnSignalTarget()
  t.after(() => scheduler.kill('SIGKILL'))
  const f = cancelScenario(t, { lock: { pid: scheduler.pid, bootTime: bootTime(), change: 'demo', claudePid: null } })
  // 标记文件放在本用例的托管目录：分片同时运行时，其他用例写的标记不会影响本用例的判定。
  const marker = join(f.home, 'cancel-signal-marker')
  writeLock(f, managedLock(f, scheduler.pid))
  // 模拟调度进程：一秒后删除运行锁。
  spawnHelper(`require('node:fs').unlinkSync(${JSON.stringify(join(f.home, 'run.lock'))})`, 1000)
  const result = f.run(['cancel', 'demo'])
  assert.equal(result.code, 0, result.all)
  assert.equal(existsSync(marker), false, '不该向 claudePid 为 null 的情况发信号')
  assert.equal(f.record().status, 'void')
})

test('等待期间出现 claude 进程时补发一次 SIGTERM', t => {
  const scheduler = spawnSignalTarget()
  t.after(() => scheduler.kill('SIGKILL'))
  const f = cancelScenario(t, { lock: { pid: scheduler.pid, bootTime: bootTime(), change: 'demo', claudePid: null } })
  const marker = join(f.home, 'cancel-signal-marker')
  const target = spawnSignalTarget(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`)
  t.after(() => target.kill('SIGKILL'))
  writeLock(f, managedLock(f, scheduler.pid))
  // 模拟调度进程：一秒后写入 claudePid，再删除运行锁。
  spawnHelper(`const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(join(f.home, 'run.lock'))}, JSON.stringify(${JSON.stringify(managedLock(f, scheduler.pid, target.pid))}))
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
  writeLock(f, managedLock(f, scheduler.pid, target.pid))
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
  writeLock(f, managedLock(f, scheduler.pid, target.pid))
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
  // 阶段替身写出实际撤回状态，进度视图仍可列出该变更。
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([{
    file: join(f.changeDir, 'decisions', 'autopilot.json'), content: JSON.stringify(managedRecord({ status: 'void' })),
  }]))
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
  const original = enabledView(f)
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

test('SPEC-01：创建原决策后暂缓，首次发卡和恢复都不领取，恢复推进后只发原卡一次', async t => {
  for (const kind of ['exit', 'question']) await t.test(kind, st => {
    const f = kind === 'exit' ? exitScenario(st) : schedScenario(st, { claude: { session_id: 's1', stop_reason: 'tool_deferred',
      deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input: QUESTION } } })
    if (kind === 'exit') {
      writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
      draftPlan(f, { branch: 'fix/x', files: ['README.md'], message: '说明' })
      writeExitRecord(f, { implSnapshot: digestOf(f, ['README.md']) })
    }
    const stateFile = join(f.changeDir, 'change-state.json')
    const probe = join(f.doublesDir, 'pause-after-create.cjs')
    // 原决策的排他创建已完成，但调度尚未领取其卡片；仅在临时项目安排这次并发写入。
    writeFileSync(probe, `const fs = require('node:fs')
if (process.argv[1]?.endsWith('scheduler.mjs')) {
  const link = fs.linkSync
  fs.linkSync = (from, to) => {
    link(from, to)
    if (String(to).endsWith('D-0001.json')) fs.writeFileSync(${JSON.stringify(stateFile)}, ${JSON.stringify(stateText(SCHED_PAUSE))})
  }
  require('node:module').syncBuiltinESMExports()
}`)
    const run = env => kind === 'exit' ? f.run(env) : f.run(['--once'], env)
    for (const env of [{ NODE_OPTIONS: `--require "${probe}"` }, {}]) {
      const result = run(env)
      assert.equal(result.code, 0, result.all)
      const [decision] = f.decisions()
      assert.equal(decision.kind, kind)
      assert.equal(decision.card.sendState, 'unclaimed')
      assert.equal(decision.card.claim, undefined)
      assert.equal(decisionCards(f).length, 0)
      if (kind === 'question') assert.equal(Object.values(JSON.parse(readFileSync(join(f.home, 'pending-trace.json'))).entries)[0].resultDecisionId, decision.id)
    }
    rmSync(stateFile)
    for (let i = 0; i < 2; i++) assert.equal(run({}).code, 0)
    assert.equal(f.decisions()[0].card.sendState, 'sent')
    assert.equal(decisionCards(f).length, 1)
    assert.equal(f.claudeCalls().length, 1)
  })
})

test('已写决策在发卡前遇到撤回时作废且不发送', t => {
  const f = schedScenario(t, { claude: { session_id: 's1', stop_reason: 'tool_deferred',
    deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input: QUESTION } } })
  const probe = join(f.doublesDir, 'withdraw-before-send.cjs')
  writeFileSync(probe, `const fs = require('node:fs')
if (process.argv[1]?.endsWith('scheduler.mjs')) {
  const link = fs.linkSync
  fs.linkSync = (from, to) => {
    link(from, to)
    if (String(to).endsWith('D-0001.json')) {
      const record = ${JSON.stringify(join(f.changeDir, 'decisions', 'autopilot.json'))}
      const current = JSON.parse(fs.readFileSync(record))
      fs.writeFileSync(record, JSON.stringify({ ...current, status: 'void' }))
    }
  }
  require('node:module').syncBuiltinESMExports()
}
`)
  assert.equal(f.run(['--once'], { NODE_OPTIONS: `--require ${probe}` }).code, 0)
  const [decision] = f.decisions()
  assert.equal(decision.status, 'void')
  assert.equal(decision.voidReason, '托管已撤回')
  assert.equal(f.larkCalls().length, 0)
})

test('进度视图确认变更离开视图后只发通知并保留核对起点', t => {
  const f = schedScenario(t, { claude: { session_id: 's1', stop_reason: 'tool_deferred',
    deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input: QUESTION } } })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([{
    file: f.viewFile, content: JSON.stringify(view({ active: [] })),
  }]))
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.deepEqual(f.decisions(), [])
  assert.equal(f.larkCalls().length, 1)
  assert.match(f.larkCalls()[0].content, /托管不再处理/)
  const saved = JSON.parse(readFileSync(join(f.home, 'pending-trace.json'), 'utf8'))
  assert.equal(Object.values(saved.entries).length, 1)
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
  writeFileSync(impl, `import { appendFileSync, readFileSync, existsSync } from 'node:fs'\n`
    + `appendFileSync(${JSON.stringify(seen)}, JSON.parse(readFileSync(${JSON.stringify(d5)}, 'utf8')).status + '\\n')\n`
    + readFileSync(impl, 'utf8').replace(/^import .*\n/, ''))
  f.run()
  const byId = Object.fromEntries(f.decisions().map(item => [item.id, item]))
  assert.equal(byId['D-0005'].status, 'used')
  assert.equal(byId['D-0006'].status, 'pending')
  assert.equal(byId['D-0006'].kind, 'question')
  assert.equal(byId['D-0006'].card.sendState, 'sent', '替身须实际确认送达')
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
function traceRound(t, before, after, files = {}, progressEntry = schedEntry()) {
  const f = schedScenario(t, { files: { ...before, ...files }, view: view({ active: [progressEntry] }),
    claude: { session_id: 's1', stop_reason: 'end_turn', result: 'done' } })
  for (const rel of Object.keys(after)) mkdirSync(dirname(join(f.changeDir, rel)), { recursive: true })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify(Object.entries(after)
    .map(([rel, content]) => ({ file: join(f.changeDir, rel), content }))))
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 1)
  const alerts = f.decisions().filter(item => item.kind === 'alert')
  return {
    alerts,
    failures: alerts.length ? alerts[0].request.checkFailures || [] : [],
    card: f.larkCalls().map(call => call.content || '').join('\n'),
  }
}

/** 一份只有表头、可放入若干行的 Standards 报告。 */
const standardsReport = (findings = [], ledger = []) => `# Standards Review\n\n## Findings\n\n| ID | 严重级别 | 影响业务功能 | 位置 | 涉及代码模块 | 一句话白话 | 触发场景 | 不修的后果 | 建议修复 | 闭环状态 |\n|----|---------|------------|------|------------|-----------|---------|-----------|---------|---------|\n${findings.join('\n')}\n\n## Finding 台账\n\n| ID | 严重级别 | 首次轮次 | 状态 | 闭环轮次 | 闭环依据 |\n|----|---------|---------|------|---------|---------|\n${ledger.join('\n')}\n`

test('门禁核对：运行后旧报告的规则版本变化需要确认', t => {
  const report = standardsReport([findingRow('STD-02', 'Major')], [ledgerRow('STD-02', 'Major')])
  const before = report.replace('## Findings', '## 评审基线\n\n- Rules Version: 2\n\n## Findings')
  const { failures } = traceRound(t, { 'review/standards.md': before }, { 'review/standards.md': report })
  assert.ok(failures.some(item => item.file === 'review/standards.md' && item.field === 'Rules Version'),
    JSON.stringify(failures))
})

test('门禁核对：运行前读取失败保留重跑标记且同批次只通知一次', t => {
  const f = schedScenario(t, {
    view: view({ active: [schedEntry({ rule: 'R9', stage: 'verify' })] }),
    files: { 'decisions/autopilot.json': managedRecord({ rerunStage: 'quality' }) },
  })
  const gate = gateDoublePath(f)
  writeFileSync(gate, `if (process.argv[2] === 'trace') {
  process.stderr.write('合成读取失败详情')
  process.exitCode = 1
} else {
  process.stdout.write('usage: trace')
}\n`)
  writeConfig(f.home, { ...f.config, gateBin: gate })
  for (let round = 0; round < 2; round += 1) {
    const result = f.run()
    assert.equal(result.code, 0, result.all)
  }
  assert.equal(f.claudeCalls().length, 0)
  assert.deepEqual(f.decisions(), [])
  assert.equal(f.changeRecord().rerunStage, 'quality')
  const cards = f.larkCalls()
  assert.equal(cards.length, 1)
  assert.match(cards[0].content, /修复读取原因后等待下一轮/)
  assert.doesNotMatch(cards[0].content, /合成读取失败详情/)
})

test('恢复前读取失败保留已答决策且环境检查不清除通知原因', t => {
  const question = answeredQuestion()
  const f = schedScenario(t, { files: { 'decisions/D-0001.json': question } })
  const gate = gateDoublePath(f)
  writeFileSync(gate, "if (process.argv[2] === 'trace') process.exitCode = 1; else process.stdout.write('usage: trace')\n")
  writeConfig(f.home, { ...f.config, gateBin: gate })
  const file = join(f.changeDir, 'decisions', question.id + '.json')
  const before = readFileSync(file, 'utf8')
  assert.equal(f.run().code, 0)
  const errors = JSON.parse(readFileSync(join(f.home, 'rule-check.json'), 'utf8')).traceErrors
  assert.equal(Object.keys(errors).length, 1)
  assert.equal(Object.values(errors)[0].startedAt, f.changeRecord().startedAt)
  assert.equal(f.run().code, 0)
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'rule-check.json'), 'utf8')).traceErrors, errors)
  assert.equal(readFileSync(file, 'utf8'), before)
  assert.equal(f.claudeCalls().length, 0)
  assert.equal(f.larkCalls().length, 1)
})

test('前置核对通知在新批次出现同一原因时再次发送', t => {
  const f = schedScenario(t)
  const gate = gateDoublePath(f)
  writeFileSync(gate, "if (process.argv[2]) process.exitCode = 1; else process.stdout.write('usage: trace')\n")
  writeConfig(f.home, { ...f.config, gateBin: gate })
  assert.equal(f.run().code, 0)
  assert.equal(f.run().code, 0)
  assert.equal(f.larkCalls().length, 1)
  const result = spawnSync(process.execPath, [autopilot, 'cancel', 'demo'], { cwd: f.repo, encoding: 'utf8',
    env: { ...process.env, OPENSPEC_AUTOPILOT_HOME: f.home, HOME: f.userHome } })
  assert.equal(result.status, 0, result.stderr)
  // 新批次直接写出托管记录：start 只运行可信安装根中的脚本并核对已加载的服务（add-change-pause design D2、D4），
  // 本用例的门禁替身按设计读取失败，不能经 start 准入；本用例只验证调度按批次去重通知。
  writeFileSync(join(f.changeDir, 'decisions', 'autopilot.json'), `${JSON.stringify(managedRecord({ startedAt: '2026-11-24T00:00:00Z' }))}\n`)
  assert.equal(f.run().code, 0)
  assert.equal(f.larkCalls().length, 2)
  assert.equal(f.claudeCalls().length, 0)
})

test('门禁核对：变更后快照不可读时保留原起点', t => {
  const before = standardsReport([findingRow('STD-02', 'Blocker')], [ledgerRow('STD-02', 'Blocker')])
  const f = schedScenario(t, { files: { 'review/standards.md': before } })
  const gate = gateDoublePath(f)
  const marker = join(f.doublesDir, 'trace-check-failure')
  writeFileSync(gate, `import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
if (process.argv[2] === 'trace' && existsSync(${JSON.stringify(marker)})) {
  process.stderr.write('合成读取失败详情')
  process.exitCode = 2
} else {
  const child = spawnSync(process.execPath, [${JSON.stringify(gateBin)}, ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exitCode = child.status
}\n`)
  writeConfig(f.home, { ...f.config, gateBin: gate })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([{ file: marker, content: '' }]))
  assert.equal(f.run().code, 0)
  const [alert] = f.decisions()
  assert.equal(alert.kind, 'alert')
  assert.equal(alert.request.comparisonState, 'unread')
  assert.match(alert.request.text, /选「回会话处理」后，托管不再列出这次运行的修改/)
  assert.match(f.larkCalls()[0].content, /托管不再列出这次运行的修改/)
  assert.deepEqual(alert.request.traceBefore.resumedDecisionIds, [])
  assert.ok(alert.request.traceBefore.findings.some(item => item.id === 'STD-02' && item.openBlocker))
  assert.doesNotMatch(JSON.stringify(alert.request), /合成读取失败详情/)
})

test('连续两次读取失败的告警沿用初次快照并记录恢复编号', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards() } })
  const fixture = join(f.doublesDir, 'claude.mjs')
  const original = readFileSync(fixture, 'utf8')
  const sonar = join(f.changeDir, 'review', 'sonar.md')
  const blocked = `${original}\nimport { mkdirSync } from 'node:fs'\nmkdirSync(${JSON.stringify(sonar)})\n`
  const effect = join(f.doublesDir, 'effect.json')
  writeFileSync(effect, JSON.stringify([{ file: join(f.changeDir, 'review', 'standards.md'), content: acceptedStandards() }]))
  const continueWith = alert => writeFiles(f.changeDir, { [`decisions/${alert.id}.json`]: { ...alert, status: 'answered',
    answer: { operatorId: 'ou_owner', choice: '补充说明后继续', text: '原因已修复' } } })
  writeFileSync(fixture, blocked)
  assert.equal(f.run().code, 0)
  const [first] = f.decisions()
  assert.equal(first.request.comparisonState, 'unread')
  assert.match(first.request.text, /无法读取处理记录/)
  rmSync(sonar, { recursive: true })
  continueWith(first)
  assert.equal(f.run().code, 0)
  const second = f.decisions().at(-1)
  assert.deepEqual(second.request.traceBefore.findings, first.request.traceBefore.findings)
  assert.deepEqual(second.request.traceBefore.resumedDecisionIds, [first.id])
  rmSync(sonar, { recursive: true })
  rmSync(effect)
  writeFileSync(fixture, original)
  continueWith(second)
  assert.equal(f.run().code, 0)
  const third = f.decisions().at(-1)
  assert.equal(third.request.comparisonState, 'listed')
  assert.ok(third.request.checkFailures.some(item => item.finding === 'STD-02'))
})

for (const [label, result] of [
  ['无会话编号', '没有有效会话'],
  ['新提问已挂起', { session_id: 's1', stop_reason: 'tool_deferred',
    deferred_tool_use: { name: 'AskUserQuestion', id: 'T-blocked', input: QUESTION } }],
]) {
  test(`核对失败优先处理运行结果：${label}`, t => {
    const f = schedScenario(t, { files: { 'review/standards.md': openStandards() }, claude: result })
    writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([
      { file: join(f.changeDir, 'review', 'standards.md'), content: acceptedStandards() },
    ]))
    assert.equal(f.run().code, 0)
    const [alert] = f.decisions()
    assert.equal(f.decisions().length, 1)
    assert.equal(alert.kind, 'alert')
    assert.ok(alert.request.checkFailures.some(item => item.finding === 'STD-02'))
    if (typeof result === 'string') assert.deepEqual(alert.request.options, ['回会话处理'])
    else assert.equal(alert.request.deferredToolUseId, 'T-blocked')
  })
}

test('会话无法恢复时保留核对告警并且没有阶段重跑通知', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards(),
    'decisions/D-0001.json': answeredQuestion() }, claude: 'No conversation found' })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([
    { file: join(f.changeDir, 'review', 'standards.md'), content: acceptedStandards() },
  ]))
  assert.equal(f.run().code, 0)
  const [question, alert] = f.decisions()
  assert.equal(question.status, 'void')
  assert.deepEqual(alert.request.options, ['回会话处理'])
  assert.ok(alert.request.checkFailures.some(item => item.finding === 'STD-02'))
  assert.equal(f.changeRecord().rerunStage, 'quality')
  assert.ok(f.larkCalls().every(item => !item.content?.includes('阶段将重跑')))
})

test('未读告警的会话失效时仍按原起点列出修改', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards() } })
  const original = { ...traceFrom(f), resumedDecisionIds: [] }
  const source = { id: 'D-0003', kind: 'alert', status: 'answered', stage: 'quality',
    request: { sessionId: 's1', traceBefore: original, comparisonState: 'unread', options: ['补充说明后继续', '回会话处理'] },
    answer: { operatorId: 'ou_owner', choice: '补充说明后继续', text: '读取问题已恢复' },
  }
  writeFiles(f.changeDir, { 'review/standards.md': acceptedStandards(), 'decisions/D-0003.json': source })
  setClaudeOutput(f.doublesDir, 'No conversation found')
  assert.equal(f.run().code, 0)
  const [prior, alert] = f.decisions()
  assert.equal(prior.status, 'void')
  assert.deepEqual(prior.request, source.request)
  assert.deepEqual(alert.request.options, ['回会话处理'])
  assert.deepEqual(alert.request.traceBefore.findings, original.findings)
  assert.ok(alert.request.checkFailures.some(item => item.finding === 'STD-02'))
  assert.equal(f.changeRecord().rerunStage, 'quality')
  assert.ok(f.larkCalls().every(item => !item.content?.includes('阶段将重跑')))
})

for (const excess of [0, 1]) {
  test(`继续告警合入编号后的 4 MiB 边界：${excess}`, t => {
    const f = schedScenario(t)
    const boundary = { ...traceFrom(f), resumedDecisionIds: [], fixture: '' }
    const size = Buffer.byteLength(JSON.stringify({ ...boundary, resumedDecisionIds: ['D-0001'] }))
    const count = 4 * 1024 * 1024 + excess - size
    boundary.fixture = '界'.repeat(Math.floor(count / 3)) + 'x'.repeat(count % 3)
    const alert = { id: 'D-0001', status: 'answered', kind: 'alert', stage: 'quality',
      request: { sessionId: 's1', comparisonState: 'unread', traceBefore: boundary },
      answer: { operatorId: 'ou_owner', choice: '补充说明后继续', text: '继续核对' },
    }
    writeFiles(f.changeDir, { 'decisions/D-0001.json': alert })
    assert.equal(f.run().code, 0)
    if (excess) {
      assert.equal(f.claudeCalls().length, 0)
      assert.deepEqual(f.decisions(), [alert])
      assert.match(f.larkCalls()[0].content, /续查起点超过 4 MiB/)
    } else {
      assert.equal(f.claudeCalls().length, 1)
      assert.equal(f.decisions()[0].status, 'used')
    }
  })
}

for (const excess of [0, 1]) {
  test(`告警发出前按预留编号校验续查容量：${excess}`, t => {
    const f = schedScenario(t)
    const original = { ...traceFrom(f), resumedDecisionIds: [], fixture: '' }
    const count = 4 * 1024 * 1024 + excess
      - Buffer.byteLength(JSON.stringify({ ...original, resumedDecisionIds: ['D-0001'] }))
    original.fixture = '界'.repeat(Math.floor(count / 3)) + 'x'.repeat(count % 3)
    const snapshotFile = join(f.doublesDir, 'snapshot.json')
    const marker = join(f.doublesDir, 'after-stage')
    const gate = gateDoublePath(f)
    writeFileSync(snapshotFile, JSON.stringify(original))
    writeFileSync(gate, `import { readFileSync, existsSync } from 'node:fs'
if (process.argv[2] !== 'trace') process.stdout.write('usage: trace')
else if (existsSync(${JSON.stringify(marker)})) process.exitCode = 2
else process.stdout.write(readFileSync(${JSON.stringify(snapshotFile)}, 'utf8'))
`)
    writeConfig(f.home, { ...f.config, gateBin: gate })
    writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([{ file: marker, content: '' }]))
    assert.equal(f.run().code, 0)
    assert.equal(f.claudeCalls().length, 1)
    const [alert] = f.decisions()
    assert.deepEqual(alert.request.traceBefore, original)
    assert.deepEqual(alert.request.options, excess ? ['回会话处理'] : ['补充说明后继续', '回会话处理'])
    assert.equal(f.larkCalls().length, 1)
    if (excess) assert.ok(!f.larkCalls()[0].content.includes('"text": "补充说明后继续"'))
  })
}

test('真实已列明告警续查不重报已展示差异且保留历史起点', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards() } })
  const effect = join(f.doublesDir, 'effect.json')
  writeFileSync(effect, JSON.stringify([{ file: join(f.changeDir, 'review', 'standards.md'), content: acceptedStandards() }]))
  assert.equal(f.run().code, 0)
  const [first] = f.decisions()
  assert.equal(first.request.comparisonState, 'listed')
  assert.ok(first.request.checkFailures.some(item => item.finding === 'STD-02'))
  assert.ok(first.request.traceBefore.findings.some(item => item.id === 'STD-02' && item.openBlocker))
  assert.ok(first.request.comparisonBoundary.findings.some(item => item.id === 'STD-02' && item.status === 'risk-accepted'))
  writeFiles(f.changeDir, { [`decisions/${first.id}.json`]: { ...first, status: 'answered',
    answer: { operatorId: 'ou_owner', choice: '补充说明后继续', text: '保留已列明问题，继续实施' } } })
  writeFileSync(effect, JSON.stringify([{ file: join(f.changeDir, 'notes.md'), content: '本轮继续实施\n' }]))
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 2)
  assert.equal(f.decisions().length, 1)
  assert.equal(f.decisions()[0].status, 'used')
  assert.deepEqual(f.decisions()[0].request, first.request)
})

test('已列明告警按后置边界核对等待期间的再次改动', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards() } })
  const effect = join(f.doublesDir, 'effect.json')
  const report = join(f.changeDir, 'review', 'standards.md')
  writeFileSync(effect, JSON.stringify([{ file: report, content: acceptedStandards() }]))
  assert.equal(f.run().code, 0)
  const [first] = f.decisions()
  writeFileSync(report, acceptedStandards().replaceAll('risk-accepted', 'false-positive'))
  writeFiles(f.changeDir, { [`decisions/${first.id}.json`]: { ...first, status: 'answered',
    answer: { operatorId: 'ou_owner', choice: '补充说明后继续', text: '检查等待期间的改动' } } })
  writeFileSync(effect, JSON.stringify([{ file: join(f.changeDir, 'notes.md'), content: '继续实施\n' }]))
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 2)
  const [source, next] = f.decisions()
  assert.deepEqual(source.request, first.request)
  assert.deepEqual(next.request.traceBefore.findings, first.request.comparisonBoundary.findings)
  assert.deepEqual(next.request.traceBefore.resumedDecisionIds, [first.id])
  assert.ok(next.request.checkFailures.some(item => item.finding === 'STD-02'
    && item.before === 'risk-accepted' && item.after === 'false-positive'))
})

test('普通阶段告警用已核对的后置快照查找等待期间的变化', t => {
  const f = schedScenario(t, { claude: { session_id: 's1', is_error: true, result: '测试阶段错误' } })
  mkdirSync(join(f.changeDir, 'review'))
  const report = join(f.changeDir, 'review', 'standards.md')
  const effect = join(f.doublesDir, 'effect.json')
  writeFileSync(effect, JSON.stringify([{ file: report, content: openStandards() }]))
  assert.equal(f.run().code, 0)
  const [prior] = f.decisions()
  assert.equal(prior.kind, 'alert')
  assert.equal(prior.request.comparisonState, 'stage')
  rmSync(report)
  rmSync(effect)
  writeFiles(f.changeDir, { 'decisions/D-0001.json': { ...prior, status: 'answered',
    answer: { operatorId: 'ou_owner', choice: '补充说明后继续', text: '继续' } } })
  setClaudeOutput(f.doublesDir, { session_id: 's1', stop_reason: 'end_turn', result: '完成' })
  assert.equal(f.run().code, 0)
  assert.ok(f.decisions()[1].request.checkFailures.some(item => item.finding === 'STD-02'))
})

test('仅已列明告警的续查边界版本不符时转交而不恢复', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards() } })
  const original = { ...traceFrom(f), resumedDecisionIds: [] }
  const source = { id: 'D-0003', kind: 'alert', status: 'answered', stage: 'quality',
    request: { sessionId: 's1', traceBefore: original, comparisonState: 'listed',
      comparisonBoundary: { ...original, traceVersion: 0 }, options: ['补充说明后继续', '回会话处理'] },
    answer: { operatorId: 'ou_owner', choice: '补充说明后继续', text: '继续核对' },
  }
  writeFiles(f.changeDir, { 'decisions/D-0003.json': source })
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 0)
  const [prior, replacement] = f.decisions()
  assert.equal(prior.status, 'used')
  assert.deepEqual(prior.request, source.request)
  assert.deepEqual(replacement.request.traceBefore, original)
  assert.deepEqual(replacement.request.options, ['回会话处理'])
  assert.match(replacement.request.text, /版本与当前不同/)
  assert.equal(replacement.request.checkFailures, undefined)
})

test('核对版本转交保留原起点并沿用唯一的回会话告警', t => {
  const original = { traceVersion: 0, findings: [], resumedDecisionIds: ['D-0002'] }
  const f = schedScenario(t, { files: {
    'decisions/D-0003.json': {
      id: 'D-0003', kind: 'alert', status: 'answered', stage: 'quality',
      request: { sessionId: 's1', traceBefore: original, comparisonState: 'unread', options: ['补充说明后继续'] },
      answer: { operatorId: 'ou_owner', choice: '补充说明后继续', text: '继续核对' },
    },
  } })
  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 0)
  const [source, replacement] = f.decisions()
  assert.equal(source.status, 'used')
  assert.deepEqual(replacement.request.traceBefore, original)
  assert.deepEqual(replacement.request.options, ['回会话处理'])
  assert.match(replacement.request.text, /版本与当前不同/)
  assert.equal(f.run().code, 0)
  assert.deepEqual(f.decisions().map(item => item.id), ['D-0003', 'D-0004'])
})

for (const sample of GATE_TRACE_SAMPLES.filter(item => ['状态带反引号', '状态大写', '三级小标题',
  '删除分隔行', '同名闭环状态列', '大写严重级别', '同 ID 的两行互换严重级别'].includes(item.name))) {
  test(`调度读取门禁认出的报告变化：${sample.name}`, t => {
    const after = sample.name === '三级小标题' ? sample.text.replace(/(src\/order\.js:[^\n]*\| )open/, '$1risk-accepted') : sample.text
    const { failures } = traceRound(t, { [sample.file]: sample.before || STANDARD_TRACE_REPORT }, { [sample.file]: after })
    assert.ok(failures.some(item => item.finding === 'STD-02'), JSON.stringify(failures))
  })
}

const envTasks = '# Tasks\n\n## Slice 02: 次要环境\nEnvironment: MQ\nEvidence: evidence/slice-02.md\n\n- [x] 2.1 实现行为\n'
const envEvidence = '# Slice 02\n\n- Fingerprint: git-tree:abc\n\n## 待环境补测\n| 登记指纹 | 原因 | 补测计划 | 负责人 | 确认人 | 日期 |\n|---|---|---|---|---|---|\n| git-tree:abc | MQ | 复验 | tester | | 2026-11-20 |\n'
const envBefore = { 'tasks.md': envTasks, 'evidence/slice-02.md': envEvidence }
for (const [name, change] of [
  ['移除环境声明', { 'tasks.md': envTasks.replace('Environment: MQ\n', '') }],
  ['切片不再完整', { 'tasks.md': envTasks + '- [ ] 2.2 核验新行为\n' }],
  ['移除登记', { 'evidence/slice-02.md': envEvidence.split('\n').slice(0, -2).join('\n') }],
  ['重记指纹后的登记缺失', { 'evidence/slice-02.md': envEvidence.replace('Fingerprint: git-tree:abc', 'Fingerprint: git-tree:new') }],
]) {
  test(`门禁核对识别待环境补测变化：${name}`, t => {
    const { failures } = traceRound(t, envBefore, change)
    assert.ok(failures.some(item => ['tasks.md', 'evidence/slice-02.md'].includes(item.file)), JSON.stringify(failures))
  })
}

for (const [name, before, after, expected] of [
  ['签字边界的变更终点', { 'tasks.md': '##  变更终点\n- 判定人：甲\n' },
    { 'tasks.md': '##  变更终点\n- 判定人：乙\n' }, '变更终点'],
  ['分镜采用围栏外首个签署行', { 'storyboard.md': 'Storyboard Approved: ____\n' },
    { 'storyboard.md': 'Storyboard Approved: tester\nStoryboard Approved: ____\n' }, 'Storyboard Approved'],
  ['同一待环境补测指纹增加确认人', envBefore,
    { 'evidence/slice-02.md': envEvidence.replace('| tester | |', '| tester | owner |') + envEvidence.trimEnd().split('\n').at(-1) + '\n' }, '确认人'],
  ['待环境补测双空格标题', { ...envBefore, 'evidence/slice-02.md': envEvidence.replace('## 待环境补测', '##  待环境补测') },
    { 'evidence/slice-02.md': envEvidence.replace('## 待环境补测', '##  待环境补测').replace('| tester | |', '| tester | owner |') }, '确认人'],
  ['完全勾选切片取消一项', envBefore, { 'tasks.md': envTasks.replace('[x]', '[ ]') }, '待环境补测切片'],
  ['切片标题缺少冒号', envBefore, { 'tasks.md': envTasks.replace('02:', '02') }, '待环境补测切片'],
  ['切片标题变成三级', envBefore, { 'tasks.md': envTasks.replace('## Slice', '### Slice') }, '待环境补测切片'],
  ['环境声明后出现二级标题', envBefore, { 'tasks.md': envTasks.replace('Evidence:', '## Other\nEvidence:') }, '待环境补测切片'],
  ['Sonar 质量门新增接受', { 'review/sonar.md': '## 质量门\n| 条件 | 处理 |\n|---|---|\n| 覆盖率 | 修复 |\n' },
    { 'review/sonar.md': '## 质量门\n| 条件 | 处理 |\n|---|---|\n| 覆盖率 | 接受 |\n' }, '处理'],
]) {
  test(`运行前后字段变化触发核对：${name}`, t => {
    const { failures } = traceRound(t, before, after)
    assert.ok(failures.some(item => item.field === expected), JSON.stringify(failures))
  })
}

for (const [name, before, after, progressEntry] of [
  ['首次写规则版本', {}, { 'review/standards.md': STANDARD_TRACE_REPORT,
    'review/spec-fidelity.md': STANDARD_TRACE_REPORT }, schedEntry({ rule: 'R8', stage: 'quality' })],
  ['发现空状态与台账 open 一致', { 'review/standards.md': openStandards() },
    { 'review/standards.md': standardsReport([findingRow('STD-02', 'Blocker', '')], [ledgerRow('STD-02', 'Blocker')]) }],
  ['原有不一致没有发生变化', { 'review/standards.md': standardsReport([findingRow('STD-02', 'Blocker')],
    [ledgerRow('STD-02', 'Blocker', 'risk-accepted')]) }, { 'notes.md': '# 本轮修改\n' }],
  ['已接受发现移出且台账不变', { 'review/standards.md': acceptedStandards() },
    { 'review/standards.md': standardsReport([], [ledgerRow('STD-02', 'Blocker', 'risk-accepted')]) },
    schedEntry({ rule: 'R8', stage: 'quality' })],
  ['另一个切片勾选不影响未开始的环境切片', { 'tasks.md': '## Slice 01: 验收\n- [ ] 1.1 任务\n' + envTasks.replace('[x]', '[ ]') },
    { 'tasks.md': '## Slice 01: 验收\n- [x] 1.1 任务\n' + envTasks.replace('[x]', '[ ]') }],
]) {
  test(`正常变更不触发核对告警：${name}`, t => {
    const { failures, alerts } = traceRound(t, before, after, {}, progressEntry)
    assert.deepEqual(failures, [])
    assert.deepEqual(alerts, [])
  })
}

test('恢复未读告警时继续识别原先有效的风险接受回复', t => {
  const question = answeredQuestion({ id: 'D-0001', request: { sessionId: 's1', toolUseId: 'T1',
    questions: [{ header: 'STD-02', question: '如何处理？' }] },
  answer: { operatorId: 'ou_owner', selected: { 'STD-02': 'risk accepted' } } })
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards(), 'decisions/D-0001.json': question } })
  const program = join(f.doublesDir, 'claude.mjs')
  const normal = readFileSync(program, 'utf8')
  const sonar = join(f.changeDir, 'review', 'sonar.md')
  writeFileSync(program, `${normal}\nimport { mkdirSync } from 'node:fs'\nmkdirSync(${JSON.stringify(sonar)})\n`)
  const effect = join(f.doublesDir, 'effect.json')
  writeFileSync(effect, JSON.stringify([{ file: join(f.changeDir, 'review', 'standards.md'), content: acceptedStandards() }]))
  assert.equal(f.run().code, 0)
  const first = f.decisions().at(-1)
  assert.deepEqual(first.request.traceBefore.resumedDecisionIds, ['D-0001'])
  rmSync(sonar, { recursive: true })
  rmSync(effect)
  writeFileSync(program, normal)
  writeFiles(f.changeDir, { [`decisions/${first.id}.json`]: { ...first, status: 'answered',
    answer: { operatorId: 'ou_owner', choice: '补充说明后继续', text: '恢复核对' } } })
  assert.equal(f.run().code, 0)
  assert.equal(f.decisions().find(item => item.id === first.id).status, 'used')
  assert.ok(f.decisions().filter(item => item.id > first.id).every(item =>
    !item.request.checkFailures?.some(failure => failure.finding === 'STD-02')))
})

test('后置门禁快照版本不匹配时只报告读取失败', t => {
  const f = schedScenario(t)
  const gate = gateDoublePath(f)
  const marker = join(f.doublesDir, 'after-stage')
  const before = traceFrom(f)
  writeFileSync(gate, `import { existsSync } from 'node:fs'
if (process.argv[2] === 'trace') {
  const snapshot = ${JSON.stringify(before)}
  if (existsSync(${JSON.stringify(marker)})) snapshot.traceVersion = 2
  process.stdout.write(JSON.stringify(snapshot))
} else process.stdout.write('usage: trace')
`)
  writeConfig(f.home, { ...f.config, gateBin: gate })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([{ file: marker, content: '' }]))
  assert.equal(f.run().code, 0)
  const [alert] = f.decisions()
  assert.equal(alert.request.comparisonState, 'unread')
  assert.match(alert.request.checkFailures[0].after, /版本不匹配/)
})

test('门禁没有 trace 子命令时停止这一轮', t => {
  const f = schedScenario(t)
  const gate = gateDoublePath(f)
  writeFileSync(gate, "process.stderr.write('implementation-gate.mjs facts')\n")
  writeConfig(f.home, { ...f.config, gateBin: gate })
  assert.equal(f.run().code, 2)
  assert.equal(f.claudeCalls().length, 0)
  assert.match(f.larkCalls()[0].content, /同步 openspec-technical-review/)
})

test('调度拒绝从项目内部或相对路径载入门禁脚本', t => {
  const f = schedScenario(t)
  const internal = join(f.repo, 'gate.mjs')
  const alias = join(f.doublesDir, 'gate-alias.mjs')
  const marker = join(f.doublesDir, 'unexpected-gate-run')
  writeFileSync(internal, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, '')\n`)
  symlinkSync(internal, alias)
  for (const path of [internal, alias, 'gate.mjs']) {
    writeConfig(f.home, { ...f.config, gateBin: path })
    assert.equal(f.run().code, 2)
    assert.equal(f.claudeCalls().length, 0)
    assert.equal(existsSync(marker), false)
  }
})

test('真实门禁拒绝归属不明资料且调度只转交安全类别', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards() } })
  const report = join(f.changeDir, 'review', 'standards.md')
  const outside = join(f.doublesDir, 'unverified-report.md')
  const marker = 'SYNTHETIC_UNVERIFIED_CONTENT_8f93'
  writeFileSync(outside, acceptedStandards() + marker)
  const program = join(f.doublesDir, 'claude.mjs')
  writeFileSync(program, readFileSync(program, 'utf8') + `\nimport { unlinkSync, symlinkSync } from 'node:fs'\nunlinkSync(${JSON.stringify(report)})\nsymlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(report)})\n`)
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 1)
  const [alert] = f.decisions()
  assert.equal(alert.request.comparisonState, 'unread')
  assert.ok(alert.request.traceBefore.findings.some(item => item.id === 'STD-02' && item.openBlocker))
  assert.match(alert.request.checkFailures[0].after, /评审报告：类型或链接无效/)
  const output = JSON.stringify([alert, f.larkCalls()])
  assert.ok(!output.includes(marker))
  assert.ok(!output.includes(outside))
})

test('门禁路径与项目根大小写不同时仍拒绝执行项目内脚本', t => {
  const f = schedScenario(t)
  const internal = join(f.repo, 'gate.mjs')
  const differentlyCased = join(f.repo.toUpperCase(), 'gate.mjs')
  const marker = join(f.doublesDir, 'unexpected-gate-run')
  writeFileSync(internal, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, '')\n`)
  if (!existsSync(differentlyCased)) return t.skip('文件系统区分大小写')
  writeConfig(f.home, { ...f.config, gateBin: differentlyCased })
  assert.equal(f.run().code, 2)
  assert.equal(f.claudeCalls().length, 0)
  assert.equal(existsSync(marker), false)
})

test('历史用于另一次核对的风险接受没有效力', t => {
  const history = answeredQuestion({ id: 'D-0002', status: 'used',
    request: { sessionId: 's0', toolUseId: 'T0', questions: [{ header: 'STD-02' }] },
    answer: { operatorId: 'ou_owner', selected: { 'STD-02': 'risk accepted' } },
  })
  const { failures } = traceRound(t, { 'review/standards.md': openStandards() },
    { 'review/standards.md': acceptedStandards() }, { 'decisions/D-0002.json': history })
  assert.ok(failures.some(item => item.finding === 'STD-02'))
})

for (const [name, before, after, history = false] of [
  ['接受改为误报', acceptedStandards(), acceptedStandards().replaceAll('risk-accepted', 'false-positive')],
  ['同编号第二行改为接受',
    standardsReport([findingRow('STD-02', 'Minor', 'risk-accepted'), findingRow('STD-02', 'Blocker')],
      [ledgerRow('STD-02', 'Blocker')]),
    standardsReport([findingRow('STD-02', 'Minor', 'risk-accepted'), findingRow('STD-02', 'Blocker', 'risk-accepted')],
      [ledgerRow('STD-02', 'Blocker', 'risk-accepted')])],
  ['历史接受不能授权交换严重级别',
    standardsReport([findingRow('STD-02', 'Minor', 'risk-accepted'), findingRow('STD-02', 'Blocker')],
      [ledgerRow('STD-02', 'Blocker')]),
    standardsReport([findingRow('STD-02', 'Blocker', 'risk-accepted'), findingRow('STD-02', 'Minor')],
      [ledgerRow('STD-02', 'Blocker')]), true],
  ['历史接受不能授权第二行接受',
    standardsReport([findingRow('STD-02', 'Minor', 'risk-accepted'), findingRow('STD-02', 'Blocker')],
      [ledgerRow('STD-02', 'Blocker')]),
    standardsReport([findingRow('STD-02', 'Minor', 'risk-accepted'), findingRow('STD-02', 'Blocker', 'risk-accepted')],
      [ledgerRow('STD-02', 'Blocker', 'risk-accepted')]), true],
]) {
  test(`核对接受变化的授权边界：${name}`, t => {
    const files = history ? { 'decisions/D-0002.json': answeredQuestion({ id: 'D-0002', status: 'used',
      request: { sessionId: 's0', toolUseId: 'T0', questions: [{ header: 'STD-02' }] },
      answer: { operatorId: 'ou_owner', selected: { 'STD-02': 'risk accepted' } },
    }) } : {}
    const { failures, alerts } = traceRound(t, { 'review/standards.md': before },
      { 'review/standards.md': after }, files, schedEntry({ rule: 'R8', stage: 'quality' }))
    assert.equal(alerts.length, 1)
    assert.ok(failures.some(item => item.finding === 'STD-02'), JSON.stringify(failures))
  })
}

for (const status of ['closed', 'open']) {
  test(`Findings 移入上轮闭环验证时核对台账：${status}`, t => {
    const before = standardsReport([findingRow('SPEC-01', 'Blocker')], [ledgerRow('SPEC-01', 'Blocker')])
    const after = standardsReport([], [ledgerRow('SPEC-01', 'Blocker', status)])
      + '\n## 上轮闭环验证\n\n| ID | 严重级别 | 闭环状态 |\n|---|---|---|\n| SPEC-01 | Blocker | closed |\n'
    const { alerts, failures } = traceRound(t, { 'review/spec-fidelity.md': before },
      { 'review/spec-fidelity.md': after }, {}, schedEntry({ rule: 'R8', stage: 'quality' }))
    if (status === 'closed') assert.deepEqual(alerts, [])
    else {
      assert.equal(alerts.length, 1)
      assert.ok(failures.some(item => item.finding === 'SPEC-01'))
    }
  })
}

test('没有台账的旧报告删除开放 Major 时仍发告警', t => {
  const before = standardsReport([findingRow('STD-06', 'Major')]).split('## Finding 台账')[0]
  const after = before.replace(findingRow('STD-06', 'Major'), '')
  const { failures, alerts } = traceRound(t, { 'review/standards.md': before }, { 'review/standards.md': after })
  assert.equal(alerts.length, 1)
  assert.ok(failures.some(item => item.finding === 'STD-06' && item.after === '消失'))
})

test('核对先使用编号较大的相同问题回复', t => {
  const makeDecision = (id, status, selected) => answeredQuestion({ id, status,
    request: { sessionId: 's1', toolUseId: 'T2', questions: [{ header: 'STD-02', question: '怎么处理？' }] },
    answer: { operatorId: 'ou_owner', selected: { 'STD-02': selected } },
  })
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards(),
    'decisions/D-0002.json': makeDecision('D-0002', 'used', 'risk accepted'),
    'decisions/D-0005.json': makeDecision('D-0005', 'used', '修复'),
  } })
  writeFiles(f.changeDir, { 'decisions/D-0006.json': { id: 'D-0006', kind: 'alert', stage: 'quality', status: 'answered',
    request: { sessionId: 's1', comparisonState: 'unread',
      traceBefore: { ...traceFrom(f), resumedDecisionIds: ['D-0002', 'D-0005'] } },
    answer: { operatorId: 'ou_owner', choice: '补充说明后继续', text: '请继续核对' },
  } })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([
    { file: join(f.changeDir, 'review', 'standards.md'), content: acceptedStandards() },
  ]))
  assert.equal(f.run().code, 0)
  assert.ok(f.decisions().at(-1).request.checkFailures.some(item => item.finding === 'STD-02'))
})

test('Sonar 接受改成误报也需要对应回复', t => {
  const sonar = status => `## 质量门\n| 条件 | 处理 |\n|---|---|\n| 覆盖率 | ${status} |\n`
  const { failures } = traceRound(t, { 'review/sonar.md': sonar('接受') }, { 'review/sonar.md': sonar('误报') })
  assert.ok(failures.some(item => item.finding === '覆盖率' && item.after === '误报'))
})

test('核对只接受与新状态完全对应的提问选项', t => {
  const question = 'STD-02 怎么处理？'
  const record = answeredQuestion({ id: 'D-0003',
    request: { sessionId: 's1', toolUseId: 'T1', questions: [{ question, header: 'STD-02' }] },
    answer: { operatorId: 'ou_owner', selected: { 'STD-02': 'risk accepted' }, text: {}, answers: { [question]: 'risk accepted' } },
  })
  const report = status => standardsReport([findingRow('STD-02', 'Major', status)], [ledgerRow('STD-02', 'Major', status)])
  const { failures, card } = traceRound(t, { 'review/standards.md': report('open') },
    { 'review/standards.md': report('false-positive') }, { 'decisions/D-0003.json': record })
  assert.ok(failures.some(item => item.finding === 'STD-02'))
  assert.match(card, /false-positive/)
})

test('核对不会用选项覆盖同时提交的自填说明', t => {
  const text = '不同意该处理，请保留问题'
  const record = answeredQuestion({ id: 'D-0003',
    request: { sessionId: 's1', toolUseId: 'T1', questions: [{ question: '怎么处理？', header: 'STD-02' }] },
    answer: { operatorId: 'ou_owner', selected: { 'STD-02': 'risk accepted' }, text: { 'STD-02': text },
      answeredAt: '2026-11-20T07:00:00Z' },
  })
  const { failures, card } = traceRound(t, { 'review/standards.md': openStandards() },
    { 'review/standards.md': acceptedStandards() }, { 'decisions/D-0003.json': record })
  const failure = failures.find(item => item.finding === 'STD-02' && item.note?.includes(text))
  assert.ok(failure)
  assert.equal(failure.answeredAt, '2026-11-20T07:00:00Z')
  assert.ok(card.includes(text))
})

test('核对允许把已关闭的发现移出报告正文', t => {
  const closed = standardsReport([], [ledgerRow('STD-02', 'Blocker', 'closed')])
  const { failures } = traceRound(t, { 'review/standards.md': openStandards() }, { 'review/standards.md': closed })
  assert.deepEqual(failures, [])
})

test('仅改变门禁认出的进度条目也算有进展', t => {
  const f = schedScenario(t)
  const changes = view({ active: [schedEntry({ rule: 'R7', tasks: { done: 1, total: 3 } })] })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([{ file: f.viewFile, content: JSON.stringify(changes) }]))
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 1)
  assert.deepEqual(f.decisions(), [])
})

function pendingState(f) {
  return JSON.parse(readFileSync(join(f.home, 'pending-trace.json'), 'utf8'))
}

function openStandards() {
  return standardsReport([findingRow('STD-02', 'Blocker')], [ledgerRow('STD-02', 'Blocker')])
}

function acceptedStandards() {
  return standardsReport([findingRow('STD-02', 'Blocker', 'risk-accepted')], [ledgerRow('STD-02', 'Blocker', 'risk-accepted')])
}

function traceFrom(f) {
  const result = spawnSync(process.execPath, [gateBin, 'trace', f.changeDir], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function savedTraceFixture(f, overrides = {}) {
  const root = realpathSync.native(f.repo)
  const startedAt = f.changeRecord().startedAt
  const key = JSON.stringify([root, 'demo', startedAt])
  return { key, saved: {
    root, name: 'demo', startedAt, directory: realpathSync.native(f.changeDir), location: 'active',
    mode: 'stage', stage: 'apply', runId: 'fixture-previous-run', writer: { state: 'exited' },
    traceBefore: { ...traceFrom(f), resumedDecisionIds: [] }, ...overrides,
  } }
}

for (const stage of ['answered', 'used']) {
  test(`版本转交从原告警为 ${stage} 的断点恢复`, t => {
    const original = { traceVersion: 0, resumedDecisionIds: ['D-0002'] }
    const reason = '比较起点的版本与当前不同'
    const source = { id: 'D-0003', stage: 'quality', kind: 'alert', status: stage,
      request: { traceBefore: original }, answer: { operatorId: 'ou_owner', choice: '补充说明后继续' },
      ...(stage === 'used' ? { result: { reason, replacement: 'D-0005' } } : {}),
    }
    const f = schedScenario(t, { files: { 'decisions/D-0003.json': source } })
    const { key, saved } = savedTraceFixture(f)
    const { mode, stage: unusedStage, runId, writer, ...batch } = saved
    writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: { ...batch,
      mode: 'version-handoff', sourceDecisionId: 'D-0003', alertId: 'D-0005', traceBefore: original,
    } } } })
    assert.equal(f.run().code, 0)
    assert.deepEqual(f.decisions().map(item => item.id), ['D-0003', 'D-0005'])
    assert.deepEqual(f.decisions()[1].request.traceBefore, original)
    assert.deepEqual(f.decisions()[1].request.options, ['回会话处理'])
    assert.equal(f.claudeCalls().length, 0)
    assert.deepEqual(pendingState(f).entries, {})
  })
}

test('旧版本转交已写出的替代告警在重启后复用同一个发送键', t => {
  const original = { traceVersion: 0, resumedDecisionIds: ['D-0002'] }
  const replacement = 'D-0005'
  const reason = '比较起点的版本与当前不同'
  const source = { id: 'D-0003', stage: 'quality', kind: 'alert', status: 'used', request: { traceBefore: original },
    answer: { operatorId: 'ou_owner', choice: '补充说明后继续' }, result: { reason, replacement } }
  const f = schedScenario(t, { files: { 'decisions/D-0003.json': source } })
  const { key, saved } = savedTraceFixture(f)
  const { traceBefore, runId, stage, writer, ...batch } = saved
  const alert = { id: replacement, stage: 'quality', kind: 'alert', status: 'pending', batchStartedAt: saved.startedAt,
    request: { traceBefore: original, pendingTraceKey: key, options: ['回会话处理'], comparisonState: 'unread', text: reason },
    card: { messageId: null, sendState: 'unclaimed' } }
  writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: { ...batch,
    mode: 'version-handoff', sourceDecisionId: source.id, alertId: replacement, traceBefore: original,
  } } } })
  writeFiles(f.changeDir, { 'decisions/D-0005.json': { ...alert, batchStartedAt: '2026-11-19T10:00:00Z' } })
  assert.equal(f.run().code, 0)
  assert.ok(pendingState(f).entries[key])
  assert.equal(f.decisions()[1].batchStartedAt, '2026-11-19T10:00:00Z')
  writeFiles(f.changeDir, { 'decisions/D-0005.json': alert })
  // 发送命令未能启动：可以确认请求未发出，领取记录保存为 not-sent（add-change-pause design D5）。
  const restore = breakLark(f)
  assert.equal(f.run().code, 0)
  assert.deepEqual(f.decisions().map(item => item.id), [source.id, replacement])
  assert.equal(pendingState(f).entries[key].alertId, replacement, '尚未送达时保留原预留')
  const first = f.decisions()[1].card
  assert.equal(first.sendState, 'not-sent')
  restore()
  assert.equal(f.run().code, 0)
  const attempts = f.larkCalls().filter(call => call.content?.includes('回会话处理') && call.content.includes('版本与当前不同'))
  assert.equal(attempts.length, 1)
  const keyOf = call => call.args[call.args.indexOf('--idempotency-key') + 1]
  assert.ok(first.claim.key)
  assert.equal(keyOf(attempts[0]), first.claim.key, '重启后复用同一个发送键')
  assert.equal(sha256(attempts[0].content), first.claim.contentDigest, '重发的内容与领取时相同')
  assert.deepEqual(pendingState(f).entries, {}, '确认送达后才清理预留')
  assert.equal(f.decisions()[1].card.sendState, 'sent')
})

for (const [label, fault, archived] of [
  ['缺少文件', 'missing', true],
  ['无法读取', 'unreadable', false],
  ['内容不符', 'changed', false],
]) {
  test(`版本转交末次复核${label}时保留预留，重启复用编号`, t => {
    const original = { traceVersion: 0, resumedDecisionIds: ['D-0002'] }
    const replacement = 'D-0005'
    const reason = '比较起点的版本与当前不同'
    const source = { id: 'D-0003', stage: 'quality', kind: 'alert', status: 'used', request: { traceBefore: original },
      answer: { operatorId: 'ou_owner', choice: '补充说明后继续' }, result: { reason, replacement } }
    const f = schedScenario(t, { files: { 'decisions/D-0003.json': source } })
    const { key, saved } = savedTraceFixture(f)
    const date = '2026-11-20'
    const location = archived ? 'archived' : 'active'
    const changeDir = archived ? join(dirname(f.changeDir), 'archive', `${date}-demo`) : f.changeDir
    if (archived) {
      mkdirSync(dirname(changeDir), { recursive: true })
      renameSync(f.changeDir, changeDir)
      mutableView(f, view({ active: [], archived: [{ name: 'demo', date }] }))
    }
    const reservation = { root: saved.root, name: saved.name, startedAt: saved.startedAt,
      directory: realpathSync.native(changeDir), location, mode: 'version-handoff', sourceDecisionId: source.id,
      alertId: replacement, traceBefore: original }
    const files = join(changeDir, 'decisions')
    const alert = { id: replacement, stage: 'quality', kind: 'alert', status: 'pending', batchStartedAt: saved.startedAt,
      request: { traceBefore: original, pendingTraceKey: key, options: ['回会话处理'], comparisonState: 'unread', text: reason },
      card: { messageId: null, sendState: 'unclaimed' } }
    const alertFile = join(files, `${replacement}.json`)
    writeFileSync(alertFile, JSON.stringify(alert))
    writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: reservation } } })

    // 在两段已完成的项目保护（恢复原告警、回读替代告警）之后改变磁盘夹具，不替换调度或决策读取函数。
    const probe = join(f.doublesDir, 'change-before-send.cjs')
    const marker = join(f.doublesDir, 'changed-before-send')
    const changed = JSON.stringify({ ...alert, request: { ...alert.request, text: '复核后改变的告警' } })
    writeFileSync(probe, `const fs = require('node:fs')
const path = require('node:path')
if (process.argv[1] === ${JSON.stringify(scheduler)}) {
  const unlink = fs.unlinkSync
  let releases = 0
  fs.unlinkSync = file => {
    unlink(file)
    if (path.extname(file) !== '.lock' || path.dirname(file) !== ${JSON.stringify(join(f.home, 'project-locks'))} || ++releases !== 2) return
    const alertFile = ${JSON.stringify(alertFile)}
    if (${JSON.stringify(fault)} === 'missing') unlink(alertFile)
    else fs.writeFileSync(alertFile, ${JSON.stringify(fault === 'unreadable' ? '{' : changed)})
    fs.writeFileSync(${JSON.stringify(marker)}, '')
  }
  require('node:module').syncBuiltinESMExports()
}
`)
    const sent = () => f.larkCalls().filter(call => call.content?.includes(reason))
    const result = f.run(['--once'], { NODE_OPTIONS: `--require ${probe}` })
    assert.equal(result.code, 0, result.all)
    assert.ok(existsSync(marker), '已在末次发卡复核前改变替代告警')
    assert.equal(sent().length, 0)
    assert.deepEqual(pendingState(f).entries[key], reservation)
    assert.equal(f.claudeCalls().length, 0)
    assert.equal(JSON.parse(readFileSync(join(files, 'autopilot.json'), 'utf8')).status, 'active')
    assert.deepEqual(JSON.parse(readFileSync(join(files, `${source.id}.json`), 'utf8')), source)

    // 缺失项由重启恢复同一预留编号；不可读或不符时先恢复原文件再重试。
    if (fault !== 'missing') writeFileSync(alertFile, JSON.stringify(alert))
    assert.equal(f.run().code, 0)
    assert.deepEqual(readdirSync(files).sort(), [source.id + '.json', replacement + '.json', 'autopilot.json'])
    const recovered = JSON.parse(readFileSync(alertFile, 'utf8'))
    assert.deepEqual(recovered.request.traceBefore, original)
    assert.deepEqual(recovered.request.options, ['回会话处理'])
    assert.equal(recovered.card.messageId, 'om_test')
    assert.equal(sent().length, 1)
    assert.equal(f.claudeCalls().length, 0)
    assert.deepEqual(pendingState(f).entries, {})
  })
}

test('历史提问文件缺失时恢复告警使用更大的编号', t => {
  const f = schedScenario(t, { files: { 'decisions/D-0004.json': { id: 'D-0004', kind: 'question', status: 'used' } } })
  const { key, saved } = savedTraceFixture(f, { resultDecisionId: 'D-0005', resultKind: 'question', traceAfter: traceFrom(f) })
  writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: saved } } })
  assert.equal(f.run().code, 0)
  assert.deepEqual(f.decisions().map(item => item.id), ['D-0004', 'D-0006'])
  assert.deepEqual(f.decisions()[1].request.traceBefore, saved.traceBefore)
  assert.equal(f.claudeCalls().length, 0)
})

test('最后一个已预留的提问文件缺失时保留原核对与编号', t => {
  const f = schedScenario(t, { files: { 'decisions/D-9998.json': { id: 'D-9998', kind: 'question', status: 'used' } } })
  const { key, saved } = savedTraceFixture(f, { resultDecisionId: 'D-9999', resultKind: 'question', traceAfter: traceFrom(f) })
  writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: saved } } })

  for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
  assert.deepEqual(pendingState(f).entries[key], saved)
  assert.deepEqual(f.decisions().map(item => item.id), ['D-9998'])
  assert.equal(f.claudeCalls().length, 0)
  assert.equal(f.larkCalls().length, 1)
  assert.match(f.larkCalls()[0].content, /决策编号已用尽/)
})

test('未证实退出的写者阻断恢复，组退出后核对原起点', async t => {
  const f = schedScenario(t)
  const writer = spawnSignalTarget()
  t.after(() => writer.kill('SIGKILL'))
  const { key, saved } = savedTraceFixture(f, { writer: writerIdentity(writer.pid) })
  writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: saved } } })
  assert.equal(f.run().code, 0)
  assert.deepEqual(pendingState(f).entries[key], saved)
  assert.deepEqual(f.decisions(), [])
  const exit = new Promise(resolve => writer.once('exit', resolve))
  writer.kill('SIGTERM')
  await exit
  assert.equal(f.run().code, 0)
  assert.deepEqual(f.decisions()[0].request.traceBefore, saved.traceBefore)
  assert.deepEqual(pendingState(f).entries, {})
  assert.equal(f.claudeCalls().length, 0)
})

test('调度保存版本转交失败时保持原告警已答并抑制重复通知', t => {
  const original = { traceVersion: 0, resumedDecisionIds: ['D-0002'] }
  const source = { id: 'D-0003', stage: 'quality', kind: 'alert', status: 'answered',
    request: { sessionId: 's1', traceBefore: original }, answer: { operatorId: 'ou_owner', choice: '补充说明后继续' } }
  const f = schedScenario(t, { files: { 'decisions/D-0003.json': source } })
  const probe = join(f.doublesDir, 'reject-trace-write.cjs')
  writeFileSync(probe, `const fs = require('node:fs')
if (process.argv[1]?.endsWith('scheduler.mjs')) {
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('/pending-trace.json')) throw Object.assign(new Error('test'), { code: 'EACCES' })
    return rename(from, to)
  }
  require('node:module').syncBuiltinESMExports()
}
`)
  for (let round = 0; round < 2; round += 1) assert.equal(f.run(['--once'], { NODE_OPTIONS: `--require ${probe}` }).code, 0)
  assert.equal(f.claudeCalls().length, 0)
  assert.deepEqual(f.decisions(), [source])
  assert.equal(f.larkCalls().length, 1)
})

test('普通提问转交恢复按摘要核验，快照变化时只转交新告警', t => {
  const f = schedScenario(t)
  const { key } = savedTraceFixture(f)
  // 提问由调度真实生成摘要，清理中断后再通过公开 CLI 验证。
  const question = { session_id: 's1', stop_reason: 'tool_deferred',
    deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input: QUESTION } }
  setClaudeOutput(f.doublesDir, question)
  const probe = join(f.doublesDir, 'reject-trace-remove.cjs')
  writeFileSync(probe, `const fs = require('node:fs')
if (process.argv[1]?.endsWith('scheduler.mjs')) {
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('/pending-trace.json') && !Object.keys(JSON.parse(fs.readFileSync(from)).entries).length) {
      throw Object.assign(new Error('test'), { code: 'EACCES' })
    }
    return rename(from, to)
  }
  require('node:module').syncBuiltinESMExports()
}
`)
  assert.equal(f.run(['--once'], { NODE_OPTIONS: `--require ${probe}` }).code, 0)
  const [questionDecision] = f.decisions()
  assert.equal(questionDecision.kind, 'question')
  assert.equal(questionDecision.request.traceBefore, undefined)
  assert.equal(questionDecision.request.pendingTraceKey, key)
  assert.match(questionDecision.request.pendingTraceDigest.value, /^[a-f0-9]{64}$/)
  assert.equal(pendingState(f).entries[key].resultDecisionId, 'D-0001')
  writeFiles(f.changeDir, { 'review/standards.md': acceptedStandards() })
  assert.equal(f.run().code, 0)
  assert.deepEqual(f.decisions().map(item => item.status), ['void', 'pending'])
  assert.equal(f.decisions()[1].kind, 'alert')
  assert.equal(f.claudeCalls().length, 1)
})

test('旧归档不会遮住当前同名批次的核对', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards() },
    view: view({ active: [schedEntry()], archived: [{ name: 'demo', date: '2026-11-19' }] }) })
  const prior = join(f.repo, 'openspec', 'changes', 'archive', '2026-11-19-demo')
  writeFiles(prior, { 'decisions/autopilot.json': managedRecord({ status: 'void', startedAt: '2026-11-05T10:00:00Z' }) })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([
    { file: join(f.changeDir, 'review', 'standards.md'), content: acceptedStandards() },
  ]))
  assert.equal(f.run().code, 0)
  const [alert] = f.decisions()
  assert.ok(alert.request.checkFailures.some(item => item.finding === 'STD-02'))
  assert.ok(!alert.request.checkFailures.some(item => item.field === '原位置出现同名目录'))
  assert.deepEqual(readdirSync(join(prior, 'decisions')), ['autopilot.json'])
})

test('保存原起点后同身份的两份归档阻断而不选首项', t => {
  const f = schedScenario(t)
  const { key, saved } = savedTraceFixture(f)
  const archiveRoot = join(f.repo, 'openspec', 'changes', 'archive')
  const first = join(archiveRoot, '2026-11-18-demo')
  const second = join(archiveRoot, '2026-11-19-demo')
  const record = f.changeRecord()
  writeFiles(first, { 'decisions/autopilot.json': record })
  writeFiles(second, { 'decisions/autopilot.json': record })
  rmSync(join(f.changeDir, 'decisions', 'autopilot.json'))
  writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: saved } } })
  assert.equal(f.run().code, 0)
  assert.deepEqual(pendingState(f).entries[key], saved)
  assert.deepEqual(readdirSync(join(first, 'decisions')), ['autopilot.json'])
  assert.deepEqual(readdirSync(join(second, 'decisions')), ['autopilot.json'])
  assert.equal(f.claudeCalls().length, 0)
  assert.match(f.larkCalls()[0].content, /同一批次有多份托管记录/)
})

test('不能核验归属的候选保留核对起点且不写外部资料', t => {
  const f = schedScenario(t)
  const { key, saved } = savedTraceFixture(f)
  const external = tempDir(t, 'autopilot-unowned-')
  const decisions = join(f.changeDir, 'decisions')
  writeFiles(external, { 'autopilot.json': f.changeRecord() })
  renameSync(decisions, join(f.home, 'original-decisions'))
  symlinkSync(external, decisions)
  writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: saved } } })
  assert.equal(f.run().code, 0)
  assert.deepEqual(pendingState(f).entries[key], saved)
  assert.deepEqual(readdirSync(external), ['autopilot.json'])
  assert.equal(f.claudeCalls().length, 0)
  assert.match(f.larkCalls()[0].content, /目录类型或归属无效/)
  assert.ok(!f.larkCalls()[0].content.includes(external))
})

test('已核验的归档交接缺少历史告警时允许同名新托管', t => {
  const f = scenario(t)
  const old = join(f.repo, 'openspec', 'changes', 'archive', '2026-11-19-demo')
  const startedAt = '2026-11-05T10:00:00Z'
  const archived = managedRecord({ status: 'void', startedAt, returnHandoff: 'D-0002' })
  writeFiles(old, { 'decisions/autopilot.json': archived })
  assert.notEqual(f.run(['start', 'demo']).code, 0)
  writeFiles(old, { 'decisions/autopilot.json': { ...archived, returnHandoffCompleted: { id: 'D-0002', startedAt } } })
  const result = f.run(['start', 'demo'])
  assert.equal(result.code, 0, result.all)
})

test('正常阶段返回要等待原进程组退出才读取后置快照', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards() } })
  const file = join(f.changeDir, 'review', 'standards.md')
  const main = join(f.doublesDir, 'claude.mjs')
  const original = readFileSync(main, 'utf8')
  const delayedWrite = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(acceptedStandards())}), 300)`
  writeFileSync(main, `${original}\nimport { spawn } from 'node:child_process'
spawn(process.execPath, ['-e', ${JSON.stringify(delayedWrite)}], { stdio: 'ignore' }).unref()
`)
  assert.equal(f.run().code, 0)
  const [alert] = f.decisions()
  assert.ok(alert?.request.checkFailures.some(item => item.finding === 'STD-02'))
  assert.equal(f.claudeCalls().length, 1)
})

test('阶段进程实例发布失败时握手不放行写入', t => {
  const f = schedScenario(t)
  const probe = join(f.doublesDir, 'reject-writer-publication.cjs')
  writeFileSync(probe, `const fs = require('node:fs')
if (process.argv[1]?.endsWith('scheduler.mjs')) {
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (String(to).endsWith('/pending-trace.json') && Object.values(JSON.parse(fs.readFileSync(from)).entries)
      .some(item => item.writer?.state === 'published')) throw Object.assign(new Error('test'), { code: 'EACCES' })
    return rename(from, to)
  }
  require('node:module').syncBuiltinESMExports()
}
`)
  assert.equal(f.run(['--once'], { NODE_OPTIONS: `--require ${probe}` }).code, 0)
  assert.equal(f.claudeCalls().length, 0)
  assert.equal(Object.values(pendingState(f).entries)[0].writer.state, 'unreleased')
})

test('快照保存失败时保留重跑标记和原决策', t => {
  const f = schedScenario(t, { files: { 'decisions/autopilot.json': managedRecord({ rerunStage: 'quality' }) } })
  const pending = join(f.home, 'pending-trace.json')
  mkdirSync(pending)
  assert.equal(f.run().code, 2)
  assert.equal(f.claudeCalls().length, 0)
  assert.equal(f.changeRecord().rerunStage, 'quality')
  assert.deepEqual(f.decisions(), [])
})

test('托管记录跨轮恢复后使用第一次比较起点且不重放阶段', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards() } })
  const recordFile = join(f.changeDir, 'decisions', 'autopilot.json')
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([
    { file: recordFile, content: '临时读取失败' },
    { file: join(f.changeDir, 'review', 'standards.md'), content: acceptedStandards() },
  ]))
  assert.equal(f.run().code, 0)
  const [saved] = Object.values(pendingState(f).entries)
  assert.equal(statSync(join(f.home, 'pending-trace.json')).mode & 0o777, 0o600)
  assert.ok(saved.traceBefore.findings.some(item => item.id === 'STD-02' && item.status === 'open'))
  assert.equal(f.run().code, 0)
  assert.deepEqual(Object.values(pendingState(f).entries)[0].traceBefore, saved.traceBefore)
  assert.deepEqual(f.decisions(), [])
  writeFiles(f.changeDir, { 'decisions/autopilot.json': managedRecord() })
  assert.equal(f.run().code, 0)
  const [alert] = f.decisions()
  assert.equal(alert.kind, 'alert')
  assert.ok(alert.request.checkFailures.some(item => item.finding === 'STD-02'))
  assert.deepEqual(alert.request.traceBefore, saved.traceBefore)
  assert.deepEqual(pendingState(f).entries, {})
  assert.equal(f.claudeCalls().length, 1)
})

test('本次归档后原活跃目录重建仍在原批次归档中核对', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards() },
    view: view({ active: [schedEntry({ rule: 'R11', stage: 'archive' })] }) })
  const archive = join(f.repo, 'openspec', 'changes', 'archive', '2026-11-20-demo')
  const script = join(f.doublesDir, 'claude.mjs')
  writeFileSync(script, `${readFileSync(script, 'utf8')}\nimport { mkdirSync, renameSync } from 'node:fs'
mkdirSync(${JSON.stringify(join(archive, '..'))}, { recursive: true })
renameSync(${JSON.stringify(f.changeDir)}, ${JSON.stringify(archive)})
mkdirSync(${JSON.stringify(f.changeDir)})
writeFileSync(${JSON.stringify(join(f.changeDir, 'notes.md'))}, '同名空位置')
writeFileSync(${JSON.stringify(join(archive, 'review', 'standards.md'))}, ${JSON.stringify(acceptedStandards())})
writeFileSync(${JSON.stringify(f.viewFile)}, ${JSON.stringify(JSON.stringify(view({ archived: [{ name: 'demo' }] })))})
`)
  assert.equal(f.run().code, 0)
  const alert = JSON.parse(readFileSync(join(archive, 'decisions', 'D-0001.json'), 'utf8'))
  assert.ok(alert.request.checkFailures.some(item => item.finding === 'STD-02'))
  assert.ok(alert.request.checkFailures.some(item => item.field === '原位置出现同名目录'))
  assert.deepEqual(readdirSync(f.changeDir), ['notes.md'])
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 1)
})

test('提前归档保留原批次的出口阻断与仅回会话告警', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards() } })
  const archive = join(f.repo, 'openspec', 'changes', 'archive', '2026-11-20-demo')
  const archived = view({ active: [], archived: [{ name: 'demo', date: '2026-11-20' }] })
  const script = join(f.doublesDir, 'claude.mjs')
  writeFileSync(script, `${readFileSync(script, 'utf8')}\nimport { mkdirSync, renameSync } from 'node:fs'
mkdirSync(${JSON.stringify(join(archive, '..'))}, { recursive: true })
renameSync(${JSON.stringify(f.changeDir)}, ${JSON.stringify(archive)})
writeFileSync(${JSON.stringify(f.viewFile)}, ${JSON.stringify(JSON.stringify(archived))})
`)
  assert.equal(f.run().code, 0)
  const record = () => JSON.parse(readFileSync(join(archive, 'decisions', 'autopilot.json'), 'utf8'))
  const alert = () => JSON.parse(readFileSync(join(archive, 'decisions', 'D-0001.json'), 'utf8'))
  assert.deepEqual(record().exitBlock, { reason: 'early-archive', stage: 'apply' })
  assert.deepEqual(alert().request.options, ['回会话处理'])
  assert.match(alert().request.text, /quality、verify/)
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 1)
  assert.deepEqual(record().exitBlock, { reason: 'early-archive', stage: 'apply' })
})

test('重启发现提前归档时替换原有继续选项的告警', t => {
  const f = schedScenario(t)
  const { key, saved } = savedTraceFixture(f, { resultDecisionId: 'D-0001', resultKind: 'stage-alert' })
  const prior = { id: 'D-0001', status: 'pending', kind: 'alert', stage: 'apply', batchStartedAt: saved.startedAt,
    request: { pendingTraceKey: key, traceBefore: saved.traceBefore, sessionId: 's1', options: ['补充说明后继续', '回会话处理'] },
    card: { messageId: 'om_existing' } }
  writeFiles(f.changeDir, { 'decisions/D-0001.json': prior })
  writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: saved } } })
  const archive = join(f.repo, 'openspec', 'changes', 'archive', '2026-11-20-demo')
  mkdirSync(join(archive, '..'), { recursive: true })
  renameSync(f.changeDir, archive)
  mutableView(f, view({ active: [], archived: [{ name: 'demo', date: '2026-11-20' }] }))
  assert.equal(f.run().code, 0)
  const read = id => JSON.parse(readFileSync(join(archive, 'decisions', `${id}.json`), 'utf8'))
  assert.equal(read('D-0001').status, 'void')
  assert.deepEqual(read('D-0002').request.options, ['回会话处理'])
  assert.deepEqual(read('D-0002').request.traceBefore, saved.traceBefore)
  assert.equal(f.claudeCalls().length, 0)
  assert.deepEqual(pendingState(f).entries, {})
})

test('调度重启补完原回会话告警且结束通知只尝试一次', t => {
  const f = schedScenario(t, { files: {
    'decisions/autopilot.json': managedRecord({ status: 'void', returnHandoff: 'D-0001' }),
    'decisions/D-0001.json': {
      id: 'D-0001', status: 'answered', kind: 'alert', stage: 'apply',
      request: { options: ['回会话处理'] }, answer: { operatorId: 'ou_owner', choice: '回会话处理' },
    },
  } })
  assert.equal(f.run().code, 0)
  assert.equal(f.decisions()[0].status, 'used')
  assert.equal(f.changeRecord().returnHandoffCompleted.id, 'D-0001')
  assert.equal(f.run().code, 0)
  assert.equal(f.larkCalls().length, 1)
  assert.equal(f.claudeCalls().length, 0)
})

test('回会话通知发送失败时重启仍保留终态且不重试', t => {
  const f = schedScenario(t, { files: {
    'decisions/autopilot.json': managedRecord({ status: 'void', returnHandoff: 'D-0001' }),
    'decisions/D-0001.json': { id: 'D-0001', status: 'answered', kind: 'alert', stage: 'apply',
      request: { options: ['回会话处理'] }, answer: { operatorId: 'ou_owner', choice: '回会话处理' } },
  } })
  const lark = join(f.doublesDir, 'lark-cli.mjs')
  const original = readFileSync(lark, 'utf8')
  writeFileSync(lark, original.replace('process.stdout.write(JSON.stringify({ message_id:', 'process.exitCode = 1\nprocess.stdout.write(JSON.stringify({ message_id:'))
  for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
  assert.equal(f.changeRecord().status, 'void')
  assert.equal(f.decisions()[0].status, 'used')
  assert.equal(f.larkCalls().length, 1)
})

for (const extraBytes of [-1, 0, 1]) {
  test(`核对快照 UTF-8 容量边界：4 MiB ${extraBytes}`, t => {
    const f = schedScenario(t)
    const { key, saved } = savedTraceFixture(f, { writer: { state: 'unreleased' } })
    const byteLimit = 4 * 1024 * 1024
    const trace = { ...saved.traceBefore, testFixture: '' }
    const available = byteLimit + extraBytes - Buffer.byteLength(JSON.stringify(trace))
    trace.testFixture = '核'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3)
    const file = join(f.home, 'pending-trace.json')
    const content = JSON.stringify({ version: 1, entries: { [key]: { ...saved, traceBefore: trace } } }) + '\n'
    writeFileSync(file, content)
    assert.equal(f.run().code, extraBytes > 0 ? 2 : 0)
    assert.equal(f.claudeCalls().length, 0)
    if (extraBytes > 0) assert.equal(readFileSync(file, 'utf8'), content)
    else assert.equal(f.decisions()[0].kind, 'alert')
  })
}

test('接纳的核对起点在总量边界仍可预留恢复告警', t => {
  const f = schedScenario(t)
  const { key, saved } = savedTraceFixture(f)
  const limit = 64 * 1024 * 1024
  const reserve = 16 * 1024
  const full = 4 * 1024 * 1024
  const withSize = (trace, size) => ({ ...trace,
    fixture: 'x'.repeat(size - Buffer.byteLength(JSON.stringify({ ...trace, fixture: '' }))) })
  const entries = {}
  // 16 条共享总量：进入计费上限后仍可保存恢复编号及游标。
  for (let index = 0; index < 15; index += 1) {
    const item = { ...saved, name: `history-${index}`, directory: join(saved.root, 'openspec', 'changes', `history-${index}`),
      traceBefore: withSize(saved.traceBefore, full) }
    entries[JSON.stringify([item.root, item.name, item.startedAt])] = item
  }
  const remaining = limit - reserve * 17 - 15 * full
  entries[key] = { ...saved, traceBefore: withSize(saved.traceBefore, remaining) }
  writeFileSync(join(f.home, 'pending-trace.json'), JSON.stringify({ version: 1, entries }) + '\n')
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 0)
  const [alert] = f.decisions()
  assert.equal(alert.kind, 'alert')
  assert.equal(Buffer.byteLength(JSON.stringify(alert.request.traceBefore)), remaining)
  assert.equal(Object.keys(pendingState(f).entries).length, 15)
})

test('总量超限的核对文件停止本轮且不会被改写', t => {
  const f = schedScenario(t)
  const file = join(f.home, 'pending-trace.json')
  writeFileSync(file, '{"version":1,"entries":{}}\n')
  const size = 64 * 1024 * 1024 + 1
  truncateSync(file, size)
  assert.equal(f.run().code, 2)
  assert.equal(statSync(file).size, size)
  assert.equal(f.claudeCalls().length, 0)
  assert.match(f.larkCalls()[0].content, /字节上限/)
})

test('决策历史中超限文件阻断核对，未受影响的项目仍可运行', t => {
  const f = schedScenario(t)
  const { key, saved } = savedTraceFixture(f)
  writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: saved } } })
  const historic = join(f.changeDir, 'decisions', 'D-0001.json')
  writeFileSync(historic, '{"id":"D-0001","status":"used"}')
  truncateSync(historic, 32 * 1024 * 1024 + 1)
  const healthy = tempDir(t, 'autopilot-healthy-')
  initRepo(healthy)
  writeFiles(join(healthy, 'openspec', 'changes', 'demo'), { 'decisions/autopilot.json': managedRecord() })
  writeConfig(f.home, { ...f.config, projects: [projectOf(f.repo), projectOf(healthy)] })
  assert.equal(f.run().code, 0)
  assert.deepEqual(pendingState(f).entries[key], saved)
  assert.equal(statSync(historic).size, 32 * 1024 * 1024 + 1)
  assert.equal(f.claudeCalls().length, 1)
  assert.ok(f.claudeCalls()[0].env.OPENSPEC_AUTOPILOT_CHANGE_ROOT.startsWith(realpathSync.native(healthy)))
})

test('32 条未完成核对时保留条目并限制新阶段', t => {
  const f = schedScenario(t)
  const { saved } = savedTraceFixture(f)
  const entry = index => ({ ...saved, name: `other-${index}`, directory: join(saved.root, 'openspec', 'changes', `other-${index}`) })
  const entries = Object.fromEntries(Array.from({ length: 32 }, (_, index) => {
    const item = entry(index)
    return [JSON.stringify([item.root, item.name, item.startedAt]), item]
  }))
  const file = join(f.home, 'pending-trace.json')
  writeFileSync(file, JSON.stringify({ version: 1, entries }) + '\n')
  const clock = join(f.doublesDir, 'capacity-clock.cjs')
  writeFileSync(clock, `const fs = require('node:fs')
if (process.argv[1]?.endsWith('scheduler.mjs')) {
  const { performance } = require('node:perf_hooks')
  let expired = false
  const open = fs.openSync
  fs.openSync = (file, ...args) => {
    if (String(file).endsWith('/pending-trace.json')) expired = true
    return open(file, ...args)
  }
  Object.defineProperty(performance, 'now', { value: () => expired ? 120001 : 0 })
  require('node:module').syncBuiltinESMExports()
}
`)
  assert.equal(f.run(['--once'], { NODE_OPTIONS: `--require ${clock}` }).code, 0)
  assert.equal(f.claudeCalls().length, 0)
  assert.deepEqual(pendingState(f).entries, entries)
  assert.match(f.larkCalls()[0].content, /超过 32 条/)
})

test('超限的核对告警保留完整证据，摘要只允许回会话', t => {
  const before = openStandards()
  const lines = Array.from({ length: 250 }, (_, index) => findingRow(`STD-${100 + index}`, 'Blocker', 'risk-accepted'))
  const f = schedScenario(t, { files: { 'review/standards.md': before } })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([
    { file: join(f.changeDir, 'review', 'standards.md'), content: standardsReport(lines) },
  ]))
  assert.equal(f.run().code, 0)
  const [alert] = f.decisions()
  assert.equal(alert.request.checkFailures.filter(item => item.note).length, 250)
  assert.deepEqual(alert.request.options, ['回会话处理'])
  assert.equal(alert.request.sessionId, undefined)
  const [{ content }] = f.larkCalls()
  assert.ok(Buffer.byteLength(content, 'utf8') <= 24 * 1024)
  assert.match(content, /本地详情/)
})

test('终态交接的扫描超时保留游标且允许健康变更运行', t => {
  const f = schedScenario(t, { entries: [] })
  const names = ['first', 'second']
  const archived = names.map(name => ({ name, date: '2026-11-20' }))
  mutableView(f, view({ active: [schedEntry()], archived }))
  const first = join(f.repo, 'openspec', 'changes', 'archive', '2026-11-20-first')
  const time = managedRecord().startedAt
  for (const name of names) {
    const archive = join(f.repo, 'openspec', 'changes', 'archive', `2026-11-20-${name}`)
    writeFiles(archive, { 'decisions/autopilot.json': managedRecord({ status: 'void', returnHandoff: 'D-0001' }),
      'decisions/D-0001.json': { id: 'D-0001', kind: 'alert', status: 'used',
        answer: { operatorId: 'ou_owner', choice: '回会话处理' } },
    })
  }
  const clock = join(f.doublesDir, 'handoff-clock.cjs')
  writeFileSync(clock, `const fs = require('node:fs')
if (process.argv[1]?.endsWith('scheduler.mjs')) {
  const { performance } = require('node:perf_hooks')
  let expired = false
  const open = fs.openSync
  fs.openSync = (file, ...args) => {
    if (process.cwd() === ${JSON.stringify(realpathSync.native(join(first, 'decisions')))} && String(file).endsWith('D-0001.json')) expired = true
    return open(file, ...args)
  }
  Object.defineProperty(performance, 'now', { value: () => expired ? 2001 : 0 })
  require('node:module').syncBuiltinESMExports()
}
`)
  const result = f.run(['--once'], { NODE_OPTIONS: `--require ${clock}` })
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 1)
  const settings = JSON.parse(readFileSync(join(f.home, 'rule-check.json'), 'utf8'))
  assert.equal(settings.handoffCursor, JSON.stringify([realpathSync.native(f.repo), 'first', time]))
  for (const name of names) {
    const file = join(f.repo, 'openspec', 'changes', 'archive', `2026-11-20-${name}`, 'decisions', 'autopilot.json')
    assert.equal(JSON.parse(readFileSync(file)).returnHandoffCompleted, undefined)
  }
})

test('恢复超过本轮预算时只推进到已尝试条目', t => {
  const f = schedScenario(t)
  const { key, saved } = savedTraceFixture(f)
  const secondDir = join(f.repo, 'openspec', 'changes', 'other')
  writeFiles(secondDir, { 'decisions/autopilot.json': managedRecord() })
  const secondKey = JSON.stringify([saved.root, 'other', saved.startedAt])
  const second = { ...saved, name: 'other', directory: realpathSync.native(secondDir) }
  writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: saved, [secondKey]: second } } })
  const marker = join(f.doublesDir, 'elapsed')
  const clock = join(f.doublesDir, 'clock.cjs')
  writeFileSync(clock, `const fs = require('node:fs')
if (process.argv[1]?.endsWith('scheduler.mjs')) {
  const { performance } = require('node:perf_hooks')
  Object.defineProperty(performance, 'now', { value: () => fs.existsSync(${JSON.stringify(marker)}) ? 119001 : 0 })
}
`)
  const gate = gateDoublePath(f)
  writeFileSync(gate, `import { writeFileSync } from 'node:fs'
if (process.argv[2] === 'trace') {
  writeFileSync(${JSON.stringify(marker)}, '')
  process.stdout.write(${JSON.stringify(JSON.stringify(traceFrom(f)))})
} else process.stdout.write('usage: trace')
`)
  writeConfig(f.home, { ...f.config, gateBin: gate })
  assert.equal(f.run(['--once'], { NODE_OPTIONS: `--require ${clock}` }).code, 0)
  assert.equal(pendingState(f).cursor, key)
  assert.equal(Object.keys(pendingState(f).entries).length, 2)
  assert.deepEqual(f.decisions(), [])
})

test('现存最高合法编号占用时调度不会再启动阶段', t => {
  const f = schedScenario(t, { files: {
    'decisions/D-9999.json': { id: 'D-9999', kind: 'alert', status: 'used' },
  } })
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 0)
  assert.deepEqual(f.decisions().map(item => item.id), ['D-9999'])
  assert.match(f.larkCalls()[0].content, /决策编号已用尽/)
})

test('核对在进度视图第二次调用失败时比较同一批次', t => {
  const f = schedScenario(t, { files: { 'review/standards.md': openStandards() } })
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([
    { file: f.viewFile, content: '不可读的视图' },
    { file: join(f.changeDir, 'review', 'standards.md'), content: acceptedStandards() },
  ]))
  assert.equal(f.run().code, 0)
  const [alert] = f.decisions()
  assert.ok(alert.request.checkFailures.some(item => item.finding === 'STD-02'))
  assert.doesNotMatch(f.larkCalls()[0].content, /托管不再处理/)
})

test('没有阶段运行的一轮只读取每个项目一次进度视图', t => {
  const f = schedScenario(t, { files: { 'decisions/D-0001.json': {
    id: 'D-0001', status: 'pending', kind: 'question', card: { messageId: 'om_pending' },
  } } })
  const calls = join(f.doublesDir, 'progress-calls.jsonl')
  writeFileSync(f.viewFile, JSON.stringify(enabledView(f)))
  writeFileSync(f.progressBin, `import { appendFileSync, readFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n')
process.stdout.write(readFileSync(${JSON.stringify(f.viewFile)}, 'utf8'))
`)
  assert.equal(f.run().code, 0)
  const lines = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(lines, [['--json', '--gate', realpathSync.native(gateBin)]])
})

test('处理归档候选时使用最新的提前归档阻断', t => {
  const f = schedScenario(t, { view: view({ active: [], archived: [{ name: 'demo' }, { name: 'previous' }] }) })
  const archive = join(f.repo, 'openspec', 'changes', 'archive')
  const demo = join(archive, '2026-11-20-demo')
  const recordFile = join(demo, 'decisions', 'autopilot.json')
  const record = managedRecord({ status: 'exiting' })
  mkdirSync(archive, { recursive: true })
  renameSync(f.changeDir, demo)
  writeFiles(demo, { 'decisions/autopilot.json': record })
  writeFiles(join(archive, '2026-11-20-previous'), {
    'decisions/autopilot.json': managedRecord({ status: 'void', returnHandoff: 'D-0001' }),
    'decisions/D-0001.json': { id: 'D-0001', kind: 'alert', status: 'used',
      answer: { operatorId: 'ou_owner', choice: '回会话处理' } },
  })
  const lark = join(f.doublesDir, 'lark-cli.mjs')
  const updated = { ...record, exitBlock: { reason: 'early-archive', stage: 'apply' } }
  // 上一批次的结束通知发生在发现候选之后，借替身模拟这段间隔内同一归档批次的记录更新。
  writeFileSync(lark, `import { writeFileSync } from 'node:fs'\n${readFileSync(lark, 'utf8').replace(
    'process.stdout.write(JSON.stringify({ message_id:',
    `writeFileSync(${JSON.stringify(recordFile)}, ${JSON.stringify(JSON.stringify(updated))})\nprocess.stdout.write(JSON.stringify({ message_id:`,
  )}`)

  const result = f.run()
  assert.equal(result.code, 0, result.all)
  assert.equal(f.larkCalls().length, 1)
  assert.equal(f.claudeCalls().length, 0)
  assert.deepEqual(JSON.parse(readFileSync(recordFile, 'utf8')), updated)
})

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
// add-change-pause 任务 2.3：执行边界核对变更状态，决策卡片先领取再发送（Seam S4：scheduler.mjs --once）
// ---------------------------------------------------------------------------

/** 调度用例的暂缓状态文件。原因带一个标记，用来证明通知不外发原因原文（design D5「通知字段」）。 */
const SCHED_PAUSE = { version: 1, state: 'paused', reason: '原因原文-不外发', updatedAt: '2026-11-24T00:00:00.000Z' }
const stateText = value => `${JSON.stringify(value, null, 2)}\n`
const sha256 = text => createHash('sha256').update(text).digest('hex')
const argOf = (call, flag) => call.args[call.args.indexOf(flag) + 1]
/** 发出的原决策卡片：卡片回调值带决策编号（卡片文件是缩进的 JSON）。 */
const decisionCards = (f, id = 'D-0001') => f.larkCalls().filter(call => call.content?.includes(`"d": "${id}"`))
const noticesTitled = (f, title) => f.larkCalls().filter(call => call.content?.includes(title))
const pendingQuestion = card => ({
  id: 'D-0001', kind: 'question', status: 'pending', stage: 'apply', batchStartedAt: managedRecord().startedAt,
  request: { sessionId: 'sess-1', toolUseId: 'T1', fingerprint: fingerprintOf(QUESTION), questions: QUESTION.questions },
  card,
})
/** 让 lark-cli 替身无法启动：解释器不存在时 spawn 报错且没有进程号，可以确认请求未发出。返回恢复函数。 */
function breakLark(f) {
  const bin = join(f.doublesDir, 'lark-cli')
  const normal = readFileSync(bin, 'utf8')
  writeFileSync(bin, '#!/nonexistent/lark-interpreter\n')
  return () => writeFileSync(bin, normal)
}
const pendingEntries = f => (existsSync(join(f.home, 'pending-trace.json')) ? pendingState(f).entries : {})

test('暂缓：状态为暂缓而托管仍为 active 时不启动阶段，只发一次不含原因与路径的通知，不改状态与托管记录', t => {
  const f = schedScenario(t, { files: { 'change-state.json': stateText(SCHED_PAUSE) } })
  for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 0)
  assert.deepEqual(f.changeRecord(), managedRecord())
  assert.equal(readFileSync(join(f.changeDir, 'change-state.json'), 'utf8'), stateText(SCHED_PAUSE))
  const notices = noticesTitled(f, '托管与推进意愿不一致')
  assert.equal(notices.length, 1, '同一批次、摘要与类别只成功通知一次')
  assert.equal(f.larkCalls().length, 1)
  const content = notices[0].content
  assert.ok(content.includes('demo') && content.includes(managedRecord().startedAt), content)
  for (const secret of [SCHED_PAUSE.reason, f.repo, realpathSync.native(f.repo), f.home]) {
    assert.ok(!content.includes(secret), `通知不得包含 ${secret}`)
  }
})

test('暂缓：状态为暂缓时不恢复已回复的会话，不消费该决策', t => {
  const answered = answeredQuestionDecision()
  const f = schedScenario(t, { files: { 'change-state.json': stateText(SCHED_PAUSE), 'decisions/D-0003.json': answered } })
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 0)
  assert.deepEqual(f.decisions(), [answered])
  assert.deepEqual(pendingEntries(f), {})
  assert.equal(noticesTitled(f, '托管与推进意愿不一致').length, 1)
})

test('暂缓：取得进度快照后、保存核对起点前状态变为暂缓时，不保存起点，不启动或恢复会话', async t => {
  for (const [label, files] of [
    ['启动阶段', {}],
    ['恢复已回复的会话', { 'decisions/D-0003.json': answeredQuestionDecision() }],
  ]) {
    await t.test(label, st => {
      const f = schedScenario(st, { files })
      const before = f.decisions()
      // 进度替身输出快照之后才写入暂缓：调度只能在领取点的保护内复核摘要时发现变化。
      writeFileSync(join(f.doublesDir, 'progress-effect.json'), JSON.stringify([
        { file: join(f.changeDir, 'change-state.json'), content: stateText(SCHED_PAUSE) },
      ]))
      assert.equal(f.run().code, 0)
      assert.equal(existsSync(join(f.doublesDir, 'progress-effect.json')), false, '替身已在快照后写入状态')
      assert.equal(f.claudeCalls().length, 0)
      assert.deepEqual(pendingEntries(f), {})
      assert.deepEqual(f.decisions(), before)
      assert.deepEqual(f.changeRecord(), managedRecord())
      assert.equal(readFileSync(join(f.changeDir, 'change-state.json'), 'utf8'), stateText(SCHED_PAUSE))
      // 对照：删除暂缓文件后同一场景照常领取，证明上一轮是被状态复核阻断的。
      rmSync(join(f.changeDir, 'change-state.json'))
      assert.equal(f.run().code, 0)
      assert.equal(f.claudeCalls().length, 1)
    })
  }
})

test('暂缓：阶段领取后才改为暂缓时完成本次核对，下一轮不再领取新动作，也不撤回托管', t => {
  const f = schedScenario(t)
  writeFileSync(join(f.doublesDir, 'effect.json'), JSON.stringify([
    { file: join(f.changeDir, 'change-state.json'), content: stateText(SCHED_PAUSE) },
  ]))
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 1)
  assert.deepEqual(pendingEntries(f), {}, '已领取的阶段按原协议完成核对')
  rmSync(join(f.doublesDir, 'effect.json'))
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 1, '暂缓后不再启动或恢复阶段')
  assert.equal(f.changeRecord().status, 'active')
  assert.equal(readFileSync(join(f.changeDir, 'change-state.json'), 'utf8'), stateText(SCHED_PAUSE))
  assert.equal(noticesTitled(f, '托管与推进意愿不一致').length, 1)
})

test('发卡：未领取的待回复决策先保存领取记录再发送，送达后写入 sent 与消息编号', t => {
  const f = schedScenario(t, { files: { 'decisions/D-0001.json': pendingQuestion({ messageId: null, sendState: 'unclaimed' }) } })
  // 替身在发送时记下决策文件：证明领取记录先于飞书调用保存。
  const seen = join(f.doublesDir, 'decision-at-send.json')
  const impl = join(f.doublesDir, 'lark-cli.mjs')
  writeFileSync(impl, `import { copyFileSync as keep } from 'node:fs'\n`
    + `if (process.argv[2] === 'im') keep(${JSON.stringify(join(f.changeDir, 'decisions', 'D-0001.json'))}, ${JSON.stringify(seen)})\n`
    + readFileSync(impl, 'utf8'))
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 0)
  const cards = decisionCards(f)
  assert.equal(cards.length, 1)
  const elements = JSON.stringify(JSON.parse(cards[0].content).body.elements)
  assert.ok(elements.includes('select_static') && elements.includes(QUESTION.questions[0].question), elements)
  const atSend = JSON.parse(readFileSync(seen, 'utf8')).card
  assert.equal(atSend.sendState, 'claimed')
  assert.equal(atSend.messageId, null)
  assert.equal(atSend.claim.decisionId, 'D-0001')
  assert.equal(atSend.claim.batchStartedAt, managedRecord().startedAt)
  assert.equal(atSend.claim.key, argOf(cards[0], '--idempotency-key'))
  assert.equal(atSend.claim.recipient, argOf(cards[0], '--user-id'))
  assert.equal(atSend.claim.contentDigest, sha256(cards[0].content))
  const after = f.decisions()[0].card
  assert.equal(after.sendState, 'sent')
  assert.equal(after.messageId, 'om_test')
  assert.equal(after.claim.id, atSend.claim.id, '回写的是同一次领取')
})

test('发卡：确认发送命令未能启动时记录 not-sent，下一轮按原编号、收件人、内容和幂等键重发', t => {
  const f = schedScenario(t, { files: { 'decisions/D-0001.json': pendingQuestion({ messageId: null, sendState: 'unclaimed' }) } })
  const restore = breakLark(f)
  assert.equal(f.run().code, 0)
  const first = f.decisions()[0].card
  assert.equal(first.sendState, 'not-sent')
  assert.equal(first.messageId, null)
  assert.ok(first.claim?.key && first.claim.contentDigest)
  assert.equal(f.larkCalls().length, 0)
  restore()
  assert.equal(f.run().code, 0)
  const cards = decisionCards(f)
  assert.equal(cards.length, 1)
  assert.equal(argOf(cards[0], '--idempotency-key'), first.claim.key)
  assert.equal(argOf(cards[0], '--user-id'), first.claim.recipient)
  assert.equal(sha256(cards[0].content), first.claim.contentDigest)
  const decisions = f.decisions()
  assert.equal(decisions.length, 1, '不创建另一决策')
  assert.equal(decisions[0].card.sendState, 'sent')
  assert.equal(decisions[0].card.messageId, 'om_test')
  assert.equal(f.claudeCalls().length, 0, '待回复的原决策继续阻断阶段')
})

test('发卡：已领取但没有送达结果、或旧决策没有发送记录时不重发，只发一次不带决策编号的通知', async t => {
  const claim = { id: 'c1', batchStartedAt: managedRecord().startedAt, decisionId: 'D-0001', key: 'k1', recipient: 'ou_owner', contentDigest: 'a'.repeat(64) }
  for (const [label, card] of [
    ['已领取、未回写', { messageId: null, sendState: 'claimed', claim }],
    ['旧决策没有发送状态也没有消息编号', { messageId: null }],
  ]) {
    await t.test(label, st => {
      const decision = pendingQuestion(card)
      const f = schedScenario(st, { files: { 'decisions/D-0001.json': decision } })
      for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
      assert.equal(decisionCards(f).length, 0)
      assert.deepEqual(f.decisions(), [decision])
      assert.equal(f.claudeCalls().length, 0)
      const notices = noticesTitled(f, '托管卡片发送结果未知')
      assert.equal(notices.length, 1)
      assert.ok(!notices[0].content.includes('D-0001'), notices[0].content)
    })
  }
})

test('发卡：发送命令退出 0 但返回的消息编号不合法时不写 sent，按结果未知处理且不重发（SEC-15）', async t => {
  for (const [label, messageId] of [
    ['数字', 12345],
    ['对象', { id: 'om_object' }],
    ['超过 128 字节', `om_${'x'.repeat(126)}`],
    ['含不可打印 ASCII 以外的字符', 'om 编号'],
  ]) {
    await t.test(label, st => {
      const f = schedScenario(st, { lark: messageId,
        files: { 'decisions/D-0001.json': pendingQuestion({ messageId: null, sendState: 'unclaimed' }) } })
      for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
      assert.equal(decisionCards(f).length, 1, '只发送一次')
      const card = f.decisions()[0].card
      assert.equal(card.sendState, 'claimed')
      assert.equal(card.messageId, null)
      assert.equal(f.claudeCalls().length, 0)
      // 替身让通知本身也拿不到回执：只允许重试无编号通知，不能重发原决策卡。
      const notices = noticesTitled(f, '托管卡片发送结果未知')
      assert.equal(notices.length, 2)
      assert.equal(argOf(notices[0], '--idempotency-key'), argOf(notices[1], '--idempotency-key'))
    })
  }
})

// ---------------------------------------------------------------------------
// add-change-pause 任务 3.1：旧副本与损坏状态不放行阶段（Seam S4：scheduler.mjs --once）
// ---------------------------------------------------------------------------

test('状态损坏：状态文件无效时不启动阶段，不改托管记录与状态文件，只发一次固定类别通知（任务 3.1）', async t => {
  for (const [label, text] of INVALID_STATES) {
    await t.test(label, st => {
      const f = schedScenario(st, { files: { 'change-state.json': text } })
      const recordPath = join(f.changeDir, 'decisions', 'autopilot.json')
      const record = readFileSync(recordPath)
      for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
      assert.equal(f.claudeCalls().length, 0)
      assert.deepEqual(readFileSync(recordPath), record)
      assert.equal(readFileSync(join(f.changeDir, 'change-state.json'), 'utf8'), text)
      assert.equal(f.larkCalls().length, 1, '同一批次、摘要与类别只成功通知一次')
      const [notice] = noticesTitled(f, '托管无法核验变更状态')
      assert.ok(notice?.content.includes('变更状态无法核验'), notice?.content)
      for (const secret of [f.repo, realpathSync.native(f.repo), 'change-state.json']) {
        assert.ok(!notice.content.includes(secret), `通知不得包含 ${secret}`)
      }
    })
  }
})

test('旧副本：进度视图缺少状态契约时不启动阶段，只发一次同步三个副本的通知（任务 3.1）', async t => {
  const oldGate = { state: 'unknown', reason: null, updatedAt: null, error: '门禁副本没有状态契约 1，请同步 openspec-technical-review', digest: null }
  for (const [label, edit] of [
    ['进度视图没有 changeStateVersion', value => { delete value.changeStateVersion }],
    ['条目没有 changeState', value => { delete value.active[0].changeState }],
    ['门禁副本没有状态契约', value => { value.changeStateVersion = null; value.active[0].changeState = oldGate; value.active[0].changeDirectory = null }],
  ]) {
    await t.test(label, st => {
      const f = schedScenario(st)
      const value = enabledView(f)
      edit(value)
      // raw：进度替身原样输出，不按门禁契约补齐，模拟旧进度或旧门禁副本。
      writeFileSync(f.viewFile, JSON.stringify({ ...value, raw: true }))
      const record = readFileSync(join(f.changeDir, 'decisions', 'autopilot.json'))
      for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
      assert.equal(f.claudeCalls().length, 0)
      assert.deepEqual(readFileSync(join(f.changeDir, 'decisions', 'autopilot.json')), record)
      assert.equal(f.larkCalls().length, 1)
      assert.ok(f.larkCalls()[0].content.includes('配套同步托管、进度视图和门禁三个副本'), f.larkCalls()[0].content)
    })
  }
})

test('旧副本：状态契约与 reviewStale 同时缺失时不作废托管，托管记录字节不变（DB-14）', t => {
  const withoutStale = schedEntry()
  delete withoutStale.reviewStale
  const f = schedScenario(t, { view: { root: null, active: [withoutStale], implementing: [], archived: [], raw: true } })
  const recordPath = join(f.changeDir, 'decisions', 'autopilot.json')
  const record = readFileSync(recordPath)
  for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
  assert.deepEqual(readFileSync(recordPath), record, '契约检查先于 reviewStale 的作废规则')
  assert.equal(f.claudeCalls().length, 0)
  const cards = f.larkCalls()
  assert.equal(cards.length, 1)
  assert.ok(cards[0].content.includes('进度视图缺少变更状态契约 1'), cards[0].content)
  assert.ok(!cards[0].content.includes('托管已作废'), cards[0].content)
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
  const { progressBin, skillRoot } = progressDouble(home, { root: repo, active: [schedEntry()], implementing: [], archived: [] })
  const { larkBin, larkCalls } = larkDouble(home, { events })
  writeConfig(home, { larkBin, progressBin, trustedSkillRoots: [skillRoot], projects: [projectOf(repo)] })
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

test('桥接读取失败保留待答决策，同一事件在恢复后可重投', t => {
  const events = [clickEvent(), clickEvent(), clickEvent({ event_id: 'E2', operator_id: 'ou_other' })]
  const f = bridgeScenario(t, { events, files: {
    'decisions/autopilot.json': managedRecord(),
    'decisions/D-0001.json': { ...answeredQuestion(), status: 'pending', card: { messageId: 'om_card_1' } },
  } })
  const directory = join(f.changeDir, 'decisions')
  const backup = join(f.home, 'decisions-backup')
  renameSync(directory, backup)
  writeFileSync(directory, '暂不可读')
  assert.equal(f.run().code, 1)
  const log = readFileSync(join(f.home, 'logs', 'bridge.log'), 'utf8')
  assert.match(log, /event-error/)
  assert.match(log, /event-other-operator/)
  assert.equal(readFileSync(join(f.home, 'events.jsonl'), 'utf8'), 'E2\n')
  rmSync(directory)
  renameSync(backup, directory)
  assert.equal(f.run().code, 1)
  assert.equal(f.decision('D-0001').status, 'answered')
  assert.equal(readFileSync(join(f.home, 'events.jsonl'), 'utf8'), 'E2\nE1\n')
})

test('桥接遇到相同消息号的多个已知批次时保持决策与卡片', t => {
  const pending = { ...answeredQuestion(), status: 'pending', card: { messageId: 'om_card_1' } }
  const f = bridgeScenario(t, { files: { 'decisions/autopilot.json': managedRecord(), 'decisions/D-0001.json': pending },
    events: [clickEvent()] })
  const other = join(f.repo, 'openspec', 'changes', 'archive', '2026-11-19-demo')
  writeFiles(other, { 'decisions/autopilot.json': managedRecord({ status: 'void', startedAt: '2026-11-05T10:00:00Z' }),
    'decisions/D-0001.json': pending })
  assert.equal(f.run().code, 1)
  assert.deepEqual(f.decision('D-0001'), pending)
  assert.deepEqual(updatedCards(f), [])
  assert.match(readFileSync(join(f.home, 'logs', 'bridge.log'), 'utf8'), /event-error/)
})

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

  const { viewFile, progressBin, skillRoot } = progressDouble(home, {
    root: repo,
    active: archived ? [] : [schedEntry({ rule: 'R11', stage: 'archive' })],
    implementing: [],
    archived: archived ? [{ name: 'demo', date: '2026-11-16' }] : [],
  })
  // claude -p --output-format json 的 result 是最终回复的文本：替身把计划写成文本形式的 JSON（quality R1 SPEC-07）。
  const { claudeBin, claudeCalls } = claudeDouble(doublesDir, { output: textResult(plan) })
  const { larkBin, larkCalls } = larkDouble(doublesDir, { messageId: 'om_card' })
  const config = writeConfig(home, {
    claudeBin, larkBin, progressBin, gateBin, trustedSkillRoots: [skillRoot],
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
    config, viewFile,
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
  const alert = f.decisions().find(item => item.kind === 'alert' && item.status === 'pending')
  assert.ok(alert, '已归档的继续会话仍检查有无进展')
  assert.equal(alert.request.comparisonState, 'stage')
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
  assert.equal(f.run().code, 0)
  const push = f.decisions().find(item => item.request.action === 'push')
  assert.ok(push)
  writeFiles(f.changeDir, { [`decisions/${push.id}.json`]: {
    ...push, status: 'answered', answer: { operatorId: 'ou_owner', choice: '推送' },
  } })
  assert.equal(f.run().code, 0)
  assert.equal(f.run().code, 0)
  assert.equal(f.record().status, 'closed')
  assert.equal(f.branch(), 'fix/x')
  assert.match(f.larkCalls().at(-1).content, /当前分支为 fix\/x.*切回 main/)
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

test('推送重试重新计算推送清单且不复用提交卡片字段', t => {
  const f = exitScenario(t)
  writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
  writeExitRecord(f)
  answeredCommit(f)
  assert.equal(f.run().code, 0)
  const prior = { id: 'D-0002', kind: 'exit-alert', status: 'answered', stage: 'exit',
    request: { exitAction: 'push', options: ['重试本项', '暂不处理'] },
    answer: { operatorId: 'ou_owner', choice: '重试本项' } }
  writeFiles(f.changeDir, { 'decisions/D-0002.json': prior })
  assert.equal(f.run().code, 0)
  assert.equal(f.run().code, 0)
  const fresh = f.decisions().at(-1)
  assert.equal(fresh.id, 'D-0003')
  assert.equal(fresh.request.action, 'push')
  assert.ok(fresh.request.commits.length > 0)
  for (const field of ['files', 'message', 'contentDigest']) assert.equal(fresh.request[field], undefined)
  assert.equal(f.claudeCalls().length, 0)
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

test('提交后撤回时记录已经完成的步骤和提交号', t => {
  const f = exitScenario(t)
  writeExitRecord(f)
  writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
  answeredCommit(f)
  const gitHook = join(f.repo, '.git', 'hooks', 'post-commit')
  const recordFile = join(f.changeDir, 'decisions', 'autopilot.json')
  const writeVoid = `const fs=require('node:fs');const file=${JSON.stringify(recordFile)};const record=JSON.parse(fs.readFileSync(file));fs.writeFileSync(file,JSON.stringify({...record,status:'void'}));`
  writeFileSync(gitHook, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e '${writeVoid.replaceAll("'", "'\"'\"'")}'\n`)
  chmodSync(gitHook, 0o755)
  assert.equal(f.run().code, 0)
  const log = readFileSync(join(f.home, 'logs', 'scheduler.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const event = log.find(item => item.event === 'commit-merge-stopped')
  assert.ok(event)
  assert.ok(event.steps.includes('commit'))
  assert.equal(event.commit, f.git('rev-parse', 'fix/x'))
  assert.equal(f.record().status, 'void')
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
  // 脚本开始运行时写标记文件，用例等标记出现（推送已开始）再撤回，不按固定时间猜调度进程走到了哪一步。
  const slow = join(f.doublesDir, 'slow-remote.sh')
  const remoteStarted = join(f.doublesDir, 'remote-started')
  writeFileSync(slow, `#!/bin/sh\ntouch ${JSON.stringify(remoteStarted)}\nsleep 2\nexec git "$1" ${JSON.stringify(f.origin)}\n`)
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
  assert.ok(await waitFor(() => existsSync(remoteStarted), 30000), '调度进程没有开始访问远端')
  const cancel = await exited('cancel')
  const schedDone = await sched
  assert.equal(cancel.code, 0, cancel.all)
  assert.ok(cancel.at >= schedDone.at, '撤回应在调度进程释放锁之后才退出')
  const remoteAfter = spawnSync('git', ['--git-dir', f.origin, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim()
  assert.equal(remoteAfter, remoteBefore)
  assert.equal(f.record().status, 'void')
  const log = readFileSync(join(f.home, 'logs', 'scheduler.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  const stopped = log.find(item => item.event === 'push-stopped')
  assert.ok(stopped)
  assert.ok(Array.isArray(stopped.steps))
  assert.equal(stopped.before, remoteBefore)
  assert.equal(stopped.after, remoteAfter)
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
// add-change-pause 任务 3.2：归档出口核对状态，异常通知去重并限量（Seam S4：scheduler.mjs --once）
// ---------------------------------------------------------------------------

/** 让 lark-cli 替身记录调用后以非零退出码结束：命令已启动，不能证明送达。返回恢复函数。 */
function failLark(f) {
  const impl = join(f.doublesDir, 'lark-cli.mjs')
  const normal = readFileSync(impl, 'utf8')
  const failing = normal.replace('process.stdout.write(JSON.stringify({ message_id', 'process.exit(7)\nprocess.stdout.write(JSON.stringify({ message_id')
  assert.notEqual(failing, normal)
  writeFileSync(impl, failing)
  return () => writeFileSync(impl, normal)
}

/**
 * 门禁计数替身：记录每次调用的参数后转给实际门禁，输出与退出码不变（评审 PERF-09）。
 * 替身目录有 gate-sleep.json（秒数）时，第一次 state 调用先删除该文件再等待，模拟慢门禁；
 * 有 gate-effect.json（`[{ file, content }]`）时，第一次 state 调用输出后写这些文件并删除该控制文件，
 * 模拟调度取得状态快照之后状态文件被修改。
 * @returns {Function} 返回各次 state 调用读取的目录。
 */
function countingGate(f) {
  const gate = gateDoublePath(f)
  const calls = join(f.doublesDir, 'gate-calls.log')
  const sleep = join(f.doublesDir, 'gate-sleep.json')
  const effect = join(f.doublesDir, 'gate-effect.json')
  writeFileSync(gate, `import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
if (args[0] === 'state' && existsSync(${JSON.stringify(sleep)})) {
  const seconds = Number(readFileSync(${JSON.stringify(sleep)}, 'utf8'))
  rmSync(${JSON.stringify(sleep)})
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000)
}
const child = spawnSync(process.execPath, [${JSON.stringify(gateBin)}, ...args], { stdio: 'inherit' })
process.exitCode = child.status ?? 1
if (args[0] === 'state' && existsSync(${JSON.stringify(effect)})) {
  for (const item of JSON.parse(readFileSync(${JSON.stringify(effect)}, 'utf8'))) writeFileSync(item.file, item.content)
  rmSync(${JSON.stringify(effect)})
}
`)
  writeConfig(f.home, { ...f.config, gateBin: gate })
  return () => readJsonLines(calls).filter(args => args[0] === 'state').map(args => args[1])
}

/** 在出口用例的仓库中再加一个已归档批次，并写入进度视图的归档清单。返回归档目录。 */
function addArchivedBatch(f, name, files) {
  const dir = join(f.repo, 'openspec', 'changes', 'archive', `2026-11-16-${name}`)
  mkdirSync(dir, { recursive: true })
  writeFiles(dir, files)
  const value = JSON.parse(readFileSync(f.viewFile, 'utf8'))
  writeFileSync(f.viewFile, JSON.stringify({ ...value, archived: [...value.archived, { name, date: '2026-11-16' }] }))
  return dir
}

const exitingRecord = (startedAt, extra = {}) => ({ status: 'exiting', startedAt, rule: 'R11', tier: 'MVP', ...extra })
/** 已送达、等待回复的推送出口决策：本批次每轮只核对状态，不推进也不发卡。 */
const sentExit = startedAt => ({
  id: 'D-0001', kind: 'exit', status: 'pending', stage: 'exit', batchStartedAt: startedAt,
  request: { action: 'push', branch: null, commits: [], options: ['推送', '暂不处理'] },
  card: { messageId: 'om_card', sendState: 'sent' },
})
const remoteMain = f => spawnSync('git', ['--git-dir', f.origin, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim()

test('出口：归档批次暂缓或状态无法核验时不生成推送清单、不推送，同名活跃变更不能代替归档批次的状态（任务 3.2）', async t => {
  for (const [label, text, title] of [
    ['暂缓', stateText(SCHED_PAUSE), '托管与推进意愿不一致'],
    ['状态文件无效', INVALID_STATES[0][1], '托管无法核验变更状态'],
  ]) {
    await t.test(label, st => {
      const f = exitScenario(st)
      writeExitRecord(f)
      writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
      answeredCommit(f)
      assert.equal(f.run().code, 0)
      assert.equal(decisionOf(f, 'D-0001').result.ok, true, JSON.stringify(decisionOf(f, 'D-0001').result))
      // 同名活跃变更处于继续推进：调度不能用它的状态放行归档批次的出口。
      mkdirSync(join(f.repo, 'openspec', 'changes', 'demo'), { recursive: true })
      writeFileSync(f.viewFile, JSON.stringify({ ...JSON.parse(readFileSync(f.viewFile, 'utf8')), active: [schedEntry()] }))
      writeFileSync(join(f.changeDir, 'change-state.json'), text)
      const recordPath = join(f.changeDir, 'decisions', 'autopilot.json')
      const record = readFileSync(recordPath)
      const remote = remoteMain(f)
      const sent = f.larkCalls().length
      const restore = failLark(f)
      assert.equal(f.run().code, 0)
      restore()
      for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
      assert.equal(f.decisions().filter(item => item.request?.action === 'push').length, 0, '不生成推送清单，不创建推送决策')
      assert.deepEqual(readFileSync(recordPath), record)
      assert.equal(remoteMain(f), remote)
      assert.equal(f.claudeCalls().length, 0)
      assert.equal(readFileSync(join(f.changeDir, 'change-state.json'), 'utf8'), text)
      const notices = f.larkCalls().slice(sent)
      assert.equal(notices.length, 2, '发送失败的下一轮再次通知，成功后不再通知')
      assert.ok(notices.every(call => call.content.includes(title)), notices.map(call => call.content).join('\n'))
      assert.equal(argOf(notices[1], '--idempotency-key'), argOf(notices[0], '--idempotency-key'))
      for (const secret of [SCHED_PAUSE.reason, f.repo, realpathSync.native(f.repo), f.home, 'change-state.json']) {
        assert.ok(!notices[1].content.includes(secret), `通知不得包含 ${secret}`)
      }
    })
  }
})

test('出口：推送执行期间状态改为暂缓时本次推送照常完成，下一轮不结束出口、不领取新动作，只发一次通知（ARCH-16）', t => {
  const f = exitScenario(t)
  writeExitRecord(f)
  writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
  answeredCommit(f)
  assert.equal(f.run().code, 0)
  assert.equal(f.run().code, 0)
  const push = f.decisions().find(item => item.kind === 'exit' && item.request.action === 'push')
  assert.ok(push, JSON.stringify(f.decisions()))
  writeFileSync(join(f.changeDir, 'decisions', `${push.id}.json`), `${JSON.stringify({ ...push, status: 'answered',
    answer: { operatorId: 'ou_owner', eventId: 'E2', choice: '推送', text: '' } }, null, 2)}\n`)
  // pre-push 钩子在 git push 运行期间写入暂缓：推送已经开始，调度内部不再复核状态。
  const stateFile = join(f.changeDir, 'change-state.json')
  const script = join(f.doublesDir, 'pre-push.mjs')
  writeFileSync(script, `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(stateFile)}, ${JSON.stringify(stateText(SCHED_PAUSE))})\n`)
  const hook = join(f.repo, '.git', 'hooks', 'pre-push')
  writeFileSync(hook, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)}\n`)
  chmodSync(hook, 0o755)
  assert.equal(f.run().code, 0)
  assert.ok(existsSync(stateFile), '钩子已在推送期间写入暂缓')
  assert.equal(decisionOf(f, push.id).result.ok, true, JSON.stringify(decisionOf(f, push.id).result))
  assert.equal(remoteMain(f), f.git('rev-parse', 'main'), '本次推送照常完成')
  rmSync(hook)
  const recordPath = join(f.changeDir, 'decisions', 'autopilot.json')
  const record = readFileSync(recordPath)
  const decisions = f.decisions()
  const sent = f.larkCalls().length
  for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
  assert.equal(f.record().status, 'exiting', '暂缓后下一轮不结束出口')
  assert.deepEqual(readFileSync(recordPath), record)
  assert.deepEqual(f.decisions(), decisions)
  assert.equal(f.claudeCalls().length, 0)
  const notices = f.larkCalls().slice(sent)
  assert.equal(notices.length, 1)
  assert.ok(notices[0].content.includes('托管与推进意愿不一致'), notices[0].content)
})

test('出口：取得状态快照后、领取出口动作前状态变为暂缓时，不起草、不执行、不消费回复（任务 3.2）', async t => {
  for (const [label, setup, check] of [
    ['执行已回复的出口决策', f => {
      writeExitRecord(f)
      writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
      answeredCommit(f)
    }, f => {
      assert.ok(!f.logCommits().includes('提交说明'), '不提交')
      assert.equal(decisionOf(f, 'D-0001').status, 'answered')
    }],
    ['起草出口', f => {
      writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
      draftPlan(f, { branch: 'fix/x', files: ['README.md'], message: '说明' })
      // 托管记录已为 exiting：本用例只观察起草前的领取点。
      writeExitRecord(f, { implSnapshot: digestOf(f, ['README.md']) })
    }, f => {
      assert.equal(f.claudeCalls().length, 0, '不起草')
      assert.deepEqual(f.decisions(), [])
    }],
    ['消费已回复的出口告警', f => {
      writeExitRecord(f)
      writeFiles(f.changeDir, { 'decisions/D-0001.json': { id: 'D-0001', kind: 'exit-alert', status: 'answered', stage: 'exit',
        request: { exitAction: 'push', options: ['重试本项', '暂不处理', '回会话处理'] },
        answer: { operatorId: 'ou_owner', choice: '暂不处理' } } })
    }, f => {
      assert.equal(decisionOf(f, 'D-0001').status, 'answered')
      assert.equal(f.record().status, 'exiting', '不结束出口')
    }],
  ]) {
    await t.test(label, st => {
      const f = exitScenario(st)
      setup(f)
      countingGate(f)
      // 门禁替身输出快照之后才写入暂缓：调度只能在领取点的保护内复核摘要时发现变化。
      writeFileSync(join(f.doublesDir, 'gate-effect.json'), JSON.stringify([
        { file: join(f.changeDir, 'change-state.json'), content: stateText(SCHED_PAUSE) },
      ]))
      const recordPath = join(f.changeDir, 'decisions', 'autopilot.json')
      const record = readFileSync(recordPath)
      assert.equal(f.run().code, 0)
      assert.equal(existsSync(join(f.doublesDir, 'gate-effect.json')), false, '替身已在快照后写入暂缓')
      check(f)
      assert.deepEqual(readFileSync(recordPath), record)
      assert.equal(f.larkCalls().length, 0, '快照之后的变化只写本机日志')
      // 下一轮按新快照发现暂缓并通知，仍不领取。
      assert.equal(f.run().code, 0)
      check(f)
      assert.deepEqual(readFileSync(recordPath), record)
      assert.equal(noticesTitled(f, '托管与推进意愿不一致').length, 1)
    })
  }
})

test('出口：每个归档批次每轮只读一次状态（PERF-09）', t => {
  const f = exitScenario(t, { files: {
    'decisions/autopilot.json': exitingRecord('2026-11-06T10:00:00Z'), 'decisions/D-0001.json': sentExit('2026-11-06T10:00:00Z'),
  } })
  const other = addArchivedBatch(f, 'other', {
    'decisions/autopilot.json': exitingRecord('2026-11-07T10:00:00Z'), 'decisions/D-0001.json': sentExit('2026-11-07T10:00:00Z'),
  })
  const stateReads = countingGate(f)
  for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
  const counts = {}
  for (const dir of stateReads()) counts[dir] = (counts[dir] || 0) + 1
  assert.deepEqual(counts, { [realpathSync.native(f.changeDir)]: 2, [realpathSync.native(other)]: 2 })
  assert.equal(f.claudeCalls().length, 0)
  assert.equal(f.larkCalls().length, 0)
})

test('出口：归档状态读取用尽本轮 10 秒时按无法核验通知，未读取的批次本轮不启动出口，下一轮再读取（PERF-09）', t => {
  const f = exitScenario(t, { files: {
    'decisions/autopilot.json': exitingRecord('2026-11-06T10:00:00Z'), 'decisions/D-0001.json': sentExit('2026-11-06T10:00:00Z'),
  } })
  // 第二个批次的出口动作都已完成：一旦处理就会结束出口。
  const other = addArchivedBatch(f, 'other', {
    'decisions/autopilot.json': exitingRecord('2026-11-07T10:00:00Z', { exit: { 'commit-merge': { ok: true }, push: { ok: true } } }),
  })
  const stateReads = countingGate(f)
  writeFileSync(join(f.doublesDir, 'gate-sleep.json'), '15')
  const otherRecord = join(other, 'decisions', 'autopilot.json')
  const before = readFileSync(otherRecord)
  const started = Date.now()
  assert.equal(f.run().code, 0)
  assert.ok(Date.now() - started < 14_000, `慢读取应在 10 秒截止时间结束：${Date.now() - started} 毫秒`)
  assert.deepEqual(stateReads(), [realpathSync.native(f.changeDir)], '时间用尽后不再读取第二个批次')
  assert.deepEqual(readFileSync(otherRecord), before, '未读取的批次本轮不启动出口')
  assert.equal(noticesTitled(f, '托管无法核验变更状态').length, 1)
  assert.equal(f.run().code, 0)
  assert.deepEqual(stateReads(), [realpathSync.native(f.changeDir), realpathSync.native(f.changeDir), realpathSync.native(other)])
  assert.equal(JSON.parse(readFileSync(otherRecord, 'utf8')).status, 'closed')
})

test('通知上限：4 个批次同时状态异常时第一轮发 3 条，第二轮发第 4 条，推迟的批次不领取新动作（PERF-13）', t => {
  const names = ['demo', 'p2', 'p3', 'p4']
  const f = schedScenario(t, { view: { root: null, active: names.map(change => schedEntry({ change })), implementing: [], archived: [] },
    files: { 'change-state.json': stateText(SCHED_PAUSE) } })
  names.slice(1).forEach((name, index) => writeFiles(join(f.repo, 'openspec', 'changes', name), {
    'decisions/autopilot.json': managedRecord({ startedAt: `2026-11-06T1${index + 1}:00:00Z` }),
    'change-state.json': stateText(SCHED_PAUSE),
  }))
  const records = () => names.map(name => readFileSync(join(f.repo, 'openspec', 'changes', name, 'decisions', 'autopilot.json'), 'utf8'))
  const before = records()
  const changesOf = calls => calls.map(call => names.find(name => call.content.includes(`变更：${name}`)))
  assert.equal(f.run().code, 0)
  const first = noticesTitled(f, '托管与推进意愿不一致')
  assert.equal(first.length, 3, '每轮最多 3 条')
  assert.deepEqual(changesOf(first), ['demo', 'p2', 'p3'])
  assert.equal(f.run().code, 0)
  const second = noticesTitled(f, '托管与推进意愿不一致').slice(3)
  assert.deepEqual(changesOf(second), ['p4'])
  assert.equal(f.run().code, 0)
  assert.equal(noticesTitled(f, '托管与推进意愿不一致').length, 4)
  assert.equal(f.claudeCalls().length, 0)
  assert.deepEqual(records(), before)
})

test('STD-02、SPEC-03：通知没有可核对的消息编号时用同一键重试，取得回执后停止', t => {
  const f = schedScenario(t, { lark: 7, files: { 'change-state.json': stateText(SCHED_PAUSE) } })
  const run = () => assert.equal(f.run().code, 0)
  run()
  larkDouble(f.doublesDir, { messageId: 'om_confirmed' })
  run()
  run()
  const notices = noticesTitled(f, '托管与推进意愿不一致')
  assert.equal(notices.length, 2)
  assert.equal(argOf(notices[1], '--idempotency-key'), argOf(notices[0], '--idempotency-key'))
  assert.equal(f.decisions().length, 0)
})

test('无编号通知：发送失败时不记录去重，下一轮用同一幂等键再次发送（SEC-16）', async t => {
  const traceFails = f => {
    const gate = gateDoublePath(f)
    writeFileSync(gate, "if (process.argv[2] === 'trace') process.exitCode = 1; else process.stdout.write('usage: trace')\n")
    writeConfig(f.home, { ...f.config, gateBin: gate })
  }
  for (const [label, title, setup] of [
    ['恢复时原批次已结束（diagnostic）', '托管核对未完成', f => {
      writeFiles(f.changeDir, { 'decisions/autopilot.json': managedRecord({ status: 'closed' }) })
      writePendingTrace(f.home, [stageEntry(f, 'demo')])
    }],
    ['候选的回复不属于当前批次（diagnostic）', '托管核对未完成', f => {
      writeFiles(f.changeDir, { 'decisions/D-0003.json': answeredQuestionDecision({ batchStartedAt: '2026-01-01T00:00:00Z' }) })
    }],
    ['运行前读取处理记录失败', '托管无法读取运行前的处理记录', traceFails],
    ['启动前核对不通过', '托管启动前核对不通过', f => {
      writeFiles(f.userHome, { '.claude/settings.json': { permissions: { allow: ['Bash(curl:*)'] } } })
    }],
    ['运行环境检查不通过', '托管运行环境检查不通过', f => {
      writeConfig(f.home, { ...f.config, claudeBin: join(f.home, 'no-such-claude') })
    }],
  ]) {
    await t.test(label, st => {
      const f = schedScenario(st)
      setup(f)
      const restore = failLark(f)
      f.run()
      assert.equal(noticesTitled(f, title).length, 1, '第一轮发送失败')
      restore()
      f.run()
      f.run()
      const notices = noticesTitled(f, title)
      assert.equal(notices.length, 2, '发送失败的下一轮再次发送，成功后不再发送')
      assert.equal(argOf(notices[1], '--idempotency-key'), argOf(notices[0], '--idempotency-key'))
      assert.equal(f.claudeCalls().length, 0)
    })
  }
})

// ---------------------------------------------------------------------------
// add-change-pause 任务 3.3：暂缓不删除未完成核对，发送结果未知时保留原决策（Seam S4：scheduler.mjs --once）
// ---------------------------------------------------------------------------

/** 一条已预留转交告警的核对起点，与原告警一起写入；卡片的发送记录由用例给出。 */
function reservedAlert(f, card, overrides = {}) {
  const { key, saved } = savedTraceFixture(f, { resultDecisionId: 'D-0001', resultKind: 'stage-alert', ...overrides })
  const prior = { id: 'D-0001', status: 'pending', kind: 'alert', stage: 'apply', batchStartedAt: saved.startedAt,
    request: { pendingTraceKey: key, traceBefore: saved.traceBefore, options: ['回会话处理'] }, card }
  writeFiles(f.changeDir, { 'decisions/D-0001.json': prior })
  writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: saved } } })
  return { key, saved, prior }
}

/** 已保存、但没有回写结果的发送领取记录。 */
const UNKNOWN_CLAIM = { id: 'c1', batchStartedAt: managedRecord().startedAt, decisionId: 'D-0001', key: 'k1',
  recipient: 'ou_owner', contentDigest: 'a'.repeat(64) }
const gateCalls = f => readJsonLines(join(f.doublesDir, 'gate-calls.log'))
const UNKNOWN_DELIVERY = '托管卡片发送结果未知'

test('暂缓与未完成核对并存：旧写者未证实停止时保留起点、不读比较结果；停止后按原协议交回会话，不重启或恢复阶段（任务 3.3）', async t => {
  const answered = answeredQuestionDecision()
  const f = schedScenario(t, { files: { 'change-state.json': stateText(SCHED_PAUSE), 'decisions/D-0003.json': answered } })
  const writer = spawnSignalTarget()
  t.after(() => writer.kill('SIGKILL'))
  // 恢复会话的阶段起点保存后中断：起点绑定已消费的原回复，写者仍存活。
  const { key, saved: base } = savedTraceFixture(f, { writer: writerIdentity(writer.pid), consumedDecisionId: answered.id })
  const saved = { ...base, traceBefore: { ...base.traceBefore, resumedDecisionIds: [answered.id] } }
  writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: saved } } })
  countingGate(f)
  assert.equal(f.run().code, 0)
  assert.deepEqual(pendingState(f).entries[key], saved, '保留原起点')
  assert.deepEqual(f.decisions(), [answered], '不消费原回复，不交回会话')
  assert.equal(gateCalls(f).filter(args => args[0] === 'trace').length, 0, '写者未证实停止时不读比较结果')
  assert.equal(f.claudeCalls().length, 0)
  const exit = new Promise(resolve => writer.once('exit', resolve))
  writer.kill('SIGTERM')
  await exit
  assert.equal(f.run().code, 0)
  assert.deepEqual(pendingState(f).entries, {}, '写者停止后按原协议核对并交回会话')
  const decisions = f.decisions()
  assert.equal(decisions.find(item => item.id === answered.id).status, 'used')
  const alert = decisions.find(item => item.kind === 'alert')
  assert.ok(alert && alert.status === 'pending' && alert.card.sendState === 'sent', JSON.stringify(decisions))
  assert.equal(decisionCards(f, alert.id).length, 1)
  assert.equal(f.run().code, 0)
  assert.equal(f.claudeCalls().length, 0, '不凭原回复重启，也不因暂缓之外的条件恢复阶段')
  assert.equal(f.changeRecord().status, 'active', '暂缓不解除占用，也不撤回托管')
  assert.equal(readFileSync(join(f.changeDir, 'change-state.json'), 'utf8'), stateText(SCHED_PAUSE))
})

test('恢复：卡片送达未回写、旧记录缺发送状态或已保存的编号不合法时不重发，保留原决策与核对起点，只发一次无编号通知（任务 3.3、SEC-15）', async t => {
  for (const [label, card] of [
    ['已领取、未回写', { messageId: null, sendState: 'claimed', claim: UNKNOWN_CLAIM }],
    ['旧记录没有发送状态也没有消息编号', { messageId: null }],
    ['已保存的消息编号不合法', { messageId: 'om 编号', sendState: 'sent', claim: UNKNOWN_CLAIM }],
  ]) {
    await t.test(label, st => {
      const f = schedScenario(st)
      const { key, saved, prior } = reservedAlert(f, card)
      for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
      assert.deepEqual(pendingState(f).entries[key], saved)
      assert.deepEqual(f.decisions(), [prior])
      assert.equal(decisionCards(f).length, 0, '不重发原卡片')
      assert.equal(f.claudeCalls().length, 0)
      const notices = noticesTitled(f, UNKNOWN_DELIVERY)
      assert.equal(notices.length, 1)
      assert.ok(!notices[0].content.includes('D-0001'), notices[0].content)
      assert.equal(f.larkCalls().length, 1)
    })
  }
})

test('恢复：发送领取写入失败时不调用飞书，保留原决策与核对起点；下一轮领取成功后发送并完成交接（任务 3.3）', t => {
  const f = schedScenario(t)
  const { key, saved, prior } = reservedAlert(f, { messageId: null, sendState: 'unclaimed' })
  const probe = join(f.doublesDir, 'reject-claim.cjs')
  // 保护内的决策写入使用相对决策目录的路径，因此只按文件名匹配。
  writeFileSync(probe, `const fs = require('node:fs')
if (process.argv[1]?.endsWith('scheduler.mjs')) {
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (/(^|\\/)D-0001\\.json$/.test(String(to)) && fs.readFileSync(from, 'utf8').includes('"claimed"')) {
      throw Object.assign(new Error('test'), { code: 'EACCES' })
    }
    return rename(from, to)
  }
  require('node:module').syncBuiltinESMExports()
}
`)
  assert.equal(f.run(['--once'], { NODE_OPTIONS: `--require ${probe}` }).code, 0)
  assert.equal(f.larkCalls().length, 0, '领取保存失败时不调用飞书')
  assert.deepEqual(f.decisions(), [prior])
  assert.deepEqual(pendingState(f).entries[key], saved)
  assert.equal(f.run().code, 0)
  assert.equal(decisionCards(f).length, 1)
  assert.equal(f.decisions()[0].card.sendState, 'sent')
  assert.deepEqual(pendingState(f).entries, {})
  assert.equal(f.claudeCalls().length, 0)
})

test('恢复：提问卡片发送结果未知且核对内容变化时保留原提问、预留与核对起点，不创建替代决策（任务 3.3）', t => {
  // 发送命令退出 0 但返回的编号不合法：结果未知。
  const f = schedScenario(t, { lark: 12345 })
  const { key } = savedTraceFixture(f)
  setClaudeOutput(f.doublesDir, { session_id: 's1', stop_reason: 'tool_deferred',
    deferred_tool_use: { id: 'T1', name: 'AskUserQuestion', input: QUESTION } })
  assert.equal(f.run().code, 0)
  const [question] = f.decisions()
  assert.equal(question.kind, 'question')
  assert.equal(question.card.sendState, 'claimed')
  const reserved = pendingState(f).entries[key]
  assert.equal(reserved?.resultDecisionId, question.id, '结果未知时不清理核对起点')
  assert.equal(noticesTitled(f, UNKNOWN_DELIVERY).length, 1, '首轮通知也未取得可核对的回执')
  writeFiles(f.changeDir, { 'review/standards.md': acceptedStandards() })
  // 原提问的送达仍未知；只有重试的无编号通知从第二轮起取得合法回执。
  larkDouble(f.doublesDir, { messageId: 'om_notice_confirmed' })
  for (const round of [2, 3]) {
    assert.equal(f.run().code, 0)
    assert.equal(noticesTitled(f, UNKNOWN_DELIVERY).length, 2, `第 ${round} 轮：通知成功后不再重试`)
  }
  assert.deepEqual(f.decisions(), [question], '不作废、不消费原提问，不创建替代决策')
  assert.deepEqual(pendingState(f).entries[key], reserved)
  assert.equal(f.claudeCalls().length, 1, '不恢复阶段')
  assert.equal(decisionCards(f, question.id).length, 1, '不重发原卡片')
  const notices = noticesTitled(f, UNKNOWN_DELIVERY)
  assert.equal(argOf(notices[0], '--idempotency-key'), argOf(notices[1], '--idempotency-key'))
  for (const notice of notices) assert.ok(!notice.content.includes(question.id), notice.content)
})

test('恢复：提前归档与发送结果未知同时出现时保存出口阻断，保留原告警、预留与核对起点，不发替代告警（任务 3.3）', t => {
  const f = schedScenario(t)
  const { key, saved, prior } = reservedAlert(f, { messageId: null, sendState: 'claimed', claim: UNKNOWN_CLAIM })
  // 原告警带「补充说明后继续」：已知送达时，恢复会用只回会话的告警替换它。
  const original = { ...prior, request: { ...prior.request, sessionId: 's1', options: ['补充说明后继续', '回会话处理'] } }
  writeFiles(f.changeDir, { 'decisions/D-0001.json': original })
  const archive = join(f.repo, 'openspec', 'changes', 'archive', '2026-11-20-demo')
  mkdirSync(join(archive, '..'), { recursive: true })
  renameSync(f.changeDir, archive)
  mutableView(f, view({ active: [], archived: [{ name: 'demo', date: '2026-11-20' }] }))
  for (let round = 0; round < 2; round += 1) assert.equal(f.run().code, 0)
  const read = file => JSON.parse(readFileSync(join(archive, 'decisions', file), 'utf8'))
  assert.deepEqual(read('autopilot.json').exitBlock, { reason: 'early-archive', stage: 'apply' })
  assert.deepEqual(read('D-0001.json'), original, '不作废原告警')
  assert.equal(existsSync(join(archive, 'decisions', 'D-0002.json')), false, '不发替代告警')
  assert.deepEqual(pendingState(f).entries[key], saved)
  assert.equal(f.claudeCalls().length, 0)
  assert.equal(decisionCards(f).length, 0)
  const notices = noticesTitled(f, UNKNOWN_DELIVERY)
  assert.equal(notices.length, 1)
  assert.ok(!notices[0].content.includes('D-0001'), notices[0].content)
})

test('通知上限：恢复路径的发卡结果未知通知共用每轮 3 条，推迟时不重发原卡片，不删除核对起点（PERF-13）', t => {
  const names = ['demo', 'p2', 'p3', 'p4']
  const f = schedScenario(t, { view: { root: null, active: names.map(change => schedEntry({ change })), implementing: [], archived: [] } })
  const root = realpathSync.native(f.repo)
  const entries = names.map((name, index) => {
    const startedAt = `2026-11-06T1${index}:00:00Z`
    const directory = join(f.repo, 'openspec', 'changes', name)
    writeFiles(directory, { 'decisions/autopilot.json': managedRecord({ startedAt }) })
    const entry = stageEntry(f, name, { startedAt, resultDecisionId: 'D-0001', resultKind: 'stage-alert' })
    writeFiles(directory, { 'decisions/D-0001.json': { id: 'D-0001', status: 'pending', kind: 'alert', stage: 'apply',
      batchStartedAt: startedAt,
      request: { pendingTraceKey: JSON.stringify([root, name, startedAt]), traceBefore: entry.traceBefore, options: ['回会话处理'] },
      card: { messageId: null, sendState: 'claimed', claim: { ...UNKNOWN_CLAIM, batchStartedAt: startedAt } } } })
    return entry
  })
  writePendingTrace(f.home, entries)
  const keys = Object.keys(pendingState(f).entries).sort()
  const changesOf = calls => calls.map(call => names.find(name => call.content.includes(`变更：${name}`)))
  assert.equal(f.run().code, 0)
  assert.equal(noticesTitled(f, UNKNOWN_DELIVERY).length, 3, '每轮最多 3 条')
  assert.deepEqual(Object.keys(pendingState(f).entries).sort(), keys, '推迟时不删除核对起点')
  assert.equal(f.run().code, 0)
  const all = noticesTitled(f, UNKNOWN_DELIVERY)
  assert.equal(all.length, 4)
  assert.deepEqual(changesOf(all).sort(), [...names].sort())
  assert.equal(f.run().code, 0)
  assert.equal(noticesTitled(f, UNKNOWN_DELIVERY).length, 4)
  assert.equal(f.larkCalls().length, 4, '推迟时不重发原卡片')
  assert.deepEqual(Object.keys(pendingState(f).entries).sort(), keys, '不删除核对起点')
  assert.equal(f.claudeCalls().length, 0)
})

test('慢通知用完共用的 60 秒后推迟其余批次，单次只给剩余时间（PERF-13）', t => {
  const names = ['demo', 'p2', 'p3']
  const f = schedScenario(t, { view: view({ active: names.map(change => schedEntry({ change })) }) })
  names.forEach((name, index) => writeFiles(join(f.repo, 'openspec', 'changes', name), {
    'decisions/autopilot.json': managedRecord({ startedAt: `2026-11-06T1${index}:00:00Z` }),
    'change-state.json': stateText(SCHED_PAUSE),
  }))
  // 只推进临时调度进程的单调时钟，不让测试实际睡眠 60 秒。飞书替身照常执行并记录发送内容。
  const probe = join(f.doublesDir, 'slow-notice.cjs')
  const limits = join(f.doublesDir, 'timeouts.log')
  writeFileSync(probe, `if (process.argv[1]?.endsWith('scheduler.mjs')) {
    const child = require('node:child_process'), fs = require('node:fs')
    const run = child.spawnSync
    let elapsed = 0
    Object.defineProperty(require('node:perf_hooks').performance, 'now', { value: () => elapsed })
    child.spawnSync = (bin, args, options) => {
      const result = run(bin, args, options)
      if (bin === ${JSON.stringify(f.config.larkBin)}) {
        fs.appendFileSync(${JSON.stringify(limits)}, options.timeout + '\\n')
        elapsed += elapsed === 0 ? 45000 : 15000
      }
      return result
    }
    require('node:module').syncBuiltinESMExports()
  }`)
  assert.equal(f.run(['--once'], { NODE_OPTIONS: `--require ${probe}` }).code, 0)
  assert.deepEqual(readJsonLines(limits), [60000, 15000])
  assert.equal(noticesTitled(f, '托管与推进意愿不一致').length, 2)
  assert.equal(f.run().code, 0)
  const notices = noticesTitled(f, '托管与推进意愿不一致')
  assert.equal(notices.length, 3)
  assert.ok(notices[2].content.includes('变更：p3'))
  assert.deepEqual(f.claudeCalls(), [])
})

test('STD-06：打开状态文件后读取失败，只发固定类别通知且不领取决策', t => {
  const f = schedScenario(t, { files: { 'decisions/D-0003.json': answeredQuestionDecision(),
    'change-state.json': stateText({ ...SCHED_PAUSE, state: 'enabled' }) } })
  const probe = join(f.doublesDir, 'state-read-error.cjs')
  writeFileSync(probe, `const fs = require('node:fs')
if (process.argv[1]?.endsWith('scheduler.mjs')) {
  const { openSync, readSync, closeSync } = fs
  const opened = new Map()
  fs.openSync = (file, ...args) => {
    const fd = openSync(file, ...args)
    if (String(file).endsWith('/change-state.json')) opened.set(fd, String(file))
    return fd
  }
  fs.readSync = (fd, ...args) => {
    if (opened.has(fd)) throw Object.assign(new Error('EIO: ' + opened.get(fd)), { code: 'EIO' })
    return readSync(fd, ...args)
  }
  fs.closeSync = fd => { opened.delete(fd); return closeSync(fd) }
  require('node:module').syncBuiltinESMExports()
}`)
  const result = f.run(['--once'], { NODE_OPTIONS: `--require "${probe}"` })
  assert.equal(result.code, 0, result.all)
  assert.equal(f.claudeCalls().length, 0)
  const [notice] = f.larkCalls()
  assert.match(notice.content, /托管无法核验变更状态/)
  assert.doesNotMatch(notice.content, /EIO|change-state\.json/)
  assert.ok(!notice.content.includes(realpathSync.native(f.repo)))
})

test('无编号通知：恢复会话与出口路径的状态核对抛出含绝对路径的错误时，通知只含固定字段，发送失败后下一轮再发（SEC-16）', async t => {
  // 领取点读取状态文件或变更目录时报出含绝对路径的系统错误：调度只能按固定类别通知，不外发原文。
  const rejectState = (f, target) => {
    const probe = join(f.doublesDir, 'reject-state.cjs')
    const match = target === 'file' ? "String(file).endsWith('/change-state.json')"
      : "!String(file).endsWith('/change-state.json') && new Error().stack.includes('verifyChangeState')"
    writeFileSync(probe, `const fs = require('node:fs')
if (process.argv[1]?.endsWith('scheduler.mjs')) {
  const lstat = fs.lstatSync
  fs.lstatSync = (file, ...rest) => {
    if (${match}) {
      throw Object.assign(new Error(\`EACCES: permission denied, lstat '\${file}'\`), { code: 'EACCES', path: String(file) })
    }
    return lstat(file, ...rest)
  }
  require('node:module').syncBuiltinESMExports()
}
`)
    return { NODE_OPTIONS: `--require ${probe}` }
  }
  const paths = [
    ['恢复已回复的会话', st => {
      const f = schedScenario(st, { files: { 'decisions/D-0003.json': answeredQuestionDecision() } })
      return { f, run: env => f.run(['--once'], env), claimed: () => f.claudeCalls().length > 0 }
    }],
    ['执行已回复的出口决策', st => {
      const f = exitScenario(st)
      writeExitRecord(f)
      writeFileSync(join(f.repo, 'README.md'), '# 改动\n')
      answeredCommit(f)
      return { f, run: env => f.run(env), claimed: () => f.logCommits().includes('提交说明') }
    }],
  ]
  for (const [label, setup] of paths) {
    for (const [source, target] of [['状态文件', 'file'], ['变更目录', 'directory']]) {
      await t.test(`${label}：读取${source}失败`, st => {
        const { f, run, claimed } = setup(st)
        const env = rejectState(f, target)
        const restore = failLark(f)
        assert.equal(run(env).code, 0)
        restore()
        for (let round = 0; round < 2; round += 1) assert.equal(run(env).code, 0)
        assert.equal(claimed(), false, '状态无法核验时不领取')
        assert.equal(noticesTitled(f, '托管核对未完成').length, 0, '状态错误不进入原文通知')
        const notices = noticesTitled(f, '托管无法核验变更状态')
        assert.equal(notices.length, 2, '发送失败的下一轮再次通知，成功后不再通知')
        assert.equal(argOf(notices[1], '--idempotency-key'), argOf(notices[0], '--idempotency-key'))
        for (const notice of notices) {
          for (const secret of [f.repo, realpathSync.native(f.repo), f.home, 'change-state.json', 'EACCES']) {
            assert.ok(!notice.content.includes(secret), `通知不得包含 ${secret}`)
          }
        }
      })
    }
  }
})

test('脚本来源无法核验时只在本机报告待核对记录，不运行脚本或飞书命令，原记录不变（任务 3.3）', t => {
  const f = schedScenario(t)
  const { key, saved } = savedTraceFixture(f)
  writeFiles(f.home, { 'pending-trace.json': { version: 1, entries: { [key]: saved } } })
  const pending = readFileSync(join(f.home, 'pending-trace.json'))
  // 门禁装在被托管的项目内：来源无法核验。
  const inside = join(f.repo, 'tools', 'implementation-gate.mjs')
  const marker = join(f.doublesDir, 'gate-ran')
  mkdirSync(dirname(inside), { recursive: true })
  writeFileSync(inside, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, '')\n`)
  writeConfig(f.home, { ...f.config, gateBin: inside })
  const result = f.run()
  assert.equal(result.code, 2, result.all)
  assert.equal(f.larkCalls().length, 0, '不调用飞书')
  assert.equal(existsSync(marker), false, '不运行未核验的脚本')
  assert.equal(f.claudeCalls().length, 0)
  assert.deepEqual(readFileSync(join(f.home, 'pending-trace.json')), pending, '原记录不变')
  assert.deepEqual(f.decisions(), [])
  assert.match(result.err, /demo/)
  assert.ok(result.err.includes(saved.startedAt), result.err)
  assert.match(result.err, /apply/)
  // 本机记录不可读时报告不可读，仍不调用飞书。
  writeFileSync(join(f.home, 'pending-trace.json'), '{ 损坏')
  const broken = f.run()
  assert.equal(broken.code, 2, broken.all)
  assert.match(broken.err, /本机待核对记录不可读/)
  assert.equal(f.larkCalls().length, 0)
  assert.equal(readFileSync(join(f.home, 'pending-trace.json'), 'utf8'), '{ 损坏')
})

// 来源校验必须先于任何辅助脚本调用；只在项目外并不能证明是操作者登记的安装副本。
for (const [key, relative] of [['gateBin', 'openspec-technical-review/scripts/implementation-gate.mjs'],
  ['progressBin', 'openspec-change-progress/scripts/progress.mjs']]) {
  test(`调度拒绝未登记安装根的 ${key}，只报告本机待核对记录`, t => {
    const f = schedScenario(t)
    const { key: id, saved } = savedTraceFixture(f)
    writePendingTrace(f.home, [saved])
    const file = join(f.doublesDir, '未登记', relative)
    const invoked = join(f.doublesDir, 'ran')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(invoked)}, '1'); process.stdout.write('trace')`)
    writeConfig(f.home, { ...f.config, [key]: file })
    const result = f.run()
    assert.equal(existsSync(invoked), false, '来源不明时不运行脚本，连用法探测也不运行')
    assert.equal(result.code, 2)
    assert.ok(result.err.includes(saved.startedAt))
    assert.deepEqual(pendingState(f).entries, { [id]: saved })
    assert.deepEqual(f.larkCalls(), [])
    assert.deepEqual(f.claudeCalls(), [])
  })
}

test('摘要卡片的发送结果未知时只发固定字段通知，不删除核对起点', t => {
  const f = schedScenario(t, { lark: 12345 })
  const { key, saved, prior } = reservedAlert(f, { messageId: null, sendState: 'unclaimed' })
  const decision = { ...prior, request: { ...prior.request, cardSummary: '核对项 100 条。' } }
  writeFiles(f.changeDir, { 'decisions/D-0001.json': decision })
  assert.equal(f.run().code, 0)
  assert.equal(noticesTitled(f, UNKNOWN_DELIVERY).length, 1)
  assert.equal(noticesTitled(f, '托管核对未完成').length, 0)
  assert.ok(!noticesTitled(f, UNKNOWN_DELIVERY)[0].content.includes(prior.id))
  assert.equal(f.run().code, 0)
  assert.equal(decisionCards(f, prior.id).length, 1)
  assert.deepEqual(pendingState(f).entries[key], saved)
})

test('桥接：消息编号不合法时不按编号对应回复，原决策保持待回复（SEC-15）', t => {
  const messageId = 'om 编号'
  const f = bridgeScenario(t, { events: [clickEvent({ message_id: messageId })], files: {
    'decisions/autopilot.json': managedRecord(),
    'decisions/D-0001.json': { ...answeredQuestion(), status: 'pending', answer: undefined, card: { messageId, sendState: 'sent' } },
  } })
  f.run()
  assert.equal(f.decision('D-0001').status, 'pending')
  assert.match(readFileSync(join(f.home, 'logs', 'bridge.log'), 'utf8'), /event-unknown-decision/)
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
