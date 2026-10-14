import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 通过 /opsx:video 实际调用的 video.mjs 入口验证行为（doctor / check-storyboard / render 的 Python 启动前部分）；
// 每个用例在临时目录里构造项目与缓存目录，不改动本仓库，也不依赖本机是否安装 uv、ffmpeg、Piper。
const SCRIPT = fileURLToPath(new URL('../skills/openspec-explainer-video/scripts/video.mjs', import.meta.url))

/** 系统基础命令所在目录：保留 git 与 /bin/sh，去掉其余目录，让 uv、ffmpeg 等只来自假命令目录。 */
const BASE_PATH = ['/usr/bin', '/bin']

/**
 * 创建临时项目、空缓存目录与假命令目录。
 * @param {object} options gitignore：项目 .gitignore 内容，null 表示不写；bins：命令名 → shell 脚本内容（假命令）；
 *   script：要运行的 video.mjs，默认为本仓库中的脚本。
 */
function fixture(t, { gitignore = null, bins = {}, script = SCRIPT } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'explainer-video-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  const cache = join(root, 'cache')
  const bin = join(root, 'bin')
  mkdirSync(repo, { recursive: true })
  mkdirSync(bin, { recursive: true })
  spawnSync('git', ['init', '-q'], { cwd: repo })
  const write = (rel, text) => {
    const file = join(repo, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text)
  }
  if (gitignore !== null) write('.gitignore', gitignore)
  for (const [name, body] of Object.entries(bins)) {
    const file = join(bin, name)
    writeFileSync(file, `#!/bin/sh\n${body}\n`)
    chmodSync(file, 0o755)
  }
  const env = { ...process.env, PATH: [bin, ...BASE_PATH].join(':'), OPENSPEC_VIDEO_CACHE: cache }
  const run = args => {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: 'utf8', env })
    return { code: result.status, out: result.stdout, err: result.stderr, json: () => JSON.parse(result.stdout) }
  }
  const read = rel => readFileSync(join(repo, rel), 'utf8')
  return { root, repo, cache, write, read, run }
}

/** 取 doctor 报告中的一项检查。 */
const item = (report, id) => report.checks.find(check => check.id === id)

/** 假 ffmpeg：`-filters` 输出不含 subtitles（即未带 libass 构建）。 */
const FFMPEG_WITHOUT_LIBASS = 'echo " ... scale             V->V       Scale the input video size."'
/** 假 ffmpeg：`-filters` 输出含 subtitles。 */
const FFMPEG_WITH_LIBASS = 'echo " .. subtitles         V->V       Render text subtitles onto input video using the libass library."'

// ---------------------------------------------------------------------------
// Slice 01：环境自检（Seam：doctor）
// ---------------------------------------------------------------------------

test('doctor：ffmpeg 未带 libass 时报告字幕滤镜缺失并给出安装指引，退出码 1', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t, { bins: { ffmpeg: FFMPEG_WITHOUT_LIBASS } })
  const result = f.run(['doctor', '--repo', f.repo])
  assert.equal(result.code, 1, result.out + result.err)
  const report = result.json()
  assert.equal(item(report, 'ffmpeg').status, 'ok')
  const filter = item(report, 'ffmpeg-subtitles')
  assert.equal(filter.status, 'missing')
  assert.match(filter.install, /libass/)
})

test('doctor：ffmpeg 带 libass 时字幕滤镜检查通过', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t, { bins: { ffmpeg: FFMPEG_WITH_LIBASS } })
  const report = f.run(['doctor', '--repo', f.repo]).json()
  assert.equal(item(report, 'ffmpeg-subtitles').status, 'ok')
})

test('doctor：缺少 uv、Python 环境与 Piper 音色时逐项报告安装指引，且不创建缓存目录', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t)
  const result = f.run(['doctor', '--repo', f.repo])
  assert.equal(result.code, 1, result.out + result.err)
  const report = result.json()
  assert.equal(report.verdict, 'MISSING')
  for (const id of ['uv', 'python-env', 'manim', 'manim-voiceover', 'tts-engine', 'piper-voice', 'ffmpeg']) {
    const check = item(report, id)
    assert.equal(check.status, 'missing', id)
    assert.ok(check.install, `${id} 缺少安装指引`)
  }
  assert.equal(existsSync(f.cache), false, 'doctor 不得安装或创建任何内容')
})

