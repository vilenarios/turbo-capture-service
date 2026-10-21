/**
 * Turbo Capture Service - production entry point.
 *
 * Loads and validates configuration from the environment, checks that Chrome
 * can start with the configured sandbox setting, then serves the API.
 * Network test hooks (resolver / dialer overrides) exist only as arguments to
 * createApp() and cannot be enabled from here, the environment or a request.
 */

import { loadConfig, ConfigError } from './src/config.js';
import { createApp, makeLogger, VERSION } from './src/app.js';
import { selfTest, reapOrphanChrome } from './src/capture.js';

const log = makeLogger({ svc: 'turbo-capture' });

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    log.error(`configuration error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

try {
  const version = await selfTest(config);
  log.info('chrome self-test ok', { chrome: version, sandbox: config.chromeSandbox });
} catch (err) {
  log.error('chrome failed to start', {
    err: err.message,
    hint: config.chromeSandbox
      ? 'The Chrome sandbox needs user namespaces: run the container with the seccomp profile in seccomp/chrome.json (see README "Chrome sandbox"), or set CHROME_SANDBOX=false as a last resort.'
      : undefined,
  });
  process.exit(1);
}

const app = await createApp(config, { log });
const server = app.listen(config.port, config.host, () => {
  log.info('listening', {
    version: VERSION,
    port: config.port,
    trustProxy: config.trustProxy,
    rateLimitPerMinute: config.rateLimitPerMinute,
    maxConcurrentCaptures: config.maxConcurrentCaptures,
    maxQueue: config.maxQueue,
    captureTimeoutMs: config.captureTimeoutMs,
    maxScreenshotHeight: config.maxScreenshotHeight,
    allowedPorts: config.allowedPorts ? [...config.allowedPorts] : '*',
    chromeSandbox: config.chromeSandbox,
    x402: config.x402.enabled ? { network: config.x402.network, price: config.x402.price, wallet: config.x402.wallet, facilitator: config.x402.facilitatorUrl } : false,
  });
});
// A capture can legitimately take up to CAPTURE_TIMEOUT_MS plus queue time.
server.requestTimeout = config.captureTimeoutMs + config.queueTimeoutMs + 30_000;
server.headersTimeout = 20_000;

const reaper = setInterval(() => {
  try {
    const n = reapOrphanChrome();
    if (n > 0) log.warn('killed orphaned chrome processes', { count: n });
  } catch (err) {
    log.warn('orphan reaper failed', { err: err.message });
  }
}, 60_000);
reaper.unref();

const shutdown = (sig) => {
  log.info('shutting down', { signal: sig });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
