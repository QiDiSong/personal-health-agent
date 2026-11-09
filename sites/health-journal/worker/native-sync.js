import { normalizePhonePayload } from './native-payload.js';

const BODY_LIMIT = 2 * 1024 * 1024;
const errorMessage = '无法处理此请求。';
const json = (body, status = 200, extraHeaders = {}) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extraHeaders } });
const failure = status => json({ error: errorMessage }, status);
class RequestFailure extends Error {
  constructor(status) { super(errorMessage); this.status = status; }
}
const contentType = req => (req.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
const sameOrigin = req => {
  const origin = req.headers.get('origin');
  return origin !== null ? origin === new URL(req.url).origin : req.headers.get('sec-fetch-site') === 'same-origin';
};
const hashKey = async key => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
const rawKey = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// Content-Length is only an early rejection. Count the bytes actually read so
// missing or dishonest lengths cannot bypass the bound.
async function boundedText(req, limit) {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new RequestFailure(413);
  if (!req.body) return '';
  const reader = req.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RequestFailure(413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new RequestFailure(400); }
}

export async function downloadPhoneConfig(req, env, owner) {
  if (!owner || typeof owner !== 'string') return failure(401);
  if (req.method !== 'POST') return failure(405);
  if (!sameOrigin(req)) return failure(403);
  if (new URL(req.url).search) return failure(400);
  const type = contentType(req);
  if (!['application/json', 'application/x-www-form-urlencoded'].includes(type)) return failure(415);
  if (typeof env.PHONE_SYNC_GATEWAY_TOKEN !== 'string' || !env.PHONE_SYNC_GATEWAY_TOKEN.trim()) return failure(503);
  let data;
  try {
    const text = await boundedText(req, 4096);
    data = type === 'application/json' ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
    if (!data || Array.isArray(data) || typeof data !== 'object') return failure(400);
  } catch (error) { return failure(error instanceof RequestFailure ? error.status : 400); }
  const name = data.name === undefined ? '我的 iPhone' : data.name;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return failure(400);
  try {
    const key = rawKey(), tokenHash = await hashKey(key), id = crypto.randomUUID(), createdAt = new Date().toISOString();
    // One conditional INSERT makes the per-owner limit safe under concurrent
    // downloads; counting in JavaScript before INSERT would race.
    const result = await env.DB.prepare('INSERT INTO phone_sync_devices(id,owner,name,token_hash,created_at) SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM phone_sync_devices WHERE owner=? AND revoked_at IS NULL)<5').bind(id, owner, name.trim(), tokenHash, createdAt, owner).run();
    if (result.meta?.changes !== 1) return failure(409);
    return json({
      url: new URL('/api/phone-sync', req.url).href,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, 'OAI-Sites-Authorization': 'Bearer ' + env.PHONE_SYNC_GATEWAY_TOKEN },
      body_template: { version: 1, collected_at: '', range_start: '', activities: [], sleep_samples: [] },
    }, 200, { 'content-disposition': 'attachment; filename="health-phone-sync.json"', 'referrer-policy': 'no-referrer' });
  } catch { return failure(503); }
}

export async function phoneSyncAction(db, owner, name, args = {}) {
  if (!owner || typeof owner !== 'string') throw new Error(errorMessage);
  if (name === 'phone_sync_list') {
    const result = await db.prepare('SELECT id,name,created_at AS createdAt,revoked_at AS revokedAt,last_received_at AS lastReceivedAt,last_collected_at AS lastCollectedAt,latest_data_day AS latestDataDay,last_count AS lastCount FROM phone_sync_devices WHERE owner=? ORDER BY created_at DESC,id').bind(owner).all();
    return { devices: result.results };
  }
  if (name === 'phone_sync_revoke') {
    if (!args || typeof args.id !== 'string' || !/^[a-f0-9-]{36}$/.test(args.id)) throw new Error(errorMessage);
    const result = await db.prepare('UPDATE phone_sync_devices SET revoked_at=? WHERE owner=? AND id=? AND revoked_at IS NULL').bind(new Date().toISOString(), owner, args.id).run();
    return { revoked: result.meta?.changes === 1 };
  }
  throw new Error(errorMessage);
}

