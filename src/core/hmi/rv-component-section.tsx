// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-component-section.tsx — Collapsible component section for the Property Inspector.
 *
 * Groups fields by component type (Drive, Sensor, etc.) with a colored header,
 * consumedOnly filter support, and per-component reset.
 */

import { useState, useMemo, useCallback } from 'react';
import {
  Box,
  Typography,
  Tooltip,
} from '@mui/material';
import { ExpandMore } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import type { SignalStore } from '../engine/rv-signal-store';
import { getConsumedFields } from '../engine/rv-extras-validator';
import {
  baseComponentType,
  classifyField,
  componentColor,
  getSignalHeaderColor,
  inferFieldType,
  isComponentRef,
  isScriptableObject,
  HIDDEN_FIELD_NAMES,
} from './rv-inspector-helpers';
import { flattenObjectFields } from './rv-field-editors';
import { FieldRow } from './rv-field-row';
import { fieldRendererRegistry } from './rv-field-renderer-registry';

// ── Expand state persistence (default: expanded) ────────────────────────

const LS_KEY_COLLAPSED = 'rv-inspector-collapsed';

/** Module-level cache to avoid re-parsing localStorage on every toggle. */
let _collapsedCache: Set<string> | null = null;

function loadCollapsedSet(): Set<string> {
  if (_collapsedCache) return _collapsedCache;
  try {
    const raw = localStorage.getItem(LS_KEY_COLLAPSED);
    _collapsedCache = raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    _collapsedCache = new Set();
  }
  return _collapsedCache;
}

function persistCollapsed(key: string, collapsed: boolean): void {
  const set = loadCollapsedSet();
  if (collapsed) set.add(key); else set.delete(key);
  localStorage.setItem(LS_KEY_COLLAPSED, JSON.stringify([...set]));
}

// ── ComponentSection ─────────────────────────────────────────────────────

export interface ComponentSectionProps {
  nodePath: string;
  componentType: string;
  data: Record<string, unknown>;
  overriddenFields: Set<string>;
  consumedOnly: boolean;
  signalValue?: string | null;
  /** Optional action element rendered in the component header (e.g. "Open AAS" button). */
  headerAction?: React.ReactNode;
  onFieldEdit: (fieldName: string, value: unknown) => void;
  onFieldReset: (fieldName: string) => void;
  onResetComponent: () => void;
  viewer: RVViewer | null;
  signalStore: SignalStore | null;
}

