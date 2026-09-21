import { assertId, b64, unb64 } from "./crypto.js";
import {
  VamlSessionRuntime,
  decodeValue,
  encodeValue,
  MAX_FIELDS,
} from "./runtime.js";
import { ValueType, type CompileInput, type SemanticField } from "./types.js";
export function parseVamlSource(source: string): CompileInput {
  if (Buffer.byteLength(source) > 1048576) throw new Error("Source too large");
  const lines = source.trim().split(/\r?\n/);
  if (lines.shift() !== "V2") throw new Error("Unsupported source version");
  const peerLine = lines.shift();
  if (!peerLine || !/^P [A-Za-z0-9_-]{1,64}$/.test(peerLine))
    throw new Error("Invalid peer");
  if (lines.length > MAX_FIELDS) throw new Error("Field count limit");
  const fields = lines.map((line) => {
    const parts = line.split(" ");
    if (parts.length !== 4 || parts[0] !== "F" || !/^0[0-9]$/.test(parts[2]))
      throw new Error("Invalid machine IR field");
    assertId(parts[1]);
    const valueType = Number.parseInt(parts[2], 16) as ValueType;
    if (valueType === ValueType.None && parts[3] !== "-")
      throw new Error("Invalid empty value");
    const data = parts[3] === "-" ? Buffer.alloc(0) : unb64(parts[3]);
    return {
      conceptId: parts[1],
      valueType,
      value: decodeValue(valueType, data),
    };
  });
  for (const f of fields)
    if (f.valueType === ValueType.Ref && (f.value as number) >= fields.length)
      throw new Error("Dangling reference");
  return { peer: peerLine.slice(2), fields };
}
export function emitVamlSource(peer: string, fields: SemanticField[]): string {
  const source =
    [
      "V2",
      "P " + peer,
      ...fields.map(
        (f) =>
          "F " +
          f.conceptId +
          " " +
          f.valueType.toString(16).padStart(2, "0") +
          " " +
          (b64(encodeValue(f.valueType, f.value)) || "-"),
      ),
    ].join("\n") + "\n";
  parseVamlSource(source);
  return source;
}
export function compileVamlSource(
  source: string,
  runtime: VamlSessionRuntime,
): Buffer {
  const input = parseVamlSource(source);
  if (input.peer !== runtime.context.remoteAgentId)
    throw new Error("Peer mismatch");
  return runtime.encode(input.fields);
}
/** Offline compilation emits typed binary IR, never a replayable pre-encrypted session frame. */
export function compileArtifact(source: string): Buffer {
  const input = parseVamlSource(source);
  const peer = Buffer.from(input.peer),
    count = Buffer.alloc(2);
  count.writeUInt16BE(input.fields.length);
  const fields = input.fields.map((f) => {
    const value = encodeValue(f.valueType, f.value),
      header = Buffer.alloc(37);
    unb64(f.conceptId).copy(header);
    header[32] = f.valueType;
    header.writeUInt32BE(value.length, 33);
    return Buffer.concat([header, value]);
  });
  return Buffer.concat([
    Buffer.from([86, 67, 0, 2, peer.length]),
    peer,
    count,
    ...fields,
  ]);
}
export function readArtifact(data: Buffer): CompileInput {
  if (data.length > 1048580) throw new Error("Artifact too large");
  if (!data.subarray(0, 4).equals(Buffer.from([86, 67, 0, 2])))
    return parseVamlSource(
      new TextDecoder("utf8", { fatal: true }).decode(data),
    );
  const peerLength = data[4];
  if (peerLength < 1 || peerLength > 64 || data.length < 7 + peerLength)
    throw new Error("Malformed compiled header");
  const peer = new TextDecoder("utf8", { fatal: true }).decode(
    data.subarray(5, 5 + peerLength),
  );
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(peer)) throw new Error("Invalid peer");
  const count = data.readUInt16BE(5 + peerLength);
  if (count > MAX_FIELDS) throw new Error("Field count limit");
  const fields: SemanticField[] = [];
  let pos = 7 + peerLength;
  for (let i = 0; i < count; i++) {
    if (data.length - pos < 37) throw new Error("Truncated compiled field");
    const conceptId = b64(data.subarray(pos, pos + 32)),
      valueType = data[pos + 32],
      length = data.readUInt32BE(pos + 33);
    pos += 37;
    if (length > data.length - pos)
      throw new Error("Truncated compiled payload");
    fields.push({
      conceptId,
      valueType,
      value: decodeValue(valueType, data.subarray(pos, pos + length)),
    });
    pos += length;
  }
  if (pos !== data.length) throw new Error("Trailing compiled data");
  for (const f of fields)
    if (f.valueType === ValueType.Ref && (f.value as number) >= fields.length)
      throw new Error("Dangling reference");
  return { peer, fields };
}
