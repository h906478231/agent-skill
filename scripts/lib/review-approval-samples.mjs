/**
 * review-summary.md 的签字行与裁决行样本。
 *
 * apply 前的签字 hook（skills/openspec-technical-review/hooks/check-review-approval.sh）与门禁脚本 facts 子命令
 * （skills/openspec-technical-review/scripts/implementation-gate.mjs 的 readTechnicalReview）各有一份读取实现，
 * 两份测试都从这里取样本：scripts/test-approval-hook.mjs 断言 hook 的放行与拦截，
 * scripts/test-implementation-gate.mjs 断言 facts 对同一样本给出与 hook 相同的结论。
 * 新增写法只加在这里，两边的测试一起覆盖，避免一侧补了用例、另一侧仍用旧样本（add-change-progress-view 风险 R2）。
 *
 * 每组的期望结论来自门禁规则（gate-policy.md「机器可读裁决行」与签字规则），不来自任何一份实现。
 */

/** 签字行样本，按 hook 的期望结论分组。 */
export const SIGNATURE_LINES = {
  /** 签字行仍是下划线占位：hook 拦截。 */
  placeholder: ['Technical Review Approved: __________'],
  /** 保留占位符再补括号说明、没写批准人：hook 拦截。评测里实际观察到的写法。 */
  placeholderWithNote: [
    'Technical Review Approved: __________ （签字 / 日期）',
    'Technical Review Approved: ____________________    （签名 / 日期）',
    'Technical Review Approved: ＿＿＿（签名）',
  ],
  /** 写入了批准人：hook 放行。 */
  signed: [
    'Technical Review Approved: 张三  2026-10-14',
    'Technical Review Approved: 张三（研发负责人） 2026-10-14',
  ],
}

/**
 * 中文输入法下的全角写法（hook 修复见提交 75eb718）。全角空格（U+3000）是否算空白随 locale 变化，
 * hook 测试在 C 与 UTF-8 locale 下都运行这些样本；它们同时并入 SIGNATURE_LINES 与 VERDICT_LINES 的对应分组。
 */
export const FULL_WIDTH_LINES = {
  /** 值的前后有全角空格，或值后直接接全角括号说明：仍是 BLOCKED，hook 拦截。 */
  blockedVerdict: ['Gate-Verdict: BLOCKED　（未闭环）', 'Gate-Verdict: BLOCKED（未闭环）', 'Gate-Verdict:　BLOCKED'],
  /** READY 后接全角说明：不是 BLOCKED，hook 只看签字行。 */
  readyVerdict: ['Gate-Verdict: READY_FOR_HUMAN_APPROVAL　（有条件通过）'],
  /** 签字值只有全角空格：未签字，hook 拦截。 */
  blankSignature: ['Technical Review Approved: 　', 'Technical Review Approved:　 　'],
  /** 签名中含全角空格：已签字，hook 放行。 */
  signedSignature: ['Technical Review Approved: 张三　2026-10-14'],
}

/** 裁决行样本，按 hook 的期望结论分组；测试时与 SIGNATURE_LINES.signed 中的签字行写在同一份汇总里。 */
export const VERDICT_LINES = {
  /** 裁决为 BLOCKED：即使已签字，hook 也拦截。覆盖列表、引用与加粗前缀、反引号、CR 结尾，以及值后用 ASCII 空格隔开的说明。 */
  blocked: [
    'Gate-Verdict: BLOCKED',
    '- Gate-Verdict: `BLOCKED`',
    '> Gate-Verdict: BLOCKED',
    '* **Gate-Verdict:** BLOCKED',
    'Gate-Verdict: BLOCKED\r',
    'Gate-Verdict: BLOCKED (2 个 Blocker 未闭环)',
    ...FULL_WIDTH_LINES.blockedVerdict,
    // 值后直接接其他字符：裁决值是第一个由 ASCII 字母与下划线组成的词，不按空白分词。
    'Gate-Verdict: **BLOCKED**（未闭环）',
    'Gate-Verdict: BLOCKED,未闭环',
  ],
  /** 裁决不是 BLOCKED（含没有 ASCII 词、读不出裁决值的写法）：hook 只看签字行。 */
  notBlocked: [
    'Gate-Verdict: READY_FOR_HUMAN_APPROVAL',
    '- Gate-Verdict: `READY_FOR_HUMAN_APPROVAL`',
    'Gate-Verdict: READY_FOR_HUMAN_APPROVAL (有条件通过)',
    ...FULL_WIDTH_LINES.readyVerdict,
    'Gate-Verdict: 待定',
  ],
}
