#!/usr/bin/env node
/**
 * 讲解视频的编排与检查：环境自检、分镜检查与渲染（Python 场景运行器之前的全部门禁都在这里判定）。
 *
 * 所属：skill openspec-explainer-video。调用方：/opsx:video（经 SKILL.md）。规则事实源（本脚本只做确定性判定，不重复规则说明）：
 *   - 分镜格式、镜头动作表、检查规则与签署：shared/storyboard.md
 *   - 触发方式、在线 TTS 确认、依赖安装与 .gitignore：SKILL.md
 *
 * 用法：
 *   node video.mjs doctor [--repo <dir>] [--tts piper|edge]                     依赖自检，只给安装指引，不安装
 *   node video.mjs check-storyboard <changeRoot> [--repo <dir>]                 分镜检查（SB-1～SB-6），输出哈希
 *   node video.mjs render <changeRoot> [--repo <dir>] [--allow-online-tts] [--quality low|medium|high]
 *                                                                               签署与在线 TTS 校验通过后经 uv 运行场景运行器
 *
 * 输出：JSON 对象。doctor 输出 { verdict, checks }；check-storyboard 输出
 *   { verdict, blocking, warnings, exemptions, hash, estimatedSeconds, signature }，检查项字段与 ste-lint.mjs check 相同；
 *   render 拒绝时输出 { verdict: 'BLOCKED', reason, detail } 或分镜检查报告，成功时输出 { verdict, video, srt, duration, subtitles, warnings }。
 * 退出码：0 通过；1 存在阻断项（doctor 为存在缺失项）；2 参数或环境错误。
 * 环境变量：OPENSPEC_VIDEO_CACHE 覆盖用户缓存目录；OPENSPEC_VIDEO_PIPER_VOICE 覆盖 Piper 音色名。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
// 内置 YAML 解析库：目标项目不一定执行 npm install，不能依赖其 node_modules。
import { load as loadYaml } from '../vendor/js-yaml.mjs'

/** 退出码：通过 / 存在阻断项 / 参数或环境错误，与 change-model.mjs、ste-lint.mjs 一致。 */
const EXIT = Object.freeze({ PASS: 0, BLOCKED: 1, ERROR: 2 })

/** 本 skill 根目录与 Python 场景运行器目录（uv 项目）。 */
const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PYTHON_DIR = path.join(SKILL_DIR, 'python')
/** 上游脚本：变更模型布局（元素 ID 与坐标）与 STE 文本检查，都在同一 skills 根目录下。 */
const CM_SCRIPT = path.resolve(SKILL_DIR, '..', 'openspec-change-overview', 'scripts', 'change-model.mjs')
const STE_SCRIPT = path.resolve(SKILL_DIR, '..', 'openspec-ste', 'scripts', 'ste-lint.mjs')
/** STE 检查的环境告警编号（缺少术语表等），原样转发。 */
const STE_ENV_RULE = 'ENV'

/** 默认 Piper 中文音色：模型与配置放在缓存目录的 piper/ 下，由用户按 doctor 指引下载。 */
const DEFAULT_PIPER_VOICE = 'zh_CN-huayan-medium'
/** 拼音音素化的音色需要 g2pW 模型（相对 piper/ 目录）；Piper 缺失时会联网下载，默认引擎必须离线，所以先检查。 */
const G2PW_MODEL = path.join('g2pW', 'g2pw.onnx')
const PINYIN_PHONEME_TYPE = 'pinyin'

/** 支持的 TTS 引擎；未写 tts 时使用 piper（离线）。 */
const TTS_ENGINES = ['piper', 'edge']
const DEFAULT_TTS = 'piper'
/** 会把旁白文本发送到外部服务的引擎：render 必须带 --allow-online-tts（二次确认）。 */
const ONLINE_ENGINES = Object.freeze({ edge: '微软 Edge 在线语音服务' })
/** edge-tts 的中文音色。 */
const EDGE_VOICE = 'zh-CN-XiaoxiaoNeural'

/** 视频产物目录的忽略规则：音频、视频与 Manim 缓存只写在这里，不进 git。 */
const GITIGNORE_ENTRY = 'openspec/changes/*/video/media/'
/** 用于 git check-ignore 的探测路径：变更名任意，只要落在 video/media/ 下。 */
const GITIGNORE_PROBE = 'openspec/changes/__probe__/video/media/explainer.mp4'

/** 中文字体候选（按优先级）：Manim 文字与 ffmpeg 硬字幕使用同一字体。 */
const CJK_FONTS = ['PingFang SC', 'Noto Sans CJK SC', 'Source Han Sans SC', 'Microsoft YaHei', 'WenQuanYi Zen Hei', 'Hiragino Sans GB', 'Heiti SC']
/** 没有 fc-list 时按字体文件判断（字体名 → 常见安装路径）。 */
const CJK_FONT_FILES = Object.freeze({
  'PingFang SC': ['/System/Library/Fonts/PingFang.ttc'],
  'Microsoft YaHei': ['C:\\Windows\\Fonts\\msyh.ttc'],
  'Noto Sans CJK SC': ['/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'],
})

/** doctor 检查项状态：ok 通过；missing 缺失（退出码 1）；warn 告警（不影响退出码）。 */
const STATUS = Object.freeze({ OK: 'ok', MISSING: 'missing', WARN: 'warn' })

/** 安装指引：只输出命令，不执行（spec：doctor SHALL NOT install）。 */
const INSTALL = Object.freeze({
  uv: 'macOS：brew install uv；Linux / macOS：curl -LsSf https://astral.sh/uv/install.sh | sh；Windows：powershell -c "irm https://astral.sh/uv/install.ps1 | iex"',
  ffmpeg: '需要带 libass 字幕滤镜的 ffmpeg。macOS：brew install ffmpeg-full（Homebrew 默认的 ffmpeg 不含 libass）；Debian / Ubuntu：sudo apt install ffmpeg；Windows：安装 gyan.dev 的 full 构建',
  font: 'macOS 自带苹方（PingFang SC）；Debian / Ubuntu：sudo apt install fonts-noto-cjk；Windows 自带微软雅黑',
})

