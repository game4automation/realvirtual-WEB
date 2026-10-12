// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-plc-signal-inspector — the two inspector sections of a PLC signal node (plan-589 F3 / F4).
 *
 * A PLC signal node IS the signal, and until now its inspector showed only the generic field dump
 * plus the one bind row (`PLCSignalSlot`). These two blocks make it an editor:
 *
 *  - **Signal** — the symbol itself: name, type/direction, origin data type, comment. The NAME is
 *    not an inline text field: the model, the bindings and every CONNECT entry couple by it, so a
 *    rename is a refactoring. Since plan-590 the name row opens the rename dialog
 *    (`SignalRenameDialog`, a view of `editor.signalRename`), which previews and carries every
 *    reference along; plan-589 F5's read-only lock is lifted.
 *  - **PLC binding** — one row per CONNECT signal PLACE this symbol could live in: the interface's
 *    flat `signals` list, and for MQTT each topic's own list. The row says whether the symbol is
 *    bound there and with which address, and lets the address be set, changed or removed. Writing
 *    goes through the connect-store into THAT container (`applySignalBinding`), never into a
 *    neighbouring one.
 *
 * Addresses live exclusively in CONNECT — there is deliberately no address field in the GLB. Without
 * a CONNECT connection the section is therefore not merely empty but DISABLED, with the reason said
 * once instead of a row of dead buttons.
 *
 * Built from the inspector building blocks and `shared-sx` only (plan-510); no new dependency, no
 * local colours or font sizes.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import { Add, Close, DriveFileRenameOutline, Edit } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import {
  addressRuleFor,
  type AddressRule,
} from '../import/rv-iface-signal-slots';
import {
  applySignalBinding,
  findSignalInContainer,
  getConnectSnapshot,
  getSignalSchema,
  isModelManagedInterfaceType,
  PLC_BINDING_NEEDS_CONNECT,
  subscribeConnectStore,
  type ConnectInterface,
  type ConnectInterfaceSignal,
  type MqttTopicMode,
} from './connect-store';
import { InspectorRow } from './rv-inspector-row';
import { InspectorSubheader } from './rv-inspector-blocks';
import { StringEditor } from './rv-field-editors';
import { SignalEditDialog } from './SignalEditDialog';
import { SignalRenameDialog } from './SignalRenameDialog';
import { useCommandView } from './rv-command-view';
import { SIGNAL_RENAME_COMMAND } from './problems-store';
import { signalNameForPath } from './use-signal-usages';
import { baseComponentType } from './rv-inspector-helpers';
import { FS, ICON_SIZE, INK_LOW, INK_MID, MONO, NEUTRAL, SUCCESS, WARN } from './shared-sx';

/** plan-590 — tooltip of the name row when the rename can be opened. */
export const SIGNAL_RENAME_HINT = 'Rename the signal and every reference to it';
/** Fallback tooltip when the rename command gives no reason (it always should). */
export const SIGNAL_RENAME_UNAVAILABLE = 'Renaming this signal is not available here';

export { PLC_BINDING_NEEDS_CONNECT };

/** Human form of an rv signal type: `PLCOutputBool` → "PLC Output · Bool". */
export function describeSignalType(componentType: string): string {
  const match = baseComponentType(componentType).match(/^PLC(Input|Output)(Bool|Int|Float|Text)$/);
  if (!match) return baseComponentType(componentType);
  return `PLC ${match[1]} · ${match[2]}`;
}

/** The CONNECT wire type to seed a new binding with — the node's own signal type. */
function wireTypeOf(componentType: string): string {
  return baseComponentType(componentType);
}

/** One row of the PLC binding section: a place, what is in it, and what the gateway demands. */
interface BindingPlace {
  key: string;
  /** Interface id, plus the topic for an MQTT container. */
  label: string;
  iface: ConnectInterface;
  topic?: string;
  mode?: MqttTopicMode;
  /** The CONNECT entry under this symbol's name in this container, or null. */
  signal: ConnectInterfaceSignal | null;
  rule: AddressRule | null;
}

/**
 * Every place the symbol `name` could be bound in, across all connected interfaces.
 *
 * Model-managed interfaces (FMI, provisioned by the FMU plugin from the scene) are left out: their
 * signals ARE the model's FMU children, and a hand-made entry would fight the plugin.
 */
export function collectBindingPlaces(interfaces: readonly ConnectInterface[], name: string): BindingPlace[] {
  const out: BindingPlace[] = [];
  for (const iface of interfaces) {
    if (isModelManagedInterfaceType(iface.type)) continue;
    const schema = getSignalSchema(iface.type);
    out.push({
      key: iface.id,
      label: iface.id,
      iface,
      signal: findSignalInContainer(iface, name),
      rule: addressRuleFor({}, schema),
    });
    for (const topic of iface.topics ?? []) {
      out.push({
        key: `${iface.id}#${topic.topic}`,
        label: `${iface.id} · ${topic.topic}`,
        iface,
        topic: topic.topic,
        mode: topic.mode,
        signal: findSignalInContainer(iface, name, topic.topic),
        rule: addressRuleFor({ topic: topic.topic, mode: topic.mode }, schema),
      });
    }
  }
  return out;
}

