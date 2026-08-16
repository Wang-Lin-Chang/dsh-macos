// dsh-macos/src/detach-runner-macos.cjs —— macOS 任务 runner（协议全对齐 Windows/Linux）
// 沙箱：uchg（EXP-1）+ sandbox-exec deny 包装（EXP-1）+ chmod 加固
// 时序（对齐 Linux 版教训）：uchg 只给 exit.txt/lock（runner 不写）；out.log 靠 sandbox-exec deny 视图
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const [jobDir, outFile, exitFile, cmdB64] = process.argv.slice(2)
const cmd = Buffer.from(cmdB64 || '', 'base64').toString('utf-8')
const lockFile = path.join(jobDir, 'lock')
const sh = (c) => { try { return spawnSync('sh', ['-c', c], { timeout: 10000 }).stdout.toString().trim() } catch { return '' } }
const q = (f) => `'${f.replace(/'/g, "'\\''")}'`

// ---- 启动时间（ps -o lstart，macos-utils 同款公式）
// CI 实测格式（EXP-3 PS-LSTART）："Sun Aug 16 15:47:18 2026"——6 个捕获组，年=m[6]（曾误用 m[7] → NaN，冒烟抓出）
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
function startSec() {
  try {
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { timeout: 8000 })
    const m = /^\w+\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)$/.exec(r.stdout.toString('utf-8').trim())
    if (m === null) return 0
    return Math.floor(new Date(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime() / 1000)
  } catch { return 0 }
}

// ---- lock（wx 独占 + pid:startSec）----
let lockCreated = false
try {
  fs.writeFileSync(lockFile, `${process.pid}:${startSec()}`, { flag: 'wx' })
  lockCreated = true
} catch {}

// ---- 预创建 exit.txt + out fd ----
const outFd = fs.openSync(outFile, 'a')
try { fs.writeFileSync(exitFile, '', { flag: 'wx' }) } catch {}
const exitFd = fs.openSync(exitFile, 'w')   // 截断（协议文件每生命周期重写——Linux 教训）

// ---- 沙箱：uchg 给 exit.txt/lock（runner 不写）；out.log 靠 sandbox-exec deny ----
function applySandbox() {
  try {
    for (const f of [exitFile, ...(lockCreated ? [lockFile] : [])]) {
      if (fs.existsSync(f)) { sh(`chmod 444 ${q(f)}`); sh(`chflags uchg ${q(f)}`) }
    }
  } catch { return false }
  return true
}
function verifySandbox() {
  for (const f of [exitFile, ...(lockCreated ? [lockFile] : [])]) {
    if (!fs.existsSync(f)) continue
    if (!/uchg/.test(sh(`ls -lO ${q(f)}`))) return false
  }
  return true
}
function failClosed() {
  try { sh(`chflags nouchg ${q(exitFile)}`) } catch {}
  try { fs.writeSync(exitFd, 'EXIT:-998') } catch {}
  try { fs.closeSync(exitFd) } catch {}
  try { fs.closeSync(outFd) } catch {}
  process.exit(0)
}
if (!applySandbox() || !verifySandbox()) failClosed()

// ---- spawn 任务：sandbox-exec 包装（deny 任务目录写）
// 绝对路径 /bin/bash：沙箱内 PATH 清空导致 execvp('bash') 找不到（EXP-2 D 案 exit 71）
// EXP-2 A/B/C 案判决：macOS 26 上隐式默认=deny，缺 (allow file-read*) → bash 被 SIGKILL（exit=null 零输出）
// 对齐 bwrap 能力（网络可用、任务目录外可写、仅任务目录写被 deny）→ (allow default) + 外科手术式 deny
// /tmp 符号链接陷阱：deny subpath 用 realpath 后的真实路径（否则 /tmp -> /private/tmp 失配，沙箱静默失效）
let realJob = jobDir
try { realJob = fs.realpathSync(jobDir) } catch {}
const profile = `(version 1) (allow default) (deny file-write* (subpath "${realJob}"))`
const child = spawn('sandbox-exec', ['-p', profile, '/bin/bash', '-c', cmd], {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: jobDir,
})
child.stdout.on('data', (d) => { try { fs.writeSync(outFd, d) } catch {} })
child.stderr.on('data', (d) => { try { fs.writeSync(outFd, d) } catch {}; console.error('TASK-STDERR:', String(d).slice(0, 200)) })
child.on('error', (e) => {
  console.error('SPAWN-ERROR:', String(e.message ?? e).slice(0, 200))
  try { sh(`chflags nouchg ${q(exitFile)}`) } catch {}
  try { fs.writeSync(exitFd, 'EXIT:1') } catch {}
  try { fs.closeSync(exitFd) } catch {}
  try { fs.closeSync(outFd) } catch {}
  process.exit(1)
})
child.on('exit', (code) => {
  const finalCode = code ?? 1
  try { sh(`chflags nouchg ${q(exitFile)}`) } catch {}
  try { fs.writeSync(exitFd, `EXIT:${finalCode}`) } catch {}
  try { fs.closeSync(exitFd) } catch {}
  try { fs.closeSync(outFd) } catch {}
  if (lockCreated) {
    try { sh(`chflags nouchg ${q(lockFile)}`) } catch {}
    try { fs.unlinkSync(lockFile) } catch {}
  }
  process.exit(0)
})
