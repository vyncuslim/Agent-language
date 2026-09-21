import { randomBytes } from "node:crypto";
import { aesGcmDecrypt, aesGcmEncrypt } from "./crypto.js";
import { ValueType, type SemanticField, type SessionContext, type WireField } from "./types.js";

const MAGIC = Buffer.from("V2", "ascii");
const HEADER_BYTES = 2 + 1 + 1 + 1 + 1 + 8 + 8 + 12 + 4;
const TAG_BYTES = 16;
const MAX_FIELD_BYTES = 16 * 1024 * 1024;

function encodeValue(type: ValueType, value: unknown): Buffer {
  switch (type) {
    case ValueType.None:
      return Buffer.alloc(0);
    case ValueType.U64: {
      const out = Buffer.alloc(8);
      out.writeBigUInt64BE(BigInt(value as bigint | number | string));
      return out;
    }
    case ValueType.I64: {
      const out = Buffer.alloc(8);
      out.writeBigInt64BE(BigInt(value as bigint | number | string));
      return out;
    }
    case ValueType.F64: {
      const out = Buffer.alloc(8);
      out.writeDoubleBE(Number(value));
      return out;
    }
    case ValueType.Bool:
      return Buffer.from([value ? 1 : 0]);
    case ValueType.Bytes:
      return Buffer.from(value as Uint8Array);
    case ValueType.Utf8:
    case ValueType.Ref:
    case ValueType.Concept:
      return Buffer.from(String(value), "utf8");
    case ValueType.Json:
      return Buffer.from(JSON.stringify(value), "utf8");
    default:
      throw new Error(`Unsupported VAML value type: ${type}`);
  }
}

function decodeValue(type: ValueType, payload: Buffer): unknown {
  switch (type) {
    case ValueType.None:
      if (payload.length !== 0) throw new Error("NONE value must be empty");
      return undefined;
    case ValueType.U64:
      if (payload.length !== 8) throw new Error("U64 must be 8 bytes");
      return payload.readBigUInt64BE(0);
    case ValueType.I64:
      if (payload.length !== 8) throw new Error("I64 must be 8 bytes");
      return payload.readBigInt64BE(0);
    case ValueType.F64:
      if (payload.length !== 8) throw new Error("F64 must be 8 bytes");
      return payload.readDoubleBE(0);
    case ValueType.Bool:
      if (payload.length !== 1 || (payload[0] !== 0 && payload[0] !== 1)) throw new Error("Invalid BOOL");
      return payload[0] === 1;
    case ValueType.Bytes:
      return Buffer.from(payload);
    case ValueType.Utf8:
    case ValueType.Ref:
    case ValueType.Concept:
      return payload.toString("utf8");
    case ValueType.Json:
      return JSON.parse(payload.toString("utf8"));
    default:
      throw new Error(`Unsupported VAML value type: ${type}`);
  }
}

function encodeWireFields(fields: WireField[]): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const value = encodeValue(field.valueType, field.value);
    if (value.length > MAX_FIELD_BYTES) throw new Error("VAML field too large");
    const header = Buffer.alloc(13);
    header.writeBigUInt64BE(field.sessionCode, 0);
    header.writeUInt8(field.valueType, 8);
    header.writeUInt32BE(value.length, 9);
    parts.push(header, value);
  }
  return Buffer.concat(parts);
}

function decodeWireFields(data: Buffer): WireField[] {
  const fields: WireField[] = [];
  let offset = 0;
  while (offset < data.length) {
    if (data.length - offset < 13) throw new Error("Truncated VAML field header");
    const sessionCode = data.readBigUInt64BE(offset);
    const valueType = data.readUInt8(offset + 8) as ValueType;
    const length = data.readUInt32BE(offset + 9);
    offset += 13;
    if (length > MAX_FIELD_BYTES || offset + length > data.length) throw new Error("Invalid VAML field length");
    const payload = data.subarray(offset, offset + length);
    fields.push({ sessionCode, valueType, value: decodeValue(valueType, payload) });
    offset += length;
  }
  return fields;
}

function headerAad(
  sessionId: bigint,
  sequence: bigint,
  nonce: Buffer,
  cipherLength: number,
  flags: number,
): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt8(0, 2);
  header.writeUInt8(2, 3);
  header.writeUInt8(flags & 0xff, 4);
  header.writeUInt8(0, 5);
  header.writeBigUInt64BE(sessionId, 6);
  header.writeBigUInt64BE(sequence, 14);
  nonce.copy(header, 22);
  header.writeUInt32BE(cipherLength, 34);
  return header;
}

export class VamlSessionRuntime {
  constructor(
    readonly context: SessionContext,
    readonly conceptToCode: Map<string, bigint>,
    readonly codeToConcept: Map<bigint, string>,
  ) {}

  encode(fields: SemanticField[], flags = 0): Buffer {
    const wireFields = fields.map((field): WireField => {
      const sessionCode = this.conceptToCode.get(field.conceptId);
      if (sessionCode === undefined) throw new Error(`Concept is not in negotiated codebook: ${field.conceptId}`);
      return { sessionCode, valueType: field.valueType, value: field.value };
    });

    this.context.sendSequence += 1n;
    const sequence = this.context.sendSequence;
    const plaintext = encodeWireFields(wireFields);
    const nonce = randomBytes(12);
    const provisionalHeader = headerAad(this.context.sessionId, sequence, nonce, plaintext.length, flags);
    const box = aesGcmEncrypt(this.context.keys.frameKey, plaintext, provisionalHeader, nonce);
    const header = headerAad(this.context.sessionId, sequence, box.nonce, box.ciphertext.length, flags);
    return Buffer.concat([header, box.ciphertext, box.tag]);
  }

  decode(frame: Uint8Array): SemanticField[] {
    const data = Buffer.from(frame);
    if (data.length < HEADER_BYTES + TAG_BYTES) throw new Error("Frame too short");
    if (!data.subarray(0, 2).equals(MAGIC)) throw new Error("Invalid VAML 0.2 magic");
    if (data.readUInt8(2) !== 0 || data.readUInt8(3) !== 2) throw new Error("Unsupported VAML version");
    if (data.readUInt8(5) !== 0) throw new Error("Reserved byte must be zero");

    const flags = data.readUInt8(4);
    const sessionId = data.readBigUInt64BE(6);
    const sequence = data.readBigUInt64BE(14);
    const nonce = data.subarray(22, 34);
    const cipherLength = data.readUInt32BE(34);
    if (sessionId !== this.context.sessionId) throw new Error("Session ID mismatch");
    if (sequence <= this.context.receiveSequence) throw new Error("Replay or out-of-order frame rejected");
    if (HEADER_BYTES + cipherLength + TAG_BYTES !== data.length) throw new Error("Cipher length mismatch");

    const header = headerAad(sessionId, sequence, nonce, cipherLength, flags);
    const ciphertext = data.subarray(HEADER_BYTES, HEADER_BYTES + cipherLength);
    const tag = data.subarray(HEADER_BYTES + cipherLength);
    const plaintext = aesGcmDecrypt(this.context.keys.frameKey, { nonce, ciphertext, tag }, header);
    const wireFields = decodeWireFields(plaintext);

    const result = wireFields.map((field): SemanticField => {
      const conceptId = this.codeToConcept.get(field.sessionCode);
      if (!conceptId) throw new Error(`Unknown negotiated session code: ${field.sessionCode.toString(16)}`);
      return { conceptId, valueType: field.valueType, value: field.value };
    });

    this.context.receiveSequence = sequence;
    return result;
  }
}
