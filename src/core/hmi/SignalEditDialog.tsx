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
 * Saving writes through the store's addSignal/updateSignal → PUT full interface (collision check,
 * atomic save and worker hot-reload included). For MQTT this creates a Single-mode signal exactly
 * like the Unity MQTTInterface: one topic per signal, the payload is one scalar value.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
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
  addSignal,
  updateSignal,
  validateSignalAddress,
  type ConnectInterface,
  type ConnectInterfaceSignal,
  type ConnectSignalSchema,
  type SignalValidationResult,
} from './connect-store';

/** Debounce for the live address validation round-trip. */
const VALIDATE_DEBOUNCE_MS = 300;

type SignalDirection = 'input' | 'output';

/** Value kind fallback when no server validation result is available (mirrors the gateway's KindFromDataType). */
function kindFromDataType(dataType: string): 'Bool' | 'Int' | 'Float' | 'Text' {
  const d = dataType.trim().toUpperCase();
  if (d === 'BOOL' || d === 'BIT') return 'Bool';
  if (d === 'REAL' || d === 'LREAL' || d === 'FLOAT') return 'Float';
  if (d === 'STRING') return 'Text';
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

export function SignalEditDialog({
  open,
  onClose,
  iface,
  schema,
  editSignal,
  isBound,
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
}) {
  const isEdit = !!editSignal;

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

  // (Re)seed the form whenever the dialog opens for a different signal / mode.
  useEffect(() => {
    if (!open) return;
    setName(editSignal?.name ?? '');
    setAddress(editSignal?.protocolAddress ?? '');
    setDataType(seedSignalDataType(editSignal, schema));
    setDirection(directionOfType(editSignal?.type) ?? 'output');
    setDirectionTouched(!!editSignal); // an existing signal's direction is authoritative
    setComment(editSignal?.comment ?? '');
    setRecord(editSignal?.record ?? false);
    setValidation(null);
    setSaveError(null);
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
  }, [open, address, dataType, direction, directionTouched, iface.type]);

  const addressBlocked = !!validation && validation.checked && !validation.valid;
  const canSave = !saving && name.trim().length > 0 && address.trim().length > 0 && !addressBlocked;
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
    };
    try {
      if (isEdit) await updateSignal(iface.id, editSignal!.name, signal);
      else await addSignal(iface.id, signal);
      onClose();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    }
    setSaving(false);
  }, [iface.id, isEdit, editSignal, name, address, dataType, comment, record, wireType, validation, onClose]);

  const addressLabel = schema?.addressLabel ?? 'Address';
  const dataTypes = schema?.dataTypes ?? [];

  // Address helper line: parser error (blocks Save) > validated OK > syntax hint.
  const addressHelper = addressBlocked
    ? validation!.error ?? 'Invalid address'
    : schema?.addressHint ?? '';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontSize: 14 }}>
        {isEdit ? <Edit sx={{ color: 'primary.main' }} /> : <Add sx={{ color: 'primary.main' }} />}
        {isEdit ? 'Edit Signal' : 'Add Signal'} — {iface.type}
      </DialogTitle>
      <DialogContent>
        <TextField
          fullWidth
          size="small"
          label="Signal name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          helperText="Unique across all interfaces — models couple to signals by this name"
          sx={{ mt: 1, mb: 1 }}
        />

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

        {(schema?.addressExamples.length ?? 0) > 0 && (
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

        {saveError && (
          <Alert severity="error" sx={{ mt: 1, fontSize: 11, py: 0 }}>
            {saveError}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={!canSave} sx={{ textTransform: 'none' }}>
          {saving ? 'Saving...' : isEdit ? 'Save' : 'Add'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
