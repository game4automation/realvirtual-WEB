// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AgentEyeMonitorPanel — the image history of what was produced for the agent
 * (plan-481).
 *
 * The agent camera's BODY has been visible since plan-740 (the cyan cone). This
 * panel shows its PICTURES: every image that left through the two encoders, in
 * exactly the bytes the encoder produced — including the idmask channel and the
 * burnt-in Set-of-Mark numbers the agent's statements are based on. Nothing is
 * re-rendered and nothing is re-encoded.
 *
 * ## Wording, and why it is careful
 *
 * The image tooltip says "produced for the agent", not "seen by the agent". After the
 * encode the bridge can still skip the send, so this cannot be a delivery
 * receipt — and the plan deliberately does not pretend otherwise.
 *
 * ## Auto-open (D-A7, D-U3)
 *
 * A new capture opens the panel if it is closed — a binding product decision.
 * It hangs off the store's monotonic `seq`, NOT off `frames.length`: with a full
 * buffer the length stays at 12 and a length-driven effect would stop firing.
 * Opening never steals focus, never blocks the scene (FloatingPanel is
 * layout-neutral and remembers its geometry), and a panel the user closed stays
 * closed until the NEXT capture.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, ButtonBase, IconButton, Tooltip, Typography } from '@mui/material';
import { ChevronLeft, ChevronRight, DeleteOutline } from '@mui/icons-material';
import { FloatingPanel } from './FloatingPanel';
import {
  clearAgentEyeFrames,
  closeAgentEyeMonitor,
  markAgentEyeSeen,
  openAgentEyeMonitor,
  useAgentEyeFrames,
  useAgentEyeLatestSeq,
  useAgentEyeMonitorOpen,
  type AgentEyeFrame,
} from './agent-eye-monitor-store';

const PREVIEW_W = 208;
const ENLARGED_W = 640;

/** "4s" / "1m" / "2h" — relative age, short enough for a cell caption. */
function shortAge(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

export function AgentEyeMonitorPanel() {
  const frames = useAgentEyeFrames();
  const latestSeq = useAgentEyeLatestSeq();
  const open = useAgentEyeMonitorOpen();
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const [selectedChannel, setSelectedChannel] = useState(0);
  const [enlarged, setEnlarged] = useState(false);
  // Re-render once a second so the relative ages stay honest while the panel is
  // open. Nothing ticks while it is closed.
  const [now, setNow] = useState(() => Date.now());

  // ── Auto-open, driven by the capture NUMBER (D-A7) ──
  // `null` on the first pass means "adopt whatever already happened" — mounting
  // the panel is not itself a new capture and must not pop it open.
  const lastSeenSeq = useRef<number | null>(null);
  useEffect(() => {
    if (lastSeenSeq.current === null) { lastSeenSeq.current = latestSeq; return; }
    if (latestSeq > lastSeenSeq.current) {
      lastSeenSeq.current = latestSeq;
      openAgentEyeMonitor(); // no focus() — never steal focus (D-U3)
    }
  }, [latestSeq]);

  useEffect(() => {
    if (!open) return;
    markAgentEyeSeen();
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open, latestSeq]);

  const selected: AgentEyeFrame | null = useMemo(
    () => (selectedSeq === null ? frames[0] ?? null : frames.find((f) => f.seq === selectedSeq) ?? frames[0] ?? null),
    [frames, selectedSeq],
  );

  // A capture that fell out of the ring buffer cannot stay selected.
  useEffect(() => {
    if (selectedSeq !== null && !frames.some((f) => f.seq === selectedSeq)) setSelectedSeq(null);
  }, [frames, selectedSeq]);

  const handleClose = useCallback(() => closeAgentEyeMonitor(), []);
  const handleClear = useCallback(() => {
    setSelectedSeq(null);
    setEnlarged(false);
    setSelectedChannel(0);
    clearAgentEyeFrames();
  }, []);

  const selectedIndex = selected ? frames.indexOf(selected) : 0;
  const navigate = (index: number) => {
    if (index < 0 || index >= frames.length) return;
    setSelectedSeq(index === 0 ? null : frames[index].seq);
    setSelectedChannel(0);
  };

  return (
    <FloatingPanel
      open={open}
      onClose={handleClose}
      title="Agent Eye"
      panelId="agent-eye-monitor"
      role="region"
      aria-label="Agent Eye Monitor"
      defaultWidth={PREVIEW_W}
      fixedWidth={enlarged ? ENLARGED_W : PREVIEW_W}
      defaultHeight={190}
      minWidth={PREVIEW_W}
      autoHeight
      resizable={false}
      // Auto-open on every capture: a user who folded it to its title bar keeps it folded.
      collapsible
      persistCollapsed
      toolbar={frames.length > 0 ? (
        <Tooltip title="Clear history">
          <IconButton aria-label="Clear history" size="small" onClick={handleClear} sx={{ p: 0.3 }}>
            <DeleteOutline sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      ) : undefined}
      zIndex={9300}
    >
      {selected ? (
        <ImageView
          frame={selected}
          channelIndex={selectedChannel}
          now={now}
          onChannel={setSelectedChannel}
          enlarged={enlarged}
          onToggleSize={() => setEnlarged((value) => !value)}
          canGoOlder={selectedIndex < frames.length - 1}
          canGoNewer={selectedIndex > 0}
          onOlder={() => navigate(selectedIndex + 1)}
          onNewer={() => navigate(selectedIndex - 1)}
          position={`${frames.length - selectedIndex} / ${frames.length}`}
        />
      ) : <EmptyState />}

    </FloatingPanel>
  );
}

/** F8 — an empty strip must say WHY it is empty. */
function EmptyState() {
  return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 0.5, p: 1 }}>
      <Typography sx={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
        No agent capture yet.
      </Typography>
      <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>
        Every image an AI tool produces appears here — the offscreen tools
        (web_eye, web_view_*) and web_screenshot, on WebGL and WebGPU alike.
      </Typography>
    </Box>
  );
}