/**
 * What a place's row shows in its value cell, and in which semantic colour.
 *
 * `no address` is a WARNING only where the gateway says an address is required — the worker would
 * skip the signal there. Where the rule is permissive (or unstated, i.e. an older gateway) a bound
 * signal without an address is a perfectly good configuration and reads as bound.
 */
export function describeBindingPlace(place: BindingPlace): { text: string; color: string; warn: boolean } {
  if (!place.signal) return { text: 'not bound', color: NEUTRAL, warn: false };
  const address = place.signal.protocolAddress?.trim() ?? '';
  if (address) {
    const dataType = place.signal.dataType?.trim();
    return { text: dataType ? `${address} · ${dataType}` : address, color: SUCCESS, warn: false };
  }
  if (place.rule === 'required') return { text: 'bound · no address', color: WARN, warn: true };
  return { text: 'bound', color: SUCCESS, warn: false };
}

/** Status gutter dot of a binding row — bound / needs attention / unbound. */
function StatusDot({ color }: { color: string }) {
  return (
    <Box sx={{
      width: ICON_SIZE.dot,
      height: ICON_SIZE.dot,
      borderRadius: '50%',
      bgcolor: color,
      justifySelf: 'center',
    }} />
  );
}

export interface PLCSignalSectionsProps {
  viewer: RVViewer | null;
  /** Node path of the signal node (the inspector's own spelling). */
  nodePath: string;
  /** Concrete component key of the section (may carry a `_N` dedup suffix). */
  componentType: string;
  /** The component's `rv_extras` data. */
  data: Record<string, unknown>;
  /** Field write path of the inspector (`editor.setField` under the hood). */
  onFieldEdit?: (fieldName: string, value: unknown) => void;
}

/**
 * The "Signal" and "PLC binding" blocks of a PLC signal node, in that order.
 *
 * Rendered by `rv-component-section` right after the node's one bind row, so a signal node reads
 * top-to-bottom as: what the symbol IS, who it is linked to in the model, and where it is bound in
 * the plant.
 */
