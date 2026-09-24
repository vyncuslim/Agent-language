#!/usr/bin/env node
/**
 * VAML text chat for the LAN room (testing only).
 *
 * Pairs two computers with pasted handshake lines, then chats by pasting
 * VAMLTXT1 sealed frames into any chat room. Every chat line is session
 * AEAD: decode verifies armor, open() verifies authenticity.
 *
 * State lives in ./.vaml-text-chat/ (or --dir). Bundle keys are TEST secrets:
 * distribute them once (USB/QR/in person), never reuse them for anything real.
 *
 * Pairing dance (5 pastes, do them in the LAN room):
 *   A: init --id A            -> prints VAMLBUNDLE line, send it to B
 *   B: init --id B --bundle <VAMLBUNDLE...>
 *   A: pair-start              -> prints VAMLHELLO line, paste to room
 *   B: pair-start              -> prints VAMLHELLO line, paste to room
 *   A: pair-finish <helloB>    -> prints VAMLCONFIRM line, paste to room
 *   B: pair-finish <helloA>    -> prints VAMLCONFIRM line, paste to room
 *   A: pair-confirm <confirmB>
 *   B: pair-confirm <confirmA>
 * Chat:
 *   A: send "你好"            -> prints VAMLTXT1 line, paste to room
 *   B: recv "VAMLTXT1..."     -> prints the plaintext (or rejects)
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createPrivateKey } from "node:crypto";
import {
  VamlSessionRuntime,
  beginHandshake,
  createPrivatePayload,
  decodeVamlFrameFromText,
  decryptLexicon,
  defaultManifest,
  encodeVamlFrameToText,
  encryptLexicon,
  exportPrivateKey,
  finishHandshake,
  verifyConfirmation,
  PrivateSemanticIndex,
} from "../dist/src/index.js";

const B64URL = /^[A-Za-z0-9_-]+$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CHAT = 4000;

const FIXED_RECORDS = [
  { semantic: { z: [0.31, -0.72, 0.58] }, embedding: [0.31, -0.72, 0.58], domains: ["text-chat"] },
];

const b64uEncode = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
const b64uDecode = (line, prefix) => {
  if (typeof line !== "string" || !line.startsWith(prefix)) throw new Error(`Expected a ${prefix} line`);
  const body = line.slice(prefix.length).trim();
  if (!B64URL.test(body)) throw new Error(`Invalid ${prefix} encoding`);
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
};

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = flag("--dir") || "./.vaml-text-chat";
const files = {
  bundle: join(dir, "bundle.json"),
  pending: join(dir, "pending.json"),
  session: join(dir, "session.json"),
};

async function readJson(path) {
  try {
    return JSON.parse(await fs.readFile(path, "utf8"));
  } catch {
    return null;
  }
}
async function writePrivate(path, obj) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path, JSON.stringify(obj, null, 2), { mode: 0o600 });
}
const b64ToBuf = (s) => Buffer.from(s, "base64");
const bufToB64 = (b) => Buffer.from(b).toString("base64");

function buildPackSide(saved) {
  // Both sides use the SAME pack object created once by A: packIds match
  // byte-for-byte, which the handshake requires. Never rebuild per side
  // (pack construction is not deterministic).
  const pack = saved.pack;
  if (!pack || pack.format !== "vaml-encrypted-vocab") throw new Error("Missing pack: re-run init");
  const packKey = b64ToBuf(saved.packKey);
  const lexicon = decryptLexicon(pack, packKey);
  return { pack, index: new PrivateSemanticIndex(lexicon) };
}

function serializeSession(session) {
  const c = session.context;
  return {
    context: {
      sessionId: c.sessionId.toString(),
      localAgentId: c.localAgentId,
      remoteAgentId: c.remoteAgentId,
      keys: {
        sendKey: bufToB64(c.keys.sendKey),
        receiveKey: bufToB64(c.keys.receiveKey),
        codebookKey: bufToB64(c.keys.codebookKey),
        confirmKey: bufToB64(c.keys.confirmKey),
      },
      sendSequence: c.sendSequence.toString(),
      receiveSequence: c.receiveSequence.toString(),
      confirmed: c.confirmed,
      maxFrameBytes: c.maxFrameBytes,
      valueTypes: c.valueTypes,
    },
    conceptToCode: [...session.conceptToCode.entries()].map(([k, v]) => [k, v.toString()]),
    codeToConcept: [...session.codeToConcept.entries()].map(([k, v]) => [k.toString(), v]),
    confirmationTag: session.confirmationTag,
  };
}

function restoreRuntime(saved) {
  const c = saved.context;
  const context = {
    sessionId: BigInt(c.sessionId),
    localAgentId: c.localAgentId,
    remoteAgentId: c.remoteAgentId,
    keys: {
      sendKey: b64ToBuf(c.keys.sendKey),
      receiveKey: b64ToBuf(c.keys.receiveKey),
      codebookKey: b64ToBuf(c.keys.codebookKey),
      confirmKey: b64ToBuf(c.keys.confirmKey),
    },
    sendSequence: BigInt(c.sendSequence),
    receiveSequence: BigInt(c.receiveSequence),
    confirmed: c.confirmed,
    maxFrameBytes: c.maxFrameBytes,
    valueTypes: c.valueTypes,
  };
  const conceptToCode = new Map(saved.conceptToCode.map(([k, v]) => [k, BigInt(v)]));
  const codeToConcept = new Map(saved.codeToConcept.map(([k, v]) => [BigInt(k), v]));
  return new VamlSessionRuntime(context, conceptToCode, codeToConcept);
}

async function cmdInit() {
  const id = flag("--id");
  if (!id || !ID_PATTERN.test(id)) throw new Error("Provide --id NAME ([A-Za-z0-9_-], 1-64 chars)");
  const bundleLine = flag("--bundle");
  if (bundleLine) {
    const bundle = b64uDecode(bundleLine, "VAMLBUNDLE.");
    if (typeof bundle.pack !== "object" || bundle.pack === null) throw new Error("Invalid bundle pack");
    for (const k of ["packKey", "authKey"]) {
      if (typeof bundle[k] !== "string" || b64ToBuf(bundle[k]).length !== 32) throw new Error("Invalid bundle keys");
    }
    await writePrivate(files.bundle, { id, pack: bundle.pack, packKey: bundle.packKey, authKey: bundle.authKey });
    console.log(`Joined as "${id}". Now run: pair-start`);
    return;
  }
  const { randomBytes } = await import("node:crypto");
  const packKey = randomBytes(32);
  const authKey = randomBytes(32);
  const lexicon = createPrivatePayload(FIXED_RECORDS, randomBytes(32));
  const pack = encryptLexicon(lexicon, packKey);
  const bundle = {
    pack,
    packKey: packKey.toString("base64"),
    authKey: authKey.toString("base64"),
  };
  await writePrivate(files.bundle, { id, ...bundle });
  console.log("TEST-ONLY keys generated. Send this ONE line to your peer (then never reuse these keys):");
  console.log(`VAMLBUNDLE.${b64uEncode(bundle)}`);
  console.log(`\nYou are "${id}". Next: pair-start`);
}

async function cmdPairStart() {
  const saved = await readJson(files.bundle);
  if (!saved) throw new Error("No bundle: run init first");
  const { pack } = buildPackSide(saved);
  const pending = beginHandshake(saved.id, defaultManifest([pack.packId]));
  await writePrivate(files.pending, {
    hello: pending.hello,
    privateKey: exportPrivateKey(pending.privateKey),
  });
  console.log("Paste this line to the room:");
  console.log(`VAMLHELLO.${b64uEncode(pending.hello)}`);
}

async function cmdPairFinish() {
  const line = args[args.indexOf("pair-finish") + 1];
  if (!line) throw new Error("Usage: pair-finish <VAMLHELLO line>");
  const saved = await readJson(files.bundle);
  const pendingSaved = await readJson(files.pending);
  if (!saved || !pendingSaved) throw new Error("Need init + pair-start first");
  const peerHello = b64uDecode(line, "VAMLHELLO.");
  const { index } = buildPackSide(saved);
  const pending = {
    hello: pendingSaved.hello,
    privateKey: createPrivateKey({ key: b64ToBuf(pendingSaved.privateKey), format: "der", type: "pkcs8" }),
  };
  const session = finishHandshake(pending, peerHello, index, b64ToBuf(saved.authKey), peerHello.agentId);
  await writePrivate(files.session, {
    ...serializeSession(session),
    expectedConfirmation: Buffer.from(session.expectedConfirmation).toString("base64"),
  });
  console.log("Handshake finished. Paste your confirmation line to the room:");
  console.log(`VAMLCONFIRM.${session.confirmationTag}`);
}

async function cmdPairConfirm() {
  const line = args[args.indexOf("pair-confirm") + 1];
  if (!line || !line.startsWith("VAMLCONFIRM.")) throw new Error("Usage: pair-confirm <VAMLCONFIRM line>");
  const saved = await readJson(files.session);
  if (!saved || !saved.expectedConfirmation) throw new Error("Need pair-finish first");
  const runtime = restoreRuntime(saved);
  // Real verification primitive: throws on mismatch, confirms on match.
  verifyConfirmation(
    { context: runtime.context, expectedConfirmation: b64ToBuf(saved.expectedConfirmation) },
    line.slice("VAMLCONFIRM.".length).trim(),
  );
  saved.context.confirmed = true;
  await writePrivate(files.session, saved);
  console.log(`Paired with "${saved.context.remoteAgentId}". Session confirmed. Chat with: send / recv`);
}

async function loadRuntime() {
  const saved = await readJson(files.session);
  if (!saved) throw new Error("No session: finish pairing first");
  if (!saved.context.confirmed) throw new Error("Session not confirmed: run pair-confirm first");
  return { runtime: restoreRuntime(saved), saved };
}

async function cmdSend() {
  const text = args.slice(args.indexOf("send") + 1).join(" ");
  if (!text || text.length > MAX_CHAT) throw new Error(`Provide message text (1-${MAX_CHAT} chars)`);
  const { runtime, saved } = await loadRuntime();
  const sealed = runtime.seal(Buffer.from(text, "utf8"), 0);
  await writePrivate(files.session, serializeSession({ context: runtime.context, conceptToCode: runtime.conceptToCode, codeToConcept: runtime.codeToConcept, confirmationTag: saved.confirmationTag }));
  console.log("Paste this line to the room:");
  console.log(encodeVamlFrameToText(sealed));
}

async function cmdSendChars() {
  // Every single character gets its own sealed Agent-language line:
  // 中文、emoji、拉丁字母一视同仁，无一例外走 AEAD + armor。
  const text = args.slice(args.indexOf("sendchars") + 1).join(" ");
  const chars = [...text];
  if (!chars.length || chars.length > 200) throw new Error("Provide 1-200 characters");
  const { runtime, saved } = await loadRuntime();
  for (const ch of chars) {
    const sealed = runtime.seal(Buffer.from(ch, "utf8"), 0);
    console.log(encodeVamlFrameToText(sealed));
  }
  await writePrivate(files.session, serializeSession({ context: runtime.context, conceptToCode: runtime.conceptToCode, codeToConcept: runtime.codeToConcept, confirmationTag: saved.confirmationTag }));
  console.error(`${chars.length} Agent-language lines printed (one per character). Paste them all; the peer recvs each line.`);
}

async function cmdRecv() {
  const line = args.slice(args.indexOf("recv") + 1).join(" ");
  if (!line) throw new Error("Usage: recv <VAMLTXT1 line>");
  const { runtime, saved } = await loadRuntime();
  const frame = decodeVamlFrameFromText(line);
  const plain = runtime.open(frame, 0);
  await writePrivate(files.session, serializeSession({ context: runtime.context, conceptToCode: runtime.conceptToCode, codeToConcept: runtime.codeToConcept, confirmationTag: saved.confirmationTag }));
  console.log(new TextDecoder("utf-8", { fatal: true }).decode(plain));
}

async function cmdStatus() {
  const bundle = await readJson(files.bundle);
  const session = await readJson(files.session);
  const pending = await readJson(files.pending);
  console.log(JSON.stringify({
    id: bundle?.id ?? null,
    paired: !!session,
    confirmed: !!session?.context?.confirmed,
    peer: session?.context?.remoteAgentId ?? null,
    sendSequence: session?.context?.sendSequence ?? null,
    receiveSequence: session?.context?.receiveSequence ?? null,
    helloReady: !!pending,
  }, null, 2));
}

async function main() {
  const cmdArgs = [...args];
  const dirFlag = cmdArgs.indexOf("--dir");
  if (dirFlag >= 0) cmdArgs.splice(dirFlag, 2);
  const cmd = cmdArgs[0];
  try {
    if (cmd === "init") await cmdInit();
    else if (cmd === "pair-start") await cmdPairStart();
    else if (cmd === "pair-finish") await cmdPairFinish();
    else if (cmd === "pair-confirm") await cmdPairConfirm();
    else if (cmd === "send") await cmdSend();
    else if (cmd === "sendchars") await cmdSendChars();
    else if (cmd === "recv") await cmdRecv();
    else if (cmd === "status") await cmdStatus();
    else {
      console.log("Usage: node tools/vaml-text-chat.mjs [--dir STATE] <init|pair-start|pair-finish|pair-confirm|send|recv|status> [...]");
      console.log("  init --id NAME [--bundle VAMLBUNDLE...]");
      console.log("  pair-start | pair-finish <VAMLHELLO> | pair-confirm <VAMLCONFIRM> | send <text> | sendchars <text> | recv <VAMLTXT1>");
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

await main();
