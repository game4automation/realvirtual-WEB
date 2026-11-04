# UI Visibility — Which Axis Decides What

> **Applies to:** Community runtime and public extension APIs. Examples of commercial or optional integrations require the corresponding feature or separate product.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

Runtime participation and UI visibility are independent. In particular:

> **`core: true` + `modes: [...]` means the runtime runs in every mode,
> while its UI appears only in the listed modes.**

Use the runtime flags for execution and the UI visibility rules for presentation.

Related: [doc-extending-webviewer.md](doc-extending-webviewer.md) (plugin authoring, UI slots),
[doc-webviewer.md](doc-webviewer.md) (architecture).

---

## 1. The two axes

|  | **Axis A — Runtime** | **Axis B — Presentation** |
|---|---|---|
| **Question** | Is this plugin running right now? | Is this UI element rendered? |
| **Declared in** | `modes` / `core` on `RVViewerPlugin` (`rv-plugin.ts`) | `visibilityRule` + `visibilityId` on a `UISlotEntry`, or a `useUIVisible(id, rule)` call |
| **Evaluated by** | `pluginParticipatesInMode()` (`rv-mode-manager.ts`) | `evaluateVisibilityRule()` / `useUIVisible()` (`ui-context-store.ts`) |
| **Effect when false** | No fixed-update / render callbacks, no model or connection hooks | The element is not rendered; the plugin keeps running |

**The bridge between them** is one function: `UIPluginRegistry.register()`
(`rv-ui-registry.ts`). It compiles `plugin.modes` into a `shownOnlyInAny` rule on every one
of that plugin's slot entries — **without ever looking at `core`**.

That single omission is the whole rule. `core` buys participation and nothing else.

### The registered modes

Five workspace modes are registered in `main.ts`; the sixth, `editor`, is registered by the asset-editor feature adapter (private builds only — a community build has no Editor mode). All six, in `order`. A mode's UI context id is
`mode:<id>` (`modeContext(id)`), which is what `modes` compiles into:

| `ModeId` | Label | `order` | Runtime |
|---|---|---|---|
| `viewer` | Viewer | 5 | `simulation` (default) — kinematics run; the pure spectator workspace (plan-387) |
| `hmi` | HMI | 10 | `simulation` |
| `des` | DES | 20 | `simulation` |
| `planner` | Planner | 30 | `simulation` |
| `commissioning` | Commissioning | 35 | `simulation` (default) — the virtual-commissioning workspace (plan-423) |
| `editor` | Editor | 40 | **`detached`** — the SimulationRuntime performs no time integration (asset authoring) |

**`commissioning` vs `viewer`** — the pair is worth understanding together, because they are
built from the same two axes and differ only in which elements carry the string:

| | `viewer` | `commissioning` |
|---|---|---|
| KPI bar, message stack, views slot, AI activity overlay | hidden | hidden |
| Inspector, Hierarchy, CONNECT panel + opener, AI-bridge entry, context menu, search | hidden | **visible** |
| ButtonPanel container | hidden | **visible** |
| `button-group` tools | — | Signal Link, Test Axes, Measure, Section/Clip |

Both were built the same way: the mode is registered, and `'mode:<id>'` is APPENDED to the
`hiddenIn` array of every element that goes away. No rule is rewritten and no element is removed,
which is what keeps the HMI workspace element-identical (pinned by
`tests/hmi-mode-regression.test.tsx`).

The `button-group` row is the one that reads backwards, and it caught the plan-423 review. In a
focused mode ButtonPanel hides every entry WITHOUT a rule (see the host table in §2), so the
operator buttons disappear from `commissioning` by themselves — while the TOOLS had to opt IN:
`SignalBindPlugin` extends its `shownOnlyInAny` list, `TestAxesPlugin` gained a `hiddenIn` naming
the four modes where the auto-hide used to do the job (a positive list would have removed it from
the no-mode CONNECT embed), and Measure/Clip already carried rules that admit the new mode.

Registration happens *after* all plugins are registered, so the dropdown reflects the full set;
the active mode is applied only after the model loads. That ordering is exactly why a positive
`shownOnlyInAny` gate fails closed before mode boot — see §2.

---

## 2. The three cases

### Case 1 — A plugin's own UI slot

Declare `modes` on the plugin; the registry gates the slots for you. You do not write a
`visibilityRule` by hand.

