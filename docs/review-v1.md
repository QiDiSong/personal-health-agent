# V1 independent review — 2026-11-09

## Verdict

**Spec compliance: substantially implemented, with three required boundary/error-handling fixes below.** The approved chat-agent → authenticated API → independent PostgreSQL database architecture is present. SQLite remains a development option. The Apple Health boundary accepts normalized daily snapshots without pretending to read HealthKit. Nine MCP tools cover the specified records, goals, summaries, trends, and sync operations.

**Code quality: clear and appropriately small, but not ready for an unqualified completion claim until the required findings are addressed.** Business rules live in the service/API rather than being duplicated in MCP. Schema validation, transactional batch upserts, explicit units, UTC storage, local-day boundaries, tombstones, and original-request fingerprints are sensible choices. The main gaps are error privacy at the SDK boundary and inputs accepted by schemas but rejected by database adapters.

This review inspected the design and implementation plan, API/service/models/schemas/configuration/database, MCP/HTTP bridge/report client, sync CLI, container setup, and Chinese instructions. Source files were not edited. This report is the only review artifact written.

## Required findings

### R1 — P2: MCP argument errors expose rejected health inputs

**Location:** `health_agent/mcp_server.py:25`, `health_agent/mcp_server.py:58`; related setting at `health_agent/schemas.py:23`.

`RequestModel.hide_input_in_errors=True` protects those models when validated directly, but FastMCP generates an outer argument model with different configuration. Its `Tool.run()` wraps the resulting Pydantic exception as a `ToolError`, and the low-level protocol handler returns that exception text to the client. Errors therefore echo rejected values into the chat transcript despite the API's redacted 422 handler and the bridge's sanitized upstream errors.

**Reproduction, independently verified through the official stdio MCP client:** initialize a `ClientSession`, then call `record_meal` with:

```json
{"meal":{"eaten_at":"2026-11-09T12:00:00+08:00","description":"synthetic","calories_kcal":"synthetic-private-health-value","client_request_id":"review-redaction"}}
```

The returned `CallToolResult` has `isError=true` and text containing:

```text
meal.calories_kcal
  Input should be a valid number [type=float_type, input_value='synthetic-private-health-value', input_type=str]
```

No API request is needed to reproduce this. The same tool-dispatch implementation is used by HTTP MCP. This is an error-redaction defect, not an unauthenticated data-access bypass.

**Fix:** redact at the complete MCP dispatch boundary, including generated argument validation. Preserve actionable safe field/type errors or emit a generic validation message. Merely adding a try/except inside `record_meal` cannot catch pre-invocation validation. A FastMCP subclass/wrapper that handles tool errors, or a supported generated-model configuration, can solve it; verify the installed SDK API before selecting the mechanism. Add an official protocol test asserting a rejected synthetic secret/health marker is absent from the error content, and retain safe bridge-error behavior.

### R2 — P2: NUL text passes validation but fails PostgreSQL and exposes parameters in errors

**Location:** `health_agent/schemas.py:61`, `health_agent/schemas.py:96`, `health_agent/schemas.py:105`; error-logging exposure at `health_agent/db.py:18` and `health_agent/api.py:41`.

Meal descriptions and request identifiers accept `\u0000`. SQLite accepts these strings, while psycopg/PostgreSQL text fields reject them. Thus an otherwise valid POST or description PATCH reaches the persistence layer and produces an unhandled database error instead of a clean 422. SQLAlchemy uses its default `hide_parameters=False`; unhandled exceptions reach Uvicorn's error logger with SQL parameters, including the meal description and nutritional values. Disabling access logs does not disable exception logs.

**Reproduction:** POST a normal synthetic meal with `description="synthetic\u0000private"`; the SQLite API returned 201. Independently execute a parameterized `SELECT CAST(:description AS text)` against the running disposable PostgreSQL instance with the same string. It raises:

```text
DataError (psycopg.DataError) PostgreSQL text fields cannot contain NUL (0x00) bytes
[parameters: {'description': 'synthetic\x00private'}]
```

The driver rejection and parameter disclosure were verified without changing the parent's PostgreSQL tables. The production request failure follows from the same bound-string adaptation and absence of a runtime SQLAlchemy exception handler; a full PostgreSQL HTTP reproduction was deliberately not run while the parent suite owned those tables.

**Fix:** reject NUL in both create/update descriptions and `client_request_id` before database access, and ensure runtime database failures cannot print health-bearing SQL parameters. `hide_parameters=True` is useful defense in depth; a safe runtime database-error handler also avoids driver diagnostics reaching general logs. Verify the rejection on PostgreSQL as well as SQLite, with no stored mutation and no raw synthetic health marker in error output.

