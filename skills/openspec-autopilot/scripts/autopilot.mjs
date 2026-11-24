#!/usr/bin/env node
/**
 * 托管入口：把签字后的变更交给托管、撤回托管、查看托管状态，以及暂缓或恢复变更的推进意愿。
 *
 * 所属：skill openspec-autopilot。调用方：/opsx:autopilot（命令镜像）与用户直接运行。
 * 输入：<变更名> 与子命令 start | cancel | status | pause | resume；pause 另需 --reason <非敏感原因>。
 * 输出：终端提示与退出码。退出码 0 成功，1 业务拒绝（规则不满足、已托管、记录状态不对、项目被占用），2 参数或环境错误。
 * 边界：只读进度视图、门禁快照与项目状态，只写变更目录中的 decisions/autopilot.json、decisions/D-<编号>.json
 *   与 change-state.json；start 另查询当前用户域已加载的定时与桥接服务，并运行同副本调度脚本的只读版本探测；
 *   不运行 claude，不发卡片，不做 git 写入，不加载或重启服务。
 */

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { readConfig, homeDir } from './lib/home.mjs'
import { decisionsDir, inDecisionDirectory, recordFile, scanDecisions, transition, voidOpenDecisions } from './lib/decisions.mjs'
import { BOOT_TIME_TOLERANCE, currentBootTime, isAlive, readLockFile } from './lib/lock.mjs'
import { readBoundedJson, sameObject } from './lib/bounded-json.mjs'
import { gitUserName, readProgressView, realPath } from './lib/project.mjs'
import { batchOf, checkProtectionTime, enumerateBatches, managementReadBudget, PROJECT_SCAN_LIMIT, PROTECTED_SCAN_MS,
  protectionProbeTimeout, readReturnHandoff, RECORD_LIMIT, withProjectProtection, withVerifiedBatch } from './lib/batch.mjs'
import { batchKey, pendingForName, readPendingTrace } from './lib/pending-trace.mjs'
import { writerStatus } from './lib/writer-instance.mjs'
import { writeJsonAtomic } from './lib/atomic-write.mjs'
import { trustedScript } from './lib/trusted-scripts.mjs'
import { activeDirectory, clearStateTemporaries, inChangeDirectory, readStateSnapshot, sameDirectory, STATE_FILE,
  STATE_VERSION, StateError, stateForWrite, stateReadBudget, stateSnapshot, validChangeName, verifyStateDigest } from './lib/change-state.mjs'

/** 退出码：0 成功；1 业务拒绝；2 参数或环境错误。 */
const EXIT = Object.freeze({ OK: 0, REJECTED: 1, ERROR: 2 })

/** 进度规则中可以交给托管的区间（design D1）。 */
const HANDOFF_RULES = ['R6', 'R7', 'R8', 'R9', 'R10', 'R11']

/** 本副本的脚本目录：已加载的定时与桥接服务必须运行这里的脚本（add-change-pause design D4「实际调度入口」）。 */
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * 托管准入核对的已加载服务：标签与 install.mjs 写出的 plist 一致；args 为解释器之后应有的完整参数。
 * 定时入口只接受同副本 scheduler.mjs 加 --once，桥接入口只接受同副本 bridge.mjs（design D4）。
 */
const LOADED_SERVICES = Object.freeze([
  { label: 'com.openspec.autopilot.scheduler', title: '定时服务', script: path.join(SCRIPTS_DIR, 'scheduler.mjs'), extra: ['--once'] },
  { label: 'com.openspec.autopilot.bridge', title: '桥接服务', script: path.join(SCRIPTS_DIR, 'bridge.mjs'), extra: [] },
])

/** 两次服务查询与一次只读探测从首次查询前起的合计上限（毫秒，design D4）。 */
const SERVICE_TOTAL_MS = 5_000

/** 每次服务查询或探测的单次上限（毫秒）；实际取它与剩余合计时间中的较小值（design D4）。 */
const SERVICE_STEP_MS = 2_000

/** 服务查询与探测输出的读取上限（字节）：只需读取一个服务的属性或一行 JSON。 */
const SERVICE_OUTPUT_LIMIT = 1024 * 1024

/** 会改变 Node.js 模块或脚本选择的环境变量：本版安装方式不使用，出现在服务环境中时退出 2（design D4）。 */
const NODE_OVERRIDES = ['NODE_OPTIONS', 'NODE_PATH']

/** 运行锁中绑定托管批次的字段：全部缺失时是调度本轮刚取得、尚未绑定批次的锁（design D0「项目占用核对」）。 */
const LOCK_BINDING_FIELDS = ['change', 'projectRoot', 'startedAt', 'runId']

/** 优先使用当前实际检出。检出之外必须检查全部配置，再认定唯一项目。 */
function matchingProjects(config) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  const root = top.status === 0 ? realPath(top.stdout.trim()) : null
  const projects = config.projects.map(project => ({ ...project, root: realPath(project.root) }))
  return projects.some(project => project.root === root) ? projects.filter(project => project.root === root) : projects
}

function startProject(config, name) {
  const hits = []
  for (const project of matchingProjects(config)) {
    const { view, error } = readProgressView(config, project.root)
    if (error) throw new Error(`进度视图不可读：${project.root}`)
    const entry = view.active?.find(item => item.change === name)
    if (entry) hits.push({ project, view, entry })
  }
  if (hits.length > 1) throw new Error(`多个项目存在活跃变更 ${name}：${hits.map(hit => hit.project.root).join('、')}`)
  return hits[0]
}

function managementBatch(config, name) {
  const hits = []
  for (const project of matchingProjects(config)) {
    const { candidates } = enumerateBatches(project.root, name)
    const open = candidates.filter(item => ['active', 'exiting'].includes(item.record?.status))
    const eligible = open.length ? open : candidates.filter(item => item.record?.status === 'void')
    for (const item of eligible) hits.push({ ...item, batch: batchOf(project, { change: name }, item.directory, item.record, item.location) })
  }
  if (hits.length !== 1) {
    const paths = hits.length ? `：${hits.map(hit => hit.directory).join('、')}` : ''
    throw new Error(`${name} ${hits.length ? '存在多个可选批次' : '没有可管理的托管记录'}${paths}`)
  }
  return hits[0]
}

