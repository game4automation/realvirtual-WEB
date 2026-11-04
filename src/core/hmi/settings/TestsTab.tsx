// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useCallback } from 'react';
import { Typography, Box, Button, CircularProgress } from '@mui/material';
import { PlayArrow, CheckCircle, Error as ErrorIcon } from '@mui/icons-material';
import { SettingsSection } from './settings-helpers';
import { DevApiUnavailableError, TESTS_RUN, readDevApiJson } from '../../rv-dev-api';
import { useDevTestApi } from '../use-dev-test-api';

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

/**
 * What the user is told when the route is not served here — one sentence that
 * names the state, in place of the JSON parser's message. Same contract as the
 * preset note in `VisualTab` ("Saved in this browser only…"): say what is,
 * rather than failing in the vocabulary of whatever happened to break.
 */
const API_ABSENT =
  'The test API is not available in this delivery — tests run on a development server only.';

export function TestsTab() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The same capability the tab itself is gated on (SettingsPanel). Read again
  // here because this tab is directly reachable (a remembered tab index), and
  // because an origin can lose the route between two clicks.
  const devTestApi = useDevTestApi();

  const runTests = useCallback(async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(TESTS_RUN, { method: 'POST' });
      // Not `res.json()`: a static deploy answers this route with `index.html`
      // and HTTP 200, and the parser's "Unexpected token '<'" named neither the
      // state nor the cure.
      const json = await readDevApiJson<TestResult & { error?: string }>(res, TESTS_RUN);
      if (json.error) {
        setError(json.error);
      } else {
        setResult(json);
      }
    } catch (e) {
      setError(e instanceof DevApiUnavailableError ? API_ABSENT : String(e));
    } finally {
      setRunning(false);
    }
  }, []);

  const passed = result?.numPassedTests ?? 0;
  const failed = result?.numFailedTests ?? 0;
  const total = result?.numTotalTests ?? 0;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <SettingsSection id="tests" title="Tests">
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
          {devTestApi === null
            ? API_ABSENT
            : `Click "Run Tests" to execute the ${devTestApi.files.length} vitest test ` +
              `${devTestApi.files.length === 1 ? 'file' : 'files'} this server offers.`}
        </Typography>
      )}
      </SettingsSection>
    </Box>
  );
}
