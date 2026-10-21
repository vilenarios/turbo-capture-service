/**
 * A tiny fake DNS server for tests (UDP, 127.0.0.1 only).
 *
 * zones: { name: { A?: string[], AAAA?: string[], CNAME?: string, nx?: true, blackhole?: true } }
 * Names ending in a key that starts with "*." match as wildcards.
 * Unknown names answer NXDOMAIN. Blackholed names swallow the query.
 */

import dgram from 'node:dgram';

function encodeName(name) {
  const parts = name.replace(/\.$/, '').split('.');
  const bufs = parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'ascii')]));
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function readName(msg, off) {
  const labels = [];
  for (;;) {
    const len = msg[off];
    if (len === 0) return { name: labels.join('.'), end: off + 1 };
    labels.push(msg.subarray(off + 1, off + 1 + len).toString('ascii'));
    off += 1 + len;
  }
}

function rr(name, type, data) {
  const h = Buffer.alloc(10);
  h.writeUInt16BE(type, 0);
  h.writeUInt16BE(1, 2); // IN
  h.writeUInt32BE(30, 4); // TTL
  h.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(name), h, data]);
}

function v4(ip) {
  return Buffer.from(ip.split('.').map(Number));
}

function v6(ip) {
  // expand ::
  const [l, r] = ip.split('::');
  const left = l ? l.split(':') : [];
  const right = r !== undefined && r !== '' ? r.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const b = Buffer.alloc(16);
  groups.forEach((g, i) => b.writeUInt16BE(parseInt(g, 16), i * 2));
  return b;
}

function lookupZone(zones, name) {
  const n = name.toLowerCase();
  if (zones[n]) return zones[n];
  for (const [k, v] of Object.entries(zones)) {
    if (k.startsWith('*.') && n.endsWith(k.slice(1))) return v;
  }
  return null;
}

export async function startFakeDns(zones, { port = 0 } = {}) {
  const queries = [];
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    let q;
    try {
      q = readName(msg, 12);
    } catch {
      return;
    }
    const qtype = msg.readUInt16BE(q.end);
    queries.push({ name: q.name, qtype });
    const zone = lookupZone(zones, q.name);
    if (zone?.blackhole) return; // never answer
    const answers = [];
    let rcode = 0;
    if (!zone || zone.nx) {
      rcode = 3;
    } else {
      let target = q.name;
      let z = zone;
      if (z.CNAME) {
        const t = Buffer.from(encodeName(z.CNAME));
        answers.push(rr(q.name, 5, t));
        target = z.CNAME;
        z = lookupZone(zones, z.CNAME) ?? {};
      }
      if (qtype === 1) for (const a of z.A ?? []) answers.push(rr(target, 1, v4(a)));
      if (qtype === 28) for (const a of z.AAAA ?? []) answers.push(rr(target, 28, v6(a)));
    }
    const header = Buffer.alloc(12);
    msg.copy(header, 0, 0, 2); // id
    header.writeUInt16BE(0x8180 | rcode, 2); // QR, RD, RA, rcode
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(answers.length, 6);
    sock.send(Buffer.concat([header, msg.subarray(12, q.end + 4), ...answers]), rinfo.port, rinfo.address);
  });
  await new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, '127.0.0.1', resolve);
  });
  return {
    port: sock.address().port,
    server: `127.0.0.1:${sock.address().port}`,
    queries,
    close: () => new Promise((r) => sock.close(r)),
  };
}
