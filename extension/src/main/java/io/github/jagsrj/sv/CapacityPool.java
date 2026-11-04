package io.github.jagsrj.sv;

import java.util.PriorityQueue;

/**
 * Models a server with a fixed number of workers (a thread pool) and a FIFO queue.
 *
 * <p>No threads are held: each arriving request is assigned the earliest-free worker and told
 * how long its response must be delayed (queue wait + service time). WireMock then schedules
 * that delay asynchronously. This is the classic multi-server queue (M/G/c), so the virtual
 * service saturates the way a real one does: once arrivals exceed maxConcurrent / serviceTime,
 * queue wait grows, and when the queue is full or the wait passes queueTimeoutMs, requests
 * are rejected.
 */
final class CapacityPool {

  /** Admission decision for one request. */
  record Admission(boolean rejected, long delayMs, long queueWaitMs) {}

  final int maxConcurrent;
  final int maxQueue;
  final long queueTimeoutMs;

  // Time (ms) at which each worker becomes free; exactly maxConcurrent entries.
  private final PriorityQueue<Long> workersFreeAt = new PriorityQueue<>();
  // Time (ms) at which each waiting request leaves the queue (starts, or times out).
  private final PriorityQueue<Long> queueExits = new PriorityQueue<>();

  private long admitted;
  private long queuedTotal;
  private long rejected;

  CapacityPool(int maxConcurrent, int maxQueue, long queueTimeoutMs) {
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.queueTimeoutMs = queueTimeoutMs;
    for (int i = 0; i < maxConcurrent; i++) {
      workersFreeAt.add(0L);
    }
  }

  boolean sameConfig(int maxConcurrent, int maxQueue, long queueTimeoutMs) {
    return this.maxConcurrent == maxConcurrent
        && this.maxQueue == maxQueue
        && this.queueTimeoutMs == queueTimeoutMs;
  }

  synchronized Admission admit(long nowMs, long serviceMs) {
    while (!queueExits.isEmpty() && queueExits.peek() <= nowMs) {
      queueExits.poll();
    }
    long freeAt = workersFreeAt.poll();
    long start = Math.max(nowMs, freeAt);
    long wait = start - nowMs;

    if (wait > 0) {
      if (queueExits.size() >= maxQueue) {
        workersFreeAt.add(freeAt);
        rejected++;
        return new Admission(true, 0, 0);
      }
      if (queueTimeoutMs >= 0 && wait > queueTimeoutMs) {
        // Waits in the queue until it times out, without ever getting a worker.
        workersFreeAt.add(freeAt);
        queueExits.add(nowMs + queueTimeoutMs);
        rejected++;
        return new Admission(true, queueTimeoutMs, queueTimeoutMs);
      }
      queueExits.add(start);
      queuedTotal++;
    }
    workersFreeAt.add(start + serviceMs);
    admitted++;
    return new Admission(false, wait + serviceMs, wait);
  }

  synchronized Snapshot snapshot(long nowMs) {
    int busy = 0;
    for (long t : workersFreeAt) {
      if (t > nowMs) {
        busy++;
      }
    }
    int waiting = 0;
    for (long t : queueExits) {
      if (t > nowMs) {
        waiting++;
      }
    }
    return new Snapshot(maxConcurrent, maxQueue, queueTimeoutMs, busy, waiting, admitted, queuedTotal, rejected);
  }

  record Snapshot(
      int maxConcurrent,
      int maxQueue,
      long queueTimeoutMs,
      int busy,
      int waiting,
      long admitted,
      long queued,
      long rejected) {}
}
