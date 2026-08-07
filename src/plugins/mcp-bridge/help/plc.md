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

Deploying never starts scanning — always `web_plc_run` afterwards.
Full language reference: `doc-plc-programming.md`.
