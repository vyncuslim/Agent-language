import { Socket, createConnection, createServer } from "node:net";
import { once } from "node:events";
import { assertKey, b64, deriveKey, unb64 } from "./crypto.js";
import {
  beginHandshake,
  defaultManifest,
  finishHandshake,
  verifyConfirmation,
  MAX_ACTIVE,
  type ConceptResolver,
} from "./negotiation.js";
import { VamlSessionRuntime } from "./runtime.js";
import {
  ValueType,
  type CompileInput,
  type HandshakeHello,
  type SemanticField,
} from "./types.js";
const MAX_PACKET = 1048576;
/** Length-prefixed TCP packets. Bounded queue, timeout, truncation detection and backpressure. */
export class PacketChannel {
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private body: Buffer | undefined;
  private used = 0;
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private failure: Error | undefined;
  private cleanEnd = false;
  private waiter:
    { resolve: (b: Buffer) => void; reject: (e: Error) => void } | undefined;
  constructor(readonly socket: Socket) {
    socket.setTimeout(10000, () =>
      socket.destroy(new Error("Transport timeout")),
    );
    socket.on("error", (e) => this.fail(e));
    socket.on("end", () => {
      if (this.body || this.headerUsed) {
        this.fail(new Error("Transport ended or truncated"));
        return;
      }
      this.cleanEnd = true;
      this.failure = new Error("Transport ended");
      this.waiter?.reject(this.failure);
      this.waiter = undefined;
    });
    socket.on("close", () => {
      if (!this.cleanEnd) this.fail(new Error("Transport closed"));
    });
    socket.on("data", (chunk) => {
      try {
        this.consume(chunk);
      } catch (e) {
        socket.destroy(e as Error);
      }
    });
  }
  private fail(e: Error): void {
    this.failure = e;
    this.queue = [];
    this.queuedBytes = 0;
    this.body = undefined;
    this.waiter?.reject(e);
    this.waiter = undefined;
  }
  private consume(chunk: Buffer): void {
    let pos = 0;
    while (pos < chunk.length) {
      if (!this.body) {
        const n = Math.min(4 - this.headerUsed, chunk.length - pos);
        chunk.copy(this.header, this.headerUsed, pos, pos + n);
        this.headerUsed += n;
        pos += n;
        if (this.headerUsed < 4) continue;
        const length = this.header.readUInt32BE();
        this.headerUsed = 0;
        if (length < 1 || length > MAX_PACKET)
          throw new Error("Packet size limit");
        this.body = Buffer.alloc(length);
        this.used = 0;
      }
      const n = Math.min(this.body.length - this.used, chunk.length - pos);
      chunk.copy(this.body, this.used, pos, pos + n);
      this.used += n;
      pos += n;
      if (this.used === this.body.length) {
        const packet = this.body;
        this.body = undefined;
        if (this.waiter) {
          const w = this.waiter;
          this.waiter = undefined;
          w.resolve(packet);
        } else {
          this.queuedBytes += packet.length;
          this.queue.push(packet);
          if (this.queue.length > 8 || this.queuedBytes > 2 * MAX_PACKET)
            throw new Error("Receive queue limit");
        }
      }
    }
  }
  receive(): Promise<Buffer> {
    const p = this.queue.shift();
    if (p) {
      this.queuedBytes -= p.length;
      return Promise.resolve(p);
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.waiter) return Promise.reject(new Error("Concurrent receive"));
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }
  async send(data: Buffer): Promise<void> {
    if (this.failure) throw this.failure;
    if (!data.length || data.length > MAX_PACKET)
      throw new Error("Packet size limit");
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    if (!this.socket.write(Buffer.concat([size, data])))
      await once(this.socket, "drain");
  }
}
export function encodeHello(h: HandshakeHello): Buffer {
  const id = Buffer.from(h.agentId),
    limits = Buffer.alloc(7);
  limits.writeUInt32BE(h.manifest.maxFrameBytes);
  limits.writeUInt16BE(
    h.manifest.valueTypes.reduce((n, v) => n | (1 << v), 0),
    4,
  );
  limits[6] = 127;
  return Buffer.concat([
    Buffer.from([86, 50, 0, 2, id.length]),
    id,
    unb64(h.ephemeralPublicKey),
    unb64(h.nonce),
    Buffer.from([h.manifest.packIds.length]),
    ...h.manifest.packIds.map(unb64),
    limits,
  ]);
}
export function decodeHello(data: Buffer): HandshakeHello {
  if (
    data.length < 90 ||
    data.length > 1200 ||
    data[0] !== 86 ||
    data[1] !== 50 ||
    data[2] !== 0 ||
    data[3] !== 2
  )
    throw new Error("Invalid binary hello");
  const n = data[4];
  let pos = 5;
  if (n < 1 || n > 64) throw new Error("Invalid peer");
  const agentId = data.subarray(pos, pos + n).toString("ascii");
  pos += n;
  const ephemeralPublicKey = b64(data.subarray(pos, pos + 44));
  pos += 44;
  const nonce = b64(data.subarray(pos, pos + 32));
  pos += 32;
  const count = data[pos++];
  if (count < 1 || count > 32 || data.length !== pos + count * 32 + 7)
    throw new Error("Invalid hello length");
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(b64(data.subarray(pos, pos + 32)));
    pos += 32;
  }
  const manifest = defaultManifest(ids);
  manifest.maxFrameBytes = data.readUInt32BE(pos);
  const mask = data.readUInt16BE(pos + 4);
  if (mask === 0 || mask > 1023 || data[pos + 6] !== 127)
    throw new Error("Handshake downgrade rejected");
  manifest.valueTypes = Array.from({ length: 10 }, (_, i) => i).filter(
    (i) => mask & (1 << i),
  );
  const hello: HandshakeHello = {
    protocol: "VAML",
    version: "0.2",
    agentId,
    ephemeralPublicKey,
    nonce,
    manifest,
  };
  if (!encodeHello(hello).equals(data))
    throw new Error("Noncanonical binary hello");
  return hello;
}
export interface NetworkConfig {
  agentId: string;
  peerId: string;
  catalogId: string;
  packKey: Uint8Array;
  index: ConceptResolver & { semantic(id: string): unknown };
}
export async function negotiate(channel: PacketChannel, config: NetworkConfig) {
  assertKey(config.packKey);
  const pending = beginHandshake(
    config.agentId,
    defaultManifest([config.catalogId]),
  );
  await channel.send(encodeHello(pending.hello));
  const hello = decodeHello(await channel.receive());
  const auth = deriveKey(
    config.packKey,
    Buffer.alloc(32),
    "VAML-0.2/network-peer-auth",
  );
  let session;
  try {
    session = finishHandshake(
      pending,
      hello,
      config.index,
      auth,
      config.peerId,
    );
  } finally {
    auth.fill(0);
  }
  await channel.send(unb64(session.confirmationTag));
  try {
    verifyConfirmation(session, b64(await channel.receive()));
  } catch (e) {
    for (const key of Object.values(session.context.keys)) key.fill(0);
    throw e;
  }
  return {
    session,
    runtime: new VamlSessionRuntime(
      session.context,
      session.conceptToCode,
      session.codeToConcept,
    ),
  };
}
export async function runClient(
  host: string,
  port: number,
  input: CompileInput,
  config: NetworkConfig,
  onFrame: (frame: Buffer) => void = () => {},
): Promise<SemanticField[]> {
  if (input.peer !== config.peerId) throw new Error("Source peer mismatch");
  // The sending agent resolves its own machine representation before compiling intent.
  for (const field of input.fields) config.index.semantic(field.conceptId);
  const socket = createConnection({ host, port });
  const channel = new PacketChannel(socket);
  const deadline = setTimeout(
    () => socket.destroy(new Error("Connection deadline")),
    15000,
  );
  let runtime: VamlSessionRuntime | undefined;
  try {
    await once(socket, "connect");
    const connected = await negotiate(channel, config);
    runtime = connected.runtime;
    const ids = [
      ...new Set(
        input.fields.flatMap((f) =>
          f.valueType === ValueType.Concept
            ? [f.conceptId, f.value as string]
            : [f.conceptId],
        ),
      ),
    ];
    connected.session.activate(ids);
    const active = runtime.seal(Buffer.concat(ids.map(unb64)), 1);
    onFrame(active);
    await channel.send(active);
    if (runtime.open(await channel.receive(), 2).length !== 0)
      throw new Error("Invalid active set acknowledgement");
    const frame = runtime.encode(input.fields);
    onFrame(frame);
    await channel.send(frame);
    const reply = await channel.receive();
    onFrame(reply);
    return runtime.decode(reply);
  } finally {
    clearTimeout(deadline);
    runtime?.close();
    socket.destroy();
  }
}
/** One bounded request per connection. Semantic receipt does not authorize tool execution. */
export function startServer(
  host: string,
  port: number,
  config: NetworkConfig,
  onFrame: (frame: Buffer) => void = () => {},
  onReceipt: (count: number) => void = () => {},
) {
  let active = 0;
  const server = createServer((socket) => {
    if (active >= 16) {
      socket.destroy();
      return;
    }
    active++;
    const deadline = setTimeout(
      () => socket.destroy(new Error("Connection deadline")),
      15000,
    );
    const channel = new PacketChannel(socket);
    void (async () => {
      let runtime: VamlSessionRuntime | undefined;
      try {
        const connected = await negotiate(channel, config);
        runtime = connected.runtime;
        const encrypted = await channel.receive();
        onFrame(encrypted);
        const activeSet = runtime.open(encrypted, 1);
        if (activeSet.length % 32 !== 0 || activeSet.length > MAX_ACTIVE * 32)
          throw new Error("Invalid active set");
        const ids: string[] = [];
        for (let i = 0; i < activeSet.length; i += 32)
          ids.push(b64(activeSet.subarray(i, i + 32)));
        connected.session.activate(ids);
        await channel.send(runtime.seal(Buffer.alloc(0), 2));
        const frame = await channel.receive();
        onFrame(frame);
        const fields = runtime.decode(frame);
        for (const field of fields) config.index.semantic(field.conceptId);
        onReceipt(fields.length);
        const response = runtime.encode(fields);
        onFrame(response);
        await channel.send(response);
        socket.end();
      } catch {
        socket.destroy();
      } finally {
        clearTimeout(deadline);
        runtime?.close();
        active--;
      }
    })();
  });
  server.listen(port, host);
  return server;
}
