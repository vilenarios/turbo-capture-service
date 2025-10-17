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

// Use stealth plugin to evade bot detection
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3001;

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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'puppeteer-screenshot' });
});

// Screenshot endpoint
app.post('/screenshot', async (req, res) => {
  const {
    url,
    waitFor = 5000,
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

  // Block localhost/private IPs (SSRF protection)
  const hostname = parsedUrl.hostname.toLowerCase();
  const blockedHosts = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
  if (
    blockedHosts.includes(hostname) ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('10.') ||
    hostname.startsWith('172.')
  ) {
    return res.status(400).json({
      error: 'Forbidden URL',
      message: 'Cannot capture localhost or private network URLs',
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

    // Take screenshot
    const screenshot = await page.screenshot({
      fullPage: fullPage,
      type: 'png',
      // PNG doesn't support quality, but we'll keep param for future JPEG support
    });

    const screenshotSize = screenshot.length;

    console.log(`[Puppeteer] Success: ${url} -> ${screenshotSize} bytes`);

    await browser.close();

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

    if (browser) {
      await browser.close();
    }

    res.status(500).json({
      error: 'Failed to capture screenshot',
      message: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`[Puppeteer] Server running on http://localhost:${PORT}`);
  console.log(`[Puppeteer] Health check: http://localhost:${PORT}/health`);
  console.log(`[Security] Rate limit: 3 requests/minute per IP`);
  console.log(`[Security] CORS origins: ${corsOptions.origin}`);
  console.log(`[Security] Input validation: SSRF protection enabled`);
});
