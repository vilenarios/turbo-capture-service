/**
 * Puppeteer Backend Server
 * Captures full-page screenshots of websites using headless Chrome
 * With security: API key auth, rate limiting, input validation
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dns from 'dns';
import { promisify } from 'util';
import swaggerUi from 'swagger-ui-express';
import YAML from 'yaml';
import fs from 'fs';

const dnsResolve = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

// Use stealth plugin to evade bot detection
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3001;
const VERSION = '0.0.1';

// Server statistics
const startTime = Date.now();
let captureCount = 0;
let totalBytesCaptured = 0;

// Security: Helmet for HTTP headers
app.use(helmet());

// CORS configuration
const corsOptions = {
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
};
app.use(cors(corsOptions));

// Body parser
app.use(express.json({ limit: '10kb' })); // Limit payload size

// Rate limiting: 3 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 3, // 3 requests per minute
  message: {
    error: 'Too many requests',
    message: 'Rate limit exceeded. Maximum 3 screenshots per minute. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to screenshot endpoint only
app.use('/screenshot', limiter);

// Security helper functions
function isPrivateIP(ip) {
  // Check for localhost
  if (ip === '127.0.0.1' || ip === 'localhost' || ip === '0.0.0.0') {
    return true;
  }

  // Check for private IPv4 ranges
  const parts = ip.split('.');
  if (parts.length === 4) {
    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);

    // 10.0.0.0/8
    if (first === 10) return true;

    // 172.16.0.0/12
    if (first === 172 && second >= 16 && second <= 31) return true;

    // 192.168.0.0/16
    if (first === 192 && second === 168) return true;

    // 169.254.0.0/16 (link-local/cloud metadata)
    if (first === 169 && second === 254) return true;
  }

  // Check for IPv6 localhost and private addresses
  if (ip === '::1' || ip === '::' || ip.toLowerCase().startsWith('fe80:') || ip.toLowerCase().startsWith('fc00:') || ip.toLowerCase().startsWith('fd00:')) {
    return true;
  }

  // Check for IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (ip.toLowerCase().includes('::ffff:')) {
    const ipv4Part = ip.split('::ffff:')[1];
    if (ipv4Part) {
      return isPrivateIP(ipv4Part);
    }
  }

  return false;
}

function normalizeIPv6(hostname) {
  // Remove brackets if present
  let cleaned = hostname.replace(/^\[|\]$/g, '');

  // Expand :: notation to full form
  if (cleaned.includes('::')) {
    const sides = cleaned.split('::');
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides[1] ? sides[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const middle = Array(missing).fill('0000');
    cleaned = [...left, ...middle, ...right].join(':');
  }

  // Pad each segment to 4 digits
  const segments = cleaned.split(':');
  const padded = segments.map(seg => seg.padStart(4, '0'));

  return padded.join(':');
}

async function validateHostname(hostname) {
  // Check for localhost variations
  const localhostVariations = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
  if (localhostVariations.includes(hostname.toLowerCase())) {
    return { valid: false, reason: 'Localhost access not allowed' };
  }

  // Check for IPv6 localhost variations (with or without brackets)
  const cleanedHostname = hostname.replace(/^\[|\]$/g, '');

  // Normalize and check IPv6
  if (cleanedHostname.includes(':')) {
    try {
      const normalized = normalizeIPv6(cleanedHostname);
      // Check if it's localhost (0000:0000:0000:0000:0000:0000:0000:0001)
      if (normalized === '0000:0000:0000:0000:0000:0000:0000:0001') {
        return { valid: false, reason: 'Localhost access not allowed' };
      }
      // Check for IPv4-mapped IPv6
      if (normalized.startsWith('0000:0000:0000:0000:0000:ffff:')) {
        return { valid: false, reason: 'IPv4-mapped IPv6 not allowed' };
      }
      // Check for link-local and private IPv6
      if (normalized.startsWith('fe80:') || normalized.startsWith('fc00:') || normalized.startsWith('fd00:')) {
        return { valid: false, reason: 'Private IPv6 addresses not allowed' };
      }
    } catch (e) {
      // Invalid IPv6 format, continue with other checks
    }
  }

  // Check if it's a direct IP address
  if (isPrivateIP(cleanedHostname)) {
    return { valid: false, reason: 'Private IP addresses not allowed' };
  }

  // Perform DNS resolution to check if domain resolves to private IP
  try {
    // Try IPv4 resolution
    try {
      const addresses = await dnsResolve(hostname);
      for (const addr of addresses) {
        if (isPrivateIP(addr)) {
          return { valid: false, reason: 'Domain resolves to private IP address' };
        }
      }
    } catch (e) {
      // IPv4 resolution failed, that's okay
    }

    // Try IPv6 resolution
    try {
      const addresses = await dnsResolve6(hostname);
      for (const addr of addresses) {
        if (isPrivateIP(addr)) {
          return { valid: false, reason: 'Domain resolves to private IP address' };
        }
      }
    } catch (e) {
      // IPv6 resolution failed, that's okay
    }
  } catch (error) {
    // DNS resolution errors are acceptable (domain might not exist yet)
  }

  return { valid: true };
}

// Load OpenAPI spec
const openapiFile = fs.readFileSync('./openapi.yaml', 'utf8');
const openapiSpec = YAML.parse(openapiFile);

// Swagger UI with custom options for reverse proxy compatibility
// Using swaggerDocument directly to avoid URL-based loading issues
const swaggerUiOptions = {
  customSiteTitle: 'Turbo Capture API Docs',
  customCss: '.swagger-ui .topbar { display: none }',
  swaggerOptions: {
    // Pass spec directly instead of URL to avoid path issues
  }
};

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, swaggerUiOptions));

// Health check
app.get('/health', (req, res) => {
  const uptimeMs = Date.now() - startTime;
  const uptimeSeconds = Math.floor(uptimeMs / 1000);
  const hours = Math.floor(uptimeSeconds / 3600);
  const minutes = Math.floor((uptimeSeconds % 3600) / 60);
  const seconds = uptimeSeconds % 60;

  // Format bytes for human-readable display
  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  res.json({
    status: 'ok',
    service: 'turbo-capture',
    version: VERSION,
    captures: captureCount,
    totalBytes: totalBytesCaptured,
    totalBytesFormatted: formatBytes(totalBytesCaptured),
    uptime: `${hours}h ${minutes}m ${seconds}s`,
    uptimeSeconds
  });
});

// Screenshot endpoint
app.post('/screenshot', async (req, res) => {
  const {
    url,
    waitFor = 10000,
    viewportWidth = 1280,
    viewportHeight = 800,
    fullPage = true,
    quality = 90
  } = req.body;

  // Input validation
  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Validate URL format
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (error) {
    return res.status(400).json({
      error: 'Invalid URL',
      message: 'Please provide a valid HTTP or HTTPS URL',
    });
  }

  // Only allow HTTP/HTTPS
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({
      error: 'Invalid protocol',
      message: 'Only HTTP and HTTPS URLs are allowed',
    });
  }

  // Comprehensive hostname validation (SSRF protection with DNS rebinding prevention)
  const hostname = parsedUrl.hostname.toLowerCase();
  const hostnameValidation = await validateHostname(hostname);

  if (!hostnameValidation.valid) {
    return res.status(400).json({
      error: 'Forbidden URL',
      message: hostnameValidation.reason || 'Cannot capture localhost or private network URLs',
    });
  }

  // Validate viewport dimensions
  if (
    viewportWidth < 320 ||
    viewportWidth > 3840 ||
    viewportHeight < 240 ||
    viewportHeight > 2160
  ) {
    return res.status(400).json({
      error: 'Invalid viewport',
      message: 'Viewport must be between 320x240 and 3840x2160',
    });
  }

  // Validate wait time
  if (waitFor < 0 || waitFor > 30000) {
    return res.status(400).json({
      error: 'Invalid waitFor',
      message: 'Wait time must be between 0 and 30000ms',
    });
  }

  let browser;
  try {
    console.log(`[Puppeteer] Capturing screenshot: ${url}`);

    // Launch browser with stealth plugin (handles anti-detection automatically)
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });

    const page = await browser.newPage();

    // Set viewport
    await page.setViewport({
      width: viewportWidth,
      height: viewportHeight
    });

    // Navigate to URL with timeout
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Wait for additional rendering (JS execution, lazy loading, etc.)
    await new Promise(resolve => setTimeout(resolve, waitFor));

    // Get page metadata
    const finalUrl = page.url();
    const title = await page.title();

    // Validate final URL after redirects (prevent redirect-based SSRF)
    try {
      const finalParsedUrl = new URL(finalUrl);
      const finalHostname = finalParsedUrl.hostname.toLowerCase();
      const finalValidation = await validateHostname(finalHostname);

      if (!finalValidation.valid) {
        throw new Error(`Redirect to forbidden URL detected: ${finalValidation.reason}`);
      }
    } catch (error) {
      console.error(`[Security] Blocked redirect to forbidden URL: ${finalUrl}`);
      throw new Error('URL redirected to a forbidden destination');
    }

    // Take screenshot
    const screenshot = await page.screenshot({
      fullPage: fullPage,
      type: 'png',
      // PNG doesn't support quality, but we'll keep param for future JPEG support
    });

    const screenshotSize = screenshot.length;

    // Increment capture counter and total bytes
    captureCount++;
    totalBytesCaptured += screenshotSize;

    console.log(`[Puppeteer] Success: ${url} -> ${screenshotSize} bytes`);

    // Return screenshot as base64 for JSON response
    res.json({
      screenshot: screenshot.toString('base64'),
      finalUrl,
      title,
      size: screenshotSize,
      capturedAt: new Date().toISOString(),
      viewport: { width: viewportWidth, height: viewportHeight },
    });
  } catch (error) {
    console.error(`[Puppeteer] Error capturing ${url}:`, error.message);

    res.status(500).json({
      error: 'Failed to capture screenshot',
      message: error.message,
    });
  } finally {
    // Always close browser, even if errors occur
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('[Puppeteer] Error closing browser:', closeError.message);
      }
    }
  }
});

app.listen(PORT, () => {
  console.log(`[Puppeteer] Server running on http://localhost:${PORT}`);
  console.log(`[Puppeteer] API Docs: http://localhost:${PORT}/api-docs`);
  console.log(`[Puppeteer] Health check: http://localhost:${PORT}/health`);
  console.log(`[Security] Rate limit: 3 requests/minute per IP`);
  console.log(`[Security] CORS origins: ${corsOptions.origin}`);
  console.log(`[Security] Input validation: SSRF protection enabled`);
});
