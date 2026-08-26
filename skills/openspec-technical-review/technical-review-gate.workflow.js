export const meta = {
  name: 'technical-review-gate',
  description: 'OpenSpec 技术评审门禁：并行调度架构/并发/性能/数据库/安全五个专项评审 Agent，汇总为 review-summary，停在人工确认门禁（编码前，不写业务代码）',
  phases: [
    { title: 'Review', detail: '五个专项评审 Agent 并行审查已确定的技术方案' },
    { title: 'Summarize', detail: '汇总各维度风险与建议，产出门禁裁决与人工确认区' },
  ],
}

// args:
//   { change: '<change-name>' }                       全量重走：5 维度全跑（默认）
//   { change: '<name>', roles: ['security'] }          增量重走：只重跑指定维度，其余沿用上轮 review/<role>.md
//   { change: '<name>', skillDir: '/abs/path/...' }    显式指定本 skill 的安装目录，省去子 agent 自行探测
// 缺省 change 时用 demo 变更；缺省 roles 时视为全量。
const change = (args && args.change) || 'add-contact-batch-import'
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

// 解析增量重走范围：roles 未指定或为空 → 全量重走 5 维度；否则只重跑交集维度，其余沿用上轮结论。
const requested = args && Array.isArray(args.roles) ? args.roles.filter(Boolean) : null
const rerun = requested && requested.length > 0 ? ROLES.filter(r => requested.includes(r.key)) : ROLES
const reuse = ROLES.filter(r => !rerun.includes(r))
const incremental = reuse.length > 0

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['role', 'verdict', 'blockers', 'findings'],
  properties: {
    role: { type: 'string' },
    verdict: { type: 'string', enum: ['通过', '有条件通过', '打回'] },
    blockers: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'location', 'plainLanguage', 'trigger', 'impact', 'fix'],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['Blocker', 'Major', 'Minor'] },
          location: { type: 'string' },
          // 一句话白话：面向没参与设计的人，不得出现未解释的专有名词
          plainLanguage: { type: 'string' },
          // 触发场景：什么输入/时序/数据量/故障 → 出现什么可观测现象。写不出的 Blocker 一律降级 Major
          trigger: { type: 'string' },
          // 不修的后果：影响面（哪些用户/数据/接口）+ 严重度，禁止「可能有风险」这类空话
          impact: { type: 'string' },
          fix: { type: 'string' },
        },
      },
    },
  },
}

phase('Review')

if (incremental) {
  log(`增量重走：重跑 [${rerun.map(r => r.key).join(', ')}]；沿用上轮 [${reuse.map(r => r.key).join(', ')}]。`)
}

// 只对需要重跑的维度并行 fan-out。每个子 agent 自读角色准则 + 方案文档，产出结构化评审并覆写 review/<key>.md。
const reviews = await parallel(rerun.map(r => () =>
  agent(
    [
      `你是「${r.title} Agent」，在 OpenSpec 技术评审门禁（编码前）审查一个已确定但尚未实现的技术方案。`,
      `严格铁律：本阶段不写任何业务代码，只识别问题并给建议。`,
      ``,
      locateHint,
      ``,
      `第一步：读取以下三个文件，作为本次评审的准则：`,
      `  · ${SD}/roles/${r.key}.md —— 你的角色定位、审查清单、本维度闭环判据；`,
      `  · ${SD}/shared/finding-format.md —— finding 七字段、三条硬规则、维度结论取值；`,
      `  · ${SD}/shared/closed-loop-verification.md —— 上轮闭环验证规则。`,
      `第二步：读取方案文档 ${base}/proposal.md（需求澄清结论）与 ${base}/design.md（已确定方案，可能是回改后的新版）。`,
      `第三步（上轮闭环验证）：仅当 design.md 末尾存在「## 评审意见闭环记录」区块时执行，完全按 ${SD}/shared/closed-loop-verification.md 的规则处理其中「维度」属于你（${r.title}）的每一行，并结合角色文件里的「本维度闭环判据」判定。你是全新上下文，没有上轮记忆 —— 不做这一步就会重复报同一问题或漏掉验证。`,
      `第四步：围绕 ${r.focus} 逐项审查。每条 finding 含 id/severity(Blocker|Major|Minor)/location/plainLanguage/trigger/impact/fix，字段含义与硬规则以 ${SD}/shared/finding-format.md 为准 —— 特别是：写不出可复现触发场景的 Blocker 一律降级为 Major。新问题用新 ID，避免与闭环记录中的历史 ID 冲突。`,
      `第五步：把完整评审覆写到 ${base}/review/${r.key}.md（中文，Markdown），结构按 ${SD}/shared/finding-format.md 的输出骨架（上轮闭环验证（若适用）→ findings 表格 → 容量估算等你角色特有内容 → 末尾维度结论行）。`,
      `最后：返回结构化结论（role/verdict/blockers/findings）。verdict 只能是 通过|有条件通过|打回；有未闭环 Blocker（含上轮声称已闭环但实际未闭环的）时必须为 打回，并在 blockers 列出。`,
    ].join('\n'),
    { label: `review:${r.key}`, phase: 'Review', schema: REVIEW_SCHEMA }
  )
)).then(rs => rs.filter(Boolean))