function ImageView(
  { frame, channelIndex, now, onChannel, enlarged, onToggleSize,
    canGoOlder, canGoNewer, onOlder, onNewer, position }: {
    frame: AgentEyeFrame;
    channelIndex: number;
    now: number;
    onChannel: (i: number) => void;
    enlarged: boolean;
    onToggleSize: () => void;
    canGoOlder: boolean;
    canGoNewer: boolean;
    onOlder: () => void;
    onNewer: () => void;
    position: string;
  },
) {
  const activeChannel = Math.min(channelIndex, frame.images.length - 1);
  const image = frame.images[activeChannel];
  const arrowStyle = {
    position: 'absolute', top: '50%', transform: 'translateY(-50%)',
    bgcolor: 'rgba(0,0,0,0.65)', color: '#fff',
    '&:hover': { bgcolor: 'rgba(0,0,0,0.85)' },
    '&.Mui-disabled': { bgcolor: 'rgba(0,0,0,0.35)', color: 'rgba(255,255,255,0.3)' },
  } as const;
  return (
    <Box>
      <Box sx={{ position: 'relative' }}>
        <ButtonBase
          aria-label={enlarged ? 'Shrink image' : 'Enlarge image'}
          aria-pressed={enlarged}
          title={`${frame.source} - ${shortAge(frame.at, now)} ago - ${image.width} x ${image.height} - produced for the agent. Click to ${enlarged ? 'shrink' : 'enlarge'}.`}
          onClick={onToggleSize}
          sx={{
            display: 'block', width: '100%', lineHeight: 0,
            cursor: enlarged ? 'zoom-out' : 'zoom-in',
            '&.Mui-focusVisible': { outline: '2px solid #4fc3f7', outlineOffset: -2 },
          }}
        >
          <img
            src={image.url}
            alt={`${frame.source} ${image.channel}`}
            decoding="async"
            style={{ width: '100%', aspectRatio: `${image.width} / ${image.height}`, objectFit: 'contain', display: 'block' }}
          />
        </ButtonBase>
        {(canGoOlder || canGoNewer) && (
          <>
            <IconButton aria-label="Older capture" disabled={!canGoOlder} onClick={onOlder}
              size="small" sx={{ ...arrowStyle, left: 4 }}><ChevronLeft /></IconButton>
            <IconButton aria-label="Newer capture" disabled={!canGoNewer} onClick={onNewer}
              size="small" sx={{ ...arrowStyle, right: 4 }}><ChevronRight /></IconButton>
            <Typography sx={{ position: 'absolute', right: 4, bottom: 4, px: 0.5,
              borderRadius: 0.5, bgcolor: 'rgba(0,0,0,0.65)', color: '#fff',
              fontSize: 10, fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>
              {position}
            </Typography>
          </>
        )}
      </Box>
      {frame.images.length > 1 && (
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', px: 0.5 }}>
          {frame.images.map((ch, i) => (
            <Button key={ch.channel + i} size="small" aria-pressed={i === activeChannel}
              onClick={() => onChannel(i)}
              sx={{ fontSize: 10, minWidth: 0, py: 0, px: 0.5,
                color: i === activeChannel ? '#4fc3f7' : 'text.secondary' }}>
              {ch.channel}
            </Button>
          ))}
        </Box>
      )}
    </Box>
  );
}
