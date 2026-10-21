/** Test-only helpers for app-level tests. */

import http from 'node:http';
import { loadConfig } from '../../src/config.js';
import { listen, close } from './net.js';

/** Config for tests: production defaults, with overrides. */
export function testConfig(overrides = {}) {
  const base = loadConfig({ CHROME_SANDBOX: process.env.CHROME_SANDBOX ?? 'true' });
  return { ...base, ...overrides };
}

/** Width/height from a PNG buffer's IHDR chunk. */
export function pngSize(buf) {
  assertPng(buf);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function assertPng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error('not a PNG');
}

export async function startApp(app) {
  const server = http.createServer(app);
  const port = await listen(server);
  return { url: `http://127.0.0.1:${port}`, close: () => close(server) };
}

const debug = process.env.TEST_DEBUG === '1';
/** Quiet logger; TEST_DEBUG=1 prints everything to stderr. */
export const silentLog = {
  info: (m, f) => debug && console.error('[info]', m, JSON.stringify(f ?? {})),
  warn: (m, f) => debug && console.error('[warn]', m, JSON.stringify(f ?? {})),
  error: (m, f) => debug && console.error('[error]', m, JSON.stringify(f ?? {})),
  child() {
    return silentLog;
  },
};
