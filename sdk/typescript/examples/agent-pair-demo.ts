import { randomBytes } from "node:crypto";
import {
  ValueType,
  VamlSessionRuntime,
  beginHandshake,
  compileVamlSource,
  createPrivatePayload,
  defaultManifest,
  decryptLexicon,
  emitVamlSource,
  encryptLexicon,
  finishHandshake,
  verifyConfirmation,
  type ConceptSourceRecord,
} from "../src/index.js";

// Demo-only latent records. No stable human-readable vocabulary is committed.
const sourceRecords: ConceptSourceRecord[] = [
  {
    semantic: { v: [0.931, -0.112, 0.447, 0.019], r: [1, 7, 2] },
    embedding: [0.931, -0.112, 0.447, 0.019],
    domains: ["d0"],
  },
  {
    semantic: { v: [-0.302, 0.881, 0.121, -0.541], r: [2, 4, 9] },
    embedding: [-0.302, 0.881, 0.121, -0.541],
    domains: ["d0"],
  },
  {
    semantic: { v: [0.084, 0.215, -0.971, 0.602], r: [9, 1, 5] },
    embedding: [0.084, 0.215, -0.971, 0.602],
    domains: ["d1"],
  },
];

const semanticKey = randomBytes(32);
const packSecret = randomBytes(32);
const privatePayload = createPrivatePayload(sourceRecords, semanticKey);
const encryptedPack = encryptLexicon(privatePayload, packSecret);
const agentALexicon = decryptLexicon(encryptedPack, packSecret);
const agentBLexicon = decryptLexicon(encryptedPack, packSecret);

const aPending = beginHandshake("A-7F1", defaultManifest([encryptedPack.packId]));
const bPending = beginHandshake("B-2C9", defaultManifest([encryptedPack.packId]));

const aNegotiated = finishHandshake(aPending, bPending.hello, agentALexicon);
const bNegotiated = finishHandshake(bPending, aPending.hello, agentBLexicon);
verifyConfirmation(aNegotiated, bNegotiated.confirmationTag);
verifyConfirmation(bNegotiated, aNegotiated.confirmationTag);

const a = new VamlSessionRuntime(
  aNegotiated.context,
  aNegotiated.conceptToCode,
  aNegotiated.codeToConcept,
);
const b = new VamlSessionRuntime(
  bNegotiated.context,
  bNegotiated.conceptToCode,
  bNegotiated.codeToConcept,
);

const c0 = privatePayload.concepts[0].conceptId;
const c1 = privatePayload.concepts[1].conceptId;

const source = emitVamlSource("B-2C9", [
  { conceptId: c0, valueType: ValueType.None },
  { conceptId: c1, valueType: ValueType.U64, value: 9021n },
]);

const frameAtoB = compileVamlSource(source, a);
const decodedByB = b.decode(frameAtoB);

if (decodedByB[0]?.conceptId !== c0 || decodedByB[1]?.conceptId !== c1) {
  throw new Error("Agent B did not recover the same semantic concepts");
}

const frameBtoA = b.encode([
  { conceptId: c0, valueType: ValueType.Bool, value: true },
]);
const decodedByA = a.decode(frameBtoA);

console.log("VAML 0.2 Agent A <-> Agent B demo OK");
console.log(`encrypted vocab pack id: ${encryptedPack.packId}`);
console.log(`wire A->B bytes: ${frameAtoB.length}`);
console.log(`wire A->B preview: ${frameAtoB.subarray(0, 40).toString("hex").toUpperCase()}...`);
console.log(`A recovered fields: ${decodedByA.length}`);
