import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { FileFingerprint } from "../types.js";

export function sha256Text(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function fingerprintFile(path: string): Promise<FileFingerprint> {
  const metadata = await stat(path);
  return {
    path,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    sha256: await sha256File(path),
  };
}

export async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  await writeFile(temporary, content, { mode: 0o600 });
  const descriptor = await open(temporary, "r");
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
  await rename(temporary, path);
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function defaultDataRoot(): string {
  return (
    process.env.IDE_HUB_DATA_DIR ??
    join(homedir(), "Library", "Application Support", "IDE Hub")
  );
}
