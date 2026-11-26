/**
 * 把毫秒写成「1 分 05 秒」或「3.2 秒」。调用方：scripts/run-tests.mjs 与 scripts/run-shards.mjs 的进度显示。
 * 不足 1 分钟时保留一位小数；59.95 秒及以上按整秒进位后写成分秒，避免出现「60.0 秒」。
 * @param {number} ms 毫秒数。
 * @returns {string} 中文时长。
 */
export function formatDuration(ms) {
  if (ms < 59950) return `${(ms / 1000).toFixed(1)} 秒`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, '0')} 秒`
}
