# Virtual PLC (IEC 61131-3 Structured Text)

Browser-side soft PLC — a COMMERCIAL feature (beta). It ships in commercial builds and
deliveries, including customer workspaces and hosted customer models; `tier-manifest.json`
places `plc` on the default `commercial` tier. Only the Community build lacks it, and there
the tools return "PLC not available in this build".

## Workflow

1. `web_signal_list` — discover the signal names to bind via `VAR_EXTERNAL`
2. `web_execute("plc.deploy", {"code":"PROGRAM Main\nEND_PROGRAM","program":"Main"})` (`code` = `PROGRAM ... END_PROGRAM`) — compile + COLD load. Error
   diagnostics block loading; binding warnings mean a `VAR_EXTERNAL` matched no signal.
3. `web_execute("plc.run", {"program":"Main"})` — start cyclic scanning (one scan per 60 Hz sim tick: input snapshot →
   program pass → output batch write). After an error state this COLD-restarts.
4. `web_query("plc.status", {})` — confirm `state=running`, scan time, watch values (VAR_EXTERNAL +
   function-block outputs like `tDelay.Q`)
5. `web_execute("plc.stop", {"program":"Main"})` — WARM stop (program memory and FB states kept, outputs keep last values)

Deploying never starts scanning — always `web_execute("plc.run", {"program":"Main"})` afterwards. A `PLCProgram` included in the
model with `Active: true` is deployed and run automatically on model load.

**Several programs:** a scene can hold several `PLCProgram` nodes (one per unit). They scan in
ascending `Order` in the same tick. Every `plc.*` command takes an optional `program` (name or
path; default: the program shown in the editor); `web_query("plc.status", {})` lists all programs and outputs
written by more than one.

**Connection mode:** the PLC scans in both modes. Bind the read-only system variable
`RV_SimulationMode : BOOL` (TRUE = Simulation, FALSE = PLC mode) and assign no outputs while it is
FALSE, so a real PLC's writes are never overwritten.
Full language reference: `doc-plc-programming.md`.

## Language (v1.1) — write only what compiles

Types `BOOL INT DINT REAL TIME` and the 10 standard FBs (`TON TOF TP CTU CTD CTUD R_TRIG F_TRIG RS SR`).
One `PROGRAM` per `PLCProgram`; declare variables one per line (`a, b : INT;` is an error).

**Supported**

- Start values: `x : INT := 5;`, `t : TIME := T#2s;`, FB start inputs `tDelay : TON := (PT := T#2s);`.
  Only constant expressions (literals, constants, `-`, `+ - * / MOD`); never on `VAR_EXTERNAL`.
- `VAR CONSTANT K : INT := 4; END_VAR` — start value required, not writable, usable in expressions, `CASE`
  labels and `FOR` bounds.
- `RV_FirstScan : BOOL` (`VAR_EXTERNAL`, read-only): `TRUE` for exactly one scan after a COLD start (Deploy,
  Reset / simulation reset, Run after an error); not after Stop -> Run. Start values apply on the same COLD starts.
- `EXIT` (innermost loop), `RETURN` (ends the scan, outputs are still written), FB output arguments
  `tDelay(IN := a, PT := T#1s, Q => done)` (formal parameters only, no positional arguments).
- `AND OR XOR NOT` are bitwise on `INT` (16 bit) / `DINT` (32 bit) and logical on `BOOL`, never mixed.
  `SHL(x, n)`, `SHR(x, n)` (logical), `ROL`, `ROR` — result type = type of `x`; `n >= width` gives 0 for
  `SHL`/`SHR`, rotations are modulo the width, `n < 0` is a runtime error (state `error`).
- `CASE` over `INT`/`DINT`: single labels, comma lists, named integer constants, `ELSE`.

**Not supported (compile error with line/column)** — strings, arrays, structs/enums, `WORD`/`DWORD`/`BYTE` and
other types, own `FUNCTION`/`FUNCTION_BLOCK`, several `PROGRAM`s in one source, functions other than
`SHL SHR ROL ROR` (no `ABS`, `MIN`, `LIMIT`, `INT_TO_REAL`), `CASE` ranges (`1..5`), `VAR_INPUT`/`VAR_OUTPUT`/
`VAR_GLOBAL`, `RETAIN`/`PERSISTENT`, typed/based literals (`INT#5`, `2#1010`), writing FB members (`t.PT := ..`),
nested comments. `INT`/`DINT` arithmetic does **not** wrap on overflow (`32767 + 1` is `32768`) and literals are
not range-checked.

## PLC auto-map — the comment address convention

A model PLC signal (`PLCInput*` / `PLCOutput*`) carries its absolute PLC address as the PREFIX of
its comment:

```
<address> · <text>          e.g.  %I0.2 · Betriebsart: Automatik
                                  %QW8 · Speed setpoint
                                  DB1.DBX0.0 · Recipe active
```

- Separator `·` (U+00B7); ` | ` and ` - ` are accepted only when the left side is a valid address.
  A tag without comment text may carry the address alone (`%Q108.0`).
- Address forms: `%I`/`%Q`/`%M` bit (`%Q108.0`), byte/word/dword (`%IB4`, `%QW8`, `%MD20`) and
  `DBn.DBX/DBB/DBW/DBD` (`DB1.DBW2`). German `%E`/`%A` are equivalent to `%I`/`%Q`.
- Direction follows the PLC convention: `%I` only on `PLCInput*`, `%Q` only on `PLCOutput*`
  (`%M` / DB fit either). A mismatch is reported as `direction-conflict`, never guessed.
- The address is read from the GLB comment (`rv_extras.<Type>.Comment`), not from the CONNECT
  metadata, so it survives an Apply that writes the plain text back as the interface comment.

`web_execute("signal.automapCheck", {"interfaceId":"S7"})` or
`web_execute("signal.automapApply", {"interfaceId":"S7"})` — the same report as the
*PLC auto-map* strip in an expanded S7 / PLCSIM Advanced interface of the CONNECT panel:

- **S7** binds by address: the key is the signal name, Apply writes `protocolAddress` = comment
  address, `type` = the model signal type, `dataType` from the kind (Bool / Int / Real; `DInt` /
  `Byte` when the address says `D` / `B`).
- **PLCSIM Advanced** binds by tag name: both sides are compared with the quotes stripped
  (`"FG01_P_Camera".bEnable` = `FG01_P_Camera.bEnable`, case-sensitive). Apply writes the PLC
  spelling as `protocolAddress` and keeps the model name as the signal name. Dotted model names
  whose block is not in the process-image browse produce the hint `dataBlockFilter: [..]`; Apply
  adds those blocks to `plcSimAdvanced.dataBlockFilter` (merge) and browses again.
- Categories: `mapped`, `mappable`, `address-mismatch` (Apply updates), `missing-in-plc`,
  `no-address` (S7), `direction-conflict`, `address-duplicate` (S7), `ambiguous` (PLCSIM),
  `plc-only` (kept — Apply never removes a signal), plus `hints` (e.g. PLCInput signals while
  `allowWebToPlc` is off — Apply never changes that switch; a 409 name collision).

## Tool reference

<!-- BEGIN GENERATED: tool-reference plc — do not edit; run `npm run gen:mcp-docs` -->
_0 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| _none_ | | | |
<!-- END GENERATED: tool-reference plc -->
