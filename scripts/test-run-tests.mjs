import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/**
 * 测试运行脚本 run-tests.mjs 的命令行测试。
 * 每个用例在临时目录写一份 package.json，用 node -e 模拟通过或失败的测试脚本，再在该目录调用运行脚本。
 */
const runner = fileURLToPath(new URL('./run-tests.mjs', import.meta.url))

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
