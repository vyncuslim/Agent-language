import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  acousticFingerprint,
  decodeVamlFrameFromWav,
  encodeVamlFrameToWav,
} from "../src/index.js";

test("acoustic transport round-trips an opaque encrypted VAML frame", () => {
  const frame = randomBytes(96);
  const wav = encodeVamlFrameToWav(frame);
  const decoded = decodeVamlFrameFromWav(wav);
  assert.deepEqual(decoded, frame);
  assert.equal(acousticFingerprint(wav).length, 64);
});

test("acoustic transport rejects a corrupted packet", () => {
  const frame = randomBytes(48);
  const wav = encodeVamlFrameToWav(frame);
  const damaged = Buffer.from(wav);
  const midpoint = Math.floor(damaged.length / 2);
  for (let i = 0; i < 512 && midpoint + i < damaged.length; i++) damaged[midpoint + i] = 0;
  assert.throws(() => decodeVamlFrameFromWav(damaged), /CRC|preamble|magic|Truncated/);
});
