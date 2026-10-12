# Operator panel (WebOperatorPanel)

An operator panel is a window of IEC control-box devices — illuminated push buttons,
two-position selector switches, emergency stops, a stack light, title-bar chips and a
status line — described entirely as **JSON data** in a `WebOperatorPanel` component on
any node of the model. No code: the viewer opens one window per component (main model and
placements), buttons write PLC **inputs**, lamps show PLC **outputs**, and the panel travels
with the GLB. Behaviour stays in the PLC / logic; the panel only writes its input signals and
shows signal states.

## Build one (MCP, as an AI would)

1. `web_signal_list` — the signal NAMES the panel will read and write (inputs for buttons,
   selectors, E-stops; outputs for lamps, stack light, status rules). Every name must exist.
2. `web_editor_open` — open the document in the asset editor (`source=library`).
3. `web_editor_create_empty(name="OperatorPanel")` — a dedicated node (any node works).
4. `web_editor_add_component(path="OperatorPanel", type="WebOperatorPanel")`
5. `web_editor_set_field(path="OperatorPanel", componentType="WebOperatorPanel",
   fieldName="Config", valueJson=<the config as a JSON STRING>)` — `valueJson` is parsed as
   JSON, so pass the config **string-encoded** (`"{\"version\":1,…}"`, i.e.
   `JSON.stringify(JSON.stringify(config))`). A raw object is tolerated, but the string is the
   stored form. Optional fields: `Title`, `Dock`, `StartCollapsed`.
6. Check: the window appears at once; a config problem shows in the window, in the
   Problems panel and in `web_component_get(path, "WebOperatorPanel")`. Fix and set again.
7. `web_editor_save` — stored in the GLB; after a reload the window is back.

## Component fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `Title` | string | "" | Window title; empty = `title` of the config |
| `Config` | string | "" | The panel JSON below |
| `Dock` | top-left / top-right / bottom-left / bottom-right | top-left | Corner the window first appears in when the config has no `position`; panels in one corner stack |
| `StartCollapsed` | bool | false | Start collapsed to the title bar (chips, stack light and E-stop stay reachable) |

## Config schema (version 1)

```text
{
  "version": 1,                 required, always 1
  "id": "cell-panel",           required, unique per model (window id, remembered position)
  "title": "Operator panel",    required
  "width": 300,                 px, default 300
  "position": { "x": 80, "y": 100 },   optional; wins over Dock
  "columns": 3,                 grid columns, default 3
  "buttons":    [ Button ],     required (may be [])
  "selectors":  [ Selector ],   required (may be [])
  "estops":     [ EStop ],      required (may be [])
  "stackLight": [ Segment ],    required (may be []), top to bottom
  "chips":      [ Chip ],       optional
  "status":     [ StatusRule ], required; the first rule whose "when" holds wins
  "restart": { "hint": "...", "steps": ["...", "..."] },   optional
  "headerEstop": 0              E-stop index kept in the collapsed title bar
}
```

Every device has a grid cell `row`, `col` (1-based, `col` <= `columns`). Devices with the
same cell stack in it (e.g. a key switch above a mode knob), separated by a hairline.

