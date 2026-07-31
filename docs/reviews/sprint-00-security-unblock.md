# Sprint 00 security unblock

## Scope and decision

This change resolves the release-blocking dependency findings recorded by Gate #4. It changes dependencies and documentation only; it does not include Sprint 01 or Sprint 02 implementation work.

Security classification: **resolved**. `npm audit --audit-level=high` reports zero vulnerabilities after a clean lockfile install.

## Original findings

The old candidate `7956c4ec0152c59fd0c17ab0d9102d5348b38c1b` resolved:

- `next@14.2.35`, directly affected by current Next.js denial-of-service, request-smuggling, SSRF, cache, and related advisories. High-severity advisory identifiers included GHSA-h25m-26qc-wcjf, GHSA-q4gf-8mx6-v5v3, GHSA-8h8q-6873-q5fj, GHSA-c4j6-fc7j-m34r, GHSA-36qx-fr4f-26g5, GHSA-m99w-x7hq-7vfj, GHSA-89xv-2m56-2m9x, and GHSA-p9j2-gv94-2wf4.
- direct `postcss@8.5.8` and Next's nested `postcss@8.4.31`, affected by GHSA-qx2v-qp2m-jg93, GHSA-6g55-p6wh-862q, and GHSA-r28c-9q8g-f849.

These were production dependency paths. Reachability exceptions were not used to waive them.

## Remediation

- `next`: `14.2.35` to `15.5.21`.
- direct `postcss`: floating `^8` to exact `8.5.18`.
- override all PostCSS paths to `8.5.18`, including Next's otherwise vulnerable nested version.
- override Next's optional image dependency from `sharp@0.34.5` to patched `sharp@0.35.0`. Without this override, the updated tree remained affected by GHSA-f88m-g3jw-g9cj.

Next.js 16 is not required. Next 15.5.21 supports Node 20+ and React 18.2, so the repository's Node 22.23.1 and React 18 runtime remain supported. The existing dynamic route handlers already use the Next 15 asynchronous `params` contract. No application source change was necessary.

## Validation

Run with `/opt/homebrew/opt/node@22/bin` first on `PATH`:

```sh
npm ci
npm audit --audit-level=high
npm ls next postcss sharp
npm run typecheck
npm test
npm run test:contracts
npm run test:registry
node --experimental-test-coverage --no-warnings --loader ./scripts/ts-resolver.mjs --test tests/scheduler/scheduler.test.ts
npm run validate:registry -- --verify maybesitter-gemma=../maybesitter-gemma-gold-calibration --verify maybesitter-gemma-runtime-benchmark=../maybesitter-gemma-runtime-benchmark
npm run seal:ledger -- --check
npm run build
git diff --check
```

Verified results:

- clean install and audit: pass, zero vulnerabilities;
- typecheck: pass;
- complete tests: 180/180 pass;
- contracts: 9/9 pass;
- registry tests: 63/63 pass;
- scheduler: 9/9 pass;
- registry and mapped artifact bytes: pass with the two existing SPL006 warnings for unlocked in-progress test splits;
- ledger: sealed at `ea295ba935b38253f6d58a0644222ab6deec334ddc960fac1fe14bc00a76b973`;
- production build: pass on Next 15.5.21;
- whitespace validation: pass.

The build emits an environment-specific warning because a separate lockfile exists above this worktree. It does not affect compilation or the committed repository tree.

## Migration and rollback

There is no data, schema, or stored-state migration. Deployment replaces application dependencies from the committed lockfile and performs the normal build/start sequence.

Rollback is a normal revert of the security-unblock commit followed by `npm ci` and a rebuild. That rollback restores the known high-severity dependency findings, so it is emergency-only and must not be treated as a release-eligible baseline. Operational rollback should first restore the last known-running artifact while keeping public exposure contained, then ship a separately patched dependency revision.

