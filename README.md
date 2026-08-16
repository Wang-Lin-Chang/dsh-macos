# dsh-macos

> **Part of the [DSH plugin suite](https://github.com/Wang-Lin-Chang)** — six Apache-2.0 plugins for DeepSeek Harness. · DSH 插件套件之一：六个 Apache-2.0 插件。

> macOS backend for [dsh-witness](https://github.com/Wang-Lin-Chang/dsh-witness) and [dsh-anchor](https://github.com/Wang-Lin-Chang/dsh-anchor): **uchg immutable flags + a sandbox-exec deny view** give macOS the same six-dimension evidence protection the other platforms have. Every capability claim carries an experiment number and a control group.
>
> dsh-witness / dsh-anchor 的 macOS 后端：**uchg 不可变位 + sandbox-exec deny 视图**，把证据保护能力补齐到与 Windows/Linux 同级。每个能力声明都带实验编号与对照组。

[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![ci](https://github.com/Wang-Lin-Chang/dsh-macos/actions/workflows/ci.yml/badge.svg)](https://github.com/Wang-Lin-Chang/dsh-macos/actions/workflows/ci.yml)
[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-4d6bfe)](https://github.com/topics/dsh-plugin)
[![topic: dsh](https://img.shields.io/badge/topic-dsh-4d6bfe)](https://github.com/topics/dsh)

## 为什么存在 / Why this exists

dsh-witness 的任务证据链需要三平台同级的沙箱。Windows 用 NTFS ACL 六维闭合，Linux 用 chattr +i + bubblewrap——macOS 是最后一块拼图：

| 能力 | Windows（dsh-witness）| Linux（dsh-cross-platform）| macOS（本包）|
|---|---|---|---|
| 防覆盖 | NTFS ACL deny | chattr +i + bwrap 只读视图 | sandbox-exec deny 视图 |
| 防删 | NTFS ACL deny | chattr +i | chflags uchg |
| 防伪造 lock/exit.txt | ACL + 守卫句柄 | chattr +i | chflags uchg |
| 写隔离视图 | 受限 token | bubblewrap（EROFS）| sandbox-exec `(allow default)` + 外科手术 deny |
| 进程身份 | PowerShell StartTime | /proc/<pid>/stat + btime | ps -o lstart |
| 退出协议 | `EXIT:<code>` | `EXIT:<code>` | `EXIT:<code>`（全对齐）|

## 沙箱解剖 / The sandbox anatomy

每个任务由 runner 托管，时序如下（对齐 Linux 版架构判决）：

```
node detach-runner-macos.cjs <jobDir> <outFile> <exitFile> <commandBase64>

  ① lock（wx 独占）        lock ← "pid:startSec"（ps -o lstart，EXP-3 实测格式）
  ② 预创建协议文件          exit.txt（每生命周期截断重写）+ out.log（追加）
  ③ uchg 只给协议文件       chmod 444 → chflags uchg：exit.txt / lock（runner 自己不再写它们）
  ④ sandbox-exec 包装任务   (allow default) (deny file-write* (subpath "<realpath(jobDir)>"))
                            —— 网络可用、目录外可写、目录内写全被挡（EXP-3 P1 三案对照当选）
  ⑤ 输出管道捕获            stdout/stderr → out.log（out.log 不 uchg——它靠 deny 视图防）
  ⑥ 退出                   nouchg → 写 EXIT:<code> → 删 lock → 进程退出
```

两个关键判决（EXP-2）：macOS 26 的 sandbox-exec **不写 default 时隐式默认 = deny**——缺 `(allow file-read*)` 的任务会被内核静默 SIGKILL；`/bin/bash` 必须绝对路径（沙箱内 execvp 的 PATH 查找被拒）。deny subpath 用 realpath 后的路径（`/tmp → /private/tmp` 符号链接失配会让沙箱静默失效）。

## 你能得到什么 / What you get

- **防覆盖/防删/防伪造**——任务在沙箱视图内写、删、伪造任务目录文件全部失败（冒烟 9/9 攻击项全挡）。
- **进程身份三证据**——`ps -o lstart` 启动时间公式（EXP-3 PS-LSTART 实测 + 冒烟 ±5s），PID 复用防护与 Windows/Linux 同级。
- **能力对齐不缩水**——沙箱内网络可用、任务目录外可写，与 bubblewrap 视图同能力（EXP-3 同电池对照）。
- **协议全对齐**——`EXIT:<code>`、`lock = pid:startSec`、O_EXCL 竞争语义与两个已发布后端一致，registry 无感知切换平台。
- **macOS 独有加固**——`chmod 444` 同用户防写（EXP-1 实测），Windows/Linux 没有这个免费午餐。

## 快速开始 / Quick start

```sh
# 安装（git 源，固定 tag——npm 发布前的安装方式）
dsh plugin --profile <name> add "github:Wang-Lin-Chang/dsh-macos#v0.1.0"
```

```ts
import { MacosSandboxBackend } from 'dsh-macos'

const backend = new MacosSandboxBackend('/path/to/job-dir')
backend.apply()        // chflags uchg 证据文件（任务 spawn 前）
backend.verify()       // fail-closed 自校验（对齐 EXIT:-998 语义）
backend.restore()      // 任务死后恢复（registry 终态落盘窗口）
```

Runner 直接用法（与 detach-runner.cjs / detach-runner-linux.cjs 同协议）：

```sh
node detach-runner-macos.cjs <jobDir> <outFile> <exitFile> <commandBase64>
```

## 验收证据 / Acceptance evidence

`test/witness-final-macos-test.ts` —— 12 场景 / 34 断言，**34/34 ×3 连跑稳定**（GitHub Actions macos-latest · macOS 26.5.2 arm64 · Node 25.9）。另：runner 冒烟 9/9。

| 类别 | 场景 | 断言 |
|---|---|---|
| 持久化 A | 重启存活 / 僵尸恢复（SIGKILL）/ 输出游标续读 / ID 不冲突 | 4 项 |
| 收养协调 B | 50 进程 O_EXCL 竞争恰一终态 / 跨会话收养 / 静默任务保护 / PID 复用防护 | 4 项 |
| 事件溯源 C | 事件日志完整有序 / 尸检报告生成 | 2 项 |
| 沙箱边界 D | 防覆盖 / 防删（sandbox-exec deny 视图 + uchg）| 2 项 |

自己跑：`npm test`（`node --experimental-strip-types test/witness-final-macos-test.ts`）。

## 实验账本 / Experiments

全部实验在 `EXPERIMENTS.md`：4 项判决，每项带对照组。三个决定性结果：

- EXP-1：uchg 全对照组真过（+uchg 前可写可删 → +uchg 后覆盖/删除/rm -f 全 BLOCKED → 恢复后可写）。
- EXP-2：静默 SIGKILL 之谜——隐式默认 deny + 缺 `(allow file-read*)`，三次复跑一致。
- EXP-3：profile 三案同电池对照——`(allow default)` 当选（IN-WRITE-BLOCKED / OUT-WRITE-ALLOWED / 网络 200）。

## 组件 / Components

```
src/
├── detach-runner-macos.cjs   # 任务 runner（sandbox-exec 包装 + uchg，协议全对齐 Windows/Linux）
├── macos-backend.mjs         # 沙箱后端（uchg 应用/校验/恢复 + 能力自述）
└── macos-utils.mjs           # ps lstart 启动时间 + 进程存活 + 退出码协议
vendor/
├── detach-runner-macos.cjs   # runner 自包含副本（registry 集成用）
└── lib/                      # WitnessJobRegistry 编译产物（darwin 分支）
```

## 诚实边界 / Honest boundaries

- **macOS 实测环境**：GitHub Actions macos-latest（macOS 26.5.2 arm64）+ Node 25.9。本机无 Mac，所有判决来自 CI 实验场，未在其它 macOS 版本实测。
- **sandbox-exec 是 Apple 弃用中的工具**：macOS 26 上仍可用且行为已实测；若未来版本移除，本包的能力声明随实验失效（见 EXPERIMENTS.md 实验 1 第 6 项 sandbox_init 探测记录）。
- **sandbox-exec 隐式默认 = deny**（EXP-2 判决）：profile 必须显式写 `(allow default)` 或全套 allow，否则任务被 SIGKILL。
- **`/tmp` 符号链接陷阱**：deny subpath 必须用 realpath 后的路径，否则 `/tmp → /private/tmp` 失配导致沙箱静默失效（runner 已内置 realpath）。
- **离线适用面**：沙箱机制全部为本地系统调用（chflags/sandbox-exec），无网络组件；数天级断网长跑未实测，不声称。
- **uchg 时序对齐 Linux 教训**：uchg 只给 exit.txt/lock（runner 不写）；out.log 靠 deny 视图。

## 开发 / Development

```sh
npm test   # 12 项验收 macOS 版（需 macOS；见 EXPERIMENTS.md 实验场说明）
```

要求：Node ≥ 22.6（`node:sqlite`，实测 25.9）、macOS（sandbox-exec / chflags）。

## License

Apache-2.0
