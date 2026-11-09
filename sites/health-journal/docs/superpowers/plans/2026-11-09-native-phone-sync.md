# Native Phone Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Free Apple-only iPhone uploads into the existing journal, visible from Windows and ChatGPT mobile.
**Architecture:** Native Shortcuts uploads bounded typed samples via a narrow device key behind existing Sites private service access. Shared sleep normalization and owner-scoped D1 storage keep XML and phone imports consistent.
**Tech Stack:** Node24 tests, Worker ESM, SQLite/D1, esbuild, iPhone Shortcuts.
**Spec:** docs/superpowers/specs/2026-11-09-native-phone-sync.md

## Global Constraints
- Preserve Site identity, D1 data and owner-only audience; do not create another Site or expose secrets.
- No third-party phone app or payment. Windows cannot produce signed .shortcut bundles.
- Step counts/Apple Exercise Time are not individual workout duration.
- Use offset-aware timestamps, Asia/Shanghai dates, validated finite explicit quantities, idempotent IDs and stale-write protection.
- No real health records in tests or public source; no production synthetic writes.

## Review Focus
- Revoked/wrong-device/cross-owner attempts never write or expose configuration.
- Duplicate, delayed or partial phone snapshots do not erase newer known values or double-count XML imports.
- Overnight phases/source metadata/unknown states and midnight boundaries preserve sleep totals.
- Private config download cannot be triggered/read cross-origin or leak into public HTML/logs.
- UI reports uploaded data freshness accurately; no claim of locked-phone remote reading or full native workouts.

### Task1: Shared normalization
**Files:** worker/apple-sleep.js, worker/native-payload.js, tests/native-payload.test.mjs.
**Consumes:** Existing appleSleepRows/appleDeviceKey/appleLegacySleepRows behavior in worker/index.js.
**Produces:** Export the three named helpers self-contained (safe function.toString injection into browser); export normalizePhonePayload(payload,{now?:Date}) -> {collectedAt,rows,latestDataDay}. Rows {id,day,kind,label,source:'device',...quantities,collectedAt}; activity/sleep only.
- [x] Write failing tests for strict values/timestamps, unknown vs0, state aliases, overnight union, minimum waking day, stable IDs and duplicated-day handling.
- [x] Observe RED; implement and preserve existing helper semantics with no external closure dependencies.
- [x] Run node --test tests/native-payload.test.mjs; expect PASS.

### Task2: Authenticated upload/device lifecycle
**Files:** worker/native-sync.js, tests/native-sync.test.mjs, drizzle/0001_native_phone_sync.sql, drizzle/meta/_journal.json (append only).
**Consumes:** normalizePhonePayload from Task1; D1 entries schema, env.PHONE_SYNC_GATEWAY_TOKEN.
**Produces:** handlePhoneSync(request,env) -> Response for POST /api/phone-sync; downloadPhoneConfig(request,env,owner) -> Response for POST /phone-sync/config; phoneSyncAction(db,owner,name,args) -> JSON for phone_sync_list/phone_sync_revoke. Error responses generic with no input/secrets. Config response attachment no-store.
- [x] Write failing real-SQLite D1-adapter tests for key creation/download, token auth/revoke, owner scoping, bounded invalid payload atomicity, idempotency/stale protection and safe status.
- [x] Observe RED; implement tables/migration/lifecycle/route functions. Config header platform token supplied from private env only; device raw key is returned only in owner-requested config file and never stored.
- [x] Run node --test tests/native-sync.test.mjs; expect PASS.

### Task3: Integrate native UI and one-time setup
**Files:** worker/index.js, scripts/build.mjs, package.json/package-lock.json, existing test import harnesses, tests/native-ui.test.mjs, README.md, docs/native-shortcuts-windows.md, .env.example.
- [x] Test module bundle/client sleep regression, activity display separate from workouts, config/status/revoke request paths and secret-free HTML.
- [x] Integrate routes after platform auth, strict config CSRF, shared helpers and activity-only UI; bundle one Worker with pinned esbuild.
- [x] Add one-time Windows/phone native setup instructions using fixed private config file; triggers opening Safari/Health plus optional time retry. No repeated file export, no unsigned shortcut installer claim.
- [x] Run complete Node suite/build and unchanged Python regressions after public mirror; independent review and fix required findings.
- [ ] Configure existing platform service key privately, push Site source, package exact commit, publish owner-private, verify live read/status only, mirror sanitized source and push GitHub; update handoff/verification.

## Recent-30-day clarification
The user now explicitly wants a manual one-tap catch-up for the latest30calendar days, rather than daily manual exports. First-time iPhone Shortcuts construction/Health permission is required. The initial guide synchronizes sleep; daily steps are an optional extension using one explicitly selected source. Query31days of sleep for the first-night buffer, set range_start to the first desired waking day (today minus29calendar days, yyyy-MM-dd), disable sample limits. Cap12000samples and2MiB, never truncate silently. No background automation is required.

## Verification and final review
63 Node tests passed, build passed, independent whole-feature review passed after fixing partial sleep replacement and effective-data-date accounting. The parent also ran unchanged Python regressions:139passed. Latest user steering: unfamiliar with Shortcuts, so the UI/README recommend the existing monthly XML import, with the new native path explicitly optional. Phone-side authorization and field verification remain incomplete.
