# Commands and macros (plan-641)

Every model change in realvirtual WEB is a **command** of the command registry — the same rule,
refusal text and undo step as the button in the editor. You reach all of them through three tools,
and you can record what you did as a **macro** that travels inside the GLB and replays in any
session.

## Working rhythm

1. **Look up** — `web_commands(query?)` lists the commands: `id`, `label`, `argsSchema`
   (arg → type; an arg that is `null`/omitted is taken from the selection where the command allows
   it), `readOnly`, `destructive`, `macro` (recorded when run via MCP), `available` /
   `unavailableReason`.
2. **Change** — `web_execute(command, args, _reason?, _source?, _confidence?)` runs ONE command,
   `web_batch(steps)` several in order (`stopOnError` default true, `stopOnPartial` default false,
   `background=true` for a long batch → `jobId`, poll `web_macro_status`).
3. **Check** — read back what you changed (`web_component_get`, `web_node_bounds`, `web_measure`,
   `web_eye`) before you build on it.
4. **Save** — `web_editor_save` / `web_document_save`. Macros ride along in the GLB.

Every answer carries `status`: `ok` | `partial` (some targets skipped) | `noop` (accepted, nothing
changed) | `failed` (`error` + `kind`: `disabled`, `unknown` — with `similar` ids —, `stale`,
`threw`, …) | `requires-commercial` (the command exists only in the commercial editor).

**Path lists** (`paths`, `…Paths`): comma-separated, or a JSON array of strings for names
containing commas — `{"paths": "[\"Asset/LINK,PLATE\"]"}` is ONE path, `"A,B"` is two. A
string starting with `[` must be valid JSON; it is never split.

Old alias names answer `MOVED` with their replacement command ids for one release.
Run edits through `web_execute` / `web_batch`; use `web_commands(query=…)` to find commands by id or label.

For robot rigging, paths, checks, motion jobs and export, read `web_help("robot")`.

## Runtime commands

Call these with `web_execute(command="<id>", args={...})`. Each implementation validates arguments
in `run()` using shared validation helpers, so UI and MCP calls use the same checks.

- `des.fastForward {on?, untilSimTime?}` — toggle FastForward when neither is supplied; `on`
  explicitly enables/disables it. `untilSimTime` runs to a target time and takes precedence over `on`.
- `des.setEnd {end?, statReset?}` — set the run end and/or statistics reset time on the DES manager.
  Times use `DD:HH:MM:SS` strings; `end` also accepts `"inf"`. The same time format applies to `untilSimTime`.
- `des.stats.window {open, hiddenKinds?}` — open/close statistics and optionally replace the hidden
  kind list (array of strings).
- `des.badges {on}` — enable/disable in-scene statistics badges.
- `camera.flyTo {position, target, durationSec?}` — absolute flight with `[x, y, z]` vectors;
  alternatively `{node, offset?, lookAhead?, durationSec?}` follows a node-relative endpoint.
  Default offset is `[-1.6, 2.1, -4.2]`, look-ahead 1.5, duration 0.6 s. A flight exits follow and first-person view.
- `camera.fit {paths?, region?, rect?, fill?, durationSec?}` — frames the nodes (default: the whole
  model) into the user's view, keeping the view direction. `region` `free` (default) is the largest
  canvas area no floating window covers, `canvas` the whole canvas; `rect` `[x, y, w, h]` in page
  pixels overrides both. `fill` 1 fits the larger side, above 1 crops the edges (1.1 = large).
- `camera.follow {mode, path?}` — `follow`, `siton` or `off`; a supplied path is selected first,
  otherwise the current selection is used.
- `selection.select {path, frame?}` — select a scene node; `frame:true` also frames it in the camera.
- `ui.panel {panelId, rect?, collapsed?}` — set panel geometry (`[x, y, width, height]`) and/or
  collapsed state; at least one is required. Geometry uses the same normalization whether open or closed.
- `ui.panel.list {}` (read, `web_query`) — every known window: `{panelId, title, open, openable}`. Use these
  ids with `ui.panel`, `ui.panel.open` and `ui.panel.close` (e.g. `stats-hub`, `des-event-queue`, `problems`,
  `des-experiment-matrix`, `des-matrix-runs`).
- `ui.panel.open {panelId, target?}` / `ui.panel.close {panelId}` — open or close a window the way its own button
  does. `target` is what a drill-down opens on: `ui.panel.open {panelId:'des-matrix-runs', target:'Base'}` opens
  "Runs — Base". A mounted window without an opener can only be closed; the experiment windows answer
  `kind:'commercial-feature'` without the experiment manager.

FastForward, speed (`des.setMode`, button key `des.speed.<n>`), Follow/Sit, DES Statistics and badges
buttons bind to these commands through `data-rv-command-id` / `data-rv-button-id`; the commands
are also callable through `web_execute`. See `web_help("des")` for target-time behavior.

