import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { aesGcmEncrypt, b64, unb64 } from "../src/crypto.js";
import {
  beginHandshake,
  defaultManifest,
  finishHandshake,
  verifyConfirmation,
} from "../src/negotiation.js";
import {
  createPrivatePayload,
  decryptLexicon,
  encryptLexicon,
} from "../src/lexicon.js";
import { PrivateSemanticIndex } from "../src/semantic-index.js";
import {
  VamlSessionRuntime,
  encodeValue,
  decodeValue,
} from "../src/runtime.js";
import { ValueType } from "../src/types.js";
import {
  compileArtifact,
  emitVamlSource,
  parseVamlSource,
  readArtifact,
} from "../src/compiler.js";
import { decodeHello, encodeHello } from "../src/transport.js";
function material() {
  const lexicon = createPrivatePayload(
    [{ semantic: [0.17, 0.73] }, { semantic: [0.63, 0.19] }],
    randomBytes(32),
  );
  const key = randomBytes(32),
    pack = encryptLexicon(lexicon, key),
    index = new PrivateSemanticIndex(lexicon);
  return { lexicon, key, pack, index };
}
function pair(m = material(), confirm = true) {
  const pa = beginHandshake("01", defaultManifest([m.pack.packId])),
    pb = beginHandshake("02", defaultManifest([m.pack.packId]));
  const a = finishHandshake(pa, pb.hello, m.index, m.key, "02"),
    b = finishHandshake(pb, pa.hello, m.index, m.key, "01");
  if (confirm) {
    verifyConfirmation(a, b.confirmationTag);
    verifyConfirmation(b, a.confirmationTag);
  }
  const ids = m.lexicon.concepts.map((c) => c.conceptId);
  if (confirm) {
    a.activate(ids);
    b.activate(ids);
  }
  return {
    ...m,
    pa,
    pb,
    a,
    b,
    ids,
    ar: new VamlSessionRuntime(a.context, a.conceptToCode, a.codeToConcept),
    br: new VamlSessionRuntime(b.context, b.conceptToCode, b.codeToConcept),
  };
}
test("confirmation is mandatory and role-bound, wrong PSK and reflection fail", () => {
  const p = pair(undefined, false);
  assert.throws(() => p.ar.encode([]), /confirmed/);
  assert.throws(() => p.a.activate(p.ids), /confirmed/);
  assert.throws(() => verifyConfirmation(p.a, p.a.confirmationTag), /mismatch/);
  assert.throws(
    () => verifyConfirmation(p.a, b64(randomBytes(32))),
    /mismatch/,
  );
  const pending = beginHandshake("01", defaultManifest([p.pack.packId]));
  assert.throws(
    () => finishHandshake(pending, pending.hello, p.index, p.key, "01"),
    /reflection/,
  );
  const pa = beginHandshake("01", defaultManifest([p.pack.packId])),
    pb = beginHandshake("02", defaultManifest([p.pack.packId]));
  const a = finishHandshake(pa, pb.hello, p.index, p.key, "02"),
    b = finishHandshake(pb, pa.hello, p.index, randomBytes(32), "01");
  assert.throws(() => verifyConfirmation(a, b.confirmationTag), /mismatch/);
});
test("downgrade, peer mismatch, unshared packs, key reuse and bad X25519 are rejected", () => {
  const m = material();
  for (const change of [
    (h: any) => {
      h.version = "0.1";
    },
    (h: any) => {
      h.manifest.features.pop();
    },
    (h: any) => {
      h.manifest.maxFrameBytes = 2 ** 32;
    },
    (h: any) => {
      h.agentId = "03";
    },
    (h: any) => {
      h.manifest.packIds = [b64(randomBytes(32))];
    },
    (h: any) => {
      h.ephemeralPublicKey = b64(Buffer.alloc(44));
    },
    (h: any) => {
      h.manifest.valueTypes = [10];
    },
  ]) {
    const a = beginHandshake("01", defaultManifest([m.pack.packId])),
      b = beginHandshake("02", defaultManifest([m.pack.packId]));
    change(b.hello);
    assert.throws(() => finishHandshake(a, b.hello, m.index, m.key, "02"));
  }
  const p = pair();
  assert.throws(
    () => finishHandshake(p.pa, p.pb.hello, p.index, p.key, "02"),
    /consumed/,
  );
});
test("same concept and vocabulary across fresh sessions yields different code and keys", () => {
  const m = material(),
    a = pair(m),
    b = pair(m);
  assert.notEqual(
    a.a.conceptToCode.get(a.ids[0]),
    b.a.conceptToCode.get(a.ids[0]),
  );
  assert.notDeepEqual(a.a.context.keys.sendKey, b.a.context.keys.sendKey);
  assert.throws(() => b.br.decode(a.ar.encode([])), /Session/);
});
test("directional keys prevent reflection and deterministic nonces never repeat within a direction", () => {
  const p = pair(),
    f1 = p.ar.encode([]),
    f2 = p.ar.encode([]),
    back = p.br.encode([]);
  assert.notDeepEqual(f1.subarray(22, 34), f2.subarray(22, 34));
  assert.notDeepEqual(p.a.context.keys.sendKey, p.b.context.keys.sendKey);
  assert.throws(() => p.ar.decode(f1));
  p.br.decode(f1);
  p.ar.decode(back);
  p.a.context.sendSequence = (1n << 64n) - 1n;
  assert.throws(() => p.ar.encode([]), /overflow/);
});
test("all header, ciphertext, tag tampering fails without advancing authenticated state", () => {
  const p = pair(),
    frame = p.ar.encode([
      { conceptId: p.ids[0], valueType: ValueType.Bool, value: true },
    ]);
  for (let i = 0; i < frame.length; i++) {
    const bad = Buffer.from(frame);
    bad[i] ^= 1;
    assert.throws(() => p.br.decode(bad), "byte " + i);
    assert.equal(p.b.context.receiveSequence, 0n);
  }
  assert.equal(p.br.decode(frame)[0].value, true);
  assert.throws(() => p.br.decode(frame), /Replay/);
});
test("malformed, oversized, truncated frames and unknown codes fail", () => {
  const p = pair();
  assert.throws(() => p.br.decode(Buffer.alloc(1048577)), /size/);
  assert.throws(() => p.br.decode(Buffer.alloc(0)), /size/);
  const valid = p.ar.encode([]);
  assert.throws(() => p.br.decode(valid.subarray(0, -1)));
  assert.throws(
    () => p.ar.encode([{ conceptId: b64(randomBytes(32)), valueType: 0 }]),
    /codebook/,
  );
  const plain = Buffer.alloc(13);
  plain.writeBigUInt64BE(0n);
  assert.throws(() => p.br.decode(p.ar.seal(plain, 0)), /Unknown/);
  const malformed = Buffer.alloc(13);
  malformed.writeBigUInt64BE(p.a.conceptToCode.get(p.ids[0])!);
  malformed[8] = 1;
  assert.throws(() => p.br.decode(p.ar.seal(malformed, 0)), /length/);
});
test("field count, aggregate bytes, type coercion and dangling graph references are bounded", () => {
  const p = pair(),
    id = p.ids[0];
  assert.throws(
    () =>
      p.ar.encode(
        Array.from({ length: 4097 }, () => ({ conceptId: id, valueType: 0 })),
      ),
    /count/,
  );
  assert.throws(
    () =>
      p.ar.encode([
        { conceptId: id, valueType: 5, value: Buffer.alloc(1048576) },
      ]),
    /large/,
  );
  assert.throws(
    () => p.ar.encode([{ conceptId: id, valueType: 8, value: 3 }]),
    /reference/,
  );
  assert.throws(() => encodeValue(4, "false"));
  assert.throws(() => encodeValue(3, NaN));
  assert.throws(() => encodeValue(1, 4));
  assert.throws(() => decodeValue(4, Buffer.from([2])));
  assert.throws(() => decodeValue(6, Buffer.from([255])));
  p.a.context.valueTypes = [0];
  assert.throws(
    () => p.ar.encode([{ conceptId: id, valueType: 4, value: true }]),
    /Unnegotiated/,
  );
});
test("concept references are opaque codes, graph references survive session compilation", () => {
  const p = pair();
  const fields = [
    { conceptId: p.ids[0], valueType: 7, value: p.ids[1] },
    { conceptId: p.ids[1], valueType: 8, value: 0 },
  ];
  assert.deepEqual(p.br.decode(p.ar.encode(fields)), fields);
  assert.throws(
    () =>
      p.ar.encode([
        { conceptId: p.ids[0], valueType: 7, value: b64(randomBytes(32)) },
      ]),
    /reference/,
  );
});
test("active-set resolution is bounded and handshake never enumerates the vocabulary", () => {
  const p = material();
  let lookups = 0;
  const resolver = {
    has(id: string) {
      lookups++;
      return p.index.has(id);
    },
  };
  const pa = beginHandshake("01", defaultManifest([p.pack.packId])),
    pb = beginHandshake("02", defaultManifest([p.pack.packId]));
  const a = finishHandshake(pa, pb.hello, resolver, p.key, "02");
  assert.equal(lookups, 0);
  assert.equal(a.conceptToCode.size, 0);
  const b = finishHandshake(pb, pa.hello, resolver, p.key, "01");
  verifyConfirmation(a, b.confirmationTag);
  assert.throws(() => a.activate([b64(randomBytes(32))]), /unauthorized/);
  assert.equal(a.conceptToCode.size, 0);
  assert.throws(
    () => a.activate(Array(4097).fill(p.lexicon.concepts[0].conceptId)),
    /limit/,
  );
  a.activate([p.lexicon.concepts[0].conceptId]);
  assert.equal(a.conceptToCode.size, 1);
});
test("vocabulary key, tag, algorithm, digest and alias injection are checked", () => {
  const p = material();
  assert.throws(() => decryptLexicon(p.pack, randomBytes(32)));
  for (const key of ["tag", "nonce", "salt", "packId", "ciphertext"] as const) {
    const bytes = unb64(p.pack[key]);
    bytes[0] ^= 1;
    assert.throws(() =>
      decryptLexicon({ ...p.pack, [key]: b64(bytes) }, p.key),
    );
  }
  assert.throws(() =>
    decryptLexicon({ ...p.pack, algorithm: "other" } as any, p.key),
  );
  assert.throws(
    () =>
      encryptLexicon(
        {
          ...p.lexicon,
          concepts: [
            { ...p.lexicon.concepts[0], aliases: { en: ["private"] } },
          ],
        },
        p.key,
      ),
    /Aliases/,
  );
});
test("strict IR rejects readable opcodes, legacy, noncanonical base64 and malformed types", () => {
  const p = pair(),
    src = emitVamlSource("02", [
      { conceptId: p.ids[0], valueType: 1, value: 42n },
    ]);
  assert.equal(readArtifact(compileArtifact(src)).fields[0].value, 42n);
  for (const bad of [
    src.replace(p.ids[0], "SEARCH"),
    src.replace("V2", "V1"),
    src.replace(" 01 ", " 01junk "),
    src + "F bad 00 -",
    src.replace(" 01 ", " 04 "),
  ]) {
    assert.throws(() => parseVamlSource(bad));
  }
  assert.throws(() => unb64("YQ=="));
  assert.throws(() => unb64("YR"));
});
test("binary handshake roundtrip is exact and rejects downgraded feature bits", () => {
  const p = pair(),
    binary = encodeHello(p.pa.hello);
  assert.deepEqual(decodeHello(binary), p.pa.hello);
  binary[binary.length - 1] = 0;
  assert.throws(() => decodeHello(binary), /downgrade/);
});
test("closed sessions erase accessible key buffers and reject future traffic", () => {
  const p = pair();
  p.ar.close();
  assert.equal(
    p.a.context.keys.sendKey.every((b) => b === 0),
    true,
  );
  assert.throws(() => p.ar.encode([]), /closed/);
});

test("binary compilation preserves empty typed values and rejects truncation or trailing data", () => {
  const p = pair();
  const source = emitVamlSource("02", [
    { conceptId: p.ids[0], valueType: ValueType.Bytes, value: Buffer.alloc(0) },
    { conceptId: p.ids[0], valueType: ValueType.Utf8, value: "" },
  ]);
  const binary = compileArtifact(source);
  assert.equal(readArtifact(binary).fields[1].value, "");
  assert.deepEqual(readArtifact(binary).fields[0].value, Buffer.alloc(0));
  assert.equal(binary.includes(Buffer.from(p.ids[0])), false);
  for (let length = 0; length < binary.length; length++) {
    assert.throws(() => readArtifact(binary.subarray(0, length)));
  }
  assert.throws(
    () => readArtifact(Buffer.concat([binary, Buffer.from([0])])),
    /Trailing/,
  );
  assert.throws(() =>
    emitVamlSource("02", [{ conceptId: p.ids[0], valueType: 0, value: 1 }]),
  );
});
