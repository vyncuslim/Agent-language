/**
 * VAML Text Transport copy/paste demo: Computer A seals a private semantic
 * payload, prints one paste-safe line; Computer B pastes it back, decodes
 * the exact bytes, and opens them with session AEAD. Simulates the human
 * clipboard step in-process.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  VamlSessionRuntime,
  ValueType,
  beginHandshake,
  createPrivatePayload,
  decodeVamlFrameFromText,
  defaultManifest,
  encryptLexicon,
  encodeVamlFrameToText,
  finishHandshake,
  verifyConfirmation,
  PrivateSemanticIndex,
} from "../src/index.js";

export async function textTransportDemo(): Promise<void> {
  const records = [
    { semantic: { z: [0.31, -0.72, 0.58] }, embedding: [0.31, -0.72, 0.58], domains: ["x"] },
  ];
  const lexicon = createPrivatePayload(records, randomBytes(32));
  const pack = encryptLexicon(lexicon, randomBytes(32));
  const authKey = randomBytes(32);
  const aPending = beginHandshake("a", defaultManifest([pack.packId]));
  const bPending = beginHandshake("b", defaultManifest([pack.packId]));
  const index = new PrivateSemanticIndex(lexicon);
  const aSession = finishHandshake(aPending, bPending.hello, index, authKey, "b");
  const bSession = finishHandshake(bPending, aPending.hello, index, authKey, "a");
  verifyConfirmation(aSession, bSession.confirmationTag);
  verifyConfirmation(bSession, aSession.confirmationTag);
  aSession.activate(lexicon.concepts.map((c) => c.conceptId));
  bSession.activate(lexicon.concepts.map((c) => c.conceptId));
  const concept = lexicon.concepts[0].conceptId;
  const a = new VamlSessionRuntime(aSession.context, aSession.conceptToCode, aSession.codeToConcept);
  const b = new VamlSessionRuntime(bSession.context, bSession.conceptToCode, bSession.codeToConcept);

  // Computer A: seal, armor, copy.
  const sealed = a.encode([{ conceptId: concept, valueType: ValueType.U64, value: 7n }]);
  const pasted = encodeVamlFrameToText(sealed);
  console.log(`COPY THIS LINE:\n${pasted}`);

  // Computer B: paste, decode, open. Whitespace from chat boxes is tolerated.
  const recovered = decodeVamlFrameFromText(`\n  ${pasted}  \n`);
  assert.deepEqual(recovered, sealed);
  const fields = b.decode(recovered);
  assert.equal(fields.length, 1);
  assert.equal(fields[0].conceptId, concept);
  assert.equal(fields[0].value, 7n);
  console.log("Computer B recovered the exact payload with AEAD PASS: copy/paste OK.");
}

await textTransportDemo();