## Diagnosis commands

Read-only commands, called with `web_execute(command="<id>", args={...})`:

- `diagnose {}` — start here: summary, run state, top 10 problems, faulted components/vehicles, fleet counts and statistics sanity checks.
- `des.status {}` — run state and reason, simulation/end time, progress, event counts and pause reasons (DES mode only).
- `des.events {limit?, component?, action?}` — next events in dispatch order; default 20, maximum 200 (DES mode only).
- `fleet.status {vehicle?, state?}` — vehicle state, fault reason, job, position, waiting and battery; vehicle substring and state filters.
- `problems.list {severity?, code?, node?, limit?}` — problems including quiet entries; severity, code prefix and node substring filters; default 100, maximum 500.
- `problems.ack {id?, code?}` (**write**) — acknowledge problems like closing the Problems panel: they no longer reopen it until they change. Without arguments all (and the panel closes); `id` exact, `code` prefix; the panel closes when nothing unacknowledged is left. Returns `{acknowledged, closed}`.

- `diag.blockage {}` (readOnly) — on-demand `{findings, coverage, atSec, exempt}`. Each deadlock/stall includes its chain, idle time, budget source and checks. No Problems or signal writes; `exempt` counts excluded subtrees.
- `diag.waitGraph {}` (readOnly) — `{edges, sources}`; edges include `analysed` and, where analysis is unsupported, `notAnalysedReason`. Such edges are not proof of a deadlock.
- `diag.blockageWatchStatus {}` (readOnly) — `{on, sampleEverySec, since}`; `since` is simulation seconds when enabled, or null while off.
- `diag.blockageWatch {on: boolean}` (**write**) — enables/disables continuous checking at ledger samples (normally every 1 simulation second). Defaults off after load. Publishes Problems and `SignalBlockageFound`; resolved findings disappear, and disabling clears entries and output signals.

Coverage compares the expected population with registered observers: `expected`, `registered`, `armed`, `complete`, `inactive`, counts `bySource`, plus IDs in `missing` and `unknown`. Zero findings with missing observers does not mean the model is healthy. Only the watch publishes coverage gaps as informational Problems. `web_status.blockage` contains counters only; its `coverage.missing` is a count.

See `web_help("des")` for finished versus stalled. `diagnose` reports statistics issues without changing results or adding Problems entries.

## Planning commands

- `planning.param.list {owner?}` — parameters, KPIs, change log and scenario state.
- `planning.param.set {values}` — atomic key/value update; `values` is a JSON object string.
- `planning.param.apply {}` — commit pending values and reset the run.
- `planning.reset {owner}` — restore defaults (live immediately, reset-class pending).
- `planning.scenario.save {name}` — save and activate; reports `persistedTo: glb | session`.
- `planning.scenario.switch {name}` — load saved values; apply pending reset-class values next.

Planning writes have no undo step and are not recorded as macros. While an experiment batch runs, every planning write answers `experiment-running`.

## Variant commands

- `variant.list {}` — opt-in state, active variant, save state and compact variant summaries.
- `variant.diff {variants?}` — differing fields with paths, units, Base values and per-variant values.
- `variant.create {name}` — create an empty variant, enable variants and show it in the scene.
- `variant.activate {id}` — show a variant; use `id: "base"` to return to Base.
- `variant.set {id, address?|path?, component, field, value}` — set an override; `null` removes it. Typed paths are resolved to stable node addresses.
- `variant.rename {id, name}`, `variant.duplicate {id, name}`, `variant.delete {id}` — manage variants. Duplicate does not activate the copy.
- `variant.save {}` — save the Variants block, reporting `persistedTo: glb | session` and its revision.

Variant writes are session commands and are not recorded as macros. Activating, editing, or deleting the variant in the scene may reset the simulation.

## Give a reason

Every model-changing call accepts three optional meta arguments. They never reach the command;
they are stored with the macro line:

- `_reason` — why, in one sentence: `"DFM-6-5 has 5 mm stroke"`.
- `_source` — where that comes from: `parts:DFM-6-5`, `knowledge:<node path>`,
  `customer:festo/2026-10-19`.
- `_confidence` — `observed` (measured / read), `inferred` (concluded), `unverified` (assumed).

## Record a macro

```
web_macro_record_start(name="festo-round-2")
web_execute(command="editor.setField", args={"path":"Cell/Slide","componentType":"Drive",
            "fieldName":"UpperLimit","valueJson":"5"}, _reason="DFM-6-5 has 5 mm stroke",
            _source="parts:DFM-6-5", _confidence="observed")
web_batch(steps=[{...}, {...}])
web_macro_record_stop()
```

- Only commands with `macro: true` become lines (editor model changes). Signals, simulation,
  camera and view commands are never recorded.
