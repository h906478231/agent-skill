#!/usr/bin/env node
/**
 * Skills 内部引用校验
 *
 * 作用：确认每个 skill 引用的 shared/ roles/ hooks/ 资产在仓库中真实存在，
 * 防止「规则事实源换了位置、引用没跟着改」这类静默断链流入安装包。
 *
 * 设计约束：
 * 1. 不依赖任何外部安装目录。skill 会被安装到 ~/.claude/skills、~/.config/opencode/skills
 *    等不同位置，脚本只以本仓库自身为基准解析路径。
 * 2. 只校验仓库自有的资产引用，不校验运行期产物路径（openspec/changes/**、review/*.md 等）。
 * 3. 支持本仓约定的四种写法：裸 `shared/x.md`、相对当前文件 `../x/shared/x.md`、
 *    `<SKILL_DIR>/shared/x.md`、跨 skill 定位用的 glob 前缀写法。
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录，以脚本自身位置推算，不写死绝对路径。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS_DIR = path.join(ROOT, 'skills')

/** 需要校验的资产目录：只有这几个目录下的 .md 才是规则事实源。 */
const ASSET_DIRS = ['shared', 'roles', 'hooks']

/**
 * 引用提取正则。
 * 结构：前缀（<SKILL_DIR>/ 、glob 前缀或若干 ../）+ 可选 skill 名 + 资产目录 + 文件名。
 */
const REF_PATTERN = new RegExp(
  String.raw`((?:<SKILL_DIR>/|\*\*/|(?:\.\.?/)*)(?:[A-Za-z0-9._-]+/)?(?:${ASSET_DIRS.join('|')})/[A-Za-z0-9._/-]+\.md)`,
  'g',
)

/** 终端着色：非 TTY 环境（如 CI 重定向）不着色，避免日志里出现转义序列。 */
const useColor = process.stdout.isTTY
const paint = (code, text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text)
const green = (t) => paint('0;32', t)
const red = (t) => paint('0;31', t)

/**
 * 找到某个文件所属的 skill 根目录。
 * 例：skills/openspec-grill/shared/interview-rules.md → skills/openspec-grill
 */
function findSkillRoot(file) {
  let dir = path.dirname(file)
  while (path.dirname(dir) !== SKILLS_DIR) {
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return dir
}

/**
 * 把一条引用解析为候选的绝对路径列表，命中任一即视为可达。
 * 返回多个候选是因为同一写法在不同位置语义不同（如资产文件内部的自指写法）。
 */
function resolveCandidates(fromFile, ref) {
  const skillRoot = findSkillRoot(fromFile)

  // 本仓约定的显式 skill 根前缀
  if (ref.startsWith('<SKILL_DIR>/')) {
    return skillRoot ? [path.join(skillRoot, ref.slice('<SKILL_DIR>/'.length))] : []
  }

  // 跨 agent 无法确定相对基准时使用的 glob 写法：在本仓 skills/ 下按剩余路径定位
  if (ref.startsWith('**/')) {
    const rest = ref.slice(3)
    return [path.join(SKILLS_DIR, rest), path.join(ROOT, rest)]
  }

  const candidates = [path.resolve(path.dirname(fromFile), ref)]
  // 资产文件内部自指（如 tdd-discipline.md 里写 shared/tdd-discipline.md）需回退到 skill 根
  if (skillRoot) candidates.push(path.resolve(skillRoot, ref))
  return candidates
}

/** 收集待校验的文件：所有 skill 的 SKILL.md，以及资产目录下的 .md。 */
async function collectFiles() {
  const files = []
  for (const entry of await readdir(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillDir = path.join(SKILLS_DIR, entry.name)

    const skillFile = path.join(skillDir, 'SKILL.md')
    if (existsSync(skillFile)) files.push(skillFile)

    for (const assetDir of ASSET_DIRS) {
      const dir = path.join(skillDir, assetDir)
      if (!existsSync(dir)) continue
      for (const asset of await readdir(dir, { withFileTypes: true })) {
        if (asset.isFile() && asset.name.endsWith('.md')) files.push(path.join(dir, asset.name))
      }
    }
  }
  return files
}

async function main() {
  const files = await collectFiles()
  let okCount = 0
  const broken = []

  for (const file of files) {
    const content = await readFile(file, 'utf8')
    const refs = new Set(content.match(REF_PATTERN) ?? [])

    for (const ref of refs) {
      const candidates = resolveCandidates(file, ref)
      const hit = candidates.find((candidate) => existsSync(candidate))
      if (hit) {
        okCount++
      } else {
        broken.push({ file, ref })
      }
    }
  }

  console.log(paint('1;36', '╔══════════════════════════════════════════════════════════════════════════════╗'))
  console.log(paint('1;36', '║            Skills 引用校验                                                   ║'))
  console.log(paint('1;36', '╚══════════════════════════════════════════════════════════════════════════════╝'))
  console.log('')
  console.log(`扫描 ${files.length} 个文件，发现 ${okCount + broken.length} 条资产引用`)
  console.log('')

  if (broken.length === 0) {
    console.log(green(`✓ 全部 ${okCount} 条引用可达`))
    console.log('')
    process.exit(0)
  }

  console.log(red(`✗ 发现 ${broken.length} 条断链：`))
  console.log('')
  for (const { file, ref } of broken) {
    console.log(`  ${red('✗')} ${path.relative(ROOT, file)} → ${ref}`)
    console.log(`      候选路径均不存在：${resolveCandidates(file, ref).map((c) => path.relative(ROOT, c)).join(' | ')}`)
  }
  console.log('')
  console.log(red('❌ 引用校验失败'))
  process.exit(1)
}

await main()
