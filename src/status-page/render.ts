import { createHash } from 'node:crypto';

export interface StatusView {
  agentVersion: string;
  gatewayId: string | null;
  provisioning: 'provisioned' | 'waiting_for_code' | 'bootstrapping' | 'rejected';
  provisioningDetail?: string;
  configVersion: number;
  link: {
    broker: 'connected' | 'disconnected';
    /** `mtls` = 8883 with the client certificate; `wss` = the WebSocket fallback (device JWT only, D-239). */
    transport?: 'mtls' | 'wss';
    type: string;
    rssi: number | null;
    httpsFallback: boolean;
  };
  queue: { depth: number; oldestReadAt: string | null; evictedTotal: number };
  uptimeS: number;
  now: string;
  meters: Array<{
    meterId: string;
    roomCode: string;
    driver: string;
    bus: string;
    address: string;
    status: string;
    lastReadAt: string | null;
    lastRegister: string | null;
    unit: string;
  }>;
}

export const STYLE = `
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1b1b1b;--muted:#666;--line:#d9d9d4;--ok:#1d7a3a;--bad:#b3261e;--warn:#9a6700}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ececec;--muted:#a0a0a0;--line:#333;--ok:#5cc47e;--bad:#ff8a80;--warn:#e3b341}}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,sans-serif;background:var(--bg);color:var(--fg)}
main{max-width:1100px;margin:0 auto;padding:16px}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}
.muted{color:var(--muted)}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dt{color:var(--muted)}dd{margin:0}
.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
form{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}input{font:inherit;padding:6px 8px;min-width:16ch}button{font:inherit;padding:6px 12px}
`;

/** CSP hash of the inline stylesheet: the page runs no script at all. */
export const STYLE_HASH = `sha256-${createHash('sha256').update(STYLE).digest('base64')}`;

export function esc(v: string | number | null | undefined): string {
  return String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

const cls = (status: string) => (status === 'ok' ? 'ok' : status === 'timeout' ? 'warn' : 'bad');

export function renderStatusPage(v: StatusView, flash?: string): string {
  const provisioningForm =
    v.provisioning === 'provisioned'
      ? ''
      : `<section aria-labelledby="prov"><h2 id="prov">Provisioning</h2>
<p>${v.provisioning === 'bootstrapping' ? 'Registering this gateway…' : 'This gateway is not registered yet. Enter the one-time provisioning code printed on the gateway QR label.'}
${v.provisioningDetail ? `<br><strong class="bad">${esc(v.provisioningDetail)}</strong>` : ''}</p>
${
  v.provisioning === 'bootstrapping'
    ? ''
    : `<form method="post" action="/provision"><label for="code">Provisioning code</label>
<input id="code" name="code" autocomplete="off" required pattern="[A-Za-z0-9\\- ]{8,64}"><button type="submit">Register</button></form>`
}</section>`;
  const rows = v.meters
    .map(
      (
        m,
      ) => `<tr><td>${esc(m.roomCode)}</td><td><code>${esc(m.meterId)}</code></td><td>${esc(m.driver)}</td><td>${esc(m.bus)}</td><td>${esc(m.address)}</td>
<td class="${cls(m.status)}">${esc(m.status)}</td><td>${esc(m.lastReadAt ?? '—')}</td><td>${esc(m.lastRegister ?? '—')} ${esc(m.unit)}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30"><title>getproperty gateway</title><style>${STYLE}</style></head>
<body><main>
<h1>getproperty gateway</h1><p class="muted">Read-only status · refreshes every 30 s · ${esc(v.now)}</p>
${flash ? `<p role="status"><strong>${esc(flash)}</strong></p>` : ''}
${provisioningForm}
<section aria-labelledby="gw"><h2 id="gw">Gateway</h2><dl>
<dt>Gateway id</dt><dd>${esc(v.gatewayId ?? 'not provisioned')}</dd>
<dt>Agent version</dt><dd>${esc(v.agentVersion)}</dd>
<dt>Config version</dt><dd>${esc(v.configVersion || '—')}</dd>
<dt>Broker</dt><dd class="${v.link.broker === 'connected' ? 'ok' : 'bad'}">${esc(v.link.broker)}${v.link.transport === 'wss' ? ' (WebSocket fallback)' : ''}${v.link.httpsFallback ? ' (HTTPS fallback active)' : ''}</dd>
<dt>Link</dt><dd>${esc(v.link.type)}${v.link.rssi !== null ? ` · ${esc(v.link.rssi)} dBm` : ''}</dd>
<dt>Queue</dt><dd>${esc(v.queue.depth)} buffered${v.queue.oldestReadAt ? ` · oldest ${esc(v.queue.oldestReadAt)}` : ''}${v.queue.evictedTotal ? ` · ${esc(v.queue.evictedTotal)} evicted` : ''}</dd>
<dt>Uptime</dt><dd>${esc(Math.floor(v.uptimeS / 3600))} h ${esc(Math.floor((v.uptimeS % 3600) / 60))} min</dd>
</dl></section>
<section aria-labelledby="meters"><h2 id="meters">Meters (${v.meters.length})</h2>
${
  v.meters.length
    ? `<div class="tablewrap"><table><thead><tr><th>Room</th><th>Meter id</th><th>Driver</th><th>Bus</th><th>Address / pin</th><th>Status</th><th>Last read</th><th>Register</th></tr></thead><tbody>
${rows}</tbody></table></div>`
    : '<p class="muted">No meters bound yet — the configuration comes from the cloud.</p>'
}
</section></main></body></html>`;
}
