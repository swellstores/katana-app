import { ACTIVE_STATUSES, activeJob } from './lib/jobs';

export const config: SwellConfig = {
  description: 'Cancel or resume a Katana sync job',
  action: true,
};

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const action = data.$action;
  const id = action?.record_id;

  if (!id || !/^[0-9a-f]{24}$/i.test(id)) {
    fail('Open a sync job to run this action');
  }

  const job: Record<string, any> | null = await swell.get(`/syncs/${id}`);
  if (!job) {
    fail('Sync job not found');
  }

  if (action?.id === 'cancel') {
    if (!ACTIVE_STATUSES.includes(job.status)) {
      fail(`This sync is already ${job.status}.`);
    }
    await swell.put(`/syncs/${id}`, { status: 'canceled', date_completed: new Date().toISOString() });
    return { message: 'Sync canceled.' };
  }

  if (action?.id === 'resume') {
    if (!['failed', 'canceled', 'waiting'].includes(job.status)) {
      fail(`Only failed, canceled or waiting syncs can be resumed. This one is ${job.status}.`);
    }
    const other = await activeJob(swell, job.type);
    if (other && other.id !== id) {
      fail('Another sync of this type is active. Cancel it or wait for it to finish first.');
    }
    // Jobs continue at their saved page or after `last_id`; a waiting job retries now instead of at date_retry
    await swell.put(`/syncs/${id}`, {
      status: 'pending',
      last_error: null,
      date_completed: null,
      retries: 0,
      date_retry: null,
    });
    return { message: 'Sync resumed.' };
  }

  fail(`Unknown action: ${action?.id}`);
}
