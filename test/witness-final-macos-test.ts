// dsh-macos/test/witness-final-macos-test.ts —— Witness 12 项验收 macOS 版（sandbox-exec deny 视图 + uchg）
// 对齐 Linux 版 12 项结构；D 组不传 sandbox 参数——macOS runner 默认施加 sandbox-exec（EXP-3 P1 配方）
import { WitnessJobRegistry } from '../vendor/lib/WitnessJobRegistry.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

let passed = 0, failed = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) passed++
  else { failed++; console.log(`  ❌ ${name} ${detail}`) }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'wfinal-mx-'))
let rootSeq = 0
const mkRoot = () => {
  const local = path.join(BASE, `t${rootSeq++}`)
  return { jobsRoot: path.join(local, 'jobs'), idx: path.join(local, 'index.db'), local }
}
const mkReg = (r: { jobsRoot: string; idx: string }, adoptMs = 500) =>
  new WitnessJobRegistry({ get: () => undefined, effect: () => () => {} } as never, { jobsRoot: r.jobsRoot, indexDbPath: r.idx, adoptMonitorMs: adoptMs })
const allRegs: WitnessJobRegistry[] = []
const reg = (r: { jobsRoot: string; idx: string }, adoptMs = 500) => { const x = mkReg(r, adoptMs); allRegs.push(x); return x }
const waitLock = async (jobsRoot: string, id: string): Promise<number> => {
  for (let i = 0; i < 150; i++) {
    try {
      const m = /^(\d+):(\d+)$/.exec(fs.readFileSync(path.join(jobsRoot, id, 'lock'), 'utf-8').trim())
      if (m !== null && Number(m[1]) > 0) return Number(m[1])
    } catch {}
    await sleep(200)
  }
  return 0
}
// macOS 版任务进程定位：runner 的直接子进程 = sandbox-exec（pgrep -P 三平台通用）
const taskPidOf = async (runnerPid: number): Promise<number> => {
  for (let i = 0; i < 150; i++) {
    try {
      const r = spawnSync('pgrep', ['-P', String(runnerPid)], { timeout: 8000 })
      const out = r.stdout.toString('utf-8').trim().split('\n').filter(Boolean)
      if (out.length > 0) return Number(out[0])
    } catch {}
    await sleep(200)
  }
  return 0
}

console.log('='.repeat(72))
console.log('  Witness 12 项验收 · macOS 版（sandbox-exec deny 视图 + uchg）')
console.log('='.repeat(72))

// ===== A-01 重启存活 =====
{
  const root = mkRoot()
  const r1 = reg(root)
  const id = r1.start({ kind: 'bash', label: 'a01', command: 'echo hello' } as never)
  const snap = await r1.wait(id, 60000)
  check('A-01 重启存活: 完成状态', (snap.status as string) === 'completed', String(snap.status))
  r1.close()
  const r2 = reg(root)
  const recovered = r2.get(id)
  check('A-01 重启存活: 重启后 completed', (recovered.status as string) === 'completed', String(recovered.status))
  check('A-01 重启存活: readOutput 含 hello', r2.read(id).includes('hello'), JSON.stringify(r2.read(id).slice(0, 40)))
  r2.close()
}

// ===== A-02 僵尸恢复 =====
{
  const root = mkRoot()
  const r1 = reg(root, 1000)
  const id = r1.start({ kind: 'bash', label: 'a02', command: 'sleep 120' } as never)
  const lockPid = await waitLock(root.jobsRoot, id)
  check('A-02 僵尸恢复: 任务已启动', lockPid > 0, `pid=${lockPid}`)
  const taskPid = lockPid > 0 ? await taskPidOf(lockPid) : 0
  check('A-02 僵尸恢复: 任务进程定位', taskPid > 0, `taskPid=${taskPid}`)
  try { process.kill(taskPid, 'SIGKILL') } catch {}
  const snap = await r1.wait(id, 30000)
  check('A-02 僵尸恢复: 崩溃后 failed', (snap.status as string) === 'failed', String(snap.status))
  check('A-02 僵尸恢复: 尸检报告生成', fs.existsSync(path.join(root.jobsRoot, id, 'autopsy.json')))
  r1.close()
}

// ===== A-03 输出续读 =====
{
  const root = mkRoot()
  const r1 = reg(root)
  const lines = Array.from({ length: 1000 }, (_, i) => `echo line${i + 1}`)
  const id = r1.start({ kind: 'bash', label: 'a03', command: lines.join('; ') } as never)
  await r1.wait(id, 120000)
  const part1 = r1.read(id)
  const p1Lines = part1.split(/\r?\n/).filter(l => l.startsWith('line'))
  check('A-03 输出续读: 首读 1000 行', p1Lines.length === 1000, `got ${p1Lines.length}`)
  r1.close()
  const r2 = reg(root)
  const part2 = r2.read(id)
  check('A-03 输出续读: 重启续读空', part2 === '', JSON.stringify(part2.slice(0, 40)))
  r2.close()
}

