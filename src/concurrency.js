/**
 * A counting semaphore with a small bounded FIFO queue.
 *
 * acquire() resolves with a release function once a slot is free. It rejects
 * immediately with QueueFullError when all slots are busy and the queue is
 * full, and with QueueTimeoutError when it waited too long. Passing an
 * AbortSignal removes a waiter whose client went away.
 */

export class QueueFullError extends Error {}
export class QueueTimeoutError extends Error {}

export class CaptureGate {
  constructor({ maxConcurrent, maxQueue, queueTimeoutMs }) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.queueTimeoutMs = queueTimeoutMs;
    this.active = 0;
    this.waiters = [];
  }

  get queued() {
    return this.waiters.length;
  }

  #releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.#pump();
    };
  }

  #pump() {
    while (this.active < this.maxConcurrent && this.waiters.length > 0) {
      const w = this.waiters.shift();
      w.cleanup();
      this.active++;
      w.resolve(this.#releaser());
    }
  }

  acquire(signal) {
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve(this.#releaser());
    }
    if (this.waiters.length >= this.maxQueue) return Promise.reject(new QueueFullError('capture queue full'));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, cleanup: () => {} };
      const remove = () => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
      };
      const timer = setTimeout(() => {
        remove();
        w.cleanup();
        reject(new QueueTimeoutError('timed out waiting for a capture slot'));
      }, this.queueTimeoutMs);
      const onAbort = () => {
        remove();
        w.cleanup();
        reject(new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      w.cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      this.waiters.push(w);
    });
  }
}
