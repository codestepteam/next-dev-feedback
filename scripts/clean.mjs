import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

await rm(path.join(packageRoot, "dist"), {
  force: true,
  recursive: true,
});
