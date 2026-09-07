// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-457 §9.3b (UI half) — the Json topic mode in the CONNECT panel.
 *
 * Three claims: the import dialog recognizes a SEW symbol table and offers the
 * two topic fields instead of the single S7 topic; the topic editor offers the
 * Json mode and shows encoding/interval ONLY there (they are Json-only on the
 * gateway, so offering them elsewhere would be a lie); and a Json signal row
 * renders without an address column, because its name IS the JSON key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import type { RVViewer } from '../src/core/rv-viewer';
import type { ConnectInterface, ConnectMqttTopic } from '../src/core/hmi/connect-store';
import { _resetConnectStore } from '../src/core/hmi/connect-store';
import {
  ImportTagTableDialog,
  MqttTopicEditDialog,
  SignalListView,
} from '../src/core/hmi/ConnectPanel';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';

const viewerStub = {
  signalStore: null,
  registry: null,
  signalBindingManager: undefined,
} as unknown as RVViewer;

function wrap(children: React.ReactNode) {
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={viewerStub}>{children}</RVViewerProvider>
    </ThemeProvider>
  );
}

const SEW_CSV = [
  'Name;Type;Direction',
  'Speed;INT;PLC_OUT',
  'Enable;BOOL;PLC_IN',
].join('\n');

const S7_CSV = [
  'Name;Type;Address',
  'Motor_Start;Bool;%I0.0',
].join('\n');

/** A File whose `.text()` resolves in the browser test environment. */
function csvFile(name: string, text: string): File {
  return new File([text], name, { type: 'text/csv' });
}

const MQTT_IFACE: ConnectInterface = {
  id: 'mqtt-sew',
  type: 'MQTT',
  enabled: true,
  brokerUrl: 'mqtt://localhost:1883',
  topics: [],
  signals: [],
};

beforeEach(() => {
  localStorage.clear();
  _resetConnectStore();
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  _resetConnectStore();
});

// ── Import dialog ───────────────────────────────────────────────────────────

/**
 * Drive the dialog's file picker. Chromium exposes `showOpenFilePicker`, so the
 * dialog takes the FS-Access path — stub it with a handle over our File.
 */
async function pickFile(file: File): Promise<void> {
  const handle = {
    name: file.name,
    kind: 'file' as const,
    getFile: async () => file,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
  };
  vi.stubGlobal('showOpenFilePicker', vi.fn(async () => [handle]));
  fireEvent.click(screen.getByRole('button', { name: /Choose file/ }));
}

describe('ImportTagTableDialog — SEW detection', () => {
  it('detects the SEW format and shows receive/publish topic fields', async () => {
    render(wrap(
      <ImportTagTableDialog open interfaces={[MQTT_IFACE]} initialTargetId="mqtt-sew" onClose={() => {}} />,
    ));

    // Before a file is chosen this is the ordinary S7 single-topic dialog.
    expect(screen.getByLabelText('Topic')).toBeTruthy();

    await pickFile(csvFile('symbols.csv', SEW_CSV));

    await waitFor(() => expect(screen.getByText('Detected: SEW symbol table')).toBeTruthy());
    const receive = screen.getByLabelText('Receive topic (PLC → WEB)') as HTMLInputElement;
    const publish = screen.getByLabelText('Publish topic (WEB → PLC)') as HTMLInputElement;
    expect(receive.value).toBe('SEW/SimOUT');
    expect(publish.value).toBe('SEW/SimIN');
    expect((screen.getByLabelText('Publish interval (ms)') as HTMLInputElement).value).toBe('100');
    expect(screen.getByText(/1 PLC_OUT signals/)).toBeTruthy();
    // The single S7 topic field is gone — a SEW import never targets one topic.
    expect(screen.queryByLabelText('Topic')).toBeNull();
  });

  it('keeps the S7 path for a tag table with addresses', async () => {
    render(wrap(
      <ImportTagTableDialog open interfaces={[MQTT_IFACE]} initialTargetId="mqtt-sew" onClose={() => {}} />,
    ));

    await pickFile(csvFile('tags.csv', S7_CSV));

    await waitFor(() => expect(screen.getByText(/1 Tags/)).toBeTruthy());
    expect(screen.queryByText('Detected: SEW symbol table')).toBeNull();
    expect(screen.getByLabelText('Topic')).toBeTruthy();
  });
});

// ── Topic editor ────────────────────────────────────────────────────────────

function topicEditor(topic: ConnectMqttTopic) {
  return wrap(
    <MqttTopicEditDialog open interfaceId="mqtt-sew" topic={topic} onClose={() => {}} />,
  );
}

describe('MqttTopicEditDialog', () => {
  it('offers Json mode and hides encoding/interval for Single and ProcessImage', async () => {
    render(topicEditor({ topic: 'rv/x', mode: 'Single', signals: [] }));

    // Single: mode only.
    expect(screen.getByLabelText('Mode')).toBeTruthy();
    expect(screen.queryByLabelText('Encoding')).toBeNull();
    expect(screen.queryByLabelText('Publish interval (ms)')).toBeNull();

    // ProcessImage: still mode only.
    cleanup();
    render(topicEditor({ topic: 'rv/x', mode: 'ProcessImage', signals: [] }));
    expect(screen.queryByLabelText('Encoding')).toBeNull();
    expect(screen.queryByLabelText('Publish interval (ms)')).toBeNull();

    // Json: encoding + interval appear.
    cleanup();
    render(topicEditor({ topic: 'SEW/SimIN', mode: 'Json', encoding: 'WString', publishIntervalMs: 250, signals: [] }));
    expect(screen.getByLabelText('Encoding')).toBeTruthy();
    expect((screen.getByLabelText('Publish interval (ms)') as HTMLInputElement).value).toBe('250');
    // Every mode is offered, Json included.
    fireEvent.mouseDown(screen.getByLabelText('Mode'));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Json' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'Single' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'ProcessImage' })).toBeTruthy();
  });
});

// ── Signal rows ─────────────────────────────────────────────────────────────

describe('SignalListView — Json topic rows', () => {
  it('renders Json signal rows without an address column', async () => {
    const iface: ConnectInterface = {
      ...MQTT_IFACE,
      topics: [
        {
          topic: 'SEW/SimOUT',
          mode: 'Json',
          signals: [{ protocolAddress: '', name: 'Speed', type: 'PLCOutputInt', dataType: 'INT', record: false }],
        },
        {
          topic: 'rv/pi',
          mode: 'ProcessImage',
          signals: [{ protocolAddress: '%IW13', name: 'Temp', type: 'PLCInputInt', dataType: 'Word', record: false }],
        },
      ],
    };

    render(wrap(
      <div style={{ height: 400, display: 'flex', flexDirection: 'column' }}>
        <SignalListView iface={iface} overLimitSignals={[]} />
      </div>,
    ));

    // The Json row's second line carries the data type only — no address.
    await waitFor(() => expect(screen.getByText('INT')).toBeTruthy());
    expect(screen.queryByText(/^ · INT$/)).toBeNull();
    // The ProcessImage row still shows its byte address.
    expect(screen.getByText('%IW13 · Word')).toBeTruthy();
    // The mode is visible on the group row, so a Json topic is recognizable.
    expect(screen.getByText('Json')).toBeTruthy();
  });
});
