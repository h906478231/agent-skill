/**
 * 出口动作：归档后的提交与合并、推送（add-autopilot-loop design D11）。
 *
 * 所属：skill openspec-autopilot。调用方：scheduler.mjs。
 * 职责：算出主规格清单、核对提交计划、执行提交与合并、算推送清单。
 * 边界：全部 git 调用用参数数组，不经过 shell；对外写入只在用户点选后执行（评审 SEC-03、SEC-07、SEC-11）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { readRecord, recordFile, transition } from './decisions.mjs'

/** 出口动作的顺序（design D11 的表）。 */
export const EXIT_ACTIONS = ['commit-merge', 'push']

/** 出口动作的选项。 */
const COMMIT_OPTIONS = ['提交并合并', '只提交到分支', '暂不处理']

/** 推送动作的选项。 */
const PUSH_OPTIONS = ['推送', '暂不处理']

/**
 * 在项目目录中运行 git。
 * @param {string} root 项目根目录。
 * @param {string[]} args git 参数。
 * @returns {{ code: number, out: string, err: string }} 执行结果。
 */
export function git(root, args) {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  return { code: result.status === null ? 1 : result.status, out: result.stdout || '', err: result.stderr || '' }
}

/**
 * 读 git 的一行输出。
 * @param {string} root 项目根目录。
 * @param {string[]} args git 参数。
 * @returns {string} 输出；失败时为空串。
 */
export function gitLine(root, args) {
  const result = git(root, args)
  return result.code === 0 ? result.out.trim() : ''
}

/**
 * 解析 git status 的 -z 输出：每条记录是「状态 + 路径」。
 * @param {string} output git status 的输出。
 * @returns {{ status: string, file: string }[]} 记录列表。
 */
export function parseStatus(output) {
  return output.split('\0').filter(Boolean).map(line => ({
    status: line.slice(0, 2),
    file: line.slice(3),
  }))
}

/**
 * 算出主规格清单（design D11「主规格清单」，评审 ARCH-11）。
 * 只取本变更 delta spec 的能力名对应的主规格；别的变更的主规格与被忽略的 .DS_Store 不进入清单。
 * @param {string} root 项目根目录。
 * @param {string} changeDir 变更目录。
 * @returns {string[]} 主规格的相对路径。
 */
export function mainSpecList(root, changeDir) {
  const specsDir = path.join(changeDir, 'specs')
  if (!existsSync(specsDir)) return []
  const list = []
  for (const cap of readdirSync(specsDir, { withFileTypes: true })) {
    if (!cap.isDirectory()) continue
    const rel = `openspec/specs/${cap.name}/spec.md`
    const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', '--', rel])
    if (status.code !== 0) continue
    for (const record of parseStatus(status.out)) {
      if (record.file) list.push(record.file)
    }
  }
  return [...new Set(list)]
}

/**
 * 列出 openspec/specs 下不属于本变更的主规格记录（design D11「计划核对」）。
 * @param {string} root 项目根目录。
 * @param {string[]} mainSpecs 主规格清单。
 * @returns {string[]} 不属于本变更的路径。
 */
export function otherMainSpecs(root, mainSpecs) {
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', '--', 'openspec/specs'])
  if (status.code !== 0) return []
  return parseStatus(status.out).map(record => record.file).filter(file => file && !mainSpecs.includes(file))
}

/**
 * 判断一个路径是不是被 git 忽略的文件。
 * @param {string} root 项目根目录。
 * @param {string} file 相对路径。
 * @returns {boolean} 被忽略时为 true。
 */
export function isIgnored(root, file) {
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored', '--', file])
  if (status.code !== 0) return false
  return parseStatus(status.out).some(record => record.status.startsWith('!!'))
}

/**
 * 判断一个路径是不是已跟踪文件的删除。
 * @param {string} root 项目根目录。
 * @param {string} file 相对路径。
 * @returns {boolean} 是删除时为 true。
 */
export function isDeleted(root, file) {
  if (existsSync(path.join(root, file))) return false
  const tracked = git(root, ['cat-file', '-e', `HEAD:${file}`])
  return tracked.code === 0
}

/**
 * 计算一个文件的内容哈希；删除的文件记 null（design D11「计划核对」）。
 * @param {string} root 项目根目录。
 * @param {string} file 相对路径。
 * @returns {string|null} 哈希或 null。
 */
