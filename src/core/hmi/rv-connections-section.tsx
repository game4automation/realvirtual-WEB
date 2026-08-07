// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-connections-section.tsx — "Connections" section of the Property
 * Inspector (plan-259 F11).
 *
 *  - Lists all incoming/outgoing connection edges of the selected node as
 *    clickable chips (navigate to the other end), with typed per-edge config
 *    fields (built-in config schema or the custom type's request schema) and
 *    a remove button. All edits go through the op log (undoable).
 *  - "+ Connection" inline form: type (built-in + user-defined) + target path.
 *  - Link handle: press-and-drag starts a node-link drag (Shift not required
 *    here — the handle IS the explicit affordance); drop on the 3D scene or a
 *    registered drop target creates the edge (plan-259 F10).
 *  - "Connection Types" editor: define/edit user-defined type signatures
 *    (request/response parameter schemas) — persisted in the rv-ODT
 *    `Connections` block via `setConnectionType` ops (Stufe 2).
 *
 * The section also registers itself as a node-link DROP TARGET: dropping a
 * link onto the section creates an edge INTO the inspected node.
 */

import { useEffect, useReducer, useState } from 'react';
import {
  Box, Chip, IconButton, TextField, Tooltip, Typography, Button,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
  Add, Close, ExpandLess, ExpandMore, Link as LinkIcon, ArrowForward, ArrowBack, Edit,
} from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import {
  getConnectionSystem,
  getBuiltinConnectionTypes,
  type RvConnection,
  type ConnectionType,
  type ConnectionParamType,
} from '../engine/rv-connection-registry';
import { connectionTypeColor } from '../../plugins/connection-gizmo-plugin';
import {
  applyAddConnection, applyRemoveConnection, applySetConnectionType,
  applyRemoveConnectionType, applyUpdateConnectionConfig, freshConnectionId,
} from './scene/rv-connection-edits';
import { navigateToRef } from './rv-reference-display';
import { armNodeLinkDrag, useNodeLinkDropTarget } from './node-link-drag-store';
import { DROP_TARGET_SX } from './drop-target-registry';
import { ISA_GREEN, ISA_RED } from './isa-colors';

const PARAM_TYPE_OPTIONS: ConnectionParamType[] = ['bool', 'int', 'float', 'string'];

/** Config field schema of an edge: built-in config schema, else the custom
 *  type's request schema (typed defaults for the call). */
function configSchemaFor(edge: RvConnection): Record<string, ConnectionParamType> {
  const builtin = getBuiltinConnectionTypes().find((t) => t.type === edge.type);
  if (builtin?.config) return builtin.config;
  return getConnectionSystem().getType(edge.type)?.request ?? {};
}

function leaf(path: string): string {
  return path.split('/').pop() || path;
}

// ── One edge row ─────────────────────────────────────────────────────────

function EdgeRow({ edge, direction, viewer }: {
  edge: RvConnection;
  direction: 'in' | 'out';
  viewer: RVViewer | null;
}) {
  const color = `#${connectionTypeColor(edge.type).toString(16).padStart(6, '0')}`;
  const otherPath = direction === 'in' ? edge.source : edge.target;
  const resolved = !!viewer?.registry?.getNode(otherPath);
  const schema = configSchemaFor(edge);
  const fields = Object.entries(schema);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, px: 1, py: 0.5, borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        {direction === 'in'
          ? <ArrowBack sx={{ fontSize: 11, color: 'text.disabled' }} />
          : <ArrowForward sx={{ fontSize: 11, color: 'text.disabled' }} />}
        <Chip
          label={edge.type}
          size="small"
          sx={{
            height: 18, fontSize: 11, fontWeight: 600,
            bgcolor: color + '22', color, border: `1px solid ${color}55`,
            '& .MuiChip-label': { px: 0.5 },
          }}
        />
        <Tooltip title={`${resolved ? 'Linked' : 'Unresolved'} → ${otherPath}\nClick to navigate`} placement="top">
          <Chip
            label={`${leaf(otherPath)}${resolved ? '' : ' · Unresolved'}`}
            size="small"
            onClick={() => navigateToRef(viewer, otherPath)}
            sx={{
              height: 18, fontSize: 11, cursor: 'pointer',
              bgcolor: alpha(resolved ? ISA_GREEN : ISA_RED, 0.1),
              color: resolved ? ISA_GREEN : ISA_RED,
              border: `1px solid ${alpha(resolved ? ISA_GREEN : ISA_RED, 0.3)}`,
              '& .MuiChip-label': { px: 0.5, overflow: 'hidden', textOverflow: 'ellipsis' },
            }}
          />
        </Tooltip>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Remove connection" placement="top">
          <IconButton
            size="small"
            aria-label="Remove connection"
            onClick={() => applyRemoveConnection(edge)}
            sx={{ p: 0.25 }}
          >
            <Close sx={{ fontSize: 11, color: 'text.disabled' }} />
          </IconButton>
        </Tooltip>
      </Box>
      {fields.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, pl: 2 }}>
          {fields.map(([name, type]) => (
            <ConfigField key={name} edge={edge} name={name} type={type} />
          ))}
        </Box>
      )}
    </Box>
  );
}

