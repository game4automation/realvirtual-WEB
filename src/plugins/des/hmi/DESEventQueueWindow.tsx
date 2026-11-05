// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * DESEventQueueWindow -- Floating, draggable window showing all pending
 * events in the DES event queue.
 *
 * Uses FloatingPanel for drag/resize/title-bar infrastructure (same pattern
 * as DriveChartOverlay and SensorChartOverlay).
 *
 * Features:
 * - Always sorted by time (natural queue order)
 * - Text filter across action name, component path, MU id
 * - Dropdown filter by action category (e.g. "Station.*")
 * - Auto-refresh every 250ms in Animated/Step mode
 * - Frozen during FastForward with status message
 * - Compact rows with monospace time column
 * - Virtual scrolling for large queues (>100 events)
 * - Footer with total/filtered/cancelled counts
 */

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Box, Typography, TextField, MenuItem, Select, InputAdornment,
} from '@mui/material';
import { Search } from '@mui/icons-material';
import { FloatingPanel } from '../../../core/hmi/FloatingPanel';
import { BOTTOM_BAR_HEIGHT } from '../../../core/hmi/layout-constants';
import type { DESRunner } from '../des-runner';
import { DESMode } from '../rv-des-manager';

// ── Constants ──

const REFRESH_MS = 250;
const ROW_HEIGHT = 22;
const DEFAULT_W = 600;
const DEFAULT_H = 400;
const BOTTOM_MARGIN = BOTTOM_BAR_HEIGHT + 72;
const OVERSCAN = 5;

// ── Time formatter: DD:HH:MM:SS.ss ──

function formatTime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const dd = String(days).padStart(2, '0');
  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = seconds.toFixed(2).padStart(5, '0');
  return `${dd}:${hh}:${mm}:${ss}`;
}

// ── Types ──

interface QueueEntry {
  time: number;
  actionName: string;
  componentPath: string;
  componentShortName: string;
  muId: number;
  priority: number;
  cancelled: boolean;
  id: number;
}

export interface DESEventQueueWindowProps {
  source: DESRunner;
  open: boolean;
  onClose: () => void;
}

// ── Component ──

