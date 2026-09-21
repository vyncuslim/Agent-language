import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  acousticFingerprint,
  decodeVamlFrameFromWav,
  encodeVamlFrameToWav,
} from "../src/index.js";

const opaqueFrame = randomBytes(64);
const wav = encodeVamlFrameToWav(opaqueFrame);
const recovered = decodeVamlFrameFromWav(wav);
if (!recovered.equals(opaqueFrame)) throw new Error("Acoustic VAML round-trip failed");

const output = "vaml-acoustic-demo.wav";
await writeFile(output, wav);
console.log(JSON.stringify({
  output,
  bytes: wav.length,
  fingerprint: acousticFingerprint(wav),
  semanticContentLogged: false,
}));