/** 锁归属未知时不得据此停阶段或声明本批次已停止。 */
function lockFor(batch, timeout) {
  const lock = readLockFile(path.join(homeDir(), 'run.lock'))
  if (lock.stale) return { state: 'no', value: null }
  if (lock.unreadable) return { state: 'unknown', value: null }
  const value = lock.value
  if (!value || value.change !== batch.name) return { state: 'no', value: null }
  if (!value.projectRoot || !value.startedAt || !value.runId) return { state: 'unknown', value: null }
  if (value.projectRoot !== batch.root || value.startedAt !== batch.startedAt) return { state: 'no', value: null }
  return { value, state: value.writer ? writerStatus(value.writer, timeout) : value.claudePid ? 'unknown' : 'no' }
}

/**
 * 读取未完成核对文件；读取失败按无法验证处理，不写入（design D0 第 5 条）。
 * @param {Function} [charge] 项目保护内托管记录与待核对文件的累计读取额度（design D0 第 3 条，评审 PERF-12）。
 * @param {number} [inspected] 本次保护内已检查的目录条目数，额度用尽时写进拒绝说明。
 * @returns {object} 已校验的核对文件。
 * @throws {StateError} 退出码 1：文件无法验证或累计读取超过额度。
 */
function savedTrace(charge, inspected = 0) {
  try {
    return readPendingTrace(charge)
  } catch (error) {
    if (error.readBudget) throw new StateError(`未完成核对文件读取（已检查 ${inspected} 个条目）：${error.message}`, EXIT.REJECTED)
    throw new StateError(`未完成核对文件无法验证：${error.message}`, EXIT.REJECTED)
  }
}

/**
 * 读取项目的当前分支。
 * @param {string} root 项目根目录。
 * @returns {string|null} 分支名；不是分支状态（游离 HEAD）时为 null。
 */
function currentBranch(root) {
  const result = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

/**
 * 作废上一次托管遗留的决策，并列出遗留会话告警中的核对失败项（design D1，评审 CONC-12、SEC-19）。
 * @param {string} changeDir 变更目录。
 * @returns {string[]} 核对失败项的说明行。
 */
function voidLeftoverDecisions(changeDir) {
  const lines = []
  const cleanup = voidOpenDecisions(changeDir, '上一次托管遗留')
  if (cleanup.error) throw new Error(`遗留决策清单不完整：${cleanup.error}`)
  if (cleanup.failed.length) throw new Error(`遗留决策写入失败：${cleanup.failed.map(item => item.id).join('、')}`)
  for (const decision of cleanup.open) {
    const failures = (decision.request && decision.request.checkFailures) || []
    for (const failure of failures) {
      const id = failure.finding || failure.id || failure.field || ''
      const where = failure.file || ''
      const values = failure.before !== undefined || failure.after !== undefined
        ? `（${failure.before ?? '（无）'} → ${failure.after ?? '（无）'}）` : ''
      lines.push(`${id}${where ? ` ${where}` : ''}${values}`)
    }
  }
  return lines
}

/**
 * 准入快照（design D4「准入快照」）：校验进度视图的状态契约、全部活跃条目的目录身份与状态，以及 implementing 名称映射。
 * 只核对跨进程信封，状态内容仍由门禁解析；任一条目无法确认时整体拒绝，不把「不知道」当作可排除。
 * @param {object} view 进度视图。
 * @param {string} root 选定项目的真实根。
 * @returns {Map<string, {changeState: object, changeDirectory: object}>} 变更名到已核验快照。
 * @throws {StateError} 退出码 2：契约版本缺失、条目重复或缺字段、身份无法核对、状态未知、事实读取失败或名称无对应条目。
 */
function admissionSnapshot(view, root) {
  if (view.changeStateVersion !== STATE_VERSION) {
    throw new StateError(`进度视图没有变更状态契约 ${STATE_VERSION}，请配套同步 openspec-change-progress 与 openspec-technical-review 副本`)
  }
  const entries = new Map()
  const failures = []
  for (const item of view.active) {
    const change = item?.change
    if (!validChangeName(change)) {
      failures.push(`${String(change)}：条目名称无效`)
      continue
    }
    if (entries.has(change)) {
      failures.push(`${change}：进度视图中有重复条目`)
      continue
    }
    entries.set(change, null)
    // 事实读取失败的条目状态与目录身份均为 null，原因在 error 中；先报原因，不报缺字段。
    if (item.error) {
      failures.push(`${change}：${item.error}`)
      continue
    }
    try {
      const snapshot = stateSnapshot(item)
      // 目录身份须是选定项目下同名的活跃目录：门禁按选定项目根读取（评审 SEC-13）。
      if (snapshot.changeDirectory.path !== path.join(root, 'openspec', 'changes', change)) {
        throw new StateError('变更目录身份不属于选定项目')
      }
      entries.set(change, snapshot)
    } catch (error) {
      failures.push(`${change}：${error.message}`)
    }
  }
  const named = new Set()
  for (const change of view.implementing) {
    if (named.has(change)) failures.push(`${change}：implementing 中重复出现`)
    else if (!entries.has(change)) failures.push(`${change}：implementing 中的名称没有对应的活跃条目`)
    named.add(change)
  }
  if (failures.length) throw new StateError(`无法确认这些变更的状态，未登记托管：\n${failures.join('\n')}`)
  return entries
}

/**
 * 在合计截止时间内运行一次服务查询或探测；剩余不足 1 毫秒时不启动，超时停止子进程且不接纳迟到结果（design D4）。
 * @param {number} deadline 单调时钟上的合计截止时间。
 * @param {string} step 失败说明中的步骤名。
 * @param {string} command 命令。
 * @param {string[]} args 参数。
 * @returns {object} spawnSync 的结果。
 * @throws {StateError} 退出码 2：超时或无法运行。
 */
function serviceStep(deadline, step, command, args) {
  const remaining = Math.floor(deadline - performance.now())
  if (remaining < 1) throw new StateError(`${step}超时：服务查询与只读版本探测合计超过 ${SERVICE_TOTAL_MS} 毫秒`)
  const timeout = Math.min(SERVICE_STEP_MS, remaining)
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: SERVICE_OUTPUT_LIMIT,
  })
  if (result.error?.code === 'ETIMEDOUT' || result.signal) throw new StateError(`${step}超时（${timeout} 毫秒）`)
  if (result.error) throw new StateError(`${step}无法运行：${result.error.message}`)
  return result
}

/**
 * 解析 `launchctl print` 的一级字段：program、arguments、environment 与 inherited environment。
 * 只读一级缩进的块，块内每行为二级缩进；同一字段出现两次或块未闭合时按无法核验处理。
 * @param {string} text launchctl print 的标准输出。
 * @returns {{ program: string|null, arguments: string[]|null, environment: Map|null, inherited: Map|null }} 解析结果。
 */
