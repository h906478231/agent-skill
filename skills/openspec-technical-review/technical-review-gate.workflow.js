export const meta = {
  name: 'technical-review-gate',
  description: 'OpenSpec 技术评审门禁：并行调度架构/并发/性能/数据库/安全五个专项评审 Agent，汇总为 review-summary，停在人工确认门禁（编码前，不写业务代码）',
  phases: [
    { title: 'Review', detail: '五个专项评审 Agent 并行审查已确定的技术方案' },
    { title: 'Summarize', detail: '汇总各维度风险与建议，产出门禁裁决与人工确认区' },
  ],
}

// args:
//   { change: '<change-name>', level: 'L2' }           完整方案全量重走：按等级推导纳入维度，纳入维度全跑
//   { change: '<name>', level: 'L2', roles: ['security'] }
//                                                     增量重走：只重跑 roles（必须在纳入维度内），其余纳入维度沿用上轮 review/<role>.md
//   { change: '<name>', tier: 'mvp', roles: ['security', 'concurrency'] }
//                                                     MVP 且命中升级信号：roles 取 shared/gate-levels.md 映射表的结果，
//                                                     只跑这些维度并使用 MVP 评审标准，其余维度记为「不适用」而非沿用上轮
//   以上任一形态都可加 skillDir: '/abs/path/...'      显式指定本 skill 的安装目录，省去子 agent 自行探测
// changedLocations 可选：{ locations: ['design.md:85-92'], originalHashes: { <相对路径>: <原始 SHA-256> } }。
// change 必填：缺省时报错，不回落到任何默认变更（否则会把评审产物静默写进同名变更目录）。
if (!args || !args.change) {
  throw new Error("缺少必填参数 change：请传入 OpenSpec 变更名，例如 { change: 'add-ste-gate', level: 'L2' }")
}
const change = args.change
const base = `openspec/changes/${change}`

// skills 根目录随 agent 而不同（~/.claude/skills、~/.codex/skills、~/.config/opencode/skills、
// ~/.cursor/skills、~/.gemini/skills、项目级 .claude/skills、直接使用本仓时的 ./skills），
// 脚本环境没有文件系统 API，无法自己探测 —— 因此要么由调用方传入 skillDir，要么让子 agent 自行定位。
// 任何情况下都不写死单一绝对路径。
const skillDir = (args && args.skillDir) || null
const SD = skillDir || '<SKILL_DIR>'
const locateHint = skillDir
  ? `本 skill 的安装目录（下称 SKILL_DIR）为：${skillDir}`
  : [
      `先定位本 skill 的安装目录（下称 SKILL_DIR）：依次探测 $CLAUDE_PROJECT_DIR/.claude/skills、~/.claude/skills、`,
      `~/.codex/skills、~/.config/opencode/skills、~/.cursor/skills、~/.gemini/skills、./skills，`,
      `取第一个存在 openspec-technical-review/SKILL.md 的目录；都不命中则用 Glob 搜 **/openspec-technical-review/SKILL.md。`,
      `项目级优先于全局。下文所有 <SKILL_DIR> 均替换为该路径。`,
    ].join('')

// 每个专项评审角色：读取 proposal.md + design.md，按角色清单审查，写入 review/<key>.md。
// 角色提示词固化在 <SKILL_DIR>/roles/<key>.md，子 agent 需先读取该文件作为自身评审准则。
// 随 skill 安装即可跨项目复用，不依赖被评审项目的目录结构。
const ROLES = [
  { key: 'architecture', title: '架构评审', focus: '模块划分/服务边界/数据流/扩展能力/失败处理/一致性边界' },
  { key: 'concurrency', title: '并发评审', focus: '多消费者安全/MQ重复消费/幂等/锁竞争/数据一致性/状态机交错' },
  { key: 'performance', title: '性能评审', focus: 'SQL性能/N+1/大数据量/JVM压力/网络调用/缓存/容量估算(10万≤10分钟)' },
  { key: 'database', title: '数据库评审', focus: '表结构/索引/访问模式/数据增长与清理/分库分表/加密唯一键/Doris' },
  { key: 'security', title: '安全评审', focus: '权限越权(IDOR)/数据泄露脱敏/参数校验/接口限流/CSV注入/加密合规' },
]

