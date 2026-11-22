---
status: accepted
---
# Mutation gate: per-file safety ceilings, a config-hashed incremental chain, code pull requests only

A review of the mutation gate found that the overall break threshold could not see one safety file collapse (a guard file at 0 % moved the overall score by about two points), that the incremental results kept counting files and tests that had been removed from the configuration, and that pull requests changing only documentation paid for a mutation run. We changed the gate's shape, not the tests.

## Decision

1. **Per-file safety ceilings.** Each safety-critical file (policy, audit, the write guard, the rate limit, authentication, the transport guards, the HTTP front and the token store) has a ceiling on undetected mutants equal to its known equivalent mutants; equivalents stay visible rather than disabled. A file over its ceiling, or missing from the report, fails the build whatever the overall score. The overall floors rose to break 95, low 95, high 97.
2. **A config-hashed incremental chain.** The mutation cache key starts with a hash of the Stryker and Vitest mutation configuration, so changing what is mutated, which tests run or the thresholds starts a clean chain. A full run from an empty cache takes much longer than an incremental one, and the job timeout leaves room for it.
3. **Code pull requests only.** The mutation job runs when a pull request changes source, tests, package manifests, TypeScript, Vitest or Stryker configuration. Any doubt about the changed-file list runs it. Other pull requests skip it, and therefore also skip the safety-ceiling check.

## Considered options

- Raising the overall break threshold until it caught a safety file: rejected, it would fail on ordinary noise elsewhere long before it caught a collapse.
- Clearing the incremental file by hand or running every pull request from scratch: rejected as error-prone and slow respectively.

## Consequences

A pull request that edits only the mutation workflows or the report script skips the mutation job and the ceiling check; its effect is first seen on the next code pull request or on the push to `main`.