export function contentHash(root, file) {
  if (!existsSync(path.join(root, file))) return null
  const hash = git(root, ['hash-object', file])
  return hash.code === 0 ? hash.out.trim() : null
}

/**
 * 核对提交计划（design D11「计划核对」，评审 ARCH-02、ARCH-07、ARCH-08、SEC-05、SEC-07、SEC-10、SEC-11）。
 * @param {object} options root 项目根；changeDir 变更目录；plan 计划；baseBranch 主分支；
 *   branchPrefix 分支前缀；snapshot 实现快照；previousBranch 本变更上一次尝试的分支（exit.commit-merge.branch）。
 * @returns {{ ok: boolean, error: string|null, files: string[], mainSpecs: string[], ignored: string[], deleted: string[], removed: string[] }} 核对结果。
 */
export function checkPlan({ root, changeDir, plan, baseBranch, branchPrefix, snapshot, previousBranch = null }) {
  const fail = error => ({ ok: false, error, files: [], mainSpecs: [], ignored: [], deleted: [], removed: [] })
  if (!plan || typeof plan !== 'object') return fail('计划不是对象')
  const { branch, files, message } = plan
  if (typeof branch !== 'string' || typeof message !== 'string' || !Array.isArray(files)) {
    return fail('计划缺少 branch、files 或 message')
  }
  // 当前分支必须是主分支（design D11「计划核对」，评审 ARCH-07）。
  const current = gitLine(root, ['symbolic-ref', '--short', 'HEAD'])
  if (current !== baseBranch) return fail(`当前分支是 ${current}，不是 ${baseBranch}`)

  // 本变更 decisions/ 下的文件移出提交计划（design D11「计划核对」，评审 CONC-10）。
  const decisionsPrefix = `${path.relative(root, path.join(changeDir, 'decisions')).split(path.sep).join('/')}/`
  const removed = files.filter(file => file.startsWith(decisionsPrefix))
  const planned = files.filter(file => !file.startsWith(decisionsPrefix))

  // 暂存区的每条路径都必须在计划中（design D11「计划核对」，评审 SEC-11）。
  const staged = git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames'])
  if (staged.code === 0) {
    for (const file of staged.out.split('\0').filter(Boolean)) {
      if (!planned.includes(file)) return fail(`暂存区有计划以外的路径：${file}`)
    }
  }

  // 计划中的每项必须是 git status 的一条记录，且是普通文件或已跟踪文件的删除（design D11，评审 K4）。
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'])
  const records = parseStatus(status.code === 0 ? status.out : '')
  const ignored = []
  const deleted = []
  for (const file of planned) {
    if (file.includes('..') || file.endsWith('/') || file.includes('*')) return fail(`路径不允许：${file}`)
    const record = records.find(item => item.file === file)
    if (!record) return fail(`git status 中没有 ${file}`)
    if (record.status.startsWith('R') || record.status.startsWith('C')) return fail(`暂存区有重命名或复制记录：${file}`)
    if (record.status.startsWith('!!')) {
      ignored.push(file)
      const info = lstatSync(path.join(root, file), { throwIfNoEntry: false })
      if (!info || !info.isFile()) return fail(`被忽略的路径不是普通文件：${file}`)
      continue
    }
    const full = path.join(root, file)
    if (existsSync(full)) {
      const info = lstatSync(full)
      if (!info.isFile()) return fail(`路径不是普通文件：${file}`)
    } else if (!isDeleted(root, file)) {
      return fail(`路径不存在也不是已跟踪文件的删除：${file}`)
    } else {
      deleted.push(file)
    }
  }

  // 主规格清单：每条都要在计划中，计划中的主规格也都要在清单中（design D11，评审 ARCH-11）。
  const mainSpecs = mainSpecList(root, changeDir)
  for (const file of mainSpecs) {
    if (!planned.includes(file)) return fail(`主规格清单中的路径不在计划中：${file}`)
  }
  for (const file of planned.filter(item => item.startsWith('openspec/specs/'))) {
    if (!mainSpecs.includes(file)) return fail(`计划中的主规格不在本变更清单中：${file}`)
  }

  // 实现快照：规划目录以外的文件必须与快照相同（design D11，评审 SEC-10、跨维度冲突 K6）。
  if (!snapshot) return fail('托管记录没有实现快照')
  for (const file of planned.filter(item => !item.startsWith('openspec/'))) {
    const expected = snapshot[file]
    if (expected === undefined) return fail(`计划中的文件不在实现快照中：${file}`)
    const current = contentHash(root, file)
    if (current !== expected) return fail(`文件与实现快照不同：${file}`)
  }

  // 分支名校验（design D11「计划核对」，评审 SEC-07）。
  if (!branch.startsWith(branchPrefix)) return fail(`分支名没有以 ${branchPrefix} 开头：${branch}`)
  if (!/^[A-Za-z0-9._/-]+$/.test(branch)) return fail(`分支名含不允许的字符：${branch}`)
  if (branch.startsWith('-')) return fail(`分支名不能以 - 开头：${branch}`)
  const refCheck = git(root, ['check-ref-format', '--branch', branch])
  if (refCheck.code !== 0) return fail(`分支名不是合法的 git 分支名：${branch}`)
  // 本变更上一次尝试留下的分支可以复用：提交前失败时它与主分支同一提交（design D11「计划核对」，评审 SEC-07 的例外）。
  if (branch !== previousBranch) {
    const local = git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    if (local.code === 0) return fail(`本地已有分支 ${branch}`)
    const remote = git(root, ['ls-remote', '--heads', 'origin', branch])
    if (remote.code === 0 && remote.out.trim()) return fail(`远端已有分支 ${branch}`)
  }

  return { ok: true, error: null, files: planned, mainSpecs, ignored, deleted, removed }
}

