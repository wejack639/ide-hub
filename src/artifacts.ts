import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, defaultDataRoot } from "./util/fs.js";
import { stableJson, stablePrettyJson } from "./util/stable-json.js";

export class MigrationArtifacts {
  readonly directory: string;
  readonly journalPath: string;

  constructor(migrationId: string, root = defaultDataRoot()) {
    this.directory = join(root, "migrations", migrationId);
    this.journalPath = join(this.directory, "journal.jsonl");
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }

  async writeJson(name: string, value: unknown): Promise<string> {
    const path = join(this.directory, name);
    await atomicWrite(path, stablePrettyJson(value));
    return path;
  }

  async writeText(name: string, value: string): Promise<string> {
    const path = join(this.directory, name);
    await atomicWrite(path, value);
    return path;
  }

  async appendJournal(state: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.initialize();
    const entry = {
      at: new Date().toISOString(),
      state,
      details,
    };
    await appendFile(this.journalPath, `${stableJson(entry)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}
