/**
 * Strict validation of the POST /screenshot body, and the fast top-level URL
 * pre-check. The egress proxy is the real enforcement point; the pre-check
 * only turns obviously bad URLs into a quick 400.
 */

import { resolveAndValidate } from './egress-proxy.js';

export const LIMITS = {
  urlMaxLength: 2048,
  waitFor: { min: 0, max: 30_000, def: 10_000 },
  viewportWidth: { min: 320, max: 3840, def: 1280 },
  viewportHeight: { min: 240, max: 2160, def: 800 },
  quality: { min: 1, max: 100, def: 90 },
};

const KNOWN = new Set(['url', 'waitFor', 'viewportWidth', 'viewportHeight', 'fullPage', 'quality']);

export class ValidationError extends Error {
  constructor(error, message) {
    super(message);
    this.error = error;
  }
}

function intField(body, name) {
  const spec = LIMITS[name];
  if (!(name in body)) return spec.def;
  const v = body[name];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < spec.min || v > spec.max) {
    throw new ValidationError(`Invalid ${name}`, `${name} must be an integer between ${spec.min} and ${spec.max}`);
  }
  return v;
}

/**
 * @param {unknown} body parsed JSON body
 * @returns {{url: string, waitFor: number, viewportWidth: number, viewportHeight: number, fullPage: boolean}}
 */
export function validateBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Invalid request', 'Request body must be a JSON object');
  }
  const unknown = Object.keys(body).filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) {
    throw new ValidationError('Invalid request', `Unknown field(s): ${unknown.slice(0, 5).map((k) => k.slice(0, 40)).join(', ')}`);
  }
  if (!('url' in body) || body.url === '' || body.url === null) throw new ValidationError('URL is required', 'url is required');
  if (typeof body.url !== 'string') throw new ValidationError('Invalid URL', 'url must be a string');
  if (body.url.length > LIMITS.urlMaxLength) throw new ValidationError('Invalid URL', `url must be at most ${LIMITS.urlMaxLength} characters`);

  let parsed;
  try {
    parsed = new URL(body.url);
  } catch {
    throw new ValidationError('Invalid URL', 'Please provide a valid HTTP or HTTPS URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('Invalid protocol', 'Only HTTP and HTTPS URLs are allowed');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ValidationError('Invalid URL', 'URLs with credentials are not allowed');
  }

  const waitFor = intField(body, 'waitFor');
  const viewportWidth = intField(body, 'viewportWidth');
  const viewportHeight = intField(body, 'viewportHeight');
  intField(body, 'quality'); // accepted for compatibility; PNG output ignores it
  let fullPage = true;
  if ('fullPage' in body) {
    if (typeof body.fullPage !== 'boolean') throw new ValidationError('Invalid fullPage', 'fullPage must be a boolean');
    fullPage = body.fullPage;
  }
  return { url: parsed.href, waitFor, viewportWidth, viewportHeight, fullPage };
}

/**
 * Fast pre-check of the top-level URL using the same rules as the proxy.
 * @returns {Promise<null|string>} null when OK, otherwise a client-safe reason
 */
export async function precheckUrl(url, { lookup, allowedPorts, extraDeny }) {
  const u = new URL(url);
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  try {
    await resolveAndValidate(u.hostname, port, { lookup, allowedPorts, extraDeny });
    return null;
  } catch (err) {
    if (err.status === 502) return 'The host name could not be resolved';
    if (/port/.test(err.message)) return 'This port is not allowed';
    return 'Cannot capture localhost, private-network or reserved addresses';
  }
}
