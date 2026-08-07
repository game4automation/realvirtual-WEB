// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useCallback, useMemo, useEffect } from 'react';
import { Typography, Box, Button } from '@mui/material';
import { RestartAlt, FileDownload, FileUpload, CleaningServices, Cookie } from '@mui/icons-material';
import { useViewer } from '../../../hooks/use-viewer';
import { clearAllRVStorage } from '../rv-storage-keys';
import { clearCadGlbCache, getCadGlbCacheSize } from '../../import/rv-cad-glb-cache';
import { isSettingsLocked } from '../../rv-app-config';
import { isAnalyticsConfigured, useAnalyticsConsent, resetAnalyticsConsent } from '../../consent-store';
import { SettingsSection } from './settings-helpers';

/**
 * Enumerate legacy WebViewer localStorage keys that the unified Scene model
 * superseded. They are no longer read but may consume quota on long-running
 * deployments. The Settings → Backup tab exposes a button that calls this.
 */
function listLegacyWebViewerKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    if (
      k === 'rv-layouts-index' ||
      k.startsWith('rv-layouts/') ||
      k === 'rv-scene-active' ||
      k === 'rv-layout-autosave' ||
      k === 'rv-layout-library-urls' ||
      k.startsWith('rv-extras-overlay:') ||
      k.startsWith('rv-extras-originals:')
    ) {
      out.push(k);
    }
  }
  return out;
}
import {
  collectSettingsBundle,
  downloadSettingsBundle,
  importSettingsFile,
  applySettingsBundle,
  getModelBasename,
} from '../rv-settings-bundle';
import type { RVSettingsBundle } from '../rv-settings-bundle';

/**
 * BackupTab — Settings export/import + reset.
 *
 * Note: model selection moved to the Scene window (top-bar Scene button).
 * The file is still named ModelTab.tsx for git-history continuity, but the
 * exported component is `BackupTab` and the Settings tab label is "Backup".
 */
