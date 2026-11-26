# Implementation report

## Files changed

- `packages/desktop/src-tauri/src/agent/onboarding.rs`
- `packages/desktop/src-tauri/src/agent/onboarding/tests.rs`

## What changed

- Added a generated `.gitignore` section that unignores the fixed shared paths used by initial commit:
  `.trellis`, `.gitignore`, `AGENTS.md`, `.gitattributes`, and `.agents`.
- Directory rules now include both `!/<dir>/` and `!/<dir>/**`.
- Generated shared-path rules are moved to the end of `.gitignore`, so they run after existing project ignore rules.
- Initialization (`ensure_agent_gitignore`) and one-click commit preparation (`commit_and_push_initial`) both ensure the shared-path rules exist.
- `.trellis/.template-hashes.json` remains ignored and is always placed after the shared-path rules.
- Generated rule repair preserves existing user rules and the existing newline style; repeated runs are content-idempotent.
- Initial commit paths are calculated after `.gitignore` repair, including the case where repair creates a new `.gitignore`.

## Tests added or updated

- `unignores_shared_paths_while_keeping_local_state_ignored`:
  - Starts with stale shared negations, later broad ignores, and an earlier template-hash ignore.
  - Verifies all shared paths stop matching `git check-ignore --no-index`.
  - Verifies `.trellis/.template-hashes.json` remains ignored.
  - Verifies generated titles and rules are not duplicated and remain ordered on a second run.
- `commits_and_pushes_only_initialization_paths`:
  - Uses strict project ignore rules, including ignoring `.gitignore` itself.
  - Verifies normal `git add` succeeds without `-f`.
  - Verifies commit/push through a bare remote, exact initialization paths, unrelated staged files staying out, and template hashes not being committed.
- `untracks_manifest_before_initial_commit`:
  - Also verifies a `.gitignore` created during one-click repair is included in the initial commit.
- Existing LF/CRLF, no-trailing-newline, equivalent-rule dedupe, and idempotence expectations were updated for the generated shared section.

## Verification performed

- IDE file inspection:
  - `onboarding.rs`: no errors.
  - `onboarding/tests.rs`: no errors.
- Diff reviewed to confirm only the two scoped source/test files changed.

## Verification intentionally deferred

No build/test/format command was run during implementation, per the explicit task instruction. The main session should run one final validation after all development work:

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml onboarding
```

Then run the project-required final build/check once.

## Open risks

- A deeper nested `.gitignore` under `.trellis` or `.agents` can still override the root-level negations; this task intentionally modifies only the project-root `.gitignore`.
- A user-added negation specifically targeting `.trellis/.template-hashes.json` is preserved, but the generated ignore rule is appended after it to keep the documented local-state invariant.
