# Turbo Capture Service

Screenshot API: `POST /screenshot` with a URL, get back a base64 PNG rendered by
headless Chrome (puppeteer with the stealth plugin). Built to be exposed publicly:
every byte Chrome sends goes through an egress proxy that only talks to public
addresses, each capture is bounded in time, size and concurrency, and optional
[x402](https://github.com/coinbase/x402) payments lift the free-tier rate limit.

- API docs: `GET /api-docs` (OpenAPI in `openapi.yaml`)
- Health: `GET /health`

## Quick start (Docker, recommended)

```bash
cp .env.example .env        # edit it; docker compose reads it via env_file
docker compose up -d --build
curl -s localhost:3001/health
curl -s -X POST localhost:3001/screenshot \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","waitFor":2000}' | jq -r .screenshot | base64 -d > shot.png
```

The compose file binds to `127.0.0.1:3001` (set `BIND_ADDRESS` / `HOST_PORT` to
change), runs the container read-only with all capabilities dropped,
`no-new-privileges`, a PID limit, and the seccomp profile that lets Chrome keep its
sandbox (see below).

Running without Docker needs Node >= 22.12: `npm ci`, then `npm start`
(puppeteer downloads Chrome on install). The container is the supported setup.

## API

`POST /screenshot` (JSON, at most 10 kB):

| Field | Type | Default | Range |
|---|---|---|---|
| `url` | string, http/https only, no credentials | required | ≤ 2048 chars |
| `waitFor` | integer ms after load | 10000 | 0–30000 |
| `viewportWidth` | integer px | 1280 | 320–3840 |
| `viewportHeight` | integer px | 800 | 240–2160 |
| `fullPage` | boolean | true | |
| `quality` | integer (ignored, PNG only) | | 1–100 |

Types are strict (`"5000"` is not an integer, `"true"` is not a boolean) and
unknown fields are rejected.

Response: `screenshot` (base64 PNG), `finalUrl`, `title`, `size`, `capturedAt`,
`viewport`, `height` (PNG height), `clipped` (page was taller than
`MAX_SCREENSHOT_HEIGHT`), `requestId`.

| Status | Meaning |
|---|---|
| 400 | Invalid input, or the URL / a redirect targets a forbidden destination |
| 402 | Payment required (x402 enabled, free tier used up, or payment invalid) |
| 413 / 415 | Body too large / not `application/json` |
| 429 | Free-tier rate limit (x402 disabled); `Retry-After` |
| 502 | Page could not be loaded (DNS, connect, TLS) |
| 503 | All capture slots and the queue are full; `Retry-After` |
| 504 | Capture exceeded `CAPTURE_TIMEOUT_MS` |
| 500 | Internal error |

Every response carries `X-Request-Id`; error bodies are
`{error, message, requestId}` with generic messages. Details (URL, cause, egress
refusals) are logged server-side as JSON lines under the same id.

## Configuration

All settings are environment variables, validated at start-up (an invalid value
stops the service). See `.env.example` for the annotated list.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 3001 | Listen port |
| `ALLOWED_ORIGINS` | any | CORS origins, comma-separated |
| `TRUST_PROXY` | false | Reverse-proxy hops to trust for the client IP (see below) |
| `RATE_LIMIT_PER_MINUTE` | 3 (1 with x402) | Free-tier requests per client IP per minute |
| `MAX_CONCURRENT_CAPTURES` | 2 | Captures running at once (each is a full Chrome) |
| `MAX_QUEUE` | 4 | Requests waiting for a slot; beyond that, 503 |
| `QUEUE_TIMEOUT_MS` | 30000 | Max wait in the queue before 503 |
| `CAPTURE_TIMEOUT_MS` | 60000 | Hard deadline per capture (launch → screenshot) |
| `NAVIGATION_TIMEOUT_MS` | 30000 | Navigation bound (also capped by the deadline) |
| `MAX_SCREENSHOT_HEIGHT` | 16384 | Full-page screenshots are clipped to this height |
| `SCROLL_MAX_STEPS` / `SCROLL_MAX_MS` | 40 / 10000 | Lazy-load scroll budget |
| `MAX_EGRESS_BYTES` | 200 MiB | Download budget per capture |
| `ALLOWED_PORTS` | 80,443,8080,8443 | Destination ports Chrome may use (`*` = any) |
| `BLOCKED_CIDRS` | none | Extra ranges to refuse (your own public IPs, LBs, NAT) |
| `CHROME_SANDBOX` | true | Keep Chrome's sandbox; see "Chrome sandbox" |
| `ENABLE_X_402` | false | x402 payments |
| `X_402_WALLET_ADDRESS` | none | Required when x402 is on; start-up fails without it |
| `X_402_NETWORK` | base | `base`, `base-sepolia` or `eip155:<chainId>` |
| `X_402_FACILITATOR_URL` | https://facilitator.x402.rs | Must be https |
| `X_402_PRICE` | $0.01 | Price per capture |

### Running behind a reverse proxy: `TRUST_PROXY`

By default `X-Forwarded-For` is ignored and the rate limit keys on the TCP peer.
Behind nginx or a load balancer that peer is the proxy, so every client shares one
bucket. Set `TRUST_PROXY` to the number of proxy hops you control: `1` for a single
nginx or AWS ALB, `2` for CloudFront → ALB. You can instead list the proxy
addresses/CIDRs (`TRUST_PROXY=10.0.0.0/8`). `true` is refused because it would let
any client choose its own IP.

## Security model

### Egress containment

Chrome is launched with `--proxy-server=http://127.0.0.1:<port>` and
`--proxy-bypass-list=<-loopback>`, so all of its traffic (the page, redirects,
images, iframes, fetch/XHR, WebSockets, beacons, WebRTC TURN) goes through an
in-process forward proxy (`src/egress-proxy.js`, HTTP + CONNECT). For each
request the proxy:

1. requires a random per-capture secret (`Proxy-Authorization`), supplied to Chrome
   through CDP; the proxy listens on 127.0.0.1 only and is closed after the capture;
2. refuses `localhost`, `*.localhost`, `*.local`, `*.internal`, and ports outside
   `ALLOWED_PORTS`;
3. resolves the host once (all A and AAAA records) and refuses the request if any
   address is not public unicast (`src/address.js`: ipaddr.js `range()` plus explicit
   lists: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, TEST-NETs,
   192.88.99/24, 192.168/16, 198.18/15, 224/4, 240/4, Azure 168.63.129.16; for IPv6
   only 2000::/3 minus documentation, Teredo/6to4 and other special ranges, with
   IPv4-mapped, IPv4-compatible and NAT64 `64:ff9b::/96` addresses judged by their
   embedded IPv4);
4. connects to the validated IP, never re-resolving (no DNS-rebinding window).

Other Chrome flags back this up: QUIC off, WebRTC limited to proxied TCP,
`--host-resolver-rules=MAP * ~NOTFOUND` (Chrome cannot resolve names itself), DNS
prefetch and background networking off, service workers bypassed, downloads denied.
Hex, octal and integer IPv4 forms (`0x7f.1`, `2130706433`) are normalised by the URL
parser before classification.

The top-level URL also gets a fast pre-check with the same rules, for an immediate
`400`. A redirect, or a JavaScript navigation, to a refused destination fails the
capture deterministically with `400 Forbidden URL`.

The port allow-list (80, 443, 8080, 8443) keeps the service from being used as a
port scanner or to talk to non-web services on public hosts. Widen it with
`ALLOWED_PORTS` if you must.

**Defence in depth: restrict egress at the network layer too.** The proxy is the
enforcement point, but deploy so that a bug in it is not fatal:

- Run in a subnet / security group whose egress allows only TCP 80/443 to the
  internet (via NAT) and nothing to the VPC CIDR, peered networks or on-prem ranges.
- Block the instance metadata service from the container: on EC2 require IMDSv2
  with hop limit 1, and on ECS-on-EC2 with `awsvpc` set `ECS_AWSVPC_BLOCK_IMDS=true`.
  Fargate has no IMDS; its task metadata endpoint (169.254.170.2) is link-local and
  refused by the proxy. On Kubernetes use a NetworkPolicy denying
  `169.254.0.0/16` and the cluster/VPC CIDRs.
- Give the task role no permissions beyond what the service needs (none).
- Add your NAT gateway / load balancer public IPs and any public-IP internal
  services to `BLOCKED_CIDRS`.

### Chrome sandbox

Chrome keeps its sandbox (no `--no-sandbox`). Its namespace sandbox needs to create
an unprivileged user namespace and chroot its renderers, which Docker's default
seccomp profile only allows for containers with `CAP_SYS_ADMIN`.
`seccomp/chrome.json` is Docker's default profile plus one rule allowing `clone`,
`unshare`, `setns` and `chroot`, so the container still runs with **no
capabilities** (`cap_drop: ALL`) and `no-new-privileges`. Regenerate it with
`node scripts/make-seccomp.mjs <moby default.json> > seccomp/chrome.json`.

At start-up the service launches Chrome once; if the sandbox cannot start it exits
with an explanation. Where a custom seccomp profile cannot be applied (e.g. AWS
Fargate), or the host forbids unprivileged user namespaces, set
`CHROME_SANDBOX=false` as a last resort and rely on the container boundary:
read-only root, `cap_drop: ALL`, `no-new-privileges`, PID and memory limits, a
fresh Chrome profile per capture, and the network-level egress restrictions above.

### Bounded work

- `MAX_CONCURRENT_CAPTURES` captures run at once; `MAX_QUEUE` more may wait up to
  `QUEUE_TIMEOUT_MS`; otherwise `503` + `Retry-After`. Paid requests count too.
- One deadline (`CAPTURE_TIMEOUT_MS`) covers launch, navigation, `waitFor`, the
  scroll pass and the screenshot. On expiry Chrome's process group is killed.
- The scroll pass is bounded by steps and time, so infinite-scroll pages finish.
- Full-page screenshots are clipped to `MAX_SCREENSHOT_HEIGHT`.
- If the client disconnects, the capture is aborted and Chrome killed.
- Chrome runs under `tini`; a reaper kills any Chrome process that outlives its
  browser.

## x402 payments

With `ENABLE_X_402=true` (and a valid `X_402_WALLET_ADDRESS`, or the service refuses
to start), clients within the free tier are served as usual. Over the free tier
they receive `402 Payment Required` with the x402 v2 `PAYMENT-REQUIRED` header, and
may retry with a `PAYMENT-SIGNATURE` header produced by an x402 v2 client (e.g.
`@x402/fetch`). A request carrying a payment header skips the free-tier limiter but
goes straight to payment verification: garbage or invalid payments get `402` and no
capture runs. Payment is settled only after a successful capture; a capture that
fails, times out or is refused for capacity (`503`) is not charged.

The service uses the x402 v2 packages (`@x402/express`, `@x402/core`, `@x402/evm`).
x402 v1 `X-PAYMENT` headers are no longer accepted. Make sure the facilitator you
configure supports x402 v2 and your network.

## Deployment

- **Behind nginx** on the same host: `proxy_pass http://127.0.0.1:3001/;`, timeouts
  of at least `CAPTURE_TIMEOUT_MS + QUEUE_TIMEOUT_MS` (default 90 s; use 120 s),
  `TRUST_PROXY=1`, and do not add CORS headers in nginx.
- **Cloud (ECS / Kubernetes)**: build the `production` target, 2 GB memory per two
  concurrent captures, read-only root filesystem with a writable `/tmp`, drop all
  capabilities, apply `seccomp/chrome.json` where the platform allows it
  (Kubernetes: `seccompProfile: Localhost`), set `TRUST_PROXY` to the number of load
  balancer hops, and restrict egress as described above.

## Development and tests

All tooling runs in containers:

```bash
# unit + integration tests (real Chrome, local fixtures only, no network)
docker build --target test -t turbo-capture:test .
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --security-opt seccomp=$PWD/seccomp/chrome.json --read-only --tmpfs /tmp \
  turbo-capture:test

# smoke test against https://example.com (needs outbound HTTPS)
docker run --rm --cap-drop ALL --security-opt seccomp=$PWD/seccomp/chrome.json \
  --read-only --tmpfs /tmp -e SMOKE=1 turbo-capture:test node --test test/smoke.test.js
```

Integration tests resolve fake `*.public.test` names to addresses classed as public
and route them to a fixture server on 127.0.0.1 through resolver/dialer hooks that
exist only as `createApp()` arguments; `server.js` never passes them, and no
environment variable or request field can enable them.

## License

AGPL-3.0