test('doctor：项目 .gitignore 未忽略 video/media/ 时告警并给出要加的行；已忽略时通过', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t, { gitignore: 'node_modules/\n' })
  const warned = item(f.run(['doctor', '--repo', f.repo]).json(), 'gitignore')
  assert.equal(warned.status, 'warn')
  assert.match(warned.detail, /openspec\/changes\/\*\/video\/media\//)
  f.write('.gitignore', 'node_modules/\nopenspec/changes/*/video/media/\n')
  assert.equal(item(f.run(['doctor', '--repo', f.repo]).json(), 'gitignore').status, 'ok')
})

test('doctor：只有告警没有缺失项时退出码 0', { skip: process.platform === 'win32' }, t => {
  // 用假 uv 与假 Python 环境模拟依赖齐全：本用例只关心退出码与 verdict 的判定口径。
  const f = fixture(t, { bins: { ffmpeg: FFMPEG_WITH_LIBASS, 'uv': 'echo "uv 0.0.0"', 'fc-list': 'echo "PingFang SC"' } })
  const python = join(f.cache, 'venv', 'bin', 'python')
  mkdirSync(dirname(python), { recursive: true })
  writeFileSync(python, '#!/bin/sh\necho \'{"manim":"0.19.2","manim-voiceover":"0.3.7","piper-tts":"1.8.0","edge-tts":"7.2.8"}\'\n')
  chmodSync(python, 0o755)
  const missing = f.run(['doctor', '--repo', f.repo])
  assert.equal(missing.code, 1, missing.out + missing.err)
  assert.equal(item(missing.json(), 'piper-voice').status, 'missing')
  // 音色模型放在缓存目录的 piper/ 下：按报告给出的路径写入模型与配置。
  const model = item(missing.json(), 'piper-voice').path
  mkdirSync(dirname(model), { recursive: true })
  writeFileSync(model, '')
  writeFileSync(`${model}.json`, '{"phoneme_type":"espeak"}')
  const passed = f.run(['doctor', '--repo', f.repo])
  assert.equal(passed.code, 0, passed.out + passed.err)
  const report = passed.json()
  assert.equal(report.verdict, 'PASS')
  assert.equal(item(report, 'gitignore').status, 'warn')
})

// ---------------------------------------------------------------------------
// Slice 02：分镜检查（Seam：check-storyboard）
// ---------------------------------------------------------------------------

/** 示例术语表：取消的禁用别名为退单、撤单。 */
const GLOSSARY = [
  '# 订单', '', '## Language', '',
  '**Cancellation（取消）**:', '整单取消。', '_Avoid_: 退单、撤单', '',
].join('\n')

/** 示例变更模型（与 change-model.md 完整示例同构）：状态机 order-status 与流程 cancel-order。 */
const DESIGN = [
  '## 可视化判定', '',
  '- 状态变动：命中 → machines: order-status',
  '- 流程变动：命中 → flows: cancel-order', '',
  '```change-model',
  'version: 1',
  'machines:',
  '  - id: order-status',
  '    name: 订单状态',
  '    states:',
  '      - { id: PENDING, name: 待支付, initial: true }',
  '      - { id: PAID, name: 已支付 }',
  '      - { id: REFUNDING, name: 退款中, diff: added }',
  '      - { id: CANCELLED, name: 已取消, final: true }',
  '      - { id: CLOSED, name: 已关闭, final: true, diff: removed }',
  '    transitions:',
  '      - { id: T1, from: PENDING, to: PAID, trigger: 支付成功 }',
  '      - { id: T2, from: PENDING, to: CLOSED, trigger: 超时关闭, diff: removed }',
  '      - { id: T5, from: PAID, to: REFUNDING, trigger: 用户取消, diff: added, scenarios: [order-cancel/已支付订单取消后进入退款中] }',
  'flows:',
  '  - id: cancel-order',
  '    name: 用户取消订单',
  '    steps:',
  '      - { id: S1, name: 接收取消请求, actor: 用户 }',
  '      - { id: S2, name: 判断是否已支付, kind: decision, diff: added, scenarios: [order-cancel/已支付订单取消后进入退款中] }',
  '      - { id: S5, name: 发起渠道退款, causes: [T5], diff: added, scenarios: [order-cancel/已支付订单取消后进入退款中] }',
  '    edges:',
  '      - { from: S1, to: S2, diff: added }',
  '      - { from: S2, to: S5, label: 已支付, diff: added }',
  '```', '',
].join('\n')

