import { getKatanaSettings, hasCredentials } from './lib/katana';
import { runChecks } from './lib/pull';

export const config: SwellConfig = {
  description: 'Check Katana every 5 minutes for sales order status, tracking and stock changes',
  cron: {
    schedule: '*/5 * * * *',
  },
};

export default async function (req: SwellRequest) {
  const { swell, appId, store } = req;

  const settings = await getKatanaSettings(swell);
  if (settings.enabled === false || !hasCredentials(settings)) {
    return;
  }

  const results = await runChecks({
    swell,
    appId,
    storeId: store?.id || '',
    settings,
    appValues: (values) => req.appValues(values),
  });
  console.log(
    'Katana: check',
    results.map(({ run, ...result }) => ({ ...result, ...(run?.id && { pull_id: run.id }) })),
  );
}