export function PLCSignalSections({ viewer, nodePath, componentType, data, onFieldEdit }: PLCSignalSectionsProps) {
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);
  const [dialog, setDialog] = useState<BindingPlace | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);

  // The RUNTIME name is the key CONNECT couples by (a generated signal inside a placement is
  // scoped). Fall back to the persisted asset-local symbol when the store has not registered the
  // node — a node in the asset editor that was never loaded as a scene still deserves its name row.
  const localName = typeof data['Name'] === 'string' ? (data['Name'] as string) : '';
  const runtimeName = signalNameForPath(viewer, nodePath) ?? localName;

  const comment = typeof data['Comment'] === 'string' ? (data['Comment'] as string) : '';
  const originDataType = typeof data['OriginDataType'] === 'string' ? (data['OriginDataType'] as string) : '';

  const connected = snap.state === 'connected';

  // plan-590: the name row is a view of `editor.signalRename` — enabled, reason and choreography
  // come from the command (a dry-run probe with the current name: "may this node be renamed?").
  const renameView = useCommandView(viewer ? {
    id: SIGNAL_RENAME_COMMAND,
    args: () => ({ path: nodePath, newName: runtimeName || localName || nodePath, dryRun: true }),
    invoke: () => setRenameOpen(true),
    viewer,
  } : null);
  const renameTitle = renameView.disabled ? (renameView.reason ?? SIGNAL_RENAME_UNAVAILABLE) : SIGNAL_RENAME_HINT;

  const places = useMemo(
    () => (connected && runtimeName ? collectBindingPlaces(snap.interfaces, runtimeName) : []),
    [connected, snap.interfaces, runtimeName]);

  const handleRemove = useCallback((place: BindingPlace) => {
    void applySignalBinding({
      interfaceId: place.iface.id,
      topic: place.topic,
      name: runtimeName,
      remove: true,
    }).catch((err) => console.error('[plc-binding] remove failed:', err));
  }, [runtimeName]);

  return (
    <>
      <InspectorSubheader data-testid="rv-signal-section">Signal</InspectorSubheader>

      <InspectorRow
        label="Name"
        labelTitle={renameTitle}
        dataAttrs={renameView.dataAttrs}
        trailing={
          <Tooltip title={renameTitle} disableInteractive>
            <span>
              <IconButton
                size="small"
                aria-label={`Rename signal '${runtimeName}'`}
                data-testid="rv-signal-rename-open"
                disabled={renameView.disabled}
                onClick={renameView.onClick}
                sx={{ p: 0.25 }}
              >
                <DriveFileRenameOutline sx={{ fontSize: ICON_SIZE.xs, color: INK_LOW }} />
              </IconButton>
            </span>
          </Tooltip>
        }
      >
        {/* Not an inline editor: clicking the name opens the rename dialog, which previews every
            reference before anything changes. */}
        <Typography
          data-testid="rv-signal-name"
          aria-readonly="true"
          role={renameView.disabled ? undefined : 'button'}
          tabIndex={renameView.disabled ? undefined : 0}
          title={renameTitle}
          onClick={renameView.disabled ? undefined : renameView.onClick}
          onKeyDown={renameView.disabled ? undefined : (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); renameView.onClick(); }
          }}
          sx={{
            fontSize: FS.label, fontFamily: MONO, color: INK_MID, overflow: 'hidden', textOverflow: 'ellipsis',
            cursor: renameView.disabled ? 'default' : 'pointer',
          }}
        >
          {runtimeName || '—'}
        </Typography>
      </InspectorRow>

      <InspectorRow label="Type">
        <Typography sx={{ fontSize: FS.label, color: INK_MID }}>
          {describeSignalType(componentType)}
        </Typography>
      </InspectorRow>

      <InspectorRow label="Data type" labelTitle="Origin data type of the PLC tag (BOOL, INT, DINT, REAL, …)">
        {onFieldEdit
          ? <StringEditor value={originDataType} onChange={(v) => onFieldEdit('OriginDataType', v)} />
          : <Typography sx={{ fontSize: FS.label, fontFamily: MONO, color: INK_MID }}>{originDataType || '—'}</Typography>}
      </InspectorRow>

      <InspectorRow label="Comment">
        {onFieldEdit
          ? <StringEditor value={comment} onChange={(v) => onFieldEdit('Comment', v)} />
          : <Typography sx={{ fontSize: FS.label, color: INK_MID }}>{comment || '—'}</Typography>}
      </InspectorRow>

      <InspectorSubheader data-testid="rv-plc-binding-section">PLC binding</InspectorSubheader>

      {!connected && (
        <InspectorRow label="" dataAttrs={{ 'data-testid': 'rv-plc-binding-disabled' }}>
          <Typography data-testid="rv-plc-binding-hint" sx={{ fontSize: FS.label, color: INK_LOW }}>
            {PLC_BINDING_NEEDS_CONNECT}
          </Typography>
        </InspectorRow>
      )}

      {connected && places.length === 0 && (
        <InspectorRow label="">
          <Typography sx={{ fontSize: FS.label, color: INK_LOW }}>
            No CONNECT interface to bind to — add one in the CONNECT panel.
          </Typography>
        </InspectorRow>
      )}

      {places.map((place) => {
        const state = describeBindingPlace(place);
        return (
          <InspectorRow
            key={place.key}
            label={place.label}
            labelTitle={place.label}
            dot={<StatusDot color={state.color} />}
            dataAttrs={{ 'data-rv-binding': place.key }}
            trailing={
              <Box sx={{ display: 'flex', alignItems: 'center' }}>
                <Tooltip title={place.signal ? 'Change the address' : 'Bind this signal here'} disableInteractive>
                  <IconButton
                    size="small"
                    aria-label={`${place.signal ? 'Edit' : 'Bind'} '${runtimeName}' on ${place.label}`}
                    onClick={() => setDialog(place)}
                    sx={{ p: 0.25 }}
                  >
                    {place.signal
                      ? <Edit sx={{ fontSize: ICON_SIZE.xs, color: INK_LOW }} />
                      : <Add sx={{ fontSize: ICON_SIZE.xs, color: INK_LOW }} />}
                  </IconButton>
                </Tooltip>
                {place.signal && (
                  <Tooltip title="Remove the binding from this interface" disableInteractive>
                    <IconButton
                      size="small"
                      aria-label={`Remove '${runtimeName}' from ${place.label}`}
                      onClick={() => handleRemove(place)}
                      sx={{ p: 0.25 }}
                    >
                      <Close sx={{ fontSize: ICON_SIZE.xs, color: INK_LOW }} />
                    </IconButton>
                  </Tooltip>
                )}
              </Box>
            }
          >
            <Typography sx={{ fontSize: FS.label, fontFamily: MONO, color: state.color, overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {state.text}
            </Typography>
          </InspectorRow>
        );
      })}

      {/* The SAME dialog the CONNECT panel uses, opened from the model side: prefilled with the
          runtime name (read-only — F5), the node's wire type and its origin data type. */}
      {dialog && (
        <SignalEditDialog
          open
          onClose={() => setDialog(null)}
          iface={dialog.iface}
          schema={getSignalSchema(dialog.iface.type)}
          editSignal={dialog.signal}
          seed={{
            name: runtimeName,
            type: wireTypeOf(componentType),
            ...(originDataType ? { dataType: originDataType } : {}),
          }}
          topic={dialog.topic}
          mode={dialog.mode}
          isBound
          nameReadOnly
        />
      )}

      {renameOpen && (
        <SignalRenameDialog
          open
          onClose={() => setRenameOpen(false)}
          viewer={viewer}
          nodePath={nodePath}
          currentName={runtimeName}
        />
      )}
    </>
  );
}