```typescript
class LayoutPlannerPlugin implements RVViewerPlugin {
  readonly id = 'layout-planner';
  readonly modes: ModeId[] = ['planner'];       // runtime AND UI limited to planner
  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: PlannerButtons },
  ];
}
```

`register()` rewrites that slot entry to carry `shownOnlyInAny: ['mode:planner']` and assigns a
`visibilityId` if none is set (HMIShell only applies a rule when a `visibilityId` exists).

> **Hosts do not all filter alike.** The same rule means different things depending on who
> evaluates it, which is why "I set a rule and nothing happened" is a recurring surprise:
>
> | Host | A slot entry with NO rule |
> |---|---|
> | `SlotRenderer` (`HMIShell.tsx`) | visible — and a rule is applied **only** when `visibilityId` is set |
> | `ButtonPanel` | visible only when the active mode is `hmi` or none |
> | `ActivityBar`, `MessagePanel` | always visible |
> | `PluginSettingsTabs` | always visible (filters since plan-387; before that it ignored rules entirely) |
> | `KpiBar` | always visible — **it does not filter at all**; gate the whole bar instead |
>
> Consequence for `button-group`: a ruleless entry is already hidden outside `hmi`. Declaring
> `modes` on such a plugin *un*-hides it in DES/Planner/Editor. Leave it alone.

**`hiddenIn` vs `modes`.** `modes` compiles to `shownOnlyInAny`, a POSITIVE list: it fails
**closed** whenever no `mode:*` context is active — before the mode-boot block (it runs only
after the model loads) and in the CONNECT embed path, which skips mode boot entirely. For
"available everywhere except one workspace", write `hiddenIn: [modeContext('x')]` on the entry,
which fails **open**. Use `modes` when you also want the plugin's runtime off in that mode.

To keep the runtime alive everywhere while showing the UI in one mode only, add `core`:

```typescript
readonly core = true;                            // participates in every mode
readonly modes: ModeId[] = ['hmi'];              // slots visible only in hmi
```

This is the combination worth remembering — see §4 for why it is deliberate.

### Case 2 — A chrome element (not owned by a plugin)

Elements that belong to the shell itself (`TopBar`, `ActivityBar`, help entry points, …) are not
slot entries, so no plugin compiles a rule for them. They register their own rule through the
hook:

```typescript
const visible = useUIVisible('help', { hiddenIn: ['kiosk'] });
if (!visible) return null;
```

The rule passed to `useUIVisible` is a **code-declared default**. It is registered once, on first
call, and a deployment override wins over it (§3).

### Case 3 — Runtime only, no UI

A data-only plugin has no `slots`. Axis B never applies; only `modes`/`core` matter.

---

## 3. Rule evaluation and deployment overrides

A `UIVisibilityRule` combines its keys with AND at evaluation time. `evaluateVisibilityRule()`
(`ui-context-store.ts`) checks them in this order — `shownOnlyInAny` **first**, which matters
because that is the key `plugin.modes` compiles into: a mode gate rejects before any hand-written
`shownOnlyIn` or `hiddenIn` is even looked at.

| # | Key | Semantics |
|---|---|---|
| 1 | `shownOnlyInAny` | Visible only when **AT LEAST ONE** listed context is active (OR) |
| 2 | `shownOnlyIn` | Visible only when **ALL** listed contexts are active |
| 3 | `hiddenIn` | Hidden when any listed context is active |

An empty rule is always visible. Mode contexts are namespaced as `mode:<id>` (`modeContext()`),
which is what keeps them from colliding with free-form contexts like `'fpv'` or `'kiosk'`.

**Deployment overrides.** A deployment can override any registered element by `visibilityId`
through `ui.visibilityOverrides` in its settings (`rv-app-config.ts`, applied in `main.ts`):

```json
{
  "ui": {
    "visibilityOverrides": {
      "help": { "hiddenIn": ["kiosk"] }
    }
  }
}
```

Config overrides beat the code-declared defaults from `useUIVisible` — because `useUIVisible`
registers its rule only if the id is not already known, while `main.ts` applies the overrides at
startup.