/** Typed inline editor for one per-edge config field. */
function ConfigField({ edge, name, type }: {
  edge: RvConnection;
  name: string;
  type: ConnectionParamType;
}) {
  const value = edge.config?.[name];
  if (type === 'bool') {
    const on = value === true;
    return (
      <Chip
        label={`${name}: ${on ? 'true' : 'false'}`}
        size="small"
        onClick={() => applyUpdateConnectionConfig(edge, name, !on)}
        sx={{ height: 18, fontSize: 11, cursor: 'pointer', '& .MuiChip-label': { px: 0.5 } }}
      />
    );
  }
  const isNum = type === 'int' || type === 'float';
  return (
    <TextField
      key={`${edge.id}:${name}`}
      size="small"
      variant="standard"
      label={name}
      defaultValue={value ?? (isNum ? 0 : '')}
      type={isNum ? 'number' : 'text'}
      onBlur={(e) => {
        const raw = e.target.value;
        const parsed = isNum
          ? (type === 'int' ? Math.trunc(Number(raw) || 0) : Number(raw) || 0)
          : raw;
        if (parsed !== value) applyUpdateConnectionConfig(edge, name, parsed);
      }}
      sx={{
        width: 90,
        '& .MuiInputBase-input': { fontSize: 11, py: 0 },
        '& .MuiInputLabel-root': { fontSize: 11 },
      }}
    />
  );
}

// ── Connection Types editor (user-defined signatures, Stufe 2) ──────────

