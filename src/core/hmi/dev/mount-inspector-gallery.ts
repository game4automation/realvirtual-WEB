// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * mount-inspector-gallery.ts — mounts the DEV-ONLY Inspector reference page
 * (plan-510) into its own React root, independent of the viewer HMI.
 *
 * Loaded ONLY by the `import.meta.env.DEV && ?rvDev=inspector-gallery` branch
 * in `main.ts` (dynamic import): the production build drops the branch and
 * with it this module and the gallery. Never import it statically.
 */

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { CssBaseline } from '@mui/material';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { rvDarkTheme } from '../theme';
import { InspectorGallery } from './InspectorGallery';

const HOST_ID = 'rv-inspector-gallery';
/** The host layer sits at z-index 20000; popups (the open section menu, tooltips)
 *  portal to <body> and must stack ABOVE it, or the gallery hides them. */
const GALLERY_Z = 20000;
const galleryTheme = createTheme(rvDarkTheme, { zIndex: { modal: GALLERY_Z + 1, tooltip: GALLERY_Z + 2 } });

/** Mount the gallery as a scrollable full-screen layer over the viewer. */
export function mountInspectorGallery(): void {
  if (document.getElementById(HOST_ID)) return;
  const host = document.createElement('div');
  host.id = HOST_ID;
  Object.assign(host.style, {
    position: 'fixed',
    inset: '0',
    zIndex: String(GALLERY_Z),
    overflow: 'auto',
    padding: '24px',
    background: '#161616',
  });
  document.body.appendChild(host);
  createRoot(host).render(
    createElement(ThemeProvider, { theme: galleryTheme }, createElement(CssBaseline), createElement(InspectorGallery)),
  );
}
