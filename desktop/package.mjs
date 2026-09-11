import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packager } from "@electron/packager";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const electronPackage = JSON.parse(
  await readFile(join(projectRoot, "node_modules", "electron", "package.json"), "utf8"),
);
const electronVersion = electronPackage.version;
const zipName = `electron-v${electronVersion}-darwin-arm64.zip`;
const cacheRoot = join(homedir(), "Library", "Caches", "electron");
const cacheEntries = await readdir(cacheRoot, { recursive: true, withFileTypes: true });
const cachedZip = cacheEntries.find(
  (entry) => entry.isFile() && entry.name === zipName,
);

if (cachedZip === undefined) {
  throw new Error(
    `Electron runtime cache is missing ${zipName}; run npm install once before packaging`,
  );
}

const outputPaths = await packager({
  dir: projectRoot,
  name: "IDE Hub",
  platform: "darwin",
  arch: "arm64",
  out: join(projectRoot, "release"),
  overwrite: true,
  prune: true,
  asar: { unpackDir: "{cursor-bridge,dsh-bridge,dist/src/pi,dist/src/claude,node_modules/@anthropic-ai/claude-agent-sdk}" },
  appBundleId: "com.idehub.desktop",
  appVersion: "0.1.0",
  electronVersion,
  electronZipDir: dirname(entryPath(cachedZip)),
  // 离线回读只用 SDK JS，不打包其用于 query() 的另一份 Claude CLI。
  ignore: [/^\/(docs|release|schemas|src|test|\.agent|\.agents|\.windsurf)(\/|$)/u,
    /^\/node_modules\/@anthropic-ai\/claude-agent-sdk-(darwin|linux|win32)-/u],
});

console.log(outputPaths.join("\n"));

function entryPath(entry) {
  return join(entry.parentPath, entry.name);
}
