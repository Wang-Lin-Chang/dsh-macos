# Changelog

All notable changes to dsh-macos are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-16

### Added

- `detach-runner-macos.cjs` — task runner with protocol parity to the Windows and Linux runners (`EXIT:<code>`, `lock = pid:startSec`, O_EXCL semantics).
- `macos-backend.mjs` — sandbox backend: uchg apply/verify/restore + capability self-description backed by experiment numbers.
- `macos-utils.mjs` — `ps -o lstart` process-start-time parsing (EXP-3 verified format) + liveness + exit protocol.
- sandbox-exec deny view with the `(allow default)` profile (EXP-3 three-way control-group verdict).
- uchg immutable flags for exit.txt/lock (EXP-1 full control group).
- `chmod 444` same-user write hardening (EXP-1).
- `vendor/` — self-contained `WitnessJobRegistry` build with darwin branches (runner selection + `ps` start time) and the runner copy for registry integration.
- Witness 12-item acceptance, macOS edition — 34/34 ×3 consecutive stable runs on CI.
- Engineering packaging: README, LICENSE, SECURITY, CONTRIBUTING, THIRD_PARTY_NOTICES, CI workflow.

### Changed

- None (first release).

### Fixed

- Year-field off-by-one in the `ps -o lstart` regex capture groups (`m[7]` → `m[6]`), caught by the smoke test reading the lock file directly.
- `applyLock` ordering: chmod before uchg (uchg blocks metadata writes).
