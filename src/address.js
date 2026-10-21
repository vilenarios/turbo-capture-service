/**
 * Address classification for outbound-request containment.
 *
 * The rule is an allow-list: an address is "public" only when it is global
 * unicast. Everything else (loopback, RFC 1918, link-local / cloud metadata,
 * CGNAT, benchmarking, documentation, multicast, reserved, unique-local IPv6,
 * deprecated IPv4-compatible IPv6, NAT64 / 6to4 wrapping a non-public IPv4,
 * Teredo, ...) is refused.
 */

import ipaddr from 'ipaddr.js';

/** IPv4 ranges refused in addition to everything ipaddr.js does not call "unicast". */
const IPV4_DENY = [
  '0.0.0.0/8', // "this network"
  '10.0.0.0/8',
  '100.64.0.0/10', // CGNAT (also Alibaba metadata 100.100.100.200)
  '127.0.0.0/8',
  '169.254.0.0/16', // link-local, cloud metadata
  '172.16.0.0/12',
  '192.0.0.0/24', // IETF protocol assignments (Oracle metadata 192.0.0.192)
  '192.0.2.0/24',
  '192.88.99.0/24', // 6to4 relay anycast
  '192.168.0.0/16',
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved + broadcast
  '168.63.129.16/32', // Azure WireServer (public-looking, platform-internal)
].map((c) => ipaddr.parseCIDR(c));

/** IPv6 is only ever allowed inside global unicast 2000::/3, minus these. */
const IPV6_GLOBAL = ipaddr.parseCIDR('2000::/3');
const IPV6_DENY = [
  '2001::/23', // IETF protocol assignments (incl. Teredo 2001::/32)
  '2001:db8::/32', // documentation
  '3fff::/20', // documentation
  '2002::/16', // 6to4 (embedded IPv4 is checked separately; refused here as a whole)
].map((c) => ipaddr.parseCIDR(c));

const NAT64_WKP = ipaddr.parseCIDR('64:ff9b::/96');

/**
 * @param {string[]} cidrs extra CIDRs to refuse (operator supplied)
 * @returns {Array<[ipaddr.IPv4|ipaddr.IPv6, number]>}
 */
export function parseCidrList(cidrs) {
  return cidrs.map((c) => {
    const trimmed = c.trim();
    try {
      return trimmed.includes('/')
        ? ipaddr.parseCIDR(trimmed)
        : (() => {
            const a = ipaddr.parse(trimmed);
            return [a, a.kind() === 'ipv4' ? 32 : 128];
          })();
    } catch {
      throw new Error(`Invalid CIDR in BLOCKED_CIDRS: "${trimmed}"`);
    }
  });
}

function inAny(addr, list) {
  return list.some(([net, bits]) => net.kind() === addr.kind() && addr.match(net, bits));
}

function v4FromLow32(v6) {
  const b = v6.toByteArray();
  return new ipaddr.IPv4(b.slice(12, 16));
}

function isPublicV4(v4, extraDeny) {
  if (v4.range() !== 'unicast') return false;
  if (inAny(v4, IPV4_DENY)) return false;
  if (inAny(v4, extraDeny)) return false;
  return true;
}

/**
 * Classify a literal IP address (no brackets). Returns false for anything
 * that does not parse as a canonical IPv4/IPv6 address.
 *
 * @param {string} ip
 * @param {{ extraDeny?: Array<[any, number]> }} [opts]
 * @returns {boolean}
 */
export function isPublicAddress(ip, opts = {}) {
  const extraDeny = opts.extraDeny ?? [];
  if (typeof ip !== 'string') return false;
  const s = ip.replace(/^\[|\]$/g, '');
  // ipaddr.isValid accepts legacy IPv4 forms (e.g. "0x7f.1"); only accept the
  // strict forms that getaddrinfo / the URL parser produce.
  let addr;
  if (ipaddr.IPv4.isValidFourPartDecimal(s)) {
    addr = ipaddr.IPv4.parse(s);
  } else if (s.includes(':') && ipaddr.IPv6.isValid(s)) {
    addr = ipaddr.IPv6.parse(s);
  } else {
    return false;
  }

  if (addr.kind() === 'ipv4') return isPublicV4(addr, extraDeny);

  // IPv6
  if (addr.zoneId) return false;
  if (addr.isIPv4MappedAddress()) return isPublicV4(addr.toIPv4Address(), extraDeny);
  if (addr.match(NAT64_WKP[0], NAT64_WKP[1])) {
    // Well-known NAT64 prefix: the real destination is the embedded IPv4.
    return isPublicV4(v4FromLow32(addr), extraDeny);
  }
  if (!addr.match(IPV6_GLOBAL[0], IPV6_GLOBAL[1])) return false; // ::, ::1, ::/96 compat, fc00::/7, fe80::/10, ff00::/8, 64:ff9b:1::/48 ...
  if (addr.range() !== 'unicast') return false;
  if (inAny(addr, IPV6_DENY)) return false;
  if (inAny(addr, extraDeny)) return false;
  return true;
}

/**
 * Host names refused by name before any DNS lookup. Chrome maps
 * "localhost" and every "*.localhost" to loopback internally, and some
 * resolvers do the same, so these never reach a lookup.
 *
 * @param {string} hostname lower-case, no trailing dot handling needed by caller
 */
export function isForbiddenHostname(hostname) {
  const h = hostname.toLowerCase().replace(/\.+$/, '');
  if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'localhost.localdomain' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  return false;
}

/**
 * Parse a URL host the way Chrome would (WHATWG URL parser normalises
 * hex/octal/dword IPv4 such as 0x7f.1, 0177.0.0.1 and 2130706433) and
 * report whether it is an IP literal.
 *
 * @param {string} hostname URL.hostname value
 * @returns {{ host: string, isIp: boolean }}
 */
export function normalizeHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  const isIp = ipaddr.IPv4.isValidFourPartDecimal(host) || (host.includes(':') && ipaddr.IPv6.isValid(host));
  return { host, isIp };
}
