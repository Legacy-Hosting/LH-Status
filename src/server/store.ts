import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { statusSnapshotSchema, type SnapshotStore } from "./status.js";

export function createFileSnapshotStore(path: string): SnapshotStore {
  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        const snapshot = statusSnapshotSchema.safeParse(parsed);
        return snapshot.success ? snapshot.data : null;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
      }
    },
    async save(snapshot) {
      await mkdir(dirname(path), { recursive: true, mode: 0o750 });
      const temporaryPath = `${path}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(snapshot)}\n`, {
        encoding: "utf8",
        mode: 0o644,
      });
      await rename(temporaryPath, path);
    },
  };
}
