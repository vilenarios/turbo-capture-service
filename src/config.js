/**
 * Environment configuration. Every value is parsed and range-checked at
 * start-up; an invalid value is a fatal error rather than a silent default.
 */

import { parseCidrList } from './address.js';

export class ConfigError extends Error {}

function int(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^\d+$/.test(raw.trim())) throw new ConfigError(`${name} must be an integer, got "${raw}"`);
  const v = Number(raw.trim());
  if (v < min || v > max) throw new ConfigError(`${name} must be between ${min} and ${max}, got ${v}`);
  return v;
}

function bool(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw new ConfigError(`${name} must be true or false, got "${raw}"`);
}

/**
 * TRUST_PROXY: unset/"false" = do not trust X-Forwarded-For (default).
 * An integer N = trust N hops (e.g. 1 behind a single nginx or ALB).
 * Otherwise a comma-separated list of addresses/CIDRs/express keywords
 * (loopback, linklocal, uniquelocal). "true" is refused because it lets any
 * client spoof its address and bypass the rate limit.
 */
function trustProxy(env) {
  const raw = (env.TRUST_PROXY ?? '').trim();
  if (raw === '' || raw.toLowerCase() === 'false' || raw === '0') return false;
  if (raw.toLowerCase() === 'true') {
    throw new ConfigError('TRUST_PROXY=true trusts every X-Forwarded-For hop and lets clients spoof their IP; set the hop count (e.g. 1) or the proxy addresses instead');
  }
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n > 10) throw new ConfigError('TRUST_PROXY hop count must be 0-10');
    return n;
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function ports(env) {
  const raw = (env.ALLOWED_PORTS ?? '80,443,8080,8443').trim();
  if (raw === '*') return null;
  const set = new Set();
  for (const p of raw.split(',')) {
    const t = p.trim();
    if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 65535) throw new ConfigError(`ALLOWED_PORTS has an invalid port "${t}"`);
    set.add(Number(t));
  }
  if (set.size === 0) throw new ConfigError('ALLOWED_PORTS is empty');
  return set;
}

const NETWORK_ALIASES = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
};

function x402(env) {
  const enabled = bool(env, 'ENABLE_X_402', false);
  if (!enabled) return { enabled: false };
  const wallet = (env.X_402_WALLET_ADDRESS ?? '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || /^0x0{40}$/.test(wallet)) {
    throw new ConfigError('ENABLE_X_402=true requires X_402_WALLET_ADDRESS to be set to your EVM wallet address (0x followed by 40 hex characters)');
  }
  const netRaw = (env.X_402_NETWORK ?? 'base').trim();
  const network = NETWORK_ALIASES[netRaw] ?? netRaw;
  if (!/^eip155:\d+$/.test(network)) {
    throw new ConfigError(`X_402_NETWORK must be base, base-sepolia or a CAIP-2 eip155:<chainId> id, got "${netRaw}"`);
  }
  const facilitatorUrl = (env.X_402_FACILITATOR_URL ?? 'https://facilitator.x402.rs').trim();
  let fu;
  try {
    fu = new URL(facilitatorUrl);
  } catch {
    throw new ConfigError('X_402_FACILITATOR_URL is not a valid URL');
  }
  if (fu.protocol !== 'https:' && !(fu.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(fu.hostname))) {
    throw new ConfigError('X_402_FACILITATOR_URL must use https');
  }
  const price = (env.X_402_PRICE ?? '$0.01').trim();
  if (!/^\$\d+(\.\d+)?$/.test(price)) throw new ConfigError(`X_402_PRICE must look like $0.01, got "${price}"`);
  return { enabled: true, wallet, network, facilitatorUrl, price };
}

export function loadConfig(env = process.env) {
  const cfg = {
    port: int(env, 'PORT', 3001, 1, 65535),
    host: (env.HOST ?? '0.0.0.0').trim(),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? '').trim(),
    trustProxy: trustProxy(env),
    // Free-tier rate limit (per client IP, per minute).
    rateLimitPerMinute: int(env, 'RATE_LIMIT_PER_MINUTE', bool(env, 'ENABLE_X_402', false) ? 1 : 3, 1, 10_000),
    maxConcurrentCaptures: int(env, 'MAX_CONCURRENT_CAPTURES', 2, 1, 32),
    maxQueue: int(env, 'MAX_QUEUE', 4, 0, 100),
    queueTimeoutMs: int(env, 'QUEUE_TIMEOUT_MS', 30_000, 1_000, 300_000),
    captureTimeoutMs: int(env, 'CAPTURE_TIMEOUT_MS', 60_000, 5_000, 300_000),
    navigationTimeoutMs: int(env, 'NAVIGATION_TIMEOUT_MS', 30_000, 1_000, 120_000),
    maxScreenshotHeight: int(env, 'MAX_SCREENSHOT_HEIGHT', 16_384, 240, 65_535),
    scrollMaxSteps: int(env, 'SCROLL_MAX_STEPS', 40, 0, 1_000),
    scrollMaxMs: int(env, 'SCROLL_MAX_MS', 10_000, 0, 120_000),
    maxEgressBytes: int(env, 'MAX_EGRESS_BYTES', 200 * 1024 * 1024, 1024 * 1024, 4 * 1024 * 1024 * 1024),
    allowedPorts: ports(env),
    extraDeny: parseCidrList((env.BLOCKED_CIDRS ?? '').split(',').filter((s) => s.trim() !== '')),
    chromeSandbox: bool(env, 'CHROME_SANDBOX', true),
    x402: x402(env),
  };
  return cfg;
}
