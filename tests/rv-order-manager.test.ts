// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  subscribeOrderStore,
  getOrderSnapshot,
  extractOrderData,
  OrderManagerPlugin,
  _resetOrderStore,
} from '../src/plugins/order-manager-plugin';
import type { AasParsedData } from '../src/plugins/aas-link-parser';

// ─── Helper: direct store mutations via plugin instance ──────────────

let plugin: OrderManagerPlugin;

function addItem(
  aasId: string,
  displayName: string,
  manufacturer: string,
  articleNumber: string,
  nodePath?: string,
): void {
  plugin.addItem(aasId, displayName, manufacturer, articleNumber, nodePath);
}

function removeItem(aasId: string): void {
  plugin.removeItem(aasId);
}

function updateQuantity(aasId: string, qty: number): void {
  plugin.updateQuantity(aasId, qty);
}

function clear(): void {
  plugin.clear();
}

function exportCsv(): string {
  return plugin.exportCsv();
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('OrderManagerStore', () => {
  beforeEach(() => {
    _resetOrderStore();
    plugin = new OrderManagerPlugin();
  });

  it('should add item and update snapshot', () => {
    addItem('aas-001', 'Motor XM-500', 'Bosch Rexroth', 'R911234567');
    const snap = getOrderSnapshot();
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].aasId).toBe('aas-001');
    expect(snap.items[0].quantity).toBe(1);
    expect(snap.totalPositions).toBe(1);
    expect(snap.totalQuantity).toBe(1);
  });

  it('should increment quantity on duplicate aasId', () => {
    addItem('aas-001', 'Motor XM-500', 'Bosch', 'R911234567');
    addItem('aas-001', 'Motor XM-500', 'Bosch', 'R911234567');
    const snap = getOrderSnapshot();
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].quantity).toBe(2);
    expect(snap.totalQuantity).toBe(2);
  });

  it('should remove item', () => {
    addItem('aas-001', 'Motor', 'Bosch', 'R911');
    addItem('aas-002', 'Sensor', 'ifm', 'O5D100');
    removeItem('aas-001');
    const snap = getOrderSnapshot();
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].aasId).toBe('aas-002');
  });

  it('should update quantity with min=1', () => {
    addItem('aas-001', 'Motor', 'Bosch', 'R911');
    updateQuantity('aas-001', 5);
    expect(getOrderSnapshot().items[0].quantity).toBe(5);
    updateQuantity('aas-001', 0); // should clamp to 1
    expect(getOrderSnapshot().items[0].quantity).toBe(1);
  });

  it('should clamp NaN and Infinity to 1', () => {
    addItem('aas-001', 'Motor', 'Bosch', 'R911');
    updateQuantity('aas-001', NaN);
    expect(getOrderSnapshot().items[0].quantity).toBe(1);
    updateQuantity('aas-001', Infinity);
    expect(getOrderSnapshot().items[0].quantity).toBe(1);
  });

  it('should clear all items', () => {
    addItem('aas-001', 'Motor', 'Bosch', 'R911');
    addItem('aas-002', 'Sensor', 'ifm', 'O5D100');
    clear();
    const snap = getOrderSnapshot();
    expect(snap.items).toHaveLength(0);
    expect(snap.totalPositions).toBe(0);
    expect(snap.totalQuantity).toBe(0);
  });

  it('should notify listeners on change', () => {
    const listener = vi.fn();
    const unsub = subscribeOrderStore(listener);
    addItem('aas-001', 'Motor', 'Bosch', 'R911');
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    addItem('aas-002', 'Sensor', 'ifm', 'O5D');
    expect(listener).toHaveBeenCalledTimes(1); // no more calls after unsub
  });

  it('should return new snapshot reference on mutation', () => {
    addItem('aas-001', 'Motor', 'Bosch', 'R911');
    const snap1 = getOrderSnapshot();
    addItem('aas-002', 'Sensor', 'ifm', 'O5D100');
    const snap2 = getOrderSnapshot();
    expect(snap1).not.toBe(snap2); // different reference
  });

  it('should keep snapshot stable when no mutation', () => {
    addItem('aas-001', 'Motor', 'Bosch', 'R911');
    const snap1 = getOrderSnapshot();
    const snap2 = getOrderSnapshot();
    expect(snap1).toBe(snap2); // same reference
  });

  it('should add multiple different items', () => {
    addItem('aas-001', 'Motor', 'Bosch', 'R911');
    addItem('aas-002', 'Sensor', 'ifm', 'O5D100');
    addItem('aas-003', 'Valve', 'Festo', 'VUVG-L10');
    const snap = getOrderSnapshot();
    expect(snap.totalPositions).toBe(3);
    expect(snap.totalQuantity).toBe(3);
  });
});

// ─── extractOrderData Tests ──────────────────────────────────────────

