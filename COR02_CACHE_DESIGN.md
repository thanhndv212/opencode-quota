# COR-02: Account-safe cache implementation

The shared quota cache currently identifies configuration but not the selected credential. An account switch can therefore reuse another account's memory, persisted, or pending result.

1. Introduce explicit cache policies. Providers without a verified identity policy fetch uncached; cached-only reads return a miss. Account-neutral caching must be explicitly declared.
2. Adapt the pinned upstream protected HMAC identity implementation (4.x commit 5e20e58b3e516996cde7725601fc62e945025df1). Persist only a locator digest, never credentials or the opaque auth identity. Unavailable protected storage disables account caching.
3. A resolved-auth policy prepares both identity and a fetch closure using the same credential snapshot. This prevents credential switches, including A/B/A races, from assigning a fetched result to the wrong cache identity.
4. Version/invalidate old ambiguous snapshots; apply identity to memory, disk, pending work, and cached-only reads. Recheck pending work after asynchronous disk lookup. Explicit bypass never joins pending cached work.
5. Prove the contract with account switches, simultaneous requests, bypass, old snapshots, and serialized-state tests. Integrate DeepSeek using its actual env/global-config/OpenCode-auth resolver and frozen credential.
6. Audit and integrate the remaining provider-specific/internal caches before closing COR-02. Unsupported adapters remain explicitly uncached in the shared layer; this can increase probes across independent surfaces. Do not label this initial safety increment as full provider coverage.

Validation: targeted failing regressions first, full suite after each logical increment, installed-package/desktop CI before merge. Protected main and required checks remain mandatory. No live credentials or provider calls are needed for fixtures.