/**
 * 算推送清单：origin/<baseBranch>..<要推送的提交> 的短提交号与标题（design D11「推送」，评审 SEC-14）。
 * @param {string} root 项目根目录。
 * @param {object} options baseBranch 主分支；commit 要推送的提交。
 * @returns {{ ok: boolean, commits: object[], error: string|null }} 推送清单。
 */
export function pushList(root, { baseBranch, commit }) {
  const fetch = git(root, ['fetch', 'origin'])
  if (fetch.code !== 0) return { ok: false, commits: [], error: `git fetch origin 失败：${fetch.err.trim().slice(0, 200)}` }
  const list = git(root, ['rev-list', `origin/${baseBranch}..${commit}`])
  if (list.code !== 0) return { ok: false, commits: [], error: '无法计算将推送的提交' }
  const commits = []
  for (const sha of list.out.split('\n').map(item => item.trim()).filter(Boolean)) {
    const subject = gitLine(root, ['log', '-1', '--format=%s', sha])
    commits.push({ id: sha.slice(0, 7), subject })
  }
  return { ok: true, commits, error: null }
}

/**
 * 读一个提交树中的路径集合（design D11「执行与回读」）。
 * @param {string} root 项目根目录。
 * @param {string} commit 提交号。
 * @returns {string[]} 路径列表。
 */
export function commitPaths(root, commit) {
  const result = git(root, ['diff-tree', '-r', '--no-renames', '--no-commit-id', '--name-only', '-z', `${commit}^`, commit])
  if (result.code !== 0) return []
  return result.out.split('\0').filter(Boolean)
}

/**
 * 读一个提交中某个路径的内容哈希；路径不在提交树中时为 null（design D11「执行与回读」第 1 步）。
 * @param {string} root 项目根目录。
 * @param {string} commit 提交号。
 * @param {string} file 相对路径。
 * @returns {string|null} 哈希或 null。
 */
export function commitHash(root, commit, file) {
  const result = git(root, ['rev-parse', `${commit}:${file}`])
  if (result.code !== 0) return null
  return result.out.trim()
}

/**
 * 判断一个提交是不是另一个提交的祖先。
 * @param {string} root 项目根目录。
 * @param {string} ancestor 祖先提交。
 * @param {string} descendant 后代提交。
 * @returns {boolean} 是祖先时为 true。
 */
export function isAncestor(root, ancestor, descendant) {
  return git(root, ['merge-base', '--is-ancestor', ancestor, descendant]).code === 0
}

