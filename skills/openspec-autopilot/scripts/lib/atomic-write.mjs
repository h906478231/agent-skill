/** 托管文件共用的 JSON 原子写。读者只会看到替换前或替换后的完整文件。 */
import { linkSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export function writeJsonAtomic(file, value, { indent = 2, mode = 0o600, replace = true } = {}) {
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`
  writeFileSync(temporary, `${JSON.stringify(value, null, indent)}\n`, { flag: 'wx', mode })
  try {
    if (replace) renameSync(temporary, file)
    else linkSync(temporary, file)
  } finally {
    // 创建决策时用 link 拒绝覆盖；替换后的临时路径已不存在。
    try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return file
}