- **Button** — `label` (accessible name), `legend` (plate text, default label), `signal`
  (input: true while held, false on release), `capColor`, optional `lamp`, optional
  `separated: true` (hairline on the cell's left edge, e.g. an immediate stop).
- **Selector** — `label`, `caption` (default label), `variant`: `knob` | `key`, `signal`
  (latched), `positions`: exactly two `{ "legend": "Hand", "value": false }` (left, right),
  optional `lamp`.
- **EStop** — `label`, `signal`, `normallyClosed` (default true: pressed writes **false**,
  released writes true; releasing needs a short hold), optional `lamp`.
- **Lamp** — `{ "signal": <output>, "color": <lamp colour>, "simDriven": false?, "flashWhen": Condition? }`.
  `simDriven: false` = the simulation never writes this lamp (drawn "not driven" in
  Simulation mode). `flashWhen` flashes it (2 Hz) while the condition holds.
- **Segment** (stack light) — `name`, `signal`, `color`, optional `simDriven`.
- **Chip** — `label`, `text`, `when`: Condition, `tone`: `warn` (default) | `neutral`.
- **StatusRule** — `kind` (stable id, e.g. `fault-estop`), `tone`: `ok` | `neutral` |
  `action` | `fault`, `text`, optional `icon` (`check`, `hourglass`, `play`, `error`,
  `warning`, `info`; default by tone), optional `step` (1-based index into `restart.steps`,
  shown as the step counter), optional `when`. A rule without `when` always holds — put it last.

### Conditions (status rules, chips, flashWhen)

```text
{ "signal": "i_SS_ESTOP1", "is": false }        equality on a boolean signal
{ "all": [ Condition, ... ] }                   AND (non-empty)
{ "any": [ Condition, ... ] }                   OR (non-empty)
{ "not": Condition }                            NOT
```

## IEC colour rules (IEC 60204-1 §10.2 / §10.3)

Cap colours (`capColor`): `red`, `yellow`, `green`, `blue`, `white`, `black`.

| Function | Cap |
|---|---|
| Emergency / immediate stop | `red` (E-stops are drawn red on yellow automatically) |
| Start / on | `white` (preferred), `green`, `black`; never `red` |
| Stop / off | `black` (preferred), `white`; `red` only away from emergency devices |
| Reset / acknowledge (mandatory action) | `blue` |
| Intervention in an abnormal condition | `yellow` |

Lamp colours (`lamp.color`, stack light): `red` emergency / fault, `yellow` abnormal /
warning, `blue` mandatory action, `green` normal / running, `white` neutral information.
The lamp ring shows the colour of the OUTPUT it is wired to — a black "Auto stop" cap may
carry a blue lamp.

## Minimal example

```json
{
  "version": 1, "id": "cell-panel", "title": "Cell",
  "buttons": [
    { "label": "Start", "signal": "S_Start", "capColor": "green", "lamp": { "signal": "L_Run", "color": "green" }, "row": 1, "col": 1 },
    { "label": "Stop", "signal": "S_Stop", "capColor": "black", "row": 1, "col": 2 }
  ],
  "selectors": [], "estops": [], "stackLight": [],
  "status": [
    { "kind": "running", "tone": "ok", "text": "RUNNING", "when": { "signal": "L_Run", "is": true } },
    { "kind": "idle", "tone": "neutral", "text": "READY" }
  ]
}
```

## Full example (Laser Welding Assembly Station demo)

Six illuminated buttons, a key switch and a mode knob stacked in one cell, two E-stops, a
four-segment stack light, a HAND chip, a fault-first status list and a three-step restart:

```json
{
  "version": 1,
  "id": "laserwelding-operator-panel",
  "title": "Operator panel",
  "width": 300,
  "position": { "x": 80, "y": 100 },
  "columns": 3,
  "buttons": [
    { "label": "Auto start", "signal": "BT4_AutoStart", "capColor": "green", "lamp": { "signal": "BT4_AutoLight", "color": "green" }, "row": 1, "col": 1 },
    { "label": "Auto stop", "signal": "BT5_AutoStop", "capColor": "black", "lamp": { "signal": "BT5_AutoStopLight", "color": "blue" }, "row": 1, "col": 2 },
    { "label": "Immediate stop", "signal": "BT8_ImmediateStop", "capColor": "red", "lamp": { "signal": "BT8_ImmediateStopLight", "color": "red" }, "row": 1, "col": 3, "separated": true },
    { "label": "Single step", "signal": "BT3_SingleStep", "capColor": "white", "lamp": { "signal": "BT3_SingleStepLight", "color": "green", "simDriven": false }, "row": 2, "col": 1 },
    {
      "label": "Acknowledge", "legend": "Ack", "signal": "BT6_Ack", "capColor": "blue",
      "lamp": {
        "signal": "BT6_ErrFltLight", "color": "red",
        "flashWhen": { "all": [
          { "any": [ { "signal": "SignalTower_Red", "is": true }, { "signal": "BT6_ErrFltLight", "is": true } ] },
          { "signal": "i_SS_ESTOP1", "is": true },
          { "signal": "i_SS_ESTOP2", "is": true }
        ] }
      },
      "row": 2, "col": 2
    },
    { "label": "Home position", "legend": "Home", "signal": "BT7_Reset", "capColor": "white", "lamp": { "signal": "BT7_HomingLight", "color": "green", "simDriven": false }, "row": 2, "col": 3 }
  ],
  "selectors": [
    {
      "label": "Control", "variant": "key", "signal": "BT1_ControlOnOff",
      "positions": [ { "legend": "0", "value": false }, { "legend": "I", "value": true } ],
      "lamp": { "signal": "BT1_ControlLight", "color": "green" },
      "row": 3, "col": 2
    },
    {
      "label": "Mode", "variant": "knob", "signal": "BT2_OpMode",
      "positions": [ { "legend": "Hand", "value": false }, { "legend": "Auto", "value": true } ],
      "row": 3, "col": 2
    }
  ],
  "estops": [
    { "label": "E-stop 1", "signal": "i_SS_ESTOP1", "lamp": { "signal": "q_SS_ESTOP1", "color": "yellow" }, "row": 3, "col": 1 },
    { "label": "E-stop 2", "signal": "i_SS_ESTOP2", "lamp": { "signal": "q_SS_ESTOP2", "color": "yellow" }, "row": 3, "col": 3 }
  ],
  "stackLight": [
    { "name": "Blue", "signal": "SignalTower_Blue", "color": "blue" },
    { "name": "Red", "signal": "SignalTower_Red", "color": "red" },
    { "name": "Yellow", "signal": "SignalTower_Yellow", "color": "yellow", "simDriven": false },
    { "name": "Green", "signal": "SignalTower_Green", "color": "green" }
  ],
  "chips": [
    { "label": "Operating mode: Hand", "text": "HAND", "when": { "signal": "BT2_OpMode", "is": false }, "tone": "warn" }
  ],
  "status": [
    { "kind": "fault-estop", "tone": "fault", "text": "FAULT: release E-stops 1 + 2", "step": 1,
      "when": { "all": [ { "signal": "i_SS_ESTOP1", "is": false }, { "signal": "i_SS_ESTOP2", "is": false } ] } },
    { "kind": "fault-estop", "tone": "fault", "text": "FAULT: release E-stop 1", "step": 1, "when": { "signal": "i_SS_ESTOP1", "is": false } },
    { "kind": "fault-estop", "tone": "fault", "text": "FAULT: release E-stop 2", "step": 1, "when": { "signal": "i_SS_ESTOP2", "is": false } },
    { "kind": "fault-ack", "tone": "fault", "text": "FAULT: press ACK", "step": 2,
      "when": { "any": [ { "signal": "SignalTower_Red", "is": true }, { "signal": "BT6_ErrFltLight", "is": true } ] } },
    { "kind": "stopping", "tone": "neutral", "text": "STOPPING…", "when": { "signal": "SignalTower_Blue", "is": true } },
    { "kind": "auto", "tone": "ok", "text": "AUTO", "when": { "signal": "SignalTower_Green", "is": true } },
    { "kind": "start", "tone": "action", "text": "STOPPED: press AUTO START", "step": 3 }
  ],
  "restart": {
    "hint": "After a stop: 1 Release the E-stops · 2 Acknowledge · 3 Auto start",
    "steps": ["Release the E-stops", "Acknowledge", "Auto start"]
  },
  "headerEstop": 0
}
```

## Common mistakes

- **Signal not found** — every name (also inside conditions) must exist; the message names
  the JSON path, e.g. `buttons[3].signal 'BT9' not found in model`. Use `web_signal_list`.
- **Config set as an object instead of a string** — tolerated, but store the string form
  (string-encode `valueJson`).
- **Not JSON** (trailing commas, comments, single quotes) — the inspector field never applies
  it; an MCP write shows `Config is not valid JSON: ...` in the window.
- **Missing required arrays** — `buttons`, `selectors`, `estops`, `stackLight`, `status` must
  be present (use `[]`).
- **`version` not 1, `col` > `columns`, `row`/`col` < 1, unknown colour / tone / icon names.**
- **A catch-all status rule first** — the first rule that holds wins; faults first, the rule
  without `when` last.
- **E-stop logic inverted** — E-stops are normally closed: the PLC sees **false** while pressed.
- **Duplicate `id`** across panels of one model — give every panel its own `id`.
- **Writing `Config` while someone edits it in the Inspector** — the Inspector JSON editor keeps
  the user's unapplied text and shows "The stored config changed while you were editing";
  the user decides (Ctrl+Enter overwrites your write, Escape loads it). Read the value back
  with `web_component_get` before assuming your write is what stays.