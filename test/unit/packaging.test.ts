import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('scripts/install.sh (test mode under --root)', () => {
  it('lays out slots, guard, unit, udev, NTP, watchdog and a secret-free env file', () => {
    const root = mkdtempSync(join(tmpdir(), 'gp-install-'));
    const bin = join(root, 'getproperty-edge.bin');
    writeFileSync(bin, '#!/bin/sh\necho 0.1.0\n');
    const out = execFileSync(
      'bash',
      ['scripts/install.sh', '--root', root, '--binary', bin, '--api-url', 'https://api.example.test'],
      {
        encoding: 'utf8',
      },
    );
    expect(out).toContain('done (files only');
    const opt = join(root, 'opt/getproperty-edge');
    expect(readlinkSync(join(opt, 'slots/current'))).toBe('a');
    expect(statSync(join(opt, 'slots/a/getproperty-edge')).mode & 0o777).toBe(0o755);
    expect(statSync(join(opt, 'ota-guard.sh')).mode & 0o777).toBe(0o755);
    expect(statSync(join(root, 'var/lib/getproperty-edge')).mode & 0o777).toBe(0o700);
    const env = readFileSync(join(root, 'etc/getproperty-edge/agent.env'), 'utf8');
    expect(env).toContain('GP_API_URL=https://api.example.test');
    expect(env).toContain('GP_MQTT_WS_FALLBACK=off'); // D-239: opt-in per gateway (--mqtt-ws-fallback on)
    expect(env).not.toMatch(/PROVISIONING|KEY|TOKEN|SECRET/);
    expect(statSync(join(root, 'etc/getproperty-edge/agent.env')).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(root, 'etc/udev/rules.d/60-getproperty-edge.rules'), 'utf8')).toMatch(
      /idVendor}=="0403"[\s\S]*gpiochip/,
    );
    expect(readFileSync(join(root, 'etc/systemd/system.conf.d/getproperty-watchdog.conf'), 'utf8')).toContain(
      'RuntimeWatchdogSec=30',
    );
    expect(readFileSync(join(root, 'etc/systemd/timesyncd.conf.d/getproperty.conf'), 'utf8')).toContain(
      'th.pool.ntp.org',
    );
    expect(lstatSync(join(root, 'etc/systemd/system/getproperty-edge.service')).isFile()).toBe(true);
    // idempotent
    execFileSync('bash', [
      'scripts/install.sh',
      '--root',
      root,
      '--binary',
      bin,
      '--api-url',
      'https://api.example.test',
      '--mqtt-ws-fallback',
      'on',
    ]);
    expect(readlinkSync(join(opt, 'slots/current'))).toBe('a');
    expect(readFileSync(join(root, 'etc/getproperty-edge/agent.env'), 'utf8')).toContain('GP_MQTT_WS_FALLBACK=on');
  });

  it('refuses plain-HTTP API URLs and missing binaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'gp-install-'));
    expect(() =>
      execFileSync('bash', ['scripts/install.sh', '--root', root, '--binary', '/nope'], { stdio: 'pipe' }),
    ).toThrow();
    writeFileSync(join(root, 'b'), 'x');
    expect(() =>
      execFileSync(
        'bash',
        ['scripts/install.sh', '--root', root, '--binary', join(root, 'b'), '--api-url', 'http://x'],
        { stdio: 'pipe' },
      ),
    ).toThrow();
    expect(() =>
      execFileSync(
        'bash',
        ['scripts/install.sh', '--root', root, '--binary', join(root, 'b'), '--mqtt-ws-fallback', 'maybe'],
        { stdio: 'pipe' },
      ),
    ).toThrow();
  });
});

describe('systemd unit', () => {
  const unit = readFileSync('systemd/getproperty-edge.service', 'utf8');
  it('restarts always, runs the A/B current slot behind the OTA guard, unprivileged and sandboxed', () => {
    for (const line of [
      'Restart=always',
      'ExecStartPre=/opt/getproperty-edge/ota-guard.sh',
      'ExecStart=/opt/getproperty-edge/slots/current/getproperty-edge',
      'User=gpedge',
      'NoNewPrivileges=yes',
      'ProtectSystem=strict',
      'CapabilityBoundingSet=',
      'DevicePolicy=closed',
      'MemoryMax=320M',
      'StartLimitIntervalSec=0',
    ])
      expect(unit).toContain(line);
    expect(unit).toMatch(/ReadWritePaths=\/var\/lib\/getproperty-edge \/opt\/getproperty-edge\/slots\n/);
  });
});
