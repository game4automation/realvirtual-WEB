// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Dev-only in-app test runner.
 * Discovers vitest test files via the rv-test-runner Vite plugin and
 * lets the user execute them from within the WebViewer UI.
 *
 * Only active when the dev server exposes /__api/tests endpoints.
 */

interface VitestResult {
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  testResults?: Array<{
    name: string;
    status: string;
    assertionResults?: Array<{
      fullName: string;
      status: string;
      failureMessages?: string[];
    }>;
  }>;
  error?: string;
}

/** Call once during init — no-ops silently if not in dev mode or no tests exist. */
export async function initTestRunner(): Promise<void> {
  try {
    const resp = await fetch('/__api/tests');
    const data = (await resp.json()) as { files: string[] };
    if (data.files.length === 0) return;
    setupTestUI(data.files);
  } catch {
    // API not available — not in dev mode or plugin missing
  }
}

function setupTestUI(testFiles: string[]): void {
  const panel = document.getElementById('test-panel');
  if (!panel) return;

  panel.style.display = 'block';

  const countEl = document.getElementById('test-file-count')!;
  countEl.textContent = `(${testFiles.length} files)`;

  const btn = document.getElementById('test-run-btn') as HTMLButtonElement;
  const statusEl = document.getElementById('test-status')!;
  const resultsEl = document.getElementById('test-results')!;

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Running\u2026';
    statusEl.textContent = '';
    statusEl.style.color = '';
    resultsEl.innerHTML = '';

    try {
      const resp = await fetch('/__api/tests/run', { method: 'POST' });
      const result = (await resp.json()) as VitestResult;

      if (result.error) {
        statusEl.textContent = 'Error';
        statusEl.style.color = '#f44336';
        resultsEl.innerHTML = `<div class="test-error">${esc(result.error)}</div>`;
      } else {
        const passed = result.numPassedTests ?? 0;
        const failed = result.numFailedTests ?? 0;
        const allPassed = failed === 0;

        statusEl.textContent = allPassed
          ? `\u2713 ${passed} passed`
          : `\u2717 ${failed} failed, ${passed} passed`;
        statusEl.style.color = allPassed ? '#4caf50' : '#f44336';

        if (result.testResults) {
          resultsEl.innerHTML = result.testResults
            .map((suite) => {
              const icon = suite.status === 'passed' ? '\u2713' : '\u2717';
              const color = suite.status === 'passed' ? '#4caf50' : '#f44336';
              const fileName = suite.name.split('/').pop() ?? suite.name;

              let html = `<div class="test-suite" style="color:${color}">${icon} ${esc(fileName)}</div>`;

              if (suite.assertionResults) {
                for (const t of suite.assertionResults) {
                  const ti = t.status === 'passed' ? '\u2713' : '\u2717';
                  const tc = t.status === 'passed' ? '#4caf50' : '#f44336';
                  html += `<div class="test-case" style="color:${tc}">${ti} ${esc(t.fullName)}</div>`;
                  if (t.failureMessages?.length) {
                    html += `<div class="test-failure">${esc(t.failureMessages[0])}</div>`;
                  }
                }
              }
              return html;
            })
            .join('');
        }
      }
    } catch (e) {
      statusEl.textContent = 'Error';
      statusEl.style.color = '#f44336';
      resultsEl.innerHTML = `<div class="test-error">${esc(String(e))}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Run Tests';
    }
  });
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
