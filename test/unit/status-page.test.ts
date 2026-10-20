import { describe, expect, it } from 'vitest';

import { loadEnv } from '../../src/env.js';
import { esc, renderStatusPage, type StatusView } from '../../src/status-page/render.js';
import { bindsBeyondLoopback, isLoopback, StatusPageServer } from '../../src/status-page/server.js';
import { silentLogger } from '../../src/util/logger.js';

const view = (over: Partial<StatusView> = {}): StatusView => ({
  agentVersion: '0.1.0',
  gatewayId: '0192a000-0000-7000-8000-00000000aaaa',
  provisioning: 'provisioned',
  configVersion: 12,
  link: { broker: 'connected', type: 'wifi', rssi: -61, httpsFallback: false },
  queue: { depth: 3, oldestReadAt: '2026-11-01T00:15:00+07:00', evictedTotal: 0 },
  uptimeS: 7260,
  now: '2026-11-01T00:16:00+07:00',
  meters: [
    {
      meterId: '0192a000-0000-7000-8000-000000000001',
      roomCode: '<script>alert(1)</script>',
      driver: 'eastron_sdm120',
      bus: 'rs485-1',
      address: '21',
      status: 'ok',
      lastReadAt: '2026-11-01T00:15:00+07:00',
      lastRegister: '12345.678',
      unit: 'kwh',
    },
  ],
  ...over,
});

describe('status page rendering', () => {
  it('escapes everything that comes from config', () => {
    expect(esc('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    const html = renderStatusPage(view());
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('12345.678 kwh');
    expect(html).toContain('-61 dBm');
    expect(html).not.toContain('<form');
  });
  it('offers the provisioning entry only while unprovisioned', () => {
    expect(renderStatusPage(view({ gatewayId: null, provisioning: 'waiting_for_code' }))).toContain(
      'action="/provision"',
    );
    expect(renderStatusPage(view({ gatewayId: null, provisioning: 'bootstrapping' }))).not.toContain('<form');
  });
});

async function withServer(
  provisioned: boolean,
  fn: (base: string, codes: string[]) => Promise<void>,
  rate = 60,
  access: { token?: string; trustLoopback?: boolean } = {},
) {
  const codes: string[] = [];
  const srv = new StatusPageServer({
    host: '127.0.0.1',
    port: 0,
    ...access,
    view: async () => view(provisioned ? {} : { gatewayId: null, provisioning: 'waiting_for_code' }),
    submitCode: (c) => {
      codes.push(c);
      return c.length >= 8;
    },
    provisioned: () => provisioned,
    logger: silentLogger(),
    ratePerMinute: rate,
  });
  const port = await srv.start();
  try {
    await fn(`http://127.0.0.1:${port}`, codes);
  } finally {
    await srv.stop();
  }
}

describe('status page server', () => {
  it('serves read-only HTML/JSON with a strict CSP and no scripts', async () => {
    await withServer(true, async (base) => {
      const res = await fetch(`${base}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'; style-src 'sha256-/);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(await res.text()).not.toMatch(/<script/i);
      const json = (await (await fetch(`${base}/status.json`)).json()) as StatusView;
      expect(json.configVersion).toBe(12);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
      expect((await fetch(`${base}/`, { method: 'PUT' })).status).toBe(405);
      expect((await fetch(`${base}/provision`, { method: 'POST', body: 'code=ABCDEFGH' })).status).toBe(404);
    });
  });

  it('accepts a provisioning code only while unprovisioned', async () => {
    await withServer(false, async (base, codes) => {
      const res = await fetch(`${base}/provision`, {
        method: 'POST',
        body: 'code=GP7K-Q2MX-9TZ4',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        redirect: 'manual',
      });
      expect(res.status).toBe(303);
      expect(codes).toEqual(['GP7K-Q2MX-9TZ4']);
      expect(await (await fetch(`${base}/`)).text()).toContain('Code received');
      const big = await fetch(`${base}/provision`, { method: 'POST', body: 'code=' + 'A'.repeat(5000) }).catch(
        () => null,
      );
      expect(big === null || big.status >= 400).toBe(true);
    });
  });

  it('rate-limits per client', async () => {
    await withServer(
      true,
      async (base) => {
        const statuses: number[] = [];
        for (let i = 0; i < 8; i++) statuses.push((await fetch(`${base}/healthz`)).status);
        expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
        expect(statuses).toContain(429);
      },
      5,
    );
  });
});

describe('status page access (review #12)', () => {
  const TOKEN = 'local-admin-token-0123456789';
  const lan = { token: TOKEN, trustLoopback: false }; // emulates a client on the building network

  it('binds to loopback by default and needs a token beyond it', () => {
    expect(loadEnv({}).statusHost).toBe('127.0.0.1');
    expect(bindsBeyondLoopback('127.0.0.1')).toBe(false);
    expect(bindsBeyondLoopback('localhost')).toBe(false);
    expect(bindsBeyondLoopback('0.0.0.0')).toBe(true);
    expect(bindsBeyondLoopback('192.168.1.20')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(() => loadEnv({ GP_STATUS_TOKEN: 'short' })).toThrow(/GP_STATUS_TOKEN/);
  });

  it('a LAN client without the token sees no per-unit data and cannot provision', async () => {
    await withServer(
      false,
      async (base, codes) => {
        for (const path of ['/', '/status.json']) {
          const res = await fetch(`${base}${path}`);
          expect(res.status).toBe(401);
          expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm=/);
          expect(await res.text()).not.toMatch(/roomCode|12345\.678|<script/);
        }
        const wrong = await fetch(`${base}/status.json`, { headers: { authorization: 'Bearer nope-nope-nope-nope' } });
        expect(wrong.status).toBe(401);
        const post = await fetch(`${base}/provision`, {
          method: 'POST',
          body: 'code=GP7K-Q2MX-9TZ4',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          redirect: 'manual',
        });
        expect(post.status).toBe(401);
        expect(codes).toEqual([]);
        expect((await fetch(`${base}/healthz`)).status).toBe(200);
      },
      60,
      lan,
    );
  });

  it('with the token (Basic password or Bearer) the LAN client gets the page', async () => {
    await withServer(
      true,
      async (base) => {
        const basic = `Basic ${Buffer.from(`installer:${TOKEN}`).toString('base64')}`;
        const page = await fetch(`${base}/`, { headers: { authorization: basic } });
        expect(page.status).toBe(200);
        const json = (await (
          await fetch(`${base}/status.json`, { headers: { authorization: `Bearer ${TOKEN}` } })
        ).json()) as StatusView;
        expect(json.meters).toHaveLength(1);
      },
      60,
      lan,
    );
  });

  it('a LAN-facing page without any token configured serves nobody but /healthz', async () => {
    await withServer(
      true,
      async (base) => {
        expect((await fetch(`${base}/`)).status).toBe(401);
        expect((await fetch(`${base}/healthz`)).status).toBe(200);
      },
      60,
      { trustLoopback: false },
    );
  });
});
