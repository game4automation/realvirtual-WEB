// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * VariantFieldMarker — states 2 and 3 of Concept D (plan-2013): the icon every SCALAR
 * inspector row carries while variant management is on, and the row marking that goes with
 * it. Registered as a field-row action by the variants runtime, so none of it exists while
 * the mode is off.
 *
 * Three icon states, not two:
 *
 *   ◆ filled   the variant IN THE SCENE overrides this field (the row is marked too)
 *   ◈ half     the scene inherits Base here, but another variant differs
 *   ◇ pale     no variant varies this field
 *
 * Plus the SECOND DIMENSION Codex insisted on: an override whose value currently equals
 * Base is still an override (it protects the field against later Base changes). It is not a
 * fourth state — it is the filled icon in a neutral colour with a small `=`, and its
 * tooltip says so. Nothing deletes such an override automatically, and the compare table
 * lists it like any other.
 *
 * Multi-selection: the icon is absent (plan-2013 / Codex P0 #2 — one clear target beats an
 * unclear batch semantics in the first version).
 */

import { useRef, useState, useSyncExternalStore } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import { Diamond, DiamondOutlined } from '@mui/icons-material';
import type { FieldRowActionContext } from '../../core/hmi/rv-field-row-actions';
import { ACCENT, INK_LOW, INK_MID, WARN } from '../../core/hmi/shared-sx';
import { formatDisplayValue } from '../../core/hmi/rv-inspector-helpers';
import type { VariantFieldState } from '../../core/variants/rv-variant-index';
import type { VariantsRuntime } from './variants-runtime';
import { VariantFieldPopover } from './VariantFieldPopover';
import {
  baseValueOf,
  fieldInfoOf,
  fieldKeyOf,
  isVariableField,
  overrideEqualsBase,
} from './variant-ui';

const HIT = 24;

/** Is this row a variant target at all? Cheap: schema admission + selection size. */
export function markerApplies(rt: VariantsRuntime | null, ctx: FieldRowActionContext): boolean {
  if (!rt || !ctx.nodePath) return false;
  const selected = ctx.viewer?.selectionManager?.getSnapshot?.().nodes.length ?? 1;
  if (selected > 1) return false;
  return isVariableField(rt, ctx.componentType, ctx.fieldName);
}

/** The row marking of a field the variant in the scene overrides. */
export function markerRowSx(rt: VariantsRuntime | null, ctx: FieldRowActionContext): Record<string, unknown> | undefined {
  if (!rt) return undefined;
  const key = fieldKeyOf(ctx.viewer, ctx.nodePath, ctx.componentType, ctx.fieldName);
  if (!key) return undefined;
  const info = rt.index.infoOf(key);
  if (info.state !== 'overridden') return undefined;
  const equal = overrideEqualsBase(baseValueOf(rt, key, info.state), info.value);
  return { boxShadow: `inset 2px 0 0 ${equal ? WARN : ACCENT}` };
}

function HalfDiamond({ color }: { color: string }) {
  return (
    <Box component="span" sx={{ position: 'relative', display: 'inline-flex', width: 14, height: 14 }}>
      <DiamondOutlined sx={{ position: 'absolute', inset: 0, fontSize: 14, color }} />
      <Diamond sx={{ position: 'absolute', inset: 0, fontSize: 14, color, clipPath: 'polygon(0 0, 50% 0, 50% 100%, 0 100%)' }} />
    </Box>
  );
}

function tooltipOf(state: VariantFieldState, count: number, equalsBase: boolean, value: unknown): string {
  if (state === 'overridden') {
    return equalsBase
      ? 'Explicitly set by the variant in the scene, currently equal to Base — click to see every variant'
      : `The variant in the scene sets ${formatDisplayValue(value)} here — click to see every variant`;
  }
  if (state === 'elsewhere') {
    return `Base here, but ${count} other variant(s) differ — click to see every variant`;
  }
  return 'Not varied — click to give this field a variant value';
}

export interface VariantFieldMarkerProps extends FieldRowActionContext {
  runtime: VariantsRuntime;
}

export function VariantFieldMarker({ runtime, viewer, nodePath, componentType, fieldName }: VariantFieldMarkerProps) {
  const store = runtime.store;
  useSyncExternalStore(store.subscribe.bind(store), () => store.version);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  const key = fieldKeyOf(viewer, nodePath, componentType, fieldName);
  if (!key) return null;
  const info = fieldInfoOf(runtime, key);
  const base = baseValueOf(runtime, key, info.state);
  const equalsBase = info.state === 'overridden' && overrideEqualsBase(base, info.value);
  const color = info.state === 'overridden'
    ? (equalsBase ? WARN : ACCENT)
    : info.state === 'elsewhere' ? INK_MID : INK_LOW;

  return (
    <>
      <Tooltip title={tooltipOf(info.state, info.variants.length, equalsBase, info.value)} placement="top">
        <IconButton
          ref={buttonRef}
          size="small"
          data-testid="variant-field-marker"
          data-variant-state={info.state}
          data-variant-equals-base={equalsBase ? 'true' : 'false'}
          aria-label={`Variants of ${fieldName}`}
          aria-haspopup="dialog"
          onClick={(e) => { e.stopPropagation(); setOpen(true); }}
          sx={{ width: HIT, height: HIT, p: 0, color, opacity: info.state === 'none' ? 0.55 : 1 }}
        >
          {info.state === 'elsewhere'
            ? <HalfDiamond color={color} />
            : info.state === 'overridden'
              ? <Diamond sx={{ fontSize: 14 }} />
              : <DiamondOutlined sx={{ fontSize: 14 }} />}
          {equalsBase && (
            <Box component="span" sx={{ position: 'absolute', right: 0, bottom: 0, fontSize: 8, fontWeight: 700, lineHeight: 1 }}>=</Box>
          )}
        </IconButton>
      </Tooltip>
      {open && (
        <VariantFieldPopover
          viewer={viewer}
          runtime={runtime}
          anchorEl={buttonRef.current}
          fieldKey={key}
          componentType={componentType}
          fieldName={fieldName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** The field-row action the runtime registers while the mode is on. */
export function variantFieldRowAction(runtime: VariantsRuntime) {
  return {
    id: 'variants-field-marker',
    subscribeValue: (listener: () => void) => runtime.store.subscribe(listener),
    readValue: (ctx: FieldRowActionContext) => {
      if (runtime.store.sceneVariant === null) return undefined;
      const key = fieldKeyOf(ctx.viewer, ctx.nodePath, ctx.componentType, ctx.fieldName);
      if (!key) return undefined;
      const info = runtime.index.infoOf(key);
      if (info.state === 'overridden') return info.value;
      const base = baseValueOf(runtime, key, info.state);
      return base?.kind === 'value' ? base.value : undefined;
    },
    applies: (ctx: FieldRowActionContext) => markerApplies(runtime, ctx),
    rowSx: (ctx: FieldRowActionContext) => markerRowSx(runtime, ctx),
    component: (ctx: FieldRowActionContext) => <VariantFieldMarker {...ctx} runtime={runtime} />,
  };
}
