// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SignalEditDialog — generic add/edit dialog for manually created CONNECT signals.
 *
 * ONE dialog for every interface type: the protocol-specific parts (address label, syntax hint,
 * example addresses, allowed DataTypes, whether the address implies the direction) come from the
 * gateway's per-type signal schema (`GET /interface-types` → `signals`), so no per-protocol form
 * is hardcoded here. Addresses are validated live against `POST /signals/validate`, which runs the
 * same parsers the worker uses at connect time — the dialog shows the identical error message a
 * bad address (e.g. S7 `%IW13` declared Bool) would produce in the gateway log.
 *
 * Saving goes through `saveSignalFromDialog` (plan-2025 F10): one `signal.upsert` on CONNECT's write
 * core (`POST /config/ops`) that names every field the dialog edits and leaves the rest — the OPC UA
 * acquisition fields among them — as the gateway has it; an older CONNECT gets the pre-ops PUT. A
 * changed name is a RENAME through `/config/signals/rename` first, then the upsert under the new name;
 * if that second step fails the dialog says "Renamed to X — other changes not saved" and offers a
 * Retry that repeats only the second step. For MQTT this creates a Single-mode signal exactly like
 * the Unity MQTTInterface: one topic per signal, the payload is one scalar value.
 *
 * **plan-589: the dialog edits a PLACE, not a name.** `topic` + `mode` say which container of the
 * interface the signal lives in (the flat `signals` list, or one MQTT topic's own list), and the
 * place decides two things the dialog used to get wrong:
 *
 *  - whether the ADDRESS is mandatory. It used to be mandatory always. It is mandatory only where
 *    the gateway says `addressRule === 'required'` — an MQTT `Single` topic carries the address on
 *    the container, a `Json` topic keys its object by the signal name, and PLCSIM / SHM / ABB /
 *    WebSocket Realtime / WINMOD / PVI fall back to the name. A gateway that states no rule imposes
 *    none (and warns about none).
 *  - how the address is VALIDATED. `POST /signals/validate` checks an MQTT address as a topic, which
 *    is the wrong parser for a ProcessImage signal — that one carries a Siemens byte offset
 *    (`%IW13`) and is checked locally against the gateway's own address syntax.
 */

import { useState, useEffect, useCallback, useMemo, useSyncExternalStore } from 'react';
import {
  Box,
  Typography,
  Button,
  TextField,
  Checkbox,
  Chip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  MenuItem,
  Alert,
  ToggleButton,
  ToggleButtonGroup,
  CircularProgress,
  Tooltip,
} from '@mui/material';
import { Add, Edit, CheckCircleOutline } from '@mui/icons-material';
import {
  saveSignalFromDialog,
  validateSignalAddress,
  type SignalRenameProgress,
  isTextDataType,
  type ConnectInterface,
  type ConnectInterfaceSignal,
  type ConnectSignalSchema,
  type MqttTopicMode,
  type SignalValidationResult,
  holdConnectConfigEditing,
  getConnectConfigNotice,
  subscribeConnectConfigNotice,
} from './connect-store';
import { addressRuleFor, isProcessImageAddress } from '../import/rv-iface-signal-slots';

/** plan-590 — why the name is read-only in this dialog, and where the rename lives instead. */
export const SIGNAL_NAME_HERE_READONLY =
  'Rename the signal from its Name row in the inspector — that updates every reference';

/** Debounce for the live address validation round-trip. */
const VALIDATE_DEBOUNCE_MS = 300;

type SignalDirection = 'input' | 'output';

/**
 * Value kind fallback when no server validation result is available (mirrors the gateway's
 * KindFromDataType, plus the text types `Text` / `WSTRING` / `STRING[n]`, which must never read as Int).
 */
function kindFromDataType(dataType: string): 'Bool' | 'Int' | 'Float' | 'Text' {
  const d = dataType.trim().toUpperCase();
  if (d === 'BOOL' || d === 'BIT') return 'Bool';
  if (d === 'REAL' || d === 'LREAL' || d === 'FLOAT') return 'Float';
  if (isTextDataType(d)) return 'Text';
  return 'Int';
}

/** Direction encoded in an rv wire type ("PLCInputBool" → 'input'), or null when absent. */
function directionOfType(type: string | null | undefined): SignalDirection | null {
  if (!type) return null;
  if (type.includes('PLCInput')) return 'input';
  if (type.includes('PLCOutput')) return 'output';
  return null;
}

/** Value kind suffix of an rv wire type ("PLCInputBool" → "Bool"), or null. */
function kindOfType(type: string | null | undefined): string | null {
  const m = type?.match(/^PLC(?:Input|Output)(Bool|Int|Float|Text)$/);
  return m ? m[1] : null;
}

/**
 * Inverse of the data-type → wire-kind mapping. Written out explicitly on purpose: three of the
 * four kinds carry the same name as their data type, but the wire kind `Text` is called `String`
 * in the schemas — a plain suffix hand-over would produce an invalid data type for text signals.
 */
const DATA_TYPE_OF_KIND: Readonly<Record<string, string>> = {
  Bool: 'Bool',
  Int: 'Int',
  Float: 'Float',
  Text: 'String',
};

/** A data type counts as present only when it holds a non-blank value. */
function hasDataType(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Data type to seed the dialog with (plan-352 F9).
 *
 * Order: the signal's own dataType wins; if it is missing the type is DERIVED from the signal's
 * wire type; only then does the schema's first entry apply. Without the derivation step a pure
 * direction change silently rewrote the value kind — `SignalConfig.DataType` is initialized to `""`
 * server-side, so a `??` fallback never fires for the real legacy case, and the schema default for
 * MQTT is `Bool`: a `PLCOutputFloat` came back as `PLCInputBool`.
 *
 * Blank (empty or whitespace) counts as missing. The derived type is matched against the schema
 * exactly, then case-insensitively, then by value kind — so an S7 `PLCOutputFloat` lands on `Real`
 * instead of falling back to `Bool`.
 */
export function seedSignalDataType(
  editSignal: ConnectInterfaceSignal | null | undefined,
  schema: ConnectSignalSchema | null,
): string {
  if (hasDataType(editSignal?.dataType)) return editSignal!.dataType!;

  const kind = kindOfType(editSignal?.type);
  const derived = kind ? DATA_TYPE_OF_KIND[kind] : undefined;
  const dataTypes = schema?.dataTypes ?? [];
  if (derived) {
    if (dataTypes.length === 0) return derived;
    const match = dataTypes.find(dt => dt === derived)
      ?? dataTypes.find(dt => dt.toUpperCase() === derived.toUpperCase())
      ?? dataTypes.find(dt => kindFromDataType(dt) === kind);
    if (match) return match;
  }
  return dataTypes[0] ?? '';
}

/** The OPC UA acquisition fields a signal carries (plan-2025 F10) — copied verbatim into a dialog save. */
export function opcUaFieldsOf(signal: ConnectInterfaceSignal | null | undefined): Pick<ConnectInterfaceSignal, 'subscribeValue' | 'pollValue' | 'pollCycleMs'> {
  if (!signal) return {};
  return {
    ...(typeof signal.subscribeValue === 'boolean' ? { subscribeValue: signal.subscribeValue } : {}),
    ...(typeof signal.pollValue === 'boolean' ? { pollValue: signal.pollValue } : {}),
    ...(typeof signal.pollCycleMs === 'number' ? { pollCycleMs: signal.pollCycleMs } : {}),
  };
}

export function SignalEditDialog({
  open,
  onClose,
  iface,
  schema,
  editSignal,
  isBound,
  topic,
  mode,
  nameReadOnly,
  seed,
}: {
  open: boolean;
  onClose: () => void;
  iface: ConnectInterface;
  /** Per-type signal schema from the gateway; null = older gateway (dialog still works, no hints/validation). */
  schema: ConnectSignalSchema | null;
  /** Signal being edited, or null/undefined to create a new one. */
  editSignal?: ConnectInterfaceSignal | null;
  /** True when the edited signal is bound to the loaded model (rename warning). */
  isBound?: boolean;
  /** plan-589: MQTT topic container the signal lives in; omit for the interface-level `signals` list. */
  topic?: string;
  /** plan-589: payload mode of `topic` — decides the address rule and the validator. */
  mode?: MqttTopicMode;
  /**
   * plan-589 F5: opened from a MODEL signal, whose name is the key the binding couples by. Renaming
   * it here would silently unbind the model, so the field is read-only — the rename is the
   * inspector's name row (plan-590 `SignalRenameDialog`).
   */
  nameReadOnly?: boolean;
  /**
   * plan-589: prefill for ADD mode — the inspector opens the dialog from a model signal that has no
   * CONNECT entry yet and already knows the name, wire type and origin data type. Ignored while
   * editing, where the stored signal is authoritative.
   */
  seed?: { name?: string; type?: string; dataType?: string };
}) {
  const isEdit = !!editSignal;
  // plan-2024 F3: while this dialog is open a config push is held, so an interface deleted or
  // changed elsewhere never tears the dialog (or the typed input) away - a notice says so instead.
  useEffect(() => {
    if (!open) return undefined;
    return holdConnectConfigEditing();
  }, [open]);
  const configNotice = useSyncExternalStore(subscribeConnectConfigNotice, getConnectConfigNotice);
  // The address rule of THIS place. null = the gateway states none (older gateway): no requirement
  // and no warning, which is the plan's explicit compatibility promise (§5.4).
  const addressRule = addressRuleFor({ topic, mode }, schema);
  const addressRequired = addressRule === 'required';
  // A ProcessImage address is a Siemens byte offset, not an MQTT topic — the server-side validator
  // would apply the topic parser to it, so this one place validates locally instead.
  const localAddressCheck = mode === 'ProcessImage';

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [dataType, setDataType] = useState('');
  const [direction, setDirection] = useState<SignalDirection>('output');
  // Once the user picks a direction by hand it is never overwritten by a validation prefill.
  const [directionTouched, setDirectionTouched] = useState(false);
  const [comment, setComment] = useState('');
  const [record, setRecord] = useState(false);

  const [validation, setValidation] = useState<SignalValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // plan-2025 F10: a save that renamed but could not store the other fields (or whose rename is not
  // confirmed yet). Kept until the dialog closes; the next Save resumes from it instead of renaming again.
  const [renameProgress, setRenameProgress] = useState<SignalRenameProgress | null>(null);
  const [renameNotice, setRenameNotice] = useState<string | null>(null);

  // (Re)seed the form whenever the dialog opens for a different signal / mode.
  useEffect(() => {
    if (!open) return;
    setName(editSignal?.name ?? seed?.name ?? '');
    setAddress(editSignal?.protocolAddress ?? '');
    // In ADD mode the seed stands in for the stored signal, so the model's own wire type and origin
    // data type drive the same derivation the edit path uses.
    setDataType(seedSignalDataType(editSignal ?? (seed ? { ...seed, name: seed.name ?? '', protocolAddress: '', type: seed.type ?? '', record: false } : null), schema));
    setDirection(directionOfType(editSignal?.type ?? seed?.type) ?? 'output');
    // An existing signal's direction is authoritative — and so is a seeded one, which comes from the
    // model signal's own type and must not be overwritten by an address-derived guess.
    setDirectionTouched(!!editSignal || !!seed?.type);
    setComment(editSignal?.comment ?? '');
    setRecord(editSignal?.record ?? false);
    setValidation(null);
    setSaveError(null);
    setRenameProgress(null);
    setRenameNotice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editSignal]);

  // Live server-side validation, debounced. The direction is only sent once the user chose it
  // explicitly — otherwise the gateway derives it from the address (S7 area, FANUC prefix) and
  // `effectiveType` prefills the toggle below.
  useEffect(() => {
    if (!open || !address.trim()) {
      setValidation(null);
      return;
    }
    // ProcessImage (plan-589): checked here, with the gateway's own symbolic-address syntax. The
    // DataType cross-check (`%IW13` declared Bool) stays on the gateway, which runs it over the
    // whole tag table when the worker compiles.
    if (localAddressCheck) {
      const valid = isProcessImageAddress(address);
      setValidating(false);
      setValidation({
        checked: true,
        valid,
        error: valid ? null : `Invalid process-image address '${address.trim()}' — expected e.g. %IW13, %I3.1 or 96.0`,
        normalizedAddress: valid ? address.trim() : null,
      });
      return;
    }
    setValidating(true);
    const kind = kindFromDataType(dataType);
    const explicitType = directionTouched ? `PLC${direction === 'input' ? 'Input' : 'Output'}${kind}` : undefined;
    const timer = window.setTimeout(() => {
      void validateSignalAddress(iface.type, address.trim(), dataType || undefined, explicitType)
        .then(result => {
          setValidation(result);
          setValidating(false);
          // Prefill the direction from the address (S7 I/Q/M area, FANUC do/di prefix) as long as
          // the user has not chosen one by hand.
          if (result?.valid && schema?.directionFromAddress && !directionTouched) {
            const derived = directionOfType(result.effectiveType);
            if (derived) setDirection(derived);
          }
        });
    }, VALIDATE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, address, dataType, direction, directionTouched, iface.type, localAddressCheck]);

  const addressBlocked = !!validation && validation.checked && !validation.valid;
  // plan-589 F12: an address is only MANDATORY where the gateway says so. Everywhere else an empty
  // address is a legitimate configuration (container topic, Json key by name, name fallback), and
  // an unstated rule must not invent a requirement either.
  const addressMissing = addressRequired && address.trim().length === 0;
  const canSave = !saving && name.trim().length > 0 && !addressMissing && !addressBlocked;
  const renamed = isEdit && name.trim() !== editSignal!.name;

  const wireType = useMemo(() => {
    // Value kind: prefer the gateway's effectiveType (knows FANUC/Denso prefixes and bit
    // addresses); fall back to the DataType mapping. Direction: always the user-visible toggle.
    const kind = kindOfType(validation?.effectiveType) ?? kindFromDataType(dataType);
    return `PLC${direction === 'input' ? 'Input' : 'Output'}${kind}`;
  }, [validation, dataType, direction]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    const signal: ConnectInterfaceSignal = {
      name: name.trim(),
      protocolAddress: (validation?.valid && validation.normalizedAddress) || address.trim(),
      type: wireType,
      ...(dataType ? { dataType } : {}),
      ...(comment.trim() ? { comment: comment.trim() } : {}),
      record,
      // plan-2025 F10: the OPC UA acquisition fields are not edited here, so they travel unchanged —
      // a save never resets them to the gateway default (the write core would keep them anyway).
      ...opcUaFieldsOf(editSignal),
    };
    try {
      // plan-589: into the SLOT's container — a topic's own `signals` list when the dialog was
      // opened on one, the interface-level list otherwise.
      const outcome = await saveSignalFromDialog({
        interfaceId: iface.id,
        topic,
        originalName: isEdit ? editSignal!.name : null,
        signal,
        resume: renameProgress,
      });
      if (outcome.kind === 'saved') {
        onClose();
      } else {
        setRenameProgress(outcome.progress);
        setRenameNotice(outcome.message);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  }, [iface.id, isEdit, editSignal, name, address, dataType, comment, record, wireType, validation, topic, onClose, renameProgress]);

  // plan-589: a ProcessImage place is addressed by a Siemens byte offset, so the MQTT schema's
  // "Topic" label and topic hint would be the wrong words for it.
  const addressLabel = localAddressCheck
    ? 'Address'
    : `${schema?.addressLabel ?? 'Address'}${addressRequired ? '' : ' (optional)'}`;
  const dataTypes = schema?.dataTypes ?? [];

  /** Why an empty address is fine here — the gateway's rule, said in one line. */
  const optionalAddressHint =
    addressRule === 'container-topic' ? `Leave empty — the topic '${topic ?? ''}' is the address.`
      : addressRule === 'none' ? 'Leave empty — this topic keys its JSON object by the signal name.'
        : addressRule === 'name-fallback' ? 'Leave empty to use the signal name as the address.'
          : '';

  // Address helper line: parser error (blocks Save) > validated OK > syntax hint.
  const addressHelper = addressBlocked
    ? validation!.error ?? 'Invalid address'
    : localAddressCheck
      ? 'Siemens process-image address — %IW13, %I3.1, %QX2.7 or a bare byte offset (96.0)'
      : optionalAddressHint || schema?.addressHint || '';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14 }}>
        {isEdit ? <Edit sx={{ color: 'primary.main' }} /> : <Add sx={{ color: 'primary.main' }} />}
        {isEdit ? 'Edit Signal' : 'Add Signal'} — {iface.type}
        {topic ? ` · ${topic}` : ''}
      </DialogTitle>
      <DialogContent>
        {configNotice.pending && (
          <Alert
            severity="info"
            variant="outlined"
            data-testid="signal-edit-config-changed"
            sx={{ mb: 1, fontSize: 11, py: 0 }}
          >
            Configuration changed outside. Your input is kept; the change loads when this dialog closes.
          </Alert>
        )}
        <Tooltip
          title={nameReadOnly ? SIGNAL_NAME_HERE_READONLY : ''}
          disableInteractive
          disableHoverListener={!nameReadOnly}
        >
          <TextField
            fullWidth
            size="small"
            label="Signal name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            inputProps={{
              readOnly: nameReadOnly,
              'aria-readonly': nameReadOnly ? 'true' : undefined,
              // Stable handle: "Signal name" is also an ADDRESS label on several protocols
              // (SHM, ABB, FANUC), so a label query cannot tell the two fields apart.
              'data-testid': 'rv-signal-name-input',
            }}
            helperText={nameReadOnly
              // The model couples by this name: renaming it here would unbind the model. The rename
              // is the inspector's name row (plan-590), which carries every reference along.
              ? SIGNAL_NAME_HERE_READONLY
              : 'Unique across all interfaces — models couple to signals by this name'}
            sx={{ mt: 1, mb: 1 }}
          />
        </Tooltip>

        {renamed && isBound && (
          <Alert severity="warning" sx={{ mb: 1, fontSize: 11, py: 0 }}>
            This signal is used by the loaded model (coupled by name). Renaming it breaks that
            binding until the model or link is updated.
          </Alert>
        )}

        <TextField
          fullWidth
          size="small"
          label={addressLabel}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          error={addressBlocked}
          helperText={addressHelper}
          inputProps={{ 'data-testid': 'rv-signal-address-input' }}
          InputProps={{
            sx: { fontFamily: 'monospace' },
            endAdornment: validating
              ? <CircularProgress size={12} />
              : validation?.checked && validation.valid
                ? (
                  <Tooltip title={`Validated${validation.normalizedAddress && validation.normalizedAddress !== address.trim() ? ` — saved as ${validation.normalizedAddress}` : ''}`}>
                    <CheckCircleOutline sx={{ fontSize: 16, color: '#66bb6a' }} />
                  </Tooltip>
                )
                : undefined,
          }}
          sx={{ mb: 0.5 }}
        />

        {/* The schema's examples belong to the interface-level address. In an MQTT topic container
            they would be topics offered for a byte offset (ProcessImage) or for a field that must
            stay empty (Single / Json), so they are shown only for the flat container. */}
        {topic === undefined && (schema?.addressExamples.length ?? 0) > 0 && (
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
            <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>e.g.</Typography>
            {schema!.addressExamples.map(ex => (
              <Tooltip key={ex} title="Click to use this example" disableInteractive>
                <Chip
                  label={ex}
                  size="small"
                  onClick={() => setAddress(ex)}
                  sx={{ fontSize: 10, height: 20, fontFamily: 'monospace', cursor: 'pointer' }}
                />
              </Tooltip>
            ))}
          </Box>
        )}

        <Box sx={{ display: 'flex', gap: 1, mb: 1, alignItems: 'flex-start' }}>
          {dataTypes.length > 0 ? (
            <TextField
              select
              size="small"
              label="Data type"
              value={dataTypes.includes(dataType) ? dataType : ''}
              onChange={(e) => setDataType(e.target.value)}
              sx={{ flex: 1 }}
            >
              {dataTypes.map(dt => <MenuItem key={dt} value={dt} sx={{ fontSize: 12 }}>{dt}</MenuItem>)}
            </TextField>
          ) : (
            <TextField
              size="small"
              label="Data type (optional)"
              value={dataType}
              onChange={(e) => setDataType(e.target.value)}
              sx={{ flex: 1 }}
            />
          )}

          {/* Direction follows the PLC convention: Output = PLC supplies, viewer reads;
              Input = viewer writes to the PLC. Prefilled from the address when it encodes
              a direction (S7 area, FANUC prefix); a manual choice always wins. */}
          <Box>
            <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.65)', mb: 0.25 }}>
              Direction
            </Typography>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={direction}
              onChange={(_, v: SignalDirection | null) => {
                if (!v) return;
                setDirection(v);
                setDirectionTouched(true);
              }}
              sx={{ '& .MuiToggleButton-root': { fontSize: 10, textTransform: 'none', py: 0.5, px: 1 } }}
            >
              {/* Tooltips wrap the LABELS, not the buttons — ToggleButtonGroup injects its
                  selection props via cloneElement into direct children, and a Tooltip in
                  between would swallow them. */}
              <ToggleButton value="output">
                <Tooltip title="PLC Output — the PLC supplies the value, the viewer reads it" disableInteractive>
                  <span>Read from PLC</span>
                </Tooltip>
              </ToggleButton>
              <ToggleButton value="input">
                <Tooltip title="PLC Input — the viewer writes the value to the PLC" disableInteractive>
                  <span>Write to PLC</span>
                </Tooltip>
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>
        </Box>

        <TextField
          fullWidth
          size="small"
          label="Comment (optional)"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          sx={{ mb: 0.5 }}
        />

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Checkbox checked={record} onChange={(e) => setRecord(e.target.checked)} size="small" />
          <Tooltip title="Store this signal's value history in the CONNECT historian" disableInteractive>
            <Typography sx={{ fontSize: 12 }}>Record (historian)</Typography>
          </Tooltip>
          <Box sx={{ flex: 1 }} />
          <Tooltip title="Resulting wire type — derived from direction and data type" disableInteractive>
            <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.6)', fontFamily: 'monospace' }}>
              wire type: {wireType}
            </Typography>
          </Tooltip>
        </Box>

        {renameNotice && (
          <Alert severity="warning" data-testid="signal-edit-rename-partial" sx={{ mt: 1, fontSize: 11, py: 0 }}>
            {renameNotice}
          </Alert>
        )}
        {saveError && (
          <Alert severity="error" sx={{ mt: 1, fontSize: 11, py: 0 }}>
            {saveError}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={!canSave} sx={{ textTransform: 'none' }}>
          {saving ? 'Saving...' : renameProgress ? 'Retry' : isEdit ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
