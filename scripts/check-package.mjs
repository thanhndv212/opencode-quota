import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./lib/package-consumer.mjs";

const root = await mkdtemp(path.join(tmpdir(), "quota-pack-"));
try {
  await run("pnpm", ["pack", "--pack-destination", root]);
  const archives = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("Expected exactly one package tarball");
  await run(process.execPath, [
    fileURLToPath(new URL("smoke-package.mjs", import.meta.url)),
    path.join(root, archives[0]),
  ]);
} finally {
  await rm(root, { recursive: true, force: true });
}
