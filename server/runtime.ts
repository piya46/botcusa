import type { FastifyInstance } from 'fastify';
import type { Worker } from './worker.js';

export function attachWorkerWakeup(app: FastifyInstance, worker: Worker) {
  // Acknowledge the durable LINE event first; start work without waiting for cron.
  app.addHook('onResponse', async (request) => {
    if (request.url.startsWith('/api/')) worker.wake();
  });
}
