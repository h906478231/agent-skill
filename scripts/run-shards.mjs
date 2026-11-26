#!/usr/bin/env node
/**
 * 把一个测试文件分成几个进程同时运行，缩短用例多、每个用例都同步启动子进程的测试文件的总耗时。
 *
 * 用法：node scripts/run-shards.mjs <分片数> <测试文件>
 *
 * 每个分片是一个 `node --test <测试文件>` 进程，环境变量 TEST_SHARD 为「序号/总数」；测试文件须从
 * scripts/lib/test-shard.mjs 导入 test，才会只运行属于本分片的用例（分配规则见该模块）。
 * 分片数不超过本机可用的 CPU 数。各分片同时运行；为免输出交错，每个分片的输出先缓存，结束时整段打印，
 * 打印顺序为结束顺序。行为与直接 `node --test <测试文件>` 一致：一个分片失败时其余分片照常运行完，
 * 全部结束后以序号最小的失败分片的退出码退出（被信号中断按 1 计），全部通过时退出码为 0。
 * 参数错误、测试文件读不到或没有导入分片模块时立即以 2 退出：没有导入时每个分片都会运行全部用例，结果正确但白白多跑几遍。
 */

import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { spawn } from 'node:child_process'
import { formatDuration } from './lib/format-duration.mjs'

/** 测试文件导入分片模块时必然出现的路径片段，用来在运行前发现忘记改用分片模块的测试文件。 */
const SHARD_MODULE = 'lib/test-shard.mjs'

const args = process.argv.slice(2)
const requested = Number(args[0])
if (args.length !== 2 || !Number.isInteger(requested) || requested < 1) {
  console.error('用法：node scripts/run-shards.mjs <分片数> <测试文件>')
  process.exit(2)
}
const file = args[1]
let source
try {
  source = readFileSync(file, 'utf8')
} catch (error) {
  console.error(`无法读取测试文件 ${file}：${error.message}`)
  process.exit(2)
}
if (!source.includes(SHARD_MODULE)) {
  console.error(`${file} 没有从 ${SHARD_MODULE} 导入 test，分片后每个分片都会运行全部用例`)
  process.exit(2)
}

// 分片数超过 CPU 数时，多出的进程只会互相争抢 CPU，还会拖慢用例里按时间断言的子进程。
const total = Math.min(requested, availableParallelism())
const startedAt = Date.now()
console.log(`分 ${total} 个进程同时运行 ${file}；每个分片结束时打印它的输出`)

/**
 * 运行一个分片。
 * @param {number} index 分片序号，从 1 计。
 * @returns {Promise<{ index: number, code: number }>} 分片序号与退出码（被信号中断时为 1）。
 */
function runShard(index) {
  return new Promise(resolve => {
    // 输出不是终端时 node --test 缺省改用 TAP 格式，这里指定与直接运行时相同的 spec 格式。
    const child = spawn(process.execPath, ['--test', '--test-reporter=spec', file], {
      env: { ...process.env, TEST_SHARD: `${index}/${total}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    // stdout 与 stderr 按到达顺序存入同一个数组，打印时保持两者的先后关系。
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.stderr.on('data', chunk => chunks.push(chunk))
    child.on('error', error => chunks.push(Buffer.from(`无法启动分片进程：${error.message}\n`)))
    child.on('close', (status, signal) => {
      const code = status === 0 ? 0 : status ?? 1
      process.stdout.write(Buffer.concat(chunks))
      const outcome = code === 0
        ? '通过'
        : signal ? `被信号 ${signal} 中断` : `失败（退出码 ${code}）`
      console.log(`${code === 0 ? '✓' : '✗'} 分片 ${index}/${total} ${outcome}，用时 ${formatDuration(Date.now() - startedAt)}`)
      resolve({ index, code })
    })
  })
}

/** 已启动的分片进程，收到中断信号时转发给它们，避免本进程退出后分片仍在后台运行。 */
const children = []
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) child.kill(signal)
  })
}

const results = await Promise.all(Array.from({ length: total }, (_, offset) => runShard(offset + 1)))
const failed = results.filter(result => result.code !== 0)
console.log(failed.length === 0
  ? `${total} 个分片全部通过，用时 ${formatDuration(Date.now() - startedAt)}`
  : `${failed.length}/${total} 个分片失败：${failed.map(result => result.index).join('、')}`)
// 用 exitCode 而不是 process.exit()，让输出写到管道时也能写完再退出。
process.exitCode = failed.length === 0 ? 0 : failed[0].code
