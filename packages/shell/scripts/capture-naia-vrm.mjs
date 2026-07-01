#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';

const [vrm = '/avatars/Naia-Iter012.vrm', out = 'app-render.png', expression = 'neutral'] = process.argv.slice(2);

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=swiftshader',
    '--disable-gpu',
  ],
});

try {
  const page = await browser.newPage({ viewport: { width: 768, height: 768 } });
  await page.goto(`http://localhost:1420/capture.html?vrm=${encodeURIComponent(vrm)}&expression=${encodeURIComponent(expression)}`);
  await page.waitForFunction(() => window.__RENDERED === true || window.__RENDER_ERROR, { timeout: 30000 });

  const state = await page.evaluate(() => ({
    rendered: window.__RENDERED === true,
    error: window.__RENDER_ERROR || null,
    bounds: window.__BOUNDS || null,
    fitted: window.__FITTED_BOUNDS || null,
    contextLost: window.__CONTEXT_LOST === true,
    hasData: Boolean(window.__CAPTURE_DATA_URL),
  }));

  if (state.error) {
    throw new Error(state.error);
  }

  const dataUrl = await page.evaluate(() => window.__CAPTURE_DATA_URL || '');
  if (!dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error('capture data URL missing');
  }

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(JSON.stringify({ out, vrm, expression, state }, null, 2));
} finally {
  await browser.close();
}