/**
 * 执行提交与合并（design D11「执行与回读」）。
 * 先回读已完成的步骤：已有本次提交时只核对提交树并从合并继续，不会重复提交（评审 CONC-04、K3）。
 * 每完成一步立即写入托管记录；写入返回 false（托管已撤回）时停止剩余步骤（评审 CONC-06）。
 * @param {object} candidate 候选变更：project、entry、changeDir、record（运行前读到的托管记录）。
 * @param {object} decision 出口决策。
 * @param {{ draftsDir: string, log?: Function }} options draftsDir 为提交说明草稿目录（托管目录的 drafts/），log 为日志函数。
 * @returns {{ ok: boolean, error: string|null, steps: string[] }} 执行结果。
 */
export function executeCommitMerge(candidate, decision, { draftsDir, log = () => {} }) {
  const { project } = candidate
  const request = decision.request || {}
  const steps = []
  const root = project.root
  const base = project.baseBranch
  const branch = request.branch
  const files = request.files || []
  const digest = request.contentDigest || {}
  const message = String(request.message || '')
  const merge = (decision.answer && decision.answer.choice) === '提交并合并'
  const exitState = currentExit(candidate)['commit-merge'] || {}
  const stopped = () => ({ ok: false, error: '托管记录已变化（撤回或重新托管），停止剩余步骤', steps, stopped: true })
  const branchExists = git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0
  const draftFile = path.join(draftsDir, `${branch.replace(/\//g, '_')}.txt`)

  // 第 1 步：先回读。托管记录已有提交号，或分支已存在并且最后一次提交的说明等于计划说明时，不再提交（spec 第 1 步）。
  let commit = exitState.commit || null
  if (!commit && branchExists && gitLine(root, ['log', '-1', '--format=%B', branch]).trim() === message.trim()) {
    commit = gitLine(root, ['rev-parse', branch])
  }
  if (commit) {
    for (const file of files) {
      const expected = digest[file] === undefined ? null : digest[file]
      if (commitHash(root, commit, file) !== expected) {
        return { ok: false, error: `提交 ${commit.slice(0, 12)} 中的 ${file} 与内容摘要不同`, steps }
      }
    }
    if (!samePaths(commitPaths(root, commit), files)) {
      return { ok: false, error: `提交 ${commit.slice(0, 12)} 的路径集合与计划不同`, steps }
    }
    steps.push('read-back')
    if (!writeExitState(candidate, 'commit-merge', { branch, commit }, log)) return stopped()
  } else {
    // 第 2 步：没有提交时，停在本次分支并且它与主分支同一提交（提交前失败）就先切回主分支（评审 CONC-11）。
    const current = gitLine(root, ['symbolic-ref', '--short', 'HEAD'])
    if (current === branch && exitState.branch === branch
      && gitLine(root, ['rev-parse', branch]) === gitLine(root, ['rev-parse', base])) {
      if (git(root, ['switch', base]).code !== 0) return { ok: false, error: `切回 ${base} 失败`, steps }
    }
    const branchNow = gitLine(root, ['symbolic-ref', '--short', 'HEAD'])
    if (branchNow !== base) return { ok: false, error: `当前分支是 ${branchNow}，不是 ${base}`, steps }
    // 卡片确认后又暂存的文件不能进入提交（评审 SEC-11）。
    const staged = git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames'])
    for (const file of (staged.code === 0 ? staged.out : '').split('\0').filter(Boolean)) {
      if (!files.includes(file)) return { ok: false, error: `暂存区有计划以外的路径：${file}`, steps }
    }
    // 卡片确认后文件被改动，或删除的文件又出现时不提交（design D11「计划核对」最后一条，风险 R6）。
    for (const file of files) {
      const expected = digest[file] === undefined ? null : digest[file]
      if (contentHash(root, file) !== expected) return { ok: false, error: `文件与卡片确认时不同：${file}`, steps }
    }
    // 第 3 步：建分支；提交前失败留下的同名分支（与主分支同一提交）直接复用（评审 CONC-11）。
    const reuse = branchExists && exitState.branch === branch
      && gitLine(root, ['rev-parse', branch]) === gitLine(root, ['rev-parse', base])
    const switched = git(root, reuse ? ['switch', branch] : ['switch', '-c', branch, base])
    if (switched.code !== 0) return { ok: false, error: `建分支 ${branch} 失败：${switched.err.trim().slice(0, 200)}`, steps }
    steps.push('branch')
    if (!writeExitState(candidate, 'commit-merge', { branch }, log)) return stopped()
    // 第 4 步：未被忽略的文件与删除的文件用 git add --，被忽略的文件逐个 git add -f --（评审 SEC-05、K2）。
    const ignored = request.ignored || []
    const normal = files.filter(file => !ignored.includes(file))
    if (normal.length) {
      const added = git(root, ['add', '--', ...normal])
      if (added.code !== 0) return { ok: false, error: `git add 失败：${added.err.trim().slice(0, 200)}`, steps }
    }
    for (const file of ignored) {
      const added = git(root, ['add', '-f', '--', file])
      if (added.code !== 0) return { ok: false, error: `git add -f 失败：${added.err.trim().slice(0, 200)}`, steps }
    }
    // 第 5 步：用草稿文件提交，提交后核对提交树的路径集合（评审 SEC-07、SEC-11）。
    mkdirSync(path.dirname(draftFile), { recursive: true, mode: 0o700 })
    writeFileSync(draftFile, `${message}\n`, { mode: 0o600 })
    const committed = git(root, ['commit', '-F', draftFile])
    if (committed.code !== 0) return { ok: false, error: `git commit 失败：${committed.err.trim().slice(0, 200)}`, steps }
    commit = gitLine(root, ['rev-parse', 'HEAD'])
    if (!samePaths(commitPaths(root, commit), files)) return { ok: false, error: '提交树的路径集合与计划不同', steps }
    steps.push('commit')
    if (!writeExitState(candidate, 'commit-merge', { branch, commit }, log)) return stopped()
  }

  // 第 6 步：先切回主分支再合并；分支已是主分支的祖先时跳过合并（spec 第 6 步）。
  if (merge) {
    if (git(root, ['switch', base]).code !== 0) return { ok: false, error: `切回 ${base} 失败`, steps }
    if (!isAncestor(root, branch, base)) {
      const merged = git(root, ['merge', '--no-ff', '--no-edit', branch])
      if (merged.code !== 0) {
        // 合并冲突先 abort，工作区不留合并中的状态（design D11「执行失败」）。
        git(root, ['merge', '--abort'])
        return { ok: false, error: `合并冲突：${(merged.out + merged.err).trim().slice(0, 200)}`, steps }
      }
    }
    steps.push('merge')
    if (!writeExitState(candidate, 'commit-merge', { mergeCommit: gitLine(root, ['rev-parse', 'HEAD']) }, log)) return stopped()
  }
  // 第 7 步：回读成功后删除草稿（评审 SEC-08）。
  if (existsSync(draftFile)) rmSync(draftFile, { force: true })
  if (!writeExitState(candidate, 'commit-merge', { ok: true, mode: merge ? 'merge' : 'branch-only' }, log)) return stopped()
  return { ok: true, error: null, steps }
}

