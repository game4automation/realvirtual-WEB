# Signal Connection Logic

## Overview

Signal connections link a component slot in the 3D model to a signal supplied
by an interface. A slot is the fixed connection point on a component, such as
**Forward**, **TargetSpeed**, **SensorOccupied**, or **CurrentPosition**. A
signal is the live Boolean, integer, or floating-point value exchanged with a
PLC or another interface.

Each slot has a fixed direction and value type. Command slots (PLC outputs)
receive values from an interface. Feedback slots (PLC inputs) publish values
from the simulation to an interface. The direction is declared by the
component schema and cannot be reversed from the UI.

## Where slot rows appear

There is no separate signal-linking panel. Every declared slot renders as one
`SignalSlotRow` on two surfaces, both built from the same shared row-model
builder (`slot-row-models.ts`), so they always show identical slots and states:

- **Property Inspector** — inline inside the owning component section
  (`InlineSignalSlots.tsx`, rows from `rv-signal-slot-row.tsx`).
- **3D badge popover** — the popover opened from an element's signal badge in
  the scene (`SignalBindPopover.tsx`).

A row reads left to right as `slot name · assignment · [link icon] · linked
signal`. The left cell is always the slot name; the right cell is always the
assignment — a model signal chip, a CONNECT signal chip, or `– not linked`.

## Turn on Signal linking first

Clicking an element in the scene only opens its binding popover while **Signal
linking** is active. `SignalBindPlugin` gates its `object-clicked` handler on
`isSignalLinkModeActive()` and returns early otherwise — without the mode, a
scene click does nothing at all for binding.

The mode is active when either of these holds:

- the **Signal linking** toggle in the button group is on
  (`SignalLinkModeButton`, contributed by `SignalBindPlugin` as a
  `button-group` slot at order 64; available in the hmi, planner, des and
  editor modes). The toggle is persisted under the `rv-layout-signal-link-mode`
  key, so it survives a reload.
- a signal drag is currently running — a drag implies the mode for its
  duration.

The Property Inspector rows are always reachable without the mode; the mode
gates the 3D click path.

## Slot states

- **Not linked** shows `– not linked` in the assignment cell. The component
  uses its authored or internal behavior.
- **Model signal** shows the signal stored in the model. It can be monitored
  and forced because it exists in the model's signal store.
- **Linked to a model signal** — a mapping with `sourceKind: 'internal'`. It
  relays from a SignalStore model signal into the slot; the GLB is never
  rewritten. If that model signal is itself fed from CONNECT, the row shows the
  chain (`slot ← internal ← CONNECT`).
- **Linked to a CONNECT signal** — a mapping with `sourceKind: 'connect'`
  (the default for mappings persisted before the field existed). Command slots
  receive from the interface, feedback slots publish to it.
- **No model signal** — a command or feedback slot the component exposes
  without a stored model signal (`direct-property` / `direct-feedback`
  internally). The row simply shows no model-signal chip; the word "Direct"
  never appears in the UI. Its row tooltip states that values go straight to
  the component and that forcing is therefore unavailable.
- **Unavailable** is dimmed and includes a reason. The component declares the
  slot but does not provide the runtime command or feedback contract required
  to connect it. The row still accepts a pointer so it can state that reason.

A bound row additionally carries at most **one** status token, resolved by
priority (`resolveSlotStatusToken`): `conflict`, `remote`, `forced`,
`disconnected`, `pending`, `live · hold`, `live · local`, `bound`. A plainly
live binding shows no token — both chips already display their live value.
Element-level status uses its own wording (`BINDING_STATE_LABEL`): `Not
linked`, `Live controlled`, `Pending — waiting for CONNECT`, `Source
disconnected`, `Conflict`.

There is no separate "silent adoption" state. A saved binding whose provider is
not yet available starts as `pending` and becomes `live` (`SlotLiveness`) once
the provider reconnects — no model signal is created on the way.

## Connect a signal

1. Switch **Signal linking** on if you want to bind from the 3D scene.
2. Select the component. Its slot rows appear in the Property Inspector
   section; clicking the element's badge opens the same rows in the popover.
3. Find the required command or feedback slot.
4. Either select the link icon and choose a signal from the picker, or
   Shift+drag a compatible signal chip onto the row.
5. Check the status token. `live` (or no token) confirms the provider is
   connected; `pending` means the saved provider or signal is not currently
   available.
6. To replace a connection, choose or drop another compatible signal on the
   same row.
7. To remove one connection, select its unlink icon.

The picker (`SignalSearchOverlay`) offers two groups: **CONNECT (live)** from
the connect store, and **Model signals** from the SignalStore — the slot's own
target signal is excluded. Auto-assign suggests only confident matches (exact,
or token confidence ≥ 0.75) and never assigns unavailable slots.

