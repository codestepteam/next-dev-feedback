import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(packageRoot, "src");
const outputRoot = path.join(packageRoot, "dist");

async function copyCssFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const sourcePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await copyCssFiles(sourcePath);
        return;
      }

      if (!entry.isFile() || !entry.name.endsWith(".css")) {
        return;
      }

      const relativePath = path.relative(sourceRoot, sourcePath);
      const outputPath = path.join(outputRoot, relativePath);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await cp(sourcePath, outputPath);
    }),
  );
}

await copyCssFiles(sourceRoot);
