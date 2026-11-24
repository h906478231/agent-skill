/** 从同一个已核验的普通文件描述符读取有界 JSON。 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import path from 'node:path'

/** 路径身份用于核对目录与文件的归属，普通读写可改变同一目录的时间戳。 */
export function sameObject(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
}

/**
 * 只有已经验证的父目录下缺少目标时，才返回 null。
 * @param {string} file 文件路径。
 * @param {number} maxBytes 单文件字节上限。
 * @param {Function} [charge] 累计读取额度：读取前以文件字节数调用，额度不足时由它抛出，不读取内容
 *   （add-change-pause design D0 第 3 条，评审 PERF-12）。
 */
export function readBoundedJson(file, maxBytes, charge) {
  const parent = path.dirname(file)
  const dir = lstatSync(parent)
  if (!dir.isDirectory()) throw new Error('父目录类型无效')
  let before
  try {
    before = lstatSync(file)
  } catch (error) {
    if (error.code !== 'ENOENT' || !sameObject(dir, lstatSync(parent))) throw error
    return null
  }
  if (!before.isFile() || before.nlink !== 1) throw new Error('文件类型或链接无效')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const opened = fstatSync(fd)
    if (!sameObject(before, opened) || opened.nlink !== 1) throw new Error('文件对象已改变')
    if (opened.size > maxBytes) throw new Error('文件超过字节上限')
    charge?.(opened.size)
    const contents = Buffer.allocUnsafe(opened.size + 1)
    let offset = 0
    while (offset < contents.length) {
      const count = readSync(fd, contents, offset, contents.length - offset, null)
      if (!count) break
      offset += count
    }
    const after = fstatSync(fd)
    if (offset !== opened.size || after.nlink !== 1 || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
      || !sameObject(opened, lstatSync(file)) || !sameObject(dir, lstatSync(parent))) throw new Error('读取时对象已改变')
    let value
    try {
      value = JSON.parse(contents.toString('utf8', 0, offset))
    } catch {
      throw new Error('JSON 无效')
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 对象无效')
    return value
  } finally {
    closeSync(fd)
  }
}
