import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { b64 } from "../src/crypto.js";
import { buildVocabulary, ShardedSemanticIndex } from "../src/vocabulary.js";
import {
  conceptId,
  compileConcepts,
  decryptDocument,
  encryptDocument,
} from "../src/lexicon.js";
import {
  normalizeRecord,
  PrivateImportAliases,
  readSources,
} from "../src/ingestion.js";
test("World Concept Space joins multilingual expressions and splits explicit senses", () => {
  const key = randomBytes(32),
    aliases = new PrivateImportAliases();
  const records = normalizeRecord({
    senses: [[0.1], [0.2]],
    aliases: { en: ["bank"], zh: ["银行"] },
  });
  for (const r of records) aliases.add(conceptId(key, r), r.aliases);
  assert.equal(aliases.resolve("en", "BANK").length, 2);
  assert.equal(aliases.resolve("zh", "银行").length, 2);
  const compiled = compileConcepts(
    [
      ...records,
      { semantic: [0.1], aliases: { ms: ["institusi"] }, domains: ["02"] },
    ],
    key,
  );
  assert.equal(compiled.length, 2);
  assert.ok(compiled.every((c) => c.aliases === undefined));
  assert.equal(
    conceptId(key, { semantic: [0.1], domains: ["03"] }),
    conceptId(key, records[0]),
  );
});
test("JSONL, CSV including multiline quoted fields, and JSON normalize equivalently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vaml-source-"));
  try {
    const r = { semantic: { v: [1, 2] }, aliases: { zh: ["多\n行"] } };
    await writeFile(join(dir, "a.json"), JSON.stringify([r]));
    await writeFile(join(dir, "a.jsonl"), JSON.stringify(r) + "\n");
    const cell = (v: unknown) =>
      '"' + JSON.stringify(v).replaceAll('"', '""') + '"';
    await writeFile(
      join(dir, "a.csv"),
      "semantic,aliases\n" + cell(r.semantic) + "," + cell(r.aliases) + "\n",
    );
    const results = [];
    for (const name of ["a.json", "a.jsonl", "a.csv"]) {
      const rows = [];
      for await (const r of readSources(join(dir, name))) rows.push(r);
      results.push(rows);
    }
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], results[2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("encrypted sharding deduplicates across batches; pinned catalog blocks rollback and substitution", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vaml-packs-")),
    key = randomBytes(32),
    secret = randomBytes(32);
  try {
    async function* records() {
      for (let i = 0; i < 300; i++)
        yield { semantic: [i % 200], aliases: { en: ["never-in-pack"] } };
    }
    const built = await buildVocabulary(records(), dir, key, secret, 3);
    assert.equal(built.count, 200);
    const index = new ShardedSemanticIndex(dir, secret, built.catalogId, 3, 2);
    assert.equal(index.loadedShards(), 0);
    assert.equal(index.size(), 200);
    const id = conceptId(key, { semantic: [7] });
    assert.deepEqual(index.semantic(id), [7]);
    assert.equal(index.loadedShards(), 1);
    index.verify();
    assert.ok(index.loadedShards() <= 2);
    assert.throws(
      () => new ShardedSemanticIndex(dir, secret, built.catalogId, 4),
      /rollback/,
    );
    assert.throws(
      () => new ShardedSemanticIndex(dir, randomBytes(32), built.catalogId, 3),
    );
    const path = join(dir, built.catalogId + ".catalog.vocab"),
      envelope = JSON.parse(await readFile(path, "utf8"));
    const catalog = decryptDocument(
      envelope,
      secret,
      "VAML-0.2/catalog",
    ) as any;
    const shard = Object.values(catalog.buckets)[0] as any;
    const shardPath = join(dir, shard.file),
      original = await readFile(shardPath, "utf8");
    const tampered = JSON.parse(original);
    tampered.packId = b64(randomBytes(32));
    await writeFile(shardPath, JSON.stringify(tampered));
    const fresh = new ShardedSemanticIndex(dir, secret, built.catalogId, 3);
    assert.throws(() => fresh.verify(), /substitution/);
    await writeFile(shardPath, original);
    shard.file = "../escape.vocab";
    const bad = encryptDocument(catalog, secret, "VAML-0.2/catalog");
    await writeFile(
      join(dir, bad.packId + ".catalog.vocab"),
      JSON.stringify(bad),
    );
    assert.throws(
      () => new ShardedSemanticIndex(dir, secret, bad.packId, 3),
      /index/,
    );
    index.close();
    fresh.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
    key.fill(0);
    secret.fill(0);
  }
});
test("CLI compile, authorized inspect, pack build and verify execute as separate processes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vaml-cli-")),
    key = randomBytes(32),
    packKey = randomBytes(32);
  const env = {
    ...process.env,
    VAML_SEMANTIC_KEY: b64(key),
    VAML_PACK_KEY: b64(packKey),
  };
  const run = (args: string[]) =>
    spawnSync(process.execPath, ["dist/src/cli.js", ...args], {
      encoding: "utf8",
      env,
      timeout: 15000,
      windowsHide: true,
    });
  try {
    const source = join(dir, "in.json");
    await writeFile(source, JSON.stringify([{ semantic: [0.7] }]));
    const build = run([
      "pack",
      "build",
      source,
      "--out",
      dir,
      "--revision",
      "1",
    ]);
    assert.equal(build.status, 0, build.stderr);
    const catalog = JSON.parse(build.stdout).catalogId;
    assert.equal(
      run(["pack", "verify", dir, "--catalog", catalog, "--min-revision", "1"])
        .status,
      0,
    );
    const input = join(dir, "in.vaml");
    await writeFile(
      input,
      "V2\nP 02\nF " + conceptId(key, { semantic: [0.7] }) + " 00 -\n",
    );
    assert.equal(run(["compile", input]).status, 0);
    assert.equal(run(["inspect", input + ".compiled.vaml"]).status, 1);
    assert.equal(
      run(["inspect", input + ".compiled.vaml", "--authorized"]).status,
      0,
    );
    assert.equal(
      run(["pack", "verify", dir, "--catalog", catalog, "--min-revision", "2"])
        .status,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("private stable corpus identity survives sharding without merging distinct aligned concepts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vaml-identity-"));
  const key = randomBytes(32),
    secret = randomBytes(32);
  try {
    const records = [
      {
        semantic: { schema: 1 },
        identityMaterial: { alignment: "synthetic-01" },
      },
      {
        semantic: { schema: 1 },
        identityMaterial: { alignment: "synthetic-02" },
      },
    ];
    assert.notEqual(conceptId(key, records[0]), conceptId(key, records[1]));
    async function* source() {
      yield* records;
    }
    const built = await buildVocabulary(source(), dir, key, secret);
    assert.equal(built.count, 2);
    const index = new ShardedSemanticIndex(dir, secret, built.catalogId, 1);
    for (const record of records) {
      const recovered = index.get(conceptId(key, record));
      assert.deepEqual(recovered?.semantic, record.semantic);
      assert.equal("identityMaterial" in recovered!, false);
    }
    index.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing CSV source rejects through async reader without an unhandled stream error", async () => {
  await assert.rejects(async () => {
    for await (const _record of readSources(
      join(tmpdir(), "vaml-missing-" + randomBytes(8).toString("hex") + ".csv"),
    )) {
    }
  }, /ENOENT/);
});

