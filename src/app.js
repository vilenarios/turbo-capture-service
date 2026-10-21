/**
 * Express application. createApp() is pure wiring so tests can build an app
 * with injected network hooks; server.js is the only production entry point
 * and never passes them.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import { capture as realCapture, CaptureError } from './capture.js';
import { CaptureGate, QueueFullError, QueueTimeoutError } from './concurrency.js';
import { validateBody, precheckUrl, ValidationError, LIMITS } from './validate.js';

export const VERSION = '0.1.0';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Minimal JSON-lines logger. */
export function makeLogger(base = {}) {
  const write = (level, msg, fields) => {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...base, ...fields });
    if (level === 'error' || level === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    info: (m, f = {}) => write('info', m, f),
    warn: (m, f = {}) => write('warn', m, f),
    error: (m, f = {}) => write('error', m, f),
    child: (more) => makeLogger({ ...base, ...more }),
  };
}

const errBody = (req, error, message) => ({ error, message, requestId: req.id });

function screenshotSchemas() {
  const inputSchema = {
    type: 'object',
    required: ['url'],
    additionalProperties: false,
    properties: {
      url: { type: 'string', format: 'uri', maxLength: LIMITS.urlMaxLength, description: 'The URL to capture (HTTP/HTTPS only)' },
      waitFor: { type: 'integer', default: LIMITS.waitFor.def, minimum: LIMITS.waitFor.min, maximum: LIMITS.waitFor.max },
      viewportWidth: { type: 'integer', default: LIMITS.viewportWidth.def, minimum: LIMITS.viewportWidth.min, maximum: LIMITS.viewportWidth.max },
      viewportHeight: { type: 'integer', default: LIMITS.viewportHeight.def, minimum: LIMITS.viewportHeight.min, maximum: LIMITS.viewportHeight.max },
      fullPage: { type: 'boolean', default: true },
    },
  };
  const outputSchema = {
    type: 'object',
    properties: {
      screenshot: { type: 'string', format: 'byte', description: 'Base64-encoded PNG' },
      finalUrl: { type: 'string' },
      title: { type: 'string' },
      size: { type: 'integer' },
      capturedAt: { type: 'string', format: 'date-time' },
      viewport: { type: 'object' },
      height: { type: 'integer' },
      clipped: { type: 'boolean' },
    },
  };
  return { inputSchema, outputSchema };
}

/**
 * Build the x402 payment middleware (v2 @x402/* packages).
 * @returns {Promise<import('express').RequestHandler>}
 */
