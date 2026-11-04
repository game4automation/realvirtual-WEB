# Component scripting

Read and edit a node's JavaScript or TypeScript in the built-in script editor. Saving hot-reloads a fresh instance and runs `setup(self)` again; it does not transfer the old runtime state. Script execution requires the trust gate to allow it.

Return literal handlers from `setup(self)`: `des.on(hook, mu, data)` receives scheduled events; material-flow handlers include `des.canAccept`, `des.onAccept` and `des.onDownstreamReady`. Continuous update handlers do not run in DES.

Use `self.now` for simulation time, `self.prop` for read-only configuration, and `self.persist(initial)` once in setup for changing state. Persist values must be JSON-pure: no handles, functions, cycles, aliases or non-finite numbers. Restore refills the live object in place. Legacy snapshot hooks do not replace this declaration.

Schedule named hooks through `self.in`, `self.at` or `self.every`; keep repeating timer IDs in persisted state when cancellation is needed. The snapshot already restores pending timers: do not re-arm them after restore.

`self.random()` uses mulberry32. V1 defaults to a path seed; DES v2 derives the seed from the run master seed, component id and purpose `script`. Setup draws and scripts added during a run keep the initial seed until the next applicable reset/start. `Date`, `Math.random`, `setTimeout` and `setInterval` are unavailable.

Code checks report `fixed-update`, `dt-accumulation`, `blocked-global`, `geometry-sampling` and `des-script-undeclared-state`. Move mutable captured state into the persist object and replace tick countdowns with scheduled hooks. Register callbacks in setup; script KPI statistics and callbacks added later are not snapshotted.

Discover available command descriptors with `web_commands`; use `web_query` for read commands and `web_execute` for writes. This checkout has no registered script read/write/check command IDs: use the script editor rather than inventing command names. For simulation and snapshot context read `web_help("des")`.