const SPEC = ['## ADDED Requirements', '', '### Requirement: 示例', '',
  '#### Scenario: 已支付订单取消后进入退款中', '- **WHEN** 条件', '- **THEN** 结果', ''].join('\n')

/** 合法分镜的段落：每个用例在此基础上修改。 */
function baseSegments() {
  return [
    { narration: '这是变更前的订单状态。超时关闭的订单进入已关闭状态。',
      actions: ['show: { target: order-status, view: before }', 'highlight: [T2, CLOSED]'] },
    { narration: '本次变更删除已关闭状态，新增退款中状态。',
      actions: ['morph: { target: order-status, from: before, to: after }'] },
    { narration: '用户取消已支付的订单后，系统发起渠道退款，订单进入退款中。',
      actions: ['trace: { target: cancel-order, path: [S1, S2, S5] }', 'highlight: [S5, S2->S5]'] },
  ]
}

/** 拼出 storyboard.md：标题、签署行、可选备注与 storyboard 代码块。 */
function storyboardText({ focus = '已支付订单取消后的退款流程', tts = null, segments = baseSegments(), signature = '____', note = '', block = null } = {}) {
  const body = block !== null ? block : [
    `focus: ${focus}`,
    ...(tts ? [`tts: ${tts}`] : []),
    'segments:',
    ...segments.flatMap(segment => [
      `  - narration: ${segment.narration}`,
      segment.actions.length ? '    actions:' : '    actions: []',
      ...segment.actions.map(action => `      - ${action}`),
    ]),
  ].join('\n')
  return ['# 讲解视频分镜：已支付订单取消后的退款', '', `Storyboard Approved: ${signature}`, '', note,
    '```storyboard', body, '```', ''].join('\n')
}

/** 在 fixture 基础上写入术语表、变更（design + spec）与分镜。 */
function videoFixture(t, { design = DESIGN, ...options } = {}) {
  const f = fixture(t, options)
  const changeRoot = join(f.repo, 'openspec/changes/demo')
  f.write('CONTEXT.md', GLOSSARY)
  if (design !== null) f.write('openspec/changes/demo/design.md', design)
  f.write('openspec/changes/demo/specs/order-cancel/spec.md', SPEC)
  const storyboard = input => f.write('openspec/changes/demo/video/storyboard.md', typeof input === 'string' ? input : storyboardText(input))
  const checkStoryboard = () => f.run(['check-storyboard', changeRoot])
  return { ...f, changeRoot, storyboard, checkStoryboard }
}

/** 检查项摘要：`规则:命中内容`，便于整体断言。 */
const findings = report => report.blocking.map(entry => `${entry.rule}:${entry.text}`)

test('check-storyboard：合法分镜退出码 0，输出 8 位哈希、估算时长与未签署状态', t => {
  const f = videoFixture(t)
  f.storyboard()
  const result = f.checkStoryboard()
  assert.equal(result.code, 0, result.out + result.err)
  const report = result.json()
  assert.equal(report.verdict, 'PASS')
  assert.deepEqual(report.blocking, [])
  assert.match(report.hash, /^[0-9a-f]{8}$/)
  // 三段旁白共 24 + 18 + 26 = 68 个汉字（不含标点，手工计数），按每秒 4 个估算为 17 秒。
  assert.equal(report.estimatedSeconds, 17)
  assert.equal(report.signature, 'unsigned')
})

