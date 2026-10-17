import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import { protocolSchema } from './schema.js';
import type { Command, CommandAck, DeviceEvent, GatewayConfig, Health, TelemetryBatch } from './types.js';

export interface PayloadTypes {
  TelemetryBatch: TelemetryBatch;
  Health: Health;
  DeviceEvent: DeviceEvent;
  GatewayConfig: GatewayConfig;
  Command: Command;
  CommandAck: CommandAck;
}
export type PayloadName = keyof PayloadTypes;

export class SchemaError extends Error {
  constructor(
    readonly payload: PayloadName,
    readonly errors: ErrorObject[],
  ) {
    super(
      `${payload} failed schema validation: ${errors
        .slice(0, 5)
        .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`)
        .join('; ')}`,
    );
    this.name = 'SchemaError';
  }
}

type AddFormats = (ajv: Ajv2020) => Ajv2020;
const addFormats = ((addFormatsModule as unknown as { default?: AddFormats }).default ??
  addFormatsModule) as unknown as AddFormats;

let ajv: Ajv2020 | undefined;
const compiled = new Map<PayloadName, ValidateFunction>();

function validator(name: PayloadName): ValidateFunction {
  let v = compiled.get(name);
  if (!v) {
    if (!ajv) {
      ajv = new Ajv2020({ allErrors: true, strict: false });
      addFormats(ajv);
      ajv.addSchema(protocolSchema);
    }
    v = ajv.getSchema(`${protocolSchema.$id}#/$defs/${name}`);
    if (!v) throw new Error(`schema $defs/${name} missing from the protocol contract`);
    compiled.set(name, v);
  }
  return v;
}

/** Returns the payload typed when it matches the contract schema, otherwise throws SchemaError. */
export function assertValid<N extends PayloadName>(name: N, value: unknown): PayloadTypes[N] {
  const v = validator(name);
  if (!v(value)) throw new SchemaError(name, v.errors ?? []);
  return value as PayloadTypes[N];
}

export function isValid(name: PayloadName, value: unknown): boolean {
  return validator(name)(value);
}
