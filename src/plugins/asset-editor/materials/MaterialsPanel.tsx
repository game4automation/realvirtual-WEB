// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MaterialsPanel — the editor's right-docked "Materials" window.
 *
 * Sibling of the Quick Edit panel (they share the right dock slot and the
 * `panel-primitives` building blocks). Three sections:
 *
 *  - Asset  — material & texture health of the whole asset, with actionable
 *             warnings; clicking one selects the parts it refers to.
 *  - Presets — the swatch library. Click applies to the selection.
 *  - Edit   — free PBR editing of the current selection, saveable as a preset.
 *
 * Every apply is an undoable `setMaterial` op on the AssetDocument, so it lands
 * in the GLB on save. Editor-mode only by construction: the plugin declares
 * `modes: ['editor']`, and the underlying op is a no-op in batched modes.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Box, Typography, Tooltip, IconButton, InputBase, Button, Divider,
} from '@mui/material';
import { Close, WarningAmber, InfoOutlined, AutoFixHigh } from '@mui/icons-material';
import { useViewer } from '../../../hooks/use-viewer';
import { useSelection } from '../../../hooks/use-selection';
import { LeftPanel } from '../../../core/hmi/LeftPanel';
import { DragNumberField } from '../../../core/hmi/DragNumberField';
import { RV_SCROLL_CLASS } from '../../../core/hmi/shared-sx';
import { StatRow } from '../../../core/hmi/settings/settings-helpers';
import {
  MATERIALS_PANEL_MIN_WIDTH, MATERIALS_PANEL_MAX_WIDTH,
  LS_KEY_MATERIALS_PANEL_WIDTH, getStoredMaterialsPanelWidth,
} from '../../../core/hmi/layout-constants';
import { getActiveAssetContext, subscribeActiveAsset, getActiveAssetVersion } from '../active-asset-store';
import { Section, ActionButton, ButtonGrid, buttonSimSx } from '../panel-primitives';
import { useButtonSim } from '../button-sim-store';
import { materialToValue, materialValueKey, indexMeshPathsByMaterialValue } from '../../../core/editor/rv-asset-material';
import type { MaterialValue } from '../../../core/editor/rv-asset-ops';
import {
  BUILTIN_MATERIAL_PRESETS, PRESET_CATEGORIES, loadCustomPresets,
  saveCustomPreset, deleteCustomPreset, swatchBackground,
} from './material-presets';
import type { MaterialPreset, PresetCategory } from './material-presets';
import { computeMaterialStats, formatBytes } from './material-stats';
import type { MaterialWarning } from './material-stats';

export const LS_KEY_MATERIALS_OPEN = 'rv-editor-materials-open';

const SELECT_FIRST = 'Select an object first';

const _noopSubscribe = () => () => {};
const _nullSnapshot = () => null;

/**
 * The value the Edit section starts from when the selection has no readable
 * material (multi-material, textured, or nothing selected).
 *
 * NOTE: this is a 3D PBR surface color, NOT interface chrome — the DESIGN.md
 * palette governs the panel around it, not the material the user is authoring.
 * It matches the `plastic-grey` preset so an unseeded edit starts somewhere
 * neutral and recognizable.
 */
const FALLBACK_VALUE: MaterialValue = {
  name: 'Custom', color: '#9a9a98', metalness: 0, roughness: 0.5,
  opacity: 1, transparent: false,
};

