import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { b64 } from "../src/crypto.js";
import { conceptId } from "../src/lexicon.js";
import { compileArtifact, emitVamlSource } from "../src/compiler.js";
import { buildVocabulary } from "../src/vocabulary.js";
import { ValueType } from "../src/types.js";
export async function networkDemo(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "vaml-demo-")),
    semanticKey = randomBytes(32),
    packKey = randomBytes(32);
  let server: ReturnType<typeof spawn> | undefined;
  try {
    const record = {
      semantic: { v: Array.from(randomBytes(8), (n) => n / 255) },
    };
    const id = conceptId(semanticKey, record);
    async function* source() {
      yield record;
    }
    const built = await buildVocabulary(source(), dir, semanticKey, packKey);
    const input = join(dir, "input.compiled.vaml");
    await writeFile(
      input,
      compileArtifact(
        emitVamlSource("02", [
          { conceptId: id, valueType: ValueType.F64, value: 0.75 },
          { conceptId: id, valueType: ValueType.Ref, value: 0 },
        ]),
      ),
      { mode: 0o600 },
    );
    const env = { ...process.env, VAML_PACK_KEY: b64(packKey) };
    const common = [
      "--vocab",
      dir,
      "--catalog",
      built.catalogId,
      "--min-revision",
      "1",
    ];
    server = spawn(
      process.execPath,
      [
        resolve("dist/examples/network-agent-b.js"),
        ...common,
        "--port",
        "0",
        "--id",
        "02",
        "--peer-id",
        "01",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let output = "",
      errors = "";
    server.stdout!.on("data", (d) => {
      output += String(d);
    });
    server.stderr!.on("data", (d) => {
      errors += String(d);
    });
    const port = await new Promise<number>((resolvePort, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Server readiness timeout")),
        15000,
      );
      const check = () => {
        const m = output.match(/LISTEN (\d+)/);
        if (m) {
          clearTimeout(timer);
          resolvePort(Number(m[1]));
        }
      };
      server!.stdout!.on("data", check);
      server!.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      server!.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Server failed " + errors));
      });
    });
    const client = spawn(
      process.execPath,
      [
        resolve("dist/examples/network-agent-a.js"),
        input,
        ...common,
        "--peer",
        "127.0.0.1:" + port,
        "--id",
        "01",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let clientOutput = "",
      clientErrors = "";
    client.stdout!.on("data", (d) => {
      clientOutput += String(d);
    });
    client.stderr!.on("data", (d) => {
      clientErrors += String(d);
    });
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => {
        client.kill();
        reject(new Error("Client timeout"));
      }, 15000);
      client.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      client.once("exit", (code) => {
        clearTimeout(timer);
        code === 0
          ? done()
          : reject(new Error("Client failed " + clientErrors));
      });
    });
    assert.match(clientOutput, /"received":2/);
    assert.match(output, /"semanticRecordsResolved":2/);
    const frames = [...clientOutput.matchAll(/FRAME_HEX ([0-9a-f]+)/g)].map(
      (m) => Buffer.from(m[1], "hex"),
    );
    assert.equal(frames.length, 3);
    for (const frame of frames) {
      assert.equal(frame.includes(Buffer.from(id)), false);
      for (const word of ["TASK", "SEARCH", "TRUE", "FALSE"])
        assert.equal(frame.includes(Buffer.from(word)), false);
    }
    // Absence checks are regression evidence; cryptographic confidentiality, not HEX, provides privacy.
    console.log(clientOutput.trim());
    console.log(
      "Independent Agent A / Agent B TCP demo OK; B resolved 2 private machine semantic records.",
    );
  } finally {
    if (server && server.exitCode === null) {
      const exited = new Promise<void>((r) => server!.once("exit", () => r()));
      server.kill();
      await exited;
    }
    semanticKey.fill(0);
    packKey.fill(0);
    await rm(dir, { recursive: true, force: true });
  }
}
await networkDemo();
