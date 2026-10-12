// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { chromium } from 'playwright';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const outputRoot = fileURLToPath(new URL('../../test-results/recordings/', import.meta.url));

/** Owns one browser and its video. All actions target exactly the recorded page. */
export class RecordingSession {
  browser;
  context;
  page;
  timer;
  result = { state: 'idle' };
  steps = [];
  busy = false;

  async start({ url, width = 1920, height = 1080, maxDurationSec = 180, outputDir = outputRoot }) {
    if (this.browser) throw new Error('A recording is already active. Stop it first.');
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Expected an HTTP(S) application URL.');
    const directory = join(resolve(outputDir), new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
    await mkdir(directory, { recursive: true });
    this.steps = [];
    this.result = { state: 'starting', directory, url: target.href, width, height, startedAt: Date.now() };
    try {
      this.browser = await chromium.launch({ channel: 'chromium', headless: true, args: [
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ] });
      this.context = await this.browser.newContext({ viewport: { width, height },
        recordVideo: { dir: directory, size: { width, height } }, acceptDownloads: false });
      // Dismiss through the real close button on every navigation, including
      // delayed React mounts. This preference applies only to recording pages.
      await this.context.addInitScript(() => {
        // The fresh profile would open the welcome/terms modal over every recording.
        // Seed its flags before the app boots (keys: WelcomeModal.tsx, ButtonPanel.tsx).
        try {
          localStorage.setItem('rv-terms-accepted', '1');
          localStorage.setItem('rv-welcome-dismissed', '1');
        } catch { /* opaque origin: nothing to seed */ }
        const dismissed = new WeakSet();
        const closeBanner = () => {
          const button = document.querySelector('button[aria-label="Hide dev server banner until reload"]');
          if (button && !dismissed.has(button)) {
            dismissed.add(button);
            button.click();
          }
        };
        new MutationObserver(closeBanner).observe(document, { childList: true, subtree: true });
        closeBanner();
      });
      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(15_000);
      this.page.on('pageerror', error => this.steps.push({ type: 'pageerror', message: error.message, at: Date.now() }));
      const response = await this.page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (response && !response.ok()) throw new Error(`Application returned HTTP ${response.status()}`);
      this.result.state = 'recording';
      this.timer = setTimeout(() => { void this.stop().catch(error => {
        process.stderr.write(`Recording auto-stop failed: ${error.message}\n`);
      }); }, maxDurationSec * 1000);
      return this.status();
    } catch (error) {
      await this.stop().catch(() => {});
      this.result.state = 'failed';
      this.result.error = error.message;
      throw error;
    }
  }

  status() {
    return { ...this.result, elapsedSec: this.result.startedAt
      ? ((this.result.stoppedAt ?? Date.now()) - this.result.startedAt) / 1000 : 0 };
  }

  async snapshot() {
    if (!this.page || this.result.state !== 'recording') throw new Error('No active recording.');
    return { screenshot: await this.page.screenshot(), tree: await this.page.locator('body').ariaSnapshot() };
  }

  async run(steps) {
    if (!this.page || this.result.state !== 'recording') throw new Error('No active recording.');
    if (this.busy) throw new Error('A sequence is already running.');
    this.busy = true;
    let completed = 0;
    try {
      for (const step of steps) {
        const entry = { ...step, at: Date.now(), outcome: 'running' };
        this.steps.push(entry);
        try {
          const locator = step.selector ? this.page.locator(step.selector) : null;
          switch (step.type) {
            case 'wait': await this.page.waitForTimeout(step.ms); break;
            case 'waitFor': await locator.waitFor({ state: step.state ?? 'visible', timeout: step.timeoutMs ?? 30_000 }); break;
            case 'click': await locator.click(); break;
            case 'doubleClick': await locator.dblclick(); break;
            case 'fill': await locator.fill(step.value); break;
            case 'press': await this.page.keyboard.press(step.key); break;
            case 'wheel':
              await this.page.mouse.move(step.x, step.y);
              await this.page.mouse.wheel(0, step.deltaY);
              break;
            case 'drag': {
              await this.page.mouse.move(step.fromX, step.fromY);
              await this.page.mouse.down({ button: step.button ?? 'left' });
              try {
                const count = Math.max(1, Math.ceil((step.durationMs ?? 1000) / 40));
                for (let i = 1; i <= count; i++) {
                  await this.page.mouse.move(step.fromX + (step.toX - step.fromX) * i / count,
                    step.fromY + (step.toY - step.fromY) * i / count);
                  await this.page.waitForTimeout((step.durationMs ?? 1000) / count);
                }
              } finally { await this.page.mouse.up({ button: step.button ?? 'left' }); }
              break;
            }
            default: throw new Error(`Unknown step type: ${step.type}`);
          }
          entry.outcome = 'ok';
          completed++;
        } catch (error) { entry.outcome = 'error'; entry.error = error.message; throw error; }
      }
      return { completed };
    } finally { this.busy = false; }
  }

  async stop() {
    if (this.stopping) return this.stopping;
    if (!this.browser) return this.status();
    this.stopping = this.finalize();
    try { return await this.stopping; } finally { this.stopping = null; }
  }

  async finalize() {
    clearTimeout(this.timer);
    this.result.state = 'finalizing';
    const video = this.page?.video();
    try {
      if (this.page && !this.page.isClosed()) {
        await this.page.screenshot({ path: join(this.result.directory, 'final.png'), timeout: 5000 }).catch(() => {});
        await this.page.locator('body').ariaSnapshot({ timeout: 5000 })
          .then(tree => writeFile(join(this.result.directory, 'accessibility.txt'), tree)).catch(() => {});
      }
      this.result.captureEndedAt = Date.now();
      await this.context?.close();
      if (!video) throw new Error('No video was created.');
      const videoPath = await video.path();
      const { size } = await stat(videoPath);
      if (size === 0) throw new Error('The video is empty.');
      this.result = { ...this.result, state: 'saved', videoPath, bytes: size, stoppedAt: Date.now() };
      return this.status();
    } catch (error) {
      this.result = { ...this.result, state: 'failed', error: error.message, stoppedAt: Date.now() };
      throw error;
    } finally {
      try { await this.browser?.close(); } finally {
        this.browser = this.context = this.page = null;
        await writeFile(join(this.result.directory, 'session.json'), JSON.stringify({ ...this.status(), steps: this.steps }, null, 2));
      }
    }
  }
}
