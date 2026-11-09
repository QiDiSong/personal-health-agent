CREATE TABLE entries (owner TEXT NOT NULL, id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner,id));
--> statement-breakpoint
CREATE INDEX entries_day ON entries(owner,day);
--> statement-breakpoint
CREATE TABLE goals (owner TEXT PRIMARY KEY, weight REAL NOT NULL);