### R3 — P2: Unbounded meal IDs cause database overflow and HTTP 500

**Location:** `health_agent/api.py:96`, `health_agent/api.py:100`; downstream `health_agent/service.py:99`.

Both path parameters accept arbitrary Python integers. A large integer is then bound directly to the database primary-key query. SQLite cannot bind integers outside its signed 64-bit range, so a malformed client identifier causes an unhandled server error instead of an input-validation response. The MCP update/delete argument schemas also advertise unbounded integers.

**Reproduction, independently verified:** against an authenticated in-memory SQLite API, send:

```text
PATCH /v1/meals/1000000000000000000000000000000
{"description":"synthetic"}
```

The response is `500 Internal Server Error`. DELETE has the same lookup path.

**Fix:** define a positive bounded meal-ID type compatible with the persisted primary key and apply it to API path inputs and MCP tool inputs. Return 422 for out-of-range values and preserve 404 for valid but absent IDs. Cover both PATCH and DELETE.

## Optional polish

- **P3 — Correct the remaining-goal explanation:** `docs/agent-instructions.md:19` says negative remaining values mean the goal was exceeded, but `health_agent/service.py:200` clamps calorie/protein/steps/sleep remaining values to zero. The signed `weight_kg_to_target` field is a different quantity and should be explained separately. Document the current clamping behavior rather than encouraging the assistant to infer negative results it will never receive.
- The plan's task checkboxes remain unchecked. Once final verification and fixes finish, update the delivery record so readers can distinguish completed work from pending work.

## Checks that did not yield a required defect

- Every health-data API route has the bearer dependency; the only intentionally public data-free route is `/healthz`. OpenAPI and interactive documentation are disabled. HTTP MCP requires a separate strong token before protocol dispatch. stdio relies on local process access and still calls the token-protected API.
- Meal retry fingerprints preserve the original payload through corrections. Tombstones prevent reuse of deleted request IDs; retry conflict handling handles concurrent unique-key insertion. Updates do not clear the tombstone, so inspection did not identify a resurrection race. Concurrent overlapping operations were assessed from source rather than stress-tested.
- Daily sync uses a database uniqueness constraint and atomic conflict updates. Summary selection is `apple_health`, then `manual`, then lexical source order; selected sources are returned and different sources are never summed.
- Offset-aware meal timestamps are normalized to UTC, and start/end boundaries are calculated separately in the saved IANA timezone. This supports DST days. Missing observations and incomplete macro totals remain null; explicit zero remains distinguishable.
- Date ranges are bounded and inclusive. Metric bounds reject nonfinite or contradictory batches before writes. The sync CLI validates payloads, bounds file size, rejects ambiguous JSON, requires remote HTTPS, and refuses redirects.
- Compose uses PostgreSQL with a named volume, limits the API host port to loopback, and runs the API image as a non-root user. The parent is separately verifying actual image build/startup and PostgreSQL behavior; those checks were not duplicated here.
- README accurately distinguishes local stdio from remote ChatGPT connectivity, identifies the possible OAuth gateway requirement, and does not claim deployment/account connection. Apple instructions disclose that a generic six-metric Shortcut has not been device-tested, describe single-source selection and overlapping intervals, and offer manual confirmation/file-upload fallbacks. The documented boundary is feasible; a turnkey device integration is not delivered or claimed.

## Evidence limits

The parent reported existing API, CLI, MCP/report tests and was running official protocol, PostgreSQL, and Docker checks. Those reported results are not represented here as independently rerun suites. Independent probes covered the official MCP validation-error round trip, SQLite NUL acceptance, SQLite oversized-ID failure, malformed Unicode rejection, and PostgreSQL NUL/SQLAlchemy exception behavior. All probe values were synthetic; no real health records or credentials were printed.

This report records the reviewed pre-fix state. Recheck R1–R3 after implementation changes and append verification evidence before treating this review as passed.


## 最终修正与复核记录（实现者补充）

R1 已用 PrivateFastMCP 在完整分发边界脱敏；回归测试先观察到原始输入被回显，再通过；官方 stdio/HTTP 协议测试也验证错误内容没有合成私密标记。R2 已在新建与修改描述及请求标识中拒绝 NUL，同时设置 SQLAlchemy hide_parameters=True；实际数据库错误诊断回归验证不打印绑定参数。R3 已在 API 路径与 MCP 参数中限制记录 ID 为1..2147483647；合法但不存在的 ID 仍返回404。目标剩余量说明已纠正。

最终项目139项测试全部通过，API58项在 SQLite 和 PostgreSQL 两种后端均通过，Ruff 检查通过。此节是实现者的修正验证，不是审查者再次独立运行的结论。
