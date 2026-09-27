#!/usr/bin/env node
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import webPush from "web-push";

if (process.argv.length !== 3) {
  console.error("Usage: node ops/scripts/generate-vapid-keys.mjs OUTPUT_FILE");
  process.exit(2);
}

const output = resolve(process.argv[2]);
const keys = webPush.generateVAPIDKeys();
const contents = [
  `STATUS_PUSH_VAPID_PUBLIC_KEY=${keys.publicKey}`,
  `STATUS_PUSH_VAPID_PRIVATE_KEY=${keys.privateKey}`,
  "",
].join("\n");
await writeFile(output, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
await chmod(output, 0o600);
console.log(`Created protected VAPID environment fragment: ${output}`);