function parseLoadedService(text) {
  const service = { program: null, arguments: null, environment: null, inherited: null }
  const blocks = { arguments: 'arguments', environment: 'environment', 'inherited environment': 'inherited' }
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const program = /^\tprogram = (.+)$/.exec(lines[index])
    if (program) {
      if (service.program !== null) throw new Error('program 出现两次')
      service.program = program[1]
      continue
    }
    const block = /^\t(arguments|environment|inherited environment) = \{$/.exec(lines[index])
    if (!block) continue
    const key = blocks[block[1]]
    if (service[key] !== null) throw new Error(`${block[1]} 出现两次`)
    const items = []
    for (index += 1; index < lines.length && lines[index] !== '\t}'; index += 1) {
      if (!lines[index].startsWith('\t\t')) throw new Error(`${block[1]} 块格式无效`)
      items.push(lines[index].slice(2))
    }
    if (index >= lines.length) throw new Error(`${block[1]} 块未闭合`)
    if (key === 'arguments') {
      service.arguments = items
      continue
    }
    const values = new Map()
    for (const line of items) {
      const at = line.indexOf(' => ')
      if (at < 1) throw new Error(`${block[1]} 块格式无效`)
      values.set(line.slice(0, at), line.slice(at + 4))
    }
    service[key] = values
  }
  return service
}

/** 解析真实路径；路径不存在或无法解析时为 null，由调用方按不一致处理。 */
function realPathOrNull(target) {
  try {
    return typeof target === 'string' && path.isAbsolute(target) ? realPath(target) : null
  } catch {
    return null
  }
}

/**
 * 核对一项已加载服务与当前托管副本一致：解释器、完整参数、托管目录与 Node.js 环境覆盖（design D4「实际调度入口」）。
 * @param {object} expected LOADED_SERVICES 中的一项。
 * @param {object} service parseLoadedService 的结果。
 * @param {string} node 本次管理进程 Node.js 的真实路径。
 * @param {string} home 当前托管目录的真实路径。
 * @throws {StateError} 退出码 2：任一项不一致或无法核验。
 */
function checkLoadedService(expected, service, node, home) {
  const { title } = expected
  const program = realPathOrNull(service.program)
  let executable = false
  try {
    executable = !!program && statSync(program).isFile() && (accessSync(program, constants.X_OK), true)
  } catch {
    executable = false
  }
  if (program !== node || !executable) {
    throw new StateError(`${title}的解释器不是本次管理进程的 Node.js（${node}）：${service.program ?? '（未写出）'}`)
  }
  // 解释器之后只能是同副本脚本与固定参数：额外的 Node.js 参数可以改变模块或脚本选择。
  const args = service.arguments ?? []
  const wanted = [expected.script, ...expected.extra]
  const script = realPathOrNull(expected.script)
  // 两个无法解析的路径不代表同一份脚本，目录也不能充作启动入口。
  let sameScript = false
  try { sameScript = !!script && script === realPathOrNull(args[1]) && statSync(script).isFile() } catch { /* 无法再次核实时拒绝登记。 */ }
  if (args.length !== wanted.length + 1 || realPathOrNull(args[0]) !== node || !sameScript
    || expected.extra.some((arg, index) => args[index + 2] !== arg)) {
    throw new StateError(`${title}的启动参数不是本副本的 ${path.basename(expected.script)}${expected.extra.length ? ` ${expected.extra.join(' ')}` : ''}：${args.join(' ') || '（未写出）'}`)
  }
  const configured = service.environment?.get('OPENSPEC_AUTOPILOT_HOME')
  if (realPathOrNull(configured) !== home) {
    throw new StateError(`${title}的托管目录与当前托管目录（${home}）不同：${configured ?? '（未设置）'}`)
  }
  for (const [block, values] of [['environment', service.environment], ['inherited environment', service.inherited]]) {
    for (const key of NODE_OVERRIDES) {
      if (values?.has(key)) throw new StateError(`${title}的 ${block} 设置了 ${key}，会改变 Node.js 的模块或脚本选择，不符合本版安装方式`)
    }
  }
}

/**
 * 核对当前 macOS 用户域已加载的定时与桥接服务，再用相同 Node.js 运行同副本调度脚本的只读版本探测（design D4）。
 * 在项目保护外运行；不以磁盘上的 plist 代替查询结果，不要求定时服务当前有进程，不加载或重启服务。
 * @throws {StateError} 退出码 2：服务未加载、与当前副本不一致、探测返回异常或超时。
 */
function verifyLoadedServices() {
  const deadline = performance.now() + SERVICE_TOTAL_MS
  const node = realPath(process.execPath)
  const home = realPathOrNull(homeDir())
  if (!home) throw new StateError(`当前托管目录无法解析：${homeDir()}`)
  for (const expected of LOADED_SERVICES) {
    // launchctl 按 PATH 查找，与用户在终端中运行的命令一致；只读查询，不改变服务。
    const result = serviceStep(deadline, `${expected.title}查询`, 'launchctl', ['print', `gui/${process.getuid()}/${expected.label}`])
    if (result.status !== 0) {
      throw new StateError(`${expected.title}（${expected.label}）未加载或无法查询（launchctl 退出码 ${result.status}）`)
    }
    let service
    try {
      service = parseLoadedService(result.stdout)
    } catch (error) {
      throw new StateError(`${expected.title}的查询结果无法核验：${error.message}`)
    }
    checkLoadedService(expected, service, node, home)
  }
  const [scheduler] = LOADED_SERVICES
  const probe = serviceStep(deadline, '只读版本探测', process.execPath, [scheduler.script, '--change-state-version'])
  if (probe.status !== 0) throw new StateError(`只读版本探测失败：退出码 ${probe.status}`)
  let value
  try {
    value = JSON.parse(probe.stdout)
  } catch {
    throw new StateError('只读版本探测的输出不是单个 JSON 对象')
  }
  // 唯一成功响应是只含契约版本的对象：其他字段说明加载的不是本版调度。
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
    || value.changeStateVersion !== STATE_VERSION) {
    throw new StateError(`只读版本探测返回的不是 {"changeStateVersion":${STATE_VERSION}}`)
  }
}

/**
 * 最终准入复核（design D4「最终准入」）：在项目写保护内，用本次扫描复核活跃目录名集合、每个活跃条目的目录实例与状态摘要。
 * 保护内不重跑进度视图或门禁；状态文件读取受 4 MiB 累计额度约束。
 * @param {object} scan 本次保护内的全项目候选扫描。
 * @param {Map} entries admissionSnapshot 的结果。
 * @throws {StateError} 退出码 1：任一项变化、超过上限或无法复核。
 */
