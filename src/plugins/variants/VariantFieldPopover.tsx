// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * VariantFieldPopover — state 4 of Concept D (plan-2013): the values of ALL variants for
 * ONE field, opened from the row's icon.
 *
 * Three rules this surface exists to make unmissable (Codex P0):
 *
 *  1. The EDIT TARGET is visible. Exactly one row is selected, the editor carries the label
 *     "Editing: <Base | variant>", and an edit of a variant that is not in the scene only
 *     changes the store — the scene and the simulation are not touched (no reset, no
 *     confirm). Only an edit of the variant IN THE SCENE applies, and only that one asks
 *     once at t > 0.
 *  2. An override whose value EQUALS Base is not the same as "not set". It keeps its row
 *     marked ("Explicitly set, currently equal to Base") and its "← Base" button; nothing
 *     here deletes it automatically.
 *  3. Base is edited in Base. While a variant drives the scene the Base row is read-only
 *     and offers "Switch to Base" instead — so no inherited row can silently write Base
 *     under an active variant. In Base, an edit that other variants inherit names its
 *     effect ("N variants inherit this value") and asks before it commits.
 *
 * The value editor is always the inspector's own `FieldEditor` for that field — never a
 * second editor of our own.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Box, Button, Divider, IconButton, Popover, Tooltip, Typography } from '@mui/material';
import { Close } from '@mui/icons-material';
import type { RVViewer } from '../../core/rv-viewer';
import type { FieldKey, ParamFieldInfo, ParamValue } from '../../core/params/rv-param-field';
import { FieldEditor } from '../../core/hmi/rv-field-editors';
import { formatDisplayValue, type FieldType } from '../../core/hmi/rv-inspector-helpers';
import { ACCENT, DIVIDER, ERROR, FS, INK_LOW, INK_MID, WARN } from '../../core/hmi/shared-sx';
import type { RvExtrasEditorPlugin } from '../../core/hmi/rv-extras-editor';
import type { Variant } from '../../core/variants/rv-variant-model';
import { activateVariant } from './variant-commands';
import type { VariantsRuntime } from './variants-runtime';
import {
  baseValueOf,
  fieldInfoOf,
  inheritingVariants,
  nextVariantName,
  overrideEqualsBase,
  resultProblem,
} from './variant-ui';

const BUTTON_SX = { minHeight: 24, fontSize: FS.micro, textTransform: 'none', px: 0.75 } as const;
const BASE = 'base';

export interface VariantFieldPopoverProps {
  viewer: RVViewer | null;
  runtime: VariantsRuntime;
  anchorEl: HTMLElement | null;
  fieldKey: FieldKey;
  /** Concrete component key of the row (`Source`, `Drive_1`). */
  componentType: string;
  fieldName: string;
  onClose(): void;
}

type Pending =
  | { kind: 'variant-reset'; variantId: string; value: ParamValue }
  | { kind: 'base-inherited'; value: ParamValue; count: number };

/** `FieldEditor`'s type for a variable field — the schema decides, never the value. */
function editorTypeOf(info: ParamFieldInfo | null): FieldType {
  if (info?.type === 'boolean') return 'boolean';
  if (info?.type === 'enum') return 'enum';
  if (info?.type === 'number' || info?.type === 'integer') return 'number';
  return 'string';
}

/** A value the editor can start from when neither an override nor Base is known. */
function seedValue(info: ParamFieldInfo | null): ParamValue {
  if (typeof info?.default === 'number' || typeof info?.default === 'boolean' || typeof info?.default === 'string') {
    return info.default;
  }
  if (info?.type === 'boolean') return false;
  if (info?.type === 'enum') return info.enum?.[0] ?? '';
  return 0;
}