export function MaterialsPanel() {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  const lpmSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  useSyncExternalStore(subscribeActiveAsset, getActiveAssetVersion);
  const ctx = getActiveAssetContext();
  const docSnapshot = useSyncExternalStore(
    ctx?.doc.subscribe ?? _noopSubscribe,
    ctx?.doc.getSnapshot ?? _nullSnapshot,
  );
  const selection = useSelection();

  const [structureTick, setStructureTick] = useState(0);
  useEffect(() => {
    return viewer.on('editor-structure-changed', () => setStructureTick(t => t + 1));
  }, [viewer]);

  const [customs, setCustoms] = useState<MaterialPreset[]>(() => loadCustomPresets());

  const open = lpmSnapshot.right.activePanel === 'materials';

  // Walking the whole asset is O(nodes); on a large assembly that is not free.
  // Gate it on the panel actually being open, and recompute only when the op
  // log or the structure moved — not on every selection click.
  const stats = useMemo(
    () => (open ? computeMaterialStats(viewer.currentModelRoot ?? null) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewer, open, structureTick, docSnapshot?.opCount],
  );

  // Every mesh keyed by its material value, so each preset row's "Select" knows
  // what it can select (and how many). Same walk cost and recompute triggers as
  // the stats above — built once, shared across all rows.
  const materialIndex = useMemo(
    () => (open ? indexMeshPathsByMaterialValue(viewer.currentModelRoot ?? null) : new Map<string, string[]>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewer, open, structureTick, docSnapshot?.opCount],
  );

  // The material of the primary selection, when it is readable as a value —
  // this is what the Edit section seeds from.
  const selectedValue = useMemo(() => {
    const path = selection.primaryPath;
    if (!path) return null;
    const node = viewer.registry?.getNode(path);
    if (!node) return null;
    let found: MaterialValue | null = null;
    node.traverse((child) => {
      if (found) return;
      const mesh = child as { isMesh?: boolean; material?: unknown };
      if (mesh.isMesh && mesh.material && !Array.isArray(mesh.material)) {
        found = materialToValue(mesh.material as never);
      }
    });
    return found;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, selection.primaryPath, structureTick, docSnapshot?.opCount]);

  const handleClose = useCallback(() => {
    lpm.close('materials');
    try { localStorage.setItem(LS_KEY_MATERIALS_OPEN, 'false'); } catch { /* private mode */ }
  }, [lpm]);

  const apply = useCallback((value: MaterialValue) => {
    const c = getActiveAssetContext();
    if (!c || selection.selectedPaths.length === 0) return;
    c.doc.setMaterial([...selection.selectedPaths], value);
  }, [selection.selectedPaths]);

  const selectPaths = useCallback((paths: string[]) => {
    if (paths.length > 0) viewer.selectionManager.selectPaths(paths);
  }, [viewer]);

  if (!open || !ctx) return null;

  const busy = docSnapshot?.busy === true;
  const hasSelection = selection.selectedPaths.length > 0;
  const applyDisabled = busy || !hasSelection;

  return (
    <LeftPanel
      title="Materials"
      anchor="right"
      mobile="hidden"
      onClose={handleClose}
      width={lpmSnapshot.right.activePanelWidth || getStoredMaterialsPanelWidth()}
      resizable
      minWidth={MATERIALS_PANEL_MIN_WIDTH}
      maxWidth={MATERIALS_PANEL_MAX_WIDTH}
      onResize={(w) => {
        lpm.open('materials', w, 'right');
        try { localStorage.setItem(LS_KEY_MATERIALS_PANEL_WIDTH, String(w)); } catch { /* private mode */ }
      }}
    >
      <Box className={RV_SCROLL_CLASS} sx={{ flex: 1, overflowY: 'auto', minHeight: 0, pb: 1 }}>
        <SelectionLine count={selection.selectedPaths.length} />
        <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)' }} />

        <Section title="Asset">
          {stats && <StatsBody stats={stats} onSelect={selectPaths} />}
        </Section>

        <Section title="Presets">
          <PresetList
            customs={customs}
            index={materialIndex}
            assignDisabled={applyDisabled}
            onAssign={apply}
            onSelect={selectPaths}
            onDeleteCustom={(id) => setCustoms(deleteCustomPreset(id))}
          />
        </Section>

        <Section title="Edit">
          <MaterialEditor
            seed={selectedValue ?? FALLBACK_VALUE}
            seedKey={`${selection.primaryPath ?? ''}|${docSnapshot?.opCount ?? 0}`}
            disabled={applyDisabled}
            onChange={apply}
            onSave={(value, name) => {
              const next = saveCustomPreset(value, name);
              if (next) setCustoms(next);
            }}
          />
        </Section>
      </Box>
    </LeftPanel>
  );
}

// ─── Selection line ─────────────────────────────────────────────────────

function SelectionLine({ count }: { count: number }) {
  return (
    <Box sx={{ px: 1, py: 0.75 }}>
      <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: 11 }}>
        {count === 0
          ? 'No selection — click an object in the 3D view.'
          : `${count} object${count === 1 ? '' : 's'} selected`}
      </Typography>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>
        Materials apply to the selection and everything under it.
      </Typography>
    </Box>
  );
}

