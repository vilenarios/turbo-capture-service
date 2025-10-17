# Permaweb Capture - Backend

Screenshot capture service using Puppeteer with stealth mode for bot detection evasion.

## Features

- Full-page screenshot capture
- Headless Chrome with anti-detection (puppeteer-extra-stealth)
- Configurable viewport sizes
- Returns base64-encoded PNG screenshots
- CORS-enabled for frontend integration
- **Rate limiting** (3 requests/minute per IP)
- **Input validation & SSRF protection**
- **Security headers** (Helmet.js)

## Prerequisites

- Node.js 18+ (for ES modules support)
- Chrome/Chromium (installed automatically by Puppeteer)

## Installation

```bash
npm install
```

## Configuration

### Environment Variables

Create a `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

Edit `.env` with your settings:

```env
PORT=3001
ALLOWED_ORIGINS=http://localhost:5175,https://yourdomain.com
NODE_ENV=production
```

**⚠️ IMPORTANT:**
- Set specific ALLOWED_ORIGINS (don't use `*` in production)
- Keep your `.env` file secret (it's in `.gitignore`)

## Usage

### Start the server

```bash
npm start
```

Or with auto-reload during development:

```bash
npm run dev
```

The server will run on `http://localhost:3001`

### API Endpoints

#### Health Check
```
GET /health
```

Response:
```json
{
  "status": "ok",
  "service": "puppeteer-screenshot"
}
```

#### Screenshot Capture
```
POST /screenshot
```

Request headers:
```
Content-Type: application/json
```

Request body:
```json
{
  "url": "https://example.com",
  "waitFor": 5000,
  "viewportWidth": 1280,
  "viewportHeight": 800,
  "fullPage": true,
  "quality": 90
}
```

Response:
```json
{
  "screenshot": "base64-encoded-png-data",
  "finalUrl": "https://example.com",
  "title": "Page Title",
  "size": 123456,
  "capturedAt": "2025-10-16T...",
  "viewport": { "width": 1280, "height": 800 }
}
```

**Example with curl:**
```bash
curl -X POST http://localhost:3001/screenshot \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

**Rate Limit:** 3 requests per minute per IP address

## Environment Variables

- `PORT` - Server port (default: 3001)

## Security Features

### 1. Rate Limiting
- **3 requests per minute per IP address**
- Prevents abuse and resource exhaustion
- Primary defense against malicious use
- Configurable in `server.js` (line 35-44)

### 2. Input Validation
- URL format validation
- Protocol whitelist (HTTP/HTTPS only)
- **SSRF protection** (blocks localhost, private IPs: 192.168.x.x, 10.x.x.x, 172.x.x.x)
- Viewport dimension limits (320x240 to 3840x2160)
- Wait time limits (0-30000ms)

### 3. Security Headers (Helmet.js)
- X-Content-Type-Options: nosniff
- X-Frame-Options: DENY
- X-XSS-Protection: 1; mode=block
- Strict-Transport-Security
- And more...

### 4. CORS Configuration
- Configurable allowed origins via `ALLOWED_ORIGINS` env var
- Prevents unauthorized cross-origin requests
- Set to specific domains in production

## Technical Details

### Anti-Detection

This server uses `puppeteer-extra-stealth` to evade bot detection on sites like Twitter, Instagram, etc. The stealth plugin:

- Hides the `navigator.webdriver` property
- Mocks the Chrome object and APIs
- Spoofs permissions API
- Prevents browser fingerprinting
- And many more techniques

### Screenshot Process

1. **Validate** request (API key, rate limit, input)
2. Launch headless Chrome with stealth mode
3. Navigate to target URL
4. Wait for network idle (JavaScript execution complete)
5. Wait additional time for lazy-loading content
6. Capture full-page PNG screenshot
7. Return base64-encoded data

## Docker Deployment

### Build and run with Docker Compose (recommended)

```bash
docker-compose up -d
```

The service will be available at `http://localhost:3001`

### Build Docker image manually

```bash
docker build -t permaweb-capture-backend .
```

### Run Docker container

```bash
docker run -d \
  --name permaweb-capture-backend \
  -p 3001:3001 \
  --restart unless-stopped \
  permaweb-capture-backend
```