test('check-storyboard：highlight 引用变更模型中不存在的 T9 时退出码 1，报告段落与 T9', t => {
  const f = videoFixture(t)
  const segments = baseSegments()
  segments[1].actions.push('highlight: [T9]')
  f.storyboard({ segments })
  const result = f.checkStoryboard()
  assert.equal(result.code, 1, result.out + result.err)
  const report = result.json()
  assert.deepEqual(findings(report), ['SB-2:T9'])
  assert.equal(report.blocking[0].segment, 2)
  assert.equal(report.blocking[0].file, 'video/storyboard.md')
  const lines = f.read('openspec/changes/demo/video/storyboard.md').split('\n')
  assert.match(lines[report.blocking[0].line - 1], /T9/)
})

test('check-storyboard：旁白共 800 个汉字时退出码 1，报告估算时长 200 秒', t => {
  const f = videoFixture(t)
  const segments = baseSegments().slice(0, 1)
  segments[0].narration = '订单状态'.repeat(200)
  f.storyboard({ segments })
  const result = f.checkStoryboard()
  assert.equal(result.code, 1, result.out + result.err)
  const report = result.json()
  assert.equal(report.estimatedSeconds, 200)
  assert.deepEqual(findings(report), ['SB-3:200'])
  assert.match(report.blocking[0].detail, /200 秒/)
})

test('check-storyboard：旁白含禁用别名「退单」时退出码 1，报告段落、退单与取消', t => {
  const f = videoFixture(t)
  const segments = baseSegments()
  segments[2].narration = '用户退单后，系统发起渠道退款，订单进入退款中。'
  f.storyboard({ segments })
  const result = f.checkStoryboard()
  assert.equal(result.code, 1, result.out + result.err)
  const [entry] = result.json().blocking
  assert.equal(`${entry.rule}:${entry.text}`, 'SB-4:退单')
  assert.equal(entry.replacement, '取消')
  assert.equal(entry.segment, 3)
})

test('check-storyboard：找不到 openspec-ste 时退出码 2，不跳过旁白 STE 检查', t => {
  // 只复制 explainer-video 与 change-overview 两个 skill，模拟没有安装 openspec-ste 的项目。
  const skills = mkdtempSync(join(tmpdir(), 'explainer-video-skills-'))
  t.after(() => rmSync(skills, { recursive: true, force: true }))
  const source = fileURLToPath(new URL('../skills/', import.meta.url))
  for (const name of ['openspec-explainer-video', 'openspec-change-overview']) cpSync(join(source, name), join(skills, name), { recursive: true })
  const f = videoFixture(t, { script: join(skills, 'openspec-explainer-video', 'scripts', 'video.mjs') })
  const segments = baseSegments()
  segments[2].narration = '用户退单后，系统发起渠道退款，订单进入退款中。'
  f.storyboard({ segments })
  const result = f.checkStoryboard()
  assert.equal(result.code, 2, result.out + result.err)
  assert.match(result.err, /openspec-ste/)
})

test('check-storyboard：focus 为空时报 SB-5', t => {
  const f = videoFixture(t)
  f.storyboard({ focus: '""' })
  const result = f.checkStoryboard()
  assert.equal(result.code, 1, result.out + result.err)
  assert.deepEqual(findings(result.json()), ['SB-5:focus'])
})

test('check-storyboard：变更没有变更模型时报 SB-6，不核对元素 ID', t => {
  const f = videoFixture(t, { design: '## Context\n\n订单取消。\n' })
  f.storyboard()
  const result = f.checkStoryboard()
  assert.equal(result.code, 1, result.out + result.err)
  assert.deepEqual(findings(result.json()), ['SB-6:change-model'])
})

test('check-storyboard：highlight 之前没有当前图、trace 相邻节点之间没有连线时报 SB-2', t => {
  const f = videoFixture(t)
  const segments = baseSegments()
  segments[0].actions = ['highlight: [T2]', 'show: { target: order-status, view: before }']
  segments[2].actions = ['trace: { target: cancel-order, path: [S1, S5] }']
  f.storyboard({ segments })
  const report = f.checkStoryboard().json()
  assert.deepEqual(findings(report), ['SB-2:T2', 'SB-2:S1->S5'])
  assert.match(report.blocking[0].detail, /当前图/)
})

