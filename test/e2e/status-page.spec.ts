import { expect, test } from '@playwright/test';

import type { Agent } from '../../src/agent.js';
import { meterIds, simConfig, Testbed } from '../../tools/testbed.js';

/**
 * LAN status page, headless Chromium: provisioning entry → bootstrap → read-only status with meters,
 * last reads, queue depth, config version, link and agent version — and nothing secret on the page.
 */
let tb: Testbed;
let agent: Agent;
let base = '';
let gatewayId = '';
const CODE = 'GP7K-Q2MX-9TZ4';
const SECRETS = ['PRIVATE KEY', 'BEGIN CERTIFICATE', CODE, 'eyJ'];

test.beforeAll(async () => {
  tb = await new Testbed().start();
  const built = tb.agent({ statusPage: true, code: 'UNUSED-CODE-0000', env: { provisioningCode: undefined } });
  agent = built.agent;
  gatewayId = tb.api.addCode(CODE);
  void agent.start();
  for (let i = 0; i < 100 && agent.statusPort === undefined; i++) await new Promise((r) => setTimeout(r, 50));
  base = `http://127.0.0.1:${agent.statusPort}`;
});

test.afterAll(async () => {
  await agent.stop();
  await tb.stop();
});

test('provisioning, then a read-only status view without secrets', async ({ page }) => {
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'getproperty gateway' })).toBeVisible();
  await expect(page.getByText('not registered yet')).toBeVisible();

  await page.getByLabel('Provisioning code').fill(CODE.toLowerCase());
  await page.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText('Code received')).toBeVisible();

  await expect.poll(() => agent.gatewayId, { timeout: 15_000 }).toBe(gatewayId);
  tb.pushConfig(gatewayId, simConfig(meterIds(3, '0192a000-0000-7000-8030'), 9));
  await expect.poll(() => agent.config.version(), { timeout: 15_000 }).toBe(9);
  await expect
    .poll(async () => (await agent.statusView()).meters.every((m) => m.lastRegister !== null), { timeout: 15_000 })
    .toBe(true);

  await page.goto(base);
  await expect(page.getByText(gatewayId)).toBeVisible();
  await expect(page.locator('dt:has-text("Config version") + dd')).toHaveText('9');
  await expect(page.locator('dt:has-text("Agent version") + dd')).toHaveText('0.1.0');
  await expect(page.locator('dt:has-text("Broker") + dd')).toHaveText(/connected/);
  await expect(page.locator('dt:has-text("Queue") + dd')).toContainText('buffered');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText('A-101');
  await expect(rows.first()).toContainText('kwh');
  await expect(rows.first().locator('td').nth(5)).toHaveText('ok');

  // read-only: no form once provisioned, no scripts at all, nothing secret
  await expect(page.locator('form')).toHaveCount(0);
  await expect(page.locator('script')).toHaveCount(0);
  const html = await page.content();
  for (const s of SECRETS) expect(html).not.toContain(s);
  const json = await (await page.request.get(`${base}/status.json`)).text();
  for (const s of SECRETS) expect(json).not.toContain(s);
  expect((await page.request.post(`${base}/provision`, { form: { code: CODE } })).status()).toBe(404);
});

test('works at phone width without horizontal page scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto(base);
  const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth');
  expect(overflow).toBeLessThanOrEqual(0);
});
