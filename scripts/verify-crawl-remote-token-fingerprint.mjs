#!/usr/bin/env node
import { scryptSync, timingSafeEqual } from "node:crypto";
import process from "node:process";

const token = process.env.CLOUDFLARE_API_TOKEN;
const fingerprint = process.env.CLOUDFLARE_TOKEN_FINGERPRINT;
if (!token || !fingerprint) {
  throw new Error("Cloudflare token fingerprint verification requires both inputs");
}

const match = /^scrypt-v1:([0-9a-f]{32}):([0-9a-f]{64})$/.exec(fingerprint);
if (!match) {
  throw new Error("Cloudflare token fingerprint is malformed");
}

const expected = Buffer.from(match[2], "hex");
const actual = scryptSync(token, Buffer.from(match[1], "hex"), expected.length, {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});
if (!timingSafeEqual(actual, expected)) {
  throw new Error("Cloudflare token does not match the protected environment fingerprint");
}
