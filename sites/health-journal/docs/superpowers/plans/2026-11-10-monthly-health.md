# Monthly health implementation

**Goal:** Monthly iPhone export -> one-file local import -> durable monthly health website.
**Spec:** ../specs/2026-11-10-monthly-health-design.md

1. Archive module and synthetic ZIP tests (independent agent): readHealthFile(File)->XML, bounded/CRC validated; parent bundles browser copy.
2. Quantity module/tests (independent agent): quantityRows(records,{today,from?,to?})->stable activity/nutrition/vitals rows; explicit units and single-source aggregation.
3. Monthly dashboard/tests (independent agent): self-contained renderMonthDashboard(state,{from,to,title?})->safe HTML, coverage/unknowns, real nutrition/sleep/workout calculations.
4. Root integration: test new device kinds/range query, ZIP browser bundle, enhanced XML mapping, month selector/default dashboard, clear monthly import/food instructions, preserve existing features.
5. Fresh complete tests/build, independent review/fixes, private publish and read-only checks, sanitized GitHub mirror/push and handoff.

## Final verification
101 Node tests passed; Worker build passed. Independent reviewer executed the bundled inline browser script and closed calendar response races, missing historical controls and aggregation policy visibility. Archive extraction, unit/source aggregation and monthly renderer also received scoped review. Public mirror and owner-private publication follow the exact committed source. Actual iPhone export not supplied/tested; no production health writes performed during authoring.
