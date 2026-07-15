import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(packageRoot, "src");
const outputRoot = path.join(packageRoot, "dist");
const directivePattern = /^(?:\uFEFF)?(?:#![^\n]*\n)?\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*(?:\n|$)\s*)*(["'])(use client|use server)\1\s*;/;

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return collectSourceFiles(entryPath);
      }

      if (
        entry.isFile() &&
        /\.(?:ts|tsx)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        return [entryPath];
      }

      return [];
    }),
  );

  return nested.flat();
}

const sourceFiles = await collectSourceFiles(sourceRoot);
const directiveFiles = [];

for (const sourceFile of sourceFiles) {
  const source = await readFile(sourceFile, "utf8");
  const sourceMatch = source.match(directivePattern);

  if (!sourceMatch) {
    continue;
  }

  const directive = sourceMatch[2];
  const relativeSourcePath = path.relative(sourceRoot, sourceFile);
  const relativeOutputPath = relativeSourcePath.replace(/\.(?:ts|tsx)$/, ".js");
  const outputFile = path.join(outputRoot, relativeOutputPath);
  const output = await readFile(outputFile, "utf8");
  const outputMatch = output.match(directivePattern);

  if (outputMatch?.[2] !== directive) {
    throw new Error(
      `${relativeOutputPath} must preserve the ${JSON.stringify(directive)} directive as its first statement.`,
    );
  }

  directiveFiles.push({ directive, relativeOutputPath });
}

for (const requiredDirective of ["use client", "use server"]) {
  if (!directiveFiles.some(({ directive }) => directive === requiredDirective)) {
    throw new Error(`No source entry with ${JSON.stringify(requiredDirective)} was found.`);
  }
}

for (const { directive, relativeOutputPath } of directiveFiles) {
  console.log(`verified ${JSON.stringify(directive)} in ${relativeOutputPath}`);
}
