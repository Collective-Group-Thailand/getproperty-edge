import { mapFromCustom } from '../drivers/modbus/register-map.js';
import type { GatewayConfig } from '../protocol/types.js';

export interface DriverCatalogue {
  modbus: Set<string>;
  pulse: Set<string>;
}

/**
 * Semantic checks beyond the JSON Schema: references, uniqueness and per-driver required fields.
 * Returns human-readable errors (empty = valid).
 */
export function semanticErrors(cfg: GatewayConfig, drivers: DriverCatalogue): string[] {
  const errors: string[] = [];
  const buses = new Map(cfg.buses.map((b) => [b.id, b]));
  if (buses.size !== cfg.buses.length) errors.push('duplicate bus id');
  for (const b of cfg.buses) {
    if (b.type === 'modbus_rtu' && (!b.device || !b.baud)) errors.push(`bus ${b.id}: modbus_rtu needs device and baud`);
  }
  const ids = new Set<string>();
  const addrs = new Set<string>();
  const pins = new Set<number>();
  for (const m of cfg.meters) {
    const where = `meter ${m.meterId} (${m.roomCode})`;
    if (ids.has(m.meterId)) errors.push(`${where}: duplicate meterId`);
    ids.add(m.meterId);
    const bus = buses.get(m.bus);
    if (!bus) {
      errors.push(`${where}: unknown bus ${m.bus}`);
      continue;
    }
    if (m.registerMap !== 'custom' && m.customRegisterMap)
      errors.push(`${where}: customRegisterMap is only allowed with registerMap "custom" (CR-005)`);
    if (bus.type === 'modbus_rtu') {
      if (m.registerMap === 'custom') {
        // CR-005: the map travels in the config; the driver name is only a label for the model.
        try {
          mapFromCustom(m);
        } catch (err) {
          errors.push(`${where}: invalid custom register map: ${(err as Error).message}`);
        }
      } else if (!drivers.modbus.has(m.driver)) errors.push(`${where}: unknown Modbus driver ${m.driver}`);
      if (m.address === undefined) errors.push(`${where}: address required on a modbus_rtu bus`);
      else {
        const k = `${m.bus}:${m.address}`;
        if (addrs.has(k)) errors.push(`${where}: address ${m.address} already used on ${m.bus}`);
        addrs.add(k);
      }
    } else if (bus.type === 'gpio') {
      if (!drivers.pulse.has(m.driver)) errors.push(`${where}: driver ${m.driver} cannot run on a gpio bus`);
      if (m.registerMap === 'custom') errors.push(`${where}: a custom register map needs a modbus_rtu bus`);
      if (m.pin === undefined) errors.push(`${where}: pin required on a gpio bus`);
      else if (pins.has(m.pin)) errors.push(`${where}: pin ${m.pin} already used`);
      else pins.add(m.pin);
      if (m.litresPerPulse === undefined) errors.push(`${where}: litresPerPulse required`);
      if (m.initialRegister === undefined) errors.push(`${where}: initialRegister required (staff reading, D-033)`);
      if (m.unit !== 'm3') errors.push(`${where}: pulse meters count water in m3`);
    } else {
      errors.push(`${where}: ${bus.type} meters are not supported until E2 (LoRaWAN)`);
    }
  }
  if (pins.size > 16) errors.push('more than 16 pulse channels (carrier limit, docs/HARDWARE.md)');
  return errors;
}