test('check-storyboard：动作名不在动作表、morph 的 from 等于 to 时报 SB-1，且不再核对元素 ID', t => {
  const f = videoFixture(t)
  const segments = baseSegments()
  segments[0].actions = ['show: { target: refund-status, view: before }']
  segments[1].actions = ['zoom: [PAID]', 'morph: { target: order-status, from: after, to: after }']
  f.storyboard({ segments })
  assert.deepEqual(findings(f.checkStoryboard().json()), ['SB-1:zoom', 'SB-1:morph'])
})

test('check-storyboard：show 的 target 不是变更模型中的图 ID 时报 SB-2', t => {
  const f = videoFixture(t)
  const segments = baseSegments()
  segments[0].actions = ['show: { target: refund-status, view: before }']
  f.storyboard({ segments })
  assert.deepEqual(findings(f.checkStoryboard().json()), ['SB-2:refund-status'])
})

test('check-storyboard：没有 storyboard 代码块时报 SB-1；分镜文件不存在时退出码 2', t => {
  const f = videoFixture(t)
  assert.equal(f.checkStoryboard().code, 2)
  f.storyboard('# 讲解视频分镜\n\nStoryboard Approved: ____\n')
  const result = f.checkStoryboard()
  assert.equal(result.code, 1)
  assert.deepEqual(findings(result.json()), ['SB-1:storyboard'])
})

test('check-storyboard：哈希只随代码块变化；签署行哈希一致为 signed，不一致为 stale', t => {
  const f = videoFixture(t)
  f.storyboard()
  const hash = f.checkStoryboard().json().hash
  f.storyboard({ note: '备注：代码块之外的说明不参与哈希。' })
  assert.equal(f.checkStoryboard().json().hash, hash)
  f.storyboard({ signature: `张三 2026-10-09 ${hash}` })
  assert.equal(f.checkStoryboard().json().signature, 'signed')
  const segments = baseSegments()
  segments[1].narration = '本次变更删除已关闭状态，新增退款中状态和已退款状态。'
  f.storyboard({ signature: `张三 2026-10-09 ${hash}`, segments })
  const report = f.checkStoryboard().json()
  assert.notEqual(report.hash, hash)
  assert.equal(report.signature, 'stale')
})

// ---------------------------------------------------------------------------
// Slice 03：render 在启动 Python 之前的门禁（Seam：render）
// ---------------------------------------------------------------------------

/** 写入合法分镜并按当前哈希签署，返回哈希。 */
function signStoryboard(f, options = {}) {
  f.storyboard(options)
  const { hash } = f.checkStoryboard().json()
  f.storyboard({ ...options, signature: `张三 2026-10-09 ${hash}` })
  return hash
}

/** render 拒绝后不得开始渲染：video/media/ 不存在。 */
const assertNotRendered = f => assert.equal(existsSync(join(f.changeRoot, 'video', 'media')), false, '拒绝渲染时不得写入 video/media/')

test('render：签署行为占位 ____ 时退出码 1，不开始渲染', t => {
  const f = videoFixture(t)
  f.storyboard()
  const result = f.run(['render', f.changeRoot])
  assert.equal(result.code, 1, result.out + result.err)
  const report = result.json()
  assert.equal(report.verdict, 'BLOCKED')
  assert.equal(report.reason, 'unsigned')
  assert.match(report.detail, /未签署/)
  assertNotRendered(f)
})

test('render：签署后修改分镜代码块时退出码 1，要求重新签署', t => {
  const f = videoFixture(t)
  const hash = signStoryboard(f)
  const segments = baseSegments()
  segments[0].narration = '这是变更前的订单状态。'
  f.storyboard({ segments, signature: `张三 2026-10-09 ${hash}` })
  const result = f.run(['render', f.changeRoot])
  assert.equal(result.code, 1, result.out + result.err)
  const report = result.json()
  assert.equal(report.reason, 'stale')
  assert.match(report.detail, /重新签署/)
  assertNotRendered(f)
})

