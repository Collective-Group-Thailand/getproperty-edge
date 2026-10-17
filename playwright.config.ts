import { defineConfig } from '@playwright/test';

const executablePath = process.env.PW_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});