export function DESEventQueueWindow({ source, open, onClose }: DESEventQueueWindowProps) {
  const [events, setEvents] = useState<QueueEntry[]>([]);
  const [textFilter, setTextFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [isFastForwarding, setIsFastForwarding] = useState(false);
  const [endReached, setEndReached] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const manager = source.getManager();

  // ── Periodic refresh ──
  useEffect(() => {
    if (!open || !manager) return;

    const tick = () => {
      // Show the queue LIVE in every mode — including FastForward. The new FF
      // drains the queue incrementally per frame (budgeted processEvents), so the
      // snapshot is meaningful and shrinks visibly as events fire. (Previously FF
      // froze the list behind a "in progress" message.) The flag now only drives a
      // small non-blocking indicator.
      setIsFastForwarding(manager.mode === DESMode.FastForward);
      // End state: pending events exist but all lie BEYOND the sim end time —
      // nothing will process anymore. Show that honestly instead of "draining…".
      setEndReached(manager.isComplete && manager.pendingEventCount > 0);
      setEvents(manager.getEventQueueSnapshot());
    };

    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => clearInterval(id);
  }, [open, manager]);

  // ── Derive unique action categories ──
  const categories = useMemo(() => {
    const cats = new Set<string>();
    for (const e of events) {
      const dot = e.actionName.indexOf('.');
      if (dot > 0) {
        cats.add(e.actionName.substring(0, dot));
      } else {
        cats.add(e.actionName);
      }
    }
    return Array.from(cats).sort();
  }, [events]);

  // ── Filter events ──
  const filtered = useMemo(() => {
    const lowerText = textFilter.toLowerCase();
    return events.filter(e => {
      // Category filter
      if (categoryFilter !== 'all') {
        const dot = e.actionName.indexOf('.');
        const cat = dot > 0 ? e.actionName.substring(0, dot) : e.actionName;
        if (cat !== categoryFilter) return false;
      }
      // Text filter
      if (lowerText) {
        const haystack = `${e.actionName} ${e.componentShortName} ${e.componentPath} ${e.muId}`.toLowerCase();
        if (!haystack.includes(lowerText)) return false;
      }
      return true;
    });
  }, [events, textFilter, categoryFilter]);

  const cancelledCount = useMemo(() => events.filter(e => e.cancelled).length, [events]);

  // ── Virtual scroll ──
  const handleScroll = useCallback(() => {
    if (scrollRef.current) {
      setScrollTop(scrollRef.current.scrollTop);
    }
  }, []);

  const totalHeight = filtered.length * ROW_HEIGHT;

  // Calculate visible range (we need to know the container height)
  const containerHeight = DEFAULT_H - 110; // approximate: header + filter + footer
  const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(containerHeight / ROW_HEIGHT) + 2 * OVERSCAN;
  const endIdx = Math.min(filtered.length, startIdx + visibleCount);
  const visibleSlice = filtered.slice(startIdx, endIdx);

  // ── Header row style ──
  const headerSx = {
    fontSize: 10,
    fontWeight: 700,
    color: 'rgba(255,255,255,0.5)',
    textTransform: 'uppercase' as const,
    letterSpacing: 0.5,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    userSelect: 'none' as const,
  };

  const cellSx = {
    fontSize: 11,
    color: 'text.primary',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  };

  const subtitle = `${filtered.length} pending`;

  const toolbar = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, ml: 'auto' }}>
      <TextField
        size="small"
        placeholder="Filter..."
        value={textFilter}
        onChange={(e) => setTextFilter(e.target.value)}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <Search sx={{ fontSize: 14, color: 'rgba(255,255,255,0.3)' }} />
              </InputAdornment>
            ),
          },
        }}
        sx={{
          width: 130,
          '& .MuiInputBase-root': {
            height: 22,
            fontSize: 10,
            color: 'text.primary',
            bgcolor: 'rgba(255,255,255,0.04)',
            borderRadius: 1,
          },
          '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.08)' },
        }}
      />
      <Select
        size="small"
        value={categoryFilter}
        onChange={(e) => setCategoryFilter(e.target.value)}
        sx={{
          height: 22,
          fontSize: 10,
          color: 'text.primary',
          minWidth: 80,
          bgcolor: 'rgba(255,255,255,0.04)',
          '& .MuiOutlinedInput-notchedOutline': { borderColor: 'rgba(255,255,255,0.08)' },
          '& .MuiSelect-select': { py: 0.25, px: 1 },
        }}
      >
        <MenuItem value="all" sx={{ fontSize: 11 }}>All Actions</MenuItem>
        {categories.map(cat => (
          <MenuItem key={cat} value={cat} sx={{ fontSize: 11 }}>{cat}.*</MenuItem>
        ))}
      </Select>
    </Box>
  );

  return (
    <FloatingPanel
      open={open}
      onClose={onClose}
      title="Event Queue"
      panelId="des-event-queue"
      subtitle={subtitle}
      defaultWidth={DEFAULT_W}
      defaultHeight={DEFAULT_H}
      defaultPosition={{ x: window.innerWidth - DEFAULT_W - 16, y: window.innerHeight - DEFAULT_H - BOTTOM_MARGIN }}
      zIndex={1600}
      toolbar={toolbar}
    >
      {(
        <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          {/* ── Status indicator (non-blocking — the live queue stays visible) ── */}
          {endReached ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.25, flexShrink: 0 }}>
              {/* A normally finished run is not an error — neutral ink, not red. */}
              <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                ⏹ Simulation end reached — remaining events lie beyond the end time
              </Typography>
            </Box>
          ) : isFastForwarding ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.25, flexShrink: 0 }}>
              {/* Live-activity indicator — Instrument Blue like the other "running" states, not warning amber. */}
              <Typography sx={{ fontSize: 11, color: '#4fc3f7' }}>
                ⏩ Fast-forwarding — draining the queue…
              </Typography>
            </Box>
          ) : null}
          {/* ── Column headers ── */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: '110px 1fr 100px 40px',
              gap: 0.5,
              px: 1,
              py: 0.25,
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              flexShrink: 0,
            }}
          >
            <Typography sx={headerSx}>Time</Typography>
            <Typography sx={headerSx}>Action</Typography>
            <Typography sx={headerSx}>Component</Typography>
            <Typography sx={{ ...headerSx, textAlign: 'right' }}>MU</Typography>
          </Box>

          {/* ── Scrollable rows (virtual) ── */}
          <Box
            ref={scrollRef}
            onScroll={handleScroll}
            sx={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              '&::-webkit-scrollbar': { width: 6 },
              '&::-webkit-scrollbar-thumb': {
                bgcolor: 'rgba(255,255,255,0.12)',
                borderRadius: 3,
              },
            }}
          >
            <Box sx={{ height: totalHeight, position: 'relative' }}>
              {visibleSlice.map((e, i) => {
                const idx = startIdx + i;
                return (
                  <Box
                    key={e.id}
                    sx={{
                      position: 'absolute',
                      top: idx * ROW_HEIGHT,
                      left: 0,
                      right: 0,
                      height: ROW_HEIGHT,
                      display: 'grid',
                      gridTemplateColumns: '110px 1fr 100px 40px',
                      gap: 0.5,
                      px: 1,
                      alignItems: 'center',
                      opacity: e.cancelled ? 0.35 : 1,
                      textDecoration: e.cancelled ? 'line-through' : 'none',
                      '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
                    }}
                  >
                    <Typography
                      sx={{
                        ...cellSx,
                        fontFamily: 'monospace',
                        fontSize: 10,
                        color: '#4fc3f7',
                        letterSpacing: 0.3,
                      }}
                    >
                      {formatTime(e.time)}
                    </Typography>
                    <Typography
                      title={e.actionName}
                      sx={cellSx}
                    >
                      {e.actionName}
                    </Typography>
                    <Typography
                      title={e.componentPath}
                      sx={{ ...cellSx, color: 'rgba(255,255,255,0.6)' }}
                    >
                      {e.componentShortName}
                    </Typography>
                    <Typography
                      sx={{
                        ...cellSx,
                        textAlign: 'right',
                        fontFamily: 'monospace',
                        fontSize: 10,
                        color: e.muId >= 0 ? 'text.primary' : 'rgba(255,255,255,0.2)',
                      }}
                    >
                      {e.muId >= 0 ? e.muId : '\u2014'}
                    </Typography>
                  </Box>
                );
              })}
            </Box>
          </Box>

          {/* ── Footer ── */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              px: 1,
              py: 0.25,
              borderTop: '1px solid rgba(255,255,255,0.08)',
              flexShrink: 0,
            }}
          >
            <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
              Total: {events.length}
            </Typography>
            <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>
              Showing: {filtered.length}
            </Typography>
            {cancelledCount > 0 && (
              <Typography sx={{ fontSize: 10, color: 'rgba(255,167,38,0.6)' }}>
                Cancelled: {cancelledCount}
              </Typography>
            )}
          </Box>
        </Box>
      )}
    </FloatingPanel>
  );
}
