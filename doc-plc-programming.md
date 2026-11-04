# PLC Programming (Virtual PLC)

> **Applies to:** Commercial beta PLC feature; unavailable in Community. Included in commercial builds.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16; ST language level v1.1 (plan-2218) reviewed 2026-11-04.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

realvirtual WEB includes a **virtual PLC**: write IEC 61131-3 Structured Text (ST) in a
VS-Code-style editor (Monaco) directly in the browser, deploy it, and run it as a cyclic
scan program against the live scene. PLC inputs and outputs map straight onto the
SignalStore — sensors are read, drives and actuators are written — so complete plant
logic can be programmed and tested without Unity and without PLC hardware.

The ST source is compiled to JavaScript in the browser and executed inside a
QuickJS-WASM sandbox, one scan per simulation tick.

> **Availability:** the virtual PLC editor, compiler and runtime are a **commercial
> beta feature**. They are not included in the Community build, and they ARE included in
> commercial builds and deliveries — customer workspaces and hosted customer models
> alike. `tier-manifest.json` carries `"defaults": "commercial"` and does not list `plc`
> among its `rules`, so the feature falls on the customer tier; `registerPrivatePlugins`
> registers it unconditionally (`src/private-plugins.ts`, `useFeature(viewer, 'plc', ...)`),
> and `useFeature` is an isolating try/catch, not a gate. There is no per-build opt-in to
> switch on. A customer can only lack it through an explicit `restrictedFeatures` entry in
> their customer file. The public `src/core/plc-control.ts` API alone does not provide a
> PLC runtime. See the [edition comparison](README.md#community-edition-vs-commercial).

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

The compiler implements a deliberate subset of IEC 61131-3 ST (language level **v1.1**).
Keywords are case-insensitive; comments are `(* ... *)` (not nestable) and `// ...`.
Anything outside the subset is rejected at compile time with a diagnostic that carries
the line and column — it never runs as something else.

### Supported

| Area | Supported | Example |
|------|-----------|---------|
| Program structure | One `PROGRAM ... END_PROGRAM` per `PLCProgram`, with `VAR`, `VAR CONSTANT` and `VAR_EXTERNAL` blocks (declarations first, then statements) | `PROGRAM Main VAR n : INT; END_VAR n := n + 1; END_PROGRAM` |
| Declarations | One name per declaration; types `BOOL`, `INT`, `DINT`, `REAL`, `TIME` or a standard FB | `speed : REAL;` |
| Start values | `name : Type := <constant expression>;` — literals, constants, unary minus, `+ - * / MOD` over them. Applied on every COLD start (see Scan Cycle) | `x : INT := 5;` `limit : INT := 4 * 25;` `t : TIME := T#2s;` |
| Constants | `VAR CONSTANT` with a mandatory start value, elementary types. Folded at compile time: usable in expressions, initializers, `CASE` labels and `FOR` bounds; not writable | `VAR CONSTANT MAXP : INT := 10; END_VAR` |
| FB start inputs | Start values for FB inputs (formal, inputs only, type-checked) | `tDelay : TON := (PT := T#2s);` `cnt : CTU := (PV := 10);` |
| Literals | Integer, real (`1.5`, `1.5E2`), hex `16#FF`, `TRUE` / `FALSE`, time `T#2s` / `T#500ms` / `T#1m30s` / `TIME#2s` (internally milliseconds) | `T#1m30s` |
| Assignment | `:=` with implicit widening `INT -> DINT -> REAL` | `d := i;` |
| Branches | `IF / ELSIF / ELSE`; `CASE` over `INT` / `DINT` with single integer labels, comma lists, named integer constants and `ELSE` | `CASE s OF 1, 2: x := 1; MAXP: x := 2; ELSE x := 0; END_CASE` |
| Loops | `FOR ... TO ... BY ... DO`, `WHILE`, `REPEAT ... UNTIL` | `FOR i := 1 TO 10 BY 2 DO ... END_FOR` |
| Loop / program exit | `EXIT` leaves the innermost loop (also from inside an `IF` / `CASE` in it); `RETURN` ends the scan, outputs are still written | `IF x > 5 THEN EXIT; END_IF;` `RETURN;` |
| FB calls | Formal parameters only: inputs with `:=`, outputs with `=>` into a variable or `VAR_EXTERNAL` (assigned after the call, in source order) | `tDelay(IN := a, PT := T#1s, Q => done, ET => el);` |
| Member reads | Inputs and outputs of an FB instance | `tDelay.Q`, `cnt.CV` |
| Arithmetic | `+ - * /`, `MOD`, unary `-`; `TIME +/- TIME`; integer `/` truncates | `r := 7 / 2;` (INT: 3) |
| Comparisons | `= <> < <= > >=` on numbers; `= <>` also on `BOOL` / `TIME`; `< <= > >=` also on `TIME` | `IF t.ET >= T#1s THEN` |
| Logic and bits | `AND OR XOR NOT`: logical on `BOOL`, bitwise on `INT` / `DINT` (never mixed) | `m := flags AND 16#00FF;` |
| Shifts / rotations | Built-in `SHL`, `SHR`, `ROL`, `ROR` — positional or formal (`IN`, `N`); result has the type of `IN` | `x := SHL(1, 3);` `y := ROR(IN := d, N := 2);` |
| Function blocks | The 10 standard FBs (next section), declared as `VAR` instances | `tDelay : TON;` |
| System variables | `RV_SimulationMode`, `RV_FirstScan` via `VAR_EXTERNAL`, read-only | `IF RV_FirstScan THEN ... END_IF;` |
| Signal names | `(* @signal: <store name> *)` on a `VAR_EXTERNAL` line binds a short identifier to any signal name | `Probe : BOOL; (* @signal: FG04_Y_AxisZ_WorkPos *)` |

### Not supported

| Not supported | What the compiler does | Instead |
|---------------|------------------------|---------|
| Strings and string literals (`STRING`, `'abc'`) | Error: unexpected character / unknown type | Use `INT` codes or signals |
| Arrays (`ARRAY[0..3] OF INT`) | Error: unexpected character `[` | One variable per element, or a `CASE` |
| Structs, enums, `TYPE` declarations | Error: unknown type | Separate variables; `VAR CONSTANT` + `CASE` for named states |
| Other types: `WORD`, `DWORD`, `BYTE`, `SINT`, `LINT`, `UINT`, `LREAL`, `DATE`, `TOD` ... | Error: unknown type | `INT` / `DINT` with bit operations |
| Own `FUNCTION`, `FUNCTION_BLOCK`, `ACTION`, `METHOD` | Error: the source must start with `PROGRAM` | Several `PLCProgram` nodes (one per unit) |
| Several `PROGRAM` blocks in one file | Error: redundant input | One `PLCProgram` node each |
| Built-in functions other than `SHL SHR ROL ROR` (`ABS`, `MIN`, `MAX`, `LIMIT`, `SEL`, `INT_TO_REAL` ...) | Error: unknown function | Write the expression with `IF` / arithmetic |
| `CASE` ranges (`1..5:`) | Error: expected `:` | A comma list, or `IF x >= 1 AND x <= 5` |
| Several names in one declaration (`a, b : INT;`) | Error: expected `:` | One declaration per variable |
| `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT`, `VAR_GLOBAL`, `VAR_TEMP`, `RETAIN`, `PERSISTENT`, `AT %IX0.0` | Error: parse error | `VAR_EXTERNAL` for signals; memory is never retained across a COLD start |
| Typed / based literals (`INT#5`, `2#1010`, `8#17`) | Error: unexpected character `#` | `16#` hex or decimal |
| Positional FB arguments (`t(TRUE, T#1s)`) | Error: expected `)` | Formal: `t(IN := TRUE, PT := T#1s)` |
| Writing an FB member (`t.PT := ...`) | Error with a hint | Pass the input in the call |
| FB instance as `VAR_EXTERNAL`, other FB types than the standard 10 | Error | Declare in `VAR` |
| Initial value that is not constant (`b : INT := a;`, `NOT`, comparisons, `AND` / `OR`), or on `VAR_EXTERNAL` | Error: initializer must be a constant expression | Assign under `IF RV_FirstScan THEN` |
| `**`, `TIME * n`, `MOD` on `REAL`, `CONTINUE`, `GOTO` / `JMP`, nested comments | Error | Rewrite with `*`, `IF` |
| Mixed `BOOL` / `INT` in `AND OR XOR NOT`, bit operations on `REAL` / `TIME` | Error: operands must be `BOOL` or `INT` / `DINT` | Compare first: `(n <> 0) AND b` |
| Narrowing assignment (`DINT -> INT`, `REAL -> INT`, `BOOL -> INT`) | Error: type mismatch | No conversion functions exist; keep both sides the same type |
| Integer overflow wrap-around | Not performed (see Numbers) | Keep values in range, or mask with a bit operation |

Warning, not error: a `VAR_EXTERNAL` that the program never uses.

### Numbers

- **Arithmetic does not wrap.** `INT` and `DINT` are plain JavaScript numbers: `32767 + 1`
  gives `32768` in an `INT` variable. Literal and start values are not range-checked either
  (`x : INT := 40000;` compiles). Keep values in range yourself.
- **Bit operations are type-correct.** `AND`, `OR`, `XOR`, `NOT`, `SHL`, `SHR`, `ROL`, `ROR`
  work on 16 bits for `INT` and 32 bits for `DINT`: both operands are masked to that width
  first and the result is a signed value of that width (`NOT 0` is `-1`,
  `16#8000 OR 1` is `-32767`). The width comes from the operand types (the wider of the
  two), not from the variable that receives the result: `a := ROR(1, 1);` with a `DINT`
  `a` rotates the `INT` literal and gives `-32768`.
- **Shifts.** `SHR` is logical (zeros shift in). `SHL` / `SHR` by `N >= width` give `0`.
  `ROL` / `ROR` rotate by `N` modulo the width. `N` must be `INT` / `DINT`; a negative `N`
  is a runtime error (the program enters the `error` state, like a division by zero).
- **Division.** `INT` / `DINT` division and `MOD` truncate toward zero; a zero divisor is a
  runtime error. In a start value or constant a zero divisor is a compile error instead.
- `BOOL` operands keep their logical meaning with `AND OR XOR NOT`.

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
| `RV_FirstScan` | `BOOL` | `TRUE` in exactly one scan after every COLD start (Deploy, simulation reset, restart after an error), `FALSE` in all other scans. **Not** `TRUE` after Stop -> Run (WARM). Not a signal: it is never registered in the SignalStore and has no address |

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

A model **without** a `ConnectionMode` component starts in **Simulation**, so
`RV_SimulationMode` reads `TRUE` there and the programs run. `rv-connection-mode.ts`
resolves `component ? stateFor(parseStartMode(component.StartMode)) : 'Disconnected'`,
`Disconnected` is the Simulation state, and the virtual PLC maps that state to
`RV_SimulationMode = TRUE`. A real PLC still takes over on its first write.

> **Corrected 2026-10-15.** This paragraph previously said the opposite ("starts in PLC
> mode, so `RV_SimulationMode` reads `FALSE`"). That described the behaviour **before**
> plan-539 F15/F15b, when the viewer default was `Connected` for Unity parity and a
> virtual PLC consequently never ran in a plain viewer. Adding a `ConnectionMode` with
> `StartMode: 'Simulation'` is still worth doing — it pins the intent and survives the
> next default change — but it is a documentation argument, not a prerequisite for the
> programs to run.

## Scan Cycle Semantics

One scan per 60 Hz simulation tick, executed in the PRE stage after the interface
adapters have flushed live signal values and before drive physics — outputs take effect
in the same tick. Each scan follows classic PLC process-image semantics:

1. **Input snapshot** — all `VAR_EXTERNAL` values are copied from the SignalStore.
   Signal changes during the scan are invisible to the program.
2. **Scan** — the compiled program runs once, synchronously, from top to bottom.
3. **Output batch** — all written externals are committed in one `setMany()` batch.

Outputs only change at scan boundaries, which makes the execution deterministic.

### COLD and WARM start, start values, first scan

| Event | Start | Program memory (`VAR`) | FB instances | `RV_FirstScan` |
|-------|-------|------------------------|--------------|----------------|
| **Deploy** | COLD | rebuilt, **start values applied** | fresh, FB start inputs applied | `TRUE` in the first scan |
| **Reset** / simulation reset | COLD | rebuilt, start values applied again | back to FB start inputs | `TRUE` in the first scan after it |
| **Run** after an `error` | COLD | fresh sandbox, start values applied | fresh | `TRUE` in the first scan |
| **Stop** -> **Run** | WARM | kept (a changed value stays changed) | kept | stays `FALSE` |

- A variable without start value begins at `FALSE` / `0`. Start values only apply at a COLD
  start; nothing is retained across it (`RETAIN` / `PERSISTENT` do not exist).
- `RV_FirstScan` is consumed by the first scan that runs, whether it comes from **Run**,
  **Step** or the simulation tick. A program that binds it runs initialization code exactly
  once per COLD start:

```iecst
PROGRAM Main
VAR_EXTERNAL RV_FirstScan : BOOL; Feed : BOOL; END_VAR
VAR CONSTANT MAXP : INT := 10; END_VAR
VAR
  parts  : INT := 0;               (* start value, applied at every COLD start *)
  starts : INT;                    (* counts COLD starts *)
  tDelay : TON := (PT := T#2s);    (* FB start input *)
END_VAR
  IF RV_FirstScan THEN starts := starts + 1; END_IF;
  tDelay(IN := Feed);              (* PT keeps the start value *)
  IF tDelay.Q AND parts < MAXP THEN parts := parts + 1; END_IF;
END_PROGRAM
```

- FB start inputs are the values of the instance inputs before the first call and again
  after every COLD start. A call that passes `PT` replaces it; later calls without `PT`
  keep the new value (IEC semantics). The watch shows FB inputs as well as outputs, so
  `tDelay.PT` reads `2000` (ms) right after a COLD start.
- `RV_FirstScan` is also listed in the watch while bound. Writing to it is a deploy error
  (`read-only system variable`), like `RV_SimulationMode`.

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
  program is reported (console, `web_query("plc.status", {}).conflicts`) — on a real PLC the last
  writer would win silently;
- the editor works on one program at a time: the list button in its header shows all
  programs in scan order with state and scan time and switches between them. Deploy,
  Run, Stop, Step, Reset and the online view act on the program shown;
- the PLC commands take an optional `program` (name or path); without it they address the
  program shown in the editor. `web_query("plc.status", {})` also lists all programs.

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
- **Execution deadlines** — every evaluation has a hard interrupt deadline (200 ms per
  scan, 500 ms for program load; runner defaults), so endless loops cannot freeze the viewer. The deadline
  is wall-clock time, so it leaves room for a browser pause during a scan; a whole station
  program typically scans in under 1 ms.
- **Memory limit** — the guest heap is capped (32 MB default); allocation bombs abort
  the scan.
- After a deadline or memory abort the sandbox is disposed and rebuilt — a poisoned
  heap is never reused.
- An `Active` program in a loaded model starts automatically (see Persistence above) — it
  runs inside the same sandbox limits, and it can only read and write signals.

## MCP commands

With the MCP bridge connected, four `plc.*` commands inspect and control the PLC (see
[webviewer.mcp.md](webviewer.mcp.md)):

| Command call | Purpose |
|------|---------|
| `web_query("plc.status", {})` | Run state, scan time (ms), last error, and online watch values |
| `web_execute("plc.deploy", {code, program})` | Compile + COLD-load an ST program (`code`), returns diagnostics |
| `web_execute("plc.run", {program})` | Start cyclic scanning (COLD restart after an error state) |
| `web_execute("plc.stop", {program})` | Stop scanning (WARM — memory and FB states kept) |

In builds without the PLC runtime the commands return `"PLC not available in this build"`.
