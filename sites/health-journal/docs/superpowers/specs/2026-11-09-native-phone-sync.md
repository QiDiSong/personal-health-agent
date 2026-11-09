# Native iPhone health upload

## Authorized goal
The user wants Windows/desktop access to iPhone health data without repeated manual exports, without paid or third-party phone apps. They selected Apple-only tools. Their iPhone Find Health Samples action does not offer Workouts but does offer steps and other metrics. Existing phone ChatGPT plugin and website use the same owner-private Site D1 database; preserve it. Earlier implementation/publish/GitHub push authorization continues for this integration.

## Approach
Use a one-time iPhone Shortcuts setup: authorized Health sample reads -> authenticated HTTPS POST -> existing D1 records -> desktop refresh/status. A desktop refresh reads stored uploads, not remotely wakes a locked phone. Full individual workouts remain XML-only unless a supported native read action is later verified. Native activity quantities must have their own activity entry, never be added to workout-session minutes.

## Data contract (implementation choice)
POST /api/phone-sync accepts JSON {version:1,collected_at,range_start?,activities?:[],sleep_samples?:[]}.
collected_at is an offset-aware ISO8601 timestamp, normalized to UTC; reject more than5 minutes in the future. range_start is the earliest eligible sleep waking date; default yesterday in Asia/Shanghai, so a last2-day query cannot overwrite an earlier partial night. activities items: {date,steps?,active_energy_kcal?,apple_exercise_minutes?}; explicit numbers and units, at least one quantity. sleep_samples: {start,end,state,source?,device?}; aware ISO times and known Apple sleep states (canonical English/HK identifiers, numeric HK enum values, common Chinese labels). Exclude Awake/InBed from duration while retaining interval connectivity; share existing XML normalization. Preserve null/unknown vs measured0.

Rows use source=device. Sleep IDs remain apple:sleep:YYYY-MM-DD. Native activities use apple:activity:YYYY-MM-DD with kind=activity and named fields; no workout sums. Incoming phone data stores collected_at metadata; stale uploads cannot overwrite newer snapshots. Only requested fields are accepted; no meal/goal/weight writes through device endpoint. Normalize/validate entire payload before D1 writes. Bound body to2MiB and samples to12000; activities up to366 days. All dates/attribution follow existing Asia/Shanghai Site convention.

## Authentication and device configuration
Keep Site owner-only; never make it public. Existing platform service credential is available from get_site: reuse it only for this exact Site and configure as a private runtime secret PHONE_SYNC_GATEWAY_TOKEN. Do not generate/rotate a new platform bypass credential. Add an owner-scoped device credential: random32-byte key, hash only in D1, revocable. The phone sends OAI-Sites-Authorization for platform access and Authorization:Bearer <device-key> for narrow write-only data access. The device key selects the owner; ignore any user-provided owner/identity fields.

Owner browser can POST /phone-sync/config with device name to download a private configuration JSON attachment containing URL/headers/body template. A signed-in same-origin request is required; do not embed credentials in bundles, source, logs, chat, or public pages. Config is delivered only as an authenticated private file and kept in the user's private Files/iCloud Drive. Normal status API exposes no credential/hash. Do not pretend an unsigned .shortcut is installable: Linux/Windows cannot produce an Apple-signed share shortcut here.

Internal same-origin API actions: phone_sync_list, phone_sync_revoke. Config creation has a hard cap5 active devices per owner. New schema-only migration adds phone_sync_devices; existing entries/goals unchanged. Invalid/unknown/revoked device token returns401. Status shows server receipt, phone collected time, latest data day, count; never calls a server receipt 'fresh phone read'. Empty sync must not claim recorded measurements. No actual phone data/configuration is presumed until a verified first upload.

## Delivery
Preserve existing XML importer, owner auth, profile settings, D1, MCP identity and current access. Add distinct activity display, device config/status/revoke controls and Chinese Apple-only instructions for Windows. Build modules into one Worker using pinned esbuild. Mirror sanitized current Site source (no private Git history, secrets or runtime data) into public GitHub sites/health-journal. Test with synthetic data/real local SQLite; independent review; private publish; read-only live verification. Actual iPhone permissions, native action property names and locked/background behavior still need user-side setup/test.

## Recent-30-day clarification
The user now explicitly wants a manual one-tap catch-up for the latest30calendar days, rather than daily manual exports. First-time iPhone Shortcuts construction/Health permission is required. The initial guide synchronizes sleep; daily steps are an optional extension using one explicitly selected source. Query31days of sleep for the first-night buffer, set range_start to the first desired waking day (today minus29calendar days, yyyy-MM-dd), disable sample limits. Cap12000samples and2MiB, never truncate silently. No background automation is required.

## Review rulings
Native catch-up conservatively preserves an existing device sleep row if incoming duration is shorter. A short native result does not prove the phone supplied a complete corrected day. User can delete that Site day then resync, or reimport a full XML, for intentional reductions. Stable daily IDs remain unchanged; no arbitrary sleep length or source is inferred.