function recheckAdmission(scan, entries) {
  const active = scan.candidates.filter(item => item.location === 'active')
  const names = active.map(item => path.basename(item.directory)).sort()
  const expected = [...entries.keys()].sort()
  if (names.length !== expected.length || names.some((item, index) => item !== expected[index])) {
    throw new StateError(`活跃变更目录与进度快照不一致，请重试（目录：${names.join('、') || '无'}；快照：${expected.join('、') || '无'}）`, EXIT.REJECTED)
  }
  const charge = stateReadBudget()
  for (const item of active) {
    checkProtectionTime()
    const name = path.basename(item.directory)
    const { changeDirectory, changeState } = entries.get(name)
    const stat = lstatSync(item.directory, { bigint: true })
    if (!stat.isDirectory() || !sameDirectory(changeDirectory, { path: item.directory, dev: String(stat.dev), ino: String(stat.ino) })) {
      throw new StateError(`${name} 的变更目录实例与进度快照不同，请重试`, EXIT.REJECTED)
    }
    try {
      verifyStateDigest(path.join(item.directory, STATE_FILE), changeState.digest, charge)
    } catch (error) {
      throw new StateError(`${name} 的状态无法复核：${error.message}`, EXIT.REJECTED)
    }
  }
}

/** 值为普通对象（不含数组与 null）。 */
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key)

/**
 * 未决出口（design D4「未决出口」，评审 CONC-16、CONC-17、DB-17）：只在本次登记依靠暂缓排除历史实现项时调用。
 * 已撤回的归档批次保存了提交与合并成功的结果时，可能有已启动的拉取；用本次开机时间晚于该托管记录修改时间 60 秒以上证明已停止。
 * 只读 D0 扫描已读的托管记录字段、该记录的修改时间和本次开机时间，不扫描决策目录或日志。
 * @param {object} scan 本次保护内的全项目候选扫描。
 * @throws {StateError} 退出码 1：有未决出口、出口结果无法核验或修改时间晚于当前时间。
 */
function assertNoPendingExit(scan) {
  for (const item of scan.candidates) {
    checkProtectionTime()
    if (item.location !== 'archived' || item.record?.status !== 'void' || !hasOwn(item.record, 'exit')) continue
    const { record } = item
    const unverifiable = detail => new StateError(`${item.directory} 的出口结果无法核验（${detail}），不能确认拉取已停止`, EXIT.REJECTED)
    if (!plainObject(record.exit)) throw unverifiable('exit 不是对象')
    if (!hasOwn(record.exit, 'commit-merge')) continue
    const commitMerge = record.exit['commit-merge']
    if (!plainObject(commitMerge)) throw unverifiable('exit.commit-merge 不是对象')
    if (hasOwn(commitMerge, 'ok') && typeof commitMerge.ok !== 'boolean') throw unverifiable('ok 不是布尔值')
    for (const key of ['mergeCommit', 'commit']) {
      if (hasOwn(commitMerge, key) && typeof commitMerge[key] !== 'string') throw unverifiable(`${key} 不是字符串`)
    }
    // 判据与调度相同：只有提交与合并标记 ok 后才起草推送，推送对象取 mergeCommit 或 commit；不校验提交标识的格式。
    const pushTarget = commitMerge.mergeCommit || commitMerge.commit
    if (commitMerge.ok !== true || !pushTarget) continue
    let mtimeMs
    try {
      mtimeMs = lstatSync(recordFile(item.directory)).mtimeMs
    } catch (error) {
      throw unverifiable(`托管记录不可读：${error.code || error.message}`)
    }
    if (mtimeMs > Date.now()) throw unverifiable('托管记录的修改时间晚于当前时间')
    // 本次开机晚于写为 void 的时间 60 秒以上：重启结束了当时的全部本机进程，void 批次也不会再被领取。
    if (currentBootTime() * 1000 > mtimeMs + BOOT_TIME_TOLERANCE * 1000) continue
    throw new StateError(`${item.directory} 有未决出口（批次 ${record.startedAt}，提交 ${pushTarget}），撤回后尚未重启，请重启后重试`, EXIT.REJECTED)
  }
}

/** 候选目录对应的变更名：活跃目录取目录名，归档目录去掉 YYYY-MM-DD- 前缀。 */
const candidateName = item => (item.location === 'active' ? path.basename(item.directory) : path.basename(item.directory).slice(11))

/**
 * 交接托管：写入托管记录。
 * 准入顺序（add-change-pause design D4）：可信脚本 → 进度视图与原规则 → 准入快照 → 目标暂缓与其他实现项 →
 * 已加载服务与只读探测（保护外）→ 项目写保护内的最终复核、实际占用与未决出口 → 在原目录实例中登记。
 * @param {string} name 变更名。
 * @param {object} config 托管配置。
 * @returns {{ code: number, message: string }} 退出码与输出。
 */