// ─── Stats ──────────────────────────────────────────────────────────────

function StatsBody({ stats, onSelect }: {
  stats: ReturnType<typeof computeMaterialStats>;
  onSelect: (paths: string[]) => void;
}) {
  const redundant = stats.materialCount - stats.uniqueByAppearance;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      <StatRow label="Materials" value={String(stats.materialCount)} />
      <StatRow
        label="Unique appearance"
        value={String(stats.uniqueByAppearance)}
        // Amber only when duplicates exist — a matching count is not a state.
        color={redundant > 0 ? '#ffa726' : undefined}
      />
      <StatRow label="Meshes" value={String(stats.meshCount)} />
      <StatRow label="Textures" value={String(stats.textureCount)} />
      {stats.textureCount > 0 && (
        <StatRow label="Texture memory" value={formatBytes(stats.textureBytes)} />
      )}

      {stats.warnings.length === 0 ? (
        <Typography variant="caption" sx={{
          color: 'rgba(255,255,255,0.3)', fontSize: 10, mt: 0.75,
        }}>
          No material or texture issues found.
        </Typography>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.375, mt: 0.75 }}>
          {stats.warnings.map(w => (
            <WarningRow key={w.id} warning={w} onSelect={onSelect} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function WarningRow({ warning, onSelect }: {
  warning: MaterialWarning;
  onSelect: (paths: string[]) => void;
}) {
  // State-Is-Sacred: color always paired with an icon, never color alone.
  const isWarning = warning.severity === 'warning';
  const color = isWarning ? '#ffa726' : 'rgba(255,255,255,0.5)';
  const Icon = isWarning ? WarningAmber : InfoOutlined;
  const canSelect = warning.meshPaths.length > 0;
  return (
    <Tooltip
      title={canSelect ? `${warning.detail} Click to select the affected parts.` : warning.detail}
      placement="left"
    >
      <Box
        onClick={() => canSelect && onSelect(warning.meshPaths)}
        sx={{
          display: 'flex', alignItems: 'flex-start', gap: 0.625,
          px: 0.75, py: 0.5, borderRadius: '2px',
          border: `1px solid ${isWarning ? 'rgba(255,167,38,0.25)' : 'rgba(255,255,255,0.08)'}`,
          bgcolor: isWarning ? 'rgba(255,167,38,0.07)' : 'rgba(255,255,255,0.02)',
          cursor: canSelect ? 'pointer' : 'default',
          '&:hover': canSelect
            ? { bgcolor: isWarning ? 'rgba(255,167,38,0.13)' : 'rgba(255,255,255,0.05)' }
            : undefined,
        }}
      >
        <Icon sx={{ fontSize: 13, color, mt: '1px', flexShrink: 0 }} />
        <Typography variant="caption" sx={{ color, fontSize: 10, fontWeight: 600, lineHeight: 1.35 }}>
          {warning.label}
        </Typography>
      </Box>
    </Tooltip>
  );
}

// ─── Presets ────────────────────────────────────────────────────────────

function PresetList({ customs, index, assignDisabled, onAssign, onSelect, onDeleteCustom }: {
  customs: MaterialPreset[];
  /** valueKey → mesh paths currently wearing that material. */
  index: Map<string, string[]>;
  assignDisabled: boolean;
  onAssign: (v: MaterialValue) => void;
  onSelect: (paths: string[]) => void;
  onDeleteCustom: (id: string) => void;
}) {
  const byCategory = useMemo(() => {
    const map = new Map<PresetCategory, MaterialPreset[]>();
    for (const p of [...BUILTIN_MATERIAL_PRESETS, ...customs]) {
      const bucket = map.get(p.category);
      if (bucket) bucket.push(p);
      else map.set(p.category, [p]);
    }
    return map;
  }, [customs]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {PRESET_CATEGORIES.map(category => {
        const presets = byCategory.get(category);
        if (!presets || presets.length === 0) return null;
        return (
          <Box key={category}>
            <Typography variant="caption" sx={{
              color: 'rgba(255,255,255,0.3)', fontSize: 9, fontWeight: 600,
              textTransform: 'uppercase', letterSpacing: 0.4,
              display: 'block', mb: 0.5,
            }}>
              {category}
            </Typography>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.375 }}>
              {presets.map(p => (
                <PresetRow
                  key={p.id}
                  preset={p}
                  matchPaths={index.get(materialValueKey(p)) ?? []}
                  assignDisabled={assignDisabled}
                  onAssign={() => onAssign(p)}
                  onSelect={onSelect}
                  onDelete={p.category === 'Custom' ? () => onDeleteCustom(p.id) : undefined}
                />
              ))}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** A small outlined button sized for the preset row. `flashId` lets the MCP
 *  bridge simulate a human click on it (button-sim-store). */
function RowButton({ label, tooltip, onClick, disabled, flashId }: {
  label: string; tooltip: string; onClick: () => void; disabled?: boolean; flashId?: string;
}) {
  const simPhase = useButtonSim(flashId ?? '');
  return (
    <Tooltip title={tooltip} placement="top">
      <span style={{ display: 'inline-flex' }}>
        <Button
          size="small"
          variant="outlined"
          onClick={onClick}
          disabled={disabled}
          data-rv-button-id={flashId}
          sx={{
            textTransform: 'none', fontSize: 10, fontWeight: 600,
            height: 22, py: 0, px: 0.75, minWidth: 0,
            color: disabled ? 'text.disabled' : 'text.secondary',
            borderColor: 'rgba(255,255,255,0.15)',
            '&:hover': { borderColor: 'primary.main', color: 'primary.main' },
            transition: 'transform 120ms ease, background-color 120ms ease',
            ...buttonSimSx(simPhase, '#4fc3f7'),
          }}
        >
          {label}
        </Button>
      </span>
    </Tooltip>
  );
}

function PresetRow({ preset, matchPaths, assignDisabled, onAssign, onSelect, onDelete }: {
  preset: MaterialPreset;
  matchPaths: string[];
  assignDisabled: boolean;
  onAssign: () => void;
  onSelect: (paths: string[]) => void;
  onDelete?: () => void;
}) {
  const matches = matchPaths.length;
  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', gap: 0.75,
      px: 0.5, py: 0.375, borderRadius: '2px',
      '&:hover': { bgcolor: 'rgba(255,255,255,0.03)' },
    }}>
      {/* Thumbnail — the lit-sphere approximation of the preset. */}
      <Box sx={{
        width: 26, height: 26, flexShrink: 0, borderRadius: '2px',
        background: swatchBackground(preset),
        border: '1px solid rgba(255,255,255,0.12)',
      }} />

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{
          fontSize: 11, color: 'rgba(255,255,255,0.85)', lineHeight: 1.25,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {preset.name}
        </Typography>
        {matches > 0 && (
          <Typography sx={{
            fontSize: 9, color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace', lineHeight: 1.2,
          }}>
            {matches} in use
          </Typography>
        )}
      </Box>

      <RowButton
        label="Assign"
        flashId={`mat.preset-${preset.id}`}
        tooltip={assignDisabled ? SELECT_FIRST : `Apply ${preset.name} to the selection`}
        disabled={assignDisabled}
        onClick={onAssign}
      />
      <RowButton
        label="Select"
        tooltip={matches > 0
          ? `Select the ${matches} object${matches === 1 ? '' : 's'} using this material`
          : 'No objects currently use this material'}
        disabled={matches === 0}
        onClick={() => onSelect(matchPaths)}
      />
      {onDelete && (
        <IconButton
          size="small"
          aria-label={`Delete preset ${preset.name}`}
          onClick={onDelete}
          sx={{
            p: 0.25, color: 'rgba(255,255,255,0.3)',
            '&:hover': { color: '#ef5350' },
          }}
        >
          <Close sx={{ fontSize: 12 }} />
        </IconButton>
      )}
    </Box>
  );
}

// ─── Free editor ────────────────────────────────────────────────────────

/**
 * A 0..1 PBR parameter row.
 *
 * `DragNumberField` is a controlled STRING draft with a separate commit point,
 * so this owns the draft and translates it back to numbers: `onDragChange`
 * fires the live value during a scrub (which the op log coalesces into one undo
 * step), and `onCommit` parses whatever was typed. Invalid or out-of-range text
 * snaps back to the last good value rather than pushing NaN into a material.
 */
function PbrSlider({ label, value, disabled, onChange }: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (n: number) => void;
}) {
  const [draft, setDraft] = useState(() => value.toFixed(2));
  const [lastValue, setLastValue] = useState(value);

  // Adopt external changes (new selection, undo) without clobbering typing.
  if (value !== lastValue) {
    setLastValue(value);
    setDraft(value.toFixed(2));
  }

  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n)) {
      const clamped = Math.min(1, Math.max(0, n));
      setDraft(clamped.toFixed(2));
      if (clamped !== value) onChange(clamped);
    } else {
      setDraft(value.toFixed(2));
    }
  };

  return (
    <DragNumberField
      compact
      label={label}
      value={draft}
      min={0}
      max={1}
      step={0.01}
      fractionDigits={2}
      disabled={disabled}
      ariaLabel={label}
      onValueChange={setDraft}
      onDragChange={(n) => { setLastValue(n); onChange(n); }}
      onCommit={commit}
    />
  );
}

function MaterialEditor({ seed, seedKey, disabled, onChange, onSave }: {
  seed: MaterialValue;
  /** Changes whenever the seed should be re-adopted (new selection / new op). */
  seedKey: string;
  disabled: boolean;
  onChange: (v: MaterialValue) => void;
  onSave: (v: MaterialValue, name: string) => void;
}) {
  const [value, setValue] = useState<MaterialValue>(seed);
  const [lastSeedKey, setLastSeedKey] = useState(seedKey);
  const [saveName, setSaveName] = useState('');

  // Re-seed from the selection during render (the documented alternative to a
  // sync effect) so the fields track what the user just clicked on.
  if (seedKey !== lastSeedKey) {
    setLastSeedKey(seedKey);
    setValue(seed);
  }

  const push = (patch: Partial<MaterialValue>) => {
    const next: MaterialValue = { ...value, ...patch, name: value.name || 'Custom' };
    setValue(next);
    if (!disabled) onChange(next);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 11, flex: 1 }}>
          Base color
        </Typography>
        <Box
          component="input"
          type="color"
          aria-label="Base color"
          value={value.color}
          disabled={disabled}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => push({ color: e.target.value })}
          sx={{
            width: 46, height: 22, p: 0, border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '2px', bgcolor: 'transparent',
            cursor: disabled ? 'default' : 'pointer',
            '&::-webkit-color-swatch-wrapper': { p: '2px' },
            '&::-webkit-color-swatch': { border: 'none', borderRadius: '2px' },
          }}
        />
        <Typography variant="caption" sx={{
          color: 'rgba(255,255,255,0.5)', fontFamily: 'monospace', fontSize: 11, width: 62,
        }}>
          {value.color.toUpperCase()}
        </Typography>
      </Box>

      <PbrSlider
        label="Metalness" value={value.metalness} disabled={disabled}
        onChange={(n) => push({ metalness: n })}
      />
      <PbrSlider
        label="Roughness" value={value.roughness} disabled={disabled}
        onChange={(n) => push({ roughness: n })}
      />
      <PbrSlider
        label="Opacity" value={value.opacity} disabled={disabled}
        // Opacity is the only PBR field that flips a second property: below 1
        // the material must be flagged transparent or the change is invisible.
        onChange={(n) => push({ opacity: n, transparent: n < 1 })}
      />

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.06)', my: 0.25 }} />

      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
        <InputBase
          value={saveName}
          onChange={(e) => setSaveName(e.target.value)}
          placeholder="Preset name"
          inputProps={{ 'aria-label': 'New preset name' }}
          sx={{
            flex: 1, height: 24, px: 0.75, fontSize: 11,
            border: '1px solid rgba(255,255,255,0.15)', borderRadius: '2px',
            '&.Mui-focused': { borderColor: '#4fc3f7' },
          }}
        />
        <Box sx={{ width: 108 }}>
          <ActionButton
            label="Save preset"
            icon={AutoFixHigh}
            disabled={!saveName.trim()}
            disabledReason="Enter a name for the preset"
            tooltip="Save these settings to the Custom library"
            onClick={() => { onSave(value, saveName); setSaveName(''); }}
          />
        </Box>
      </Box>
    </Box>
  );
}
