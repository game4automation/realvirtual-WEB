// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { SixDofSample } from './rv-spacemouse-nav';

export const SPACEMOUSE_FILTERS = [{ vendorId: 0x046d }, { vendorId: 0x256f }];

export interface SpaceMouseDevice extends EventTarget {
  vendorId: number;
  productName: string;
  opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
}

export interface SpaceMouseHID extends EventTarget {
  requestDevice(options: {
    filters: typeof SPACEMOUSE_FILTERS;
  }): Promise<SpaceMouseDevice[]>;
  getDevices(): Promise<SpaceMouseDevice[]>;
}

/** Read the currently available WebHID API from the native navigator. */
export function getSpaceMouseHID(): SpaceMouseHID | undefined {
  return (navigator as unknown as {
    hid?: SpaceMouseHID;
  }).hid;
}

/** Pure parser: reports update only their group, preserving the other axes. */
export class RVSpaceMouseParser {
  readonly sample: SixDofSample = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
  buttons = 0;
  reset(): void {
    this.sample.tx = this.sample.ty = this.sample.tz = 0;
    this.sample.rx = this.sample.ry = this.sample.rz = this.buttons = 0;
  }
  parse(reportId: number, data: DataView): boolean {
    // WebHID strips the report ID. Accept recorded packets with the ID prefix too.
    const offset = data.byteLength === 13 && data.getUint8(0) === reportId ? 1 : 0;
    const length = data.byteLength - offset;
    const axis = (i: number) => Math.max(-1, Math.min(1, data.getInt16(offset + i, true) / 350));
    if (reportId === 1 && length >= 6) {
      this.sample.tx = axis(0);
      this.sample.ty = axis(2);
      this.sample.tz = axis(4);
      if (length >= 12) {
        this.sample.rx = axis(6);
        this.sample.ry = axis(8);
        this.sample.rz = axis(10);
      }
    } else if (reportId === 2 && length >= 6) {
      this.sample.rx = axis(0);
      this.sample.ry = axis(2);
      this.sample.rz = axis(4);
    } else if (reportId === 3 && length >= 1) {
      this.buttons = 0;
      for (let i = 0; i < Math.min(length, 4); i++)
        this.buttons = (this.buttons | data.getUint8(offset + i) << (8 * i)) >>> 0;
    } else
      return false;
    return true;
  }
}
