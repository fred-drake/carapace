# TASK.md — Code Review Findings

> Generated from code review of PR #1: `feat(arch-01): bootstrap project structure`
> Reviewed: 2026-02-18

## 🟡 Medium Priority

- [ ] **[BUILD]** Add `tsc-alias` (or equivalent) to the build pipeline so
      `@carapace/core/*` path aliases resolve at runtime, not just at type-check
      time. `tsc` with `NodeNext` does not rewrite path aliases in emitted JS.
      Affects: `package.json` build script, `tsconfig.json`.
- [ ] **[TOOLING]** Update `packageManager` in `package.json` from
      `pnpm@9.15.4` to match Nix dev shell version (currently `pnpm@10.28.0`).
      Prevents `corepack` version mismatch conflicts.
- [ ] **[TYPES]** Create `tsconfig.check.json` that extends `tsconfig.json`
      but includes `**/*.test.ts` and `**/*.spec.ts`. Use in CI via
      `tsc --noEmit -p tsconfig.check.json` to type-check test files alongside
      source. Currently tests are excluded from `tsc`.
- [ ] **[SAFETY]** Add `"private": true` to `package.json` to prevent
      accidental npm publish during early development.

## 🟢 Low Priority

- [ ] **[GIT]** Add `.DS_Store` to `.gitignore` (macOS development artifact).
- [ ] **[COVERAGE]** Add `html` to Vitest coverage reporters for local visual
      review (deferred to QA-07 task).