function start(name, config) {
  // 先核验进度与门禁脚本的来源，来源不符时不运行任何候选脚本（design D2）。
  let scripts
  try {
    scripts = { progressBin: trustedScript(config, 'progressBin'), gateBin: trustedScript(config, 'gateBin') }
  } catch (error) {
    return { code: EXIT.ERROR, message: error.message }
  }
  const found = startProject({ ...config, ...scripts }, name)
  if (!found) return { code: EXIT.ERROR, message: `进度视图中没有活跃变更 ${name}` }
  const { project, view, entry } = found

  // 进度视图的 implementing 数组缺失时退出码 2：不能把「不知道」当作「没有」（design D1，评审 ARCH-10）。
  if (!Array.isArray(view.implementing)) {
    return { code: EXIT.ERROR, message: '进度视图没有 implementing 数组，请同步 openspec-change-progress 副本' }
  }
  // 规则 R1–R5 表示产物不全、未评审、评审 BLOCKED 或签字空白，这些在会话中处理（design D1）。
  if (!HANDOFF_RULES.includes(entry.rule)) {
    const blockers = (entry.blockers || []).join('、')
    return { code: EXIT.REJECTED, message: `进度规则 ${entry.rule}${blockers ? `：${blockers}` : ''}，只在 R6–R11 时托管` }
  }
  // 门禁副本没有 reviewStale 时退出码 2：两个副本只同步一个时 R8 的新条件静默失效（design D1，评审 ARCH-18）。
  if (!('reviewStale' in entry) || entry.reviewStale === null) {
    return {
      code: EXIT.ERROR,
      message: '进度条目没有 reviewStale，请一起同步 openspec-change-progress 与 openspec-technical-review 两个副本',
    }
  }
  // 当前分支必须是项目的主分支：实现、测试与提交要基于同一个起点（design D1，评审 ARCH-07）。
  const branch = currentBranch(project.root)
  if (branch !== project.baseBranch) {
    return { code: EXIT.REJECTED, message: `当前分支是 ${branch || '（游离 HEAD）'}，项目的 baseBranch 是 ${project.baseBranch}` }
  }
  // quality 按回复写入的接受人、驳回人与决策人取这个用户名（design D1）。
  const userName = gitUserName(project.root)
  if (!userName) {
    return { code: EXIT.REJECTED, message: '项目没有 git config user.name，先设置用户名再托管' }
  }

  const entries = admissionSnapshot(view, project.root)
  const target = entries.get(name)
  // 推进意愿只由用户恢复：托管入口不自动恢复，也不把暂缓目标登记为托管（design D3）。
  if (target.changeState.state === 'paused') return { code: EXIT.REJECTED, message: `${name} 已暂缓，先运行 resume 恢复推进` }
  // 同一检出只实现一个变更（design D1，决策⑯）。implementing 保留历史名称；已核实暂缓的历史项只从基于阶段的占用中排除，
  // 托管批次、运行者与未完成核对仍在保护内独立检查（design D4「准入快照」）。
  const others = view.implementing.filter(item => item !== name)
  const excluded = others.filter(item => entries.get(item).changeState.state === 'paused')
  const implementingOthers = others.filter(item => !excluded.includes(item))
  if (implementingOthers.length) {
    return { code: EXIT.REJECTED, message: `同一检出中这些变更已开始实现：${implementingOthers.join('、')}` }
  }
  verifyLoadedServices()

  const targetDirectory = target.changeDirectory
  let written = false
  let result
  try {
    result = withProjectProtection(project.root, () => {
      const charge = managementReadBudget()
      const scan = enumerateBatches(project.root, name, undefined, { all: true, limit: PROJECT_SCAN_LIMIT, charge })
      recheckAdmission(scan, entries)
      const active = scan.candidates.find(item => item.location === 'active' && item.directory === targetDirectory.path)
      if (!active) throw new StateError(`找不到变更目录：${name}`, EXIT.REJECTED)
      // 同名候选（含已归档的 void 批次）的回会话告警未核验为 used 时不登记。
      for (const item of scan.candidates) {
        checkProtectionTime()
        if (candidateName(item) === name && item.record?.returnHandoff
          && readReturnHandoff(item.directory, item.record, config.ownerOpenId)?.status !== 'used') {
          return { code: EXIT.REJECTED, message: `${item.directory} 的回会话交接尚未完成` }
        }
      }
      // 按暂缓排除的名称同样核对未完成核对：其核对起点之后比较时会混入新批次的修改（评审 DB-13）。
      assertProjectIdle(scan, [name, ...excluded], charge)
      if (excluded.length) assertNoPendingExit(scan)
      const current = active.record
      // 在已复核的目录实例中按相对名建决策目录，不按名字路径写入同名替代目录（评审 CONC-06）。
      inChangeDirectory(targetDirectory, project.root, () => {
        checkProtectionTime()
        if (!existsSync(decisionsDir('.'))) mkdirSync(decisionsDir('.'), { mode: 0o700 })
      })
      const verified = enumerateBatches(project.root, name, undefined, { limit: PROJECT_SCAN_LIMIT, charge })
        .candidates.find(item => item.location === 'active')
      if (!verified || !sameObject(verified.identity, active.identity) || !sameDirectory(targetDirectory, activeDirectory(project.root, name))
        || verified.record?.startedAt !== current?.startedAt) throw new StateError('活跃目录或托管批次已改变，请重试', EXIT.REJECTED)
      const outcome = inDecisionDirectory(verified, project.root, () => {
        scan.verify()
        const leftovers = current?.status === 'void' ? voidLeftoverDecisions(verified.directory) : []
        const startedAt = new Date().toISOString()
        const record = transition(recordFile(verified.directory), ['void', 'closed'], {
          status: 'active', startedAt, rule: entry.rule, tier: entry.tier || null,
        }, { allowMissing: !current, replace: true, ...(current ? { startedAt: current.startedAt } : {}) })
        if (!record.ok) return { code: EXIT.ERROR, message: `写入托管记录失败：${record.reason}` }
        written = true
        return { startedAt, leftovers }
      }, checkProtectionTime)
      if (outcome.code !== undefined) return outcome
      // 归档不参与本保护。写入后原实例若已离开活跃位置，报告实际结果，不回滚，也不向同名新目录写入（评审 CONC-06）。
      let moved
      try {
        moved = !sameDirectory(targetDirectory, activeDirectory(project.root, name))
      } catch {
        moved = true
      }
      if (moved) {
        return {
          code: EXIT.ERROR,
          message: `已在原变更目录 ${targetDirectory.path} 写入托管记录（开始时间 ${outcome.startedAt}），但该目录已离开活跃位置；未回滚，也未写入同名新目录`,
        }
      }
      return outcome
    })
  } catch (error) {
    if (written) throw new StateError(`托管记录已写入原变更目录，但活跃位置无法核验：${error.message}`)
    throw error
  }
  if (result.code !== undefined) return result
  const { startedAt, leftovers } = result
  const lines = [`已托管 ${name}（规则 ${entry.rule}，开始时间 ${startedAt}）`]
  for (const item of leftovers) lines.push(`上一次托管遗留的核对失败项：${item}`)
  lines.push('托管期间不要在同一仓库中修改文件')
  return { code: EXIT.OK, message: lines.join('\n') }
}

/** 按最新锁实例停止已经核验的组。没有锁时还须核对持久保存的写者。 */
function stopRunningStage(batch, config) {
  const waitMs = Math.max(1, Number(config.cancelWaitSeconds || 30)) * 1000
  const deadline = Date.now() + waitMs
  const signaled = new Set()
  const waitCell = new Int32Array(new SharedArrayBuffer(4))
  let unknownLock = false
  do {
    const lock = lockFor(batch)
    const stored = savedTrace().entries[batchKey(batch)]
    const savedState = writerStatus(stored?.writer)
    // 未能归属的存活锁消失不是退出证明，不在同一次撤回中报告成功。
    if (!lock.value && lock.state === 'unknown' && !stored) unknownLock = true
    if (!lock.value && lock.state === 'no' && savedState === 'no' && !unknownLock) return { stopped: true }
    if (lock.state === 'yes' && !signaled.has(lock.value.runId)) {
      const current = lockFor(batch)
      if (current.state === 'yes' && current.value.runId === lock.value.runId && current.value.token === lock.value.token) {
        const writer = current.value.writer
        try {
          process.kill(-writer.pid, 'SIGTERM')
        } catch (error) {
          if (error.code !== 'ESRCH') throw new Error('无法停止已核验的阶段进程组')
        }
        signaled.add(current.value.runId)
      }
    }
    const remaining = deadline - Date.now()
    if (remaining > 0) Atomics.wait(waitCell, 0, 0, Math.min(200, remaining))
  } while (Date.now() < deadline)
  return { stopped: false, message: '托管已撤回，阶段仍在停止，确认停止后再修改仓库' }
}

