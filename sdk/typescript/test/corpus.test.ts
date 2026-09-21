import test from "node:test";
import assert from "node:assert/strict";
import {
  WorldSemanticCorpusAssembler,
  type CorpusSourceDescriptor,
} from "../src/index.js";

const sources: CorpusSourceDescriptor[] = [
  {
    id: "source-a",
    kind: "dictionary",
    license: "TEST-ONLY",
    redistribution: "private-only",
    embeddingSpace: "test-space",
  },
  {
    id: "agent-native-generator",
    kind: "agent-native",
    license: "TEST-ONLY",
    redistribution: "private-only",
    embeddingSpace: "test-space",
  },
];

test("corpus assembler merges multilingual aliases into one private concept", () => {
  const assembler = new WorldSemanticCorpusAssembler(sources);
  assert.equal(
    assembler.push({
      kind: "lexeme",
      alignmentKey: "private:0001",
      sourceId: "source-a",
      sourceSenseId: "a-1",
      language: "en",
      lexeme: "synthetic-one",
      aliases: ["synthetic-1"],
      embedding: [1, 0],
    }),
    undefined,
  );
  assert.equal(
    assembler.push({
      kind: "lexeme",
      alignmentKey: "private:0001",
      sourceId: "source-a",
      sourceSenseId: "a-1b",
      language: "ms",
      lexeme: "sintetik-satu",
      embedding: [1, 0],
    }),
    undefined,
  );
  const concept = assembler.finish();
  assert.ok(concept);
  assert.deepEqual(concept.aliases?.en, ["synthetic-1", "synthetic-one"]);
  assert.deepEqual(concept.aliases?.ms, ["sintetik-satu"]);
  assert.deepEqual(concept.embedding, [1, 0]);
  assert.equal(assembler.stats().concepts, 1);
  assert.equal(assembler.stats().languages, 2);
});

test("agent-native concepts need no human-language alias", () => {
  const assembler = new WorldSemanticCorpusAssembler(sources);
  assembler.push({
    kind: "agent-native",
    alignmentKey: "private:latent:0001",
    sourceId: "agent-native-generator",
    prototype: [0.25, 0.75],
    domains: ["synthetic-test"],
  });
  const concept = assembler.finish();
  assert.ok(concept);
  assert.equal(concept.aliases, undefined);
  assert.deepEqual(concept.embedding, [0.25, 0.75]);
  assert.equal(assembler.stats().agentNativeRows, 1);
});

test("corpus assembler rejects unsorted input", () => {
  const assembler = new WorldSemanticCorpusAssembler(sources);
  assembler.push({
    kind: "lexeme",
    alignmentKey: "private:0002",
    sourceId: "source-a",
    language: "en",
    lexeme: "synthetic-two",
  });
  assembler.push({
    kind: "lexeme",
    alignmentKey: "private:0003",
    sourceId: "source-a",
    language: "en",
    lexeme: "synthetic-three",
  });
  assert.throws(
    () =>
      assembler.push({
        kind: "lexeme",
        alignmentKey: "private:0001",
        sourceId: "source-a",
        language: "en",
        lexeme: "synthetic-one",
      }),
    /sorted by alignmentKey/,
  );
});

test("unknown corpus source is rejected", () => {
  const assembler = new WorldSemanticCorpusAssembler(sources);
  assert.throws(
    () =>
      assembler.push({
        kind: "lexeme",
        alignmentKey: "private:0001",
        sourceId: "not-registered",
        language: "en",
        lexeme: "synthetic",
      }),
    /Unknown corpus source/,
  );
});
