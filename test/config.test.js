import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.js';

const WALLET = '0x' + 'ab'.repeat(20);

test('defaults', () => {
  const c = loadConfig({});
  assert.equal(c.port, 3001);
  assert.equal(c.trustProxy, false);
  assert.equal(c.maxConcurrentCaptures, 2);
  assert.equal(c.captureTimeoutMs, 60_000);
  assert.equal(c.maxScreenshotHeight, 16_384);
  assert.equal(c.rateLimitPerMinute, 3);
  assert.equal(c.chromeSandbox, true);
  assert.deepEqual([...c.allowedPorts], [80, 443, 8080, 8443]);
  assert.equal(c.x402.enabled, false);
});

test('x402 enabled without a wallet refuses to start (no hardcoded default)', () => {
  assert.throws(() => loadConfig({ ENABLE_X_402: 'true' }), ConfigError);
  assert.throws(() => loadConfig({ ENABLE_X_402: 'true', X_402_WALLET_ADDRESS: '' }), ConfigError);
  assert.throws(() => loadConfig({ ENABLE_X_402: 'true', X_402_WALLET_ADDRESS: '0x1234' }), ConfigError);
  assert.throws(() => loadConfig({ ENABLE_X_402: 'true', X_402_WALLET_ADDRESS: '0x' + '0'.repeat(40) }), ConfigError);
  assert.throws(() => loadConfig({ ENABLE_X_402: 'true', X_402_WALLET_ADDRESS: 'your_wallet_address_here' }), ConfigError);
});

test('x402 enabled with a valid wallet', () => {
  const c = loadConfig({ ENABLE_X_402: 'true', X_402_WALLET_ADDRESS: WALLET, X_402_NETWORK: 'base-sepolia' });
  assert.equal(c.x402.enabled, true);
  assert.equal(c.x402.wallet, WALLET);
  assert.equal(c.x402.network, 'eip155:84532');
  assert.equal(c.rateLimitPerMinute, 1);
  assert.equal(loadConfig({ ENABLE_X_402: 'true', X_402_WALLET_ADDRESS: WALLET }).x402.network, 'eip155:8453');
  assert.throws(() => loadConfig({ ENABLE_X_402: 'true', X_402_WALLET_ADDRESS: WALLET, X_402_NETWORK: 'solana' }), ConfigError);
  assert.throws(() => loadConfig({ ENABLE_X_402: 'true', X_402_WALLET_ADDRESS: WALLET, X_402_FACILITATOR_URL: 'http://facilitator.example' }), ConfigError);
  assert.throws(() => loadConfig({ ENABLE_X_402: 'true', X_402_WALLET_ADDRESS: WALLET, X_402_PRICE: 'free' }), ConfigError);
});

test('TRUST_PROXY parsing', () => {
  assert.equal(loadConfig({ TRUST_PROXY: '' }).trustProxy, false);
  assert.equal(loadConfig({ TRUST_PROXY: 'false' }).trustProxy, false);
  assert.equal(loadConfig({ TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ TRUST_PROXY: '2' }).trustProxy, 2);
  assert.deepEqual(loadConfig({ TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy, ['loopback', '10.0.0.0/8']);
  assert.throws(() => loadConfig({ TRUST_PROXY: 'true' }), ConfigError);
});

test('invalid numbers and booleans are fatal', () => {
  assert.throws(() => loadConfig({ MAX_CONCURRENT_CAPTURES: '0' }), ConfigError);
  assert.throws(() => loadConfig({ MAX_CONCURRENT_CAPTURES: 'two' }), ConfigError);
  assert.throws(() => loadConfig({ CAPTURE_TIMEOUT_MS: '100' }), ConfigError);
  assert.throws(() => loadConfig({ CHROME_SANDBOX: 'maybe' }), ConfigError);
  assert.throws(() => loadConfig({ ALLOWED_PORTS: '80,abc' }), ConfigError);
  assert.throws(() => loadConfig({ BLOCKED_CIDRS: '10.0.0.0/33' }));
  assert.equal(loadConfig({ ALLOWED_PORTS: '*' }).allowedPorts, null);
  assert.equal(loadConfig({ BLOCKED_CIDRS: '203.0.113.0/24, 2001:db8::/32' }).extraDeny.length, 2);
});
