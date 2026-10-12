import { getKatanaSettings, hasCredentials } from './lib/katana';
import { startJob } from './lib/jobs';

// completed scheduled stock syncs are kept this long, then removed
export const KEEP_SCHEDULED_MS = 3 * 24 * 60 * 60_000;

export const config: SwellConfig = {
  description: 'Start the hourly stock sync job from Katana',
  cron: {
    // a few minutes past the hour, away from the 5-minute check
    schedule: '2 * * * *',
  },
};

export default async function (req: SwellRequest) {
  const { swell } = req;

  const settings = await getKatanaSettings(swell);
  if (settings.enabled === false || settings.sync_inventory === false || !hasCredentials(settings)) {
    return;
  }

  await removeOldScheduledJobs(swell);

  const { job, started } = await startJob(swell, 'inventory', { trigger: 'schedule' });
  console.log(
    started ? `Katana: started stock sync ${job.id}` : `Katana: stock sync ${job.id} is still ${job.status}, not starting another`,
  );
}

// Hourly jobs would fill the Katana tasks list; keep a few days of them
export async function removeOldScheduledJobs(swell: SwellAPI, now = Date.now()): Promise<number> {
  const old = await swell.get('/syncs', {
    where: {
      trigger: 'schedule',
      status: 'completed',
      date_created: { $lt: new Date(now - KEEP_SCHEDULED_MS).toISOString() },
    },
    fields: 'id',
    limit: 25,
  });
  const ids: string[] = (old?.results || []).map((job: any) => job.id);
  for (const id of ids) {
    await swell.delete(`/syncs/${id}`);
  }
  return ids.length;
}