// ===== A-04 ID 不冲突 =====
{
  const root = mkRoot()
  const r1 = reg(root, 0)
  for (let i = 0; i < 10; i++) r1.start({ kind: 'bash', label: `b${i}`, run: () => ({ done: new Promise(() => {}) }) } as never)
  r1.close()
  const r2 = reg(root, 0)
  const newIds: string[] = []
  for (let i = 0; i < 5; i++) newIds.push(r2.start({ kind: 'bash', label: `n${i}`, run: () => ({ done: new Promise(() => {}) }) } as never))
  const expected = Array.from({ length: 5 }, (_, i) => `bash-${11 + i}`)
  check('A-04 ID 不冲突: bash-11..15', JSON.stringify(newIds) === JSON.stringify(expected), newIds.join(','))
  r2.close()
}

// ===== B-01 O_EXCL 竞争（50 进程） =====
{
  const root = mkRoot()
  const r1 = reg(root, 1000)
  const id = r1.start({ kind: 'bash', label: 'b01', command: 'sleep 60' } as never)
  const lockPid = await waitLock(root.jobsRoot, id)
  if (lockPid > 0) {
    const taskPid = await taskPidOf(lockPid)
    check('B-01 O_EXCL 竞争: 任务进程定位', taskPid > 0, `taskPid=${taskPid}`)
    try { process.kill(taskPid, 'SIGKILL') } catch {}
    let exitReady = false
    for (let i = 0; i < 100; i++) {
      try { if (/^EXIT:/.test(fs.readFileSync(path.join(root.jobsRoot, id, 'exit.txt'), 'utf-8'))) { exitReady = true; break } } catch {}
      await sleep(200)
    }
    check('B-01 O_EXCL 竞争: orphaned 就绪', exitReady)
    const { pathToFileURL, fileURLToPath } = await import('node:url')
    const libUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../vendor/lib/WitnessJobRegistry.js')).href
    const childScript = `const m = await import(process.argv[1]); const r = new m.WitnessJobRegistry({ effect: () => () => {} }, { jobsRoot: process.argv[2], indexDbPath: process.argv[3], adoptMonitorMs: 0 }); const s = r.get(process.argv[4]); console.log(s.status); r.close(); process.exit(0)`
    const results = await Promise.all(Array.from({ length: 50 }, () => new Promise<number>((resolve) => {
      const p = spawn(process.execPath, ['--input-type=module', '-e', childScript, libUrl, root.jobsRoot, root.idx, id])
      p.on('exit', (c) => resolve(c ?? 1))
    })))
    check('B-01 O_EXCL 竞争: 50 进程零异常', results.filter(c => c === 0).length === 50, `${results.filter(c => c === 0).length}/50`)
    check('B-01 O_EXCL 竞争: 终态唯一', fs.existsSync(path.join(root.jobsRoot, id, 'state', 'done')))
  } else {
    check('B-01 O_EXCL 竞争: 任务启动', false, 'lock 未就位')
  }
  r1.close()
}

// ===== B-02 跨会话收养 =====
{
  const root = mkRoot()
  const regA = reg(root, 0)
  const id = regA.start({ kind: 'bash', label: 'b02', command: 'sleep 120' } as never)
  const lockPid = await waitLock(root.jobsRoot, id)
  check('B-02 跨会话收养: Session A 任务启动', lockPid > 0, `pid=${lockPid}`)
  regA.close()
  const regB = reg(root, 1000)
  const snapB = regB.get(id)
  const stB = snapB.status as string
  check('B-02 跨会话收养: B 可见（adopted/running）', stB === 'adopted' || stB === 'running', stB)
  check('B-02 跨会话收养: 输出可续读', typeof regB.read(id) === 'string')
  const taskPid = await taskPidOf(lockPid)
  try { process.kill(taskPid, 'SIGKILL') } catch {}
  await sleep(3000)
  regB.close()
}

// ===== B-03 静默任务保护 =====
{
  const root = mkRoot()
  const r1 = reg(root, 500)
  const id = r1.start({ kind: 'bash', label: 'b03', command: 'sleep 30' } as never)
  await sleep(12000)
  const snap = r1.get(id)
  check('B-03 静默任务保护: 12s 仍 running', (snap.status as string) === 'running', String(snap.status))
  await r1.wait(id, 60000)
  r1.close()
}

