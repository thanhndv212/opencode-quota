import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code ?? signal}`));
    });
  });
}

export async function withConsumer(tarball, callback) {
  const root = await mkdtemp(path.join(tmpdir(), "quota-consumer-"));
  try {
    let artifact = tarball && path.resolve(tarball);
    if (!artifact) {
      await run("pnpm", ["pack", "--pack-destination", root]);
      const archives = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
      if (archives.length !== 1) throw new Error("Expected exactly one packed package");
      artifact = path.join(root, archives[0]);
    }
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "quota-smoke-consumer", private: true, type: "module" }),
    );
    await run(
      "npm",
      ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", artifact],
      {
        cwd: root,
      },
    );
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
