#!/usr/bin/env node
/**
 * 按顺序运行 package.json 中的多个 npm 脚本，并显示进度与耗时。
 *
 * 用法：node scripts/run-tests.mjs <脚本名>...
 *
 * 行为与原来用 && 串联的写法一致：逐个运行，任一步失败就停止，并以该步的退出码退出。
 * 增加的只有显示：每步开始时打印「第几步 / 共几步」与累计用时，每步结束时打印本步用时，
 * 全部结束或中途失败时打印各步汇总。子进程直接继承终端，测试输出不经过本脚本转发。
 * 脚本名在运行前全部校验，写错的名称立即报错（退出码 2），不会等前面的步骤跑完才发现。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const names = process.argv.slice(2)
if (names.length === 0) {
  console.error('用法：node scripts/run-tests.mjs <脚本名>...')
  process.exit(2)
}

/** npm 运行脚本时工作目录是包根目录，这里按同样的位置读取 package.json。 */
const scripts = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).scripts ?? {}
const unknown = names.filter(name => !(name in scripts))
if (unknown.length > 0) {
  console.error(`package.json 中没有这些脚本：${unknown.join('、')}`)
  process.exit(2)
}

/** 把毫秒写成「1 分 05 秒」或「3.2 秒」。 */
function formatDuration(ms) {
  if (ms < 59950) return `${(ms / 1000).toFixed(1)} 秒`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}

const total = names.length
const width = Math.max(...names.map(name => name.length))
const startedAt = Date.now()
/** 每步的结果：status 为 pass、fail 或 skip。 */
const results = names.map(name => ({ name, status: 'skip', ms: 0 }))
let exitCode = 0

for (const [index, result] of results.entries()) {
  const step = `[${index + 1}/${total}]`
  console.log(`\n━━ ${step} ${result.name}（累计已用 ${formatDuration(Date.now() - startedAt)}）━━`)
  const stepStartedAt = Date.now()
  // --silent 只隐藏 npm 自己打印的脚本标题和失败日志，脚本本身的输出不受影响。
  const child = spawnSync('npm', ['run', '--silent', result.name], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  result.ms = Date.now() - stepStartedAt
  if (child.error) {
    console.error(`无法启动 npm：${child.error.message}`)
    exitCode = 1
  } else if (child.signal) {
    exitCode = 1
  } else {
    exitCode = child.status ?? 1
  }
  result.status = exitCode === 0 ? 'pass' : 'fail'
  const outcome = exitCode === 0
    ? '通过'
    : child.signal ? `被信号 ${child.signal} 中断` : `失败（退出码 ${exitCode}）`
  console.log(`${exitCode === 0 ? '✓' : '✗'} ${step} ${result.name} ${outcome}，用时 ${formatDuration(result.ms)}`)
  if (exitCode !== 0) break
}

const passed = results.filter(result => result.status === 'pass').length
const failed = results.find(result => result.status === 'fail')
const headline = failed
  ? `测试汇总：${passed}/${total} 步通过，${failed.name} 失败，后面 ${total - passed - 1} 步未运行`
  : `测试汇总：${total}/${total} 步全部通过`
console.log(`\n${headline}，总用时 ${formatDuration(Date.now() - startedAt)}`)
const MARK = { pass: '✓', fail: '✗', skip: '-' }
for (const result of results) {
  const time = result.status === 'skip' ? '未运行' : formatDuration(result.ms)
  console.log(`  ${MARK[result.status]} ${result.name.padEnd(width)}  ${time}`)
}
// 用 exitCode 而不是 process.exit()，让输出写到管道时也能写完再退出。
process.exitCode = exitCode
