import type { Context } from '@deepseek-ai/cordis';
import type { JobStart, JobSnapshot } from '@deepseek-ai/dsh-jobs';
export type WitnessState = 'absent' | 'running' | 'stopping' | 'orphaned' | 'adopted' | 'done';
export interface WitnessConfig {
    jobsRoot?: string;
    indexDbPath?: string;
    heartbeatMs?: number;
    adoptMonitorMs?: number;
}
export declare class WitnessJobRegistry {
    private jobsRoot;
    private db;
    private selfCtx;
    private stopped;
    private timers;
    constructor(ctx: Context, config?: WitnessConfig);
    /** 扫描任务目录：running/adopted 态 → 三证据判定 → pid 活 = 收养保持；pid 死 = 读 exit 落 done */
    private recover;
    /** 收养监控：周期检查 adopted/running 的 pid → 死 → 落 done；顺带清理超龄 done 目录（生产级愈合） */
    private adoptMonitor;
    /** 终态落盘：读 exit.txt（或显式退出码）→ 尸检报告 + 输出摘要事件 → state/done
     *  幂等 + 全异常吞（多进程并发收养竞争：50 个 recover 同时 finalize，胜者落盘，败者静默退出） */
    private finalize;
    private finalizeFromExit;
    /** 状态标记转移：tmp + rename 原子 + 显式 touch state/ 目录（评审 4.4：防 mtime 精度竞态） */
    private markState;
    /** read：从账房游标读全部剩余（验收 A-03：重启后游标持久，续读无重复无丢失） */
    read(id: string): string;
    private nextId;
    private taskDir;
    /** 目录观察（真相读）：state/ 目录存在性 + lock 存活 */
    private observe;
    /** lock 存活判定（O_EXCL 锁内容 pid:startSec + 进程存在 + 启动时间比对） */
    private lockAlive;
    private procStartSec;
    private dirSignal;
    get(id: string): JobSnapshot;
    private snapshotOf;
    start(spec: JobStart & {
        command?: string;
    }): string;
    list(): JobSnapshot[];
    /** wait：轮询至终态（done/tampered）或超时——验收 A-01/A-02/B-02 的等待语义 */
    wait(id: string, timeoutMs: number): Promise<JobSnapshot>;
    /** close：停止监控定时器（验收测试的 registry 生命周期管理——防跨测试残留扫描） */
    close(): void;
    /** kill：读 lock 的 pid → 终止进程 → stopping 标记（Day 3 补全） */
    kill(id: string): 'requested' | 'already-finished';
    private event;
}
/** 插件入口：提供 'witness-jobs' 服务（单机无协调任务系统） */
export declare function apply(ctx: Context, config?: WitnessConfig): WitnessJobRegistry;
//# sourceMappingURL=WitnessJobRegistry.d.ts.map