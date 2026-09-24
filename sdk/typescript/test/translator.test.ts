/**
 * Official translator boundary tests: a stub HTTP server plays the exact
 * Agent-language-Translate contract ({direction, input} -> {output}).
 * Proves request shape, validation, auth forwarding, error mapping, and
 * that NOTHING is ever translated locally (no endpoint -> hard failure).
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { translateViaEndpoint } from "../src/index.js";

interface Seen {
  direction?: unknown;
  input?: unknown;
  authorization?: string;
}

function stubTranslator(behavior: (body: Record<string, unknown>, seen: Seen) => { status: number; json: unknown }) {
  const seen: Seen = {};
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // leave empty
      }
      seen.direction = body["direction"];
      seen.input = body["input"];
      const auth = req.headers.authorization;
      if (typeof auth === "string") seen.authorization = auth;
      const { status, json } = behavior(body, seen);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  return { server, seen };
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return `http://127.0.0.1:${port}/api/translate`;
}

test("vaml-to-human posts the exact boundary contract", async () => {
  const { server, seen } = stubTranslator(() => ({ status: 200, json: { output: "你好" } }));
  const url = await listen(server);
  try {
    const out = await translateViaEndpoint(url, "vaml-to-human", "VAMLTXT1.test", { token: "tok123" });
    assert.equal(out, "你好");
    assert.equal(seen.direction, "vaml-to-human");
    assert.equal(seen.input, "VAMLTXT1.test");
    assert.equal(seen.authorization, "Bearer tok123");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("human-to-vaml round-trips and accepts output field variants", async () => {
  const { server } = stubTranslator((body) => {
    assert.equal(body["direction"], "human-to-vaml");
    return { status: 200, json: { translation: `VAML(${String(body["input"]).length})` } };
  });
  const url = await listen(server);
  try {
    assert.equal(await translateViaEndpoint(url, "human-to-vaml", "你好世界"), "VAML(4)");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("client validates before any network use", async () => {
  await assert.rejects(() => translateViaEndpoint("notaurl", "vaml-to-human", "x"), /endpoint/);
  await assert.rejects(() => translateViaEndpoint("http://127.0.0.1:1/", "sideways" as never, "x"), /direction/);
  await assert.rejects(() => translateViaEndpoint("http://127.0.0.1:1/", "vaml-to-human", "   "), /input/);
  await assert.rejects(
    () => translateViaEndpoint("http://127.0.0.1:1/", "vaml-to-human", "x".repeat(32769)),
    /input/,
  );
});

test("backend failures surface without local guessing", async () => {
  const { server } = stubTranslator(() => ({ status: 503, json: { error: "backend down" } }));
  const url = await listen(server);
  try {
    await assert.rejects(() => translateViaEndpoint(url, "vaml-to-human", "VAMLTXT1.x"), /backend down/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const empty = stubTranslator(() => ({ status: 200, json: {} }));
  const url2 = await listen(empty.server);
  try {
    await assert.rejects(() => translateViaEndpoint(url2, "vaml-to-human", "VAMLTXT1.x"), /no output/);
  } finally {
    await new Promise<void>((resolve) => empty.server.close(() => resolve()));
  }
  await assert.rejects(
    () => translateViaEndpoint("http://127.0.0.1:1/", "vaml-to-human", "VAMLTXT1.x", { timeoutMs: 2000 }),
    /unreachable/,
  );
});
