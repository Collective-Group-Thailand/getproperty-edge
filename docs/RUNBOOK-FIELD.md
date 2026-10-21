# Field runbook — installing a getproperty gateway

For the installer on site. Time: ~1 h for a 30-room floor. You need: the gateway (pre-flashed image or
Debian/Raspberry Pi OS + `install.sh`), the RS485 adapter, twisted-pair cable (shielded, 120 Ω), 120 Ω
termination resistors, a laptop or phone on the building LAN, the staff PWA logged in.

## 1. Mount and power

1. Mount the gateway in the electrical room / riser cabinet, away from contactors; DIN rail where possible.
2. Connect Ethernet (preferred) or insert the 4G SIM; Wi-Fi only if neither is available.
3. Power on. The status LED blinks while the agent starts.

## 2. Wire the RS485 bus (electric meters)

1. Daisy-chain the meters: adapter **A → A**, **B → B** on every meter, no star branches.
2. Shield/GND to the adapter GND at **one end only**.
3. Fit 120 Ω between A and B at the far end (and at the adapter if the run is > 50 m).
4. One bus per riser or floor if you have more than ~100 meters or > 300 m of cable.

## 3. Address the meters

On each Eastron SDM120/SDM230 (front-panel setup menu): set **Modbus ID** (1–247, unique per bus — use
the room number scheme agreed with the owner), **baud 9600**, **parity none**, 2 stop bits. Write the ID
on the meter label. Take a **photo of the register** of every meter (needed for the staff confirmation,
D-033).

## 4. Wire pulse inputs (water meters)

Reed / open-collector output → carrier pulse channel (two wires, polarity per the carrier silk-screen),
max ~50 m. Note the channel number (GPIO pin) and the meter's **litres per pulse** (on the dial: e.g.
"1 imp = 10 L"). Photograph the water meter register.

## 5. Provision the gateway