### Docker features

- ✅ Multi-stage build for smaller image size
- ✅ Runs as non-root user for security
- ✅ Health checks included
- ✅ Resource limits configurable
- ✅ All Chrome dependencies pre-installed

### Check container health

```bash
docker ps
# Look for "healthy" status

# Or check health endpoint directly
curl http://localhost:3001/health
```

### View logs

```bash
docker logs -f permaweb-capture-backend
```

### Stop container

```bash
docker-compose down
# or
docker stop permaweb-capture-backend
```

## Production Deployment

### Deploying on an ar.io Gateway

If you're running an ar.io gateway and want to host the capture service on the same server, you can use nginx to route requests to the backend.

#### 1. Install and Start Backend

```bash
# Clone the repository
git clone https://github.com/vilenarios/turbo-capture-service.git
cd turbo-capture-service

# Install dependencies
npm install

# Create .env file
cp .env.example .env
nano .env  # Edit with your settings

# Start the service (use PM2 or systemd for production)
npm start

# Or use PM2 for process management
npm install -g pm2
pm2 start server.js --name turbo-capture
pm2 save
pm2 startup  # Follow instructions to enable auto-start
```

#### 2. Configure Nginx

Add this location block to your nginx configuration **before** your existing `location /` block (order matters):

```nginx
# Permaweb Capture Backend Service
location /local/capture/ {
    # Route to backend on port 3001, stripping the /local/capture prefix
    proxy_pass http://127.0.0.1:3001/;

    # Preserve original request information
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    # Required for proper HTTP/1.1 support
    proxy_http_version 1.1;
    proxy_set_header Connection "";

    # Increase timeouts for screenshot processing (can take 30-90 seconds)
    proxy_connect_timeout 120s;
    proxy_send_timeout 120s;
    proxy_read_timeout 120s;

    # Handle CORS (backend already sends CORS headers, but we can reinforce)
    add_header Access-Control-Allow-Origin $http_origin always;
    add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Content-Type" always;

    # Handle preflight requests
    if ($request_method = 'OPTIONS') {
        return 204;
    }
}

# Your existing ar.io gateway routing
location / {
    proxy_pass http://127.0.0.1:3000;
    # ... rest of your existing config
}
```

#### 3. Test and Reload Nginx

```bash
# Test nginx configuration
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx

# Test health endpoint
curl https://yourdomain.com/local/capture/health
```

#### 4. Update Frontend Configuration

In your frontend code (`src/lib/capture/orchestrator.ts`), update the backend URLs:

```typescript
// Change from localhost to your domain
const healthCheck = await fetch('https://yourdomain.com/local/capture/health', {
  signal: AbortSignal.timeout(2000),
});

const screenshotResponse = await fetch('https://yourdomain.com/local/capture/screenshot', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url, waitFor: 5000 }),
});
```

#### How it works:

- `https://yourdomain.com/local/capture/screenshot` → Routes to `http://127.0.0.1:3001/screenshot`
- `https://yourdomain.com/local/capture/health` → Routes to `http://127.0.0.1:3001/health`
- `https://yourdomain.com/*` → Routes to your ar.io gateway on port 3000

The `/local/capture` prefix ensures no conflicts with ar.io gateway paths.

### Railway / Render / Heroku

1. Connect your git repository
2. Set `Dockerfile` as build method
3. Set port to `3001`
4. Deploy!

### AWS ECS / Cloud Run / Azure Container Apps

1. Build and push Docker image to registry
2. Deploy container with 2GB RAM minimum
3. Expose port 3001
4. Configure auto-scaling based on CPU/memory

### Important Notes

- Chrome requires significant RAM (minimum 512MB, recommend 2GB)
- Set appropriate resource limits to prevent memory issues
- Rate limiting is already configured at 3 requests/minute per IP
- Use PM2 or systemd for process management in production
- Monitor logs for errors: `pm2 logs turbo-capture` or `journalctl -u turbo-capture`

## Environment Variables

- `PORT` - Server port (default: 3001)
- `NODE_ENV` - Environment mode (development/production)

## License

MIT
