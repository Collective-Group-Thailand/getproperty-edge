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

1. Find the gateway's address (router DHCP list, or the label QR) and open `http://<gateway-ip>:8080`.
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

| Status page shows               | Likely cause                                              | Fix                                                                                                  |
| ------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| meter `not_found`               | wrong Modbus ID or meter model, meter unpowered           | check the ID on the meter vs the PWA binding                                                         |
| meter `timeout` (was ok before) | A/B swapped, cable cut, missing termination on a long run | swap A/B, check continuity, fit 120 Ω                                                                |
| meter `crc_error`               | noise, wrong baud/parity, two meters with the same ID     | check baud 9600 8N2, unique IDs, shield at one end                                                   |
| Broker `disconnected`           | building firewall blocks 8883                             | ask IT to allow outbound TCP 8883; the agent also tries WSS 443 and falls back to HTTPS after 10 min |
| readings `clock_suspect` (PWA)  | NTP blocked                                               | allow outbound UDP 123 or the gateway's 4G link                                                      |
| Queue keeps growing             | no uplink                                                 | readings are safe on disk for 30 days; restore the uplink                                            |

## Firewall (optional, recommended)

Allow inbound TCP 8080 from the building LAN only, nothing else inbound:

```sh
nft add rule inet filter input ip saddr 192.168.0.0/16 tcp dport 8080 accept
```
