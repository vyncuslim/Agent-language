import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { AdaptiveSemanticMemory } from "../src/adaptive-memory.js";
import { EncryptedUtf8ChatCodec, LearningChatAgent } from "../src/chat-learning.js";
import { conceptId, createPrivatePayload } from "../src/lexicon.js";
import { PrivateSemanticIndex } from "../src/semantic-index.js";

function embed(text: string): number[] {
  let a = 0, b = 0, c = 0, d = 0;
  for (let i = 0; i < text.length; i++) {
    const n = text.charCodeAt(i);
    a += n;
    b += n * (i + 1);
    c += (n % 17) - 8;
    d += (n % 31) - 15;
  }
  const norm = Math.hypot(a, b, c, d) || 1;
  return [a / norm, b / norm, c / norm, d / norm];
}

function fixture() {
  const semanticKey = randomBytes(32);
  const learningKey = randomBytes(32);
  const record = { semantic: { kind: "private-chat-utterance", version: 1 }, embedding: [1, 0, 0, 0] };
  const id = conceptId(semanticKey, record);
  const index = new PrivateSemanticIndex(createPrivatePayload([record], semanticKey));
  const memory = new AdaptiveSemanticMemory(index, learningKey, { promotionExposure: 2, promotionConfidence: 0.5 });
  return { id, memory, semanticKey, learningKey };
}

test("EncryptedUtf8ChatCodec round-trips one encrypted-chat semantic field", async () => {
  const { id, semanticKey, learningKey } = fixture();
  try {
    const codec = new EncryptedUtf8ChatCodec(id, embed);
    const encoded = await codec.encode("Hello agent");
    const decoded = await codec.decode(encoded.fields);
    assert.equal(decoded.text, "Hello agent");
    assert.deepEqual(decoded.fields, encoded.fields);
    assert.equal(decoded.vector?.length, 4);
  } finally {
    semanticKey.fill(0);
    learningKey.fill(0);
  }
});

test("LearningChatAgent chats and updates adaptive semantic memory", async () => {
  const { id, memory, semanticKey, learningKey } = fixture();
  const restoreKey = randomBytes(32);
  let restoredMemory: AdaptiveSemanticMemory | undefined;
  try {
    const agent = new LearningChatAgent({
      codec: new EncryptedUtf8ChatCodec(id, embed),
      memory,
      learningDomain: "chat",
      model: ({ message, learnedConceptIds }) => `reply:${message}:${learnedConceptIds.length}`,
    });
    const first = await agent.chat("hello");
    assert.match(first, /^reply:hello:/);
    const second = await agent.chat("hello again");
    assert.match(second, /^reply:hello again:/);
    assert.equal(agent.history().length, 4);
    assert.ok(memory.snapshot().concepts.length >= 1);

    const snapshot = agent.snapshot();
    restoredMemory = new AdaptiveSemanticMemory(memory.base, restoreKey, { promotionExposure: 2, promotionConfidence: 0.5 });
    const restored = new LearningChatAgent({
      codec: new EncryptedUtf8ChatCodec(id, embed),
      memory: restoredMemory,
      model: ({ message }) => message,
    });
    restored.restore(snapshot);
    assert.equal(restored.history().length, 4);
    assert.deepEqual(restored.snapshot().memory, snapshot.memory);
  } finally {
    restoredMemory?.close();
    memory.close();
    semanticKey.fill(0);
    learningKey.fill(0);
    restoreKey.fill(0);
  }
});

test("LearningChatAgent brain decodes, learns, models and re-encodes", async () => {
  const { id, memory, semanticKey, learningKey } = fixture();
  try {
    const codec = new EncryptedUtf8ChatCodec(id, embed);
    const agent = new LearningChatAgent({ codec, memory, model: ({ message }) => `agent:${message}` });
    const incoming = await codec.encode("ping");
    const brain = agent.brain();
    const fields = await brain({
      agentId: "A",
      peerId: "B",
      sessionId: 1n,
      conversationId: "conversation",
      message: {
        conversationId: "conversation",
        messageId: "message",
        createdAtMs: Date.now(),
        fields: incoming.fields,
      },
      history: [],
    });
    assert.ok(fields);
    const decoded = await codec.decode(fields);
    assert.equal(decoded.text, "agent:ping");
    assert.equal(agent.history().length, 2);
  } finally {
    memory.close();
    semanticKey.fill(0);
    learningKey.fill(0);
  }
});
