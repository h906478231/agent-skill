import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 读取目录下全部文件的相对路径与内容，按路径排序。
 * 测试在只读命令（进度视图 progress.mjs、门禁脚本 facts）运行前后各取一次快照再比较，断言命令没有写入变更目录。
 * scripts/test-change-progress.mjs 与 scripts/test-implementation-gate.mjs 共用这一份，两边只读断言的规则才不会分叉。
 * @param {string} dir 要读取的目录。
 * @param {string} [rel] 递归时的相对路径，调用方不传。
 * @returns {Array<[string, string]>} [相对路径, UTF-8 内容] 的数组。
 */
export function snapshot(dir, rel = '') {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap(entry => {
    const child = rel ? `${rel}/${entry.name}` : entry.name
    return entry.isDirectory() ? snapshot(dir, child) : [[child, readFileSync(join(dir, child), 'utf8')]]
  }).sort(([a], [b]) => (a < b ? -1 : 1))
}
