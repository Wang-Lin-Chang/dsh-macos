import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupSpawnDir } from './spawnDirCleanup.js';
// 沙箱 v3 实测：runner 活动期间（守卫 GENERIC_ALL 句柄 + C5 deny 组合），Node 25 的 fs.existsSync
// （Windows 走 GetFileAttributesExW）对任务目录内文件误报 false，而 statSync（CreateFile 路径）可靠——
// Witness 观测以 statSync 为准，existsSync 一律替换（实测铁证：existsSync=false 时 lstat/stat 均 ok）
const existsOk = (p) => {
    try {
        fs.statSync(p);
        return true;
    }
    catch {
        return false;
    }
};
// 沙箱 v3：deny 生效瞬间对已开句柄/新建打开的瞬时 EPERM 存在竞态窗口——观测读一律重试（瞬时拒绝 ≠ 真相）
const readOk = (p) => {
    for (let i = 0; i < 5; i++) {
        try {
            return fs.readFileSync(p, 'utf-8');
        }
        catch {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
    }
    return undefined;
};
const STATE_DIRS = ['running', 'stopping', 'orphaned', 'adopted', 'done'];
export class WitnessJobRegistry {
    jobsRoot;
    db;
    selfCtx;
    stopped = false;
    timers = [];
    constructor(ctx, config = {}) {
        this.selfCtx = ctx;
        this.jobsRoot = config.jobsRoot ?? './data/witness-jobs';
        fs.mkdirSync(this.jobsRoot, { recursive: true });
        const dbPath = config.indexDbPath ?? './data/witness-index.db';
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_index (
        id TEXT PRIMARY KEY,
        dir_path TEXT NOT NULL,
        cached_state TEXT NOT NULL,
        dir_mtime_ms INTEGER NOT NULL,
        last_scan_at INTEGER NOT NULL,
        out_cursor INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS job_seq (kind TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0);
    `);
        this.recover(); // Day 2：重启收养判定（三证据）
        const monitorMs = config.adoptMonitorMs ?? 30000;
        if (monitorMs > 0)
            this.timers.push(setInterval(() => { try {
                this.adoptMonitor();
            }
            catch { } }, monitorMs));
        ctx.effect(() => () => { this.stopped = true; for (const t of this.timers)
            clearInterval(t); try {
            this.db.close();
        }
        catch { } }, 'witness teardown');
    }
    // ---------------- Day 2：重启恢复（收养链路） ----------------
    /** 扫描任务目录：running/adopted 态 → 三证据判定 → pid 活 = 收养保持；pid 死 = 读 exit 落 done */
    recover() {
        for (const f of fs.readdirSync(this.jobsRoot)) {
            const d = path.join(this.jobsRoot, f);
            if (!fs.statSync(d).isDirectory())
                continue;
            const obs = this.observe(f);
            if (obs.state === 'done' || obs.state === 'absent')
                continue;
            if (obs.state === 'running' || obs.state === 'adopted' || obs.state === 'orphaned') {
                const lockAlive = this.lockAlive(d);
                if (lockAlive) {
                    // 收养：进程逃过父死，继续见证（标记 adopted）
                    this.markState(f, 'adopted');
                    this.event(f, 'adopted', { recoveredAt: Date.now() });
                }
                else {
                    // pid 死：读 exit 落终态
                    this.finalizeFromExit(f, d);
                }
            }
        }
    }
    /** 收养监控：周期检查 adopted/running 的 pid → 死 → 落 done；顺带清理超龄 done 目录（生产级愈合） */
    adoptMonitor() {
        if (this.stopped)
            return;
        for (const f of fs.readdirSync(this.jobsRoot)) {
            const d = path.join(this.jobsRoot, f);
            if (!fs.statSync(d).isDirectory())
                continue;
            const obs = this.observe(f);
            if (obs.state === 'done') {
                // 超龄 done 目录回收（输出可读窗口 24h；崩溃残留 C5 化 lock 由 R4 路径恢复）
                try {
                    const ageMs = Date.now() - fs.statSync(d).mtimeMs;
                    if (ageMs > 24 * 3600 * 1000)
                        cleanupSpawnDir(d);
                }
                catch { /* 下轮重试 */ }
                continue;
            }
            if (obs.state === 'running' || obs.state === 'adopted' || obs.state === 'orphaned' || obs.state === 'stopping') {
                if (!this.lockAlive(d))
                    this.finalizeFromExit(f, d);
            }
        }
    }
    /** 终态落盘：读 exit.txt（或显式退出码）→ 尸检报告 + 输出摘要事件 → state/done
     *  幂等 + 全异常吞（多进程并发收养竞争：50 个 recover 同时 finalize，胜者落盘，败者静默退出） */
    finalize(id, d, explicitCode) {
        try {
            if (existsOk(path.join(d, 'state', 'done')))
                return; // 终态已由并发胜者落盘
            let code = explicitCode;
            const exitFile = path.join(d, 'exit.txt');
            if (code === undefined) {
                code = 1;
                if (existsOk(exitFile)) {
                    const m = /^EXIT:(-?\d+)$/.exec(fs.readFileSync(exitFile, 'utf-8').trim());
                    if (m !== null)
                        code = Number(m[1]);
                }
            }
            if (code === -999) {
                // tampered 协议码（沙箱 v5 自救留痕检测）：任务篡改 lock 内容/ACL 被 runner 识破
                this.event(id, 'tampered', { at: Date.now() });
            }
            // output 事件（验收 C-01：输出摘要进事件流）
            const outFile = path.join(d, 'out.log');
            let totalBytes = 0;
            if (existsOk(outFile)) {
                try {
                    totalBytes = fs.statSync(outFile).size;
                }
                catch { }
            }
            if (totalBytes > 0)
                this.event(id, 'output', { totalBytes });
            // 尸检报告（验收 C-02：manner_of_death + primary_evidence + verdict + 死因代码 D-01~D-09）
            const evidence = [];
            if (existsOk(path.join(d, 'lock')))
                evidence.push('lock');
            if (existsOk(exitFile))
                evidence.push('exit.txt');
            if (existsOk(outFile))
                evidence.push('out.log');
            if (existsOk(path.join(d, 'state', 'running')))
                evidence.push('state/running');
            const wasStopping = existsOk(path.join(d, 'state', 'stopping'));
            let deathCode;
            let manner;
            if (code === -999) {
                deathCode = 'D-06';
                manner = 'evidence tampered by task (lock content/ACL altered)';
            }
            else if (wasStopping) {
                deathCode = 'D-03';
                manner = 'killed via stop request';
            }
            else if (code === 0) {
                deathCode = 'D-01';
                manner = 'completed normally';
            }
            else if (explicitCode === undefined && !existsOk(exitFile)) {
                deathCode = 'D-08';
                manner = 'adopted with no exit file (crash before exit write)';
            }
            else {
                deathCode = 'D-02';
                manner = 'exited non-zero';
            }
            const verdict = code === 0 ? 'completed' : code === -999 ? 'tampered' : 'failed';
            try {
                fs.writeFileSync(path.join(d, 'autopsy.json'), JSON.stringify({
                    manner_of_death: manner,
                    primary_evidence: evidence,
                    verdict,
                    death_code: deathCode,
                    exit_code: code,
                    at: Date.now(),
                }, null, 2));
            }
            catch { /* 尸检报告失败不影响终态 */ }
            this.markState(id, 'done');
            fs.writeFileSync(path.join(d, 'state', 'done'), String(code));
            this.event(id, 'done', { exitCode: code, at: Date.now() });
        }
        catch { /* 并发竞争败者：终态已由胜者落盘（markState rename 原子性保证恰好一次） */ }
    }
    finalizeFromExit(id, d) { this.finalize(id, d); }
    /** 状态标记转移：tmp + rename 原子 + 显式 touch state/ 目录（评审 4.4：防 mtime 精度竞态） */
    markState(id, state) {
        const sd = path.join(this.taskDir(id), 'state');
        // 清旧标记（done 除外——done 保留 exit 码语义）
        for (const s of STATE_DIRS) {
            if (s === state || s === 'done')
                continue;
            try {
                fs.unlinkSync(path.join(sd, s));
            }
            catch { /* 不存在 */ }
        }
        const tmp = path.join(sd, `.tmp-${id}-${state}`);
        fs.writeFileSync(tmp, '');
        try {
            fs.renameSync(tmp, path.join(sd, state));
        }
        catch {
            try {
                fs.unlinkSync(tmp);
            }
            catch { }
        } // 并发 rename 竞争：败者静默
        fs.utimesSync(sd, new Date(), new Date()); // 显式刷新 state/ 目录 mtime（缓存失效信号）
    }
    // ---------------- Day 2：输出续读（游标在账房，真相在 out.log） ----------------
    /** read：从账房游标读全部剩余（验收 A-03：重启后游标持久，续读无重复无丢失） */
    read(id) {
        const d = this.taskDir(id);
        const out = path.join(d, 'out.log');
        const size = existsOk(out) ? fs.statSync(out).size : 0;
        const row = this.db.prepare('SELECT out_cursor FROM job_index WHERE id=?').get(id);
        const cursor = row?.out_cursor ?? 0;
        if (size <= cursor)
            return '';
        const rfd = fs.openSync(out, 'r');
        try {
            const len = size - cursor;
            const buf = Buffer.allocUnsafe(len);
            let off = 0;
            while (off < len) {
                const n = fs.readSync(rfd, buf, off, len - off, cursor + off);
                if (n <= 0)
                    break;
                off += n;
            }
            this.db.prepare(`INSERT INTO job_index (id, dir_path, cached_state, dir_mtime_ms, last_scan_at, out_cursor) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET out_cursor=?`)
                .run(id, d, 'running', fs.statSync(d).mtimeMs, Date.now(), cursor + off, cursor + off);
            return buf.subarray(0, off).toString('utf-8');
        }
        finally {
            fs.closeSync(rfd);
        }
    }
    // ---------------- 账房：序号（目录扫描慢，序号由索引库计数器管） ----------------
    nextId(kind) {
        const row = this.db.prepare(`INSERT INTO job_seq (kind, count) VALUES (?,1) ON CONFLICT(kind) DO UPDATE SET count=count+1 RETURNING count`).get(kind);
        return `${kind}-${row.count}`;
    }
    // ---------------- 证人：状态 = 目录结构函数 ----------------
    taskDir(id) { return path.join(this.jobsRoot, id); }
    /** 目录观察（真相读）：state/ 目录存在性 + lock 存活 */
    observe(id) {
        const d = this.taskDir(id);
        if (!existsOk(d))
            return { state: 'absent' };
        const done = path.join(d, 'state', 'done');
        if (existsOk(done)) {
            try {
                return { state: 'done', exitCode: Number(fs.readFileSync(done, 'utf-8').trim()) || undefined };
            }
            catch {
                return { state: 'done' };
            }
        }
        const has = (s) => existsOk(path.join(d, 'state', s));
        if (has('running'))
            return { state: this.lockAlive(d) ? 'running' : 'orphaned' };
        if (has('stopping'))
            return { state: this.lockAlive(d) ? 'stopping' : 'orphaned' };
        if (has('adopted'))
            return { state: this.lockAlive(d) ? 'adopted' : 'orphaned' };
        if (has('orphaned'))
            return { state: 'orphaned' };
        return { state: 'orphaned' }; // 有目录无标记 = 孤儿（崩溃在标记创建前）
    }
    /** lock 存活判定（O_EXCL 锁内容 pid:startSec + 进程存在 + 启动时间比对） */
    lockAlive(d) {
        const lock = path.join(d, 'lock');
        if (!existsOk(lock))
            return false;
        try {
            const raw = readOk(lock);
            if (raw === undefined)
                return false;
            const m = /^(\d+):(\d+)$/.exec(raw.trim());
            if (m === null)
                return false;
            const pid = Number(m[1]);
            try {
                process.kill(pid, 0);
            }
            catch {
                return false;
            }
            const cur = this.procStartSec(pid);
            if (cur !== undefined && cur !== Number(m[2]))
                return false; // PID 复用
            return true;
        }
        catch {
            return false;
        }
    }
    procStartSec(pid) {
        if (process.platform === 'darwin') {
            // macOS：ps -o lstart= -p <pid> → "Sun Aug 16 15:47:18 2026"（CI 实测格式，EXP-3）
            // 6 个捕获组：年=m[6]（曾误用 m[7] → NaN——macOS 冒烟抓出，runner/utils 同修）
            try {
                const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
                const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 8000 });
                const m = /^\w+\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)$/.exec(r.stdout.toString('utf-8').trim());
                if (m === null)
                    return undefined;
                const t = Math.floor(new Date(Number(m[6]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime() / 1000);
                return Number.isFinite(t) && t > 0 ? t : undefined;
            }
            catch {
                return undefined;
            }
        }
        if (process.platform === 'linux') {
            // Linux：/proc/<pid>/stat 第 22 字段 + btime（EXP-6 实测验证）
            try {
                const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
                const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
                const starttime = Number(after[19]);
                const btime = Number(fs.readFileSync('/proc/stat', 'utf-8').match(/btime (\d+)/)?.[1] ?? 0);
                const t = Math.floor(btime + starttime / 100);
                return Number.isFinite(t) && t > 0 ? t : undefined;
            }
            catch {
                return undefined;
            }
        }
        // Windows：PowerShell Get-Process StartTime
        try {
            const r = spawnSync('powershell', ['-NoProfile', '-Command', `[int](Get-Date -Date (Get-Process -Id ${pid}).StartTime.ToUniversalTime() -UFormat %s)`], { timeout: 5000, windowsHide: true });
            const t = Number(r.stdout.toString('utf-8').trim());
            return Number.isFinite(t) && t > 0 ? t : undefined;
        }
        catch {
            return undefined;
        }
    }
    // ---------------- 账房：索引缓存（双失效源 mtime：任务目录=进程证据 lock/exit，state/ 子目录=状态标记） ----------------
    dirSignal(id) {
        const d = this.taskDir(id);
        const a = existsOk(d) ? fs.statSync(d).mtimeMs : 0;
        const sd = path.join(d, 'state');
        const b = existsOk(sd) ? fs.statSync(sd).mtimeMs : 0;
        return Math.max(a, b);
    }
    get(id) {
        const d = this.taskDir(id);
        const dirMtime = this.dirSignal(id);
        const cached = this.db.prepare('SELECT cached_state, dir_mtime_ms FROM job_index WHERE id=?').get(id);
        let state;
        let exitCode;
        if (cached !== undefined && cached.dir_mtime_ms === dirMtime) {
            state = cached.cached_state; // 缓存命中
        }
        else {
            const obs = this.observe(id); // 失效重扫（真相）
            state = obs.state;
            exitCode = obs.exitCode;
            this.db.prepare(`INSERT INTO job_index (id, dir_path, cached_state, dir_mtime_ms, last_scan_at) VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET cached_state=?, dir_mtime_ms=?, last_scan_at=?`)
                .run(id, d, state, dirMtime, Date.now(), state, dirMtime, Date.now());
        }
        return this.snapshotOf(id, state, exitCode);
    }
    snapshotOf(id, state, exitCode) {
        const specPath = path.join(this.taskDir(id), 'spec.json');
        let kind = 'unknown', label = '', startedAt = 0;
        try {
            const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
            kind = spec.kind;
            label = spec.label;
            startedAt = spec.startedAt;
        }
        catch { /* spec 缺失：目录已存在但规格丢失（罕见） */ }
        if (state === 'done' && exitCode === undefined) {
            // 缓存命中路径：done 的退出码直接读真相文件（不依赖传参）
            try {
                exitCode = Number(fs.readFileSync(path.join(this.taskDir(id), 'state', 'done'), 'utf-8').trim()) || 0;
            }
            catch {
                exitCode = 1;
            }
        }
        // tampered 协议（沙箱 v5 留痕检测）：exitCode=-999 → 状态显式 tampered（快照可见，非笼统 failed）
        const status = state === 'done' ? (exitCode === -999 ? 'tampered' : exitCode === 0 ? 'completed' : 'failed') : state === 'absent' ? 'failed' : state;
        return { id: id, kind: kind, label, status: status, startedAt, reported: false };
    }
    // ---------------- start：目录 + O_EXCL 锁 + detached 子进程（Day 1 检查点） ----------------
    start(spec) {
        const id = this.nextId(spec.kind);
        const d = this.taskDir(id);
        fs.mkdirSync(path.join(d, 'state'), { recursive: true });
        fs.mkdirSync(path.join(d, 'events'), { recursive: true });
        const startedAt = Date.now();
        fs.writeFileSync(path.join(d, 'spec.json'), JSON.stringify({ kind: spec.kind, label: spec.label, startedAt, outputLimitBytes: spec.outputLimitBytes ?? null }));
        // 状态标记：tmp + rename（评审 4.4：rename 必更新目录 mtime——高频竞争防御）
        const tmp = path.join(d, 'state', `.tmp-${id}-running`);
        fs.writeFileSync(tmp, '');
        fs.renameSync(tmp, path.join(d, 'state', 'running'));
        this.event(id, 'started', { kind: spec.kind, label: spec.label });
        // detached 子进程（复用 detach-runner：写 lock + 托管命令 + exit 文件）
        if (spec.command !== undefined) {
            // 跨平台 runner：Windows=ACL 沙箱版；Linux=chattr/bwrap 版；macOS=uchg/sandbox-exec 版（协议全对齐）
            const runnerName = process.platform === 'win32' ? 'detach-runner.cjs' : process.platform === 'darwin' ? 'detach-runner-macos.cjs' : 'detach-runner-linux.cjs';
            const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', runnerName);
            const outFile = path.join(d, 'out.log');
            const exitFile = path.join(d, 'exit.txt');
            const cmdB64 = Buffer.from(spec.command, 'utf-8').toString('base64');
            // Linux 沙箱模式：spec.sandbox === 'bwrap' → 任务跑在只读文件系统视图（EXP-3 验证）
            const runnerArgs = [runnerPath, d, outFile, exitFile, cmdB64];
            if (spec.sandbox === 'bwrap')
                runnerArgs.push('bwrap');
            spawn(process.execPath, runnerArgs, { detached: true, stdio: 'ignore', windowsHide: true });
        }
        else if (spec.run !== undefined) {
            // 对齐官方：run() hooks 提供 done——手动终态路径（无 command 的状态机任务）
            const hooks = spec.run();
            hooks.done.then((outcome) => {
                const code = outcome.exitCode ?? (outcome.status === 'completed' ? 0 : 1);
                this.finalize(id, d, code);
            }, () => this.finalize(id, d, 1));
        }
        this.db.prepare(`INSERT INTO job_index (id, dir_path, cached_state, dir_mtime_ms, last_scan_at) VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET cached_state=?, dir_mtime_ms=?, last_scan_at=?`)
            .run(id, d, 'running', this.dirSignal(id), Date.now(), 'running', this.dirSignal(id), Date.now());
        return id;
    }
    list() {
        const out = [];
        for (const f of fs.readdirSync(this.jobsRoot)) {
            if (fs.statSync(path.join(this.jobsRoot, f)).isDirectory())
                out.push(this.get(f));
        }
        return out;
    }
    /** wait：轮询至终态（done/tampered）或超时——验收 A-01/A-02/B-02 的等待语义 */
    async wait(id, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const snap = this.get(id);
            const st = snap.status;
            if (st === 'completed' || st === 'failed' || st === 'tampered')
                return snap;
            if (Date.now() > deadline)
                return snap; // 超时返回当前快照（调用方断言状态）
            await new Promise(r => setTimeout(r, 200));
        }
    }
    /** close：停止监控定时器（验收测试的 registry 生命周期管理——防跨测试残留扫描） */
    close() {
        this.stopped = true;
        for (const t of this.timers)
            clearInterval(t);
        this.timers = [];
        try {
            this.db.close();
        }
        catch { }
    }
    /** kill：读 lock 的 pid → 终止进程 → stopping 标记（Day 3 补全） */
    kill(id) {
        const obs = this.observe(id);
        if (obs.state === 'done' || obs.state === 'absent')
            return 'already-finished';
        const lock = path.join(this.taskDir(id), 'lock');
        if (existsOk(lock)) {
            try {
                const m = /^(\d+):(\d+)$/.exec(fs.readFileSync(lock, 'utf-8').trim());
                if (m !== null)
                    process.kill(Number(m[1]));
            }
            catch { /* 已死 */ }
        }
        this.markState(id, 'stopping');
        this.event(id, 'stopping', { at: Date.now() });
        return 'requested';
    }
    event(id, change, payload) {
        try {
            const evDir = path.join(this.taskDir(id), 'events');
            const seq = fs.readdirSync(evDir).length + 1;
            fs.writeFileSync(path.join(evDir, `${String(seq).padStart(4, '0')}-${change}.jsonl`), JSON.stringify({ seq, change, payload, at: Date.now() }));
        }
        catch { /* 事件写失败不阻断状态机（并发竞争下同名事件后写覆盖先写） */ }
    }
}
/** 插件入口：提供 'witness-jobs' 服务（单机无协调任务系统） */
export function apply(ctx, config = {}) {
    const reg = new WitnessJobRegistry(ctx, config);
    ctx.provide('witness-jobs', reg);
    return reg;
}
