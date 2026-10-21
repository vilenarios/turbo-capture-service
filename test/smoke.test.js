/**
 * Smoke test against the public internet: only https://example.com.
 * Runs only when SMOKE=1 (needs outbound HTTPS). Uses the production
 * resolver and dialer (no test hooks), so it exercises real DNS + CONNECT.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { testConfig, startApp, silentLog, pngSize } from './helpers/app.js';

const smoke = process.env.SMOKE === '1' ? test : test.skip;

smoke('captures https://example.com through the egress proxy', async () => {
  const app = await createApp(testConfig(), { log: silentLog });
  const s = await startApp(app);
  try {
    const r = await fetch(`${s.url}/screenshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', waitFor: 500 }),
    });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.match(j.title, /Example Domain/);
    assert.match(j.finalUrl, /^https:\/\/example\.com\//);
    const dim = pngSize(Buffer.from(j.screenshot, 'base64'));
    assert.equal(dim.width, 1280);
    assert.ok(dim.height >= 800);
  } finally {
    await s.close();
  }
});
