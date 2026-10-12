export const config: SwellConfig = {
  description: 'Resume a waiting Katana sync job at its retry time',
  model: {
    events: ['sync.updated'],
    conditions: { status: 'waiting', date_retry: { $exists: true } },
    // Runs at date_retry; re-schedules when sync-run sets a new retry time
    schedule: { formula: 'date_retry' },
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;

  const job: Record<string, any> | null = await swell.get(`/syncs/${data.id}`);
  // Canceled or resumed by hand in the meantime
  if (!job || job.status !== 'waiting') {
    return;
  }
  // Setting the job back to pending makes sync-run retry the step
  await swell.put(`/syncs/${job.id}`, { status: 'pending' });
}