1. The status page listens on the gateway itself only (`127.0.0.1:8080`, release review #12). Either set the
   provisioning code in `/etc/getproperty-edge/agent.env` (`GP_PROVISIONING_CODE=…`) and restart the service, or,
   for the install visit, set `GP_STATUS_HOST=0.0.0.0`, restart, read the local admin token with
   `sudo cat /var/lib/getproperty-edge/status-token`, find the gateway's address (router DHCP list, or the label QR)
   and open `http://<gateway-ip>:8080` — the browser asks for a password: any user name, the token as password.
   Remove `GP_STATUS_HOST` again when you leave (the page shows each room's meter readings).
2. Type the **one-time provisioning code** printed on the gateway QR label → _Register_.
   The page shows the gateway id when it is registered. (A rejected code: ask the office for a new one.)
3. In the staff PWA: scan the gateway QR, then for every meter scan its QR (or enter the serial), choose
   the room, enter the Modbus ID / pulse channel, litres per pulse and the **photo reading** as the
   initial register. Save — the cloud pushes the configuration to the gateway.

## 6. Verify

1. Refresh the status page: _Config version_ changes to the new version, every meter row shows
   **ok** and a _Register_ that matches the meter display (± the consumption since the photo).
2. In the staff PWA the meters turn online and the first readings appear within 15 minutes.
3. Use _Identify_ in the PWA if you need to find the box: the LED blinks 3 short + 1 long.

## Troubleshooting

| Status page shows                       | Likely cause                                                                         | Fix                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| meter `not_found`                       | wrong Modbus ID or meter model, meter unpowered                                      | check the ID on the meter vs the PWA binding                                                                                                                                  |
| meter `timeout` (was ok before)         | A/B swapped, cable cut, missing termination on a long run                            | swap A/B, check continuity, fit 120 Ω                                                                                                                                         |
| meter `crc_error`                       | noise, wrong baud/parity, two meters with the same ID                                | check baud 9600 8N2, unique IDs, shield at one end                                                                                                                            |
| Broker `disconnected`                   | building firewall blocks 8883                                                        | ask IT to allow outbound TCP 8883 to the MQTT host; readings keep flowing over HTTPS (443, device host) after 10 min. If 8883 cannot be opened: WebSocket fallback, see below |
| Broker `disconnected`, 8883 open        | agent older than protocol 1.2 (no device JWT), gateway retired / certificate revoked | update the agent (OTA or `install.sh --binary`); the office checks the gateway in the admin fleet page (`mqtt.authn_denied` audit rows)                                       |
| Broker `connected (WebSocket fallback)` | 8883 blocked, fallback in use                                                        | expected only for gateways listed for the fallback; ask IT again for 8883 and switch the fallback off once open                                                               |
| readings `clock_suspect` (PWA)          | NTP blocked                                                                          | allow outbound UDP 123 or the gateway's 4G link                                                                                                                               |
| Queue keeps growing                     | no uplink                                                                            | readings are safe on disk for 30 days; restore the uplink                                                                                                                     |

## Outbound connections the building must allow

| To                                                                             | Port     | What                                                                        |
| ------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------------- |
| MQTT host (`mqtt.getproperty.co`, UAT: collective-infra `caddy/sites.uat.yml`) | TCP 8883 | MQTT 5 + mutual TLS + device JWT (protocol 1.2) — the normal path           |
| Device host (`device.getproperty.co`)                                          | TCP 443  | bootstrap, token, certificate renewal, config pull, HTTPS readings fallback |
| MQTT host, WebSocket fallback only (`wss://mqtt.getproperty.co/mqtt`)          | TCP 443  | only for a gateway whose fallback the platform admin enabled (D-239)        |
| NTP (`th.pool.ntp.org`)                                                        | UDP 123  | clock (`clock_suspect` without it)                                          |

OTA updates come from the device host as well (api D-231), so no other destination is needed.

### Building that cannot open outbound 8883 — WebSocket fallback (D-239)

MQTT over `wss://<MQTT_HOST>/mqtt` on 443 is a **per-gateway exception**: on that path the gateway has no client
certificate and logs in with its device JWT alone (risk accepted by the founder, api ADR-0015). Use it only when IT
confirms 8883 cannot be opened:

1. Ask the office / platform admin to enable the fallback for this gateway (admin device page → _WebSocket
   fallback_, with the reason, e.g. the IT ticket). The URL arrives with the bootstrap answer **and** with every device
   token refresh (CR-015, api D-249): a gateway that is already provisioned picks it up within one token lifetime
   (≤ 1 h) and logs `the platform enabled the WebSocket fallback for this gateway` — **no new provisioning code and no
   site visit**; `systemctl restart getproperty-edge` fetches a token at once if you do not want to wait. (Agents older
   than CR-015 still need a re-provisioning: `systemctl stop getproperty-edge`,
   `mv /var/lib/getproperty-edge/identity /var/lib/getproperty-edge/identity.old`, start the service and enter a new
   code as in §5; delete `identity.old` once connected.)
2. Install with `install.sh … --mqtt-ws-fallback on` (or set `GP_MQTT_WS_FALLBACK=on` in
   `/etc/getproperty-edge/agent.env` and `systemctl restart getproperty-edge`).
3. Provision as in §5. The agent still tries 8883 first; after 3 failed attempts it switches and logs
   `switching to the WebSocket fallback`; the status page shows _Broker connected (WebSocket fallback)_.
4. Both switches are needed: the agent never uses WebSocket while the API announces no `wsUrl`, and the broker
   refuses it when the admin switches the fallback off — the agent then fetches a new token, whose answer no longer
   carries `wsUrl`, drops the stored URL and goes back to 8883.

When 8883 is opened later: switch the fallback off in the admin page and set `GP_MQTT_WS_FALLBACK=off`.

Without either path the HTTPS fallback keeps readings flowing (and pulls the first config on a cold start) during an
outage, but commands, health and OTA need MQTT.

## Firewall (optional, recommended)

Allow inbound TCP 8080 from the building LAN only, nothing else inbound:

```sh
nft add rule inet filter input ip saddr 192.168.0.0/16 tcp dport 8080 accept
```
