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

async function writePrivate(path: string, value: unknown): Promise<void> {
  await fs.mkdir(join(path, ".."), { recursive: true });
  await fs.writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

test("candidate lookup IDs are stable and sense-specific", () => {
  const base: SourcePack1Candidate = {
    category: "general-vocabulary",
    sourceId: "source-a",
    sourceSenseId: "sense-1",
    language: "en",
    lexeme: "synthetic-one",
  };
  assert.equal(candidateLookupId(base), candidateLookupId({ ...base }));
  assert.notEqual(candidateLookupId(base), candidateLookupId({ ...base, sourceSenseId: "sense-2" }));
});

test("quality scoring requires lexical identity and rewards evidence", () => {
  const minimal: SourcePack1Candidate = {
    category: "general-vocabulary",
    sourceId: "source-a",
    sourceSenseId: "sense-1",
    language: "en",
    lexeme: "synthetic-one",
  };
  assert.equal(scoreSourcePack1Candidate(minimal), 0.5);
  assert.ok(scoreSourcePack1Candidate({ ...minimal, semanticEvidence: { synthetic: true } }) > 0.5);
  assert.equal(scoreSourcePack1Candidate({ ...minimal, language: undefined }), 0);
});

test("sensitive paths inside the public repository are rejected", () => {
  assert.throws(
    () => assertOutsidePublicRepository("/tmp/public-repo", "/tmp/public-repo/private/input.jsonl", "input"),
    /outside the public repository/,
  );
});

test("private runner verifies, aligns, sorts, deduplicates and encrypts synthetic corpus", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "vaml-private-runner-"));
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
      semanticEvidence: { test: true },
    };
    const snapshotPath = join(secure, "source-a.sourcepack.jsonl");
    await writePrivate(snapshotPath, `${JSON.stringify(candidate)}\n${JSON.stringify(candidate)}\n`);

    const lookupId = candidateLookupId(candidate);
    const prefix = lookupId.slice(0, 2);
    const shardPath = join(alignmentDir, `${prefix}.alignment.private.json`);
    await writePrivate(shardPath, {
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
        [prefix]: { file: basename(shardPath), sha256: await sha256File(shardPath) },
      },
    });

    const plan: PrivateCorpusBuildPlan = {
      format: "vaml-private-corpus-build-plan",
      version: "0.1",
      runId: "synthetic-build",
      sourceManifest: { path: sourceManifestPath, sha256: await sha256File(sourceManifestPath) },
      snapshots: [
        {
          id: "source-a-snapshot",
          sourceId: "source-a",
          path: snapshotPath,
          sha256: await sha256File(snapshotPath),
          format: "source-pack-1-candidate-jsonl",
        },
      ],
      alignmentManifest: { path: alignmentManifestPath, sha256: await sha256File(alignmentManifestPath) },
      tempDir,
      output: { directory: outputDir, prefix: "synthetic", shardSize: 10 },
      policy: { minQuality: 0.5, missingAlignment: "reject", chunkRows: 1, cleanupTemp: true },
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
    assert.equal(receipt.artifacts.encryptedShards.length, 1);

    const encryptedPackPath = join(outputDir, receipt.artifacts.encryptedShards[0].file);
    const encryptedPack = await fs.readFile(encryptedPackPath, "utf8");
    assert.equal(encryptedPack.includes("synthetic-one"), false);

    const sortedCorpus = await fs.readFile(join(outputDir, receipt.artifacts.sortedCorpus.file), "utf8");
    assert.equal(sortedCorpus.includes("synthetic-one"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
