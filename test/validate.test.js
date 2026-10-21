import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBody, ValidationError, precheckUrl } from '../src/validate.js';
import { fakeNet } from './helpers/net.js';

test('accepts a minimal body with defaults', () => {
  assert.deepEqual(validateBody({ url: 'https://example.com' }), {
    url: 'https://example.com/',
    waitFor: 10_000,
    viewportWidth: 1280,
    viewportHeight: 800,
    fullPage: true,
  });
  assert.equal(validateBody({ url: 'http://example.com', fullPage: false, waitFor: 0, quality: 50 }).fullPage, false);
});

const BAD = [
  [null, 'null body'],
  [[], 'array body'],
  ['https://example.com', 'string body'],
  [{}, 'missing url'],
  [{ url: '' }, 'empty url'],
  [{ url: 42 }, 'numeric url'],
  [{ url: ['https://example.com'] }, 'array url'],
  [{ url: 'https://example.com/' + 'a'.repeat(2100) }, 'oversized url'],
  [{ url: 'not a url' }, 'unparseable url'],
  [{ url: 'file:///etc/passwd' }, 'file scheme'],
  [{ url: 'chrome://settings' }, 'chrome scheme'],
  [{ url: 'data:text/html,<h1>x</h1>' }, 'data scheme'],
  [{ url: 'javascript:alert(1)' }, 'javascript scheme'],
  [{ url: 'ftp://example.com/' }, 'ftp scheme'],
  [{ url: 'view-source:https://example.com' }, 'view-source'],
  [{ url: 'https://user:pass@example.com/' }, 'credentials'],
  [{ url: 'https://example.com', waitFor: '5000' }, 'string waitFor'],
  [{ url: 'https://example.com', waitFor: 1.5 }, 'fractional waitFor'],
  [{ url: 'https://example.com', waitFor: -1 }, 'negative waitFor'],
  [{ url: 'https://example.com', waitFor: 30_001 }, 'waitFor too big'],
  [{ url: 'https://example.com', waitFor: null }, 'null waitFor'],
  [{ url: 'https://example.com', viewportWidth: 319 }, 'width too small'],
  [{ url: 'https://example.com', viewportWidth: 99_999 }, 'width too big'],
  [{ url: 'https://example.com', viewportHeight: 2161 }, 'height too big'],
  [{ url: 'https://example.com', viewportHeight: 1e308 }, 'huge height'],
  [{ url: 'https://example.com', fullPage: 'true' }, 'string fullPage'],
  [{ url: 'https://example.com', fullPage: 1 }, 'numeric fullPage'],
  [{ url: 'https://example.com', quality: 101 }, 'quality too big'],
  [{ url: 'https://example.com', proxy: 'x' }, 'unknown field'],
  [{ url: 'https://example.com', __proto__x: 1 }, 'unknown field 2'],
];
for (const [body, name] of BAD) {
  test(`rejects: ${name}`, () => assert.throws(() => validateBody(body), ValidationError));
}

test('precheck: refuses private, loopback, metadata, *.localhost, odd ports; allows public', async () => {
  const n = fakeNet({});
  const opts = { lookup: n.lookup, allowedPorts: new Set([80, 443]), extraDeny: [] };
  for (const u of [
    'http://127.0.0.1/',
    'http://0x7f.1/',
    'http://2130706433/',
    'http://[::1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/',
    'http://app.localhost/',
    'http://private.public.test/',
    'http://mixed.public.test/',
    'http://site.public.test:22/',
    'http://[fd00:ec2::254]/',
    'http://100.100.100.200/',
  ]) {
    assert.notEqual(await precheckUrl(u, opts), null, u);
  }
  assert.equal(await precheckUrl('https://site.public.test/', opts), null);
  assert.match(await precheckUrl('https://nxdomain.invalid/', opts), /resolved/);
});