/** 参数或环境错误：以退出码 2 结束，与「检查不通过」区分。 */
class VideoError extends Error {}

// ============================================================================
// 运行环境路径
// ============================================================================

/** 用户缓存目录：Python 环境与 Piper 音色都放在这里，不写入 skill 目录。 */
function cacheRoot() {
  if (process.env.OPENSPEC_VIDEO_CACHE) return path.resolve(process.env.OPENSPEC_VIDEO_CACHE)
  const base = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local')
    : process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache')
  return path.join(base, 'openspec-explainer-video')
}

/** 运行环境的各个路径：venv（UV_PROJECT_ENVIRONMENT）、venv 内的 python、Piper 资源目录与音色模型。 */
function runtimePaths() {
  const cache = cacheRoot()
  const venv = path.join(cache, 'venv')
  const voice = process.env.OPENSPEC_VIDEO_PIPER_VOICE || DEFAULT_PIPER_VOICE
  const piperDir = path.join(cache, 'piper')
  return {
    cache,
    venv,
    python: process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python'),
    piperDir,
    voice,
    piperModel: path.join(piperDir, `${voice}.onnx`),
  }
}

/** 在 skill 的 uv 项目中运行命令所需的环境变量：环境建在缓存目录，不写字节码到 skill 目录。 */
const uvEnv = paths => ({ ...process.env, UV_PROJECT_ENVIRONMENT: paths.venv, PYTHONDONTWRITEBYTECODE: '1' })

/** 执行外部命令；命令不存在时 found 为 false，不抛异常。 */
function probe(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options })
  return { found: !result.error, status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

// ============================================================================
// doctor
// ============================================================================

/** Python 包的发行名：用 importlib.metadata 取版本，不导入包本身（导入 manim 要数秒）。 */
const PY_PACKAGES = ['manim', 'manim-voiceover', 'piper-tts', 'edge-tts']
const PY_VERSIONS_SCRIPT = [
  'import json, importlib.metadata as m',
  'def v(name):',
  '    try:',
  '        return m.version(name)',
  '    except m.PackageNotFoundError:',
  '        return None',
  `print(json.dumps({name: v(name) for name in ${JSON.stringify(PY_PACKAGES)}}))`,
].join('\n')

/** 选定中文字体：优先 fc-list（与 libass、Pango 使用的 fontconfig 一致），没有 fc-list 时按字体文件判断。 */
function detectFont() {
  const listed = probe('fc-list', [':lang=zh', 'family'])
  if (listed.found && listed.status === 0) {
    const families = new Set(listed.stdout.split(/\r?\n/).flatMap(line => line.split(',')).map(name => name.trim().replace(/\\/g, '')))
    return CJK_FONTS.find(name => families.has(name)) || null
  }
  return CJK_FONTS.find(name => (CJK_FONT_FILES[name] || []).some(file => existsSync(file))) || null
}

/** 检查项构造：缺失与告警项附安装指引或修复方法。 */
const check = (id, status, detail, extra = {}) => ({ id, status, detail, ...extra })

/**
 * Python 环境与依赖包检查：环境不存在时不调用 uv（uv run / uv sync 会创建环境，doctor 不得安装）。
 * @returns {object[]} python-env、manim、manim-voiceover、tts-engine 四项。
 */
function checkPython(paths, tts) {
  const sync = `UV_PROJECT_ENVIRONMENT="${paths.venv}" uv sync --frozen --project "${PYTHON_DIR}"（首次 render 也会自动创建）`
  const enginePackage = tts === 'edge' ? 'edge-tts' : 'piper-tts'
  const ids = [['manim', 'manim'], ['manim-voiceover', 'manim-voiceover'], ['tts-engine', enginePackage]]
  if (!existsSync(paths.python)) {
    return [
      check('python-env', STATUS.MISSING, `Python 环境不存在：${paths.venv}`, { install: sync }),
      ...ids.map(([id, name]) => check(id, STATUS.MISSING, `${name} 未安装（Python 环境不存在）`, { install: sync })),
    ]
  }
  const result = probe(paths.python, ['-c', PY_VERSIONS_SCRIPT])
  let versions = {}
  try {
    versions = JSON.parse(result.stdout.trim().split(/\r?\n/).pop() || '{}')
  } catch {
    versions = {}
  }
  return [
    check('python-env', STATUS.OK, paths.venv),
    ...ids.map(([id, name]) => (versions[name]
      ? check(id, STATUS.OK, `${name} ${versions[name]}`)
      : check(id, STATUS.MISSING, `${name} 未安装`, { install: sync }))),
  ]
}

/** ffmpeg 与字幕滤镜检查：硬字幕依赖 libass 提供的 subtitles 滤镜。 */
function checkFfmpeg() {
  const result = probe('ffmpeg', ['-hide_banner', '-filters'])
  if (!result.found) {
    return [
      check('ffmpeg', STATUS.MISSING, '找不到 ffmpeg', { install: INSTALL.ffmpeg }),
      check('ffmpeg-subtitles', STATUS.MISSING, '找不到 ffmpeg', { install: INSTALL.ffmpeg }),
    ]
  }
  const hasFilter = /^\s*\S*\s+subtitles\s/m.test(result.stdout)
  return [
    check('ffmpeg', STATUS.OK, 'ffmpeg 可用'),
    hasFilter
      ? check('ffmpeg-subtitles', STATUS.OK, 'subtitles 滤镜可用（libass）')
      : check('ffmpeg-subtitles', STATUS.MISSING, 'ffmpeg 缺少 subtitles 滤镜（未带 libass 构建）', { install: INSTALL.ffmpeg }),
  ]
}

/** Piper 音色检查：模型与配置文件；拼音音色另查 g2pW 模型，保证合成时不联网。 */
function checkPiperVoice(paths) {
  const download = `UV_PROJECT_ENVIRONMENT="${paths.venv}" uv run --frozen --project "${PYTHON_DIR}" python -m piper.download_voices ${paths.voice} --download-dir "${paths.piperDir}"`
  const config = `${paths.piperModel}.json`
  if (!existsSync(paths.piperModel) || !existsSync(config)) {
    return [check('piper-voice', STATUS.MISSING, `Piper 音色 ${paths.voice} 缺失`, { path: paths.piperModel, install: download })]
  }
  const items = [check('piper-voice', STATUS.OK, `${paths.voice}`, { path: paths.piperModel })]
  let phonemeType = null
  try {
    phonemeType = JSON.parse(readFileSync(config, 'utf8')).phoneme_type
  } catch {
    items[0] = check('piper-voice', STATUS.MISSING, `音色配置无法解析：${config}`, { path: paths.piperModel, install: download })
  }
  if (phonemeType === PINYIN_PHONEME_TYPE) {
    const g2pw = path.join(paths.piperDir, G2PW_MODEL)
    items.push(existsSync(g2pw)
      ? check('piper-g2pw', STATUS.OK, g2pw)
      : check('piper-g2pw', STATUS.MISSING, `拼音音色需要的 g2pW 模型缺失：${g2pw}`, {
        install: `UV_PROJECT_ENVIRONMENT="${paths.venv}" uv run --frozen --project "${PYTHON_DIR}" python -c "from piper.phonemize_chinese import download_model; download_model(r'${path.dirname(g2pw)}')"`,
      }))
  }
  return items
}

/**
 * .gitignore 检查：优先用 git check-ignore 判定（支持任意等价写法）；不是 git 仓库时按行精确匹配。
 * 缺少条目只告警：是否提交由项目决定，skill 不自动修改 .gitignore。
 */
function checkGitignore(repo) {
  const warn = check('gitignore', STATUS.WARN, `项目 .gitignore 未忽略视频产物目录，请加入一行：${GITIGNORE_ENTRY}`)
  const result = probe('git', ['check-ignore', '-q', '--no-index', GITIGNORE_PROBE], { cwd: repo })
  if (result.found && result.status === 0) return check('gitignore', STATUS.OK, `已忽略 ${GITIGNORE_ENTRY}`)
  if (result.found && result.status === 1) return warn
  const file = path.join(repo, '.gitignore')
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).map(line => line.trim()) : []
  return lines.includes(GITIGNORE_ENTRY) ? check('gitignore', STATUS.OK, `已忽略 ${GITIGNORE_ENTRY}`) : warn
}