export function VariantFieldPopover({
  viewer, runtime, anchorEl, fieldKey, componentType, fieldName, onClose,
}: VariantFieldPopoverProps) {
  const store = runtime.store;
  useSyncExternalStore(store.subscribe.bind(store), () => store.version);
  const variants = store.block.variants;
  const scene = store.sceneVariant;
  const info = fieldInfoOf(runtime, fieldKey);
  const base = baseValueOf(runtime, fieldKey, info.state);
  const baseValue = base?.kind === 'value' ? base.value as ParamValue : null;

  const verdict = useMemo(
    () => runtime.service.checkValue(componentType, fieldName, null),
    [runtime, componentType, fieldName],
  );
  const schema = verdict.ok ? verdict.info : null;
  const unit = schema?.unit;

  // Edit target: the variant in the scene if there is one, else Base. A newly created
  // variant becomes the target without going into the scene.
  const [target, setTarget] = useState<string>(scene ?? BASE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { setTarget(scene ?? BASE); }, [scene]);

  const targetVariant: Variant | undefined = target === BASE ? undefined : store.variant(target);
  const targetName = target === BASE ? 'Base' : targetVariant?.name ?? target;
  const targetIsScene = target !== BASE && target === scene;
  // Base is only editable in Base (Codex: no silent Base edit under an active variant).
  const baseEditable = scene === null;
  const editable = target === BASE ? baseEditable : Boolean(targetVariant);

  const own = (id: string): ParamValue | undefined => runtime.index.valueOf(fieldKey, id) as ParamValue | undefined;
  const currentValue: ParamValue = target === BASE
    ? baseValue ?? seedValue(schema)
    : own(target) ?? baseValue ?? seedValue(schema);

  const run = async (fn: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    setError(null);
    try { setError(await fn()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  /** Writes a Base value through the inspector's own write path (scene is in Base). */
  const writeBase = async (value: ParamValue): Promise<string | null> => {
    const editor = viewer?.getPlugin?.('rv-extras-editor') as RvExtrasEditorPlugin | undefined;
    const node = runtime.service.resolve(fieldKey);
    const path = node ? viewer?.registry?.getPathForNode(node) ?? null : null;
    if (!editor || !path) return 'Base cannot be edited for this node.';
    return editor.updateOverlayField(path, componentType, fieldName, value) ? null : 'The Base edit was refused.';
  };

  const commitVariant = async (variantId: string, value: ParamValue): Promise<string | null> => {
    const result = await store.set(variantId, fieldKey, value);
    return resultProblem(result);
  };

  const commit = (value: ParamValue): void => {
    setPending(null);
    if (target === BASE) {
      const count = inheritingVariants(variants, info).length;
      if (count > 0) { setPending({ kind: 'base-inherited', value, count }); return; }
      void run(() => writeBase(value));
      return;
    }
    if (!targetVariant) return;
    if (targetIsScene && (viewer?.simTime ?? 0) > 0) {
      setPending({ kind: 'variant-reset', variantId: targetVariant.id, value });
      return;
    }
    void run(() => commitVariant(targetVariant.id, value));
  };

  const backToBase = (variantId: string): void => {
    void run(async () => resultProblem(await store.unset(variantId, fieldKey)));
  };

  const addVariant = (): void => {
    void run(async () => {
      const made = runtime.create(nextVariantName(variants));
      const problem = resultProblem(made);
      // Created, NOT put into the scene: nothing is applied and nothing resets. It only
      // becomes the edit target of this popover.
      if (made.ok && made.id) setTarget(made.id);
      return problem;
    });
  };

  const switchToBase = (): void => {
    void run(async () => {
      if (!viewer) return 'no viewer';
      return resultProblem(await activateVariant(viewer, { id: BASE }));
    });
  };

  const rows: Array<{ id: string; name: string; inScene: boolean }> = [
    { id: BASE, name: 'Base', inScene: scene === null },
    ...variants.map((v) => ({ id: v.id, name: v.name, inScene: v.id === scene })),
  ];

  return (
    <Popover
      open={Boolean(anchorEl)}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      slotProps={{ paper: { sx: { p: 1, minWidth: 288, maxWidth: 360 }, 'aria-label': `Variants of ${fieldName}` } }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
        <Typography sx={{ flex: 1, fontSize: FS.body, fontWeight: 600 }}>
          {fieldName} · {componentType}
        </Typography>
        <IconButton size="small" aria-label="Close" onClick={onClose} sx={{ p: 0.25 }}>
          <Close sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>

      {!verdict.ok && (
        <Typography role="alert" sx={{ fontSize: FS.micro, color: ERROR }}>{verdict.detail}</Typography>
      )}

      {rows.map((row) => {
        const value = row.id === BASE ? baseValue : own(row.id) ?? null;
        const hasOverride = row.id !== BASE && own(row.id) !== undefined;
        const equalsBase = hasOverride && overrideEqualsBase(base, own(row.id));
        const selected = row.id === target;
        return (
          <Box
            key={row.id}
            data-testid={`variant-field-row-${row.id}`}
            data-variant-equals-base={equalsBase ? 'true' : undefined}
            sx={{
              display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25, px: 0.5, borderRadius: 0.5,
              ...(selected ? { bgcolor: 'rgba(255,255,255,0.06)' } : {}),
            }}
          >
            <Button
              size="small"
              role="radio"
              aria-checked={selected}
              aria-label={`Edit ${row.name}`}
              onClick={() => { setTarget(row.id); setError(null); setPending(null); setEditorKey((k) => k + 1); }}
              sx={{ ...BUTTON_SX, flex: 1, justifyContent: 'flex-start', color: selected ? ACCENT : INK_MID }}
            >
              {row.name}
              {row.inScene && (
                <Box component="span" sx={{ ml: 0.5, fontSize: 9, fontWeight: 700, color: ACCENT }}>IN SCENE</Box>
              )}
            </Button>
            {!selected && (
              <Typography sx={{ fontSize: FS.micro, fontFamily: 'monospace', color: hasOverride ? INK_MID : INK_LOW }}>
                {row.id === BASE
                  ? (value === null ? '—' : formatDisplayValue(value))
                  : hasOverride
                    ? formatDisplayValue(value)
                    : `inherits ${baseValue === null ? '—' : formatDisplayValue(baseValue)}`}
              </Typography>
            )}
            {equalsBase && (
              <Tooltip title="Explicitly set, currently equal to Base — it keeps this value if Base changes">
                <Box component="span" data-testid="variant-equals-base-tag" sx={{ fontSize: 9, fontWeight: 700, color: WARN }}>=</Box>
              </Tooltip>
            )}
            {hasOverride && (
              <Button
                size="small"
                disabled={busy}
                aria-label={`${row.name} back to Base`}
                onClick={() => backToBase(row.id)}
                sx={{ ...BUTTON_SX, color: INK_MID }}
              >
                ← Base
              </Button>
            )}
          </Box>
        );
      })}

      <Divider sx={{ my: 0.75, borderColor: DIVIDER }} />

      <Box sx={{ px: 0.5 }}>
        <Typography data-testid="variant-edit-target" sx={{ fontSize: FS.micro, color: INK_LOW, mb: 0.25 }}>
          {editable
            ? `Editing: ${targetName}${targetIsScene ? ' (in scene)' : target === BASE ? '' : ' — not in the scene'}`
            : `Base is edited in Base — '${store.variant(scene ?? '')?.name ?? 'a variant'}' is in the scene`}
        </Typography>
        {editable ? (
          <FieldEditor
            key={`${target}:${editorKey}`}
            value={currentValue}
            onChange={(v) => commit(v as ParamValue)}
            fieldType={editorTypeOf(schema)}
            fieldName={fieldName}
            editable
            unit={unit}
            options={schema?.enum ? [...schema.enum] : undefined}
          />
        ) : (
          <Button size="small" disabled={busy} onClick={switchToBase} sx={BUTTON_SX}>Switch to Base</Button>
        )}
        {target !== BASE && !targetIsScene && editable && (
          <Typography sx={{ fontSize: FS.micro, color: INK_LOW, mt: 0.25 }}>
            The scene and the simulation are not touched.
          </Typography>
        )}
        {target === BASE && editable && inheritingVariants(variants, info).length > 0 && (
          <Typography sx={{ fontSize: FS.micro, color: WARN, mt: 0.25 }}>
            {inheritingVariants(variants, info).length} variant(s) inherit this value.
          </Typography>
        )}
      </Box>

      {pending?.kind === 'variant-reset' && (
        <Box role="alertdialog" aria-label="Apply variant value" sx={{ mt: 0.75, p: 0.75, border: '1px solid', borderColor: 'warning.main', borderRadius: 1 }}>
          <Typography sx={{ fontSize: FS.micro, mb: 0.5 }}>Applying this value resets the simulation to t = 0.</Typography>
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <Button size="small" disabled={busy} onClick={() => { const p = pending; setPending(null); void run(() => commitVariant(p.variantId, p.value)); }} sx={BUTTON_SX}>
              Apply and reset
            </Button>
            <Button size="small" autoFocus ref={cancelRef} onClick={() => setPending(null)} sx={BUTTON_SX}>Cancel</Button>
          </Box>
        </Box>
      )}

      {pending?.kind === 'base-inherited' && (
        <Box role="alertdialog" aria-label="Change Base" sx={{ mt: 0.75, p: 0.75, border: '1px solid', borderColor: 'warning.main', borderRadius: 1 }}>
          <Typography sx={{ fontSize: FS.micro, mb: 0.5 }}>
            This changes Base — {pending.count} variant(s) inherit this value and change with it.
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <Button size="small" disabled={busy} onClick={() => { const p = pending; setPending(null); void run(() => writeBase(p.value)); }} sx={BUTTON_SX}>
              Change Base
            </Button>
            <Button size="small" autoFocus ref={cancelRef} onClick={() => setPending(null)} sx={BUTTON_SX}>Cancel</Button>
          </Box>
        </Box>
      )}

      {error && <Typography role="alert" sx={{ mt: 0.5, px: 0.5, fontSize: FS.micro, color: ERROR }}>{error}</Typography>}

      <Box sx={{ mt: 0.5, display: 'flex' }}>
        <Button size="small" disabled={busy} onClick={addVariant} sx={BUTTON_SX}>+ New variant</Button>
      </Box>
    </Popover>
  );
}
