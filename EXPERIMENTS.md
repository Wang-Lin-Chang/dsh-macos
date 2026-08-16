# macOS 沙箱配方实验记录（dsh-macos）

> 实验场：GitHub Actions macos-latest（macOS 26.5.2 arm64——本机无 Mac，CI 免费 runner 当实验室）
> 节奏：本地装置 + CI 实验 → 生产实装 → 反复检查 → 最后开源
> 原则：没实测不声称。本记录按 CI 原始日志逐行核对。

## 实验 1：沙箱配方能力探测（6/6 项完成——但完成 ≠ 通过，逐项看判决）

run 31953152171 原始日志判决：

| # | 配方 | 判决 |
|---|---|---|
| 1 | **uchg 不可变位** | ✅ 真过：+uchg 前可写可删 → +uchg 后覆盖/删除/rm -f 全 BLOCKED → 恢复后可写——macOS 版 chattr +i |
| 2 | **sandbox-exec 可用性** | ❌ **实际失败**：`(deny default) (allow process*)` + echo → bash 被静默杀死（stderr 全空，探测脚本打印的 ✅ 是完成标记非通过标记——记录修正）|
| 3 | **sandbox-exec deny 防写** | ✅ 真过：`(deny default) (allow process*) (allow file-read*) (deny file-write* subpath)` → 沙箱内写 BLOCKED + 文件完好 |
| 4 | **chmod 444 同用户防写** | ✅ BLOCKED——macOS 独有优势（同用户 owner 也被只读挡）|
| 5 | 环境 | macOS 26.5.2 BuildVersion 25F84 · arm64 |
| 6 | sandbox_init 符号 | 符号不可见（nm 路径问题，不关键——sandbox-exec 已够用）|

**关键差异**：配方 2（无 file-read*）死；配方 3（有 file-read*）活。

## 实验 2：为什么 bash 静默死（三次复跑）

三案同电池（run 31955090585 / 31955310772 / 31955533859，三次一致）：

| 案 | profile | 结果 |
|---|---|---|
| A | `(allow process*) (deny file-write* subpath)` | exit=**null**（信号杀死）out="" err="" |
| B | `(deny default) (allow process*)` | exit=**null** out="" err="" |
| C | `(allow process*)` | exit=**null** out="" err="" |
| D | `(version 1)` 空 | exit=71 err="sandbox-exec: execvp() of 'bash' failed: No such file or directory" |

**判决**：
1. macOS 26 sandbox-exec **不写 default 时隐式默认 = deny**（C 案全 deny → dyld 读不到 dylib → SIGKILL；D 案 execvp 的 PATH 查找被 deny → ENOENT）。
2. 缺 `(allow file-read*)` → bash/dyld 读任何文件被拒 → SIGKILL，零输出零 stderr——**这正是 runner "EXIT:1 + out 0" 的真因**（exit=null → finalCode=1）。
3. 修正旧记录："EXP-1 成功配方 `(deny default) (allow process*)`" 从未在 CI 通过过——配方 2 失败时探测脚本打印 ✅ 造成误读。

## 实验 3：profile 三案对照（候选配方 + 对照组）

run 31956682846 CI 实测判决（三案同电池：目录内写/目录外写/网络/输出/exit+signal）：

| 案 | profile | 判决 |
|---|---|---|
| **P1** | `(allow default) (deny file-write* subpath)` | ✅ **当选**：IN-WRITE-BLOCKED + OUT-WRITE-ALLOWED + 网络 200 + exit=0——**能力对齐 bwrap** |
| P2 | `(deny default) (allow process*) (allow file-read*) (deny file-write* subpath)` | 活但窄：NET-FAIL + OUT-WRITE-BLOCKED——严格全禁，弃 |
| P3 | 纯 `(allow default)` | 对照：全放行（IN-WRITE-ALLOWED）——证明挡来自 deny 规则本身，非环境巧合 |

- 隐式默认 = deny（实验 2 判决）；`(allow default)` 显式放行基线 + 外科手术 deny = macOS 版 bwrap 视图。
- PS-LSTART 实测格式："Sun Aug 16 15:47:18 2026"。

## 实验 4：冒烟 + 启动时间公式

- 冒烟（修复前）8/9：正常任务全链路（EXIT:0 + 输出捕获 + lock 删）+ 沙箱攻击 4 项全挡（stderr "Operation not permitted"）。
- ❌→✅ 启动时间公式：`lockContent="5031:NaN"`——正则 6 个捕获组，年字段误用 `m[7]`（undefined → NaN）。修 `m[6]`，runner + macos-utils 两处同修。
- 该 bug 的隐蔽性：锁协议容错（startSec 失败返回 undefined/0）吞掉了错误，直到冒烟把 lock 内容亮出来——**协议文件的"每生命周期重写 + 测试直读"是最后防线**。

## 实装（实验 3 判决后固化）

- `src/detach-runner-macos.cjs`：profile 用实验 3 判决版；`/bin/bash` 绝对路径；jobDir 走 `fs.realpathSync`（/tmp → /private/tmp 符号链接陷阱，失配则沙箱静默失效）；uchg 时序对齐 Linux 教训（只给 exit.txt/lock，out.log 靠 deny 视图）；exit 回调先 nouchg 再写 EXIT。
- 冒烟装置（lab/，不入库）：正常任务全链路 + 沙箱攻击 4 项 + 启动时间公式（轮询 lock，避开退出即删的竞态）。

## 待做

- [x] macos-backend.mjs / detach-runner-macos.cjs / 冒烟（实验 3 P1 配方固化）
- [x] 进程启动时间（ps -o lstart 公式，CI 实测 + m[6] 年字段修正）
- [x] vendor darwin 分支（WitnessJobRegistry procStartSec/runner 选择）+ vendor 自包含副本
- [x] 工程化包装（README/LICENSE/SECURITY/CONTRIBUTING/THIRD_PARTY/.gitignore/ci.yml/package.json）
- [x] 12 项验收 macOS 版 CI 全绿（34/34 ×3 连跑稳定——与 Linux 版同分）
- [x] 终检（缺失/笔误/实验记录一致性——applyLock 顺序修正 + capability 自述对齐 EXP-3 P1）
- [x] 发布：github.com/Wang-Lin-Chang/dsh-macos 公开 + v0.1.0 tag（2026-08-16，CI 双绿后开源）
