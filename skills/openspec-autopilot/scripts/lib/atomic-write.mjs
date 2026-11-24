/** 托管文件共用的 JSON 原子写。读者只会看到替换前或替换后的完整文件。 */
import { closeSync, linkSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export function writeJsonAtomic(file, value, { indent = 2, mode = 0o600, replace = true, beforePublish } = {}) {
  const temporary = `${file}.tmp.${process.pid}.${randomUUID()}`
  const contents = `${JSON.stringify(value, null, indent)}\n`
  // 状态操作临时文件准备失败时也须清理；先独占打开，避免删除其他写者的文件。
  const fd = beforePublish ? openSync(temporary, 'wx', mode) : null
  if (fd === null) writeFileSync(temporary, contents, { flag: 'wx', mode })
  try {
    if (fd !== null) {
      try { writeFileSync(fd, contents) } finally { closeSync(fd) }
    }
    // 临时文件准备也会消耗预算，调用方可在公开新版本之前作最后一次核对。
    beforePublish?.()
    if (replace) renameSync(temporary, file)
    else linkSync(temporary, file)
  } finally {
    // 创建决策时用 link 拒绝覆盖；替换后的临时路径已不存在。
    try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return file
}
