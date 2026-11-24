/**
 * 项目与变更目录的公共读取（add-autopilot-loop design D4「变更目录定位」、D7）。
 *
 * 所属：skill openspec-autopilot。调用方：autopilot.mjs、scheduler.mjs、autopilot-hook.mjs。
 * 职责：运行进度视图读 JSON、按变更名定位变更目录（含归档目录）、读 git 用户名、判断路径在目录之内。
 * 存在原因：这几条规则原来在 3–4 个脚本里各写一份，改归档目录规则时漏改一处，
 *   撤回、调度与 hook 就会找到不同的目录（quality R1 STD-02）。
 * 边界：只读文件系统与运行只读的 git、进度视图命令，不写任何文件。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

/** 进度视图错误信息中保留的输出长度。 */
const PROGRESS_ERROR_LIMIT = 300

/**
 * 在项目目录中运行进度视图脚本，读取 JSON 输出。
 * @param {object} config 托管配置（取 progressBin）。
 * @param {string} root 项目根目录。
 * @param {number} timeout 恢复时传入本轮剩余毫秒数，其他调用保持原有时限。
 * @returns {{ view: object|null, error: string|null }} 进度视图与错误说明。
 */
export function readProgressView(config, root, timeout = Infinity) {
  const args = [config.progressBin, '--json']
  if (config.gateBin) args.push('--gate', config.gateBin)
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    ...(Number.isFinite(timeout) ? { timeout, killSignal: 'SIGKILL' } : {}),
    encoding: 'utf8',
    env: { ...process.env, OPENSPEC_TELEMETRY: '0' },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.error) return { view: null, error: `进度视图无法运行：${result.error.message}` }
  if (result.status !== 0) {
    return {
      view: null,
      error: `进度视图退出码 ${result.status}：${(result.stderr || result.stdout || '').trim().slice(0, PROGRESS_ERROR_LIMIT)}`,
    }
  }
  try {
    const view = JSON.parse(result.stdout)
    if (!view || !Array.isArray(view.active) || !Array.isArray(view.archived)) {
      return { view: null, error: '进度视图缺少 active 或 archived 列表' }
    }
    return { view, error: null }
  } catch (error) {
    return { view: null, error: `进度视图输出不是 JSON：${error.message}` }
  }
}

/**
 * 列出某个变更的归档目录名。归档目录名必须完整匹配 YYYY-MM-DD-<变更名>：
 * 用后缀匹配时变更 loop 会命中 add-autopilot-loop（design D7，评审 CONC-03）。
 * @param {string} archiveRoot 归档根目录（openspec/changes/archive）。
 * @param {string} name 变更名。
 * @returns {string[]} 匹配的目录名，按名称排序；归档根目录不存在时为空数组。
 */
export function archivedDirNames(archiveRoot, name) {
  if (!existsSync(archiveRoot)) return []
  const pattern = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  return readdirSync(archiveRoot)
    .filter(item => pattern.test(item) && statSync(path.join(archiveRoot, item)).isDirectory())
    .sort()
}

/**
 * 按变更名在进度视图的 active 与 archived 中定位变更目录（design D4「变更目录定位」）。
 * @param {object} project 项目配置（取 root）。
 * @param {object} view 进度视图。
 * @param {string} name 变更名。
 * @returns {string|null} 变更目录路径；找不到时为 null。
 */
export function locateChangeDir(project, view, name) {
  const changesDir = path.join(project.root, 'openspec', 'changes')
  if ((view.active || []).some(item => item.change === name)) return path.join(changesDir, name)
  if (!(view.archived || []).some(item => item.name === name)) return null
  const archiveRoot = path.join(changesDir, 'archive')
  const [hit] = archivedDirNames(archiveRoot, name)
  return hit ? path.join(archiveRoot, hit) : null
}

/**
 * 读取项目的 git 用户名。
 * @param {string} root 项目根目录。
 * @returns {string} 用户名；没有配置时为空串。
 */
export function gitUserName(root) {
  const result = spawnSync('git', ['config', 'user.name'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : ''
}

/** 读取磁盘上的实际路径和大小写，供调度和写入保护共同使用。 */
export const realPath = target => realpathSync.native(target)

/**
 * 判断一个路径是否在某个目录之内（含目录本身）。
 * @param {string} target 目标路径。
 * @param {string} dir 目录路径。
 * @returns {boolean} 在目录之内时为 true；任一参数为空时为 false。
 */
export function inside(target, dir) {
  if (!target || !dir) return false
  const relative = path.relative(path.resolve(dir), path.resolve(target))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