> **`registerUIElement` itself overwrites UNCONDITIONALLY** (it only short-circuits when handed the
> *identical rule object*, to avoid a render loop). Two callers use it for compiled slot rules —
> `SlotRenderer` (`HMIShell.tsx`) and `PluginSettingsTabs` — and both re-register on **every
> render**. So for an id that belongs to a slot entry, the compiled `modes` rule wins over
> `ui.visibilityOverrides`: the deployment override is written once at startup and then
> overwritten on the next render. A deployment can only reliably override ids registered through
> `useUIVisible` (chrome elements) — for a plugin's slot entry, change the plugin's `modes` or
> hand-write a `hiddenIn` on the entry instead.

### Checking a delivery's view on the dev server (plan-615)

Overrides are applied **once, at boot** — and they cannot be taken back at runtime: the store has
no "unregister", and the code default of an overridden id was never registered (see above). That
is why the dev toolbar's **View** switch (`doc-web-debugging.md` § 4g) does not toggle overrides
live; it **reloads** the page with a different config:

- **Delivered** — the loaded config with its view keys applied (`mode.lock`, `lockSettings`,
  `lockedTabs`, `ui.initialContexts`, `ui.visibilityOverrides`); when the loaded config has none,
  the HMI-only profile `{ mode: { lock: "hmi" }, lockSettings: true }`.
- **Dev** — the loaded config with those keys removed: every mode, every panel.

The choice lives in sessionStorage (`rv-view-profile`) or, for one boot, in `?view=`; without
either the boot applies the loaded config unchanged. `src/core/rv-view-profile.ts` holds the rule;
`main.ts` applies it before `setAppConfig()` and before the mode lock, dev server only. The dev
entry is the activity bar's last entry in both views, so it is also the way back from the delivered
view. Only when no activity bar is mounted (e.g. the delivered config hides it) does a small handle
at the bottom-left edge (`data-testid="dev-handle"`) take its place.

### The one non-obvious rule: `shownOnlyInAny` is replaced, not merged

`register()` writes the compiled mode rule with a spread (`rv-ui-registry.ts`):

```typescript
entry.visibilityRule = { ...entry.visibilityRule, shownOnlyInAny: modeAny };
```

Consequently:

- **Other keys survive.** A `shownOnlyIn` or `hiddenIn` you set on the slot entry is preserved and
  AND-combines with the mode gate.
- **A pre-existing `shownOnlyInAny` is overwritten.** The plugin's `modes` win outright; the
  entry's own OR-list is silently discarded.

Do not hand-write a `shownOnlyInAny` on a slot entry of a plugin that declares `modes` — it will
not survive. This behaviour is pinned by `registry_ShownOnlyInAny_IsOverwritten` and
`registry_OtherRuleKeys_Preserved` in `tests/rv-mode-visibility.test.ts`. It is documented, not
endorsed; changing it is a separate decision (see plan-388).

---

## 4. Why two axes — deliberately separate

The obvious "cleanup" is to collapse the axes: if a plugin is not visible in a mode, why run it?
That refactor would break working behaviour, and the reason is concrete.

**A camera plugin whose button is invisible must still run.** `camera-startpos` restores a
stored camera position on model load and keeps it in sync. Its toolbar button belongs in one mode
only — an operator HMI has no business exposing a camera-authoring control — but its *runtime*
must participate in every mode, or a mode switch would silently drop camera state. Recorders,
physics and drive-sorting plugins have exactly the same shape: essential infrastructure, optional
or mode-specific chrome.

Merging the axes forces a false choice between "runs and is visible" and "neither". The split is
what lets `core: true` + `modes: ['hmi']` express the case that actually occurs. Keep them
separate.

If a future change does merge them, it must first answer what happens to every `core` plugin that
carries a `modes` list — that is the set this document exists to protect.

---

## 4.5 A third reason a slot can be missing: the user switched the plugin off

The two axes above explain a slot that is *hidden*. Since plan-435 there is a third cause, and it
is different in kind: the slot is not hidden, it is **not registered at all**.

`setPluginUserEnabled(id, false)` calls `uiRegistry.unregister(id)`, so every slot entry of that
plugin leaves the registry. Switching the plugin back on calls `register(plugin)` again, which is
idempotent (it unregisters first) and restores the original position, because the registry keeps a
stable per-plugin sequence number and sorts by `(order, seq, declaration index)`.

Two consequences worth knowing:

- **The override survives a reload** (persisted per project under `rv-plugin-overrides/<scope>`),
  so "the button was there yesterday" is a real possibility. Check the Features tab in Settings, or
  boot with `?resetPlugins=1`.
