# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Turbo Capture Service is a headless Chrome screenshot capture API powered by Puppeteer with stealth mode for bot detection evasion. It's designed for permanent web archiving on Arweave and can capture websites that block automated browsers (Twitter, Instagram, etc.).

**Key Technology:** Uses `puppeteer-extra` with the stealth plugin to evade bot detection by hiding navigator.webdriver, mocking Chrome APIs, and preventing browser fingerprinting.

## Development Commands

```bash
npm start              # Production mode
npm run dev           # Development mode with auto-reload (--watch)
```

### Docker
```bash
docker-compose up -d               # Start service
docker-compose down                # Stop service
docker logs -f permaweb-capture-backend  # View logs
```

### Manual Chrome Installation
When running without Docker, Chrome must be installed manually:
```bash
npx puppeteer browsers install chrome
```

## Architecture

### Single File Service (`server.js`)
This is intentionally a single-file Express application. All logic is in `server.js`:
- Express HTTP server setup and middleware
- Rate limiting with x402 skip logic
- x402 payment middleware configuration
- Security validation functions (`isPrivateIP`, `normalizeIPv6`, `validateHostname`)
- Swagger UI setup
- Health endpoint (`GET /health`)
- Screenshot endpoint (`POST /screenshot`)

### Security Architecture

The service implements **defense-in-depth SSRF protection** in three layers:

1. **Initial URL Validation**: Protocol whitelist (HTTP/HTTPS only)
2. **DNS Resolution Check**: `validateHostname()` validates hostname doesn't resolve to private IPs before navigation
3. **Post-Redirect Validation**: Re-validates final URL after all redirects to prevent redirect-based SSRF

**Critical Security Functions:**
- `isPrivateIP(ip)`: Checks IPv4/IPv6 private ranges, localhost, link-local (169.254.0.0/16), and IPv4-mapped IPv6
- `normalizeIPv6(hostname)`: Expands IPv6 :: notation to detect obfuscated localhost
- `validateHostname(hostname)`: Performs DNS resolution to detect domains that resolve to private IPs (DNS rebinding protection)

### Rate Limiting & x402 Payment Protocol

**Dynamic Rate Limiting based on x402 configuration:**
- When `ENABLE_X_402=true`: 1 request per minute (free tier)
- When `ENABLE_X_402=false`: 3 requests per minute
- Paid tier: Bypass rate limit with x402 payment ($0.01 per screenshot)

**x402 Integration:**
- Uses `x402-express` middleware for payment verification
- Payment details in middleware config include full input/output schemas for AI agent discovery
- Rate limiter has `skip` function that bypasses limit when valid `X-PAYMENT` header present
- Middleware verifies payment through facilitator before allowing request

**Payment Flow:**
1. Request without payment → rate limited → 402 response with payment instructions
2. AI agent signs payment with crypto wallet (USDC on Base network)
3. Retry request with `X-PAYMENT` header containing proof
4. x402 middleware verifies payment via facilitator
5. Rate limiter skipped, request proceeds to screenshot capture

**Configuration:**
- `ENABLE_X_402`: Toggle payment protocol on/off
- `X_402_WALLET_ADDRESS`: Your wallet to receive payments
- `X_402_NETWORK`: Blockchain network (base, base-sepolia for testnet)
- `X_402_FACILITATOR_URL`: Payment verification service URL
- `X_402_PRICE`: Price per screenshot (e.g., "$0.01")

### Screenshot Process Flow
1. Validate request parameters
2. Validate hostname with DNS resolution
3. Launch headless Chrome with stealth mode
4. Set viewport and navigate
5. Wait additional time for lazy-loading/JS
6. **Validate final URL after redirects** - critical security step
7. Capture full-page PNG screenshot
8. Return base64-encoded data with metadata
9. Always close browser in finally block

### Configuration

Environment variables (`.env`):
- `PORT`: Server port (default: 3001)
- `ALLOWED_ORIGINS`: Comma-separated CORS origins (default: *)
- `NODE_ENV`: Environment mode

### API Documentation

OpenAPI 3.0 specification is in `openapi.yaml`. Swagger UI is available at `/api-docs`.

The Swagger UI middleware uses a custom redirect handler to ensure proper routing when behind an nginx reverse proxy (e.g., `/local/capture/api-docs`).

## Common Development Patterns

### Adding New Screenshot Options
When adding new parameters to the screenshot endpoint:
1. Add parameter to request body destructuring in the `/screenshot` handler
2. Add validation logic in the screenshot endpoint handler
3. Update OpenAPI schema in `openapi.yaml` under `/screenshot` requestBody
4. **Important:** Also update the x402 middleware `inputSchema` so AI agents can discover the new parameter
5. Pass parameter to Puppeteer's `page.screenshot()` or `page.goto()`

### Modifying x402 Configuration
To change payment settings:
1. Update environment variables in `.env`
2. Restart service (x402 config is loaded at startup)
3. To change price: modify `X_402_PRICE` (e.g., "$0.02")
4. To switch networks: change `X_402_NETWORK` ("base" for mainnet, "base-sepolia" for testnet)
5. Schema updates require editing the `paymentMiddleware` config in server.js

### Modifying Security Validation
SSRF protection happens in three places - all must be updated:
1. Initial validation in the `/screenshot` handler
2. DNS resolution check in `validateHostname()`
3. Post-redirect check after `page.goto()` completes

### Browser Launch Configuration
Puppeteer launch options are in `puppeteer.launch()`. The args array contains security flags required for Docker/sandboxed environments:
- `--no-sandbox`: Required for Docker
- `--disable-setuid-sandbox`: Required for non-root user
- `--disable-dev-shm-usage`: Prevents shared memory issues in containers

## Deployment Notes

### Production Deployment with ar.io Gateway
The service is designed to run on port 3001 behind an nginx reverse proxy. Example nginx configuration from README.md routes `/local/capture/*` to `http://127.0.0.1:3001/*`.

**Critical nginx settings:**
- Path stripping: `proxy_pass http://127.0.0.1:3001/;` (trailing slash strips prefix)
- Timeouts: 120s for screenshot processing
- **Do not add CORS headers in nginx** - handled by Express via ALLOWED_ORIGINS

### Docker vs Manual Deployment
- **Docker**: Chrome is automatically installed during build. Uses multi-stage build with non-root user for security.
- **Manual**: Must run `npx puppeteer browsers install chrome` before starting service
- **Resource Requirements**: Minimum 512MB RAM, recommended 2GB+ for Chrome

### Process Management
Use PM2 or systemd for production:
```bash
pm2 start server.js --name turbo-capture
pm2 save
pm2 startup
```

## Testing the Service

### Health Check
```bash
curl http://localhost:3001/health
```

### Screenshot Capture
```bash
curl -X POST http://localhost:3001/screenshot \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "waitFor": 5000}'
```

### Testing SSRF Protection
The service blocks these URL patterns:
- `http://localhost:3001` (localhost)
- `http://127.0.0.1:3001` (loopback)
- `http://192.168.1.1` (private IP)
- `http://169.254.169.254/latest/meta-data/` (cloud metadata)
- Domains that resolve to private IPs (DNS rebinding)
- Redirects to private IPs (redirect-based SSRF)
