# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Turbo Capture Service: a public screenshot API. `POST /screenshot` loads a URL in
a fresh headless Chrome (puppeteer 25 + `puppeteer-extra-plugin-stealth`) and
returns a base64 PNG. Optional x402 v2 payments lift the free-tier rate limit.
It is exposed to the internet, so egress containment and bounded work are the
load-bearing parts of the design.

## Commands

Run Node/npm/Chrome only inside containers (Node >= 22.12; host Node may be old):

```bash
# full test suite in the built image (real Chrome, local fixtures, no network).
# --dns/--sysctl let test/dns-starvation.test.js run a fake nameserver on
# 127.0.0.1:53 inside the container (it skips without them).
docker build --target test -t turbo-capture:test .
docker run --rm --network none --dns 127.0.0.1 --sysctl net.ipv4.ip_unprivileged_port_start=0 \
  --cap-drop ALL --security-opt no-new-privileges \
  --security-opt seccomp=$PWD/seccomp/chrome.json --read-only --tmpfs /tmp turbo-capture:test
# one file / one test; TEST_DEBUG=1 prints service logs
docker run ... turbo-capture:test node --test --test-name-pattern='redirect' test/integration.test.js
# smoke test against https://example.com only (needs network)
docker run ... -e SMOKE=1 turbo-capture:test node --test test/smoke.test.js
# unit tests without Chrome (integration tests skip themselves)
docker run --rm -u $(id -u) -v $PWD:/w -w /w node:22-bookworm-slim npm test
# regenerate the lockfile
docker run --rm -u $(id -u) -e HOME=/tmp -e PUPPETEER_SKIP_DOWNLOAD=true -v $PWD:/w -w /w node:22-bookworm npm install
docker compose up -d --build   # reads .env (cp .env.example .env)
```

## Layout

- `server.js` – production entry: `loadConfig()`, Chrome self-test, `createApp()`,
  listen, orphan-Chrome reaper, signal handling.
- `src/config.js` – every env var, parsed and range-checked; invalid → exit 1.
  x402 enabled without a valid wallet or facilitator URL is fatal (no defaults).
- `src/app.js` – Express app: request ids, helmet, CORS, rate limit / x402 gate,
  validation, pre-check, concurrency gate, error mapping, swagger, health.
- `src/validate.js` – strict body schema and the fast top-level URL pre-check.
- `src/concurrency.js` – `CaptureGate`: N slots + bounded FIFO queue + timeout.
- `src/capture.js` – one capture: per-capture proxy + temp profile, Chrome flags,
  deadline (`step()` races every await against an abort), bounded scroll, clipped
  screenshot, teardown (kill process group), `reapOrphanChrome()`.
- `src/egress-proxy.js` – HTTP + CONNECT forward proxy; the enforcement point.
- `src/resolver.js` – bounded c-ares resolver (A+AAAA, hard timeout, concurrency
  cap + bounded queue, `cancel()`); one per proxy and one per pre-check. Never
  go back to `dns.lookup`/getaddrinfo: it runs on the 4-thread libuv pool and a
  silent nameserver stalls the whole service. DNS only (no /etc/hosts).
- `src/address.js` – public-address classification (`isPublicAddress`) and
  forbidden host names.
- `seccomp/chrome.json` – Docker default profile + clone/unshare/setns/chroot so
  Chrome's sandbox works with `cap_drop: ALL` (`scripts/make-seccomp.mjs`).

## Security architecture (do not weaken)

- **All Chrome traffic goes through the egress proxy.** Flags in `chromeArgs()`:
  `--proxy-server`, `--proxy-bypass-list=<-loopback>` (loopback is NOT bypassed),
  `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1`, QUIC off, WebRTC
  `disable_non_proxied_udp`, DNS prefetch / background networking off. Do not add
  flags that bypass the proxy.
- The proxy resolves once (all A/AAAA), refuses if ANY address is non-public,
  then dials the validated IP. Never add a second lookup between check and
  connect. Port allow-list defaults to 80/443/8080/8443.
- Each capture gets its own proxy on 127.0.0.1 with a random secret
  (Proxy-Authorization via `page.authenticate`), closed with the capture.
- Forbidden redirects are detected from the proxy's `blocked` set against
  main-frame navigation URLs → `FORBIDDEN_DESTINATION` → 400.
- Test hooks (`deps.net.lookup` / `deps.net.dial`, `deps.capture`) are
  `createApp()` arguments only. Never read them from env or request input.
- Client errors are generic `{error, message, requestId}`; details go to the
  JSON-lines log under the request id.

## Rate limiting and x402

- `TRUST_PROXY` (default false; hop count or CIDR list; `true` refused) sets
  express `trust proxy` so the limiter keys on the real client IP.
- Payment header present (`PAYMENT-SIGNATURE` or legacy `X-PAYMENT`) → x402
  middleware (verify, settle only on success). Otherwise the free-tier limiter;
  when exhausted, its handler answers with the x402 402 (or 429 if x402 is off).
  Garbage headers therefore get 402 and never reach the capture.
- Paid requests still go through `CaptureGate` (503 when full; not settled), a
  per-IP paid limiter (`PAID_RATE_LIMIT_PER_MINUTE`), and an in-flight set that
  refuses a payment payload already being served (409).
- `app.locals.paymentInFlight` counts x402 middleware runs until they finish;
  every exit path must end the response (aborted clients get `499` via
  `endGone()`), or @x402/express waits forever.
- Screenshot size: `MAX_SCREENSHOT_HEIGHT`, pixel budget `MAX_SCREENSHOT_PIXELS`,
  `MAX_PNG_BYTES` (422). The PNG stays base64 from CDP to the response body.

## Adding a screenshot option

1. `src/validate.js`: add to `KNOWN`/`LIMITS`, validate strictly.
2. `src/capture.js`: use it.
3. `openapi.yaml` request schema, and `screenshotSchemas()` in `src/app.js`
   (x402 bazaar discovery).
4. Tests in `test/validate.test.js` (and integration if behaviour changes).

## Tests

`node:test`, files `test/*.test.js`; helpers in `test/helpers/`. Integration
tests start a fixture server and a "trap" server on 127.0.0.1, resolve fake
`*.public.test` names to public-classified IPs and dial them to the fixture;
the trap must see zero connections. Never point tests at real private hosts or
the metadata address; the only public target is https://example.com (smoke).

## Deployment notes

- Compose: read-only root, `/tmp` tmpfs (Chrome HOME/profile live in a per-capture
  temp dir there), `cap_drop: ALL`, `no-new-privileges`, seccomp profile,
  `pids_limit`, binds 127.0.0.1:3001 by default, `env_file: .env`.
- `CHROME_SANDBOX=false` only where a custom seccomp profile is impossible.
- Defence in depth: restrict egress at the network layer (only 80/443 out, no
  VPC/metadata routes) — see README "Egress containment".
- nginx in front: `proxy_pass http://127.0.0.1:3001/;`, 120 s timeouts,
  `TRUST_PROXY=1`, no CORS headers in nginx.
