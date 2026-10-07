import { expect, type APIRequestContext, type TestInfo } from '@playwright/test';

export async function waitForWorkspace(request: APIRequestContext, info: TestInfo) {
  // Browser workflows share a local IP. Respect the live request limit between workflows.
  info.setTimeout(Math.max(info.timeout, 90000));
  await expect
    .poll(
      async () => {
        try {
          const response = await request.get('/api/health');
          return (
            response.status() === 200 &&
            Number(response.headers()['x-ratelimit-remaining'] ?? 300) >= 100
          );
        } catch {
          return false;
        }
      },
      { timeout: 75000, intervals: [1000, 2000, 3000] },
    )
    .toBe(true);
}