export function ComponentSection({ nodePath, componentType, data, overriddenFields, consumedOnly, signalValue, headerAction, onFieldEdit, onFieldReset, onResetComponent, viewer, signalStore }: ComponentSectionProps) {
  const color = componentColor(componentType);
  const base = baseComponentType(componentType);
  const expandKey = `${nodePath}:${componentType}`;
  const [showOther, setShowOther] = useState(() => !loadCollapsedSet().has(expandKey));

  const toggleOther = useCallback(() => {
    setShowOther(prev => {
      const next = !prev;
      persistCollapsed(expandKey, !next);
      return next;
    });
  }, [expandKey]);

  /**
   * Flatten entries: if a value is a non-ref, non-vector3 object/array,
   * expand it into sub-field rows (e.g. Status.Connected, Status.Value).
   * This way objects like Status render as regular grayed-out field rows.
   */
  const flattenEntries = useCallback((entries: [string, unknown][]): [string, unknown][] => {
    const result: [string, unknown][] = [];
    for (const [key, value] of entries) {
      const ft = inferFieldType(key, value);
      if (ft === 'object' && !isComponentRef(value) && !isScriptableObject(value)) {
        // Flatten object/array sub-fields into regular rows
        const flat = flattenObjectFields(value as Record<string, unknown> | unknown[], key);
        for (const f of flat) result.push([f.key, f.value]);
      } else {
        result.push([key, value]);
      }
    }
    return result;
  }, []);

  // Separate consumed fields (editable) from non-consumed (read-only)
  const { consumedEntries, otherEntries } = useMemo(() => {
    const consumed = new Set(getConsumedFields(base));
    const consumedRaw: [string, unknown][] = [];
    const otherRaw: [string, unknown][] = [];

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('_')) continue;
      if (HIDDEN_FIELD_NAMES.has(key)) continue;
      if (consumed.has(key)) {
        consumedRaw.push([key, value]);
      } else {
        otherRaw.push([key, value]);
      }
    }

    // Consumed entries keep objects as-is (editable ObjectEditor handles them)
    // Other entries flatten objects into sub-field rows
    return { consumedEntries: consumedRaw, otherEntries: flattenEntries(otherRaw) };
  }, [base, data, flattenEntries]);

  return (
    <Box>
      {/* Component type header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.375,
          bgcolor: color + '11',
          borderBottom: `1px solid ${color}22`,
          borderTop: `1px solid ${color}22`,
        }}
      >
        <Typography
          sx={{
            fontSize: 10,
            fontWeight: 700,
            color: color,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
          }}
        >
          {componentType}
        </Typography>
        {signalValue != null && (
          <Typography
            sx={{
              fontSize: 10,
              fontWeight: 600,
              fontFamily: 'monospace',
              ml: 'auto',
              color: getSignalHeaderColor(componentType, String(signalValue)),
            }}
          >
            {signalValue}
          </Typography>
        )}
        {headerAction}
        {overriddenFields.size > 0 && (
          <Tooltip title="Click to reset all overrides for this component" placement="top">
            <Typography
              onClick={onResetComponent}
              sx={{
                fontSize: 9,
                color: '#4fc3f7',
                ml: 'auto',
                cursor: 'pointer',
                '&:hover': { color: '#ffa726', textDecoration: 'underline' },
              }}
            >
              {overriddenFields.size} override{overriddenFields.size !== 1 ? 's' : ''}
            </Typography>
          </Tooltip>
        )}
      </Box>

      {/* Consumed (editable) fields */}
      {consumedEntries.map(([fieldName, value]) => {
        // Check for a custom field renderer plugin
        const CustomRenderer = fieldRendererRegistry.getRenderer(componentType, fieldName);
        if (CustomRenderer) {
          return (
            <CustomRenderer
              key={fieldName}
              value={value}
              fieldName={fieldName}
              componentType={componentType}
              nodePath={nodePath}
              viewer={viewer}
              signalStore={signalStore}
            />
          );
        }
        return (
          <FieldRow
            key={fieldName}
            fieldName={fieldName}
            value={value}
            status="consumed"
            isOverridden={overriddenFields.has(fieldName)}
            onEdit={(v) => onFieldEdit(fieldName, v)}
            onReset={() => onFieldReset(fieldName)}
            viewer={viewer}
            signalStore={signalStore}
          />
        );
      })}

      {/* Collapsible other (read-only) fields — hidden when consumedOnly is active */}
      {!consumedOnly && otherEntries.length > 0 && (
        <>
          <Box
            onClick={toggleOther}
            sx={{
              display: 'flex',
              alignItems: 'center',
              px: 1,
              py: 0.125,
              cursor: 'pointer',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.02)' },
            }}
          >
            <ExpandMore sx={{
              fontSize: 12,
              color: 'text.disabled',
              transform: showOther ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 0.15s',
            }} />
            <Typography sx={{ fontSize: 9, color: 'text.disabled', ml: 0.25 }}>
              {otherEntries.length} more field{otherEntries.length !== 1 ? 's' : ''}
            </Typography>
          </Box>
          {showOther && otherEntries.map(([fieldName, value]) => (
            <FieldRow
              key={fieldName}
              fieldName={fieldName}
              value={value}
              status={classifyField(componentType, fieldName)}
              isOverridden={overriddenFields.has(fieldName)}
              onEdit={(v) => onFieldEdit(fieldName, v)}
              onReset={() => onFieldReset(fieldName)}
              viewer={viewer}
              signalStore={signalStore}
            />
          ))}
        </>
      )}
    </Box>
  );
}
