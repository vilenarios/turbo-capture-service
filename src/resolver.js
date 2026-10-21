/**
 * Bounded DNS resolver.
 *
 * Uses a c-ares Resolver (DNS over the event loop, not getaddrinfo on the
 * libuv threadpool), so a nameserver that never answers cannot starve other
 * lookups or file-system work. Each lookup:
 *   - queries A and AAAA in parallel (CNAME chains are followed by c-ares),
 *   - is bounded by a hard timeout,
 *   - runs under a per-resolver concurrency cap with a bounded queue.
 * cancel() aborts every pending and queued lookup and refuses new ones.
 *
 * DNS only: /etc/hosts is not consulted. Names such as localhost are refused
 * by name before any lookup (see address.js).
 */

import dns from 'node:dns';

const NO_RECORDS = new Set(['ENODATA', 'ENOTFOUND']);

function dnsError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.servers] nameservers; default: the system's (resolv.conf)
 * @param {number} [opts.timeoutMs] hard bound for one lookup (both families)
 * @param {number} [opts.tries] c-ares attempts per query
 * @param {number} [opts.maxConcurrent] lookups in flight at once
 * @param {number} [opts.maxQueue] lookups waiting; beyond this EBUSY
 */
export function createBoundedResolver(opts = {}) {
  const { servers, timeoutMs = 5_000, tries = 2, maxConcurrent = 6, maxQueue = 64 } = opts;
  // c-ares per-attempt timeout; the hard timeout below bounds the total.
  const resolver = new dns.promises.Resolver({ timeout: Math.max(100, Math.floor(timeoutMs / tries)), tries });
  if (servers && servers.length > 0) resolver.setServers(servers);

  let cancelled = false;
  let active = 0;
  const queue = [];
  const pendingRejects = new Set();

  const pump = () => {
    while (!cancelled && active < maxConcurrent && queue.length > 0) {
      queue.shift().start();
    }
  };

  async function resolveBoth(host) {
    const settle = (p) => p.then((v) => ({ ok: v }), (e) => ({ err: e }));
    const [a, aaaa] = await Promise.all([settle(resolver.resolve4(host)), settle(resolver.resolve6(host))]);
    // Any real error (timeout, SERVFAIL, refused) fails the lookup: without
    // the full answer we cannot apply the "any non-public address" rule.
    for (const r of [a, aaaa]) {
      if (r.err && !NO_RECORDS.has(r.err.code)) throw r.err;
    }
    const out = [...(a.ok ?? []), ...(aaaa.ok ?? [])];
    if (out.length === 0) {
      const nx = a.err?.code === 'ENOTFOUND' || aaaa.err?.code === 'ENOTFOUND';
      throw dnsError(nx ? 'ENOTFOUND' : 'ENODATA', `no addresses for ${host}`);
    }
    return out;
  }

  /** @returns {Promise<string[]>} */
  function lookup(host) {
    if (cancelled) return Promise.reject(dnsError('ECANCELLED', 'resolver cancelled'));
    if (active >= maxConcurrent && queue.length >= maxQueue) {
      return Promise.reject(dnsError('EBUSY', 'too many pending DNS lookups'));
    }
    return new Promise((resolve, reject) => {
      let done = false;
      let timer = null;
      const finish = (fn, v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pendingRejects.delete(onCancel);
        fn(v);
      };
      const onCancel = () => {
        const i = queue.indexOf(entry);
        if (i >= 0) queue.splice(i, 1);
        finish(reject, dnsError('ECANCELLED', 'resolver cancelled'));
      };
      const entry = {
        start() {
          active++;
          let released = false;
          const release = () => {
            if (released) return;
            released = true;
            if (cancelled) return; // cancel() already reset the counters
            active--;
            pump();
          };
          timer = setTimeout(() => {
            release();
            finish(reject, dnsError('ETIMEOUT', `DNS lookup for ${host} timed out`));
          }, timeoutMs);
          resolveBoth(host).then(
            (v) => {
              release();
              finish(resolve, v);
            },
            (e) => {
              release();
              finish(reject, cancelled ? dnsError('ECANCELLED', 'resolver cancelled') : e);
            },
          );
        },
      };
      pendingRejects.add(onCancel);
      queue.push(entry);
      pump();
    });
  }

  return {
    lookup,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      resolver.cancel();
      for (const rej of [...pendingRejects]) rej();
      active = 0;
    },
    stats: () => ({ active, queued: queue.length, cancelled }),
  };
}
