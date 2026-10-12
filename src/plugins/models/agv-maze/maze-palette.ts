// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

// Values copied from realvirtual-WebViewer-Private~/src/plugins/asset-editor/materials/material-presets.ts
// (RAL paints and IEC-60073 signal colors). Deliberately local: the public game must not import private code.
export const MAZE_PALETTE = {
  steel: { color: 0x8a8f94, metalness: 1, roughness: 0.45 },
  stainless: { color: 0xb8bcc0, metalness: 1, roughness: 0.30 },
  'brushed-alu': { color: 0xc3c7ca, metalness: 1, roughness: 0.42 },
  'RAL 5015': { color: 0x2271b3, metalness: 0, roughness: 0.45 },
  'RAL 7016': { color: 0x383e42, metalness: 0, roughness: 0.48 },
  'RAL 1023': { color: 0xfad201, metalness: 0, roughness: 0.45 },
  'RAL 6018': { color: 0x57a639, metalness: 0, roughness: 0.45 },
  'RAL 9005': { color: 0x0a0a0d, metalness: 0, roughness: 0.50 },
  'lamp-red': { color: 0xe30613, emissive: 0xe30613, emissiveIntensity: 2 },
  'lamp-amber': { color: 0xf2a900, emissive: 0xf2a900, emissiveIntensity: 2 },
  'lamp-green': { color: 0x008351, emissive: 0x008351, emissiveIntensity: 2 },
  'lamp-white': { color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 3 },
  'lamp-blue': { color: 0x0057b8, emissive: 0x0057b8, emissiveIntensity: 4 },
} as const;
