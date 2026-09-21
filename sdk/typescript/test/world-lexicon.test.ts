import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  AgentSemanticLearner,
  PrivateSemanticIndex,
  WorldConceptAssembler,
  createPrivatePayload,
  decryptLexicon,
  makePack,
  type ConceptSourceRecord,
} from "../src/index.js";

test("world lexicon assembler groups multilingual forms without exposing a public registry", () => {
  const assembler = new WorldConceptAssembler();
  const emitted: ConceptSourceRecord[] = [];
  const accept = (value: ConceptSourceRecord | undefined): void => {
    if (value) emitted.push(value);
  };

  accept(assembler.push({ conceptKey: "c-0001", language: "en-x-test", lexeme: "lx-01", semantic: { v: [1, 4, 9] } }));
  accept(assembler.push({ conceptKey: "c-0001", language: "en-x-test", lexeme: "lx-02", semantic: { v: [1, 4, 9] } }));
  accept(assembler.push({ conceptKey: "c-0002", language: "en-x-test", lexeme: "lx-03", semantic: { v: [2, 8, 1] } }));
  accept(assembler.finish());

  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted[0]?.aliases?.["en-x-test"], ["lx-01", "lx-02"]);
  assert.deepEqual(assembler.stats(), { sourceRows: 3, concepts: 2, languages: 1, surfaceForms: 3 });
});

test("world lexicon input must be grouped and sorted by private concept key", () => {
  const assembler = new WorldConceptAssembler();
  assembler.push({ conceptKey: "c-0002", language: "en-x-test", lexeme: "lx-02" });
  assert.throws(
    () => assembler.push({ conceptKey: "c-0001", language: "en-x-test", lexeme: "lx-01" }),
    /sorted by conceptKey/,
  );
});

test("agent learner can resolve private concepts after encrypted-pack authorization", () => {
  const semanticKey = randomBytes(32);
  const packKey = randomBytes(32);
  const records: ConceptSourceRecord[] = [
    { semantic: { z: 11 }, aliases: { "en-x-test": ["lx-11"] }, domains: [], embedding: [1, 0, 0] },
    { semantic: { z: 22 }, aliases: { "en-x-test": ["lx-22"] }, domains: [], embedding: [0, 1, 0] },
  ];

  const pack = makePack(records, semanticKey, packKey);
  const payload = decryptLexicon(pack, packKey);
  const index = new PrivateSemanticIndex(payload);
  const learner = new AgentSemanticLearner(index);

  const lexical = learner.resolve({ language: "en-x-test", lexeme: "lx-11" });
  assert.equal(lexical.length, 1);
  assert.equal(lexical[0]?.source, "private-alias");

  const vector = learner.resolve({ vector: [0.99, 0.01, 0] });
  assert.equal(vector[0]?.conceptId, lexical[0]?.conceptId);

  const first = lexical[0]?.conceptId;
  const second = index.resolveAlias("en-x-test", "lx-22")[0];
  assert.ok(first);
  assert.ok(second);
  learner.observe(first);
  learner.associate(first, second, 3);
  assert.equal(learner.related(first)[0]?.conceptId, second);

  const snapshot = learner.snapshot();
  const restored = new AgentSemanticLearner(new PrivateSemanticIndex(createPrivatePayload(records, semanticKey)));
  restored.restore(snapshot);
  assert.equal(restored.fingerprint(), learner.fingerprint());
});