- Recording needs a document open in the **editor**: the macro book belongs to it. Commands that
  write into the planner's document instead (`ik.*` robot programs, `signal.bind` outside the editor) carry
  `macro: true` but are not recorded today — `web_macro_record_start` answers "No document is
  open" in that mode.
- Each line stores the **resolved** args: a target taken from the selection is written as the
  explicit path, so a replay does the same thing whatever is selected then.
- Recorded steps run strictly one after the other.
- Undo, redo, a manual edit in the editor or a document switch **ends** the recording in a
  controlled way (`recording-interrupted`, reason kept on the macro, nothing lost). Start again
  with the same name to continue the macro.
- `web_macro_list` / `web_macro_get(name)` show the lines with their notes,
  `web_macro_annotate(name, step, reason, source?, confidence?)` adds a reason afterwards.
- `web_macro_save(name, stripNotes?)` additionally writes `macros/<name>.macro.json` into a
  writable project folder (`stripNotes=true` removes reasons and sources — customer quotes).

## Import a macro into another document

```
web_macro_list(files=true)                              # + macros/*.macro.json not yet in the book
web_macro_import(source="festo-round-2")                # name → macros/festo-round-2.macro.json
web_macro_import(source="archive/round-1.macro.json")   # or a project-relative path
web_macro_import(json="{\"name\":\"round-3\",\"steps\":[...]}")   # inline — no project folder needed
```

- The book of a document is filled from its own GLB; `macros/*.macro.json` is read only by
  `web_macro_import`. Import into a fresh copy or a frozen base, then replay it there.
- Pass exactly one of `source` or `json`. Without a project folder (public demo) only `json` works.
- A macro of the same name is refused unless `overwrite=true`. A macro recorded on another
  document is imported with a `warnings` entry — check the paths with `dryRun` first.
- The next document save embeds the imported macro in the GLB.

## Modelling commands without their own tool

Reached through `web_execute` / `web_batch` only (all `macro: true`, recorded with resolved args):

| Command | Args | Effect |
|---------|------|--------|
| `editor.clone` | `path`, `name?`, `parentPath?` | Deep copy of a subtree (own nodes, geometry, materials, components); next to the source unless `parentPath` (`""` = the asset root); the new path comes back in `created` |
| `editor.materialDefine` | `name`, `color` (hex), `roughness?`, `metalness?`, `opacity?`, `paths?` | A named PBR material applied to every mesh under `paths` (default: the selection) |
| `editor.reorder` | `path`, `index` | Put the node at sibling slot `index` (0 = first) under its parent |

## Look up → model → check → save

```
web_query("part.lookup", {"name":"DFM-12-50-P-A-GF (K)"})          # stroke 50, moving "(K)", fixed "(Z)", source parts:DFM-12-50
web_execute(command="editor.setField", args={...}, _reason="DFM-12-50 has 50 mm stroke", _source="parts:DFM-12-50")
web_check_gap(a="Cell/Rod", b="Cell/Plate", pose={"Cell/Cylinder": 50})   # mesh-exact, mm
web_macro_assert(name="round-2", check="contact", args={"a":"Cell/Rod","b":"Cell/Plate","pose":{"Cell/Cylinder":50}}, expect={"contact":true})
web_editor_save()
```

- `web_check_gap` / `web_check_contact` answer `gapMm`, `contact` (≤ `toleranceMm`, default 0.1),
  `overlap` (surfaces intersect — `gapMm` 0) and `contained` (one inside the other).
- A pose (`{drive path or unique name: mm | deg}`) is set only for the measurement and restored;
  no drive state changes. It needs the runtime tree (`pose-requires-runtime` in the editor tree).
  `Drive_Gear` slaves follow their master; any other coupling must be posed explicitly
  (`pose-dependency-unsupported`). Above 200 000 triangles together: `too-complex`.
- An assertion line (`web_macro_assert`, checks `gap` | `contact`, expect `{gapMm:{min,max}}` and/or
  `{contact}`) is measured when you add it and on every replay; a failing one is `failed` in the
  report and `macro-step-failed` in the Problems panel.

## Replay a macro

```
web_macro_replay(name="festo-round-2", dryRun=true)   # list what would run, change nothing
web_macro_replay(name="festo-round-2")                # → { jobId }
web_macro_status(jobId)                                # progress + per-line report
web_macro_cancel(jobId)                                # stops between two lines
```

- A replay is a JOB: it answers at once; the per-line report comes from `web_macro_status`.
- Lines recorded as `failed` or `noop` are skipped; `ok` / `partial` lines run again and are
  classified again. A failed line is also listed in the Problems panel (`macro-step-failed`).
- One job per document. Switching the document aborts the job (`document-changed`); edits by
  somebody else in between are reported as `concurrentEdit`, not refused.
- A replay is never recorded. Names that do not exist any more fail with the command's own
  error — nothing is guessed.
