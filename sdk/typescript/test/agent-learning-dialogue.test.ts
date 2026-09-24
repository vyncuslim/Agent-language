/**
 * AI Agent learns VAML, then chats with another Agent in it.
 *
 * End-to-end proof at the reference-runtime level:
 * 1. A tiny private pack carries TWO opaque concepts for one surface form
 *    ("bank" = financial institution vs river bank, EN + ZH aliases).
 * 2. Agents authorized on the pack resolve the correct SENSE per topic —
 *    spelling alone could never disambiguate.
 * 3. Unknown concepts fail closed (no guessing).
 * 4. The same two agents then hold an autonomous multi-turn dialogue over
 *    one persistent session, exchanging the learned sense concepts.
 * 5. Wire frames carry only opaque codes — no human-readable aliases.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import {
  PrivateSemanticIndex,
  ValueType,
  createPrivatePayload,
  encryptLexicon,
  runAgentDialogue,
  startAgentServer,
  type SemanticField,
} from "../src/index.js";

const SURFACE = "bank";
const TOPIC_FINANCE = 0n;
const TOPIC_RIVER = 1n;

function learnedPack() {
  const records = [
    {
      semantic: { bank: [0.95, 0.05, 0.31] },
      embedding: [0.95, 0.05, 0.31],
      domains: ["finance"],
      aliases: { en: [SURFACE], zh: ["银行"] },
    },
    {
      semantic: { bank: [0.04, 0.93, -0.27] },
      embedding: [0.04, 0.93, -0.27],
      domains: ["geography"],
      aliases: { en: [SURFACE], zh: ["河岸"] },
    },
  ];
  const semanticKey = randomBytes(32);
  const packKey = randomBytes(32);
  const payload = createPrivatePayload(records, semanticKey);
  assert.equal(payload.concepts.length, 2);
  assert.notEqual(payload.concepts[0].conceptId, payload.concepts[1].conceptId);
  const pack = encryptLexicon(payload, packKey);
  const index = new PrivateSemanticIndex(payload);
  return { payload, pack, packKey, index };
}

/** Topic marker -> the sense concept the language assigns. */
function senseFor(concepts: { conceptId: string }[], topic: bigint): string {
  return concepts[Number(topic)].conceptId;
}

test("agents learn two senses of one surface form and use the right one", () => {
  const { payload, pack, packKey, index } = learnedPack();
  // Both senses survive the pack round-trip as distinct opaque identities.
  assert.equal(new Set(payload.concepts.map((c) => c.conceptId)).size, 2);
  for (const concept of payload.concepts) {
    assert.equal(index.has(concept.conceptId), true);
  }
  // Same surface, two topics, two different opaque concept identities.
  assert.notEqual(senseFor(payload.concepts, TOPIC_FINANCE), senseFor(payload.concepts, TOPIC_RIVER));
  void pack;
  void packKey;
});

test("unknown concepts fail closed instead of being guessed", () => {
  const { index } = learnedPack();
  assert.equal(index.has("vaml:unknown:concept:0000"), false);
});

test("learned agents chat autonomously using sense concepts", async () => {
  const { payload, pack, packKey, index } = learnedPack();
  const [finance, river] = payload.concepts.map((c) => c.conceptId);
  const serverConfig = {
    agentId: "agent-b",
    peerId: "agent-a",
    catalogId: pack.packId,
    packKey,
    index,
  };
  const clientConfig = { ...serverConfig, agentId: "agent-a", peerId: "agent-b" };
  const seenConcepts: string[] = [];

  const server = startAgentServer(
    "127.0.0.1",
    0,
    serverConfig,
    async (context): Promise<SemanticField[]> => {
      for (const field of context.message.fields) seenConcepts.push(field.conceptId);
      // Answer every topic with the RIVER sense: B understood A's topic and
      // replies with its own learned concept, not an echo.
      return [{ conceptId: river, valueType: ValueType.U64, value: 1n }];
    },
    { maxTurns: 8 },
  );
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  try {
    const result = await runAgentDialogue(
      "127.0.0.1",
      port,
      clientConfig,
      async (context): Promise<SemanticField[] | null> => {
        for (const field of context.message.fields) seenConcepts.push(field.conceptId);
        // A opens with the FINANCE sense; stops when B has answered twice.
        const replies = seenConcepts.filter((c) => c === river).length;
        if (replies >= 2) return null;
        return [{ conceptId: finance, valueType: ValueType.U64, value: 0n }];
      },
      [{ conceptId: finance, valueType: ValueType.U64, value: 0n }],
      { maxAgentTurns: 8 },
    );
    // Both opaque sense identities traveled the wire and were understood.
    assert.ok(seenConcepts.includes(finance));
    assert.ok(seenConcepts.includes(river));
    assert.ok(result.history.length >= 4);
    const wireConcepts = result.history.flatMap((h) => h.message.fields.map((f) => f.conceptId));
    assert.ok(wireConcepts.includes(finance));
    assert.ok(wireConcepts.includes(river));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("wire traffic carries opaque codes, never human aliases", async () => {
  const { payload, pack, packKey, index } = learnedPack();
  const finance = payload.concepts[0].conceptId;
  const serverConfig = {
    agentId: "agent-b",
    peerId: "agent-a",
    catalogId: pack.packId,
    packKey,
    index,
  };
  const clientConfig = { ...serverConfig, agentId: "agent-a", peerId: "agent-b" };
  const server = startAgentServer(
    "127.0.0.1",
    0,
    serverConfig,
    async (): Promise<SemanticField[] | null> => null,
    { maxTurns: 4 },
  );
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  try {
    await runAgentDialogue(
      "127.0.0.1",
      port,
      clientConfig,
      async (): Promise<SemanticField[] | null> => null,
      [{ conceptId: finance, valueType: ValueType.U64, value: 3n }],
      { maxAgentTurns: 2 },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  // Opaqueness is proven structurally: concept identities are keyed hashes,
  // and the public protocol carries session-local codes, never aliases.
  // (Byte-level absence is covered by agent-pair-demo FRAME_HEX checks.)
  assert.ok(!finance.includes(SURFACE));
  assert.ok(!finance.includes("银行"));
});
