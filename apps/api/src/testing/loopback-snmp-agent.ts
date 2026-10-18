/** Minimal GET-only SNMPv2c fixture, bound exclusively to loopback. No operational credentials. */
import { createSocket } from 'node:dgram';

function tlv(tag: number, value: Buffer): Buffer {
  const length =
    value.length < 128
      ? Buffer.from([value.length])
      : Buffer.from([0x82, value.length >> 8, value.length & 255]);
  return Buffer.concat([Buffer.from([tag]), length, value]);
}
function elements(b: Buffer): Array<{ tag: number; value: Buffer; raw: Buffer }> {
  const list = [];
  let p = 0;
  while (p < b.length) {
    const start = p;
    const tag = b[p++]!;
    let n = b[p++]!;
    if (n & 128) {
      const count = n & 127;
      n = 0;
      for (let i = 0; i < count; i++) n = n * 256 + b[p++]!;
    }
    if (p + n > b.length) throw new Error('Invalid test packet');
    list.push({ tag, value: b.subarray(p, p + n), raw: b.subarray(start, p + n) });
    p += n;
  }
  return list;
}
function oid(bytes: Buffer): string {
  const values = [Math.floor(bytes[0]! / 40), bytes[0]! % 40];
  let value = 0;
  for (const b of bytes.subarray(1)) {
    value = value * 128 + (b & 127);
    if (!(b & 128)) {
      values.push(value);
      value = 0;
    }
  }
  return values.join('.');
}
function unsigned(value: bigint): Buffer {
  let h = value.toString(16);
  if (h.length % 2) h = '0' + h;
  const b = Buffer.from(h, 'hex');
  return b[0]! & 128 ? Buffer.concat([Buffer.from([0]), b]) : b;
}

export async function loopbackSnmpAgent(options: {
  value(oid: string): { type: number; value: bigint | string };
  dropFirst?: boolean;
  dropAll?: boolean;
  duplicate?: boolean;
  delayMs?: number;
}) {
  const socket = createSocket('udp4');
  let requests = 0;
  socket.on('message', (message, remote) => {
    requests++;
    if (remote.address !== '127.0.0.1' || options.dropAll || (options.dropFirst && requests === 1))
      return;
    const outer = elements(elements(message)[0]!.value);
    const pdu = elements(outer[2]!.value);
    const bindings = elements(pdu[3]!.value).map((v) => {
      const id = elements(v.value)[0]!;
      const result = options.value(oid(id.value));
      return tlv(
        0x30,
        Buffer.concat([
          id.raw,
          tlv(
            result.type,
            typeof result.value === 'string' ? Buffer.from(result.value) : unsigned(result.value),
          ),
        ]),
      );
    });
    const response = tlv(
      0x30,
      Buffer.concat([
        outer[0]!.raw,
        outer[1]!.raw,
        tlv(
          0xa2,
          Buffer.concat([
            pdu[0]!.raw,
            tlv(2, Buffer.from([0])),
            tlv(2, Buffer.from([0])),
            tlv(0x30, Buffer.concat(bindings)),
          ]),
        ),
      ]),
    );
    const send = () => {
      socket.send(response, remote.port, '127.0.0.1');
      if (options.duplicate) socket.send(response, remote.port, '127.0.0.1');
    };
    if (options.delayMs) setTimeout(send, options.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const address = socket.address();
  return {
    port: address.port,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => socket.close(resolve)),
  };
}
