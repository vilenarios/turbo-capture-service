import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublicAddress, isForbiddenHostname, normalizeHost, parseCidrList } from '../src/address.js';

const NON_PUBLIC = [
  // IPv4 special ranges
  '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.100.100.200', '100.127.255.255',
  '127.0.0.1', '127.1.2.3', '127.255.255.254', '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255',
  '192.0.0.1', '192.0.0.192', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.255.255',
  '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '168.63.129.16',
  // IPv6 special ranges
  '::', '::1', 'fc00::1', 'fd00::1', 'fd12:3456::1', 'fdff:ffff::1', 'fd00:ec2::254', 'fe80::1', 'febf::1',
  'fec0::1', 'ff02::1', 'ff0e::1', '100::1', '2001:db8::1', '3fff::1', '2001::1', '2001:0:4136:e378::1', '2002:c0a8:101::1',
  '2002:808:808::1', '64:ff9b:1::a00:1', '5f00::1',
  // IPv4-mapped / IPv4-compatible IPv6 of private addresses
  '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:0:0',
  '::127.0.0.1', '::7f00:1', '::a00:1', '::808:808',
  // NAT64 wrapping a non-public IPv4
  '64:ff9b::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::c0a8:101',
  // garbage / non-canonical forms must never be treated as public
  '', 'localhost', 'example.com', '0x7f.1', '2130706433', '0177.0.0.1', '1.2.3', '256.1.1.1', 'fe80::1%eth0', '[::1]',
];

const PUBLIC = [
  '8.8.8.8', '1.1.1.1', '93.184.215.14', '11.22.33.44', '100.63.255.255', '100.128.0.1', '172.15.255.255',
  '172.32.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.254',
  '2606:4700:4700::1111', '2001:4860:4860::8888', '2a00:1450:4001:80b::200e',
  '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', '64:ff9b::808:808',
];

for (const ip of NON_PUBLIC) {
  test(`non-public: ${ip || '(empty)'}`, () => assert.equal(isPublicAddress(ip), false));
}
for (const ip of PUBLIC) {
  test(`public: ${ip}`, () => assert.equal(isPublicAddress(ip), true));
}

test('extra deny list from BLOCKED_CIDRS', () => {
  const extraDeny = parseCidrList(['8.8.8.0/24', '2606:4700::/32', '1.1.1.1']);
  assert.equal(isPublicAddress('8.8.8.8', { extraDeny }), false);
  assert.equal(isPublicAddress('::ffff:8.8.8.8', { extraDeny }), false);
  assert.equal(isPublicAddress('64:ff9b::8.8.8.8', { extraDeny }), false);
  assert.equal(isPublicAddress('2606:4700:4700::1111', { extraDeny }), false);
  assert.equal(isPublicAddress('1.1.1.1', { extraDeny }), false);
  assert.equal(isPublicAddress('8.8.4.4', { extraDeny }), true);
  assert.throws(() => parseCidrList(['not-a-cidr']));
});

test('URL parser normalises numeric/hex/octal IPv4 forms to a classifiable address', () => {
  const cases = {
    'http://0x7f.1/': '127.0.0.1',
    'http://0x7f000001/': '127.0.0.1',
    'http://2130706433/': '127.0.0.1',
    'http://0177.0.0.1/': '127.0.0.1',
    'http://017700000001/': '127.0.0.1',
    'http://127.1/': '127.0.0.1',
    'http://0/': '0.0.0.0',
    'http://0xa9.0xfe.0xa9.0xfe/': '169.254.169.254',
    'http://[::ffff:127.0.0.1]/': '::ffff:7f00:1',
    'http://[0:0:0:0:0:0:0:1]/': '::1',
    'http://[64:ff9b::10.0.0.1]/': '64:ff9b::a00:1',
  };
  for (const [url, expected] of Object.entries(cases)) {
    const { host, isIp } = normalizeHost(new URL(url).hostname);
    assert.equal(isIp, true, url);
    assert.equal(host, expected, url);
    assert.equal(isPublicAddress(host), false, url);
  }
});

test('forbidden host names (*.localhost etc.)', () => {
  for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'foo.localhost', 'a.b.localhost', 'x.localhost.', 'metadata.google.internal', 'printer.local', 'localhost.localdomain', '']) {
    assert.equal(isForbiddenHostname(h), true, h);
  }
  for (const h of ['example.com', 'localhost.example.com', 'notlocalhost', 'internal.example.org']) {
    assert.equal(isForbiddenHostname(h), false, h);
  }
});
