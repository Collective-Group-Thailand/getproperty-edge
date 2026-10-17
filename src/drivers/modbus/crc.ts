/** CRC-16/MODBUS (poly 0xA001 reflected, init 0xFFFF), table driven. */
const TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc16(buf: Uint8Array, len = buf.length): number {
  let crc = 0xffff;
  for (let i = 0; i < len; i++) crc = (crc >>> 8) ^ TABLE[(crc ^ buf[i]!) & 0xff]!;
  return crc;
}

/** Appends the CRC low byte first, as on the wire. */
export function withCrc(body: Uint8Array): Buffer {
  const out = Buffer.alloc(body.length + 2);
  out.set(body);
  const c = crc16(body);
  out[body.length] = c & 0xff;
  out[body.length + 1] = c >>> 8;
  return out;
}

export function crcOk(frame: Uint8Array): boolean {
  if (frame.length < 4) return false;
  const c = crc16(frame, frame.length - 2);
  return frame[frame.length - 2] === (c & 0xff) && frame[frame.length - 1] === c >>> 8;
}
