# GUI-03 history and budget runtime design

Issue: [#15](https://github.com/thanhndv212/opencode-quota/issues/15). Prepared: 2026-10-09. Status: design and code-path investigation; implementation and acceptance tests remain pending. Dependencies: GUI-02 and COR-04.

## Verified starting point

- Electron refresh now runs through `src/gui/quota-refresh-controller.ts` and `src/gui/ipc/quota.ts`. The controller distinguishes current outcomes from retained previous observations. Persistence must consume current provider outcomes, never the retained display snapshot.
- Plugin snapshot recording lives in `src/plugin.ts: captureDashboardSnapshotsBestEffort()`, using `src/dashboard/quota-snapshot-bridge.ts`. The bridge already skips value-only quota rather than inventing percentages, and writes actionable errors when a provider has no usable percentage rows.
- `src/gui/ipc/dashboard-history.ts` uses `SqlJsDatabaseAdapter`. This adapter intentionally does not persist writes; exporting its in-memory database back over `quota-dashboard.db` would overwrite concurrent SQLite changes from the plugin. GUI-03 must not turn it into a second whole-file writer.
- `DashboardApi.captureSnapshot()` currently uses the time of the write. The table's unique key is `(provider, captured_at)`. Separate plugin/GUI reads of the same cache result therefore create different rows unless the original observation timestamp travels with that result. Existing cache entries already contain that timestamp; fresh and coalesced uncached results need equivalent observation metadata.
- Existing quota snapshots and reset tables identify providers and display windows, without a trustworthy account identity column. Account-scoped schema and migration belong to ACC-02; legacy rows must remain explicitly unknown rather than being relabelled as the current account.
- Budget rule evaluation exists, but `src/gui/ipc/alerts.ts: evaluateAlerts()` accepts a caller-provided usage map with no window identity. The renderer lists rules without querying/evaluating their individual windows. Passing all-time totals to this API cannot satisfy a daily rule.

## Implementation order

1. Define observation metadata shared by provider fetches, cache hits and coalesced callers. Preserve actual observation time through cache clones and disk reads. Do not persist credentials or raw opaque account identities. Provider-cache locators are digests; any history identity extension must meet the same boundary. Version any serialized contract change and preserve legacy-read behavior.
2. Extract a shared post-fetch recording hook used by plugin and GUI. Supply original observation time to persistence so repeated views of one observation upsert the same row. Treat separate live fetches as separate observations even when percentages match. Keep reset comparison before snapshot replacement and qualify any reset evidence against known window/account metadata; unknown identities cannot establish an account transition. Persistence failure must be visible as a diagnostic while quota display continues.
3. Add a bounded Node helper for native SQLite writing and local usage aggregation. Electron communicates over a local process protocol, with request IDs, timeout, serialized work and disposal on quit. Use the configured runtime directories and existing database APIs. Keep Electron's sql.js reader read-only, and never export it over a live database. Handle absent Node/native bindings, process failure and database contention as unavailable history/usage. Do not add another provider fetch loop.
4. Evaluate enabled budget rules in main against freshly aggregated `day`, `week`, `month` or `all` windows. Aggregate once per distinct window for each evaluation; preserve source/provider/model buckets instead of using priced model totals for connector scopes. Use one captured upper timestamp. A read error produces an unknown evaluation, not zero spend or a triggered below-threshold rule. Do not treat unpriced cost as known zero USD.
5. Publish budget evaluation state to renderer and tray from the same post-refresh flow. Re-evaluate after rule create/update/delete. Keep budget thresholds separate from reset notifications, and expose an unsubscribe path for budget updates. Show each rule's actual evaluation time, window and unknown/error status.
6. Add fixture-copy upgrade/restart/rollback checks and installed-package runtime evidence. Record the exact boundary between GUI-03 plumbing and ACC-02 account/schema work before claiming any account isolation or migration completion.

## Acceptance gates

| Gate                     | Required evidence                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standalone snapshots     | A fixture provider refresh creates persisted quota history without an OpenCode toast; errors persist without invented percentages; value-only usage remains value-only           |
| Shared observation dedup | Plugin and GUI recording one cached/coalesced observation create one row, including across process restart; two distinct live observations with identical values remain distinct |
| Writer safety            | Two real Node writers and an Electron reader preserve all writes; busy/locked database, helper death, missing binding and persistence failures leave quota display usable        |
| Time-window correctness  | Independent daily/weekly/monthly/all-time fixtures cross thresholds differently; one aggregation per distinct window; fixed upper bound; no all-time/day substitution            |
| Scope and unknowns       | Provider/model/global source totals match; unpriced cost and read failures yield unknown; below-threshold rules do not fire on failed reads                                      |
| Desktop state            | Actual installed app publishes history/budget updates while hidden, re-evaluates rule edits, unsubscribes listeners and quits helper/timer work                                  |
| Compatibility            | Old history/config fixture copies remain readable; rollback preserves data; any account identity/schema dependency is explicitly documented and tested                           |

This design does not complete GUI-03. Implementation must resolve the observation/account metadata boundary and pass these gates before merge and green main CI can close #15. FND-04 remains a separate release/publisher and host/installation gate.
