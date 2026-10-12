import { getKatanaSettings, hasCredentials, isRetryable } from './lib/katana';
import {
  ACTIVE_STATUSES,
  JOB_LABELS,
  MAX_RETRIES,
  STEP_BUDGET_MS,
  retryDelaySeconds,
  runStep,
  shouldRun,
  type Job,
  type JobUpdate,
} from './lib/jobs';

export const config: SwellConfig = {
  description: 'Run one step of a Katana sync job',
  model: {
    events: ['sync.created', 'sync.updated'],
    conditions: { status: { $in: ['pending', 'running'] } },
  },
};

export default async function (req: SwellRequest) {
  const { swell, data, appId, store } = req;
  const deadline = Date.now() + STEP_BUDGET_MS;

  if (!shouldRun(data)) {
    return;
  }

  const job: Job | null = await swell.get(`/syncs/${data.id}`);
  if (!job || !['pending', 'running'].includes(job.status)) {
    return;
  }

  const fail = (error: string, update: JobUpdate = {}) =>
    swell.put(`/syncs/${job.id}`, {
      ...update,
      status: 'failed',
      last_error: error,
      date_completed: new Date().toISOString(),
    });

  // a second job of the same type would apply the same changes twice
  if (data.$event?.type === 'sync.created') {
    const others = await swell.get('/syncs', {
      where: { type: job.type, status: { $in: ACTIVE_STATUSES }, id: { $ne: job.id } },
      limit: 1,
    });
    if (others?.results?.length) {
      return fail(`Another ${JOB_LABELS[job.type]?.toLowerCase() || 'sync'} is already active. Cancel it first.`);
    }
  }

  const settings = await getKatanaSettings(swell);
  if (settings.enabled === false) {
    return fail('The Katana app is turned off in settings');
  }
  if (!hasCredentials(settings)) {
    return fail('Katana API key or Location ID is not set in the app settings');
  }
  if (job.type === 'inventory' && settings.sync_inventory === false) {
    return fail('"Sync inventory from Katana" is off in the app settings');
  }

  const ctx = {
    swell,
    appId,
    storeId: store?.id || '',
    settings,
    appValues: (values: SwellData) => req.appValues(values),
  };

  let update: JobUpdate = {};
  let error: unknown;
  try {
    ({ update, error } = await runStep(ctx, job, deadline));
  } catch (err) {
    error = err;
  }

  if (!error) {
    return save(swell, job, update);
  }

  const message = (error as any)?.message || String(error);
  console.error(`Katana: sync ${job.id} (${job.type}) failed - ${message}`);

  const retries = (job.retries || 0) + 1;
  if (!isRetryable(error) || retries > MAX_RETRIES) {
    return fail(retries > MAX_RETRIES ? `${message} Gave up after ${MAX_RETRIES} retries.` : message, update);
  }
  // Pause the job with the progress so far; sync-retry sets it back to pending at date_retry
  const at = new Date(Date.now() + retryDelaySeconds(error, retries) * 1000).toISOString();
  const current: Job | null = await swell.get(`/syncs/${job.id}`);
  if (current && ['pending', 'running'].includes(current.status)) {
    delete update.status;
    await swell.put(`/syncs/${job.id}`, {
      ...update,
      status: 'waiting',
      retries,
      date_retry: at,
      last_error: `${message} Retry ${retries} of ${MAX_RETRIES} at ${at}.`,
    });
  }
}

// Writes progress and the next status; keeps a cancel made while this step was running
export async function save(swell: SwellAPI, job: Job, update: JobUpdate) {
  const now = new Date().toISOString();
  if (!job.date_started) {
    update.date_started = now;
  }
  if (job.retries) {
    update.retries = 0;
    update.date_retry = null;
  }
  const done = update.status === 'completed';
  delete update.status;

  const current: Job | null = await swell.get(`/syncs/${job.id}`);
  if (current && ['pending', 'running'].includes(current.status)) {
    update.status = done ? 'completed' : 'running';
    if (done) {
      update.date_completed = now;
    }
  }
  await swell.put(`/syncs/${job.id}`, update);
}
