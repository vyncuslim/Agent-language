import { b64, unb64 } from "./crypto.js";
import { VamlSessionRuntime } from "./runtime.js";
import { ValueType, type CompileInput, type SemanticField } from "./types.js";

/**
 * VAML 0.2 machine-IR source format.
 *
 * V2
 * P <opaque-peer-id>
 * F <concept-id> <type-hex> <base64url-payload-or-dash>
 *
 * The source intentionally contains concept IDs, not public English semantic labels.
 */
export function parseVamlSource(source: string): CompileInput {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (lines.shift() !== "V2") throw new Error("A .vaml file must start with V2");
  const peerLine = lines.shift();
  if (!peerLine?.startsWith("P ")) throw new Error("Missing opaque peer line");
  const peer = peerLine.slice(2).trim();
  if (!peer) throw new Error("Peer identifier cannot be empty");

  const fields: SemanticField[] = lines.map((line, index) => {
    const parts = line.split(/\s+/);
    if (parts.length !== 4 || parts[0] !== "F") {
      throw new Error(`Invalid field line ${index + 3}`);
    }
    const [, conceptId, typeHex, payloadToken] = parts;
    const typeNumber = Number.parseInt(typeHex, 16);
    if (!Number.isInteger(typeNumber) || typeNumber < 0 || typeNumber > 0xff) {
      throw new Error(`Invalid value type on line ${index + 3}`);
    }
    const valueType = typeNumber as ValueType;
    const value = decodeSourcePayload(valueType, payloadToken);
    return { conceptId, valueType, value };
  });

  return { peer, fields };
}

export function compileVamlSource(source: string, runtime: VamlSessionRuntime): Buffer {
  const parsed = parseVamlSource(source);
  if (parsed.peer !== runtime.context.remoteAgentId) {
    throw new Error(".vaml peer does not match negotiated remote agent");
  }
  return runtime.encode(parsed.fields);
}

export function emitVamlSource(peer: string, fields: SemanticField[]): string {
  const body = fields.map((field) => {
    const typeHex = field.valueType.toString(16).padStart(2, "0").toUpperCase();
    return `F ${field.conceptId} ${typeHex} ${encodeSourcePayload(field.valueType, field.value)}`;
  });
  return ["V2", `P ${peer}`, ...body, ""].join("\n");
}

function encodeSourcePayload(type: ValueType, value: unknown): string {
  if (type === ValueType.None) return "-";
  let data: Buffer;
  switch (type) {
    case ValueType.U64:
    case ValueType.I64:
    case ValueType.F64:
    case ValueType.Bool:
    case ValueType.Utf8:
    case ValueType.Concept:
    case ValueType.Ref:
      data = Buffer.from(String(value), "utf8");
      break;
    case ValueType.Bytes:
      data = Buffer.from(value as Uint8Array);
      break;
    case ValueType.Json:
      data = Buffer.from(JSON.stringify(value), "utf8");
      break;
    default:
      throw new Error(`Unsupported source value type: ${type}`);
  }
  return b64(data);
}

function decodeSourcePayload(type: ValueType, token: string): unknown {
  if (type === ValueType.None) {
    if (token !== "-") throw new Error("NONE field must use '-' payload");
    return undefined;
  }
  const data = unb64(token);
  switch (type) {
    case ValueType.U64:
    case ValueType.I64:
      return BigInt(data.toString("utf8"));
    case ValueType.F64:
      return Number(data.toString("utf8"));
    case ValueType.Bool: {
      const text = data.toString("utf8");
      if (text !== "true" && text !== "false") throw new Error("Invalid boolean source payload");
      return text === "true";
    }
    case ValueType.Utf8:
    case ValueType.Concept:
    case ValueType.Ref:
      return data.toString("utf8");
    case ValueType.Bytes:
      return data;
    case ValueType.Json:
      return JSON.parse(data.toString("utf8"));
    default:
      throw new Error(`Unsupported source value type: ${type}`);
  }
}
