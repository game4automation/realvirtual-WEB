// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * useEChart — Shared ECharts lifecycle hook for init/dispose/resize.
 *
 * Handles:
 * - Delayed initialization (50ms default) to avoid race with container layout
 * - Dispose on close (prevents memory leaks)
 * - ResizeObserver for CSS-driven container resize (FloatingPanel drag/expand)
 * - Optional window resize listener (for overlay charts floating over viewport)
 * - Reactive ready state so data effects cannot race lazy ECharts loading
 * - Optional onInit callback for registering click/legend handlers
 *
 * Two groups:
 * - KPI charts (OeeChart, PartsChart, EnergyChart, CycleTimeChart):
 *     useEChart({ open }) — ResizeObserver only
 * - Overlay charts (DriveChartOverlay, SensorChartOverlay):
 *     useEChart({ open, enableWindowResize: true, onInit: ... })
 */

import { useRef, useEffect, useState } from 'react';

// Type-only reference — the echarts runtime is loaded via dynamic import() in
// the init effect, so the echarts chunk stays out of the startup bundle and is
// only fetched when the first chart actually opens.
type EChartsModule = typeof import('../core/hmi/echarts-setup')['echarts'];
export type EChartsInstance = ReturnType<EChartsModule['init']>;

interface UseEChartOptions {
  open: boolean;
  initDelay?: number;
  onInit?: (chart: EChartsInstance) => void;
  enableWindowResize?: boolean;
}

interface UseEChartResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  chartInstance: React.RefObject<EChartsInstance | null>;
  isReady: boolean;
}

export function useEChart({ open, initDelay = 50, onInit, enableWindowResize = false }: UseEChartOptions): UseEChartResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartInstance = useRef<EChartsInstance | null>(null);
  const [isReady, setIsReady] = useState(false);

  // Stabilize onInit via ref so the init effect never re-fires
  const onInitRef = useRef(onInit);
  onInitRef.current = onInit;

  // Init — echarts is fetched lazily; the cancelled flag guards against the
  // panel closing (or unmounting) while the chunk is still in flight.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void import('../core/hmi/echarts-setup').then(({ echarts }) => {
        if (cancelled || chartInstance.current || !containerRef.current) return;
        chartInstance.current = echarts.init(containerRef.current, undefined, { renderer: 'canvas' });
        setIsReady(true);
        onInitRef.current?.(chartInstance.current);
      });
    }, initDelay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, initDelay]);

  // Dispose on close
  useEffect(() => {
    if (open) return;
    chartInstance.current?.dispose();
    chartInstance.current = null;
    setIsReady(false);
  }, [open]);

  // ResizeObserver (handles CSS-driven resize from FloatingPanel drag/expand)
  useEffect(() => {
    if (!open || !containerRef.current) return;
    const observer = new ResizeObserver(() => chartInstance.current?.resize());
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [open]);

  // Window resize — opt-in only for overlay charts that float over the viewport.
  useEffect(() => {
    if (!open || !enableWindowResize) return;
    const onResize = () => chartInstance.current?.resize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, enableWindowResize]);

  return { containerRef, chartInstance, isReady };
}
