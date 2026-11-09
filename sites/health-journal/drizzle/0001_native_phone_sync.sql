CREATE TABLE phone_sync_devices (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_received_at TEXT,
  last_collected_at TEXT,
  latest_data_day TEXT,
  last_count INTEGER
);
--> statement-breakpoint
CREATE INDEX phone_sync_devices_owner ON phone_sync_devices(owner, revoked_at);
