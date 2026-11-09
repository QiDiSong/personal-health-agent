# Personal Health Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver a runnable private health API and chat tool server matching the approved architecture.
**Architecture:** Single-user FastAPI service, SQLAlchemy/PostgreSQL storage with SQLite development mode. MCP adapters call the API so validation and aggregation stay in one place.
**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2, Pydantic 2, official MCP SDK, pytest, Docker Compose.
**Spec:** docs/superpowers/specs/2026-11-09-health-agent-design.md

## Global Constraints
- HEALTH_API_TOKEN is required, at least 32 characters; no credentials in source or logs.
- Single user; daily health snapshots replace by source/date/metric; timestamps require offsets.
- Timezone Asia/Shanghai by default; inclusive bounded date ranges; unknown observations remain null.
- No invented personal health data or medical prescriptions; expose input provenance.
- Preserve FastAPI/PostgreSQL; SQLite only for local development/tests.

## Review Focus
- Retry and correction behavior for meals and daily sync; no double counting.
- Local midnight and offset conversion; no missing-as-zero observations.
- Invalid, oversized, non-finite, or contradictory input rejected atomically.
- API and MCP reads/writes require authentication, without secret leakage.
- Persistence after restart and SQL behavior on PostgreSQL.

### Task 1: Health API and persistence
**Files:** health_agent/{__init__,config,db,models,schemas,service,api}.py, tests/test_api.py
**Interfaces:** create_app(settings: Settings) -> FastAPI; Settings(api_token, database_url, timezone); app.state engine/session factory allowed for tests. Routes: GET /healthz (public), GET/PATCH /v1/profile; GET/POST /v1/meals; PATCH/DELETE /v1/meals/{id}; POST /v1/sync; GET /v1/summary?day=YYYY-MM-DD; GET /v1/trends?metric=...&start=...&end=... . Meal JSON: eaten_at, description, calories_kcal, protein_g, carbs_g, fat_g, client_request_id. Profile: timezone, calorie_goal_kcal, protein_goal_g, steps_goal, sleep_goal_minutes, target_weight_kg. Sync: source, observations:[{date,metric,value}]. List meals accepts start/end inclusive. Return meal objects and plain lists; summary includes date, meals, nutrition totals, goals, metrics and sources; trends includes daily points.
- [x] Write behavioral API tests covering authentication, validation, persistence, idempotency, correction, source choice, and timezone.
- [x] Run tests and observe missing implementation failure.
- [x] Implement schemas, database models, atomic operations and routes.
- [x] Run pytest tests/test_api.py; expect all pass.

### Task 2: MCP adapters and daily report
**Files:** health_agent/mcp_server.py, health_agent/report.py, tests/test_mcp.py, tests/test_report.py.
**Interfaces:** async HTTP bridge forwards tool calls to Task 1 routes; HEALTH_API_URL default http://127.0.0.1:8000. stdio default, optional Streamable HTTP bound to loopback with a separate strong MCP bearer token. Report CLI reads /v1/summary and prints JSON to stdout for cron.
- [x] Write tests for route arguments, error redaction, tool discovery/annotations and authenticated HTTP transport.
- [x] Observe failing tests; implement MCP tools and CLI.
- [x] Run targeted tests and official MCP client integration.

### Task 3: Sync client and user-facing setup
**Files:** scripts/sync_health.py, tests/test_sync_cli.py, examples/*, docs/apple-health-sync.md, docs/agent-instructions.md.
**Interfaces:** CLI accepts normalized JSON snapshot file and posts /v1/sync using HEALTH_API_URL/HEALTH_API_TOKEN. It never reads device data itself. iPhone daily aggregation uses chosen consolidated source; sleep uses prior night's total attributed to waking date.
- [x] Write CLI tests for success, missing token, invalid input and safe HTTP errors, then observe failure.
- [x] Implement client, synthetic explicitly marked payloads, and Chinese setup docs.
- [x] Run tests/test_sync_cli.py and inspect examples.

### Task 4: Deployment and integrated verification
**Files:** README.md, Dockerfile, compose.yaml, .env.example, .mcp.json.example, requirements.lock.
- [x] Add reproducible dependency lock, non-root container, PostgreSQL volume and healthcheck, local MCP config, daily report cron example.
- [x] Run all tests, lint, authenticated API/stdio MCP/HTTP MCP smoke tests and PostgreSQL integration when available.
- [x] Fresh independent review, fix material findings and re-run affected/full checks.
- [x] Record deployment/phone authorization requirements accurately and return source artifact.
