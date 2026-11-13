import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.env.NATIVE_BUILD = "1";
const node = process.execPath;
const root = fileURLToPath(new URL("..", import.meta.url));
function run(args) {
  const result = spawnSync(node, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
run(["scripts/copy-ort.mjs"]);
run(["node_modules/vite/bin/vite.js", "build"]);
