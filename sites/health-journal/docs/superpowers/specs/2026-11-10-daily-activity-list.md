# Separate recent daily-activity view

User requests a separate area showing all recent daily activity entries so they can read these independently. Add a 每日活动 navigation tab with7/30/90day choices, default30days. The existing read_health API remains owner-scoped; changing this view requests that recent range even when a historical month was selected elsewhere. Keep existing request-generation protection against stale responses.

Show all saved kind=activity entries in-range, newest dates first, with steps, activity energy, Apple exercise ring minutes, walking/running distance, resting energy and source. Preserve zero versus missing; do not merge these into individual workout minutes or display meal records. No pagination hiding entries within the90day maximum. Mobile table scrolls horizontally. Existing safe delete controls remain available; device rows have no edit action. No data/schema migration or health writes are required.

Use the current Site, identity, private access, database and import flows. Renderer and navigation/request behavior receive focused tests plus the full existing suite/build. Publish owner-private and push a sanitized source mirror to the already-authorized GitHub repo.

Independent focused review approved after checking existing hidden!important CSS, owner-scoped requests, safe deletion IDs, markup escaping and self-contained renderer. The monthly activity card links directly to this view; navigation highlights by view name so either entrance selects the same tab.
