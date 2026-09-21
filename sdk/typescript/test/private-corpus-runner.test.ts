import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import {
  assertOutsidePublicRepository,
  candidateLookupId,
  runPrivateCorpusBuild,
  scoreSourcePack1Candidate,
  sha256File,
  type PrivateCorpusBuildPlan,
  type SourcePack1Candidate,
} from "../src/index.js";

async function writePrivate(file: string, content: string | object): Promise<void> {
  await fs.mkdir(join(file, ".."), { recursive: true });
  await fs.writeFile(file, typeof content === "string" ? content : JSON.stringify(content, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

test("private corpus lookup IDs are stable and sense-specific", () => {
  const candidate: SourcePack1Candidate = {
    category: "general-vocabulary",
    sourceId: "source-a",
    sourceSenseId: "sense-1",
    language: "en",
    lexeme: "synthetic-one",
  };
  assert.equal(candidateLookupId(candidate), candidateLookupId({ ...candidate }));
  assert.notEqual(candidateLookupId(candidate), candidateLookupId({ ...candidate, sourceSenseId: "sense-2" }));
});

test("candidate quality gate requires lexical identity", () => {
  const candidate: SourcePack1Candidate = {
    category: "general-vocabulary",
    sourceId: "source-a",
    sourceSenseId: "sense-1",
    language: "en",
    lexeme: "synthetic-one",
  };
  assert.equal(scoreSourcePack1Candidate(candidate), 0.5);
  assert.ok(scoreSourcePack1Candidate({ ...candidate, semanticEvidence: { synthetic: true } }) > 0.5);
  assert.equal(scoreSourcePack1Candidate({ ...candidate, language: undefined }), 0);
});

test("sensitive build material inside public repository is rejected", () => {
  assert.throws(
    () => assertOutsidePublicRepository("/tmp/vaml-public", "/tmp/vaml-public/private/build.json", "build plan"),
    /outside the public repository/,
  );
});

test("runner verifies inputs, aligns, externally sorts, deduplicates and builds encrypted catalog", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "vaml-private-corpus-runner-"));
  try {
    const secure = join(root, "secure");
    const publicRepo = join(root, "public-repo");
    const alignmentDir = join(secure, "alignment");
    const outputDir = join(secure, "output");
    const tempDir = join(secure, "tmp");
    await fs.mkdir(alignmentDir, { recursive: true });

    const sourceManifestPath = join(secure, "corpus.sources.json");
    await writePrivate(sourceManifestPath, {
      format: "vaml-corpus-sources",
      version: "0.1",
      sources: [
        {
          id: "source-a",
          kind: "dictionary",
          license: "TEST-ONLY",
          redistribution: "private-only",
          languages: ["en"],
          domains: ["synthetic-test"],
        },
      ],
    });

    const candidate: SourcePack1Candidate = {
      category: "general-vocabulary",
      sourceId: "source-a",
      sourceSenseId: "sense-1",
      language: "en",
      lexeme: "synthetic-one",
      aliases: ["synthetic-alias"],
      semanticEvidence: { test: true },
    };
    const snapshotPath = join(secure, "source-a.sourcepack.jsonl");
    await writePrivate(snapshotPath, `${JSON.stringify(candidate)}\n${JSON.stringify(candidate)}\n`);

    const lookupId = candidateLookupId(candidate);
    const prefix = lookupId.slice(0, 2);
    const alignmentShardPath = join(alignmentDir, `${prefix}.alignment.private.json`);
    await writePrivate(alignmentShardPath, {
      format: "vaml-private-alignment-shard",
      version: "0.1",
      entries: { [lookupId]: "private:synthetic:0001" },
    });

    const alignmentManifestPath = join(alignmentDir, "alignment.manifest.json");
    await writePrivate(alignmentManifestPath, {
      format: "vaml-private-alignment-manifest",
      version: "0.1",
      prefixChars: 2,
      shards: {
        [prefix]: {
          file: basename(alignmentShardPath),
          sha256: await sha256File(alignmentShardPath),
        },
      },
    });

    const plan: PrivateCorpusBuildPlan = {
      format: "vaml-private-corpus-build-plan",
      version: "0.1",
      runId: "synthetic-runner-test",
      sourceManifest: {
        path: sourceManifestPath,
        sha256: await sha256File(sourceManifestPath),
      },
      snapshots: [
        {
          id: "source-a-snapshot",
          sourceId: "source-a",
          path: snapshotPath,
          sha256: await sha256File(snapshotPath),
          format: "source-pack-1-candidate-jsonl",
        },
      ],
      alignmentManifest: {
        path: alignmentManifestPath,
        sha256: await sha256File(alignmentManifestPath),
      },
      tempDir,
      output: {
        directory: outputDir,
        prefix: "synthetic",
        revision: 1,
      },
      policy: {
        minQuality: 0.5,
        missingAlignment: "reject",
        chunkRows: 1,
        mergeFanIn: 2,
        cleanupTemp: true,
      },
    };

    const receipt = await runPrivateCorpusBuild(
      plan,
      { semanticKey: randomBytes(32), packKey: randomBytes(32) },
      { publicRepoRoot: publicRepo },
    );

    assert.equal(receipt.pipelineStats.candidatesSeen, 2);
    assert.equal(receipt.pipelineStats.alignedRows, 2);
    assert.equal(receipt.pipelineStats.duplicatesRemoved, 1);
    assert.equal(receipt.pipelineStats.sortedRows, 1);
    assert.equal(receipt.corpusStats.concepts, 1);
    assert.equal(receipt.artifacts.vocabulary.count, 1);
    assert.match(receipt.artifacts.vocabulary.catalogId, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(receipt.artifacts.vocabulary.revision, 1);

    const sortedCorpus = await fs.readFile(join(outputDir, receipt.artifacts.sortedCorpus.file), "utf8");
    assert.match(sortedCorpus, /"kind":"lexeme"/);
    assert.equal(sortedCorpus.includes("synthetic-one"), true);

    for (const artifact of receipt.artifacts.vocabulary.files) {
      const encrypted = await fs.readFile(join(outputDir, "vocabulary", artifact.file), "utf8");
      assert.equal(encrypted.includes("synthetic-one"), false);
      assert.equal(encrypted.includes("synthetic-alias"), false);
    }

    await assert.rejects(fs.stat(tempDir));
    await fs.stat(join(outputDir, "synthetic.build.receipt.json"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
