// src/spawnDirCleanup.ts —— 任务目录生命周期清理器（沙箱 v5 生产级：崩溃残留 C5 化 lock 的愈合）
// 场景与语义：
//   · 正常退出：lock 已被守卫删（完成信号），目录内文件 ACL 均已恢复 → 递归删即可
//   · 崩溃残留：runner 死 → 守卫不删 lock → lock 残留 C5-readonly-denyWA 化 → 路径删除被挡
//     愈合路径（R4，实测判决）：File.SetAccessControl 移除 deny + 恢复继承
//     （owner 隐式 WRITE_DAC 授予，不需特权）→ 清只读 → 递归删
//   · 幂等：全部 try，失败返回 false（下轮重试）；任务进程还在跑时不清理（调用方保证）
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
const q = (p) => `'${p.replace(/'/g, "''")}'`;
/** 恢复单个文件的 ACL（移除 deny + 恢复继承 + 清只读）——R4 路径，失败返回 false */
function restoreFileAcl(f) {
    try {
        const ps = `try { $a=Get-Acl ${q(f)}; $a.Access | Where-Object { $_.AccessControlType -eq 'Deny' } | ForEach-Object { [void]$a.RemoveAccessRule($_) }; $a.SetAccessRuleProtection($false,$false); [System.IO.File]::SetAccessControl(${q(f)}, $a); Set-ItemProperty ${q(f)} IsReadOnly $false -ErrorAction SilentlyContinue; Write-Output 'RESTORED' } catch { Write-Output 'FAIL' }`;
        const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, windowsHide: true });
        return (r.stdout?.toString('utf-8') ?? '').includes('RESTORED');
    }
    catch {
        return false;
    }
}
/**
 * 清理任务目录（生产级）：
 * ① lock 若残留（崩溃场景）：R4 恢复 ACL + 清只读
 * ② 目录内所有文件兜底恢复（防其他残留 deny）
 * ③ 递归删除
 * 返回 true = 已清理（或目录本就不存在）；false = 本次失败（可下轮重试）
 */
export function cleanupSpawnDir(spawnDir) {
    try {
        if (!fs.existsSync(spawnDir))
            return true;
        const lock = path.join(spawnDir, 'lock');
        // ① lock 残留（崩溃收养的 C5 化证据）：R4 恢复
        let lockStatOk = true;
        try {
            fs.statSync(lock);
        }
        catch {
            lockStatOk = false;
        }
        if (lockStatOk) {
            // 先尝试轻量 icacls（正常 deny WD+AD 场景），失败再走 R4（C5 化场景）
            try {
                spawnSync('icacls', [lock, '/remove:d', 'Everyone'], { windowsHide: true, timeout: 8000 });
            }
            catch { }
            try {
                spawnSync('attrib', ['-R', lock], { windowsHide: true, timeout: 8000 });
            }
            catch { }
            let stillProtected = false;
            try {
                fs.rmSync(lock, { force: true });
            }
            catch {
                stillProtected = true;
            }
            if (stillProtected) {
                if (!restoreFileAcl(lock))
                    return false; // R4 失败：本轮放弃，下轮重试
                try {
                    fs.rmSync(lock, { force: true });
                }
                catch {
                    return false;
                }
            }
        }
        // ② 其他文件兜底恢复（out.log/exit.txt 的 C5 化或 deny 残留——icacls 打不开 C5 文件时走 R4）
        for (const f of fs.readdirSync(spawnDir)) {
            const fp = path.join(spawnDir, f);
            try {
                if (fs.statSync(fp).isFile()) {
                    try {
                        spawnSync('icacls', [fp, '/remove:d', 'Everyone'], { windowsHide: true, timeout: 8000 });
                    }
                    catch { }
                    try {
                        spawnSync('attrib', ['-R', fp], { windowsHide: true, timeout: 8000 });
                    }
                    catch { }
                    // 验证是否可删（C5 化文件仍删不掉 → R4 恢复）
                    try {
                        fs.rmSync(fp, { force: true });
                    }
                    catch {
                        if (!restoreFileAcl(fp))
                            return false;
                        try {
                            fs.rmSync(fp, { force: true });
                        }
                        catch {
                            return false;
                        }
                    }
                }
            }
            catch { /* 竞态消失 */ }
        }
        // ③ 递归删除
        try {
            fs.rmSync(spawnDir, { recursive: true, force: true });
        }
        catch {
            return false;
        }
        return true;
    }
    catch {
        return false;
    }
}
