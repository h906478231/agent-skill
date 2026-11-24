/** 恢复时有界等待外部命令。超时后不等待退出，不处理迟到结果。 */
import { spawn } from 'node:child_process'

export function runBounded(command, args, { timeout, maxBuffer, env = process.env }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let bytes = 0
    let finished = false
    const complete = (status, code) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (code) {
        // 本轮放弃该结果。关闭管道并解除事件循环引用，不等待对方结束。
        child.stdout.destroy()
        child.stderr.destroy()
        if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL') } catch { /* 子进程可能已退出。 */ }
        }
        child.unref()
      }
      // pid 为空表示命令没有启动，调用方据此区分「确认未发出」与超时（add-change-pause design D5）。
      resolve(code ? { status: null, stdout: '', stderr: '', error: { code }, pid: child.pid }
        : { status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    }
    const timer = setTimeout(() => complete(null, 'ETIMEDOUT'), timeout)
    const capture = target => chunk => {
      if (finished) return
      bytes += chunk.length
      if (bytes > maxBuffer) complete(null, 'ENOBUFS')
      else target.push(chunk)
    }
    child.stdout.on('data', capture(stdout))
    child.stderr.on('data', capture(stderr))
    child.once('error', error => complete(null, error.code || 'EIO'))
    child.once('close', status => complete(status))
  })
}