export function BackupTab() {
  const viewer = useViewer();

  // Import confirmation state
  const [pendingImport, setPendingImport] = useState<RVSettingsBundle | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Analytics consent (only relevant when a tracker is configured).
  const analyticsConfigured = isAnalyticsConfigured();
  const analyticsConsented = useAnalyticsConsent();
  const handleWithdrawConsent = useCallback(() => {
    resetAnalyticsConsent();
    window.location.reload();
  }, []);

  const handleResetAll = () => {
    clearAllRVStorage();
    window.location.reload();
  };

  // Legacy WebViewer data cleanup — see listLegacyWebViewerKeys above.
  const legacyKeyCount = useMemo(() => listLegacyWebViewerKeys().length, []);
  const handleClearLegacy = useCallback(() => {
    const keys = listLegacyWebViewerKeys();
    if (keys.length === 0) return;
    if (!confirm(
      `Clear ${keys.length} legacy WebViewer entr${keys.length === 1 ? 'y' : 'ies'} from local storage? This cannot be undone.`,
    )) return;
    for (const k of keys) {
      try { localStorage.removeItem(k); } catch { /* ignore */ }
    }
    localStorage.setItem('rv-scenes-cleared-legacy', 'true');
    window.location.reload();
  }, []);

  // Imported CAD (STEP→GLB) cache size, for the "Clear CAD import cache" button.
  const [cadCacheBytes, setCadCacheBytes] = useState<number | null>(null);
  useEffect(() => {
    void getCadGlbCacheSize().then(setCadCacheBytes).catch(() => setCadCacheBytes(null));
  }, []);
  const handleClearCadCache = useCallback(() => {
    const mb = cadCacheBytes != null ? (cadCacheBytes / 1048576).toFixed(1) : '?';
    if (!confirm(
      `Clear the imported CAD cache (~${mb} MB of converted STEP/GLB meshes)? ` +
      `Scene layouts are unaffected — a part re-converts on its next import.`,
    )) return;
    void clearCadGlbCache().then(() => window.location.reload());
  }, [cadCacheBytes]);

  const handleExport = useCallback(() => {
    const bundle = collectSettingsBundle(viewer.currentModelUrl ?? null);
    const basename = getModelBasename(viewer.currentModelUrl ?? null);
    downloadSettingsBundle(bundle, `${basename}.settings.json`);
  }, [viewer]);

  const handleImportClick = useCallback(() => {
    setImportError(null);
    setPendingImport(null);
    // Create imperative file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const bundle = await importSettingsFile(file);
        setPendingImport(bundle);
        setImportError(null);
      } catch (err) {
        setImportError(err instanceof Error ? err.message : 'Import failed.');
        setPendingImport(null);
      }
    };
    input.click();
  }, []);

  const handleApplyImport = useCallback(() => {
    if (!pendingImport) return;
    applySettingsBundle(pendingImport);
    setPendingImport(null);
    window.location.reload();
  }, [pendingImport]);

  const handleCancelImport = useCallback(() => {
    setPendingImport(null);
    setImportError(null);
  }, []);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {/* Export / Import Settings */}
      {!isSettingsLocked() && (
        <SettingsSection id="model-settings" title="Settings">
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              variant="outlined"
              size="small"
              startIcon={<FileDownload sx={{ fontSize: 14 }} />}
              onClick={handleExport}
              sx={{ fontSize: 11, textTransform: 'none', flex: 1 }}
            >
              Export Settings
            </Button>
            <Button
              variant="outlined"
              size="small"
              startIcon={<FileUpload sx={{ fontSize: 14 }} />}
              onClick={handleImportClick}
              sx={{ fontSize: 11, textTransform: 'none', flex: 1 }}
            >
              Import
            </Button>
          </Box>

          {/* Import error */}
          {importError && (
            <Typography variant="caption" sx={{ color: '#f44336', display: 'block', mt: 1, fontSize: 10 }}>
              {importError}
            </Typography>
          )}

          {/* Import confirmation */}
          {pendingImport && (
            <Box sx={{
              mt: 1.5, p: 1.5, borderRadius: 1,
              bgcolor: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.1)',
            }}>
              <Typography variant="body2" sx={{ fontSize: 12, fontWeight: 600 }}>
                Import from "{getModelBasename(pendingImport.modelUrl ?? null)}"?
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 10 }}>
                Exported {pendingImport.exportedAt ? new Date(pendingImport.exportedAt).toLocaleDateString() : 'unknown date'}.
                Overwrites current settings.
              </Typography>
              <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                <Button
                  variant="contained"
                  size="small"
                  color="primary"
                  onClick={handleApplyImport}
                  sx={{ fontSize: 11, textTransform: 'none' }}
                >
                  Apply
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleCancelImport}
                  sx={{ fontSize: 11, textTransform: 'none' }}
                >
                  Cancel
                </Button>
              </Box>
            </Box>
          )}
        </SettingsSection>
      )}

      {/* Reset all settings (hidden when locked) */}
      {!isSettingsLocked() && (
        <SettingsSection id="model-reset" title="Reset">
          <Box>
            <Button
              variant="outlined"
              size="small"
              color="warning"
              startIcon={<RestartAlt sx={{ fontSize: 14 }} />}
              onClick={handleResetAll}
              sx={{ fontSize: 11, textTransform: 'none' }}
            >
              Reset All Settings to Defaults
            </Button>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 10 }}>
              Clears all saved browser settings and reloads the page.
            </Typography>
          </Box>
        </SettingsSection>
      )}

      {/* Legacy data cleanup — orphaned keys from before the unified Scene model */}
      {!isSettingsLocked() && legacyKeyCount > 0 && (
        <SettingsSection id="model-legacy" title="Legacy Data">
          <Box>
            <Button
              variant="outlined"
              size="small"
              color="inherit"
              startIcon={<CleaningServices sx={{ fontSize: 14 }} />}
              onClick={handleClearLegacy}
              sx={{ fontSize: 11, textTransform: 'none' }}
            >
              Clear legacy WebViewer data ({legacyKeyCount})
            </Button>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 10 }}>
              Removes orphaned entries from the previous Layout / overlay storage scheme. Saved scenes are unaffected.
            </Typography>
          </Box>
        </SettingsSection>
      )}

      {/* Imported CAD cache — content-addressed converted GLBs from STEP import. */}
      {!isSettingsLocked() && (cadCacheBytes ?? 0) > 0 && (
        <SettingsSection id="model-cad-cache" title="Imported CAD Data">
          <Box>
            <Button
              variant="outlined"
              size="small"
              color="inherit"
              startIcon={<CleaningServices sx={{ fontSize: 14 }} />}
              onClick={handleClearCadCache}
              sx={{ fontSize: 11, textTransform: 'none' }}
            >
              Clear CAD import cache ({Math.max(1, Math.round((cadCacheBytes ?? 0) / 1048576))} MB)
            </Button>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 10 }}>
              Frees the browser store of converted STEP/CAD meshes. Parts re-convert on next import; scene layouts are unaffected.
            </Typography>
          </Box>
        </SettingsSection>
      )}

      {/* Analytics consent — only shown when a tracker is configured (GDPR withdrawal). */}
      {analyticsConfigured && (
        <SettingsSection id="model-privacy" title="Privacy">
          <Box>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.75, fontSize: 10 }}>
              {analyticsConsented
                ? 'Google Analytics is active — you opted in.'
                : 'Google Analytics is disabled — you have not opted in.'}
            </Typography>
            {analyticsConsented && (
              <>
                <Button
                  variant="outlined"
                  size="small"
                  color="warning"
                  startIcon={<Cookie sx={{ fontSize: 14 }} />}
                  onClick={handleWithdrawConsent}
                  sx={{ fontSize: 11, textTransform: 'none' }}
                >
                  Withdraw analytics consent
                </Button>
                <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5, fontSize: 10 }}>
                  Stops Google Analytics and reloads the page.
                </Typography>
              </>
            )}
          </Box>
        </SettingsSection>
      )}
    </Box>
  );
}
