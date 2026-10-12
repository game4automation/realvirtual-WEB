# PLC Programming (Virtual PLC)

> **Applies to:** Commercial beta PLC feature; unavailable in Community. Requires an enabled commercial build.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

realvirtual WEB includes a **virtual PLC**: write IEC 61131-3 Structured Text (ST) in a
VS-Code-style editor (Monaco) directly in the browser, deploy it, and run it as a cyclic
scan program against the live scene. PLC inputs and outputs map straight onto the
SignalStore — sensors are read, drives and actuators are written — so complete plant
logic can be programmed and tested without Unity and without PLC hardware.

The ST source is compiled to JavaScript in the browser and executed inside a
QuickJS-WASM sandbox, one scan per simulation tick.

> **Availability:** the virtual PLC editor, compiler and runtime are a **commercial
> beta feature**. They are not included in the Community build. Commercial deliveries
> and hosted demos include them only when enabled for that build. The public
> `src/core/plc-control.ts` API alone does not provide a PLC runtime. See the
> [edition comparison](README.md#community-edition-vs-commercial).

The following steps require a build with the virtual PLC feature enabled.

## Getting Started

1. Switch to **Planner** mode and click the **PLC** toolbar button (or use the
   *Edit PLC Program* action on a node that carries a `PLCProgram` component).
2. On first open of a scene without a program, a `PLC` node with a `PLCProgram` component is created in the
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
6. The **Watch** panel below the editor shows live values of all `VAR_EXTERNAL` and `VAR`
   variables and function-block outputs (e.g. `tDelay.Q`, `tDelay.ET`), refreshed at 5 Hz.

### Online view in the code

While the PLC runs, the editor shows the program state directly in the code:

- **Values** — each declaration line ends with its current value (`Step : INT;  ⟵ 30`,
  `tMeasure : TON;  ⟵ Q=FALSE ET=0.4s`). Hovering a variable anywhere in the code shows
  its type and value.
- **Active branches** — the IF / ELSIF / ELSE branches and CASE arms that ran in the last
  scan get a blue bar in the gutter; the innermost one is tinted. Branches that did not run
  are dimmed.

The branch view needs the editor text to be the deployed program: as soon as you edit, it
disappears, and it returns after the next **Deploy** (or when you undo back to the deployed
text).

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

### System variables and the connection mode

A few names are **system variables**: they bind like any `VAR_EXTERNAL`, but the value
comes from the viewer instead of a signal, and they are read-only — a program that writes
one fails to deploy.

| Name | Type | Value |
|------|------|-------|
| `RV_SimulationMode` | `BOOL` | `TRUE` while the model is in **Simulation** mode (no PLC connected); `FALSE` in **PLC** mode — set by the Simulation / PLC toggle or when a live interface takes over the model outputs |

The virtual PLC does not step aside on its own: it scans in both modes. A program that
replaces plant control should read `RV_SimulationMode` and assign nothing while it is
`FALSE`, so it never overwrites what a real PLC writes. An output the program does not assign
during a scan is written back with the value read at scan start, so a real PLC's value stays
in place. This is the ST counterpart of `Active: Disconnected` on a LogicStep root:

```iecst
IF NOT RV_SimulationMode THEN
  Step := 0;           (* PLC mode: the real PLC owns the outputs; restart on return *)
ELSE
  CASE Step OF ... END_CASE;
END_IF;
```

A model without a `ConnectionMode` component starts in PLC mode, so `RV_SimulationMode`
reads `FALSE` there.

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
`Language`, `Name`, `Code`, `Order`) on its node:

- Edits persist as scene ops (debounced), so program changes are **undo/redo-capable**
  and autosaved with the scene draft.

## Several programs

A scene can hold several `PLCProgram` nodes — one program per functional unit, like
the blocks a real PLC calls one after another in its main cycle:

- every program has its own memory, function blocks, run state and error; stopping or
  breaking one leaves the others running;
- all running programs scan in the **same tick**, in ascending `Order` (ties by node
  path), so a later program sees what an earlier one wrote in that tick;
- programs exchange data only through signals. An output written by more than one
  program is reported (console, `web_plc_status.conflicts`) — on a real PLC the last
  writer would win silently;
- the editor works on one program at a time: the list button in its header shows all
  programs in scan order with state and scan time and switches between them. Deploy,
  Run, Stop, Step, Reset and the online view act on the program shown;
- the MCP tools take an optional `program` (name or path); without it they address the
  program shown in the editor. `web_plc_status` also lists all programs.

## Converting LogicStep sequences

LogicStep sequences that only exchange PLC signals can be converted into ST — one program per
sequence
(`convertLogicStepsToSt`, private `src/plc/logicstep-to-st.ts`):

- every `SerialContainer` becomes a step chain — a `CASE` over an `INT` step counter, one
  entry per original step with the step name as a comment; a `ParallelContainer` that is
  the only child of a sequence becomes one chain per branch;
- `SetSignalBool` → assignment, `WaitForSignalBool` → `IF` (rising / falling edges sample
  the signal when the step starts), `Delay` → one `TON` per step, `JumpOnSignal` → a jump
  of the step counter;
- per scan a chain passes every step that finishes immediately until one has to wait, and
  restarts at step 0 after its last step — the same order of events as the LogicStep
  engine (timing within a tick; a delay can end one 60 Hz tick earlier or later);
- every chain obeys `RV_SimulationMode` (writes nothing in PLC mode, restarts on return);
- signal names that are no ST identifiers (TIA tags like `FG01_P_Camera.bTrigger`) are
  bound through the `@signal` pragma;
- `DriveTo` needs a mapping to a command signal plus a feedback signal — a PLC moves a
  drive through a valve or a drive interface, never directly. Other step types are
  reported, never guessed.

The Laser Welding Assembly Station copy (`LaserWeldingAssemblyStation-ST.glb`) is built
this way by `scripts/build-welding-plc-glb.mjs` (private): 11 sequences become 11 programs
(Modes with its 11 parallel chains, Transport, both lifts, buffer, entry, five stations; 57 to
551 lines each), and a whole-station scan takes well under 1 ms.

## Security

Programs execute inside a QuickJS-WASM sandbox, never in the host JavaScript context:

- **Whitelist host bridge** — the sandbox can only exchange signal values and call the
  host-side function blocks. There is no `fetch`, no DOM, no timers, no host globals.
- **Execution deadlines** — every evaluation has a hard interrupt deadline (50 ms per
  scan, 500 ms for program load), so endless loops cannot freeze the viewer. The deadline
  is wall-clock time, so it leaves room for a browser pause during a scan; a whole station
  program typically scans in under 1 ms.
- **Memory limit** — the guest heap is capped (32 MB default); allocation bombs abort
  the scan.
- After a deadline or memory abort the sandbox is disposed and rebuilt — a poisoned
  heap is never reused.
- An `Active` program in a loaded model starts automatically (see Persistence above) — it
  runs inside the same sandbox limits, and it can only read and write signals.

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