### Drag mechanics

Signal chips are dragged with Shift held (`signal-drag-store.ts`):

- **Shift+pointerdown** on a chip arms a drag (`armed`).
- Moving **4 px** (`SIGNAL_DRAG_THRESHOLD_PX`) promotes it to `dragging`;
  releasing below that threshold is a plain Shift+click that neither forces nor
  drags.
- While dragging, only compatible drop targets are highlighted — the drop
  overlay caps at `MAX_HIGHLIGHTS = 50` markers and magnets the pointer to the
  nearest port within `NEAREST_MAGNET_RADIUS_PX = 42`
  (`drop-target-overlay.ts`).
- Hovering the 3D scene auto-opens the target element's popover after
  `AUTO_OPEN_DEBOUNCE_MS = 250` ms, so the drop can land directly on a slot row
  (`scene-drag-open.ts`; raycasts throttled to 50 ms, the magnet target wins
  over the raycast). Leaving without dropping closes an auto-opened popover
  again; a successful drop keeps it open.
- **ESC** cancels the drag without dropping.

### Compatibility rules

`slotRejectReason()` in `drop-accept.ts` is the single rule behind every
verdict — drag hover, drop, picker click and picker Enter all call it. It
reports the **first** failing cause:

| Order | Reason | Cause |
|-------|--------|-------|
| 1 | `unavailable` | the slot has no runtime contract |
| 2 | `no-provider` | a CONNECT payload without provider identity (an internal model signal legitimately has none) |
| 3 | `type` | Bool↔bool, Int↔int, Float↔float, **plus an Int signal on a Float slot**; a Float signal on an Int slot stays rejected, and an underivable PLC type is rejected |
| 4 | `direction` | a PLC `output` binds only to a command slot, an `input` only to a feedback slot; `unknown` is rejected |

Type compatibility is therefore not strict equality: an Int signal is accepted
by a Float slot (`kindFitsSlot`), matching what the binding manager and the
CONNECT gateway's `SignalCoercion.IsAllowed` already permit — real PLCs address
drive setpoints as DINT.

### Remove every link of a component

**Unbind all** is not a panel control; it is a component-section action
registered in `componentActionRegistry` (`component-bulk-actions.ts`), next to
**Auto-assign**. It is scoped to that section's component, not the whole placed
element, and uses a two-click confirm: the first click arms it
("Confirm unbind all", 3 s window), the second executes.

### First link changes who drives the model

The first mapping written through the UI raises a one-time overlay
(`first-link-notice.ts`). Claiming a slot sets `liveControlled` on the drive,
which stops the model's internal control for it — in the demo model that halts
the whole LogicStep sequence and the recorded-drive replay, because playback
bails out as soon as one recorded drive is live controlled. Restoring persisted
mappings on model load does not trigger the notice.

## What is saved

A persisted `SignalMapping` carries the sink kind, component path, slot,
`sourceKind` (`connect` | `internal`), signal name, interface id, optional
topic, direction, and whether the binding is enabled. The record is identified
by `componentPath` + `kind` + `slot`.

Runtime values, connection state, temporary suggestions, and forced values are
not part of the mapping. Empty slots remain empty in the model: linking them
does not add signal nodes or component references, and assigning an internal
signal adds a runtime relay instead of rewriting the authored destination.

## Force limits

Force holds the value of a real signal in the model's signal store. It does not
apply to command or feedback slots that have no model signal, because there is
nothing stored to hold. To force such a value, explicitly add and wire a model
signal first, then force that signal.

## Troubleshooting

- **Pending — waiting for CONNECT:** Start or reconnect the selected interface
  and verify that it still exposes the saved signal and topic.
- **Conflict:** More than one provider exposes the same signal, or two feedback
  slots try to publish to the same provider signal. Choose an unambiguous
  provider or a different feedback target.
- **Unavailable:** Update the component implementation or choose another slot.
  The reason shown in the row identifies the missing command or feedback
  capability.
- **A signal cannot be dropped:** The row tooltip quotes the exact reason
  (`dropRejectText`) — type, direction, missing provider identity, or an
  unavailable slot.
- **Clicking an element in the scene does nothing:** Signal linking is off.
  Switch it on in the button group.
- **A slot without a model signal cannot be forced:** This is expected. Such
  slots create no model signal.
- **A command stops after disconnect:** The component neutralises the lost
  command after the simulation-time hold. Reconnect the provider or remove the
  stale binding. Feedback bindings are never neutralised.

## See Also

For the engine-level data flow and component contracts, see
[Signal Architecture](doc-signal-architecture.md).
