/** 只解析报告字段，不决定是否允许发布或归档。 */
export const GIT_TREE_FINGERPRINT = /^git-tree:([0-9a-f]{40}|[0-9a-f]{64})$/

/** 去掉值两端的反引号与加粗标记。 */
export const clean = value => value.trim().replace(/^[`*]+|[`*]+$/g, '').trim()

export const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * 逐行读取 `- Key：value` 字段，返回首个匹配行的值；没有匹配行时返回 null，有该行但值为空时返回空串。
 * 不用 readField：它的冒号后 `\s*` 会跨行，值为空时读到下一行，空的判定人会被当成「- 日期：…」。
 */
export function findLineField(lines, key) {
  const pattern = new RegExp(`^\\s*(?:[-*]\\s+)?\\**${escapeRegExp(key)}\\**[ \\t]*[:：][ \\t]*(.*)$`)
  for (const line of lines) {
    const match = pattern.exec(line)
    if (match) return clean(match[1])
  }
  return null
}

export function readVerifyFields(report, verdictKey = 'Verify-Verdict', countKey = 'Critical-Count') {
  const lines = report?.split(/\r?\n/) ?? []
  const value = findLineField(lines, 'Fingerprint')
  const verdictValue = findLineField(lines, verdictKey)
  const countValue = findLineField(lines, countKey)
  // 与现有报告兼容：结论取首个词，计数读开头的十进制整数，允许尾随说明。
  const word = verdictValue?.match(/[A-Za-z_]+/)?.[0]
  const verdict = word === 'PASS' || word === 'FAIL' ? word : null
  const digits = countValue?.match(/^\d+/)?.[0]
  return {
    fingerprint: value && GIT_TREE_FINGERPRINT.test(value) ? value : null,
    verdictValue, countValue, verdict, criticalCount: digits === undefined ? null : Number(digits),
  }
}