describe('extractOrderData', () => {
  it('should extract standard nameplate fields', () => {
    const parsed: AasParsedData = {
      aasId: 'aas-001',
      idShort: 'MotorXM500',
      nameplate: [
        { label: 'ManufacturerProductDesignation', value: 'Motor XM-500' },
        { label: 'ManufacturerName', value: 'Bosch Rexroth' },
        { label: 'ManufacturerArticleNumber', value: 'R911234567' },
      ],
      technicalData: [],
      documents: [],
    };
    const result = extractOrderData(parsed);
    expect(result.displayName).toBe('Motor XM-500');
    expect(result.manufacturer).toBe('Bosch Rexroth');
    expect(result.articleNumber).toBe('R911234567');
  });

  it('should fallback to idShort when no designation', () => {
    const parsed: AasParsedData = {
      aasId: 'x',
      idShort: 'FallbackName',
      nameplate: [],
      technicalData: [],
      documents: [],
    };
    expect(extractOrderData(parsed).displayName).toBe('FallbackName');
  });

  it('should handle OrderCode as fallback for ArticleNumber', () => {
    const parsed: AasParsedData = {
      aasId: 'x',
      idShort: 'X',
      nameplate: [{ label: 'ManufacturerOrderCode', value: 'OC-999' }],
      technicalData: [],
      documents: [],
    };
    expect(extractOrderData(parsed).articleNumber).toBe('OC-999');
  });

  it('should handle case-insensitive label matching', () => {
    const parsed: AasParsedData = {
      aasId: 'x',
      idShort: 'X',
      nameplate: [
        { label: 'Manufacturer Product Designation', value: 'Pump ABC' },
        { label: 'manufacturer name', value: 'KSB' },
      ],
      technicalData: [],
      documents: [],
    };
    const result = extractOrderData(parsed);
    expect(result.displayName).toBe('Pump ABC');
    expect(result.manufacturer).toBe('KSB');
  });

  it('should handle PartNumber as fallback for ArticleNumber', () => {
    const parsed: AasParsedData = {
      aasId: 'x',
      idShort: 'X',
      nameplate: [{ label: 'PartNumber', value: 'PN-12345' }],
      technicalData: [],
      documents: [],
    };
    expect(extractOrderData(parsed).articleNumber).toBe('PN-12345');
  });
});

// ─── CSV Export Tests ────────────────────────────────────────────────

describe('exportCsv', () => {
  beforeEach(() => {
    _resetOrderStore();
    plugin = new OrderManagerPlugin();
  });

  it('should produce valid CSV with headers', () => {
    addItem('aas-001', 'Motor XM-500', 'Bosch Rexroth', 'R911234567');
    updateQuantity('aas-001', 3);
    addItem('aas-002', 'Sensor IFM', 'ifm', 'O5D100');
    const csv = exportCsv();
    const lines = csv.split('\n');
    expect(lines[0]).toBe('ArticleNumber,Description,Manufacturer,Quantity');
    expect(lines[1]).toContain('R911234567');
    expect(lines[1]).toContain('3');
    expect(lines).toHaveLength(3); // header + 2 items
  });

  it('should escape commas in values', () => {
    addItem('x', 'Motor, Large', 'Bosch, Ltd.', 'R911');
    const csv = exportCsv();
    expect(csv).toContain('"Motor, Large"');
    expect(csv).toContain('"Bosch, Ltd."');
  });

  it('should escape quotes in values', () => {
    addItem('x', 'Motor "Pro"', 'Bosch', 'R911');
    const csv = exportCsv();
    expect(csv).toContain('"Motor ""Pro"""');
  });

  it('should return only header for empty cart', () => {
    const csv = exportCsv();
    expect(csv).toBe('ArticleNumber,Description,Manufacturer,Quantity');
  });
});

// ─── Plugin Lifecycle Tests ──────────────────────────────────────────

describe('OrderManagerPlugin lifecycle', () => {
  beforeEach(() => {
    _resetOrderStore();
  });

  it('should have correct id and slots', () => {
    const p = new OrderManagerPlugin();
    expect(p.id).toBe('order-manager');
    expect(p.slots).toHaveLength(1);
    expect(p.slots![0].slot).toBe('button-group');
  });

  it('should accept config in constructor', () => {
    const p = new OrderManagerPlugin({
      orderUrl: 'https://shop.example.com/api',
      orderMethod: 'POST',
      orderEmail: 'orders@example.com',
    });
    expect(p.config.orderUrl).toBe('https://shop.example.com/api');
    expect(p.config.orderMethod).toBe('POST');
    expect(p.config.orderEmail).toBe('orders@example.com');
  });

  it('should default to empty config', () => {
    const p = new OrderManagerPlugin();
    expect(p.config.orderUrl).toBeUndefined();
    expect(p.config.orderEmail).toBeUndefined();
  });

  it('should restore items from sessionStorage on model load', () => {
    // Pre-populate sessionStorage
    const items = [
      {
        aasId: 'aas-001',
        displayName: 'Motor',
        manufacturer: 'Bosch',
        articleNumber: 'R911',
        quantity: 2,
        addedAt: Date.now(),
      },
    ];
    try {
      sessionStorage.setItem('rv-order-cart', JSON.stringify(items));
    } catch {
      // sessionStorage may not be available in test env — skip
      return;
    }

    const p = new OrderManagerPlugin();
    const mockViewer = {
      contextMenu: { register: vi.fn() },
    } as any;
    p.onModelLoaded({} as any, mockViewer);
    expect(getOrderSnapshot().items).toHaveLength(1);
    expect(getOrderSnapshot().items[0].quantity).toBe(2);

    // Cleanup
    try { sessionStorage.removeItem('rv-order-cart'); } catch { /* */ }
  });

  it('should clear items on model cleared', () => {
    const p = new OrderManagerPlugin();
    p.addItem('aas-001', 'Motor', 'Bosch', 'R911');
    expect(getOrderSnapshot().items).toHaveLength(1);
    p.onModelCleared!();
    expect(getOrderSnapshot().items).toHaveLength(0);
  });

  it('should return items from getItems', () => {
    const p = new OrderManagerPlugin();
    p.addItem('aas-001', 'Motor', 'Bosch', 'R911');
    p.addItem('aas-002', 'Sensor', 'ifm', 'O5D');
    const items = p.getItems();
    expect(items).toHaveLength(2);
    // Ensure it's a copy
    expect(items).not.toBe(getOrderSnapshot().items);
  });
});
