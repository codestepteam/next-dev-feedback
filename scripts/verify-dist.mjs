import { readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);

function collectPackageTargets(value, label, targets = []) {
  if (typeof value === "string") {
    if (!value.startsWith("./")) {
      throw new Error(`${label} must be a relative package target: ${value}`);
    }

    targets.push({ label, target: value.slice(2) });
    return targets;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, nestedValue] of Object.entries(value)) {
      collectPackageTargets(nestedValue, `${label}.${key}`, targets);
    }
    return targets;
  }

  throw new Error(`${label} contains an unsupported package target.`);
}

function collectBinTargets(value, label = "bin") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object of command names and targets.`);
  }

  return Object.entries(value).map(([command, target]) => {
    if (
      typeof target !== "string" ||
      target.length === 0 ||
      target.startsWith("./") ||
      target.includes("\\") ||
      path.isAbsolute(target) ||
      target
        .split("/")
        .some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(
        `${label}.${command} must use npm's normalized package-relative form: ${String(target)}`,
      );
    }

    return { label: `${label}.${command}`, target };
  });
}

const rootExport = packageJson.exports?.["."];
const expectedRootExport = {
  types: "./dist/index.d.ts",
  development: "./dist/index.js",
  production: "./dist/noop.js",
  default: "./dist/noop.js",
};

if (JSON.stringify(rootExport) !== JSON.stringify(expectedRootExport)) {
  throw new Error(
    `The root export must be ${JSON.stringify(expectedRootExport)} so only development resolves the feedback runtime.`,
  );
}

if (packageJson.main !== "./dist/noop.js") {
  throw new Error("package.json main must use the production-safe no-op entry.");
}

if (packageJson.types !== "./dist/index.d.ts") {
  throw new Error("package.json types must expose dist/index.d.ts.");
}

if (!packageJson.sideEffects?.includes("**/*.css")) {
  throw new Error("package.json sideEffects must preserve packaged CSS files.");
}

const targets = [
  ...collectPackageTargets(packageJson.main, "main"),
  ...collectPackageTargets(packageJson.types, "types"),
  ...collectBinTargets(packageJson.bin),
  ...collectPackageTargets(packageJson.exports, "exports"),
];

for (const { label, target } of targets) {
  const targetPath = path.join(packageRoot, target);
  const targetStats = await stat(targetPath).catch(() => null);

  if (!targetStats?.isFile()) {
    throw new Error(`${label} points to a missing file: ${target}`);
  }
}

const cssTarget = "dist/client/dev-feedback.module.css";
const css = await readFile(path.join(packageRoot, cssTarget), "utf8").catch(
  () => "",
);

if (css.trim().length === 0) {
  throw new Error(`${cssTarget} is missing or empty.`);
}

const cli = await readFile(path.join(packageRoot, "dist/cli/index.js"), "utf8");
if (!cli.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("The packaged CLI must preserve its node shebang.");
}

const developmentEntry = await readFile(
  path.join(packageRoot, "dist/index.js"),
  "utf8",
);
if (!developmentEntry.includes('import "server-only";')) {
  throw new Error("The development entry must be marked server-only.");
}
for (const requiredImport of [
  "./client/DevFeedbackCapture.js",
  "./server/save-feedback-action.js",
]) {
  if (!developmentEntry.includes(requiredImport)) {
    throw new Error(`The development entry is missing ${requiredImport}.`);
  }
}

const noopEntry = await readFile(
  path.join(packageRoot, "dist/noop.js"),
  "utf8",
);
for (const forbiddenValue of [
  "client/",
  "server/",
  "html2canvas",
  ".css",
  "saveDevFeedbackAction",
]) {
  if (noopEntry.includes(forbiddenValue)) {
    throw new Error(
      `The production no-op entry must not reference ${JSON.stringify(forbiddenValue)}.`,
    );
  }
}

function resolveSelf(conditions = []) {
  const result = spawnSync(
    process.execPath,
    [
      ...conditions.map((condition) => `--conditions=${condition}`),
      "--input-type=module",
      "--eval",
      `process.stdout.write(import.meta.resolve(${JSON.stringify(packageJson.name)}))`,
    ],
    { cwd: packageRoot, encoding: "utf8" },
  );

  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || "Failed to resolve the package export.",
    );
  }

  return result.stdout.trim();
}

const expectedResolutions = [
  { conditions: [], target: "dist/noop.js" },
  { conditions: ["development"], target: "dist/index.js" },
  { conditions: ["production"], target: "dist/noop.js" },
];

for (const { conditions, target } of expectedResolutions) {
  const actual = resolveSelf(conditions);
  const expected = pathToFileURL(path.join(packageRoot, target)).href;
  if (actual !== expected) {
    throw new Error(
      `${conditions.join("+") || "default"} condition resolved ${actual}, expected ${expected}.`,
    );
  }
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(entryPath) : [entryPath];
    }),
  );
  return nested.flat();
}

const distRoot = path.join(packageRoot, "dist");
const distFiles = await collectFiles(distRoot);
const declarationMaps = distFiles.filter((filePath) =>
  filePath.endsWith(".d.ts.map"),
);
if (declarationMaps.length > 0) {
  throw new Error(
    "Declaration maps must stay disabled because TypeScript does not embed their source files.",
  );
}

const sourceMaps = distFiles.filter((filePath) => filePath.endsWith(".js.map"));

if (sourceMaps.length === 0) {
  throw new Error("No source maps were emitted.");
}

for (const sourceMapPath of sourceMaps) {
  const sourceMap = JSON.parse(await readFile(sourceMapPath, "utf8"));
  if (
    !Array.isArray(sourceMap.sources) ||
    !Array.isArray(sourceMap.sourcesContent) ||
    sourceMap.sources.length !== sourceMap.sourcesContent.length ||
    sourceMap.sourcesContent.some(
      (sourceContent) =>
        typeof sourceContent !== "string" || sourceContent.length === 0,
    )
  ) {
    throw new Error(
      `${path.relative(packageRoot, sourceMapPath)} must embed every source with inlineSources.`,
    );
  }
}

console.log(
  `verified ${targets.length} package targets, conditional resolution, CSS, no-op isolation, and ${sourceMaps.length} source maps`,
);