/**
 * 两个路径集合是否相同（顺序无关）。
 * @param {string[]} a 路径列表。
 * @param {string[]} b 路径列表。
 * @returns {boolean} 相同时为 true。
 */
function samePaths(a, b) {
  return a.length === b.length && a.every(item => b.includes(item))
}

/**
 * 执行推送（design D11「推送」）。
 * @param {object} candidate 候选变更。
 * @param {object} decision 出口决策。
 * @param {{ log?: Function }} [options] log 为日志函数。
 * @returns {{ ok: boolean, error: string|null, steps: string[] }} 执行结果。
 */
export function executePush(candidate, decision, { log = () => {} } = {}) {
  const { project } = candidate
  const request = decision.request || {}
  const steps = []
  const root = project.root
  const base = project.baseBranch
  const exitState = currentExit(candidate)['commit-merge'] || {}
  const branch = exitState.branch
  const mergeCommit = exitState.mergeCommit || null
  const target = mergeCommit || exitState.commit
  if (!target) return { ok: false, error: '没有可推送的提交', steps }
  const remoteHead = ref => {
    const out = git(root, ['ls-remote', 'origin', ref])
    return out.code === 0 ? (out.out.trim().split(/\s+/)[0] || '') : ''
  }
  // 先回读：远端主分支已指向合并提交时跳过推送（spec「A failed exit action ...」最后一段）。
  if (mergeCommit && remoteHead(`refs/heads/${base}`) === mergeCommit) {
    steps.push('read-back')
    if (!writeExitState(candidate, 'push', { ok: true }, log)) return { ok: false, error: '托管记录已变化，停止剩余步骤', steps }
    return { ok: true, error: null, steps }
  }
  // 重新计算将推送的提交，与卡片不一致时按执行失败处理（design D11「推送」，评审 SEC-14）。
  const list = pushList(root, { baseBranch: base, commit: target })
  if (!list.ok) return { ok: false, error: list.error, steps }
  if (JSON.stringify(list.commits) !== JSON.stringify(request.commits || [])) {
    return { ok: false, error: '将推送的提交与卡片上不同', steps }
  }
  // fetch 期间可能被撤回：推送前复核托管记录，撤回后不推送（评审 CONC-06）。
  const again = readRecord(candidate.changeDir)
  if (!again.value || again.value.status !== 'exiting' || again.value.startedAt !== candidate.record.startedAt) {
    log('push-stopped', { change: candidate.entry.change, steps })
    return { ok: false, error: '托管记录已变化，停止剩余步骤', steps, stopped: true }
  }
  // 只快进远端主分支：远端主分支不是要推送的提交的祖先时不推送，不强制推送（design D11「其他」）。
  const remoteBase = gitLine(root, ['rev-parse', '--verify', '--quiet', `origin/${base}`])
  if (mergeCommit && remoteBase && !isAncestor(root, remoteBase, mergeCommit)) {
    return { ok: false, error: '远端主分支已前进，不推送', steps }
  }
  if (branch) {
    const pushed = git(root, ['push', 'origin', `refs/heads/${branch}:refs/heads/${branch}`])
    if (pushed.code !== 0) return { ok: false, error: `推送分支失败：${pushed.err.trim().slice(0, 200)}`, steps }
    steps.push('push-branch')
  }
  // 选了只提交到分支时没有合并提交，只推分支（design D11 表格第 2 行）。
  if (mergeCommit) {
    const pushed = git(root, ['push', 'origin', `${mergeCommit}:refs/heads/${base}`])
    if (pushed.code !== 0) return { ok: false, error: `推送主分支失败：${pushed.err.trim().slice(0, 200)}`, steps }
    steps.push('push-base')
  }
  // 回读远端引用：远端要指向本次推送的提交（design D11「推送」）。
  if (mergeCommit && remoteHead(`refs/heads/${base}`) !== mergeCommit) return { ok: false, error: '回读远端主分支失败', steps }
  if (branch && !mergeCommit && remoteHead(`refs/heads/${branch}`) !== exitState.commit) {
    return { ok: false, error: '回读远端分支失败', steps }
  }
  if (!writeExitState(candidate, 'push', { ok: true }, log)) return { ok: false, error: '托管记录已变化，停止剩余步骤', steps }
  return { ok: true, error: null, steps }
}

