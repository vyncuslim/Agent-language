import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { PacketChannel, runClient, startServer } from "../src/transport.js";
import { createPrivatePayload, encryptLexicon } from "../src/lexicon.js";
import { PrivateSemanticIndex } from "../src/semantic-index.js";
test("TCP agents negotiate encrypted active set, recover private semantics and reject wrong PSK", async () => {
  const key = randomBytes(32),
    payload = createPrivatePayload(
      [{ semantic: [0.25, 0.75] }],
      randomBytes(32),
    );
  const pack = encryptLexicon(payload, key),
    index = new PrivateSemanticIndex(payload),
    frames: Buffer[] = [];
  const config = {
    agentId: "02",
    peerId: "01",
    catalogId: pack.packId,
    packKey: key,
    index,
  };
  let resolved = 0;
  const server = startServer(
    "127.0.0.1",
    0,
    config,
    (f) => frames.push(f),
    (n) => (resolved += n),
  );
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    const input = {
      peer: "02",
      fields: [
        { conceptId: payload.concepts[0].conceptId, valueType: 1, value: 7n },
      ],
    };
    const a = { ...config, agentId: "01", peerId: "02" };
    assert.deepEqual(
      await runClient("127.0.0.1", port, input, a),
      input.fields,
    );
    assert.equal(resolved, 1);
    assert.ok(
      frames.every(
        (f) => !f.includes(Buffer.from(payload.concepts[0].conceptId)),
      ),
    );
    await assert.rejects(() =>
      runClient("127.0.0.1", port, input, { ...a, packKey: randomBytes(32) }),
    );
    assert.equal(resolved, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("TCP packet parser rejects oversized advertised length before allocation", async () => {
  let receiver: Promise<Buffer> | undefined;
  const server = createServer((socket) => {
    const channel = new PacketChannel(socket);
    receiver = channel.receive();
    receiver.catch(() => {});
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = createConnection({
    port: (server.address() as AddressInfo).port,
    host: "127.0.0.1",
  });
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write(Buffer.from([0xff, 0xff, 0xff, 0xff]));
  try {
    await assert.rejects(receiver!, /size limit/);
  } finally {
    socket.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("TCP parser handles fragmented header/body and rejects truncated EOF", async () => {
  let channels: PacketChannel[] = [];
  let notify: () => void = () => {};
  const server = createServer((socket) => {
    channels.push(new PacketChannel(socket));
    notify();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = createConnection({
    port: (server.address() as AddressInfo).port,
    host: "127.0.0.1",
  });
  await once(socket, "connect");
  if (!channels.length) await new Promise<void>((r) => (notify = r));
  try {
    const received = channels[0].receive();
    socket.write(Buffer.from([0, 0]));
    socket.write(Buffer.from([0, 3, 7]));
    socket.write(Buffer.from([8, 9]));
    assert.deepEqual(await received, Buffer.from([7, 8, 9]));
    const truncated = channels[0].receive();
    socket.end(Buffer.from([0, 0, 0, 5, 1]));
    await assert.rejects(truncated, /truncated|closed/);
  } finally {
    socket.destroy();
    channels.forEach((c) => c.socket.destroy());
    await new Promise<void>((r) => server.close(() => r()));
  }
});