test('render：签署行缺少哈希时退出码 1，报告签署行格式错误', t => {
  const f = videoFixture(t)
  f.storyboard({ signature: '张三 2026-10-09' })
  const result = f.run(['render', f.changeRoot])
  assert.equal(result.code, 1, result.out + result.err)
  assert.equal(result.json().reason, 'invalid')
})

test('render：tts: edge 且未带 --allow-online-tts 时退出码 1，说明旁白会离开本机', t => {
  const f = videoFixture(t)
  signStoryboard(f, { tts: 'edge' })
  const result = f.run(['render', f.changeRoot])
  assert.equal(result.code, 1, result.out + result.err)
  const report = result.json()
  assert.equal(report.reason, 'online-tts')
  assert.match(report.detail, /离开本机/)
  assert.match(report.detail, /--allow-online-tts/)
  assertNotRendered(f)
})

test('render：已签署但分镜检查不通过时输出检查报告，退出码 1', t => {
  const f = videoFixture(t)
  const segments = baseSegments()
  segments[1].actions.push('highlight: [T9]')
  signStoryboard(f, { segments })
  const result = f.run(['render', f.changeRoot])
  assert.equal(result.code, 1, result.out + result.err)
  assert.deepEqual(findings(result.json()), ['SB-2:T9'])
  assertNotRendered(f)
})

test('render：已签署且带 --allow-online-tts 时通过门禁，进入 Python 阶段（本机无 uv 时退出码 2）', t => {
  const f = videoFixture(t, { bins: { 'fc-list': 'echo "PingFang SC"' } })
  signStoryboard(f, { tts: 'edge' })
  const result = f.run(['render', f.changeRoot, '--allow-online-tts'])
  assert.equal(result.code, 2, result.out + result.err)
  assert.match(result.err, /uv/)
  // 场景运行器按渲染输入创建语音服务：确认在线引擎与中文音色已传给 Python。
  const input = JSON.parse(f.read('openspec/changes/demo/video/media/render-input.json'))
  assert.equal(input.tts.engine, 'edge')
  assert.equal(input.tts.edgeVoice, 'zh-CN-XiaoxiaoNeural')
})

/** Piper 默认音色（design 决策 5，Slice 01 用户试听确认）。 */
const DEFAULT_PIPER_VOICE = 'zh_CN-huayan-medium'

test('render：分镜不写 tts 时默认使用离线 Piper，不要求 --allow-online-tts（本机无 uv 时退出码 2）', { skip: process.platform === 'win32' }, t => {
  const f = videoFixture(t, { bins: { 'fc-list': 'echo "PingFang SC"' } })
  signStoryboard(f)
  // Piper 引擎在启动 Python 之前检查音色模型：在缓存目录 piper/ 下放入假模型与配置。
  const model = join(f.cache, 'piper', `${DEFAULT_PIPER_VOICE}.onnx`)
  mkdirSync(dirname(model), { recursive: true })
  writeFileSync(model, '')
  writeFileSync(`${model}.json`, '{"phoneme_type":"espeak"}')
  const result = f.run(['render', f.changeRoot])
  assert.equal(result.code, 2, result.out + result.err)
  assert.match(result.err, /uv/)
  // 默认路径不得走在线引擎：渲染输入的引擎为 piper，音色模型取缓存目录中的默认音色。
  const input = JSON.parse(f.read('openspec/changes/demo/video/media/render-input.json'))
  assert.equal(input.tts.engine, 'piper')
  assert.equal(input.storyboard.tts, 'piper')
  assert.equal(input.tts.piperModel, model)
})

test('doctor：--tts edge 时检查 edge-tts，不检查 Piper 音色', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t)
  const report = f.run(['doctor', '--repo', f.repo, '--tts', 'edge']).json()
  assert.match(item(report, 'tts-engine').detail, /edge-tts/)
  assert.equal(item(report, 'piper-voice'), undefined)
})
