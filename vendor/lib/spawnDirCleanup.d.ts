/**
 * 清理任务目录（生产级）：
 * ① lock 若残留（崩溃场景）：R4 恢复 ACL + 清只读
 * ② 目录内所有文件兜底恢复（防其他残留 deny）
 * ③ 递归删除
 * 返回 true = 已清理（或目录本就不存在）；false = 本次失败（可下轮重试）
 */
export declare function cleanupSpawnDir(spawnDir: string): boolean;
//# sourceMappingURL=spawnDirCleanup.d.ts.map