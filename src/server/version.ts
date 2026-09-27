import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const metadata = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as { version?: unknown };

if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+/.test(metadata.version)) {
  throw new Error("LH-Status package version is invalid");
}

export const STATUS_VERSION = metadata.version;
