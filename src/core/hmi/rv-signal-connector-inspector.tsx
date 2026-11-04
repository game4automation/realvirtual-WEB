// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-connector-inspector — the SignalConnector's part of the component
 * inspector (plan-2227 Phase 2, §3.1). Loaded on demand through
 * `rv-signal-connector-inspector-entry.ts` the first time a connector is selected.
 *
 * Hooked into `rv-property-inspector.tsx` at the editable `ComponentSection` of a
 * `SignalConnector` (three props of that one call site):
 *
 * - `isFieldVisible` = {@link signalConnectorFieldFilter}: under the Mode only the
 *   fields and the two slots that Mode uses (a stray set slot stays visible);
 * - `onFieldEdit` routes `Mode` through {@link editSignalConnectorField}: in the
 *   asset editor it is `signalConnector.setMode` (Mode + cleared slots, one undo
 *   step — the same command MCP and `editor.setField('Mode')` run), elsewhere the
 *   normal overlay write;
 * - `extraContent` = {@link SignalConnectorInspector}: live preview (source value,
 *   binary for an INT, and the result) and *Create bit connectors…*.
 *
 * Inspector building blocks only (DESIGN.md, plan-510); English UI text.
 */

import { useMemo, useState } from 'react';
import { Box, Button, TextField, Typography } from '@mui/material';
import type { RVViewer } from '../rv-viewer';
import type { SignalStore } from '../engine/rv-signal-store';
import { InspectorRow } from './rv-inspector-row';
import { DetailsDisclosure, InspectorActionRow, inspectorActionButtonSx } from './rv-inspector-blocks';
import { FS, INK_LOW, INK_MID, MONO, WARN, inspectorInputSx } from './shared-sx';
import { useSignalTick } from '../../hooks/use-signal-tick';
import { commandRegistry } from './rv-command-registry';
import { ensureEditorCommandsRegistered } from './editor-command-descriptors';
import { getActiveAssetContext } from '../editor/active-asset-store';
import { formatDecimal } from './rv-number-format';
import { RVSignalConnector, signalConnectorNetworkFor } from '../engine/rv-signal-connector';
import { convertValue, interpretWord, widthBits, type ValueKind, type WordWidth } from '../engine/rv-signal-conversion';
import {
  SIGNAL_CONNECTOR_TYPE,
  bitModeSlots,
  formatBinary,
  isBitMode,
  isSignalConnectorFieldVisible,
  modeOf,
  parseBitList,
} from '../engine/rv-signal-connector-ops';
import {
  SIGNAL_CONNECTOR_CREATE_BITS_COMMAND,
  SIGNAL_CONNECTOR_SET_MODE_COMMAND,
} from './signal-connector-commands';

/** The field filter of one connector block (Mode-dependent fields and slots). */
export function signalConnectorFieldFilter(data: Readonly<Record<string, unknown>>): (field: string) => boolean {
  return (field) => isSignalConnectorFieldVisible(data, field);
}

/**
 * A field edit of a connector section. `Mode` in the asset editor runs
 * `signalConnector.setMode` (one undo step that also clears the unused slots);
 * every other edit — and `Mode` outside the editor — goes to `fallback`.
 */
export function editSignalConnectorField(
  viewer: RVViewer, nodePath: string, componentType: string, fieldName: string, value: unknown,
  fallback: (fieldName: string, value: unknown) => void,
): void {
  if (fieldName !== 'Mode' || getActiveAssetContext() === null) { fallback(fieldName, value); return; }
  ensureEditorCommandsRegistered();
  void commandRegistry.execute(
    SIGNAL_CONNECTOR_SET_MODE_COMMAND,
    { path: nodePath, mode: String(value ?? ''), componentType },
    { origin: 'ui', viewer },
  );
}

// ── Formatting ──────────────────────────────────────────────────────────


/** A signal value as the preview shows it. */
export function formatSignalValue(v: boolean | number | null | undefined, kind: ValueKind): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return kind === 'real' ? formatDecimal(v) : String(v);
}

// ── Preview (pure display) ──────────────────────────────────────────────

