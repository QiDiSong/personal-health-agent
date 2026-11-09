# Task 1: API and persistence report

Implemented `health_agent/{__init__,config,db,models,schemas,service,api}.py` and
`tests/test_api.py`. No other task's implementation files were edited.

## Behavior

- Strong printable ASCII API token required (32+ characters), hidden settings
  representations and configuration errors, constant-time bearer comparison,
  public `/healthz` only, no public docs/OpenAPI, no uvicorn request access log.
- Profile timezone and nullable explicit goals; PATCH preserves omitted fields
  and clears goals when given null. API defaults to loopback on port 8000.
- Confirmed estimated meals with explicit offset timestamps, finite bounded
  nutrition, stable request IDs, retries, corrections and deletion. Same original
  payload returns the existing record; changed payload returns 409. Tombstones
  prevent an old retry recreating a deleted meal. Timestamps normalize to UTC.
- Daily snapshots replace source/date/metric values transactionally. Sync batches
  reject duplicates, unsupported metrics, non-finite/out-of-range values,
  fractional steps and excess observations before any writes.
- Summaries prefer apple_health, then manual, then lexical source order. They
  report chosen sources and user-set goal remaining values without adding sources.
  Missing observations and missing nutrition totals are null, distinct from zero.
- Saved timezone determines inclusive meal dates, including 23/25-hour DST days.
  Ranges are inclusive, contain at most 366 days, and use strict YYYY-MM-DD input.
  Supported years are 1900–9998. Metric and nutrition trends include null days.
- SQLite and PostgreSQL native upserts; state persists across app instances.
  API validation errors omit raw input values. Startup errors give a redacted
  configuration/connection message.

## Verification evidence

Tests were written first; initial targeted run failed because `health_agent.api`
did not exist. Additional red runs demonstrated numeric timestamp/date coercion,
public docs and unhandled startup validation before those behaviors were fixed.

- `.venv/bin/pytest tests/test_api.py -q`: **49 passed**.
- `.venv/bin/pytest -q`: **128 passed**, one upstream Starlette/httpx deprecation
  warning. An earlier full run during concurrent sync-client development reported
  four expected sync-client red tests; their owner fixed them and the fresh full
  suite is green.
- Scoped `ruff check` and `ruff format --check`: passed for all Task 1 files.
- `TEST_DATABASE_URL` optionally selects a disposable PostgreSQL test database.
  The API suite drops this project's known tables before each test. The root
  integration task is running the PostgreSQL suite separately; this report's
  passing counts above are from SQLite.

## Response contract

`GET /v1/profile` returns timezone and five goal fields. Meal routes return meal
objects with integer IDs; meal lists are plain arrays. `POST /v1/sync` returns
`{source, upserted}`. Summaries return
`{date, timezone, meals, nutrition, goals, remaining, metrics, sources}`.
`remaining` contains `calories_kcal`, `protein_g`, `steps`, `sleep_minutes`, and
signed `weight_kg_to_target`; other remaining values clamp at zero and remain
null unless both the goal and observation exist. Trends return
`{metric, start, end, points:[{date, value, source}]}`. Health metrics expose the
selected source; known nutrition totals use `meal_log`.

GET meals with no date uses today in the saved timezone. A sole start or end
selects that one date. Summary with no day also uses local today.

## Limits

The implementation initializes tables for this first version; future schema
changes need an explicit migration strategy. No real user health data, external
deployment, or device HealthKit access was used.

## Independent review corrections

Reproduced the unbounded meal path ID failure: PATCH with `10**30` reached
SQLite and raised `OverflowError`. PATCH and DELETE now validate IDs as positive
signed 32-bit integers (1–2147483647), matching the PostgreSQL primary key.
Regression tests cover negative/zero IDs, just-over-limit and very large IDs,
plus the accepted maximum returning 404 when no record exists.

Reproduced PostgreSQL `DataError` for NUL characters in descriptions and request
IDs. Request schemas now reject these with 422 before querying or writing;
description corrections reuse the same validation. Tests verify no mutation and
no private value in responses or captured logs.

An additional RED test demonstrated SQLAlchemy's default exception diagnostic
included a synthetic health parameter after a database error. Database engines
now set `hide_parameters=True`; the test checks the diagnostic omits that value
and that the configured option is enabled.

Final verification after review fixes:

- SQLite API suite: **58 passed**.
- Real PostgreSQL 17 API suite, including persistence and all new regressions:
  **58 passed** against a disposable local database.
- Full project suite: **139 passed**, one upstream Starlette/httpx warning.
- Scoped Ruff lint and formatting checks: passed.

Only `health_agent/api.py`, `health_agent/schemas.py`, `health_agent/db.py`,
`tests/test_api.py` and this report changed during review corrections. No commits
were made; the disposable PostgreSQL database has been released to integration.
