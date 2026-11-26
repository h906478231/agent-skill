/**
 * 测试分片：按环境变量 TEST_SHARD（「序号/总数」，如 `2/4`）只登记属于本分片的顶层用例。
 *
 * 所属：仓库测试脚本。调用方：用 scripts/run-shards.mjs 分片运行的测试文件，用本模块的 test 代替 node:test 的 test。
 * 用途：这些测试文件的用例都用 spawnSync 同步运行子进程，同一进程内无法并发；run-shards.mjs 把同一文件
 *   分给几个进程同时运行，每个进程只运行一部分用例。
 * 分配规则：第 k 个登记的顶层用例（从 0 计）属于第 k % 总数 + 1 个分片。登记顺序由模块代码决定，各分片一致，
 *   因此每个用例恰好在一个分片中运行；轮流分配也让耗时长的用例大致分散到各分片。
 * 没有 TEST_SHARD 时原样登记全部用例：直接用 node --test 运行测试文件，结果与改用本模块之前相同。
 * 用例内的 t.test 子用例不经过本模块，始终随所属的顶层用例一起运行。
 */

import { test as nodeTest } from 'node:test'

/**
 * 解析 TEST_SHARD。
 * @param {string | undefined} value 环境变量的值。
 * @returns {{ index: number, total: number } | null} 分片序号（从 1 计）与总数；没有设置时为 null。
 * @throws {Error} 值不是「序号/总数」或序号超出 1 到总数时抛出，避免写错时静默运行全部或零个用例。
 */
function parseShard(value) {
  if (value === undefined || value === '') return null
  const match = /^(\d+)\/(\d+)$/u.exec(value)
  const index = match ? Number(match[1]) : 0
  const total = match ? Number(match[2]) : 0
  if (!match || index < 1 || index > total) throw new Error(`TEST_SHARD 应为「序号/总数」且序号在 1 到总数之间：${value}`)
  return { index, total }
}

const shard = parseShard(process.env.TEST_SHARD)
/** 已登记的顶层用例数，用来按登记顺序轮流分配分片。 */
let registered = 0

/**
 * 与 node:test 的 test 参数相同；分片时不属于本分片的用例不登记，返回 undefined。
 * @param {...unknown} args 传给 node:test 的 test 的参数。
 * @returns {Promise<void> | undefined} node:test 的返回值；未登记时为 undefined。
 */
export function test(...args) {
  if (shard === null) return nodeTest(...args)
  const position = registered++
  return position % shard.total === shard.index - 1 ? nodeTest(...args) : undefined
}
