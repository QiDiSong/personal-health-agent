# Monthly health file import and dashboard

The user repeated the final goal: export health data on iPhone once per month, import to a website, retain each month, and review diet, sleep and exercise with other available health metrics. They authorized execution and GitHub push. Use the existing owner-private Site, D1 and ChatGPT plugin; do not add an App or require Shortcuts.

## Selected approach

Apple Health full ZIP/XML export once monthly -> browser-local extraction and normalization -> owner-scoped structured D1 records -> monthly dashboard. The existing XML route remains supported. An App/Shortcuts automatic feed is optional existing functionality, not the main flow. Apple exports full history; the dashboard selects the recent30days or a calendar month without discarding earlier imported months.

ZIP parsing reads only the exact export.xml member, bounds input200MiB and XML150MiB, rejects unsafe/ambiguous/encrypted/corrupt or unsupported ZIPs. Original archive stays in the browser. Import batches validate before writing; deterministic IDs update repeated imports. No completeness or unlimited phone-file-size promise.

## Data

Retain meal/workout/sleep/weight. Add daily device-only activity, nutrition and vitals rows. Quantity normalization supports steps, activity/rest energy, exercise ring minutes, walking/running distance, nutrition energy/protein/fat/carbs/fiber/sugar/sodium/water, heart/resting heart rate, HRV, oxygen saturation, breathing rate, body fat and BMI with explicit unit conversion. Workout uses provided duration/unit when valid, falls back to elapsed; session minutes remain distinct from Apple Exercise Time.

Additive quantities aggregate each source independently, select one largest daily source total, never add Watch and iPhone totals. Vital means use one source with most samples and deterministic tie-breaking. Explicitly explain results can differ from Apple's source priority algorithm. Missing fields remain unknown. Daily nutrition from Apple takes precedence per field over manual meal sums; keep meal details separately. Watches do not infer meals: food must already exist in Health or be recorded in webpage/ChatGPT.

## Display and storage

Default to monthly dashboard, with recent30days and calendar-month selector and historical range query, using existing Shanghai date convention. Cards, coverage, trends, nutrition, sleep, exercise, activity/vitals and daily details. Preserve manual add/edit, source labels, authenticated owner boundaries, profile secrets, old XML helper tests and exact legacy sleep reconciliation. Do not seed actual health records. Raw XML and ZIP are not uploaded or committed.

## Verification

Synthetic archive corruption/path/bounds cases; actual quantity conversions/dedup; SQLite storage and range auth; actual monthly renderer calculations and escaping; old importer and native regressions; build and independent whole-feature review. Publish existing Site owner-private and mirror sanitized source (no private Git history or secrets) to the user's GitHub. Actual large iPhone export still needs user validation.
