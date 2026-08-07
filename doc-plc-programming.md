# PLC Programming (Virtual PLC)

realvirtual WEB includes a **virtual PLC**: write IEC 61131-3 Structured Text (ST) in a
VS-Code-style editor (Monaco) directly in the browser, deploy it, and run it as a cyclic
scan program against the live scene. PLC inputs and outputs map straight onto the
SignalStore — sensors are read, drives and actuators are written — so complete plant
logic can be programmed and tested without Unity and without PLC hardware.

The ST source is compiled to JavaScript in the browser and executed inside a
QuickJS-WASM sandbox, one scan per simulation tick.

> **Availability:** the PLC runtime, editor, and compiler are part of the **internal
> tier** — they ship only in internal dev builds (dev server, or builds with
> `RV_INTERNAL=1`). Public demo builds and customer deploys contain none of the PLC,
> Monaco, or sandbox code. In those builds the public control surface
> (`src/core/plc-control.ts`) reports the PLC as not available.

## Getting Started

1. Switch to **Planner** mode and click the **PLC** toolbar button (or use the
   *Edit PLC Program* action on a node that carries a `PLCProgram` component).
2. On first open, a singleton `PLC` node with a `PLCProgram` component is created in the
   scene, pre-filled with a template program:

```iecst
PROGRAM Main
VAR_EXTERNAL
  SensorInFeed : BOOL;  (* signal name = VAR_EXTERNAL name *)
  ConveyorStart : BOOL;
END_VAR
VAR
  tDelay : TON;
END_VAR
  tDelay(IN := SensorInFeed, PT := T#2s);
  ConveyorStart := tDelay.Q;
END_PROGRAM
```

3. Edit the program — syntax errors appear as live markers (debounced 300 ms).
   Signal-name autocomplete is fed from the SignalStore.
4. **Deploy** compiles and loads the program (COLD: fresh function-block states and
   memory). Compile errors and signal-binding warnings appear as editor markers.
5. **Run** starts cyclic scanning; **Stop** halts it (WARM — states are kept);
   **Step** executes exactly one scan (useful while the simulation is paused);
   **Reset** performs a COLD reset.
6. The **Watch** panel below the editor shows live values of all `VAR_EXTERNAL`
   variables and function-block outputs (e.g. `tDelay.Q`, `tDelay.ET`), refreshed at 5 Hz.

The editor panel is a floating window that survives workspace-mode switches: like a real
controller, the PLC keeps running while you watch the plant in 3D or HMI mode.

## ST Language Scope

The compiler implements a deliberate v1 subset of IEC 61131-3 ST. Keywords are
case-insensitive; comments are `(* ... *)` and `// ...`.

| Area | Supported |
|------|-----------|
| Program structure | One `PROGRAM ... END_PROGRAM` with `VAR` and `VAR_EXTERNAL` blocks |
| Statements | Assignment (`:=`), function-block calls (formal parameters, `:=` only), `IF / ELSIF / ELSE`, `CASE` (single integer labels + `ELSE`), `FOR` (with `BY`), `WHILE`, `REPEAT ... UNTIL` |
| Types | `BOOL`, `INT`, `DINT`, `REAL`, `TIME` |
| Literals | Integer (`123`), real (`1.5`), hex (`16#FF`), `TRUE` / `FALSE`, time (`T#2s`, `T#500ms`, `T#1m30s` — internally milliseconds) |
| Operators | `+ - * /`, `MOD`, comparisons (`= <> < <= > >=`), `AND OR XOR NOT` |
| Function blocks | The 10 standard FBs below, declared as `VAR` instances |

**Not in v1:** strings, arrays, structs, user-defined function blocks or functions,
`CASE` subranges, `EXIT` / `RETURN`, bitwise integer logic, `=>` output parameters, and
`TIME` arithmetic beyond `+` / `-`. Unsupported constructs produce a compile diagnostic
instead of silently misbehaving.

## Standard Function Blocks

All function blocks are implemented host-side in TypeScript and injected into the
sandbox. Their **time base is the simulation time** (not wallclock) — pausing the
simulation pauses running timers.

