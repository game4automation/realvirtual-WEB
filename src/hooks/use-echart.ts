// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * useEChart — Shared ECharts lifecycle hook for init/dispose/resize.
 *
 * Handles:
 * - Delayed initialization (50ms default) to avoid race with container layout
 * - Dispose on close (prevents memory leaks)
 * - ResizeObserver for CSS-driven container resize (ChartPanel drag/expand)
 * - Optional window resize listener (for overlay charts floating over viewport)
 * - Optional onInit callback for registering click/legend handlers
 *
 * Two groups:
 * - KPI charts (OeeChart, PartsChart, EnergyChart, CycleTimeChart):
 *     useEChart({ open }) — ResizeObserver only
 * - Overlay charts (DriveChartOverlay, SensorChartOverlay):
 *     useEChart({ open, enableWindowResize: true, onInit: ... })
 */

import { useRef, useEffect } from 'react';
import { echarts } from '../core/hmi/echarts-setup';

interface UseEChartOptions {
  open: boolean;
  initDelay?: number;
  onInit?: (chart: echarts.ECharts) => void;
  enableWindowResize?: boolean;
}

interface UseEChartResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  chartInstance: React.RefObject<echarts.ECharts | null>;
}

export function useEChart({ open, initDelay = 50, onInit, enableWindowResize = false }: UseEChartOptions): UseEChartResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartInstance = useRef<echarts.ECharts | null>(null);

  // Stabilize onInit via ref so the init effect never re-fires
  const onInitRef = useRef(onInit);
  onInitRef.current = onInit;

  // Init
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => {
      if (!chartInstance.current && containerRef.current) {
        chartInstance.current = echarts.init(containerRef.current, undefined, { renderer: 'canvas' });
        onInitRef.current?.(chartInstance.current);
      }
    }, initDelay);
    return () => clearTimeout(timer);
  }, [open, initDelay]);

  // Dispose on close
  useEffect(() => {
    if (open) return;
    chartInstance.current?.dispose();
    chartInstance.current = null;
  }, [open]);

  // ResizeObserver (handles CSS-driven resize from ChartPanel drag/expand)
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

  return { containerRef, chartInstance };
}