async function buildPaymentMiddleware(x402cfg) {
  const { paymentMiddleware, x402ResourceServer } = await import('@x402/express');
  const { HTTPFacilitatorClient } = await import('@x402/core/server');
  const { ExactEvmScheme } = await import('@x402/evm/exact/server');
  const { declareDiscoveryExtension } = await import('@x402/extensions/bazaar');
  const facilitator = new HTTPFacilitatorClient({ url: x402cfg.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register(x402cfg.network, new ExactEvmScheme());
  const { inputSchema, outputSchema } = screenshotSchemas();
  return paymentMiddleware(
    {
      'POST /screenshot': {
        accepts: [{ scheme: 'exact', price: x402cfg.price, network: x402cfg.network, payTo: x402cfg.wallet }],
        description: 'Capture a full-page PNG screenshot of a public web page with headless Chrome',
        mimeType: 'application/json',
        extensions: {
          ...declareDiscoveryExtension({
            method: 'POST',
            bodyType: 'json',
            input: { url: 'https://example.com', fullPage: true },
            inputSchema,
            output: { schema: outputSchema },
          }),
        },
      },
    },
    server,
  );
}

/**
 * @param {object} config from loadConfig()
 * @param {object} [deps]
 * @param {object} [deps.net] { lookup, dial } network overrides (tests only)
 * @param {Function} [deps.capture] capture implementation override (tests only)
 * @param {object} [deps.log]
 */
export async function createApp(config, deps = {}) {
  const log = deps.log ?? makeLogger({ svc: 'turbo-capture' });
  const captureImpl = deps.capture ?? realCapture;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false); // do not hash multi-megabyte screenshot bodies
  app.set('trust proxy', config.trustProxy);

  const gate = new CaptureGate({
    maxConcurrent: config.maxConcurrentCaptures,
    maxQueue: config.maxQueue,
    queueTimeoutMs: config.queueTimeoutMs,
  });
  const stats = { startTime: Date.now(), captures: 0, totalBytes: 0 };

  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });
  app.use(helmet());

  const origins = config.allowedOrigins === '' || config.allowedOrigins === '*' ? '*' : config.allowedOrigins.split(',').map((s) => s.trim());
  app.use(
    cors({
      origin: origins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type', 'X-PAYMENT', 'PAYMENT-SIGNATURE'],
      exposedHeaders: ['X-Request-Id', 'Retry-After', 'PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE', 'RateLimit', 'RateLimit-Policy'],
    }),
  );

  // --- payment + rate limit -------------------------------------------------
  const payment = config.x402.enabled ? await buildPaymentMiddleware(config.x402) : null;
  const hasPaymentHeader = (req) => req.get('payment-signature') !== undefined || req.get('x-payment') !== undefined;

  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.rateLimitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res, next) => {
      if (payment) {
        // Free tier exhausted: answer with the x402 402 Payment Required.
        return runPayment(req, res, next);
      }
      res.setHeader('Retry-After', '60');
      res.status(429).json(errBody(req, 'Too many requests', `Rate limit exceeded. Maximum ${config.rateLimitPerMinute} screenshots per minute.`));
    },
  });

  // Requests carrying a payment header have their own (higher) per-IP limit,
  // so one valid authorization cannot be replayed at will.
  const paidLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.paidRateLimitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => {
      res.setHeader('Retry-After', '60');
      res.status(429).json(errBody(req, 'Too many requests', `Paid rate limit exceeded. Maximum ${config.paidRateLimitPerMinute} paid screenshots per minute.`));
    },
  });

  /** Payment payloads currently being served (sha256 of the header). */
  const paymentsInFlight = new Set();
  app.locals.paymentInFlight = 0;

  /** Run the x402 middleware, counting it until it has fully finished (incl. settlement). */
  const runPayment = (req, res, next) => {
    app.locals.paymentInFlight++;
    Promise.resolve()
      .then(() => payment(req, res, next))
      .catch((err) => log.error('payment middleware failed', { requestId: req.id, err: err?.message }))
      .finally(() => app.locals.paymentInFlight--);
  };

  /**
   * A request carrying a payment header skips the free-tier limiter but must
   * then pass x402 verification: a missing, garbage or invalid payment gets
   * a 402 from the payment middleware and never reaches the capture.
   */
  const paymentOrRateLimit = (req, res, next) => {
    if (!(payment && hasPaymentHeader(req))) return limiter(req, res, next);
    paidLimiter(req, res, (err) => {
      if (err) return next(err);
      const header = req.get('payment-signature') ?? req.get('x-payment') ?? '';
      const key = crypto.createHash('sha256').update(header).digest('hex');
      if (paymentsInFlight.has(key)) {
        return res.status(409).json(errBody(req, 'Payment in use', 'This payment is already being used by another request'));
      }
      paymentsInFlight.add(key);
      res.on('close', () => paymentsInFlight.delete(key));
      runPayment(req, res, next);
    });
  };

  // --- routes ----------------------------------------------------------------
  const openapiSpec = YAML.parse(fs.readFileSync(path.join(ROOT, 'openapi.yaml'), 'utf8'));
  app.use(
    '/api-docs',
    (req, res, next) => {
      if (req.originalUrl === '/api-docs') return res.redirect('/api-docs/');
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(openapiSpec, { customSiteTitle: 'Turbo Capture API Docs', customCss: '.swagger-ui .topbar { display: none }' }),
  );

  app.get('/health', (req, res) => {
    const uptimeSeconds = Math.floor((Date.now() - stats.startTime) / 1000);
    res.json({
      status: 'ok',
      service: 'turbo-capture',
      version: VERSION,
      captures: stats.captures,
      totalBytes: stats.totalBytes,
      totalBytesFormatted: formatBytes(stats.totalBytes),
      uptime: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`,
      uptimeSeconds,
      activeCaptures: gate.active,
      queuedCaptures: gate.queued,
    });
  });

  app.post('/screenshot', express.json({ limit: '10kb', strict: true }), paymentOrRateLimit, async (req, res) => {
    const rlog = log.child({ requestId: req.id, ip: req.ip });
    // Abort everything when the client goes away (attached first, so a
    // disconnect during validation or the pre-check is seen too).
    const clientGone = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) clientGone.abort();
    });
    // End the response of a request whose client has gone: the x402
    // middleware waits for res.end() before it can finish (and it then
    // cancels settlement because of the status).
    const endGone = () => {
      if (!res.writableEnded) res.status(499).end();
    };
    if (!req.is('application/json')) {
      return res.status(415).json(errBody(req, 'Unsupported Media Type', 'Content-Type must be application/json'));
    }

    let params;
    try {
      params = validateBody(req.body);
    } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json(errBody(req, err.error, err.message));
      throw err;
    }

    const bad = await precheckUrl(params.url, {
      lookup: deps.net?.lookup,
      allowedPorts: config.allowedPorts,
      extraDeny: config.extraDeny,
      dns: { timeoutMs: config.precheckDnsTimeoutMs, tries: config.dns.tries },
    });
    if (clientGone.signal.aborted) return endGone();
    if (bad) {
      rlog.info('precheck refused', { url: params.url, reason: bad });
      return res.status(400).json(errBody(req, 'Forbidden URL', bad));
    }

    let release;
    try {
      release = await gate.acquire(clientGone.signal);
    } catch (err) {
      if (clientGone.signal.aborted) return endGone();
      if (err instanceof QueueFullError || err instanceof QueueTimeoutError) {
        res.setHeader('Retry-After', '10');
        return res.status(503).json(errBody(req, 'Service busy', 'All capture slots are busy. Retry later.'));
      }
      throw err;
    }

    try {
      rlog.info('capture start', { url: params.url });
      const result = await captureImpl(params, { config, signal: clientGone.signal, log: rlog, net: deps.net });
      // The client may have left while Chrome was being torn down: do not send
      // (and so do not settle a payment for) a result nobody receives.
      if (clientGone.signal.aborted) {
        rlog.info('client gone before response', { url: params.url });
        return endGone();
      }
      stats.captures++;
      stats.totalBytes += result.size;
      rlog.info('capture ok', { url: params.url, bytes: result.size, ms: result.durationMs, egress: result.egress, clipped: result.clipped });
      // Build the JSON around the (large) base64 string directly instead of
      // JSON.stringify-ing an object that contains it, and send one Buffer.
      const rest = JSON.stringify({
        finalUrl: result.finalUrl,
        title: result.title,
        size: result.size,
        capturedAt: new Date().toISOString(),
        viewport: { width: params.viewportWidth, height: params.viewportHeight },
        height: result.height,
        clipped: result.clipped,
        requestId: req.id,
      });
      const body = Buffer.from(`{"screenshot":"${result.screenshotBase64}",${rest.slice(1)}`);
      res.status(200).type('application/json').send(body);
    } catch (err) {
      const code = err instanceof CaptureError ? err.code : 'INTERNAL';
      rlog.warn('capture failed', { url: params.url, code, err: err?.message, cause: err?.cause?.message });
      if (code === 'ABORTED') return endGone();
      if (res.headersSent) return;
      if (code === 'TOO_LARGE') return res.status(422).json(errBody(req, 'Screenshot too large', `The screenshot exceeds the ${config.maxPngBytes}-byte limit; use a smaller viewport or fullPage=false`));
      if (code === 'TIMEOUT') return res.status(504).json(errBody(req, 'Capture timed out', `The capture did not finish within ${config.captureTimeoutMs} ms`));
      if (code === 'FORBIDDEN_DESTINATION') return res.status(400).json(errBody(req, 'Forbidden URL', 'The page redirected to a forbidden destination'));
      if (code === 'NAVIGATION_FAILED') return res.status(502).json(errBody(req, 'Failed to load page', 'The page could not be loaded'));
      return res.status(500).json(errBody(req, 'Failed to capture screenshot', 'Internal error'));
    } finally {
      release();
    }
  });

  app.use((req, res) => res.status(404).json(errBody(req, 'Not found', 'No such route')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json(errBody(req, 'Payload too large', 'Request body must be at most 10kb'));
    if (err?.type === 'entity.parse.failed') return res.status(400).json(errBody(req, 'Invalid JSON', 'Request body is not valid JSON'));
    log.error('unhandled error', { requestId: req.id, err: err?.message, stack: err?.stack });
    if (res.headersSent) return;
    res.status(500).json(errBody(req, 'Internal error', 'Internal error'));
  });

  app.locals.gate = gate;
  return app;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}
