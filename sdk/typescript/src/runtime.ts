import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  assertId,
  equalSecret,
  unb64,
  b64,
} from "./crypto.js";
import { ValueType, type SemanticField, type SessionContext } from "./types.js";
const HEADER = 38,
  TAG = 16,
  MAX_SEQ = (1n << 64n) - 1n;
export const MAX_FIELDS = 4096;
export function encodeValue(type: ValueType, value: unknown): Buffer {
  switch (type) {
    case ValueType.None:
      if (value !== undefined) throw new Error("Invalid empty value");
      return Buffer.alloc(0);
    case ValueType.U64:
    case ValueType.I64: {
      if (typeof value !== "bigint") throw new Error("Integer requires bigint");
      const out = Buffer.alloc(8);
      if (type === ValueType.U64) out.writeBigUInt64BE(value);
      else out.writeBigInt64BE(value);
      return out;
    }
    case ValueType.F64: {
      if (typeof value !== "number" || !Number.isFinite(value))
        throw new Error("Invalid finite number");
      const out = Buffer.alloc(8);
      out.writeDoubleBE(value);
      return out;
    }
    case ValueType.Bool:
      if (typeof value !== "boolean") throw new Error("Invalid boolean");
      return Buffer.from([value ? 1 : 0]);
    case ValueType.Bytes:
      if (!(value instanceof Uint8Array)) throw new Error("Invalid bytes");
      return Buffer.from(value);
    case ValueType.Concept:
      assertId(value as string);
      return unb64(value as string);
    case ValueType.Ref: {
      if (
        !Number.isInteger(value) ||
        (value as number) < 0 ||
        (value as number) >= MAX_FIELDS
      )
        throw new Error("Invalid reference");
      const out = Buffer.alloc(4);
      out.writeUInt32BE(value as number);
      return out;
    }
    case ValueType.Utf8:
      if (typeof value !== "string") throw new Error("Invalid text data");
      return Buffer.from(value);
    case ValueType.Json: {
      const text = JSON.stringify(value);
      if (text === undefined) throw new Error("Invalid JSON");
      return Buffer.from(text);
    }
    default:
      throw new Error("Unsupported value type");
  }
}
export function decodeValue(type: ValueType, data: Buffer): unknown {
  const sizes: Record<number, number> = {
    0: 0,
    1: 8,
    2: 8,
    3: 8,
    4: 1,
    7: 32,
    8: 4,
  };
  if (sizes[type] !== undefined && data.length !== sizes[type])
    throw new Error("Invalid typed length");
  switch (type) {
    case ValueType.None:
      return undefined;
    case ValueType.U64:
      return data.readBigUInt64BE();
    case ValueType.I64:
      return data.readBigInt64BE();
    case ValueType.F64: {
      const n = data.readDoubleBE();
      if (!Number.isFinite(n)) throw new Error("Invalid finite number");
      return n;
    }
    case ValueType.Bool:
      if (data[0] > 1) throw new Error("Invalid boolean");
      return data[0] === 1;
    case ValueType.Bytes:
      return Buffer.from(data);
    case ValueType.Concept:
      return b64(data);
    case ValueType.Ref:
      return data.readUInt32BE();
    case ValueType.Utf8:
      return new TextDecoder("utf-8", { fatal: true }).decode(data);
    case ValueType.Json:
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    default:
      throw new Error("Unsupported value type");
  }
}
export class VamlSessionRuntime {
  private closed = false;
  constructor(
    readonly context: SessionContext,
    readonly conceptToCode: Map<string, bigint>,
    readonly codeToConcept: Map<bigint, string>,
  ) {}
  private ready(): void {
    if (this.closed || !this.context.confirmed)
      throw new Error("Session closed or handshake not confirmed");
  }
  /** Control kinds 1 (active set), 2 (ack) share the same directional sequence space. */
  seal(plaintext: Buffer, kind: 0 | 1 | 2): Buffer {
    this.ready();
    if (plaintext.length + HEADER + TAG > this.context.maxFrameBytes)
      throw new Error("Frame too large");
    if (this.context.sendSequence >= MAX_SEQ)
      throw new Error("Sequence overflow; renegotiate");
    const sequence = ++this.context.sendSequence;
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(sequence, 4);
    const header = Buffer.alloc(HEADER);
    header.write("V2");
    header[3] = 2;
    header[4] = kind;
    header.writeBigUInt64BE(this.context.sessionId, 6);
    header.writeBigUInt64BE(sequence, 14);
    nonce.copy(header, 22);
    header.writeUInt32BE(plaintext.length, 34);
    const box = aesGcmEncrypt(
      this.context.keys.sendKey,
      plaintext,
      header,
      nonce,
    );
    return Buffer.concat([header, box.ciphertext, box.tag]);
  }
  open(frame: Uint8Array, expectedKind: 0 | 1 | 2): Buffer {
    this.ready();
    if (
      frame.length < HEADER + TAG ||
      frame.length > this.context.maxFrameBytes
    )
      throw new Error("Invalid frame size");
    const data = Buffer.from(frame);
    if (
      data[0] !== 86 ||
      data[1] !== 50 ||
      data[2] !== 0 ||
      data[3] !== 2 ||
      data[4] !== expectedKind ||
      data[5] !== 0
    )
      throw new Error("Invalid frame version/kind");
    const sid = Buffer.alloc(8);
    sid.writeBigUInt64BE(this.context.sessionId);
    if (!equalSecret(sid, data.subarray(6, 14)))
      throw new Error("Session ID mismatch");
    const seq = data.readBigUInt64BE(14);
    if (seq <= this.context.receiveSequence)
      throw new Error("Replay or out-of-order frame rejected");
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64BE(seq, 4);
    if (!equalSecret(nonce, data.subarray(22, 34)))
      throw new Error("Invalid nonce construction");
    const len = data.readUInt32BE(34);
    if (len + HEADER + TAG !== data.length)
      throw new Error("Cipher length mismatch");
    const plain = aesGcmDecrypt(
      this.context.keys.receiveKey,
      {
        nonce,
        ciphertext: data.subarray(HEADER, HEADER + len),
        tag: data.subarray(HEADER + len),
      },
      data.subarray(0, HEADER),
    );
    // Authenticated malformed messages consume their sequence; never retry them.
    this.context.receiveSequence = seq;
    return plain;
  }
  encode(fields: SemanticField[]): Buffer {
    if (fields.length > MAX_FIELDS) throw new Error("Field count limit");
    let bytes = 0;
    const parts = fields.map((field) => {
      const code = this.conceptToCode.get(field.conceptId);
      if (code === undefined)
        throw new Error("Concept is not in negotiated codebook");
      if (!this.context.valueTypes.includes(field.valueType))
        throw new Error("Unnegotiated value type");
      if (
        field.valueType === ValueType.Ref &&
        (!Number.isInteger(field.value) ||
          (field.value as number) >= fields.length)
      )
        throw new Error("Dangling reference");
      let value: Buffer;
      if (field.valueType === ValueType.Concept) {
        const target = this.conceptToCode.get(field.value as string);
        if (target === undefined) throw new Error("Unknown concept reference");
        value = Buffer.alloc(8);
        value.writeBigUInt64BE(target);
      } else value = encodeValue(field.valueType, field.value);
      bytes += 13 + value.length;
      if (bytes + HEADER + TAG > this.context.maxFrameBytes)
        throw new Error("Frame too large");
      const header = Buffer.alloc(13);
      header.writeBigUInt64BE(code);
      header[8] = field.valueType;
      header.writeUInt32BE(value.length, 9);
      return Buffer.concat([header, value]);
    });
    return this.seal(Buffer.concat(parts), 0);
  }
  decode(frame: Uint8Array): SemanticField[] {
    const data = this.open(frame, 0),
      fields: SemanticField[] = [];
    let offset = 0;
    while (offset < data.length) {
      if (fields.length >= MAX_FIELDS || data.length - offset < 13)
        throw new Error("Malformed field header");
      const conceptId = this.codeToConcept.get(data.readBigUInt64BE(offset)),
        valueType = data[offset + 8],
        length = data.readUInt32BE(offset + 9);
      offset += 13;
      if (!conceptId) throw new Error("Unknown negotiated session code");
      if (
        !this.context.valueTypes.includes(valueType) ||
        length > data.length - offset
      )
        throw new Error("Malformed field");
      const payload = data.subarray(offset, offset + length);
      offset += length;
      let value: unknown;
      if (valueType === ValueType.Concept) {
        if (length !== 8) throw new Error("Invalid concept reference");
        value = this.codeToConcept.get(payload.readBigUInt64BE());
        if (!value) throw new Error("Unknown concept reference");
      } else value = decodeValue(valueType, payload);
      fields.push({ conceptId, valueType, value });
    }
    for (const f of fields)
      if (f.valueType === ValueType.Ref && (f.value as number) >= fields.length)
        throw new Error("Dangling reference");
    return fields;
  }
  close(): void {
    this.closed = true;
    this.context.confirmed = false;
    for (const key of Object.values(this.context.keys)) key.fill(0);
    this.conceptToCode.clear();
    this.codeToConcept.clear();
  }
}
