# UI Visibility — Which Axis Decides What

Two independent mechanisms decide whether you see something in realvirtual WEB, and they are
routinely confused for one another. This document exists because that confusion has already
produced two discarded designs: a "shell contract" and a "UI/runtime separation" were both
designed from scratch before anyone found `UIPluginRegistry.register()`, where the mechanism already
lived. One of those detours alone would have cost ~6h.

The knowledge that was missing is a single sentence:

> **`core: true` + `modes: [...]` = "the runtime runs always, the UI appears only in the listed
> modes".**

Neither docstring was wrong. They were each locally complete and simply did not point at each
other, so the rule that lives *between* them was invisible.

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

Six workspace modes are registered in `main.ts`, in this order. A mode's UI context id is
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

## 7. Checklist before you change any of this

- Changing a plugin's `modes` or `core`? Check both axes — participation *and* the compiled slot
  rule. They are not the same switch.
- Adding a slot entry to a plugin that declares `modes`? Do not set `shownOnlyInAny` yourself.
- Gating a chrome element? Use `useUIVisible(id, rule)` with a stable `id`, so a deployment can
  override it.
- Changing `register()`'s compile step? `tests/rv-mode-visibility.test.ts` is the specification —
  if those tests still pass after a semantic change, the change was not covered.