// 完整方案的等级 → 纳入维度，与 shared/gate-levels.md 分级表一致（改动时两边同步，scripts/test-doc-consistency.mjs 会比对）。
// L0 豁免门禁，不进入本脚本。
const LEVEL_ROLES = {
  L1: ['database', 'security'],
  L2: ['architecture', 'database', 'security', 'performance'],
  L3: ['architecture', 'concurrency', 'performance', 'database', 'security'],
}

// 纳入范围由脚本推导，不交给调用方手工翻译：翻译错一次，评审范围就静默错一次。
//   MVP：纳入维度 = roles（映射表结果），其余「不适用」；
//   完整方案：纳入维度 = LEVEL_ROLES[level]，roles 只能在纳入维度内收窄为增量重走，其余「未纳入」。
if (args.roles !== undefined && !Array.isArray(args.roles)) {
  throw new Error(`roles 必须是数组，例如 ['security']，当前为 ${JSON.stringify(args.roles)}`)
}
const requested = (args.roles || []).filter(Boolean)
const unknown = requested.filter(k => !ROLES.some(r => r.key === k))
if (unknown.length > 0) {
  throw new Error(`roles 含未知维度 ${JSON.stringify(unknown)}，可选值：${ROLES.map(r => r.key).join(', ')}`)
}
// MVP 分层：未纳入的维度不适用（不是沿用上轮），见 shared/gate-levels.md「方案类型维度」。
const mvp = args.tier === 'mvp'
const level = args.level || null
if (mvp && level) {
  throw new Error(`tier: 'mvp' 不使用 L 等级，纳入维度由 roles 给出；请去掉 level（当前 ${level}）`)
}
// MVP 的维度来自 gate-levels.md 映射表；没有有效 roles 说明调用方漏传映射结果，不能静默按 5 维度全跑。
if (mvp && requested.length === 0) {
  throw new Error(`tier: 'mvp' 必须传 roles（按 gate-levels.md「信号到维度的映射表」得出的维度），当前 roles 为 ${JSON.stringify(args.roles)}`)
}
if (!mvp && level === 'L0') {
  throw new Error('L0 豁免技术评审门禁，不运行本脚本；豁免理由写在变更目录 overview.md 开头（见 shared/gate-levels.md）')
}
if (!mvp && !LEVEL_ROLES[level]) {
  throw new Error(`完整方案必须传 level（L1 / L2 / L3，按 shared/gate-levels.md 判定），当前为 ${JSON.stringify(args.level)}`)
}
const scope = mvp
  ? ROLES.filter(r => requested.includes(r.key))
  : ROLES.filter(r => LEVEL_ROLES[level].includes(r.key))
const outOfScope = mvp ? [] : requested.filter(k => !LEVEL_ROLES[level].includes(k))
if (outOfScope.length > 0) {
  throw new Error(`roles ${JSON.stringify(outOfScope)} 不在 ${level} 的纳入维度 [${LEVEL_ROLES[level].join(', ')}] 内；等级判定有变时先改 level`)
}
// 增量重走：roles 非空时只重跑这些维度；MVP 的 roles 即纳入范围，总是全跑。
const requestedRerun = !mvp && requested.length > 0 ? scope.filter(r => requested.includes(r.key)) : scope
const excluded = ROLES.filter(r => !scope.includes(r))

const FINDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'severity', 'businessImpact', 'location', 'module', 'plainLanguage', 'trigger', 'impact', 'fix'],
  properties: {
    id: { type: 'string' },
    severity: { type: 'string', enum: ['Blocker', 'Major', 'Minor'] },
    // 影响业务功能：该问题影响哪些业务功能，供产品/项目经理判断影响范围
    businessImpact: { type: 'string' },
    location: { type: 'string' },
    // 涉及代码模块：需改动的代码模块/表，供工作量评估
    module: { type: 'string' },
    // 一句话白话：面向没参与设计的人，不得出现未解释的专有名词
    plainLanguage: { type: 'string' },
    // 触发场景：什么输入/时序/数据量/故障 → 出现什么可观测现象；缺码或错码先核对，不凭格式降级
    trigger: { type: 'string' },
    // 不修的后果：影响面（哪些用户/数据/接口）+ 严重度，禁止「可能有风险」这类空话
    impact: { type: 'string' },
    // 建议修复：可直接执行的修改方向，落到文件/表/接口粒度
    fix: { type: 'string' },
    // 闭环状态：缺省视为 open（保守计入裁决）。重走门禁时按 shared/closed-loop-verification.md 的判定填 closed/risk-accepted/false-positive
    status: { type: 'string', enum: ['open', 'closed', 'risk-accepted', 'false-positive', 'deferred'] },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'verdict', 'blockers', 'findings', 'pendingTriggers', 'report', 'ledger'],
  properties: {
    role: { type: 'string' },
    verdict: { type: 'string', enum: ['通过', '有条件通过', '打回'] },
    blockers: { type: 'array', items: { type: 'string' } },
    report: { type: 'string' },
    ledger: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'status'], properties: { id: { type: 'string' }, status: FINDING_SCHEMA.properties.status } } },
    findings: { type: 'array', items: FINDING_SCHEMA },
    // 沿用完整 finding 字段，避免汇总补正代码后还要重建丢失的上下文。
    pendingTriggers: { type: 'array', items: FINDING_SCHEMA },
  },
}