/**
 * doctor：逐项检查依赖，只输出安装指引，不安装、不创建任何文件。
 * @param {string} repo 项目根目录（检查 .gitignore）。
 * @param {string} tts 要检查的 TTS 引擎。
 * @returns {{ code: number, output: string }}
 */
function doctor(repo, tts) {
  const paths = runtimePaths()
  const uv = probe('uv', ['--version'])
  const font = detectFont()
  const checks = [
    uv.found && uv.status === 0 ? check('uv', STATUS.OK, uv.stdout.trim()) : check('uv', STATUS.MISSING, '找不到 uv', { install: INSTALL.uv }),
    ...checkPython(paths, tts),
    ...checkFfmpeg(),
    // 在线引擎没有本地音色模型。
    ...(tts === 'piper' ? checkPiperVoice(paths) : []),
    font ? check('cjk-font', STATUS.OK, font) : check('cjk-font', STATUS.MISSING, '找不到中文字体', { install: INSTALL.font }),
    checkGitignore(repo),
  ]
  const missing = checks.some(item => item.status === STATUS.MISSING)
  return { code: missing ? EXIT.BLOCKED : EXIT.PASS, output: `${JSON.stringify({ verdict: missing ? 'MISSING' : 'PASS', checks }, null, 2)}\n` }
}

// ============================================================================
// check-storyboard
// ============================================================================

/** 分镜文件与代码块标记（相对 changeRoot）。 */
const STORYBOARD_FILE = path.join('video', 'storyboard.md')
const STORYBOARD_REL = 'video/storyboard.md'
const FENCE_INFO = 'storyboard'

/** 规则编号，与 shared/storyboard.md「检查规则」表一致。 */
const RULE = Object.freeze({
  /** 格式：代码块、YAML、字段与取值。 */
  FORMAT: 'SB-1',
  /** 元素引用：图 ID、元素 ID、当前图、trace 连通。 */
  REFERENCE: 'SB-2',
  /** 估算时长上限。 */
  DURATION: 'SB-3',
  /** 旁白 STE 阻断项（调用 openspec-ste 的 ste-lint.mjs text）。 */
  NARRATION: 'SB-4',
  /** focus 非空。 */
  FOCUS: 'SB-5',
  /** 变更模型存在且检查通过。 */
  MODEL: 'SB-6',
})

/** 顶层与段落允许的键。 */
const TOP_KEYS = ['focus', 'tts', 'segments']
const SEGMENT_KEYS = ['narration', 'actions']
/** 视图取值：变更前 / 对比 / 变更后，三者共用并集布局。 */
const VIEWS = ['before', 'diff', 'after']
/** 镜头动作表：动作名 → 参数形态（map 为映射参数及其允许的键；ids 为元素 ID 列表）。 */
const ACTIONS = Object.freeze({
  show: { shape: 'map', keys: ['target', 'view'] },
  highlight: { shape: 'ids' },
  trace: { shape: 'map', keys: ['target', 'path'] },
  morph: { shape: 'map', keys: ['target', 'from', 'to'] },
  focus: { shape: 'ids' },
})
/** 会切换当前图的动作。 */
const TARGET_ACTIONS = ['show', 'trace', 'morph']

/** 时长估算：每秒 4 个字；超过 180 秒阻断（3 分钟上限）。 */
const CHARS_PER_SECOND = 4
const MAX_SECONDS = 180
/** 计入时长的字符：文字与数字；空白与标点不发音。 */
const SPOKEN_CHAR = /[\p{L}\p{N}]/gu

/** 签署行：`Storyboard Approved: <姓名> <日期> <哈希前 8 位>`；占位为空、`____` 或 `<...>`。 */
const SIGNATURE_LINE = /^\s*Storyboard Approved:\s*(.*?)\s*$/
const SIGNATURE_PLACEHOLDER = /^(?:_*|<[^>]*>)$/
const HASH_TOKEN = /^[0-9a-f]{8}$/i
const SIGNATURE = Object.freeze({ UNSIGNED: 'unsigned', SIGNED: 'signed', STALE: 'stale', INVALID: 'invalid' })

