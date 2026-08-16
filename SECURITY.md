# Security Policy

## Supported versions

Latest tag only. Early public preview — breaking changes may occur.

## Reporting a vulnerability

Private reporting only: https://github.com/Wang-Lin-Chang/dsh-macos/security/advisories/new

Include: affected version, reproduction steps, impact.

## Scope

Reportable when an attacker can:

- Escape the sandbox-exec deny view (write/delete under the job directory) in a task context
- Clear the uchg immutable flag or falsify the lock/exit protocol without detection
- Make the runner write outside the job directory

## Out of scope

- Capability-based escapes that require host privileges the task process does not have
- sandbox-exec's own upstream limitations (deprecated Apple tool; documented in README and EXPERIMENTS.md)