/**
 * 读出托管记录当前的 exit 字段。每次从文件读：同一轮内前面的步骤已写入新值，不能用运行前读到的记录。
 * @param {object} candidate 候选变更。
 * @returns {object} exit 字段。
 */
export function currentExit(candidate) {
  const read = readRecord(candidate.changeDir)
  return (read.value && read.value.exit) || {}
}

/**
 * 把一个出口动作的结果合并写入托管记录（design D11「执行与回读」：每完成一步立即写入）。
 * 预期状态为 exiting 并带运行前读到的 startedAt；托管已撤回或重新托管时返回 false（评审 CONC-06、CONC-07）。
 * @param {object} candidate 候选变更。
 * @param {string} action 动作名。
 * @param {object} patch 要合并的字段。
 * @param {Function} [log] 日志函数。
 * @returns {boolean} 写入成功时为 true。
 */
export function writeExitState(candidate, action, patch, log = () => {}) {
  const exit = currentExit(candidate)
  exit[action] = { ...(exit[action] || {}), ...patch }
  const written = transition(recordFile(candidate.changeDir), ['exiting'], { exit }, { startedAt: candidate.record.startedAt })
  if (!written.ok) log('exit-state-write-failed', { change: candidate.entry.change, action, reason: written.reason })
  return written.ok
}

export { COMMIT_OPTIONS, PUSH_OPTIONS }