/** 围栏代码块起止行：记录围栏字符与长度，关闭行须使用同种字符且不短于开启行。 */
const FENCE = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/

/**
 * 拆分 storyboard.md：提取 `storyboard` 代码块与代码块之外的签署行。
 * @param {string} text 分镜文件内容。
 * @returns {{ blocks: { line: number, lines: string[] }[], signature: string|null }}
 *   block.line 为代码块第一行内容的行号（从 1 开始）；signature 为第一条签署行的值（未找到为 null）。
 */
function splitStoryboard(text) {
  const blocks = []
  let signature = null
  let fence = null
  text.split(/\r?\n/).forEach((raw, index) => {
    if (fence) {
      const closing = FENCE.exec(raw)
      if (closing && closing[1][0] === fence.marker[0] && closing[1].length >= fence.marker.length && !closing[2]) fence = null
      else if (fence.block) fence.block.lines.push(raw)
      return
    }
    const opening = FENCE.exec(raw)
    if (opening) {
      fence = { marker: opening[1], block: opening[2] === FENCE_INFO ? { line: index + 2, lines: [] } : null }
      if (fence.block) blocks.push(fence.block)
      return
    }
    const signed = SIGNATURE_LINE.exec(raw)
    if (signed && signature === null) signature = signed[1]
  })
  return { blocks, signature }
}

/** 代码块哈希：内容行（不含围栏行）以 `\n` 连接后的 SHA-256 前 8 位；换行风格不影响哈希。 */
const blockHash = block => createHash('sha256').update(block.lines.join('\n'), 'utf8').digest('hex').slice(0, 8)

/**
 * 签署状态：占位为未签署；最后一项须为 8 位十六进制哈希，与当前代码块一致为已签署，否则为已失效。
 * @param {string|null} value 签署行的值。
 * @param {string|null} hash 当前代码块哈希（没有代码块时为 null）。
 */
