---
mode: inline-self-check
agent: main-session
session: 678caef3-c0a9-4cc0-bd0f-5b0661e2b092
commit: ""
base: d0ef9253cae91c6e5a18177cee8087c4a082aea5
scope: packages/web/src/lib/company-spec.js,packages/web/src/lib/company-spec.d.ts,packages/web/src/features/board/dialogs/CompanySpecDialog.tsx,packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx,packages/web/test/company-spec.test.js,trellis-kit/features/company-spec/apply.mjs,scripts/test/company-spec.test.js
diff: sha256:b3a649910d0f4488deab8e91674d1c9f5b529ce81c1d02d9f9da5cfe3c3a770c
---
# Quality Check Report

## Scope
- `packages/web/src/lib/company-spec.js`
- `packages/web/src/lib/company-spec.d.ts`
- `packages/web/src/features/board/dialogs/CompanySpecDialog.tsx`
- `packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx`
- `packages/web/test/company-spec.test.js`
- `trellis-kit/features/company-spec/apply.mjs`
- `scripts/test/company-spec.test.js`

## Verification Results
- Formatting: `yarn oxfmt` on all 7 modified/added files — PASS
- Unit tests:
  - `node --test scripts/test/company-spec.test.js scripts/test/trellis-kit.test.js packages/web/test/company-spec.test.js` — 19/19 PASS
  - `node --test packages/web/test/*.test.js` — 139/139 PASS
- Lint: `yarn workspace @trellis-board/web lint` — 0 errors (no new warnings in changed lines)
- Type-check & Build: `yarn workspace @trellis-board/web build` (`tsc -b && vite build`) — PASS
- Line endings: `git ls-files --eol | rg 'i/crlf'` — 0 matches (all LF)
- Backend API E2E: Not applicable (recorded in `api-e2e-report.md`)
- Spec Sync: Reviewed `.trellis/spec/`; no cross-layer API/command contract changed, no spec update required.