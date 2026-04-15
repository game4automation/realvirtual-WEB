// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useRef, useCallback } from 'react';
import { Typography, Box, Button, Select, MenuItem } from '@mui/material';
import { RestartAlt, FileDownload, FileUpload } from '@mui/icons-material';
import { useViewer } from '../../../hooks/use-viewer';
import { clearAllRVStorage } from '../rv-storage-keys';
import { isSettingsLocked } from '../../rv-app-config';
import {
  collectSettingsBundle,
  downloadSettingsBundle,
  importSettingsFile,
  applySettingsBundle,
  getModelBasename,
} from '../rv-settings-bundle';
import type { RVSettingsBundle } from '../rv-settings-bundle';

export function ModelTab() {
  const viewer = useViewer();
  const models = viewer.availableModels;
  const currentUrl = viewer.currentModelUrl;
  // Clamp to known options so MUI Select doesn't warn about out-of-range values (e.g. blob: URLs)
  const modelValue = models.some((m) => m.url === currentUrl) ? currentUrl! : '';

  // Import confirmation state
  const [pendingImport, setPendingImport] = useState<RVSettingsBundle | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleModelChange = (url: string) => {
    if (!url) return;
    // Use loadModelWithProgress (with overlay) if available, otherwise direct load
    if (viewer.loadModelWithProgress) {
      viewer.loadModelWithProgress(url);
    } else {
      viewer.loadModel(url);
    }
  };

  const handleResetAll = () => {
    clearAllRVStorage();
    window.location.reload();
  };

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
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Model
        </Typography>
        <Select
          size="small"
          fullWidth
          value={modelValue}
          onChange={(e) => handleModelChange(e.target.value as string)}
          displayEmpty
          sx={{ mt: 0.5, fontSize: 13, '& .MuiSelect-select': { py: 0.75 } }}
        >
          <MenuItem value="" sx={{ fontSize: 13, color: 'text.secondary' }}>-- Select Model --</MenuItem>
          {models.map((m) => (
            <MenuItem key={m.url} value={m.url} sx={{ fontSize: 13 }}>{m.label}</MenuItem>
          ))}
        </Select>
      </Box>

      {/* Export / Import Settings */}
      {!isSettingsLocked() && (
        <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)', pt: 2 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1, mb: 1, display: 'block' }}>
            Settings
          </Typography>
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
        </Box>
      )}

      {/* Reset all settings (hidden when locked) */}
      {!isSettingsLocked() && (
        <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)', pt: 2 }}>
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
      )}
    </Box>
  );
}
