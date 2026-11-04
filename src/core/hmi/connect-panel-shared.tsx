// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Box, Button, Typography } from '@mui/material';
import {
  CONNECT_INTERFACE_TYPES,
  getAvailableInterfaceTypes,
  type ConnectInterface,
  type ConnectInterfaceType,
} from './connect-store';
import { useConnectDownloads } from './use-connect-downloads';

/** Human-readable label for an interface type — gateway catalog first, static registry as fallback. */
/**
 * One-line endpoint summary of an interface, as the card shows it next to its id.
 * Pure and exported so the per-type summary stays testable without rendering a card.
 */
export function interfaceEndpointLabel(iface: ConnectInterface): string {
  if (iface.type === 'OpcUa') return (iface.endpoint as string) ?? '';
  if (iface.type === 'S7') return `${iface.ipAddress ?? ''} R:${iface.rack ?? 0} S:${iface.slot ?? 1}`;
  if (iface.type === 'MQTT') return (iface.brokerUrl as string) ?? '';
  if (iface.type === 'TwinCat') return iface.twinCat?.netId ?? '';
  if (iface.type === 'Modbus' || iface.type === 'ModbusServer') {
    return iface.modbus ? `${iface.modbus.host}:${iface.modbus.port}` : '';
  }
  if (iface.type === 'EthernetIp') return iface.ethernetIp?.gateway ?? '';
  if (iface.type === 'CtrlX') return iface.ctrlX?.address ?? '';
  if (iface.type === 'CtrlXDataLayer') return iface.ctrlXDataLayer?.address ?? '';
  if (iface.type === 'Keba') return iface.keba?.host ?? '';
  if (iface.type === 'Festo') return iface.festo ? `${iface.festo.host}:${iface.festo.port}` : '';
  if (iface.type === 'Fanuc') return iface.fanuc ? `${iface.fanuc.address}:${iface.fanuc.port}` : '';
  if (iface.type === 'Denso') return iface.denso ? `${iface.denso.host} (${iface.denso.controllerName})` : '';
  if (iface.type === 'Kuka') return iface.kuka ? `${iface.kuka.host}:${iface.kuka.port}` : '';
  if (iface.type === 'KukaRsi') return iface.kukaRsi ? `${iface.kukaRsi.listenIp}:${iface.kukaRsi.rsiPort}` : '';
  if (iface.type === 'UniversalRobots') {
    return iface.universalRobots ? `${iface.universalRobots.host}:${iface.universalRobots.rtdePort}` : '';
  }
  if (iface.type === 'IgusRebel') return iface.igusRebel ? `${iface.igusRebel.host}:${iface.igusRebel.port}` : '';
  if (iface.type === 'Mitsubishi') return iface.mitsubishi ? `${iface.mitsubishi.host}:${iface.mitsubishi.port}` : '';
  if (iface.type === 'Udp') return iface.udp ? `${iface.udp.remoteHost}:${iface.udp.remotePort}` : '';
  if (iface.type === 'WebSocketRealtime') {
    const ws = iface.webSocketRealtime;
    if (!ws) return '';
    return ws.isServer ? `${ws.bindAddress}:${ws.port} (server)` : `${ws.address}:${ws.port}`;
  }
  if (iface.type === 'WinmodY200') return iface.winmodY200?.sharedMemoryName ?? '';
  if (iface.type === 'RoboDk') return iface.roboDk ? `${iface.roboDk.host}:${iface.roboDk.port}` : '';
  if (iface.type === 'WandelbotsNova') {
    return iface.wandelbotsNova ? `${iface.wandelbotsNova.server} (${iface.wandelbotsNova.cell})` : '';
  }
  if (iface.type === 'AbbRobotStudio') return iface.abbRobotStudio?.sharedMemoryName ?? '';
  if (iface.type === 'PlcSimAdvanced') return iface.plcSimAdvanced?.instanceName ?? '';
  if (iface.type === 'Pvi') {
    const pvi = iface.pvi;
    if (!pvi) return '';
    const line = pvi.connectionType === 'Ina2000' ? 'INA2000' : 'ANSL';
    return `${line} ${pvi.host}${pvi.port != null ? `:${pvi.port}` : ''}`;
  }
  if (iface.type === 'SHM') return (iface.sharedMemory as { sharedMemoryName?: string })?.sharedMemoryName ?? '';
  return '';
}

/**
 * Human-readable label of an interface type — the connected gateway's own
 * catalog first, the static registry as fallback. Exported since plan-562: the
 * write-gate overlay names the same target the card names, and it must read the
 * label from here rather than keep a second spelling of it.
 */
export function interfaceTypeLabel(type: ConnectInterfaceType): string {
  return getAvailableInterfaceTypes().find(d => d.type === type)?.label
    ?? CONNECT_INTERFACE_TYPES.find(d => d.type === type)?.label
    ?? type;
}

/** Stable download label — brand text, enriched with the semantic version when the manifest
 *  is reachable. Falls back to the plain brand text (unchanged accessible name) otherwise. */
export function stableDownloadLabel(version: string | null): string {
  return version
    ? `Download realvirtual CONNECT ${version}`
    : 'Download realvirtual CONNECT';
}

/** Human tooltip carrying the build number + date when known. */
export function channelBuildTitle(build: number | null, buildDate: string | null): string | undefined {
  if (build == null && !buildDate) return undefined;
  const parts = [build != null ? `build ${build}` : null, buildDate].filter(Boolean);
  return parts.join(' · ');
}

/** Shown while the published build is not code-signed yet: Windows SmartScreen blocks the first
 *  start with "Windows protected your PC" until the user confirms. */
export function UnsignedDownloadHint({ unsigned }: { unsigned?: boolean }) {
  if (!unsigned) return null;
  return (
    <Typography sx={{ fontSize: 10, lineHeight: 1.4, color: 'text.secondary', mt: 0.25, width: '100%' }}>
      This build is not code-signed yet. If Windows SmartScreen warns on start, choose
      {' '}<Box component="span" sx={{ fontWeight: 600 }}>More info</Box>{' → '}
      <Box component="span" sx={{ fontWeight: 600 }}>Run anyway</Box>.
    </Typography>
  );
}

/** Stable + beta download affordance reused in every connection dead end. Versions come from
 *  the published release manifests; the beta link appears ONLY when a beta build exists. */
export function ConnectDownloadLinks() {
  const downloads = useConnectDownloads();
  const { stable, beta } = downloads;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
      <Button
        component="a"
        href={stable.url}
        target="_blank"
        rel="noreferrer"
        size="small"
        variant="text"
        title={channelBuildTitle(stable.build, stable.buildDate)}
        sx={{ minWidth: 0, px: 0, fontSize: 10, textTransform: 'none' }}
      >
        {stableDownloadLabel(stable.version)}
      </Button>
      {beta && (
        <Button
          component="a"
          href={beta.url}
          target="_blank"
          rel="noreferrer"
          size="small"
          variant="text"
          title={channelBuildTitle(beta.build, beta.buildDate)}
          sx={{ minWidth: 0, p: 0, fontSize: 10, color: 'text.secondary', textTransform: 'none' }}
        >
          {beta.version ? `beta ${beta.version}` : 'beta'}
        </Button>
      )}
      <UnsignedDownloadHint unsigned={stable.unsigned} />
    </Box>
  );
}
