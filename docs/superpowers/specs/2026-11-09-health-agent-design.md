# Personal Health Agent V1

## Intent and approved direction
Implement the referenced 健康管理Agent conversation: a chat-first personal agent, an independent health database, FastAPI/PostgreSQL, and an Apple Health synchronization boundary. The user selected this direction and requested implementation in the current chat.

## Scope
A single-user authenticated API stores meals, user-set goals, and daily aggregate health snapshots. Metrics: weight_kg, steps, active_energy_kcal, sleep_minutes, resting_heart_rate_bpm, workout_minutes. Chat tools record meals, update goals, query records, view daily summaries, and query trends. Meals are user-confirmed estimates (including estimates obtained from a photo in the host chat). All stored amounts use explicit units. No diagnosis, medication advice, automatic calorie prescriptions, or claims of live HealthKit access.

## Architecture and approaches
The selected self-controlled FastAPI/PostgreSQL backend preserves the conversation's architecture; SQLite is available for local development. A Sites-hosted app would change the approved stack. A native iOS application is larger than the first slice; iPhone Shortcuts can send daily aggregates to an authenticated sync endpoint after device-side Health permission. Future official Health support can map to that same schema.

## Contracts chosen by implementer
REST under /v1, Bearer token from HEALTH_API_TOKEN, refusal to start without a strong token. Timezone is an IANA name, default Asia/Shanghai. Daily snapshots are unique by source/date/metric and replace earlier snapshots, so retries and cumulative daily updates never add twice. Summary prefers apple_health over manual then a stable source order and exposes chosen sources; no cross-device raw samples are added. Meals use client_request_id for retries and support correction/deletion. Missing data is unknown, not a zero measurement. Date ranges include both endpoints and are at most 366 days. A date's meal boundary follows the saved timezone; input timestamps require an offset. No guessed personal profile or fabricated records.

## Delivery and limits
Provide stdio and authenticated Streamable HTTP MCP adapters, startup configuration, container deployment, tests, example sync payloads, a local JSON sync CLI, Chinese health-agent instructions, and iPhone setup instructions. Verify PostgreSQL if available. No external deployment, account connection, or access to real health data is presumed; remote ChatGPT connection may require an OAuth gateway depending on host authentication support. Tools calling the same authenticated API keep data rules centralized.