phase('Summarize')

// 汇总裁决对全部 5 维度求值：重跑维度用本轮结构化结论；沿用维度由汇总人读取上轮 review/<key>.md 参与裁决。
const reuseNote = incremental
  ? `本轮为增量重走。以下维度沿用上一轮结论，请读取其 ${base}/review/<key>.md 参与裁决，并在一览表中标注「沿用上轮」：${reuse.map(r => r.key).join(', ')}。`
  : `本轮为全量重走，5 维度均为本轮最新结论。`

const summary = await agent(
  [
    `你是技术评审门禁的汇总人。`,
    reuseNote,
    `本轮重跑维度的结构化结论如下（JSON）：`,
    JSON.stringify(reviews, null, 2),
    ``,
    `裁决与留痕规则以 ${SD}/shared/gate-policy.md 为准，先读取它。`,
    `请读取 ${base}/review/*.md（含重跑与沿用维度）补充细节，产出 ${base}/review-summary.md（中文），包含：`,
    `1) 摘要（给非设计者看）：三句话说清「发现了什么 / 能不能开工 / 卡在哪」，不使用专有名词。`,
    `2) 门禁裁决：对全部 5 维度（重跑+沿用）求值，判定规则见 gate-policy.md。`,
    `3) 各维度结论一览表（维度 | 结论 | Blocker数 | Major数 | Minor数 | 本轮重跑/沿用上轮）。`,
    `4) 已确认风险：按维度+严重级别汇总。`,
    `5) 修改建议：合并去重，标注需在 design.md / tasks.md 落实的项。`,
    `6) 「有条件通过」的条件清单（条件ID | 来源维度 | 条件内容 | 对应 tasks.md 任务 | 状态）。映射不到 tasks 的条件视同 Blocker。`,
    `7) 最终设计调整：需回改 design 的点（若有）。若本轮为 BLOCKED，按 gate-policy.md 的闭环记录格式明确提示回改后必须登记每条 Blocker，下一轮评审 Agent 依赖该区块验证闭环。`,
    `8) 上轮闭环验证结果（仅当各维度 review 中存在「上轮闭环验证」小节时）：汇总哪些历史 finding 已闭环、哪些声称已闭环但实际未闭环。任何「声称已闭环但实际未闭环」的项一律按未闭环 Blocker 计入裁决。`,
    `9) 术语表：只列本次评审实际出现的专有名词 → 白话解释。这是让签字人真正读懂 Blocker 的前提。`,
    `10) 人工确认区：留一行 "Technical Review Approved: __________"（待人工填写），并注明批准前禁止 /opsx:apply。`,
    `本阶段不写业务代码。返回门禁裁决字符串（BLOCKED 或 READY_FOR_HUMAN_APPROVAL）与一句话理由。`,
  ].join('\n'),
  { label: 'summarize', phase: 'Summarize' }
)

log(`技术评审门禁完成（${incremental ? '增量重走' : '全量'}），产物：review/*.md 与 review-summary.md。请人工审阅后在 review-summary.md 写入 Technical Review Approved，再运行 /opsx:apply。`)

return { change, mode: incremental ? 'incremental' : 'full', rerun: rerun.map(r => r.key), reuse: reuse.map(r => r.key), reviews, summary }
