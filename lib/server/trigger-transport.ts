import 'server-only';

import { runs, tasks } from '@trigger.dev/sdk';
import type { DispatchTransport, DispatchPayload, DispatchOperation } from './dispatch';

async function bounded<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Trigger timeout'), { code: 'ETIMEDOUT' })), 15_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const triggerTransport: DispatchTransport = {
  async trigger(operation: DispatchOperation, payload: DispatchPayload, idempotencyKey: string): Promise<string> {
    if (!process.env.TRIGGER_SECRET_KEY) throw new Error('Trigger is not configured');
    const taskId = operation === 'calculation' ? 'calculate-procurement' : 'validate-import';
    const handle = await bounded(tasks.trigger(taskId, payload,
      { idempotencyKey, idempotencyKeyTTL: '1d' },
      { retry: { maxAttempts: 1 } }));
    return handle.id;
  },
  async cancel(externalTaskId: string): Promise<void> {
    if (!process.env.TRIGGER_SECRET_KEY) throw new Error('Trigger is not configured');
    await bounded(runs.cancel(externalTaskId, { retry: { maxAttempts: 1 } }));
  },
};
