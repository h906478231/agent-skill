/** 门禁与调度测试共用的报告写法。预期的 Blocker 判定直接取同份报告的 `review` 输出。 */
const HEADER = '| ID | 严重级别 | 位置 | 触发场景 | 闭环状态 |'
const SEPARATOR = '|---|---|---|---|---|'
const OPEN = '| STD-02 | Blocker | src/order.js:1 | [B4] 创建订单失败 | open |'
const ACCEPTED_MINOR = '| STD-02 | Minor | src/order.js:1 | [B4] 创建订单失败 | risk-accepted |'
const STANDARDS = 'review/standards.md'
const EVIDENCE = 'evidence/slice-02.md'

const report = (table, heading = 'Findings') => [
  '# Standards Review', '', '## 评审基线', '- Rules Version: 2', '',
  `## ${heading}`, table, '', '## Finding 台账',
  '| ID | 状态 |', '|---|---|', '| STD-02 | open |', '', 'Standards Review 结论：打回', '',
].join('\n')
const table = (row = OPEN, header = HEADER, delimiter = SEPARATOR) => [header, delimiter, row].join('\n')

export const STANDARD_TRACE_REPORT = report(table())

function evidence(heading, extraRows = []) {
  return [heading, '| 登记指纹 | 原因 | 补测计划 | 负责人 | 确认人 | 日期 |', '|---|---|---|---|---|---|',
    '| @FINGERPRINT@ | 缺少 MQ | 重跑订单测试 | 开发负责人 | 测试用户 | 2026-11-19 |', ...extraRows, ''].join('\n')
}

export const GATE_TRACE_SAMPLES = [
  { name: '状态带反引号', file: STANDARDS, text: report(table(OPEN.replace('open', '`risk-accepted`'))), status: 'risk-accepted' },
  { name: '状态大写', file: STANDARDS, text: report(table(OPEN.replace('open', 'RISK-ACCEPTED'))), status: 'risk-accepted' },
  { name: '三级小标题', file: STANDARDS, text: report(`### 附录\n${table()}`), status: 'open' },
  { name: '其他二级区块', file: STANDARDS, text: report(table(), '补充发现'), status: 'open' },
  { name: '移进上轮闭环验证', file: STANDARDS, text: report(table(), '上轮闭环验证') },
  { name: '删除行尾竖线', file: STANDARDS, text: report(table(OPEN.slice(0, -1))) },
  { name: '删除分隔行', file: STANDARDS, text: report([HEADER, OPEN].join('\n')) },
  { name: '分隔行无前导竖线', file: STANDARDS, text: report(table(OPEN, HEADER, SEPARATOR.slice(1))), status: 'open' },
  { name: '同名闭环状态列', file: STANDARDS, text: report(table(`${OPEN} false-positive |`, `${HEADER} 闭环状态 |`)), status: 'false-positive' },
  { name: '改名严重级别列', file: STANDARDS, text: report(table(OPEN, HEADER.replace('严重级别', '级别'))), status: 'open', severity: '' },
  { name: '待环境补测标题中的双空格', file: EVIDENCE, text: evidence('##  待环境补测') },
  { name: '同一个登记指纹的两行', file: EVIDENCE, text: evidence('## 待环境补测', ['| @FINGERPRINT@ | 缺少 MQ | 重跑订单测试 | 开发负责人 | | 2026-11-19 |']), twoRows: true },
  { name: '大写严重级别', file: STANDARDS, text: report(table(OPEN.replace('Blocker', 'BLOCKER'))), status: 'open', severity: 'BLOCKER' },
  { name: '小写严重级别', file: STANDARDS, text: report(table(OPEN.replace('Blocker', 'blocker'))), status: 'open', severity: 'blocker' },
  { name: '同 ID 的两行互换严重级别', file: STANDARDS, text: report(table([OPEN.replace('Blocker', 'Minor'), ACCEPTED_MINOR.replace('Minor', 'Blocker')].join('\n'))),
    before: report(table([OPEN, ACCEPTED_MINOR].join('\n'))), status: 'open', severity: 'Minor' },
]
