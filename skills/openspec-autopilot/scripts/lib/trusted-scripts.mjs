/** 只允许在操作者信任的安装根下找到指定脚本；配置候选路径不授予信任。 */
import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inside, realPath } from './project.mjs'

const SKILLS = fileURLToPath(new URL('../../../', import.meta.url))
const FILES = {
  gateBin: 'openspec-technical-review/scripts/implementation-gate.mjs',
  progressBin: 'openspec-change-progress/scripts/progress.mjs',
}

export function trustedScript(config, key) {
  const relative = FILES[key]
  const extra = config.trustedSkillRoots ?? []
  if (!Array.isArray(extra) || extra.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new Error('trustedSkillRoots 必须列出本机信任的 skill 安装根绝对路径')
  }
  try {
    const candidate = config[key] ?? path.join(SKILLS, relative)
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) throw new Error('候选脚本须用绝对路径')
    const actual = realPath(candidate)
    const projects = config.projects.map(project => realPath(project.root))
    if (!statSync(actual).isFile() || projects.some(root => inside(actual, root))) throw new Error('候选不在项目外的普通脚本中')
    for (const base of [SKILLS, ...extra]) {
      const root = realPath(base)
      if (actual === path.join(root, relative)) return actual
    }
    throw new Error('候选不在可信根的约定位置')
  } catch (error) {
    throw new Error(`${key} 的安装来源无法核验：${error.message}；请核对本机安装位置`)
  }
}
