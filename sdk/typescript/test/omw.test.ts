import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OmwTabSourceAdapter,
  PrivateImportAliases,
  ShardedSemanticIndex,
  WorldSemanticCorpusAssembler,
  buildVocabulary,
  conceptId,
  parseOmwTabLine,
  readCorpusSourceAdapter,
} from "../src/index.js";

async function rowsFor(content: string) {
  const root = await fs.mkdtemp(join(tmpdir(), "vaml-omw-test-"));
  const input = join(root, "synthetic.tab");
  await fs.writeFile(input, content, "utf8");
  const adapter = new OmwTabSourceAdapter({ input, sourceVersion: "test", license: "TEST-ONLY", provenance: "synthetic-offline-test" });
  const rows = [];
  for await (const row of readCorpusSourceAdapter(adapter)) rows.push(row);
  return { root, adapter, rows };
}

test("OMW adapter aligns multilingual synset expressions to one private concept", async () => {
  const { root, adapter, rows } = await rowsFor([
    "02084071-n\teng\tdog\tlemma\n",
    "02084071-n\tzho:狗\tlemma\n",
    "02084071-n\tmsa:anjing\tlemma\n",
    "08420278-n\teng:bank\n",
    "09213565-n\teng:bank\n",
  ].join(""));
  try {
    assert.equal(rows[0]?.alignmentKey, "omw:pwn3.0:02084071-n");
    assert.equal(rows[0]?.sourceId, adapter.descriptor.id);
    assert.notEqual(rows[3]?.alignmentKey, rows[4]?.alignmentKey);
    const assembler = new WorldSemanticCorpusAssembler([adapter.descriptor]);
    const concepts = rows.flatMap((row) => {
      const completed = assembler.push(row);
      return completed ? [completed] : [];
    });
    const final = assembler.finish();
    if (final) concepts.push(final);
    assert.equal(concepts.length, 3);
    assert.deepEqual(concepts[0]?.aliases, { en: ["dog"], ms: ["anjing"], zh: ["狗"] });
    const semanticKey = randomBytes(32);
    const packKey = randomBytes(32);
    const out = join(root, "encrypted");
    const result = await buildVocabulary((async function* () { yield* concepts; })(), out, semanticKey, packKey);
    const dogId = conceptId(semanticKey, concepts[0]!);
    const index = new ShardedSemanticIndex(out, packKey, result.catalogId, 1);
    assert.deepEqual(index.semantic(dogId), { schema: "vaml-world-semantic-corpus/0.1", agentNative: false });
    for (const file of await fs.readdir(out)) {
      assert.equal((await fs.readFile(join(out, file), "utf8")).includes("dog"), false);
      assert.equal((await fs.readFile(join(out, file), "utf8")).includes("anjing"), false);
    }
    index.close();
    semanticKey.fill(0);
    packKey.fill(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("OMW parser rejects malformed, unsupported and out-of-order source data", async () => {
  assert.equal(parseOmwTabLine("# private input comment"), undefined);
  assert.throws(() => parseOmwTabLine("02084071-x\teng\tdog"), /unsupported synset\/POS/);
  assert.throws(() => parseOmwTabLine("02084071-n\tdog"), /declare language and lemma/);
  await assert.rejects(
    () => rowsFor("09213565-n\teng:bank\n08420278-n\teng:bank\n"),
    /globally sorted/,
  );
});

test("OMW aliases remain a private ingestion aid and are sense-specific", () => {
  const aliases = new PrivateImportAliases();
  aliases.add("private-bank-river", { en: ["bank"] });
  aliases.add("private-bank-finance", { en: ["bank"] });
  assert.deepEqual(aliases.resolve("en", "bank").sort(), ["private-bank-finance", "private-bank-river"]);
});