| FB | Signature | Semantics |
|----|-----------|-----------|
| `TON` | `IN, PT → Q, ET` | On-delay timer: `Q` rises once `IN` has been continuously TRUE for `PT` |
| `TOF` | `IN, PT → Q, ET` | Off-delay timer: `Q` follows `IN` on rise, falls `PT` after `IN` falls |
| `TP` | `IN, PT → Q, ET` | Pulse timer: a rising edge of `IN` emits a `Q` pulse of length `PT` (not retriggerable while active) |
| `CTU` | `CU, R, PV → Q, CV` | Up-counter: `CV` increments on a rising edge of `CU`; `R` (dominant) resets; `Q = CV >= PV` |
| `CTD` | `CD, LD, PV → Q, CV` | Down-counter: `LD` loads `PV`, `CV` decrements on a rising edge of `CD`; `Q = CV <= 0` |
| `CTUD` | `CU, CD, R, LD, PV → QU, QD, CV` | Up/down counter: `R` (dominant) resets, `LD` loads `PV`; `QU = CV >= PV`, `QD = CV <= 0` |
| `R_TRIG` | `CLK → Q` | Rising-edge detector: `Q` TRUE for exactly the one call where `CLK` went FALSE → TRUE |
| `F_TRIG` | `CLK → Q` | Falling-edge detector: `Q` TRUE for exactly the one call where `CLK` went TRUE → FALSE |
| `RS` | `S, R1 → Q, Q1` | Reset-dominant bistable: `Q1 := NOT R1 AND (S OR Q1)` |
| `SR` | `S1, R → Q, Q1` | Set-dominant bistable: `Q1 := S1 OR (NOT R AND Q1)` |

IEC semantics apply: FB inputs are instance variables — parameters omitted in a call
keep their previous value.

## Signal Binding

`VAR_EXTERNAL` declarations bind program variables to SignalStore signals **by name** —
the variable name is the signal name:

```iecst
VAR_EXTERNAL
  SensorInFeed : BOOL;   (* reads the signal "SensorInFeed" *)
  ConveyorStart : BOOL;  (* writes the signal "ConveyorStart" *)
END_VAR
```

Binding is checked at deploy time:

- **Inputs** (externals the program only reads) without a matching signal produce a
  **warning diagnostic** and read `FALSE` / `0` during scans — the most common cause is
  a typo in the variable name.
- **Outputs** (externals the program writes) without a matching signal are
  **auto-registered** under the path `PLC/<name>` — the PLC never writes into the void.

## Scan Cycle Semantics

One scan per 60 Hz simulation tick, executed in the PRE stage after the interface
adapters have flushed live signal values and before drive physics — outputs take effect
in the same tick. Each scan follows classic PLC process-image semantics:

1. **Input snapshot** — all `VAR_EXTERNAL` values are copied from the SignalStore.
   Signal changes during the scan are invisible to the program.
2. **Scan** — the compiled program runs once, synchronously, from top to bottom.
3. **Output batch** — all written externals are committed in one `setMany()` batch.

Outputs only change at scan boundaries, which makes the execution deterministic.

Run states are `stopped`, `running`, and `error`:

- A scan that exceeds its sandbox deadline, hits the memory limit, or throws a runtime
  error (e.g. division by zero) stops scanning and puts the PLC into the **error**
  state; the message is available as `lastError` and in the editor status chip.
- After an error the sandbox heap is considered poisoned: the next **Run** performs a
  **COLD restart** — the sandbox is disposed and rebuilt with fresh FB states.
- A simulation reset (`simulation-reset`) also COLD-resets the PLC: FB states back to
  initial values, program memory rebuilt, PLC time back to 0.
- **Stop** is WARM: memory and FB states are kept, outputs keep their last values.

## Persistence

The program lives in the scene as a `PLCProgram` component (fields `Active`,
`Language`, `Name`, `Code`) on the singleton `PLC` node:

- Edits persist as scene ops (debounced), so program changes are **undo/redo-capable**
  and autosaved with the scene draft. When a scene contains several `PLCProgram` nodes,
  the first one found is used.
- The editor header offers **.st export** (file download) and **import** for exchanging
  programs as plain files.
- The **run state is never persisted** and programs **never auto-start**: an
  `Active: true` flag from a (possibly foreign shared) scene only loads the code into
  the editor — Deploy and Run are always explicit user actions.

## Security

Programs execute inside a QuickJS-WASM sandbox, never in the host JavaScript context:

- **Whitelist host bridge** — the sandbox can only exchange signal values and call the
  host-side function blocks. There is no `fetch`, no DOM, no timers, no host globals.
- **Execution deadlines** — every evaluation has a hard interrupt deadline (10 ms per
  scan, 100 ms for program load), so endless loops cannot freeze the viewer.
- **Memory limit** — the guest heap is capped (32 MB default); allocation bombs abort
  the scan.
- After a deadline or memory abort the sandbox is disposed and rebuilt — a poisoned
  heap is never reused.
- Programs from shared scenes never start automatically (see Persistence above).

## MCP Tools

With the MCP bridge connected, four `web_plc_*` tools control the PLC (see
[webviewer.mcp.md](webviewer.mcp.md)):

| Tool | Purpose |
|------|---------|
| `web_plc_status` | Run state, scan time (ms), last error, and online watch values |
| `web_plc_deploy` | Compile + COLD-load an ST program (`code`), returns diagnostics |
| `web_plc_run` | Start cyclic scanning (COLD restart after an error state) |
| `web_plc_stop` | Stop scanning (WARM — memory and FB states kept) |

In builds without the PLC runtime the tools return `"PLC not available in this build"`.
