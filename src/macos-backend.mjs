// dsh-macos/src/macos-backend.mjs —— macOS 沙箱后端（实验判决固化）
// 能力对齐（与 Windows/Linux 同级）：
//   防覆盖/防删 = chflags uchg（EXP-1 全对照组真过：+uchg 前可写可删 → +uchg 后全挡 → 恢复可写）
//   防写视图   = sandbox-exec deny file-write* subpath（EXP-1 配方 3 实测 BLOCKED + 文件完好；EXP-2/3 配方见 sandboxProfile）
//   加固       = chmod 444（EXP-1 实测同用户写 BLOCKED——macOS 独有优势）
//   防自救     = uchg 清除需 owner + 沙箱 deny（sandbox-exec 由 runner 施加，任务进程内无法解除）
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const sh = (cmd) => {
  try { return execFileSync('sh', ['-c', cmd], { timeout: 10000 }).toString().trim() } catch (e) { throw new Error(`sh fail: ${String(e.stderr ?? e.message).slice(0, 120)}`) }
}

export class MacosSandboxBackend {
  constructor(jobDir) {
    this.jobDir = jobDir
  }

  /** 应用限制（任务 spawn 前）：uchg 给 exit.txt + chmod 444 加固。
   *  时序对齐 runner/Linux 教训：out.log 不给 uchg（runner 自己写、任务靠 deny 视图防） */
  apply() {
    const targets = ['exit.txt'].map(f => path.join(this.jobDir, f))
    const results = {}
    for (const t of targets) {
      if (fs.existsSync(t)) {
        sh(`chmod 444 '${t}'`)
        sh(`chflags uchg '${t}'`)
        results[path.basename(t)] = 'immutable'
      }
    }
    return results
  }

  /** lock 专用（runner 写完 lock 后调用）——chmod 先于 uchg（uchg 会挡 chmod 元数据写） */
  applyLock() {
    const lock = path.join(this.jobDir, 'lock')
    if (fs.existsSync(lock)) { sh(`chmod 444 '${lock}'`); sh(`chflags uchg '${lock}'`) }
    return { lock: 'immutable' }
  }

  /** 自校验（fail-closed 对齐 -998 协议）：uchg 位在（out.log 不在列——它靠 deny 视图） */
  verify() {
    for (const f of ['exit.txt', 'lock'].map(x => path.join(this.jobDir, x))) {
      if (!fs.existsSync(f)) continue
      const flags = sh(`ls -lO '${f}'`)
      if (!/uchg/.test(flags)) throw new Error(`uchg missing on ${path.basename(f)}`)
    }
    return true
  }

  /** 收尾恢复（任务死后——registry 终态落盘窗口） */
  restore() {
    for (const f of ['out.log', 'exit.txt', 'lock'].map(x => path.join(this.jobDir, x))) {
      if (fs.existsSync(f)) {
        try { sh(`chflags nouchg '${f}'`); sh(`chmod 644 '${f}'`) } catch {}
      }
    }
    return true
  }

  /** sandbox-exec 包装参数（任务 spawn 用）：deny 任务目录写
   *  EXP-2/3 判决：macOS 26 隐式默认=deny，缺 (allow file-read*) 任务被 SIGKILL；
   *  (allow default) + 外科手术式 deny 对齐 bwrap 能力（网络/外写可用）。realpath 防 /tmp 符号链接失配。
   */
  static sandboxProfile(jobDir) {
    let real = jobDir
    try { real = fs.realpathSync(jobDir) } catch {}
    return `(version 1) (allow default) (deny file-write* (subpath "${real}"))`
  }

  static capability() {
    return {
      platform: 'macos',
      preventOverwrite: 'out.log = sandbox-exec deny 视图 (EXP-3 P1)；exit.txt/lock = uchg (EXP-1 对照)',
      preventDelete: 'uchg (EXP-1 verified: overwrite/unlink/rm -f all BLOCKED)',
      preventForgery: 'uchg on lock/exit.txt',
      preventSelfRescue: 'uchg requires owner; sandbox-exec deny applied outside task',
      writeView: 'sandbox-exec (allow default) + deny file-write* subpath (EXP-3 P1: IN-BLOCKED / OUT-ALLOWED / net 200 同电池)',
      processIdentity: 'ps -o lstart (EXP-3 PS-LSTART 实测 + 冒烟 ±5s 验证)',
    }
  }
}
