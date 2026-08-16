# Contributing

Every capability claim in this repository carries an experiment number (see `EXPERIMENTS.md`). Contributions must follow the same rule.

## Rules

- **No claims without an experiment.** New sandbox capabilities need a probe + control group before they enter `src/`.
- **Control groups are mandatory** — the source of a "blocked" result must be proven (e.g. uchg before/after comparison, profile deny vs pure allow default).
- Tests must pass on a real macOS environment (`npm test`; the documented environment is GitHub Actions macos-latest — this repo has no local Mac).
- No machine-specific paths in committed code.

## Development

```sh
npm test   # Witness 12-item acceptance, macOS edition
```

Environment: macOS 26.5.2 arm64 + Node 25 (CI macos-latest image; see `EXPERIMENTS.md`).