export interface SignalConnectorPreviewProps {
  sourceKind: ValueKind;
  targetKind: ValueKind;
  source: boolean | number | null;
  result: boolean | number | null;
  width: WordWidth;
  signed: boolean;
  /** Why the connector does not write (problem / disabled), or null while it does. */
  idleReason: string | null;
}

/** Source value (INT also in binary, grouped by the Width), and the converted result. */
export function SignalConnectorPreview({ sourceKind, targetKind, source, result, width, signed, idleReason }: SignalConnectorPreviewProps) {
  const binary = sourceKind === 'int' && typeof source === 'number' ? formatBinary(source, width) : null;
  const interpreted = sourceKind === 'int' && typeof source === 'number' ? interpretWord(source | 0, width, signed) : null;
  return (
    <Box data-testid="rv-signal-connector-preview">
      <InspectorRow label="Source" labelColor={INK_LOW} py={0.15}>
        <Typography sx={{ fontSize: FS.label, fontFamily: MONO, color: INK_MID }}>
          {formatSignalValue(source, sourceKind)}
          {interpreted !== null && interpreted !== source ? ` (${width}: ${interpreted})` : ''}
        </Typography>
      </InspectorRow>
      {binary && (
        <InspectorRow label="Bits" labelTitle={`Source as ${width}, bit ${widthBits(width) - 1} … bit 0`} labelColor={INK_LOW} py={0.15}>
          <Typography data-testid="rv-signal-connector-binary" sx={{ fontSize: FS.label, fontFamily: MONO, color: INK_MID, overflowWrap: 'anywhere' }}>
            {binary}
          </Typography>
        </InspectorRow>
      )}
      <InspectorRow label="Result" labelColor={INK_LOW} py={0.15}>
        <Typography data-testid="rv-signal-connector-result" sx={{ fontSize: FS.label, fontFamily: MONO, color: idleReason ? INK_LOW : INK_MID }}>
          {formatSignalValue(result, targetKind)}
        </Typography>
      </InspectorRow>
      {idleReason && (
        <InspectorRow label="Not writing" labelColor={WARN} py={0.15}>
          <Typography sx={{ fontSize: FS.label, color: INK_MID, overflowWrap: 'anywhere' }}>{idleReason}</Typography>
        </InspectorRow>
      )}
    </Box>
  );
}

// ── Create bit connectors… ──────────────────────────────────────────────

interface CreateBitsFormProps {
  viewer: RVViewer;
  nodePath: string;
  data: Readonly<Record<string, unknown>>;
  /** Resolved word signal path of this connector (its INT slot), or null. */
  wordPath: string | null;
}

/** Bit range + BOOL signals → one `signalConnector.createBits` call (one undo step). */
function CreateBitsForm({ viewer, nodePath, data, wordPath }: CreateBitsFormProps) {
  const mode = modeOf(data);
  const width = (data.Width === 'Byte' || data.Width === 'DWord' ? data.Width : 'Word') as WordWidth;
  const [bits, setBits] = useState(`0-${widthBits(width) - 1}`);
  const [signals, setSignals] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const parsed = useMemo(() => parseBitList(bits, width), [bits, width]);
  const signalList = signals.split(',').map((s) => s.trim());
  const editor = getActiveAssetContext() !== null;
  const reason = !editor
    ? 'Open the model in the editor to create connectors'
    : !wordPath
      ? `Link the ${isBitMode(mode) ? bitModeSlots(mode).word : 'INT'} slot first`
      : 'error' in parsed ? `Bits: ${parsed.error}` : null;
  const boolWord = isBitMode(mode) && mode === 'BitFromWord' ? 'targets' : 'sources';

  const create = async (): Promise<void> => {
    if (reason || !isBitMode(mode) || 'error' in parsed) return;
    ensureEditorCommandsRegistered();
    const res = await commandRegistry.execute(SIGNAL_CONNECTOR_CREATE_BITS_COMMAND, {
      path: nodePath,
      mode,
      word: wordPath,
      bits,
      signals: signals.trim() ? signalList : [],
      width,
      signed: data.Signed !== false,
      invert: data.Invert === true,
    }, { origin: 'ui', viewer });
    setResult(res.ok ? `Created ${parsed.bits.length} connector${parsed.bits.length === 1 ? '' : 's'}` : res.reason);
  };

  return (
    <DetailsDisclosure title="Create bit connectors…" data-testid="rv-signal-connector-create-bits">
      <InspectorRow label="Bits" labelTitle="Bit numbers or ranges, e.g. 0-7 or 0,2,5" py={0.15}>
        <TextField
          size="small"
          value={bits}
          onChange={(e) => setBits(e.target.value)}
          inputProps={{ 'aria-label': 'Bits' }}
          sx={inspectorInputSx}
        />
      </InspectorRow>
      <InspectorRow label="Signals" labelTitle={`BOOL ${boolWord}, one per bit in bit order, comma-separated; leave empty to link later`} py={0.15}>
        <TextField
          size="small"
          value={signals}
          placeholder="Signal paths, comma-separated"
          onChange={(e) => setSignals(e.target.value)}
          inputProps={{ 'aria-label': 'Signals' }}
          sx={inspectorInputSx}
        />
      </InspectorRow>
      <InspectorActionRow>
        <Button
          size="small"
          variant="outlined"
          disabled={reason !== null}
          title={reason ?? undefined}
          onClick={() => { void create(); }}
          data-rv-button-id="signal-connector.create-bits"
          sx={inspectorActionButtonSx}
        >
          {'error' in parsed ? 'Create' : `Create ${parsed.bits.length}`}
        </Button>
      </InspectorActionRow>
      {(reason || result) && (
        <Typography sx={{ px: 1, fontSize: FS.label, color: INK_LOW }}>{result ?? reason}</Typography>
      )}
    </DetailsDisclosure>
  );
}

