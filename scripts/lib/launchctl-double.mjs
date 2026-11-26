/**
 * `launchctl print` 的测试替身（add-change-pause design D4「实际调度入口」，Seam S3）。
 *
 * 所属：仓库测试脚本。调用方：autopilot-doubles.mjs 的 launchdDouble 写出的 `launchctl` 入口。
 * 用法：node launchctl-double.mjs <服务配置文件> print gui/<uid>/<标签>
 * 服务配置文件按标签保存 program、arguments、environment、inherited、delayMs（从替身进程启动起算的查询耗时）与 exitCode，
 * 用例改写它即可改变输出。
 * 输出与 macOS `launchctl print` 的一级缩进格式相同；只输出托管入口读取的字段，不连接真实的 launchd。
 */

import { readFileSync } from 'node:fs'

const [configFile, command, target] = process.argv.slice(2)
const services = JSON.parse(readFileSync(configFile, 'utf8'))
const label = String(target || '').split('/').pop()
const service = command === 'print' ? services[label] : null
if (!service) {
  process.stderr.write(`Bad request.\nCould not find service "${label}" in domain for user gui\n`)
  process.exit(113)
}
// 用例可以让查询变慢，验证单次 2 秒与合计 5 秒的上限。delayMs 从本进程启动起算（performance.now() 的起点），
// 扣除 Node.js 启动所用的时间：机器繁忙时启动可能用去数百毫秒，查询耗时仍接近 delayMs，用例的时间余量不随负载变化。
const wait = (service.delayMs || 0) - performance.now()
if (wait > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
if (service.exitCode) process.exit(service.exitCode)
const block = (name, lines) => [`\t${name} = {`, ...lines.map(line => `\t\t${line}`), '\t}']
const env = values => Object.entries(values || {}).map(([key, value]) => `${key} => ${value}`)
process.stdout.write([
  `${target} = {`,
  '\tactive count = 0',
  '\ttype = LaunchAgent',
  '\tstate = not running',
  '',
  `\tprogram = ${service.program}`,
  ...block('arguments', service.arguments || []),
  '',
  ...block('inherited environment', env(service.inherited)),
  '',
  ...block('default environment', env({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' })),
  '',
  ...block('environment', env(service.environment)),
  '',
  '\tproperties = inferred program',
  '}',
  '',
].join('\n'))
