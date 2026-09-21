import test from "node:test";
import assert from "node:assert/strict";
import {
  WorldSemanticCorpusAssembler,
  readCorpusSourceAdapter,
  type CorpusSourceAdapter,
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
    id: "source-b",
    kind: "terminology",
    license: "TEST-ONLY",
    redistribution: "private-only",
    embeddingSpace: "other-space",
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

test("multiple embedding spaces remain private metadata instead of being mixed", () => {
  const assembler = new WorldSemanticCorpusAssembler(sources);
  assembler.push({
    kind: "lexeme",
    alignmentKey: "private:multi-vector",
    sourceId: "source-a",
    language: "en",
    lexeme: "synthetic-a",
    embedding: [1, 0],
  });
  assembler.push({
    kind: "lexeme",
    alignmentKey: "private:multi-vector",
    sourceId: "source-b",
    language: "en",
    lexeme: "synthetic-b",
    embedding: [0, 1],
  });
  const concept = assembler.finish();
  assert.ok(concept);
  assert.equal(concept.embedding, undefined);
  const corpus = (concept.metadata?.corpus ?? {}) as {
    vectorSpaces?: string[];
    vectorCentroids?: Record<string, number[]>;
  };
  assert.deepEqual(corpus.vectorSpaces, ["other-space", "test-space"]);
  assert.deepEqual(corpus.vectorCentroids?.["test-space"], [1, 0]);
  assert.deepEqual(corpus.vectorCentroids?.["other-space"], [0, 1]);
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

test("source adapter enforces descriptor source identity", async () => {
  const adapter: CorpusSourceAdapter = {
    descriptor: sources[0],
    async *rows() {
      yield {
        kind: "lexeme",
        alignmentKey: "private:adapter",
        sourceId: "source-b",
        language: "en",
        lexeme: "synthetic-adapter",
      };
    },
  };

  await assert.rejects(async () => {
    for await (const _row of readCorpusSourceAdapter(adapter)) {
      // Iteration triggers adapter validation.
    }
  }, /different source/);
});
