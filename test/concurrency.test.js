import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureGate, QueueFullError, QueueTimeoutError } from '../src/concurrency.js';

test('limits concurrency, queues FIFO, rejects when the queue is full', async () => {
  const g = new CaptureGate({ maxConcurrent: 2, maxQueue: 1, queueTimeoutMs: 5_000 });
  const r1 = await g.acquire();
  const r2 = await g.acquire();
  assert.equal(g.active, 2);
  let got3 = false;
  const p3 = g.acquire().then((r) => {
    got3 = true;
    return r;
  });
  assert.equal(g.queued, 1);
  await assert.rejects(g.acquire(), QueueFullError);
  r1();
  r1(); // double release is a no-op
  const r3 = await p3;
  assert.equal(got3, true);
  assert.equal(g.active, 2);
  r2();
  r3();
  assert.equal(g.active, 0);
});

test('queue wait times out', async () => {
  const g = new CaptureGate({ maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 1_000 });
  const r = await g.acquire();
  await assert.rejects(g.acquire(), QueueTimeoutError);
  assert.equal(g.queued, 0);
  r();
});

test('abort removes a waiter', async () => {
  const g = new CaptureGate({ maxConcurrent: 1, maxQueue: 2, queueTimeoutMs: 5_000 });
  const r = await g.acquire();
  const ac = new AbortController();
  const p = g.acquire(ac.signal);
  ac.abort();
  await assert.rejects(p);
  assert.equal(g.queued, 0);
  r();
  assert.equal(g.active, 0);
});
