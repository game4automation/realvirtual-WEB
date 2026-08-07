// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { verifyRvSigDirect, type VerifyRvSigOptions } from './rv-sig-verify';

self.onmessage = async (event: MessageEvent<{ buffer: ArrayBuffer; options?: VerifyRvSigOptions }>) => {
  const { buffer, options } = event.data;
  const result = await verifyRvSigDirect(buffer, options);
  self.postMessage({ ...result, buffer }, { transfer: [buffer] });
};