- **`register()` no longer mutates the plugin's own slot objects.** It normalises a shallow copy,
  so registering twice always starts from the plugin's pristine declaration and the `modes` gate
  cannot be applied cumulatively. Anything reading `plugin.slots[i].pluginId` or `.visibilityId`
  after registration was reading a side effect that no longer happens — read the registry instead.

---

## 5. The other visibility axes (named, not covered here)

Visibility in realvirtual WEB is decided in more places than the two above. These are out of
scope for this document and are listed only so nobody assumes the taxonomy here is complete:

| Store | Governs |
|---|---|
| `src/core/overlay-visibility-store.ts` | 3D-overlay categories drawn over/inside the scene |
| `src/core/hmi/group-visibility-store.ts` | Hidden / isolated scene groups (persisted) |
| `src/core/hmi/hmi-visibility-store.ts` | The HMI overlay as a whole (on/off, persisted) |

The full taxonomy across all of these is plan-388; this document covers only the plugin/mode axis
and the UI-context axis.

---

## 6. Other consumers of the same semantics

`core`/`modes` is read in more than one place. When the semantics change, these change with it:

- `computeModePluginSets()` (`rv-mode-manager.ts`) — enable/disable and hook sets per transition
- `RVViewer.pluginsForMode()`, `.use()`, `.setPluginUserEnabled()`,
  `._notifyPluginsModelLoaded()` (`rv-viewer.ts`)
- **The feature matrix in the private repo** (`build-feature-matrix.ts`,
  `feature-matrix-plugin.tsx`) — it projects the same `core`/`modes` semantics into a
  user-visible table, so a change here shows up there as wrong rows

---

## 6.5 Authoring tools: the `planner` context is "authoring is live"

The layout planner runs in TWO workspace modes, `planner` and `des` (`AUTHORING_MODES`,
`layout-planner/authoring-modes.ts`), because DES is where material-flow layouts are built. Its
`setActive` sets the legacy UI context `'planner'` in **both** — so that context means
*"layout authoring is live"*, **not** *"Planner mode is selected"* (that is `mode:planner`). A
toolbar entry with the bare rule `{ shownOnlyIn: ['planner'] }` therefore shows in DES too, which
reads like a bug and is not one.

Authoring tools say what they mean with the named rule:

```typescript
import { AUTHORING_TOOL_RULE, AUTHORING_LIVE_CONTEXT } from '../layout-planner/authoring-modes';

{ slot: 'button-group', component: SnapFlyout, group: 'model',
  visibilityRule: { ...AUTHORING_TOOL_RULE } }   // authoring live AND mode planner|des
```

`AUTHORING_TOOL_RULE` = `shownOnlyIn: [AUTHORING_LIVE_CONTEXT]` + `shownOnlyInAny: ['mode:planner', 'mode:des']`.
The context string is not renamed (snap-point's mode handling, the magnetic arming and the chain
preview read it).

**Signal linking in DES (plan-2010).** The two signal toolbar buttons (link-mode toggle, bindings
overview) use `SIGNAL_LINK_TOOLBAR_CONTEXTS` — the link-mode list **without** `des`
(`signal-link-gate.ts`). Linking itself stays available in DES (inspector slot rows,
drag-linking, the "Link signal…" context entry follow `SIGNAL_LINK_MODES`). Because the switch is
not on screen there, a link mode that was left on **rests** in DES: `SignalBindPlugin` follows
`mode-changed` and calls `setSignalLinkModeSuspended(true)`, so `active` is false (no badges,
normal object tooltips) while the stored switch (`explicit`, localStorage) is untouched; it
applies again as soon as the mode changes. A running inspector drag-link still counts.

---

## 6.6 CONNECT panel: lazy chunk, eager boot effects (plan-2035)

`ConnectPanel` (the CONNECT left window) is a lazy chunk. `App.tsx` renders the small eager
`ConnectPanelHost` at all three places (full shell, CONNECT embed shell, recording shell); the
panel body loads on first need and then stays mounted (`hasLoaded || wanted`, the plan-344 pattern),
so dialogs and expanded interfaces survive close/reopen.

- **Wanted** = the panel is open, or an Edit request is pending (`snap.editInterfaceId`). The panel
  consumes the request exactly once when it mounts.