/** 锁前后共用同一批次扫描和作废规则。 */
function withdraw(batch, config) {
  return withVerifiedBatch(batch, target => {
    if (!['active', 'exiting', 'void'].includes(target.record.status)) throw new Error('原批次已变化')
    const handoff = readReturnHandoff(target.directory, target.record, config.ownerOpenId)
    if (target.record.status !== 'void') {
      const result = transition(recordFile(target.directory), [target.record.status], {
        status: 'void', voidReason: '用户撤回',
      }, { startedAt: batch.startedAt })
      if (!result.ok) throw new Error('作废托管记录失败')
    }
    const preserved = handoff?.status === 'answered' ? handoff.id : null
    const cleanup = voidOpenDecisions(target.directory, '用户撤回', { preserve: preserved })
    if (cleanup.error) throw new Error(`决策清单不完整：${cleanup.error}`)
    if (cleanup.failed.length) throw new Error(`决策作废写入失败：${cleanup.failed.map(item => item.id).join('、')}`)
    return preserved
  })
}

function cancel(name, config) {
  const { batch } = managementBatch(config, name)
  const before = withdraw(batch, config)
  const stop = stopRunningStage(batch, config)
  if (!stop.stopped) return { code: EXIT.REJECTED, message: stop.message }
  const after = withdraw(batch, config)
  const lines = [`已撤回 ${name} 的托管`]
  if (after || before) lines.push(`回会话告警 ${after || before} 仍待核验交接`)
  if (savedTrace().entries[batchKey(batch)]) lines.push('未完成核对仍保留，请在会话中查看本次运行的修改。')
  return { code: EXIT.OK, message: lines.join('\n') }
}

/**
 * 定位状态查询的唯一目标：先找 active/exiting 批次，再找 void 批次，都没有时才接受无托管记录的活跃目录。
 * 整次查询共用一个截止时间和条目上限，配置检出外的全部项目也计入；预算用尽时不声明候选唯一或不存在（design D6，评审 PERF-11）。
 * @param {object} config 托管配置。
 * @param {string} name 变更名。
 * @returns {object} 选定的候选：目录、记录、所属项目、真实根与 bigint 目录身份。
 * @throws {StateError} 预算用尽或候选不唯一时退出码 2，没有候选时退出码 1；记录损坏等扫描错误原样抛出。
 */
function statusTarget(config, name) {
  const deadline = performance.now() + PROTECTED_SCAN_MS
  const budget = () => {
    if (Math.floor(deadline - performance.now()) < 1) throw new Error(`查询时间超过 ${PROTECTED_SCAN_MS} 毫秒`)
  }
  let inspected = 0
  let projects = 0
  const hits = []
  for (const project of matchingProjects(config)) {
    let scan
    try {
      scan = enumerateBatches(project.root, name, budget, { limit: PROJECT_SCAN_LIMIT - inspected })
    } catch (error) {
      if (!error.scanBudget) throw error
      throw new StateError(`查询预算已用尽：已完成 ${projects} 个项目、${inspected} 个条目；当前项目 ${project.root}：${error.message}。请在项目检出内重试`)
    }
    inspected += scan.inspected
    projects += 1
    const open = scan.candidates.filter(item => ['active', 'exiting'].includes(item.record?.status))
    const eligible = open.length ? open : scan.candidates.filter(item => item.record?.status === 'void')
    // 没有可查询批次时，只有已读到「没有托管记录」的活跃目录才算未托管；closed 等其他记录不算。
    const unmanaged = eligible.length ? [] : scan.candidates.filter(item => item.location === 'active' && !item.record)
    for (const item of [...eligible, ...unmanaged]) hits.push({ ...item, project, root: scan.root })
  }
  if (hits.length > 1) throw new StateError(`${name} 存在多个可选批次：${hits.map(hit => hit.directory).join('、')}`)
  if (!hits.length) throw new StateError(`${name} 没有可查询的托管记录或活跃变更`, EXIT.REJECTED)
  const [hit] = hits
  // 扫描得到的身份是普通数值；门禁按十进制字符串输出，先换成 bigint 身份再比较，并确认仍是同一目录对象。
  const stat = lstatSync(hit.directory, { bigint: true })
  if (!stat.isDirectory() || Number(stat.dev) !== hit.identity.dev || Number(stat.ino) !== hit.identity.ino) {
    throw new StateError('查询期间变更目录已改变，请重试')
  }
  return { ...hit, selected: { path: hit.directory, dev: String(stat.dev), ino: String(stat.ino) } }
}

/** 显示前再读一次选定目录的托管记录：目录对象或批次变化时，不把新目录的状态与原批次一起显示（design D6，评审 SEC-14）。 */
function recheckStatusTarget(target) {
  const stat = lstatSync(target.directory, { bigint: true })
  if (!stat.isDirectory() || String(stat.dev) !== target.selected.dev || String(stat.ino) !== target.selected.ino) {
    throw new StateError('读取状态时变更目录已改变，请重试')
  }
  let record = null
  try { record = readBoundedJson(recordFile(target.directory), RECORD_LIMIT) } catch (error) {
    // 决策目录或记录文件缺失时为未托管；其他读取错误不能证明记录没有变化。
    if (error.code !== 'ENOENT') throw new StateError(`托管记录无法再次读取：${error.code || error.message}`)
  }
  if ((record?.startedAt ?? null) !== (target.record?.startedAt ?? null)) throw new StateError('读取状态时托管记录已改变，请重试')
}

/** 原因按普通文本显示：转义反斜杠、换行、控制字符和表格分隔符（design D1「原因的可见范围」）。 */
function plainText(text) {
  const named = { '\\': '\\\\', '|': '\\|', '\n': '\\n', '\r': '\\r', '\t': '\\t' }
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029|\\]/gu,
    char => named[char] ?? `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`)
}