// Share the eligibility predicate between the pre-write status aggregate and
// the actual UPSERT so both describe the same accepted measurement rows.
const mayReplace = (stored, incoming) => `json_extract(${stored}.data,'$.source')='device' AND ${stored}.kind=${incoming}.kind
  AND COALESCE(json_extract(${stored}.data,'$.collectedAt'),'')<=json_extract(${incoming}.data,'$.collectedAt')
  AND (${incoming}.kind<>'sleep' OR json_extract(${incoming}.data,'$.minutes')>=json_extract(${stored}.data,'$.minutes'))`;
const eligibleRows = `WITH incoming AS (
  SELECT json_extract(value,'$.id') AS id,json_extract(value,'$.day') AS day,json_extract(value,'$.kind') AS kind,value AS data FROM json_each(?)
), eligible AS (
  SELECT incoming.* FROM incoming LEFT JOIN entries AS stored ON stored.owner=? AND stored.id=incoming.id
  WHERE stored.id IS NULL OR (${mayReplace('stored', 'incoming')})
)`;

export async function handlePhoneSync(req, env) {
  if (req.method !== 'POST') return failure(405);
  // Sites validates and consumes its own OAI-Sites-Authorization header before
  // dispatch. Only the independent narrow device key is available here.
  const auth = req.headers.get('authorization') ?? '';
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) return failure(401);
  let device;
  try {
    device = await env.DB.prepare('SELECT id,owner FROM phone_sync_devices WHERE token_hash=? AND revoked_at IS NULL').bind(await hashKey(auth.slice(7))).first();
  } catch { return failure(503); }
  if (!device) return failure(401);
  if (new URL(req.url).search) return failure(400);
  if (contentType(req) !== 'application/json') return failure(415);
  let normalized;
  try { normalized = normalizePhonePayload(JSON.parse(await boundedText(req, BODY_LIMIT))); }
  catch (error) { return failure(error instanceof RequestFailure ? error.status : 400); }
  const { rows, collectedAt } = normalized;
  const encodedRows = JSON.stringify(rows);
  const receipt = new Date().toISOString();
  try {
    // json_each inserts the complete validated snapshot in one SQL statement.
    // Four statements fit a single D1 transaction even for large sample sets;
    // a late SQL failure therefore rolls back both entries and receipt status.
    // Every write checks that this owner-bound device is still active, closing
    // the token-lookup/revocation race without trusting an owner from the body.
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE phone_sync_devices SET last_received_at=MAX(COALESCE(last_received_at,''),?) WHERE id=? AND owner=? AND revoked_at IS NULL").bind(receipt, device.id, device.owner),
      env.DB.prepare(eligibleRows + ' SELECT MAX(day) AS latestDataDay FROM eligible').bind(encodedRows, device.owner),
      // Aggregate before the UPSERT, while the same transaction still sees the
      // previous entries. Rejected later days must not become measurement dates.
      env.DB.prepare(eligibleRows + ' UPDATE phone_sync_devices SET last_collected_at=?,latest_data_day=(SELECT MAX(day) FROM eligible),last_count=(SELECT COUNT(*) FROM eligible) WHERE id=? AND owner=? AND revoked_at IS NULL AND (last_collected_at IS NULL OR last_collected_at<=?)')
        .bind(encodedRows, device.owner, collectedAt, device.id, device.owner, collectedAt),
      env.DB.prepare(`INSERT INTO entries(owner,id,day,kind,data)
        SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.day'),json_extract(value,'$.kind'),value
        FROM json_each(?) WHERE EXISTS(SELECT 1 FROM phone_sync_devices WHERE id=? AND owner=? AND revoked_at IS NULL)
        ON CONFLICT(owner,id) DO UPDATE SET day=excluded.day,kind=excluded.kind,
          data=CASE WHEN excluded.kind='activity' THEN json_patch(entries.data,excluded.data) ELSE excluded.data END
        WHERE ${mayReplace('entries', 'excluded')}
          AND EXISTS(SELECT 1 FROM phone_sync_devices WHERE id=? AND owner=? AND revoked_at IS NULL)`)
        .bind(device.owner, encodedRows, device.id, device.owner, device.id, device.owner),
    ]);
    if (results[0].meta?.changes !== 1) return failure(401);
    const count = results[3].meta.changes;
    return json({ ok: true, count, latestDataDay: count > 0 ? results[1].results[0].latestDataDay : null, collectedAt });
  } catch { return failure(503); }
}
