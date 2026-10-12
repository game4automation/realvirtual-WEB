# Virtual PLC (IEC 61131-3 Structured Text)

Browser-side soft PLC — ships only in internal dev builds; elsewhere the tools return
"PLC not available in this build".

## Workflow

1. `web_signal_list` — discover the signal names to bind via `VAR_EXTERNAL`
2. `web_plc_deploy` (`code` = `PROGRAM ... END_PROGRAM`) — compile + COLD load. Error
   diagnostics block loading; binding warnings mean a `VAR_EXTERNAL` matched no signal.
3. `web_plc_run` — start cyclic scanning (one scan per 60 Hz sim tick: input snapshot →
   program pass → output batch write). After an error state this COLD-restarts.
4. `web_plc_status` — confirm `state=running`, scan time, watch values (VAR_EXTERNAL +
   function-block outputs like `tDelay.Q`)
5. `web_plc_stop` — WARM stop (program memory and FB states kept, outputs keep last values)

Deploying never starts scanning — always `web_plc_run` afterwards. A `PLCProgram` included in the
model with `Active: true` is deployed and run automatically on model load.

**Several programs:** a scene can hold several `PLCProgram` nodes (one per unit). They scan in
ascending `Order` in the same tick. Every `web_plc_*` tool takes an optional `program` (name or
path; default: the program shown in the editor); `web_plc_status` lists all programs and outputs
written by more than one.

**Connection mode:** the PLC scans in both modes. Bind the read-only system variable
`RV_SimulationMode : BOOL` (TRUE = Simulation, FALSE = PLC mode) and assign no outputs while it is
FALSE, so a real PLC's writes are never overwritten.
Full language reference: `doc-plc-programming.md`.

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

`web_signal_automap` (`interfaceId`, `mode: "check" | "apply"`) — the same report as the
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
_4 tools in this family, generated from the @McpTool decorators — do not edit by hand._

| Tool | Access | Parameters | Summary |
|------|--------|------------|---------|
| `web_plc_deploy` | write | `code` string **req**, `program` string | Deploy IEC 61131-3 Structured Text to a PLC program: compile + COLD load (fresh FB states and memory). |
| `web_plc_run` | write | `program` string | Start cyclic scanning of a PLC program (one scan per 60 Hz tick: inputs → program → outputs). |
| `web_plc_status` | read | `program` string | Virtual PLC status of one program: run state, scan time (ms), last error and watch values (VAR_EXTERNAL plus FB outputs like tDelay.Q). |
| `web_plc_stop` | write | `program` string | Stop scanning a PLC program (WARM: memory and FB states kept, outputs keep their last values). |
<!-- END GENERATED: tool-reference plc -->
