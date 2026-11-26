import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 测试运行脚本 run-tests.mjs 与分片运行脚本 run-shards.mjs 的命令行测试。
 * run-tests.mjs 的用例在临时目录写一份 package.json，用 node -e 模拟通过或失败的测试脚本，再在该目录调用运行脚本；
 * run-shards.mjs 的用例在临时目录写一个测试文件，每个用例把名称追加到日志文件，用日志核对各用例运行的次数。
 */
const runner = fileURLToPath(new URL('./run-tests.mjs', import.meta.url))
const shardRunner = fileURLToPath(new URL('./run-shards.mjs', import.meta.url))
const shardModule = new URL('./lib/test-shard.mjs', import.meta.url).href

/** 在临时目录按给定 scripts 写 package.json，运行 run-tests.mjs，返回退出码与输出。 */
function run(scripts, names) {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts }))
    const result = spawnSync(process.execPath, [runner, ...names], { cwd: dir, encoding: 'utf8', timeout: 60000 })
    return { code: result.status, out: result.stdout, err: result.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const PASS = 'node -e "console.log(\'ran-\' + process.env.npm_lifecycle_event)"'
const FAIL = 'node -e "process.exit(3)"'

test('全部通过时按顺序显示每步进度并以 0 退出', () => {
  const { code, out } = run({ a: PASS, b: PASS }, ['a', 'b'])
  assert.equal(code, 0)
  assert.ok(out.indexOf('[1/2] a') < out.indexOf('ran-a'))
  assert.ok(out.indexOf('ran-a') < out.indexOf('[2/2] b'))
  assert.match(out, /✓ \[2\/2\] b 通过，用时 \d+\.\d 秒/)
  assert.match(out, /测试汇总：2\/2 步全部通过，总用时/)
})

test('某步失败时停止运行后面的步骤，并以该步的退出码退出', () => {
  const { code, out } = run({ a: PASS, b: FAIL, c: PASS }, ['a', 'b', 'c'])
  assert.equal(code, 3)
  assert.match(out, /✗ \[2\/3\] b 失败（退出码 3）/)
  assert.doesNotMatch(out, /ran-c/)
  assert.match(out, /测试汇总：1\/3 步通过，b 失败，后面 1 步未运行/)
  assert.match(out, /- c\s+未运行/)
})

test('脚本名写错时不运行任何步骤，以 2 退出并列出错误的名称', () => {
  const { code, out, err } = run({ a: PASS }, ['a', 'nope'])
  assert.equal(code, 2)
  assert.doesNotMatch(out, /ran-a/)
  assert.match(err, /package\.json 中没有这些脚本：nope/)
})

/**
 * 在临时目录写一个测试文件：每个用例把名称追加到 ran.log，failing 中的用例随后失败。
 * @param {object} t node:test 的用例上下文，用例结束时删除临时目录。
 * @param {string[]} names 用例名称。
 * @param {object} options failing 为失败的用例名称；module 为导入 test 的模块，缺省为分片模块。
 * @returns {{ dir: string, file: string, ran: Function }} 临时目录、测试文件与读取日志的函数（每行一个用例名称）。
 */
function shardFixture(t, names, { failing = [], module = shardModule } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'run-shards-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const log = join(dir, 'ran.log')
  const file = join(dir, 'sample.test.mjs')
  writeFileSync(file, `import { test } from ${JSON.stringify(module)}
import { appendFileSync } from 'node:fs'
for (const name of ${JSON.stringify(names)}) {
  test(name, () => {
    appendFileSync(${JSON.stringify(log)}, name + '\\n')
    if (${JSON.stringify(failing)}.includes(name)) throw new Error('预期失败：' + name)
  })
}
`)
  const ran = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).sort() : []
  return { dir, file, ran }
}

/**
 * 子进程的环境变量：去掉 NODE_TEST_CONTEXT 与 TEST_SHARD。
 * node --test 给测试文件进程设置 NODE_TEST_CONTEXT；子进程继承它时，内层的 node --test 会按测试文件子进程的方式
 * 输出序列化事件，不再像在终端里那样运行测试文件。TEST_SHARD 由 run-shards.mjs 设置，用例自己运行测试文件时不继承。
 */
const { NODE_TEST_CONTEXT, TEST_SHARD, ...childEnv } = process.env

/** 在临时目录运行 run-shards.mjs，返回退出码与输出。 */
function runShards(dir, args) {
  const result = spawnSync(process.execPath, [shardRunner, ...args], { cwd: dir, encoding: 'utf8', timeout: 60000, env: childEnv })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

const NAMES = ['u1', 'u2', 'u3', 'u4', 'u5']
/** 分片数不超过本机 CPU 数，用例按实际分片数断言，单核机器上也成立。 */
const SHARDS = Math.min(2, availableParallelism())

test('分片运行时每个用例恰好运行一次，全部通过时以 0 退出', t => {
  const f = shardFixture(t, NAMES)
  const { code, out } = runShards(f.dir, [String(SHARDS), f.file])
  assert.equal(code, 0, out)
  assert.deepEqual(f.ran(), NAMES)
  for (let index = 1; index <= SHARDS; index++) assert.match(out, new RegExp(`✓ 分片 ${index}/${SHARDS} 通过，用时`))
  assert.match(out, new RegExp(`${SHARDS} 个分片全部通过，用时`))
})

test('不经过分片脚本运行时登记全部用例，TEST_SHARD 写错时测试文件报错', t => {
  const f = shardFixture(t, NAMES)
  const direct = spawnSync(process.execPath, ['--test', f.file], { cwd: f.dir, encoding: 'utf8', timeout: 60000, env: childEnv })
  assert.equal(direct.status, 0, direct.stdout)
  assert.deepEqual(f.ran(), NAMES)
  for (const value of ['0/2', '3/2', '1-2']) {
    const wrong = spawnSync(process.execPath, [f.file], { cwd: f.dir, encoding: 'utf8', env: { ...childEnv, TEST_SHARD: value } })
    assert.notEqual(wrong.status, 0, value)
    assert.match(wrong.stderr, /TEST_SHARD 应为「序号\/总数」/, value)
  }
  assert.deepEqual(f.ran(), NAMES)
})

test('某个分片失败时其余分片照常运行完，以失败分片的退出码退出', t => {
  const f = shardFixture(t, NAMES, { failing: ['u2'] })
  const { code, out } = runShards(f.dir, [String(SHARDS), f.file])
  assert.equal(code, 1, out)
  assert.deepEqual(f.ran(), NAMES)
  assert.match(out, /预期失败：u2/)
  // 第 2 个登记的用例按轮流分配属于第 2 个分片（单核时只有 1 个分片）。
  assert.match(out, new RegExp(`✗ 分片 ${SHARDS}/${SHARDS} 失败（退出码 1）`))
  assert.match(out, new RegExp(`1/${SHARDS} 个分片失败：${SHARDS}`))
})

test('测试文件没有导入分片模块或参数写错时以 2 退出，不运行任何用例', t => {
  const f = shardFixture(t, NAMES, { module: 'node:test' })
  const missing = runShards(f.dir, ['2', f.file])
  assert.equal(missing.code, 2)
  assert.match(missing.err, /没有从 lib\/test-shard\.mjs 导入 test/)
  for (const args of [['0', f.file], ['2'], ['x', f.file], ['2', join(f.dir, 'nope.mjs')]]) {
    assert.equal(runShards(f.dir, args).code, 2, args.join(' '))
  }
  assert.deepEqual(f.ran(), [])
})