/**
 * 查看一个变更的推进意愿与托管运行信息，也覆盖尚未托管的变更（design D6）。
 * 状态只经门禁 state 子命令读取，不计算实现指纹；门禁来源或状态无法核实时退出码 2，仍显示可读的本机托管信息。
 * @param {string} name 变更名。
 * @param {object} config 托管配置。
 * @returns {{ code: number, message: string }} 退出码与输出。
 */
function status(name, config) {
  const pending = savedTrace()
  let target
  try { target = statusTarget(config, name) } catch (error) {
    const paths = Object.values(pending.entries).filter(item => item.name === name)
      .map(item => `${item.startedAt} ${item.directory}`)
    // 没有候选由 statusTarget 显式标为业务拒绝；无法完整读取候选不等于没有候选。
    return { code: error instanceof StateError ? error.code : EXIT.ERROR, message: [error.message, ...paths].join('\n') }
  }
  const { directory, record } = target
  let local = ['托管记录：未托管']
  if (record) {
    const batch = batchOf(target.project, { change: name }, directory, record, target.location)
    const counts = new Map()
    const error = scanDecisions(decisionsDir(directory), decision => counts.set(decision.status, (counts.get(decision.status) || 0) + 1))
    if (error) return { code: EXIT.ERROR, message: `${record.startedAt} ${directory}：决策清单不完整（${error}）` }
    const saved = pending.entries[batchKey(batch)]
    const lock = lockFor(batch)
    const savedState = writerStatus(saved?.writer)
    const running = lock.state === 'yes' || savedState === 'yes' ? '是'
      : lock.state === 'unknown' || savedState === 'unknown' ? '无法确定' : '否'
    local = [`批次：${record.startedAt}`, `托管记录：${JSON.stringify(record)}`, `阶段运行中：${running}`]
    if (saved) local.push(`未完成核对：${saved.mode} ${saved.stage || ''}（${saved.directory}）`)
    if (record.returnHandoff && !readReturnHandoff(directory, record, config.ownerOpenId)?.completed) local.push('回会话交接待确认')
    for (const [key, count] of [...counts].sort()) local.push(`决策 ${key}: ${count}`)
  }
  let code = EXIT.OK
  let state
  try {
    // 来源核验失败时不运行任何脚本；以选定项目根传 --repo，不由目标路径推导项目根（评审 SEC-13）。
    const gate = trustedScript(config, 'gateBin')
    const snapshot = readStateSnapshot(gate, target.root, directory, 'state')
    if (!sameDirectory(snapshot.changeDirectory, target.selected)) throw new StateError('读取状态时变更目录已改变，请重试')
    recheckStatusTarget(target)
    const { changeState } = snapshot
    state = [`变更状态：${changeState.state}`]
    if (changeState.reason !== null) state.push(`状态原因：${plainText(changeState.reason)}`)
    if (changeState.updatedAt !== null) state.push(`状态时间：${changeState.updatedAt}`)
  } catch (error) {
    code = EXIT.ERROR
    state = [`变更状态：无法核验（${error.message}）`]
    // 选定时未托管，但无法再次核实时，不能报告未托管。
    if (!record) local = ['托管记录：未能再次核实，请重试']
  }
  return { code, message: [`变更：${name}`, `目录：${directory}`, ...state, ...local].join('\n') }
}

/** 文件状态命令按配置中的项目逐一定位，不依赖进度视图先选目标。 */
function selectActive(config, name) {
  const projects = config.projects.map(project => realPath(project.root))
  const hits = [...new Set(projects)].flatMap(root => {
    const directory = activeDirectory(root, name)
    return directory ? [{ root, directory }] : []
  })
  if (hits.length > 1) throw new StateError(`多个项目存在活跃变更 ${name}：${hits.map(hit => hit.root).join('、')}`)
  return hits[0] || null
}

/**
 * 运行锁的项目占用判定（design D0「项目占用核对」，评审 CONC-15、CONC-18、DB-12）。只读，不等待锁释放，不发信号。
 * 存活的锁只要绑定了本项目的批次就按占用处理，含已写 void 仍在撤回等待的批次；批次名不同、缺 writer 或缺 claudePid 均不改变结论。
 * @param {string} root 当前检出的真实根。
 * @throws {StateError} 退出码 1：锁无法核验，或存活且不能核实属于其他项目。
 */
function assertRunLockIdle(root) {
  const busy = detail => new StateError(`该项目的阶段仍在运行或无法核验：${detail}`, EXIT.REJECTED)
  const lock = readLockFile(path.join(homeDir(), 'run.lock'))
  checkProtectionTime()
  // 读不出内容时不论修改时间都拒绝：修改时间只用于调度接手陈旧锁，调度替换该锁后拒绝自然解除（DB-12）。
  if (lock.unreadable) throw busy('运行锁无法解析')
  const value = lock.value
  if (!value) return
  if (typeof value.pid !== 'number' || typeof value.bootTime !== 'number') throw busy('运行锁缺少数字形式的 pid 或 bootTime')
  // 上次开机留下的锁已没有存活进程。
  if (Math.abs(currentBootTime() - value.bootTime) > BOOT_TIME_TOLERANCE) return
  const alive = isAlive(value.pid) || isAlive(value.claudePid) || writerStatus(value.writer, protectionProbeTimeout) !== 'no'
  checkProtectionTime()
  if (!alive) return
  // 调度本轮刚取得、尚未绑定批次的锁不单独阻断：claimChange 先写绑定再开始动作，可领取的批次已被同一扫描拒绝（CONC-18）。
  if (LOCK_BINDING_FIELDS.every(key => value[key] === undefined || value[key] === null)) return
  const lockRoot = realPathOrNull(value.projectRoot)
  // 只有已核实属于其他项目的锁不阻断；不用 lockFor 的名称不匹配结果代替本判断。
  if (!lockRoot) throw busy('运行锁的项目根无法解析')
  if (lockRoot === root) throw busy(`运行锁绑定本项目的批次（${value.change ?? '未写变更名'}）`)
}

/**
 * 项目占用核对（design D0）：pause、resume、start 在同一项目写保护内调用同一判定，不各自实现。
 * 变更名未占用不等于项目未占用：归档后仍可能有批次，撤回后仍可能有写者。
 * @param {object} scan 本次保护内的全项目候选扫描（enumerateBatches，all 为 true）。
 * @param {string[]} names 需核对未完成核对的变更名：目标，以及 start 按暂缓排除的历史项。
 * @param {Function} charge 本次保护内托管记录与待核对文件的累计读取额度。
 * @throws {StateError} 退出码 1：项目被占用或无法核验。
 */