phase('Review')

const keys = rs => rs.map(r => r.key).join(', ')
const mvpNote = mvp
  ? `本次评审使用 MVP 标准。必须先阅读 ${SD}/shared/mvp-review-standard.md 理解 MVP 评审原则，只报告阻断性问题，不报告 MVP 已接受的权衡。`
  : ''

// 角色与汇总共用同一份评审输入；文件读取交给子 agent，workflow 本身不访问文件系统。
const assumptionsRequired = mvp || level === 'L2' || level === 'L3'
const baseline = await agent(
  [
    locateHint,
    assumptionsRequired ? `用固定 design 正文按 ${SD}/../openspec-explore/shared/operating-assumptions.md 核对运行假设；缺失或不符时返回 assumptionsValid: false，不分发给评审角色。` : '本等级不要求检查运行假设；assumptionsValid 返回 true。',
    `按 ${SD}/shared/gate-policy.md 第 5 节，在分发前固定 ${base} 的规划内容与文件集合。`,
    `从同一份内容计算 proposal.md、design.md、tasks.md 与 specs/ 下全部文件的原始 SHA-256、任务内容 SHA-256，并取登记基线序号（空表为 0）。`,
    `只读，返回 proposal、design 的全文、planningTexts（tasks.md 及所有 specs 文件的原文）、originalHashes（相对路径到哈希）、tasksHash、registrationBase、priorReview（是否已有任一纳入维度的报告或汇总）。分发前运行 node ${SD}/scripts/review-write.mjs snapshot ${base}，将完整 JSON 输出作为字符串放入 writeSnapshot，并核对与固定规划一致。无法读取或验证时不要编造值。`,
  ].join('\n'),
  { label: 'capture-input', phase: 'Review', schema: {
    type: 'object', additionalProperties: false,
    required: ['proposal', 'design', 'planningTexts', 'originalHashes', 'tasksHash', 'registrationBase', 'priorReview', 'writeSnapshot', 'assumptionsValid'],
    properties: {
      proposal: { type: 'string', minLength: 1 },
      design: { type: 'string', minLength: 1 },
      planningTexts: { type: 'object', additionalProperties: { type: 'string' } },
      priorReview: { type: 'boolean' },
      assumptionsValid: { type: 'boolean' },
      writeSnapshot: { type: 'string', minLength: 1 },
      originalHashes: { type: 'object', additionalProperties: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
      tasksHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      registrationBase: { type: 'integer', minimum: 0 },
    },
  } }
)
const isHash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
if (!baseline?.proposal?.trim() || !baseline?.design?.trim() || !isHash(baseline.tasksHash) ||
    !Number.isSafeInteger(baseline.registrationBase) || baseline.registrationBase < 0 ||
    !['proposal.md', 'design.md', 'tasks.md'].every(path => isHash(baseline.originalHashes?.[path])) ||
    !Object.values(baseline.originalHashes).every(isHash)) {
  throw new Error('无法固定评审输入和登记基线，停止评审，不发布可签字裁决')
}
if (assumptionsRequired && baseline.assumptionsValid !== true) throw new Error('运行假设缺失或不符合要求，停止分发；先用 /opsx:update 补写')
const { proposal, design, planningTexts, priorReview, writeSnapshot, assumptionsValid: _assumptionsValid, ...inputVersion } = baseline
const { originalHashes } = inputVersion
const rangeRule = `${SD}/shared/closed-loop-verification.md「重走时的评审范围」`

// 调用方的位置只能证明属于某版输入。是否覆盖实质差异仍由主会话按旧版本逐处核对。
function matchesInput(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false
  const paths = Object.keys(originalHashes)
  return Object.keys(candidate).length === paths.length && paths.every(file => candidate[file] === originalHashes[file])
}

const coordinates = value => {
  if (typeof value !== 'string') return false
  const match = /^([^:\n]+):[1-9]\d*(?:-[1-9]\d*)?$/.exec(value)
  return Boolean(match && Object.prototype.hasOwnProperty.call(originalHashes, match[1]))
}
const supplied = args.changedLocations
const candidateLocations = matchesInput(supplied?.originalHashes) && Array.isArray(supplied.locations) && supplied.locations.every(coordinates)
  ? supplied.locations : null

let rerun = requestedRerun
let locations = []
let scopeNote = '首轮或无需限定范围：审 proposal 与 design 全文。'
if (priorReview || (!mvp && requested.length) || supplied !== undefined) {
  const check = await agent([
    locateHint,
    `只读。按 ${rangeRule} 核对重走范围。不要重新读取磁盘上的本轮规划正文。`,
    `逐维度比对其最后一次完成评审的输入，核对旧正文哈希、变化前后的完整文件集合与每处实质差异；含任务进度排除。`,
    `运行假设的旧值与当前值不同时，不论登记为措辞、范围收窄还是条件落点，都按 ${SD}/../openspec-explore/shared/operating-assumptions.md 的方向判据逐行比较旧值与新值。出现放宽、新增数量对象、含义变化、混合或无法判断，或比较结果与登记档位不一致时，返回 assumptions-changed；措辞登记的说明不以「用户选择：」开头时，返回 assumptions-changed；范围收窄或条件落点登记的说明不以「用户选择：」开头或未写触发阈值时，返回 assumptions-changed。全部符合时按登记的位置核对，不因运行假设返回 assumptions-changed。`,
    `核对当前 specs/tasks 的行为依据，缺失返回 planning-incomplete。`,
    `覆盖全部相关差异才返回 covered。存在漏登记、旧正文不可核对或无法确认范围，返回 unknown；只有能确定影响的维度才写 roles，影响不明或区块变化则全量。`,
    `定稿后只从汇总摘取位置，严禁把结论传给评审角色。定稿前可在 locations 写 design.md 的决策节编号（如 D5）或固定输入的文件:行号。`,
    `全部纳入维度：${keys(scope)}；申请重走：${keys(requestedRerun)}。`,
    `固定规划：${JSON.stringify({ 'proposal.md': proposal, 'design.md': design, ...planningTexts })}`,
    `固定版本：${JSON.stringify(inputVersion)}`,
    candidateLocations ? `调用方位置（版本匹配，仍须查覆盖）：${JSON.stringify(candidateLocations)}` : '没有可使用的调用方位置；从同一固定输入重新核对，不可核对时审全文。',
  ].join('\n'), { label: 'check-coverage', phase: 'Review', schema: {
    type: 'object', additionalProperties: false, required: ['status', 'roles', 'locations'], properties: {
      status: { type: 'string', enum: ['covered', 'unknown', 'assumptions-changed', 'planning-incomplete'] },
      roles: { type: 'array', items: { type: 'string' } },
      locations: { type: 'array', items: { type: 'string' } },
    },
  } })
  if (check?.status === 'planning-incomplete') throw new Error('规划缺少行为依据，停止评审；先用 /opsx:update 补齐规划')
  const validRoles = Array.isArray(check?.roles) && check.roles.length > 0 && check.roles.every(key => scope.some(r => r.key === key))
  const noLocations = !Array.isArray(check?.locations) || !check.locations.length || !check.locations.every(value => coordinates(value) || /^D\d+$/.test(value))
  if (check?.status !== 'assumptions-changed' && validRoles) {
    rerun = scope.filter(r => requestedRerun.includes(r) || check.roles.includes(r.key))
  } else rerun = scope
  if (check?.status === 'covered' && validRoles && !noLocations) {
    locations = check.locations
    scopeNote = '登记覆盖核对通过。按以下纯文本位置限定本轮新发现的范围：' + JSON.stringify(locations)
  } else {
    scopeNote = check?.status === 'assumptions-changed'
      ? '运行假设已变化，全部纳入维度按新假设审 proposal 与 design 全文，不沿用结论。'
      : '登记覆盖或旧输入无法核对；受影响维度审 proposal 与 design 全文，不沿用对应旧报告。'
  }
}
const reuse = scope.filter(r => !rerun.includes(r))
const incremental = reuse.length > 0

if (mvp) {
  log(`MVP 分层评审：只跑 [${keys(rerun)}]；不适用 [${keys(excluded)}]。`)
} else {
  log(`${level}：纳入 [${keys(scope)}]；本轮重跑 [${keys(rerun)}]${incremental ? `；沿用上轮 [${keys(reuse)}]` : ''}${excluded.length ? `；未纳入 [${keys(excluded)}]` : ''}。`)
}

// 只对待重跑维度分发固定的方案内容。角色准则仍由各子 agent 读取。
const reviews = await parallel(rerun.map(r => () =>
  agent(
    [
      `你是「${r.title} Agent」，在 OpenSpec 技术评审门禁（编码前）审查一个已确定但尚未实现的技术方案。`,
      `严格铁律：本阶段不写任何业务代码，只识别问题并给建议。`,
      mvpNote,
      ``,
      locateHint,
      ``,
      `第一步：读取以下三个文件，作为本次评审的准则；只读本维度上一轮 ${base}/review/${r.key}.md（存在时），不读其他维度或汇总：`,
      `  · ${SD}/roles/${r.key}.md —— 你的角色定位、审查清单、本维度闭环判据；`,
      `  · ${SD}/shared/finding-format.md —— finding 10 个字段、五条硬规则、维度结论取值；`,
      `  · ${SD}/shared/closed-loop-verification.md —— 上轮闭环验证规则。`,
      `第二步：只使用下面传入的 proposal.md 与 design.md 正文；不重新读取磁盘上的方案。先读取「运行假设」区块（如有），用其威胁模型与规模上限判断触发场景。`,
      JSON.stringify({ 'proposal.md': proposal, 'design.md': design }),
      `第三步（上轮闭环验证）：按 ${rangeRule} 先处理上轮闭环。仅当 design.md 末尾存在「## 评审意见闭环记录」区块时执行，完全按 ${SD}/shared/closed-loop-verification.md 的规则处理其中「维度」属于你（${r.title}）的每一行，并结合角色文件里的「本维度闭环判据」判定。你是全新上下文，没有上轮记忆 —— 不做这一步就会重复报同一问题或漏掉验证。`,
      `第四步：按 ${rangeRule}。${scopeNote} 不读取该范围以外的登记结论，不读取 review-summary.md 或其他维度的报告。`,
      `围绕 ${r.focus} 逐项审查。每条 finding 含 id/severity(Blocker|Major|Minor)/location/plainLanguage/trigger/impact/fix，字段含义与硬规则以 ${SD}/shared/finding-format.md 为准。触发方式代码按硬规则 4；缺码或错码的 Blocker、Major 连同 ID、触发场景、位置和后果先放入 pendingTriggers，不先写入「建议」或「假设外观察」，也不凭格式降级。新问题用新 ID，避免与闭环记录中的历史 ID 冲突。`,
      `第五步：返回拟发布的完整 Markdown（report）、Finding 台账（ledger）和 Findings；不直接写入 ${base}/review/${r.key}.md。按 ${SD}/shared/finding-format.md 输出骨架保留台账与处理记录，前提变化用原 ID，Minor 不进台账。`,
      `最后：返回 role/verdict/blockers/findings/pendingTriggers/report/ledger。未闭环 Blocker 列入 blockers；没有待核对条目时返回空数组。`,
    ].join('\n'),
    { label: `review:${r.key}`, phase: 'Review', schema: REVIEW_SCHEMA }
  )
)).then(rs => rs.filter(Boolean))

phase('Summarize')

// 汇总裁决对全部纳入维度求值：重跑维度用本轮结构化结论；沿用维度由汇总人读取上轮 review/<key>.md 参与裁决。
// 脚本环境没有文件系统 API，无法预判沿用维度的上轮产物是否存在，因此把「不存在时怎么办」写成确定指令，
// 防止汇总人为一个从未跑过的维度编造上轮结论。
const reuseNote = mvp
  ? `本轮为 MVP 分层评审（方案类型 MVP 且命中升级信号）。以下维度不适用，不参与裁决，在一览表中标注「不适用」，理由引用 ${SD}/shared/gate-levels.md「信号到维度的映射表」中命中的信号行：${keys(excluded)}。`
  : [
      `本轮变更等级 ${level}，纳入维度：${keys(scope)}。`,
      excluded.length
        ? `以下维度不在 ${level} 的纳入范围，不参与裁决，不要读取其 review 文件，在一览表中标注「未纳入」：${keys(excluded)}。`
        : '',
      incremental
        ? `本轮为增量重走。以下纳入维度沿用上一轮结论，读取其 ${base}/review/<key>.md 参与裁决，并在一览表中标注「沿用上轮」：${keys(reuse)}。` +
          `若某个沿用维度的 review/<key>.md 不存在：不要推测、不要编造上轮结论，在一览表中标注「缺上轮产物」，` +
          `并按 ${SD}/shared/gate-policy.md 第 1 节把门禁裁决定为 BLOCKED，提示把该维度加入 roles 重跑。`
        : `本轮为全量重走，纳入维度均为本轮最新结论。`,
    ].filter(Boolean).join('\n')

const summary = await agent(
  [
    `你是技术评审门禁的汇总人。`,
    reuseNote,
    `本轮重跑维度的结构化结论如下（JSON）：`,
    JSON.stringify(reviews, null, 2),
    ``,
    `裁决与留痕规则以 ${SD}/shared/gate-policy.md 为准，先读取它。`,
    `用候选 report 和沿用报告准备汇总。逐维度按原 ID 核对历史台账、开放台账与 Findings、旧开放 Blocker 的处理依据、原发现与处理记录；不符保留旧报告并保持 BLOCKED。不得直接写汇总或角色报告。汇总项与顺序必须与 ${SD}/SKILL.md 的 Step 2 一致（共 18 项）：`,
    `1) 摘要（给非设计者看）：三句话说清「发现了什么 / 能不能开工 / 卡在哪」，不使用专有名词。`,
    `2) 业务影响地图：按业务功能分组列出 Blocker/Major/Minor 数量与主要风险。`,
    `3) 代码改动范围：按代码模块聚合改动类型与预估影响，用于工作量评估。`,
    `4) 先复核 pendingTriggers（按 finding-format.md 硬规则 4），场景成立则补正代码并按后果定级，再按范围分流；确认不成立才归入假设外观察，在疑似误报检测保留原 ID 与依据。归入假设外观察只适用于本轮新发现的待核对条目；台账已有的开放 Blocker 与 Major 不因触发场景落到收窄后的假设外而改变状态。后果足以阻断且未核实则请原维度补证，保持 BLOCKED。不保存待核对条目中间文件。误报检测另按 gate-policy.md 第 4 节处理。`,
    `5) 门禁裁决：对全部纳入维度（重跑+沿用）求值，判定规则见 gate-policy.md。未闭环 Blocker = findings 表中 severity=Blocker 且 status=open（含缺省）的项。`,
    `6) 各维度结论一览表（维度 | 结论 | Blocker数 | Major数 | Minor数 | 本轮重跑/沿用上轮/未纳入/不适用）。「假设外观察」与「建议」不计入计数、维度结论或门禁裁决，不复制到汇总。`,
    `7) 疑似误报检测：列出可能的误报、过度建议、跨维度矛盾，分「自动降级建议」与「需人工判断」两类。`,
    `8) 已确认风险详细清单：按维度+严重级别汇总，使用完整 10 字段表格（含「影响业务功能」「涉及代码模块」「闭环状态」）。`,
    `9) 待处理条件：按 gate-policy.md 第 1、5 节说明修复是否新增机制，将待选择条目交主会话；尚未决定或未写入所选修复时保持 BLOCKED。`,
    `10) 跨维度冲突清单：不同维度建议互相矛盾时列出，冲突项必须在 design.md 闭环、不得同时进入 tasks.md。`,
    `11) 条件清单按 gate-policy.md 第 1 节；对应任务或行号也接受只改规划的 <文件>:<行号>。新条件写为待处理，保存来源 finding ID、维度及原文；无落点的已处理条件仍视同 Blocker。`,
    `12) 上轮闭环验证结果（仅当各维度 review 中存在「上轮闭环验证」小节时）：汇总哪些历史 finding 已闭环、哪些声称已闭环但实际未闭环，并给出各自的 status 取值。任何「声称已闭环但实际未闭环」的项一律按未闭环 Blocker 计入裁决。`,
    `13) 术语表：只列本次评审实际出现的专有名词 → 白话解释。这是让签字人真正读懂 Blocker 的前提。`,
    `14) 分级结论：方案类型（MVP / 完整方案）+ 命中的升级信号 + 变更等级（完整方案为 L1/L2/L3，必须与本轮的 ${mvp ? 'MVP 分层' : level} 一致）或纳入维度（MVP，按映射表）+ 判定人 + 依据，规则见 ${SD}/shared/gate-levels.md。同时确保变更目录 overview.md 开头也写有这一行（还没有该文件时，创建只含文件头与分级行的最小 overview.md）——实现阶段的归档门禁从 overview.md 读等级判定双轴评审是否必需。`,
    `15) 评审输入版本：按 gate-policy.md 第 5 节转录分发时固定的原始 SHA-256、任务内容 SHA-256 与登记基线序号，不用当前值替换。输入无法确认或当前文件集合或原始哈希不一致时，裁决为 BLOCKED，不发布可签字裁决。`,
    `分发时固定的输入版本：${JSON.stringify(inputVersion)}`,
    `16) 定稿与签字后修改：覆盖汇总前先读取既有 review-summary.md（如存在）。按 gate-policy.md 第 5 节写「定稿轮：R<n>」与登记表，保留旧登记行。尚未达到定稿条件时不新写定稿轮。收窄范围或接受风险清除最后一条实质 Blocker 后，也先处理条件再定稿。运行假设放宽（含混合或方向无法判断）须保持 BLOCKED 并全量重审；措辞与用户选择的收窄不重走，方向判据见 operating-assumptions.md。`,
    `17) 收敛检查：按 gate-policy.md 第 6 节，自第 3 轮起写表，列为轮次 | 纳入维度数 | 新增 Blocker | 新增 Major | 开放 Blocker。第 1、2 轮不写此节，只在既有小节保留统计依据。`,
    `18) 人工确认区：人工确认区是最后一节，正文引用这几行时不从行首写起。不生成独立签字示例，代码块和 HTML 注释也不例外。签字说明使用普通文字，只在人工确认区保留待用户填写的签字行。按 gate-policy.md「机器可读裁决行」的格式先写 "Gate-Level: ${mvp ? 'MVP' : level}" 与 "Gate-Verdict: <READY_FOR_HUMAN_APPROVAL 或 BLOCKED，取第 5 项裁决>" 两行，再留一行 "Technical Review Approved: __________"（待人工填写），并注明批准前禁止 /opsx:apply；L3 追加一行 "复核: __________"（建议第二人复核，非必填）。`,
    `使用 ${SD}/scripts/review-write.mjs publish ${base} 通过 stdin 传 JSON：expected 为分发前固定的写入版本、roles 是全部纳入维度、reports 是本轮候选角色 Markdown、summary 是拟写入汇总。没有可核对的版本时停止，拒绝直接写。保护内复核与写入见 gate-policy.md 第 4 节；任何失败不得声称已发布或提示签字。`,
    `固定写入版本：${writeSnapshot ?? '无，停止发布'}`,
    `若本轮裁决为 BLOCKED，按 gate-policy.md 第 6 节判断是否提供收敛选项；继续修复时，明确提示回改 design.md 后须登记 Blocker 的闭环记录。只给出决策所需的信息，不替用户选择。`,
  ].join('\n'),
  { label: 'summarize', phase: 'Summarize' }
)

log(`技术评审汇总已返回（${mvp ? 'MVP 分层' : incremental ? '增量重走' : '全量'}），先确认共用写入入口成功落盘。请主会话按 SKILL.md 的 Step 3 处理开放 finding 与门禁裁决；可签字时请人工审阅并写入 Technical Review Approved，签字前不得运行 /opsx:apply。`)

return { change, level: mvp ? 'MVP' : level, mode: mvp ? 'mvp' : incremental ? 'incremental' : 'full',
  rerun: rerun.map(r => r.key), reuse: reuse.map(r => r.key), notApplicable: excluded.map(r => r.key), reviews, summary }
