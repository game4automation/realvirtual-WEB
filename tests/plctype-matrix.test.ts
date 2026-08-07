import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import {
  BaseIndustrialInterface,
  plcTypeForSignalDescriptor,
  type SignalDescriptor,
} from '../src/interfaces/base-industrial-interface';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerNodeAliases, type LoadResult } from '../src/core/engine/rv-scene-loader';
import type { InterfaceSettings } from '../src/interfaces/interface-settings-store';
import type { RVViewer } from '../src/core/rv-viewer';
import { ensureWebComponentErrorSignal } from '../src/plugins/web-component-plugin';

class MatrixInterface extends BaseIndustrialInterface {
  readonly id = 'matrix';
  readonly protocolName = 'Matrix';

  constructor(private readonly descriptors: SignalDescriptor[]) { super(); }

  protected async doConnect(): Promise<void> {}
  protected doDisconnect(): void {}
  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> {
    return this.descriptors;
  }
  protected sendSignals(): void {}
}

const TYPES = ['bool', 'int', 'float'] as const;
const DIRECTIONS = ['input', 'output'] as const;

describe('PLC type registration matrix', () => {
  it('maps Bool/Int/Float x PLCInput/PLCOutput deterministically', () => {
    for (const type of TYPES) {
      for (const direction of DIRECTIONS) {
        const expected = `${direction === 'input' ? 'PLCInput' : 'PLCOutput'}${
          type === 'bool' ? 'Bool' : type === 'int' ? 'Int' : 'Float'
        }`;
        expect(plcTypeForSignalDescriptor({ type, direction })).toBe(expected);
      }
    }
  });

  it('registers discovered interface signals with their PLC type', async () => {
    const descriptors = TYPES.flatMap((type) =>
      DIRECTIONS.map((direction) => ({
        name: `${direction}.${type}`,
        type,
        direction,
        initialValue: type === 'bool' ? false : 0,
      })),
    );
    const store = new SignalStore();
    const iface = new MatrixInterface(descriptors);
    iface.onModelLoaded({} as LoadResult, {
      signalStore: store,
      emit: () => {},
      setConnectionState: () => {},
    } as unknown as RVViewer);

    await iface.connect({} as InterfaceSettings);

    for (const descriptor of descriptors) {
      expect(store.getType(descriptor.name)).toBe(plcTypeForSignalDescriptor(descriptor));
    }
    iface.disconnect();
  });

  it('preserves the PLC type when a renamed node registers a signal alias', () => {
    const root = new Object3D();
    const node = new Object3D();
    new Scene().add(root);
    root.add(node);
    root.name = 'Root';
    node.name = 'Signal_1';
    const registry = new NodeRegistry();
    const store = new SignalStore();
    registry.registerNode('Root/Signal_1', node);
    store.register('Signal', 'Root/Signal_1', false, 'PLCOutputBool');

    registerNodeAliases(new Map([[node, 'Signal']]), registry, store);

    expect(store.nameForPath('Root/Signal')).toBe('Signal');
    expect(store.getType('Signal')).toBe('PLCOutputBool');
  });

  it('registers WebComponent Error as PLCInputBool', () => {
    const store = new SignalStore();

    expect(ensureWebComponentErrorSignal(store, 'ScriptA', 'Cell/ScriptA')).toBe('ScriptA.Error');
    expect(store.getType('ScriptA.Error')).toBe('PLCInputBool');
    expect(store.getPath('ScriptA.Error')).toBe('Cell/ScriptA/Error');
  });
});
