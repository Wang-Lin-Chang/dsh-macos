// dsh-macos/src/macos-utils.mjs —— 锁协议跨平台工具（macOS 版三证据）
// 进程启动时间：macOS 无 /proc——用 ps -o lstart 解析（EXP-3 PS-LSTART + 冒烟 ±5s 实测验证格式）
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }

/** 进程启动时间（epoch 秒）——ps -o lstart= -p <pid> → "Sun Aug 16 15:47:18 2026"（EXP-3 CI 实测格式）
 *  6 个捕获组：年=m[6]（曾误用 m[7] → NaN——冒烟抓出，两处同修） */
export function procStartSec(pid) {
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 8000 })
    const line = r.stdout.toString('utf-8').trim()
    const m = /^\w+\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)$/.exec(line)
    if (m === null) return undefined
    const t = new Date(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]))
    const sec = Math.floor(t.getTime() / 1000)
    return Number.isFinite(sec) && sec > 0 ? sec : undefined
  } catch { return undefined }
}

/** 进程存活（跨平台 ✓） */
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 退出码协议（对齐 Windows/Linux） */
export function writeExit(file, code) {
  try { fs.writeFileSync(file, `EXIT:${code}`) } catch {}
}