- **Preload** (chunk fetch only, nothing rendered): hover/focus of the CONNECT toolbar button
  (`ConnectToolbarButton`) and once the gateway is `connected`.
- **Closed-panel behaviour is unchanged.** What used to run inside the always-mounted panel now
  lives in `useConnectPanelBootEffects` (host, eager): `ensureInterfaceTypes()` and the bridge-cache
  load on `connected` (single owner; the panel only reads the cache). The status poll stays with
  `ConnectStatusPoll` in `connect-plugin.tsx`.
- **Failure**: `LazyPanelBoundary` (`visible={open}`) shows loading/error only while the panel is
  open; reopening after a failed import retries with a fresh `lazy()` instance (`attempt` + boundary `key`).
- **Recording**: `connect-panel-readiness.ts` (`pending` → `committed` / `failed`). `captureHmiSettle`
  waits for the panel's first commit (10 s timeout, import failure and abort reject with the cause);
  `enterRecordingHmi` marks it pending synchronously when it opens `connect`.
- **Shared pieces** (`ConnectDownloadLinks`, `interfaceEndpointLabel`, `interfaceTypeLabel`) live in
  `connect-panel-shared.tsx`, which must never import `ConnectPanel.tsx`; `ConnectPanel.tsx` re-exports them.


### Path-network controller (plan-2036)

`path-network-interaction.ts` (the planner's pointer/keyboard controller for path networks) is a lazy
chunk too. `PathNetworkUiPlugin.init()` starts `import('./path-network-interaction')` at boot and creates
`PathNetworkInteraction` when it lands; `interaction` is `null` until then. `whenInteractionReady()`
resolves with the controller (or `null` after dispose / import failure) and `subscribeInteraction(cb)`
feeds `useSyncExternalStore` in `PathNetworkToolbar` and `SnapPointPickerPopup`. After loading,
`syncLibrary()` runs again so the path-block catalog and the marquee provider also appear when an
authoring mode was entered before the import finished. `onRender` / `onModelCleared` are no-ops until
loaded. Constants the toolbar needs (`PATH_BLOCK_DRAG_TYPE`) live in `path-network-shared.ts`.
Tests replace the loader through `setPathNetworkInteractionLoaderForTests`.

### Layout planner chunk (plan-2037)

`plugins/layout-planner` is no longer in the demo entry: `init()` in `main.ts` starts
`import('./plugins/layout-planner')` right after `initFragmentSecret()` (still the first statement) and
awaits it just before `RVViewer.create`. Consent, password gate and published presets run while the
chunk downloads; nothing is lazy-on-demand, the boot still waits for it. The plugin chain is unchanged:
`.use(new LayoutPlannerPlugin(), 'core')` keeps its position. The rejection is handled immediately (no
unhandled rejection while a dialog is open); if the await fails, `init()` shows `showLoadingError`, wires
both splash buttons to `location.reload()` and returns without a viewer. `LayoutLibraryPanelHost` lives in
that chunk, so its lazy `LayoutLibraryPanel` import is emitted there. Guards:
`tests/bundle-splitting.test.ts` (plan-2037 block, T3) and `tests/planner-chunk-boot.node.test.ts`.

## 7. Checklist before you change any of this

- Changing a plugin's `modes` or `core`? Check both axes — participation *and* the compiled slot
  rule. They are not the same switch.
- Adding a slot entry to a plugin that declares `modes`? Do not set `shownOnlyInAny` yourself.
- Adding a toolbar tool for layout authoring? Use `AUTHORING_TOOL_RULE`, not the bare `shownOnlyIn: ['planner']` (§6.5), and give it a `group`.
- Gating a chrome element? Use `useUIVisible(id, rule)` with a stable `id`, so a deployment can
  override it.
- Changing `register()`'s compile step? `tests/rv-mode-visibility.test.ts` is the specification —
  if those tests still pass after a semantic change, the change was not covered.

### HMI overlay switch

Press **H** or use the eye button to toggle the entire HMI overlay. The choice is
stored in `localStorage['rv-hmi-visible']`. Open a link with `?hmi=0` to start
with the overlay hidden, or `?hmi=1` to force it visible. This URL override takes
precedence over the stored choice without writing to localStorage. Unknown values
are ignored. H continues to toggle visibility and persist the choice as usual.
