import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  ValueType,
  VamlSessionRuntime,
  beginHandshake,
  createPrivatePayload,
  defaultManifest,
  encryptLexicon,
  finishHandshake,
  type ConceptSourceRecord,
} from "../src/index.js";

function setup() {
  const records: ConceptSourceRecord[] = [
    { semantic: { z: [0.11, 0.73, -0.41] }, embedding: [0.11, 0.73, -0.41], domains: ["x"] },
    { semantic: { z: [-0.87, 0.22, 0.49] }, embedding: [-0.87, 0.22, 0.49], domains: ["x"] },
  ];
  const lexicon = createPrivatePayload(records, randomBytes(32));
  const pack = encryptLexicon(lexicon, randomBytes(32));
  const aPending = beginHandshake("a", defaultManifest([pack.packId]));
  const bPending = beginHandshake("b", defaultManifest([pack.packId]));
  const aSession = finishHandshake(aPending, bPending.hello, lexicon);
  const bSession = finishHandshake(bPending, aPending.hello, lexicon);
  return { lexicon, aSession, bSession };
}

test("two agents derive the same session codebook and decrypt frames", () => {
  const { lexicon, aSession, bSession } = setup();
  const concept = lexicon.concepts[0].conceptId;
  assert.equal(aSession.conceptToCode.get(concept), bSession.conceptToCode.get(concept));

  const a = new VamlSessionRuntime(aSession.context, aSession.conceptToCode, aSession.codeToConcept);
  const b = new VamlSessionRuntime(bSession.context, bSession.conceptToCode, bSession.codeToConcept);
  const encoded = a.encode([{ conceptId: concept, valueType: ValueType.U64, value: 42n }]);
  const decoded = b.decode(encoded);
  assert.equal(decoded[0].conceptId, concept);
  assert.equal(decoded[0].value, 42n);
});

test("replay is rejected", () => {
  const { lexicon, aSession, bSession } = setup();
  const concept = lexicon.concepts[0].conceptId;
  const a = new VamlSessionRuntime(aSession.context, aSession.conceptToCode, aSession.codeToConcept);
  const b = new VamlSessionRuntime(bSession.context, bSession.conceptToCode, bSession.codeToConcept);
  const encoded = a.encode([{ conceptId: concept, valueType: ValueType.None }]);
  b.decode(encoded);
  assert.throws(() => b.decode(encoded), /Replay|out-of-order/);
});

test("fresh sessions produce fresh wire codes", () => {
  const first = setup();
  const second = setup();
  // Different semantic keys also produce different concept IDs; verify sessions are independently randomized.
  const firstCode = [...first.aSession.conceptToCode.values()][0];
  const secondCode = [...second.aSession.conceptToCode.values()][0];
  assert.notEqual(firstCode, secondCode);
});
