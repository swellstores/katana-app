import { ACTIVE_STATUSES, activeJob } from './lib/jobs';

export const config: SwellConfig = {
  description: 'Cancel or resume a Katana sync job',
  action: true,
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const action = data.$action;
  const id = action?.record_id;

  if (!id || !/^[0-9a-f]{24}$/i.test(id)) {
    throw new SwellError('Open a sync job to run this action', { status: 400 });
  }

  const job: Record<string, any> | null = await swell.get(`/syncs/${id}`);
  if (!job) {
    throw new SwellError('Sync job not found', { status: 404 });
  }

  if (action?.id === 'cancel') {
    if (!ACTIVE_STATUSES.includes(job.status)) {
      return { message: `This sync is already ${job.status}.` };
    }
    await swell.put(`/syncs/${id}`, { status: 'canceled', date_completed: new Date().toISOString() });
    return { message: 'Sync canceled.' };
  }

  if (action?.id === 'resume') {
    if (!['failed', 'canceled', 'waiting'].includes(job.status)) {
      return { message: `Only failed, canceled or waiting syncs can be resumed. This one is ${job.status}.` };
    }
    const other = await activeJob(swell, job.type);
    if (other && other.id !== id) {
      return { message: 'Another sync of this type is active. Cancel it or wait for it to finish first.' };
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

  throw new SwellError(`Unknown action: ${action?.id}`, { status: 400 });
}