function signatureStatus(value, hash) {
  if (value === null || SIGNATURE_PLACEHOLDER.test(value)) return SIGNATURE.UNSIGNED
  const tokens = value.split(/\s+/)
  const last = tokens[tokens.length - 1]
  // 至少包含姓名、日期与哈希三项，缺项视为格式错误。
  if (tokens.length < 3 || !HASH_TOKEN.test(last)) return SIGNATURE.INVALID
  return hash && last.toLowerCase() === hash ? SIGNATURE.SIGNED : SIGNATURE.STALE
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isText = value => typeof value === 'string' && value.trim() !== ''
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 代码块的行定位：段落起始行按 `narration:` 出现顺序确定；动作中的 ID 在本段范围内按词查找。
 * 找不到时退回段落起始行或代码块起始行，保证每个检查项都有行号。
 */
function locator(block) {
  const segmentLines = []
  block.lines.forEach((raw, index) => {
    if (/^\s*(?:-\s*)?narration\s*:/.test(raw)) segmentLines.push(block.line + index)
  })
  const segmentLine = segment => segmentLines[segment - 1] || block.line
  return {
    segment: segmentLine,
    key: key => {
      const index = block.lines.findIndex(raw => new RegExp(`^${escapeRegExp(key)}\\s*:`).test(raw))
      return index >= 0 ? block.line + index : block.line
    },
    token: (segment, token) => {
      const start = segmentLine(segment)
      const end = segmentLines[segment] || block.line + block.lines.length
      const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(token)}($|[^A-Za-z0-9_-])`)
      for (let line = start; line < end; line += 1) {
        if (pattern.test(block.lines[line - block.line])) return line
      }
      return start
    },
  }
}

/** 检查项：字段与 ste-lint.mjs check 相同，另含 segment（段落序号，从 1 开始）。 */
function finding(rule, text, detail, { line = null, segment = null, path: at } = {}) {
  const item = { file: STORYBOARD_REL, line, rule, text, detail }
  if (segment !== null) item.segment = segment
  if (at) item.path = at
  return item
}

/**
 * 规则 SB-1 / SB-5：校验字段与取值，并把动作归一化为 { type, segment, ... } 供引用检查使用。
 * @returns {{ blocking: object[], actions: object[], narrations: { segment: number, text: string }[] }}
 */
function checkFormat(data, locate) {
  const blocking = []
  const actions = []
  const narrations = []
  const bad = (text, detail, line, segment, at) => blocking.push(finding(RULE.FORMAT, text, detail, { line, segment, path: at }))
  if (!isPlainObject(data)) {
    bad(FENCE_INFO, 'storyboard 代码块必须是包含 focus、tts、segments 的映射', locate.key('focus'), null, null)
    return { blocking, actions, narrations }
  }
  for (const key of Object.keys(data).filter(key => !TOP_KEYS.includes(key))) bad(key, `未知字段 ${key}（顶层只允许 ${TOP_KEYS.join('、')}）`, locate.key(key), null, key)
  if (data.focus !== undefined && data.focus !== null && typeof data.focus !== 'string') {
    bad('focus', 'focus 必须是字符串', locate.key('focus'), null, 'focus')
  } else if (!isText(data.focus)) {
    blocking.push(finding(RULE.FOCUS, 'focus', 'focus 为空：写出本视频聚焦的单一主题', { line: locate.key('focus'), path: 'focus' }))
  }
  if (data.tts !== undefined && !TTS_ENGINES.includes(data.tts)) bad('tts', `tts 取值必须是 ${TTS_ENGINES.join(' / ')}`, locate.key('tts'), null, 'tts')
  if (!Array.isArray(data.segments) || !data.segments.length) {
    bad('segments', 'segments 必须是至少 1 段的列表', locate.key('segments'), null, 'segments')
    return { blocking, actions, narrations }
  }
  data.segments.forEach((segmentData, i) => {
    const segment = i + 1
    const at = `segments[${i}]`
    const line = locate.segment(segment)
    if (!isPlainObject(segmentData)) {
      bad(at, '段落必须是包含 narration 与 actions 的映射', line, segment, at)
      return
    }
    for (const key of Object.keys(segmentData).filter(key => !SEGMENT_KEYS.includes(key))) bad(key, `未知字段 ${key}（段落只允许 ${SEGMENT_KEYS.join('、')}）`, line, segment, `${at}.${key}`)
    if (isText(segmentData.narration)) narrations.push({ segment, text: segmentData.narration })
    else bad('narration', 'narration 必须是非空字符串', line, segment, `${at}.narration`)
    if (!Array.isArray(segmentData.actions)) {
      bad('actions', 'actions 必须是列表（只播旁白时写 []）', line, segment, `${at}.actions`)
      return
    }
    segmentData.actions.forEach((action, j) => {
      const actionAt = `${at}.actions[${j}]`
      const keys = isPlainObject(action) ? Object.keys(action) : []
      if (keys.length !== 1) {
        bad(actionAt, `镜头动作必须是只有一个键的映射（${Object.keys(ACTIONS).join(' / ')}）`, line, segment, actionAt)
        return
      }
      const [type] = keys
      const spec = ACTIONS[type]
      if (!spec) {
        bad(type, `${type} 不在镜头动作表中（${Object.keys(ACTIONS).join(' / ')}）`, locate.token(segment, type), segment, `${actionAt}.${type}`)
        return
      }
      const value = action[type]
      const actionLine = locate.token(segment, type)
      const fail = detail => bad(type, detail, actionLine, segment, `${actionAt}.${type}`)
      if (spec.shape === 'ids') {
        if (!Array.isArray(value) || !value.length || !value.every(isText)) return fail(`${type} 的参数必须是非空的元素 ID 列表`)
        actions.push({ type, segment, ids: value })
        return
      }
      if (!isPlainObject(value)) return fail(`${type} 的参数必须是映射（${spec.keys.join('、')}）`)
      const unknown = Object.keys(value).filter(key => !spec.keys.includes(key))
      if (unknown.length) return fail(`${type} 的未知参数 ${unknown.join('、')}（只允许 ${spec.keys.join('、')}）`)
      if (!isText(value.target)) return fail(`${type} 缺少 target（状态机或流程 ID）`)
      if (type === 'show' && !VIEWS.includes(value.view)) return fail(`show 的 view 必须是 ${VIEWS.join(' / ')}`)
      if (type === 'trace' && (!Array.isArray(value.path) || value.path.length < 2 || !value.path.every(isText))) {
        return fail('trace 的 path 必须是至少 2 个节点 ID 的列表')
      }
      if (type === 'morph') {
        if (!VIEWS.includes(value.from) || !VIEWS.includes(value.to)) return fail(`morph 的 from 与 to 必须是 ${VIEWS.join(' / ')}`)
        if (value.from === value.to) return fail(`morph 的 from 与 to 相同（${value.from}），没有可过渡的变化`)
      }
      actions.push({ type, segment, ...value })
      return undefined
    })
  })
  return { blocking, actions, narrations }
}

/**
 * 运行变更模型布局（会先执行变更模型检查），返回布局 JSON；检查不通过或没有模型时返回 SB-6 检查项。
 * @returns {{ layout: object|null, blocking: object[] }}
 * @throws {VideoError} 找不到脚本或布局报参数、环境错误（退出码 2）。
 */
function loadLayout(changeRoot, repo, line) {
  if (!existsSync(CM_SCRIPT)) throw new VideoError(`未找到 openspec-change-overview（${CM_SCRIPT} 不存在），无法读取变更模型`)
  const result = spawnSync(process.execPath, [CM_SCRIPT, 'layout', changeRoot, '--repo', repo], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0 && result.status !== 1) {
    throw new VideoError(`变更模型布局失败（退出码 ${result.status}）：${(result.stderr || '').trim()}`)
  }
  const output = JSON.parse(result.stdout)
  if (result.status === 1) {
    const items = output.blocking.slice(0, 3).map(item => `design.md:${item.line} ${item.rule} ${item.text}`).join('；')
    return { layout: null, blocking: [finding(RULE.MODEL, 'change-model', `变更模型检查不通过（${output.blocking.length} 项阻断：${items}），先修正 design.md`, { line })] }
  }
  if (!output.machines.length && !output.flows.length) {
    return { layout: null, blocking: [finding(RULE.MODEL, 'change-model', 'design.md 没有变更模型（change-model 代码块）；讲解视频需要变更模型', { line })] }
  }
  return { layout: output, blocking: [] }
}

/**
 * 由布局 JSON 建立图索引：节点 ID、可引用的元素 ID（节点、迁移、流程连线）与连线端点。
 * 迁移改端点时布局中的旧路线 `<id>@before` 只用于绘制，不作为可引用的 ID，但参与 trace 连通判断。
 */
function diagramIndex(layout) {
  const diagrams = new Map()
  for (const [kind, list] of [['machine', layout.machines], ['flow', layout.flows]]) {
    for (const diagram of list) {
      const nodes = new Set(diagram.nodes.map(node => node.id))
      const elements = new Set([...nodes, ...diagram.edges.filter(edge => !edge.id.includes('@')).map(edge => edge.id)])
      diagrams.set(diagram.id, { kind, nodes, elements, links: new Set(diagram.edges.map(edge => `${edge.from}->${edge.to}`)) })
    }
  }
  return diagrams
}

/**
 * 规则 SB-2：按播放顺序跟踪当前图，核对图 ID、元素 ID 与 trace 连通。
 * @returns {object[]} 阻断项。
 */
function checkReferences(actions, diagrams, locate) {
  const blocking = []
  // undefined：尚无当前图；null：最近的 target 无效（已报告），后续元素不再重复报告。
  let current
  const report = (segment, text, detail) => blocking.push(finding(RULE.REFERENCE, text, detail, { line: locate.token(segment, text), segment }))
  const whereIs = id => [...diagrams].filter(([, diagram]) => diagram.elements.has(id)).map(([diagramId]) => diagramId)
  for (const action of actions) {
    if (TARGET_ACTIONS.includes(action.type)) {
      const diagram = diagrams.get(action.target)
      if (!diagram) {
        report(action.segment, action.target, `变更模型中没有图 ${action.target}（可用：${[...diagrams.keys()].join('、')}）`)
        current = null
        continue
      }
      current = action.target
      if (action.type !== 'trace') continue
      const missing = action.path.filter(id => !diagram.nodes.has(id))
      for (const id of missing) report(action.segment, id, `${id} 不是 ${action.target} 中的节点`)
      if (missing.length) continue
      for (let i = 0; i + 1 < action.path.length; i += 1) {
        const link = `${action.path[i]}->${action.path[i + 1]}`
        if (!diagram.links.has(link)) report(action.segment, link, `${action.target} 中 ${action.path[i]} 与 ${action.path[i + 1]} 之间没有迁移或连线（方向须一致）`)
      }
      continue
    }
    if (current === null) continue
    for (const id of action.ids) {
      if (current === undefined) {
        report(action.segment, id, `${action.type} 之前没有当前图：先用 show、trace 或 morph 显示一张图`)
      } else if (!diagrams.get(current).elements.has(id)) {
        const elsewhere = whereIs(id)
        report(action.segment, id, elsewhere.length
          ? `${id} 不在当前图 ${current} 中（在 ${elsewhere.join('、')} 中）；先 show 对应的图`
          : `变更模型中没有 ${id}`)
      }
    }
  }
  return blocking
}

/**
 * 规则 SB-4：每段旁白作为一个段落传给 `ste-lint.mjs text`，阻断项转为 SB-4，告警按段转发。
 * @returns {{ blocking: object[], warnings: object[], exemptions: number }}
 * @throws {VideoError} 找不到 openspec-ste，或 STE 检查报参数、环境错误（退出码 2，如 CONTEXT.md 非法）时抛出。
 */
function checkNarration(narrations, repo, locate) {
  // 与找不到 change-model.mjs 的处理一致：旁白必须通过 STE 检查，不能降级为跳过，否则含禁用别名的旁白会被签署并渲染。
  if (!existsSync(STE_SCRIPT)) throw new VideoError(`未找到 openspec-ste（${STE_SCRIPT} 不存在），无法执行 ${RULE.NARRATION} 旁白 STE 检查；先安装 openspec-ste`)
  if (!narrations.length) return { blocking: [], warnings: [], exemptions: 0 }
  // 段落之间空一行：第 i 段（从 0 开始）位于第 2i+1 行，行号可以映射回段落。
  const input = narrations.map(item => item.text.replace(/\s*\r?\n\s*/g, ' ')).join('\n\n')
  const result = spawnSync(process.execPath, [STE_SCRIPT, 'text', '--repo', repo], { input, encoding: 'utf8' })
  if (result.status !== 0 && result.status !== 1) throw new VideoError(`STE 检查失败（退出码 ${result.status}）：${(result.stderr || '').trim()}`)
  const report = JSON.parse(result.stdout)
  const toSegment = line => narrations[Math.floor((line - 1) / 2)]
  const blocking = report.blocking.map(item => {
    const { segment } = toSegment(item.line)
    const out = finding(RULE.NARRATION, item.text, `第 ${segment} 段旁白含 STE 阻断项「${item.text}」（${item.rule}）${item.replacement ? `，改用「${item.replacement}」` : ''}`,
      { line: locate.segment(segment), segment })
    if (item.replacement) out.replacement = item.replacement
    out.steRule = item.rule
    return out
  })
  const warnings = report.warnings.map(item => {
    if (item.rule === STE_ENV_RULE || !item.line) return { file: null, line: null, rule: RULE.NARRATION, text: item.text || '', detail: item.detail, steRule: item.rule }
    const { segment } = toSegment(item.line)
    const out = finding(RULE.NARRATION, item.text, `第 ${segment} 段旁白：${item.detail || item.rule}`, { line: locate.segment(segment), segment })
    if (item.replacement) out.replacement = item.replacement
    out.steRule = item.rule
    return out
  })
  return { blocking, warnings, exemptions: report.exemptions || 0 }
}

/** 规则 SB-3：按每秒 4 个字估算时长（秒，保留 1 位小数）。 */
function estimateSeconds(narrations) {
  const chars = narrations.reduce((sum, item) => sum + (item.text.match(SPOKEN_CHAR) || []).length, 0)
  return { chars, seconds: Math.round((chars / CHARS_PER_SECOND) * 10) / 10 }
}

/**
 * 读取并检查分镜（SB-1～SB-6），返回检查报告与渲染所需的数据。
 * @param {string} changeRoot 变更目录。
 * @param {string} repo 项目根目录（读取 CONTEXT.md）。
 * @returns {{ report: object, storyboard: object|null, layout: object|null }}
 *   storyboard 为解析后的代码块数据（SB-1 不通过时为 null）；layout 为并集布局（SB-6 不通过时为 null）。
 * @throws {VideoError} 分镜文件不存在、上游脚本缺失或报环境错误时抛出。
 */
function checkStoryboard(changeRoot, repo) {
  const file = path.join(changeRoot, STORYBOARD_FILE)
  if (!existsSync(file)) throw new VideoError(`分镜文件不存在：${file}`)
  const { blocks, signature } = splitStoryboard(readFileSync(file, 'utf8'))
  const result = (blocking, extra = {}) => ({
    report: { verdict: blocking.length ? 'BLOCKED' : 'PASS', blocking, warnings: extra.warnings || [], exemptions: extra.exemptions || 0,
      hash: extra.hash || null, estimatedSeconds: extra.estimatedSeconds ?? null, signature: signatureStatus(signature, extra.hash || null) },
    storyboard: extra.storyboard || null,
    layout: extra.layout || null,
  })
  if (blocks.length !== 1) {
    const detail = blocks.length ? `storyboard 代码块有 ${blocks.length} 个，只允许 1 个` : '没有 storyboard 代码块'
    return result([finding(RULE.FORMAT, FENCE_INFO, detail, { line: blocks[1] ? blocks[1].line - 1 : null })])
  }
  const [block] = blocks
  const hash = blockHash(block)
  const locate = locator(block)
  let data
  try {
    data = loadYaml(block.lines.join('\n'))
  } catch (error) {
    const line = error.mark && Number.isInteger(error.mark.line) ? block.line + error.mark.line : block.line
    return result([finding(RULE.FORMAT, FENCE_INFO, `YAML 解析失败：${error.reason || error.message}`, { line })], { hash })
  }
  const format = checkFormat(data, locate)
  const model = loadLayout(changeRoot, repo, block.line - 1)
  const formatValid = !format.blocking.some(item => item.rule === RULE.FORMAT)
  // 分镜结构或变更模型不可信时不核对元素 ID，避免连带报告。
  const references = formatValid && model.layout ? checkReferences(format.actions, diagramIndex(model.layout), locate) : []
  const { chars, seconds } = estimateSeconds(format.narrations)
  const duration = seconds > MAX_SECONDS
    ? [finding(RULE.DURATION, String(seconds), `估算时长 ${seconds} 秒，超过 ${MAX_SECONDS} 秒上限（旁白共 ${chars} 个字，按每秒 ${CHARS_PER_SECOND} 个估算）；删减旁白，一个视频只讲一个主题`, { line: block.line })]
    : []
  const narration = checkNarration(format.narrations, repo, locate)
  const blocking = [...model.blocking, ...format.blocking, ...references, ...duration, ...narration.blocking]
  return result(blocking, {
    warnings: narration.warnings, exemptions: narration.exemptions, hash, estimatedSeconds: seconds,
    storyboard: formatValid ? data : null, layout: model.layout,
  })
}

/** 解析 `<changeRoot>` 与 `--repo`；repo 缺省为 changeRoot 的上三级（`<repo>/openspec/changes/<name>`）。 */
function resolveChange(changeRootArg, repoOption) {
  if (!changeRootArg || changeRootArg.startsWith('--')) throw new VideoError(USAGE)
  const changeRoot = path.resolve(changeRootArg)
  if (!existsSync(changeRoot) || !statSync(changeRoot).isDirectory()) throw new VideoError(`变更目录不存在：${changeRoot}`)
  return { changeRoot, repo: repoOption ? path.resolve(repoOption) : path.resolve(changeRoot, '..', '..', '..') }
}

// ============================================================================
// render
// ============================================================================

/** 产物位置（相对 changeRoot）：音频、视频与 Manim 缓存只写入 video/media/；SRT 写入 video/，随分镜提交。 */
const MEDIA_DIR = path.join('video', 'media')
const SRT_FILE = path.join('video', 'explainer.srt')
const OUTPUT_NAME = 'explainer'
/** 场景运行器的输入文件名（写在 video/media/ 下，不进 git）。 */
const RENDER_INPUT = 'render-input.json'
/** 渲染质量 → Manim quality：low 480p15、medium 720p30（默认）、high 1080p60。 */
const QUALITIES = Object.freeze({ low: 'low_quality', medium: 'medium_quality', high: 'high_quality' })
const DEFAULT_QUALITY = 'medium'

/** 签署状态 → render 拒绝说明（spec：签署占位为空或哈希不一致时退出码 1）。 */
const SIGNATURE_REFUSAL = Object.freeze({
  [SIGNATURE.UNSIGNED]: '分镜未签署：审阅分镜与检查结果后，由人把 `Storyboard Approved: ____` 改为 `Storyboard Approved: <姓名> <日期> <哈希前 8 位>`；不开始渲染',
  [SIGNATURE.INVALID]: '签署行格式错误：应为 `Storyboard Approved: <姓名> <日期> <哈希前 8 位>`；不开始渲染',
  [SIGNATURE.STALE]: '签署后分镜已修改（签署行中的哈希与当前代码块不一致）：重新运行 check-storyboard，审阅后重新签署；不开始渲染',
})

/** render 拒绝输出：退出码 1，说明原因，不启动 Python。 */
const refuse = (reason, detail, extra = {}) => ({ code: EXIT.BLOCKED, output: `${JSON.stringify({ verdict: 'BLOCKED', reason, detail, ...extra }, null, 2)}\n` })

/**
 * render：签署校验 → 在线 TTS 校验 → 分镜检查（均在启动 Python 之前）→ 经 uv 运行场景运行器 → 实际时长告警。
 * @param {string} changeRoot 变更目录。
 * @param {string} repo 项目根目录。
 * @param {{ allowOnlineTts: boolean, quality: string }} options 命令行选项。
 * @returns {{ code: number, output: string }}
 * @throws {VideoError} 分镜不存在、缺少 uv / 中文字体 / 音色模型，或场景运行器失败时抛出（退出码 2）。
 */
function render(changeRoot, repo, { allowOnlineTts, quality }) {
  const file = path.join(changeRoot, STORYBOARD_FILE)
  if (!existsSync(file)) throw new VideoError(`分镜文件不存在：${file}`)
  const { blocks, signature } = splitStoryboard(readFileSync(file, 'utf8'))
  // 1. 签署：只认人工签署且哈希与当前代码块一致的分镜（没有或多于 1 个代码块时交给下面的分镜检查报告）。
  if (blocks.length === 1) {
    const hash = blockHash(blocks[0])
    const status = signatureStatus(signature, hash)
    if (status !== SIGNATURE.SIGNED) return refuse(status, SIGNATURE_REFUSAL[status], { hash })
  }
  const { report, storyboard, layout } = checkStoryboard(changeRoot, repo)
  if (report.blocking.length) return { code: EXIT.BLOCKED, output: `${JSON.stringify(report, null, 2)}\n` }
  // 2. 在线 TTS 二次确认：旁白文本（含方案内容）会发送到外部服务。
  const engine = storyboard.tts || DEFAULT_TTS
  if (ONLINE_ENGINES[engine] && !allowOnlineTts) {
    return refuse('online-tts', `分镜选择了在线 TTS 引擎 ${engine}：旁白文本将离开本机，发送到${ONLINE_ENGINES[engine]}。确认后带 --allow-online-tts 重新运行；不开始渲染`)
  }
  // 3. 运行环境：缺失项给出 doctor 指引，不自动安装。
  const paths = runtimePaths()
  const font = detectFont()
  if (!font) throw new VideoError(`找不到中文字体。${INSTALL.font}；运行 node video.mjs doctor 查看全部依赖`)
  if (engine === 'piper' && (!existsSync(paths.piperModel) || !existsSync(`${paths.piperModel}.json`))) {
    throw new VideoError(`Piper 音色模型缺失：${paths.piperModel}。运行 node video.mjs doctor 查看下载命令`)
  }
  const mediaDir = path.join(changeRoot, MEDIA_DIR)
  mkdirSync(mediaDir, { recursive: true })
  const input = path.join(mediaDir, RENDER_INPUT)
  writeFileSync(input, `${JSON.stringify({
    title: path.basename(changeRoot),
    storyboard: { ...storyboard, tts: engine },
    layout,
    font,
    quality: QUALITIES[quality],
    mediaDir,
    srtPath: path.join(changeRoot, SRT_FILE),
    outputName: OUTPUT_NAME,
    tts: { engine, piperModel: paths.piperModel, piperDataDir: paths.piperDir, edgeVoice: EDGE_VOICE },
  }, null, 2)}\n`)
  // 4. 经 uv 运行：--frozen 不更新 uv.lock；环境在用户缓存目录（首次运行时由 uv 创建）。
  const result = spawnSync('uv', ['run', '--frozen', '--project', PYTHON_DIR, 'python', path.join(PYTHON_DIR, 'explainer_scene.py'), '--input', input],
    { encoding: 'utf8', env: uvEnv(paths), maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw new VideoError(`找不到 uv（${result.error.message}）。${INSTALL.uv}；运行 node video.mjs doctor 查看全部依赖`)
  if (result.status !== 0) {
    const tail = (result.stderr || '').trim().split(/\r?\n/).slice(-20).join('\n')
    throw new VideoError(`场景运行器失败（退出码 ${result.status}）：\n${tail}`)
  }
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).pop())
  // 5. 实际时长只告警：分镜检查的估算已阻断超长分镜，配音语速差异造成的少量超出不阻断。
  const warnings = output.duration > MAX_SECONDS ? [`实际时长 ${output.duration} 秒，超过 ${MAX_SECONDS} 秒；考虑删减旁白`] : []
  const relative = target => path.relative(changeRoot, target).split(path.sep).join('/')
  const summary = { verdict: 'PASS', video: relative(output.video), srt: relative(output.srt), duration: output.duration, subtitles: output.subtitles, warnings }
  return { code: EXIT.PASS, output: `${JSON.stringify(summary, null, 2)}\n` }
}

// ============================================================================
// 命令入口
// ============================================================================

const USAGE = [
  '用法：node video.mjs doctor [--repo <dir>] [--tts piper|edge]',
  '      node video.mjs check-storyboard <changeRoot> [--repo <dir>]',
  '      node video.mjs render <changeRoot> [--repo <dir>] [--allow-online-tts] [--quality low|medium|high]',
].join('\n')

/**
 * 解析 `--name value` 形式的选项与布尔开关。
 * @param {string[]} args 参数列表。
 * @param {{ values: string[], flags: string[] }} spec 允许的取值选项与布尔开关。
 * @returns {object} 选项名 → 取值（布尔开关为 true）。
 * @throws {VideoError} 出现未知参数或取值选项缺少取值时抛出。
 */
function parseOptions(args, { values = [], flags = [] }) {
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    const name = args[i].replace(/^--/, '')
    if (args[i].startsWith('--') && flags.includes(name)) {
      options[name] = true
    } else if (args[i].startsWith('--') && values.includes(name) && i + 1 < args.length) {
      options[name] = args[i + 1]
      i += 1
    } else {
      throw new VideoError(`无法识别的参数：${args[i]}\n${USAGE}`)
    }
  }
  return options
}

/**
 * 执行子命令。
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）。
 * @returns {Promise<{ code: number, output: string }>} 退出码与标准输出内容。
 */
async function run(argv) {
  const [command, ...rest] = argv
  if (command === 'doctor') {
    const options = parseOptions(rest, { values: ['repo', 'tts'] })
    const tts = options.tts || DEFAULT_TTS
    if (!TTS_ENGINES.includes(tts)) throw new VideoError(`不支持的 TTS 引擎：${tts}（可选 ${TTS_ENGINES.join(' / ')}）`)
    return doctor(path.resolve(options.repo || process.cwd()), tts)
  }
  if (command === 'check-storyboard') {
    const [changeRootArg, ...optionArgs] = rest
    const { changeRoot, repo } = resolveChange(changeRootArg, parseOptions(optionArgs, { values: ['repo'] }).repo)
    const { report } = checkStoryboard(changeRoot, repo)
    return { code: report.blocking.length ? EXIT.BLOCKED : EXIT.PASS, output: `${JSON.stringify(report, null, 2)}\n` }
  }
  if (command === 'render') {
    const [changeRootArg, ...optionArgs] = rest
    const options = parseOptions(optionArgs, { values: ['repo', 'quality'], flags: ['allow-online-tts'] })
    const quality = options.quality || DEFAULT_QUALITY
    if (!QUALITIES[quality]) throw new VideoError(`不支持的渲染质量：${quality}（可选 ${Object.keys(QUALITIES).join(' / ')}）`)
    const { changeRoot, repo } = resolveChange(changeRootArg, options.repo)
    return render(changeRoot, repo, { allowOnlineTts: options['allow-online-tts'] === true, quality })
  }
  throw new VideoError(USAGE)
}

run(process.argv.slice(2)).then(({ code, output }) => {
  process.stdout.write(output)
  process.exitCode = code
}, error => {
  // 参数与环境错误只输出可读信息；非预期异常保留堆栈，便于定位脚本缺陷。
  process.stderr.write(`${error instanceof VideoError ? error.message : error.stack}\n`)
  process.exitCode = EXIT.ERROR
})