function assertProjectIdle(scan, names, charge) {
  checkProtectionTime()
  // 同一项目任一批次为 active 或 exiting 即占用，含已归档、仍在出口的批次（评审 CONC-09）。
  for (const item of scan.candidates) {
    checkProtectionTime()
    if (['active', 'exiting'].includes(item.record?.status)) {
      throw new StateError(`${item.directory} 仍在托管，先撤回并确认停止`, EXIT.REJECTED)
    }
  }
  // 记录和运行锁各自核对：原批次不存在也不能证明同项目没有存活写者。
  assertRunLockIdle(scan.root)
  const store = savedTrace(charge, scan.inspected)
  checkProtectionTime()
  // 任一名称有未完成核对即拒绝，不论写者状态，也不论是否为 version-handoff（评审 DB-13）。
  for (const name of names) {
    if (pendingForName(store, scan.root, name)) throw new StateError(`${name} 仍有未完成核对`, EXIT.REJECTED)
  }
  for (const entry of Object.values(store.entries)) {
    if (entry.root !== scan.root) continue
    if (writerStatus(entry.writer, protectionProbeTimeout) !== 'no') {
      throw new StateError(`${entry.name} 的原写者尚未确认停止`, EXIT.REJECTED)
    }
    checkProtectionTime()
  }
}

function setChangeState(name, config, nextState, reason) {
  const value = stateForWrite(nextState, reason)
  const target = selectActive(config, name)
  if (!target) throw new StateError(`配置项目中没有活跃变更 ${name}`)
  const { root, directory } = target
  const gate = trustedScript(config, 'gateBin')
  const snapshot = readStateSnapshot(gate, root, directory.path)
  if (!sameDirectory(snapshot.changeDirectory, directory)) throw new StateError('首次定位的变更目录与门禁快照不符')
  // 恢复依赖刷新进度；先核验脚本路径，真正刷新在释放保护之后。
  const progress = nextState === 'enabled' ? trustedScript(config, 'progressBin') : null
  let changed = false
  let result
  try {
    result = withProjectProtection(root, () => {
      const charge = managementReadBudget()
      const scan = enumerateBatches(root, name, undefined, { all: true, limit: PROJECT_SCAN_LIMIT, charge })
      if (!scan.candidates.some(item => item.location === 'active' && item.directory === directory.path)
          || !sameDirectory(directory, activeDirectory(root, name))) {
        throw new StateError('活跃变更目录已改变，请重试', EXIT.REJECTED)
      }
      assertProjectIdle(scan, [name], charge)
      return inChangeDirectory(directory, root, () => {
        const verifyTarget = () => {
          scan.verify()
          if (!sameDirectory(directory, activeDirectory(root, name))) throw new StateError('活跃变更目录已改变，请重试', EXIT.REJECTED)
          checkProtectionTime()
        }
        verifyTarget()
        const charge = stateReadBudget()
        verifyStateDigest(STATE_FILE, snapshot.changeState.digest, charge)
        if (snapshot.changeState.state === nextState && (nextState === 'enabled' || snapshot.changeState.reason === value.reason)) return 'unchanged'
        clearStateTemporaries()
        writeJsonAtomic(STATE_FILE, value, { mode: 0o644, beforePublish: () => {
          verifyTarget()
          verifyStateDigest(STATE_FILE, snapshot.changeState.digest, charge)
          checkProtectionTime()
        } })
        changed = true
        // 归档不参与本保护。成功写入以后若目录已移动，报告实际结果，不回滚或按名字重写。
        return sameDirectory(directory, activeDirectory(root, name)) ? 'written' : 'moved'
      })
    })
  } catch (error) {
    if (changed) throw new StateError(`状态已写入原变更目录，但活跃位置无法核验：${error.message}`)
    if (error instanceof StateError) throw error
    const localFailure = typeof error.code === 'string' && !['ENOENT', 'ENOTDIR'].includes(error.code)
    throw new StateError(error.message, localFailure ? EXIT.ERROR : EXIT.REJECTED)
  }
  if (result === 'moved') throw new StateError('状态已写入原变更目录，但该目录已离开活跃位置')
  if (nextState === 'paused') return { code: EXIT.OK, message: `已暂缓 ${name}。暂缓不隔离工作区代码。` }
  const message = changed ? `已恢复 ${name} 的推进意愿` : `${name} 已是继续推进状态`
  const { view, error } = readProgressView({ ...config, progressBin: progress, gateBin: gate }, root)
  const entry = view?.active.find(item => item.change === name)
  if (error || !entry || entry.error) throw new StateError(`${message}，但读取当前进度失败：${error || entry?.error || '缺少活跃变更'}`)
  // 写入与显示须来自同一目录实例：刷新前原目录可能已归档并出现同名新目录，不显示新目录的进度，也不回滚或改写（design D3 第 3 步，评审 DB-05）。
  if (!sameDirectory(entry.changeDirectory, directory)) {
    throw new StateError(`${message}，但刷新到的进度条目不是原变更目录（目录实例不符或缺失），未显示其进度；状态写入不回滚`)
  }
  return { code: EXIT.OK, message: `${message}。阶段：${entry.stage}（${entry.rule}）；卡点：${entry.blockers?.join('、') || '无'}；下一步：${entry.next}` }
}

/** 命令行入口。 */
function main(argv) {
  const [command, name, ...args] = argv
  const usage = '用法：node autopilot.mjs <start|cancel|status|resume> <变更名>\n      node autopilot.mjs pause <变更名> --reason <非敏感原因>'
  if (!['start', 'cancel', 'status', 'resume', 'pause'].includes(command) || !validChangeName(name)
      || (command === 'pause' ? args.length !== 2 || args[0] !== '--reason' : args.length !== 0)) {
    return { code: EXIT.ERROR, message: usage }
  }
  let config
  try {
    config = readConfig()
  } catch (error) {
    return { code: EXIT.ERROR, message: error.message }
  }
  try {
    if (command === 'start') return start(name, config)
    if (command === 'cancel') return cancel(name, config)
    if (command === 'status') return status(name, config)
    if (command === 'pause') return setChangeState(name, config, 'paused', args[1])
    return setChangeState(name, config, 'enabled', '用户恢复推进')
  } catch (error) {
    const stateCommand = command === 'pause' || command === 'resume'
    return { code: error instanceof StateError ? error.code : stateCommand ? EXIT.ERROR : EXIT.REJECTED, message: error.message }
  }
}

const result = main(process.argv.slice(2))
if (result.code === EXIT.OK) process.stdout.write(`${result.message}\n`)
else process.stderr.write(`${result.message}\n`)
process.exitCode = result.code
