import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_PACK_1_DESCRIPTORS,
  alignSourcePack1Candidates,
  uniMorphCandidates,
  unimorphDescriptor,
  wikidataCandidates,
  wiktionaryCandidates,
  wordNetCandidates,
} from "../src/index.js";

test("WordNet adapter emits general vocabulary candidates", () => {
  const rows = [...wordNetCandidates([{ synset: "n0001", pos: "noun", lemmas: ["alpha", "alpha_alias"], gloss: "synthetic" }])];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceId, "wordnet-3.0");
  assert.equal(rows[0].category, "general-vocabulary");
  assert.deepEqual(rows[0].aliases, ["alpha_alias"]);
});

test("Wiktionary adapter keeps forms at the ingress edge", () => {
  const rows = [...wiktionaryCandidates([{ entryId: "e1", senseId: "s1", language: "ms", lemma: "uji", forms: ["ujian"], partOfSpeech: "noun" }])];
  assert.deepEqual(rows[0].aliases, ["ujian"]);
  assert.equal(rows[0].language, "ms");
});

test("UniMorph source requires an explicit resolved license", () => {
  assert.throws(() => unimorphDescriptor({ id: "um-x", language: "x-test", license: "UNRESOLVED" }), /verified per-dataset license/);
  const descriptor = unimorphDescriptor({ id: "um-en", language: "en", license: "CC-BY-SA-3.0" });
  assert.equal(descriptor.kind, "morphology");
  const rows = [...uniMorphCandidates([{ lemma: "walk", form: "walked", features: "V;PST" }], "um-en", "en")];
  assert.equal(rows[0].category, "morphology");
});

test("Wikidata profile can feed entity, science/math or programming concepts", () => {
  const rows = [...wikidataCandidates([{ id: "Q1", labels: { en: "Synthetic entity", zh: "合成实体" }, aliases: { en: ["Test entity"] }, instanceOf: ["QX"], category: "science-math" }])];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.category === "science-math"));
  assert.ok(rows.every((row) => row.sourceId === "wikidata-cc0"));
});

test("private aligner converts candidates into CorpusRow without public fixed opcodes", async () => {
  const candidates = wordNetCandidates([{ synset: "n0001", pos: "noun", lemmas: ["alpha"] }]);
  const rows = [];
  for await (const row of alignSourcePack1Candidates(candidates, { resolve: (candidate) => `private:${candidate.sourceId}:${candidate.sourceSenseId}` })) rows.push(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "lexeme");
  assert.match(rows[0].alignmentKey, /^private:/);
});

test("pack descriptors use conservative redistribution defaults", () => {
  assert.equal(SOURCE_PACK_1_DESCRIPTORS["wikidata-cc0"].license, "CC0-1.0");
  assert.equal(SOURCE_PACK_1_DESCRIPTORS["wiktionary-extract"].redistribution, "private-only");
});