// ── Section content ─────────────────────────────────────────────────────

export interface SignalConnectorInspectorProps {
  viewer: RVViewer | null;
  signalStore: SignalStore | null;
  nodePath: string;
  componentType: string;
  data: Readonly<Record<string, unknown>>;
}

/** Live preview + *Create bit connectors…* below the connector's field rows. */
export function SignalConnectorInspector({ viewer, signalStore, nodePath, componentType, data }: SignalConnectorInspectorProps) {
  useSignalTick(signalStore, 200);
  const instance = viewer?.registry?.getByPath(componentType, nodePath) ?? viewer?.registry?.getByPath(SIGNAL_CONNECTOR_TYPE, nodePath);
  // The registry knows every loaded instance; the store's connector network also
  // knows those built outside it (and is the list the checks run on).
  const c = instance instanceof RVSignalConnector
    ? instance
    : signalStore
      ? [...signalConnectorNetworkFor(signalStore).connectors].find((x) => x.nodePath === nodePath) ?? null
      : null;
  const mode = modeOf(data);

  let preview: SignalConnectorPreviewProps | null = null;
  if (c && signalStore) {
    const raw = c.sourcePath ? signalStore.getByPath(c.sourcePath) : undefined;
    const source = typeof raw === 'boolean' || typeof raw === 'number' ? raw : null;
    const converted = source === null ? undefined : convertValue(source, c.sourceKind, c.targetKind, c);
    // BitToWord: the connector contributes one bit; the word is the aggregator's.
    const result = mode === 'BitToWord'
      ? (c.targetPath ? (signalStore.getByPath(c.targetPath) as number | boolean | undefined) ?? null : null)
      : converted ?? null;
    preview = {
      sourceKind: c.sourceKind,
      targetKind: c.targetKind,
      source,
      result,
      width: c.Width,
      signed: c.Signed,
      idleReason: !c.Enabled ? 'Disabled' : c.isActive ? null : 'See the Problems panel',
    };
  }

  const wordSlot = isBitMode(mode) ? bitModeSlots(mode).word : null;
  const wordPath = wordSlot && c ? (c[wordSlot] as string | null) : null;

  return (
    <Box data-testid="rv-signal-connector-inspector" sx={{ pt: 0.5 }}>
      {preview
        ? <SignalConnectorPreview {...preview} />
        : (
          <Typography sx={{ px: 1, fontSize: FS.label, color: INK_LOW }}>
            Preview while the model runs
          </Typography>
        )}
      {isBitMode(mode) && viewer && (
        <CreateBitsForm viewer={viewer} nodePath={nodePath} data={data} wordPath={wordPath} />
      )}
    </Box>
  );
}