// ===== B-04 PID 复用防护（darwin ps 分支实测点） =====
{
  const root = mkRoot()
  const r1 = reg(root, 0)
  const id = r1.start({ kind: 'bash', label: 'b04', command: 'sleep 60' } as never)
  const lockPid = await waitLock(root.jobsRoot, id)
  check('B-04 PID 复用防护: 任务启动', lockPid > 0, `pid=${lockPid}`)
  if (lockPid > 0) {
    const taskPid = await taskPidOf(lockPid)
    check('B-04 PID 复用防护: 任务进程定位', taskPid > 0, `taskPid=${taskPid}`)
    try { process.kill(taskPid, 'SIGKILL') } catch {}
    let lockGone = false
    for (let i = 0; i < 100; i++) {
      try { fs.statSync(path.join(root.jobsRoot, id, 'lock')) } catch { lockGone = true; break }
      await sleep(200)
    }
    check('B-04 PID 复用防护: runner 已释放 lock', lockGone)
    try { fs.writeFileSync(path.join(root.jobsRoot, id, 'lock'), `${process.pid}:1000`) } catch { check('B-04 伪造 lock 可写', false, 'EPERM') }
    const r2 = reg(root, 500)
    await sleep(3000)
    const snap = r2.get(id)
    check('B-04 PID 复用防护: 判定 failed（starttime 不匹配）', (snap.status as string) === 'failed', String(snap.status))
    r2.close()
  }
  r1.close()
}

// ===== C-01 事件日志完整 =====
{
  const root = mkRoot()
  const r1 = reg(root)
  const id = r1.start({ kind: 'bash', label: 'c01', command: 'echo c01-line' } as never)
  await r1.wait(id, 60000)
  const evDir = path.join(root.jobsRoot, id, 'events')
  const evs = fs.readdirSync(evDir).sort()
  const names = evs.map(f => f.replace(/^\d{4}-/, '').replace(/\.jsonl$/, ''))
  check('C-01 事件: started', names.includes('started'), names.join(','))
  check('C-01 事件: output', names.includes('output'), names.join(','))
  check('C-01 事件: done', names.includes('done'), names.join(','))
  check('C-01 事件: 顺序无断号', evs[0].startsWith('0001'), evs.join(','))
  r1.close()
}

// ===== C-02 尸检报告 =====
{
  const root = mkRoot()
  const r1 = reg(root)
  const id = r1.start({ kind: 'bash', label: 'c02', command: 'echo pre; exit 1' } as never)
  await r1.wait(id, 60000)
  const autopsyPath = path.join(root.jobsRoot, id, 'autopsy.json')
  check('C-02 尸检: autopsy.json 存在', fs.existsSync(autopsyPath))
  if (fs.existsSync(autopsyPath)) {
    const a = JSON.parse(fs.readFileSync(autopsyPath, 'utf-8'))
    check('C-02 尸检: manner_of_death', typeof a.manner_of_death === 'string' && a.manner_of_death.length > 0, a.manner_of_death)
    check('C-02 尸检: primary_evidence', Array.isArray(a.primary_evidence) && a.primary_evidence.length > 0)
    check('C-02 尸检: verdict=failed', a.verdict === 'failed', a.verdict)
    check('C-02 尸检: 死因代码 D-01~D-09', /^D-0[1-9]$/.test(a.death_code), a.death_code)
  }
  r1.close()
}

// ===== D-01 防覆盖（macOS：sandbox-exec deny 视图——runner 默认施加） =====
{
  const root = mkRoot()
  const r1 = reg(root)
  const id = r1.start({ kind: 'bash', label: 'd01', command: "echo ORIGINAL; sleep 2; echo OVERWRITE > out.log 2>/dev/null && echo OVERWROTE || echo OVERWRITE-BLOCKED" } as never)
  await r1.wait(id, 60000)
  const outFile = path.join(root.jobsRoot, id, 'out.log')
  let content = ''
  try { content = fs.readFileSync(outFile, 'utf-8') } catch {}
  check('D-01 防覆盖: out.log 未被覆盖', content.includes('ORIGINAL') && !content.includes('OVERWROTE'), JSON.stringify(content.slice(0, 80)))
  r1.close()
}

// ===== D-02 防删（macOS：sandbox-exec deny 视图 + exit.txt uchg） =====
{
  const root = mkRoot()
  const r1 = reg(root)
  const id = r1.start({ kind: 'bash', label: 'd02', command: "echo KEEP-ME; sleep 2; rm -f out.log 2>/dev/null && echo OUT-DELETED || echo OUT-PROTECTED; rm -f exit.txt 2>/dev/null && echo EXIT-DELETED || echo EXIT-PROTECTED" } as never)
  await r1.wait(id, 60000)
  const outFile = path.join(root.jobsRoot, id, 'out.log')
  let statOk = true
  try { fs.statSync(outFile) } catch { statOk = false }
  check('D-02 防删: out.log 仍存在', statOk)
  if (statOk) check('D-02 防删: 内容完好', fs.readFileSync(outFile, 'utf-8').includes('KEEP-ME'))
  r1.close()
}

console.log('='.repeat(72))
console.log(`  最终报告: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`)
console.log(`  通过率: ${(passed / (passed + failed) * 100).toFixed(1)}%`)
console.log('='.repeat(72))
for (const r of allRegs) { try { r.close() } catch {} }
try { fs.rmSync(BASE, { recursive: true, force: true }) } catch {}
process.exit(failed > 0 ? 1 : 0)
