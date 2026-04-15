// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useCallback } from 'react';
import { Typography, Box, Button, CircularProgress } from '@mui/material';
import { PlayArrow, CheckCircle, Error as ErrorIcon } from '@mui/icons-material';

interface TestResult {
  numPassedTests?: number;
  numFailedTests?: number;
  numTotalTests?: number;
  testResults?: Array<{
    name: string;
    status: string;
    assertionResults?: Array<{ fullName: string; status: string; failureMessages?: string[] }>;
  }>;
}

export function TestsTab() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runTests = useCallback(async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/__api/tests/run', { method: 'POST' });
      const json = await res.json();
      if (json.error) {
        setError(json.error);
      } else {
        setResult(json);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }, []);

  const passed = result?.numPassedTests ?? 0;
  const failed = result?.numFailedTests ?? 0;
  const total = result?.numTotalTests ?? 0;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <Button
          variant="contained"
          size="small"
          startIcon={running ? <CircularProgress size={14} color="inherit" /> : <PlayArrow />}
          disabled={running}
          onClick={runTests}
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          {running ? 'Running...' : 'Run Tests'}
        </Button>
        {result && !error && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {failed === 0 ? (
              <CheckCircle sx={{ fontSize: 16, color: '#66bb6a' }} />
            ) : (
              <ErrorIcon sx={{ fontSize: 16, color: '#ef5350' }} />
            )}
            <Typography variant="caption" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
              {passed}/{total} passed
              {failed > 0 && <span style={{ color: '#ef5350' }}> ({failed} failed)</span>}
            </Typography>
          </Box>
        )}
      </Box>

      {error && (
        <Typography variant="caption" sx={{ color: '#ef5350', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          {error}
        </Typography>
      )}

      {result?.testResults && result.testResults.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {result.testResults.map((suite) =>
            suite.assertionResults?.map((t, i) => (
              <Box key={`${suite.name}-${i}`} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                {t.status === 'passed' ? (
                  <CheckCircle sx={{ fontSize: 12, color: '#66bb6a' }} />
                ) : (
                  <ErrorIcon sx={{ fontSize: 12, color: '#ef5350' }} />
                )}
                <Typography variant="caption" sx={{ fontFamily: 'monospace', fontSize: 11, color: t.status === 'passed' ? 'text.secondary' : '#ef5350' }}>
                  {t.fullName}
                </Typography>
              </Box>
            ))
          )}
        </Box>
      )}

      {!result && !error && !running && (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          Click "Run Tests" to execute vitest browser tests. Only available on the Vite dev server.
        </Typography>
      )}
    </Box>
  );
}