test("world and corpus CLI importers produce pinned catalogs with distinct private identities", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vaml-adapters-"));
  const semantic = randomBytes(32),
    secret = randomBytes(32);
  const env = {
    ...process.env,
    VAML_SEMANTIC_KEY: b64(semantic),
    VAML_PACK_KEY: b64(secret),
  };
  try {
    const world = join(dir, "world.jsonl"),
      sources = join(dir, "sources.json"),
      corpus = join(dir, "corpus.jsonl");
    await writeFile(
      world,
      [
        {
          conceptKey: "01",
          language: "en",
          lexeme: "synthetic-01",
          semantic: [1],
        },
        {
          conceptKey: "02",
          language: "ms",
          lexeme: "synthetic-02",
          semantic: [2],
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    await writeFile(
      sources,
      JSON.stringify({
        format: "vaml-corpus-sources",
        version: "0.1",
        sources: [
          {
            id: "01",
            kind: "agent-native",
            license: "TEST-ONLY",
            redistribution: "private-only",
          },
        ],
      }),
    );
    await writeFile(
      corpus,
      [
        {
          kind: "agent-native",
          alignmentKey: "01",
          sourceId: "01",
          prototype: [1, 0],
        },
        {
          kind: "agent-native",
          alignmentKey: "02",
          sourceId: "01",
          prototype: [0, 1],
        },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    for (const [tool, args, out] of [
      [
        "build-world-lexicon",
        [world, join(dir, "world-out"), "2"],
        join(dir, "world-out"),
      ],
      [
        "build-world-semantic-corpus",
        [sources, corpus, join(dir, "corpus-out"), "2"],
        join(dir, "corpus-out"),
      ],
    ] as Array<[string, string[], string]>) {
      const run = spawnSync(
        process.execPath,
        ["dist/tools/" + tool + ".js", ...args],
        { env, encoding: "utf8", timeout: 15000, windowsHide: true },
      );
      assert.equal(run.status, 0, run.stderr);
      const result = JSON.parse(run.stdout);
      assert.equal(result.count, 2);
      const index = new ShardedSemanticIndex(out, secret, result.catalogId, 2);
      index.verify();
      assert.equal(index.size(), 2);
      index.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
