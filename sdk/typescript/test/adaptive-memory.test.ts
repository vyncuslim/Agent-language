import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  AdaptiveSemanticMemory,
  PrivateSemanticIndex,
  createPrivatePayload,
} from "../src/index.js";

function makeBaseIndex() {
  const payload = createPrivatePayload(
    [
      {
        semantic: { machine: [1, 0] },
        embedding: [1, 0],
        domains: ["synthetic"],
      },
    ],
    randomBytes(32),
  );
  return { payload, index: new PrivateSemanticIndex(payload) };
}

test("adaptive memory creates a private agent-native concept and promotes only after repeated evidence", () => {
  const { index } = makeBaseIndex();
  const memory = new AdaptiveSemanticMemory(index, randomBytes(32), {
    similarityThreshold: 0.95,
    promotionExposure: 3,
    promotionConfidence: 0.7,
  });

  const first = memory.learn({
    vector: [0, 1],
    outcome: "positive",
    domain: "agent-private",
    evidenceDigest: "event-1",
  });

  assert.equal(first.created, true);
  assert.equal(first.promoted, false);
  assert.equal(memory.has(first.conceptId), false);
  assert.ok(memory.get(first.conceptId));
  assert.throws(() => memory.semantic(first.conceptId), /unpromoted/);

  const second = memory.learn({
    vector: [0, 1],
    outcome: "positive",
    evidenceDigest: "event-2",
  });
  const third = memory.learn({
    vector: [0, 1],
    outcome: "positive",
    evidenceDigest: "event-3",
  });

  assert.equal(second.conceptId, first.conceptId);
  assert.equal(third.conceptId, first.conceptId);
  assert.equal(third.promoted, true);
  assert.equal(memory.has(first.conceptId), true);
  assert.deepEqual(
    (memory.semantic(first.conceptId) as { kind: string }).kind,
    "agent-native",
  );

  const nearest = memory.nearest([0, 1], 1);
  assert.equal(nearest[0].conceptId, first.conceptId);
  assert.ok(nearest[0].score > 0.99);

  memory.close();
});

test("adaptive memory restores learned concepts and learned-to-learned relations", () => {
  const { index } = makeBaseIndex();
  const memory = new AdaptiveSemanticMemory(index, randomBytes(32), {
    similarityThreshold: 0.99,
    promotionExposure: 1,
    promotionConfidence: 0.5,
  });

  const first = memory.learn({ vector: [0, 1], outcome: "positive" });
  const second = memory.learn({
    vector: [0, -1],
    outcome: "positive",
    relatedConceptIds: [first.conceptId],
  });

  assert.equal(first.promoted, true);
  assert.equal(second.promoted, true);

  const snapshot = memory.snapshot();
  const restored = new AdaptiveSemanticMemory(index, randomBytes(32), {
    similarityThreshold: 0.99,
    promotionExposure: 1,
    promotionConfidence: 0.5,
  });
  restored.restore(snapshot);

  assert.equal(restored.has(first.conceptId), true);
  assert.equal(restored.has(second.conceptId), true);
  assert.deepEqual(restored.state(second.conceptId)?.relatedConceptIds, [first.conceptId]);
  assert.equal(restored.fingerprint(), memory.fingerprint());

  memory.close();
  restored.close();
});

test("adaptive memory never replaces an existing base concept when reinforcing it", () => {
  const { payload, index } = makeBaseIndex();
  const memory = new AdaptiveSemanticMemory(index, randomBytes(32));
  const conceptId = payload.concepts[0].conceptId;

  const result = memory.learn({ conceptId, weight: 2, outcome: "positive" });
  assert.equal(result.conceptId, conceptId);
  assert.equal(result.created, false);
  assert.equal(result.promoted, true);
  assert.equal(memory.snapshot().concepts.length, 0);

  memory.close();
});