function ParamSchemaEditor({ label, params, onChange }: {
  label: string;
  params: Record<string, ConnectionParamType>;
  onChange: (next: Record<string, ConnectionParamType>) => void;
}) {
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<ConnectionParamType>('float');
  return (
    <Box sx={{ pl: 1 }}>
      <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>{label}</Typography>
      {Object.entries(params).map(([n, t]) => (
        <Box key={n} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Typography sx={{ fontSize: 11, fontFamily: 'monospace', flex: 1 }}>{n}: {t}</Typography>
          <IconButton
            size="small" sx={{ p: 0.125 }} aria-label={`Remove ${label} parameter '${n}'`}
            onClick={() => {
              const next = { ...params };
              delete next[n];
              onChange(next);
            }}
          >
            <Close sx={{ fontSize: 11, color: 'text.disabled' }} />
          </IconButton>
        </Box>
      ))}
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-end' }}>
        <TextField
          size="small" variant="standard" placeholder="name" value={newName}
          onChange={(e) => setNewName(e.target.value)}
          sx={{ width: 90, '& .MuiInputBase-input': { fontSize: 11, py: 0 } }}
        />
        <TextField
          size="small" variant="standard" select value={newType}
          onChange={(e) => setNewType(e.target.value as ConnectionParamType)}
          sx={{ width: 70, '& .MuiInputBase-input': { fontSize: 11, py: 0 } }}
          SelectProps={{ native: true }}
        >
          {PARAM_TYPE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
        </TextField>
        <IconButton
          size="small" sx={{ p: 0.25 }}
          aria-label={`Add ${label} parameter`}
          disabled={!newName.trim()}
          onClick={() => {
            onChange({ ...params, [newName.trim()]: newType });
            setNewName('');
          }}
        >
          <Add sx={{ fontSize: 12 }} />
        </IconButton>
      </Box>
    </Box>
  );
}

function ConnectionTypesEditor() {
  const registry = getConnectionSystem();
  const types = registry.allTypes();
  const [editing, setEditing] = useState<ConnectionType | null>(null);
  const [newTypeName, setNewTypeName] = useState('');

  if (editing) {
    return (
      <Box sx={{ px: 1, py: 0.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Typography sx={{ fontSize: 11, fontWeight: 600 }}>{editing.type}</Typography>
        <ParamSchemaEditor
          label="request"
          params={editing.request ?? {}}
          onChange={(request) => setEditing({ ...editing, request })}
        />
        <ParamSchemaEditor
          label="response"
          params={editing.response ?? {}}
          onChange={(response) => setEditing({ ...editing, response })}
        />
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <Button
            size="small" sx={{ fontSize: 11, textTransform: 'none', py: 0 }}
            onClick={() => {
              applySetConnectionType(editing, registry.getType(editing.type) ?? undefined);
              setEditing(null);
            }}
          >
            Save
          </Button>
          <Button size="small" sx={{ fontSize: 11, textTransform: 'none', py: 0 }} onClick={() => setEditing(null)}>
            Cancel
          </Button>
        </Box>
      </Box>
    );
  }

  return (
    <Box sx={{ px: 1, py: 0.5 }}>
      {types.map((t) => (
        <Box key={t.type} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Typography sx={{ fontSize: 11, fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {t.type}
            {t.request ? ` req{${Object.entries(t.request).map(([k, v]) => `${k}:${v}`).join(', ')}}` : ''}
            {t.response ? ` res{${Object.entries(t.response).map(([k, v]) => `${k}:${v}`).join(', ')}}` : ''}
          </Typography>
          <Tooltip title="Edit type" placement="top">
            <IconButton aria-label={`Edit connection type '${t.type}'`} size="small" sx={{ p: 0.125 }} onClick={() => setEditing({ ...t, request: { ...t.request }, response: { ...t.response } })}>
              <Edit sx={{ fontSize: 11, color: 'text.disabled' }} />
            </IconButton>
          </Tooltip>
          <Tooltip title="Remove type" placement="top">
            <IconButton aria-label={`Remove connection type '${t.type}'`} size="small" sx={{ p: 0.125 }} onClick={() => applyRemoveConnectionType(t)}>
              <Close sx={{ fontSize: 11, color: 'text.disabled' }} />
            </IconButton>
          </Tooltip>
        </Box>
      ))}
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-end' }}>
        <TextField
          size="small" variant="standard" placeholder="New type name" value={newTypeName}
          onChange={(e) => setNewTypeName(e.target.value)}
          sx={{ flex: 1, '& .MuiInputBase-input': { fontSize: 11, py: 0 } }}
        />
        <IconButton
          size="small" sx={{ p: 0.25 }}
          aria-label="Add connection type"
          disabled={!newTypeName.trim()}
          onClick={() => {
            const name = newTypeName.trim();
            applySetConnectionType({ type: name, request: {}, response: {} }, registry.getType(name) ?? undefined);
            setNewTypeName('');
          }}
        >
          <Add sx={{ fontSize: 12 }} />
        </IconButton>
      </Box>
    </Box>
  );
}

// ── The section ──────────────────────────────────────────────────────────

export function ConnectionsSection({ viewer, nodePath }: {
  viewer: RVViewer | null;
  nodePath: string;
}) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => getConnectionSystem().subscribe(force), []);

  const registry = getConnectionSystem();
  const incoming = registry.into(nodePath);
  const outgoing = registry.outOf(nodePath);

  const [open, setOpen] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showTypes, setShowTypes] = useState(false);
  const [addType, setAddType] = useState('StopOnExit');
  const [addTarget, setAddTarget] = useState('');

  // Drop target: dropping a node-link onto this section creates an edge INTO
  // the inspected node (self-links rejected).
  const dropRef = useNodeLinkDropTarget({
    accepts: (p) => p.sourcePath !== nodePath,
    onDrop: (p) => applyAddConnection({
      id: freshConnectionId(), source: p.sourcePath, target: nodePath, type: p.linkType,
    }),
  });

  const typeNames = [
    ...getBuiltinConnectionTypes().map((t) => t.type),
    ...registry.allTypes().map((t) => t.type),
  ];
  const total = incoming.length + outgoing.length;

  // Empty & nothing to author for bare paths: keep it minimal but present —
  // connections are created from here (add form / drag handle).
  if (!nodePath) return null;

  return (
    <Box ref={dropRef} sx={{ borderBottom: '1px solid rgba(255,255,255,0.08)', ...DROP_TARGET_SX }}>
      <Box
        sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.5, cursor: 'pointer', userSelect: 'none' }}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        {open ? <ExpandLess sx={{ fontSize: 12, color: 'text.disabled' }} /> : <ExpandMore sx={{ fontSize: 12, color: 'text.disabled' }} />}
        <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'primary.main', flex: 1 }}>
          CONNECTIONS{total > 0 ? ` (${total})` : ''}
        </Typography>
        <Tooltip title="Drag onto another node (3D scene) to connect" placement="top">
          <IconButton
            size="small"
            aria-label={`Start connection from '${nodePath}'`}
            sx={{ p: 0.25, cursor: 'grab' }}
            onPointerDown={(e) => {
              e.stopPropagation();
              armNodeLinkDrag({ sourcePath: nodePath, linkType: addType }, e.clientX, e.clientY);
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <LinkIcon sx={{ fontSize: 12, color: 'primary.main' }} />
          </IconButton>
        </Tooltip>
      </Box>

      {open && (
        <>
          {incoming.map((edge) => <EdgeRow key={edge.id} edge={edge} direction="in" viewer={viewer} />)}
          {outgoing.map((edge) => <EdgeRow key={edge.id} edge={edge} direction="out" viewer={viewer} />)}

          {showAdd ? (
            <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'flex-end', px: 1, py: 0.5 }}>
              <TextField
                size="small" variant="standard" select value={addType} label="Type"
                onChange={(e) => setAddType(e.target.value)}
                sx={{ width: 110, '& .MuiInputBase-input': { fontSize: 11, py: 0 }, '& .MuiInputLabel-root': { fontSize: 11 } }}
                SelectProps={{ native: true }}
              >
                {typeNames.map((t) => <option key={t} value={t}>{t}</option>)}
              </TextField>
              <TextField
                size="small" variant="standard" placeholder="Target node path" value={addTarget}
                label="Target"
                onChange={(e) => setAddTarget(e.target.value)}
                sx={{ flex: 1, '& .MuiInputBase-input': { fontSize: 11, py: 0 }, '& .MuiInputLabel-root': { fontSize: 11 } }}
              />
              <IconButton
                size="small" sx={{ p: 0.25 }}
                aria-label="Create connection"
                disabled={!addTarget.trim()}
                onClick={() => {
                  applyAddConnection({
                    id: freshConnectionId(), source: nodePath, target: addTarget.trim(), type: addType,
                  });
                  setAddTarget('');
                  setShowAdd(false);
                }}
              >
                <Add sx={{ fontSize: 12 }} />
              </IconButton>
              <IconButton aria-label="Cancel adding connection" size="small" sx={{ p: 0.25 }} onClick={() => setShowAdd(false)}>
                <Close sx={{ fontSize: 11, color: 'text.disabled' }} />
              </IconButton>
            </Box>
          ) : (
            <Box sx={{ display: 'flex', gap: 1, px: 1, py: 0.25 }}>
              <Button
                size="small" startIcon={<Add sx={{ fontSize: 11 }} />}
                onClick={() => setShowAdd(true)}
                sx={{ fontSize: 11, textTransform: 'none', py: 0, minWidth: 0, color: 'text.secondary' }}
              >
                Connection
              </Button>
              <Button
                size="small"
                onClick={() => setShowTypes(!showTypes)}
                sx={{ fontSize: 11, textTransform: 'none', py: 0, minWidth: 0, color: 'text.disabled' }}
              >
                {showTypes ? 'Hide types' : 'Connection types'}
              </Button>
            </Box>
          )}

          {showTypes && <ConnectionTypesEditor />}
        </>
      )}
    </Box>
  );
}
