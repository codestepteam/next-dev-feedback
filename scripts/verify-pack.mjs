import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(
  await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
const expectedAllowlist = ["dist", "docs", "LICENSE", "README.md"];

function collectPackageTargets(value, targets = []) {
  if (typeof value === "string") {
    if (value.startsWith("./")) {
      targets.push(value.slice(2));
    }
    return targets;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const nestedValue of Object.values(value)) {
      collectPackageTargets(nestedValue, targets);
    }
  }

  return targets;
}

function collectBinTargets(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("package.json bin must be an object.");
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
        `bin.${command} must use npm's normalized package-relative form: ${String(target)}`,
      );
    }
    return target;
  });
}

if (JSON.stringify(packageJson.files) !== JSON.stringify(expectedAllowlist)) {
  throw new Error(
    `package.json files must be exactly ${JSON.stringify(expectedAllowlist)}.`,
  );
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(
  npmCommand,
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    cwd: packageRoot,
    encoding: "utf8",
  },
);

if (result.status !== 0) {
  throw new Error(result.stderr || result.stdout || "npm pack --dry-run failed.");
}

const [report] = JSON.parse(result.stdout);
const files = report.files.map(({ path: filePath }) => filePath);
const forbiddenPrefixes = ["src/", "tests/", "scripts/", ".feedback/"];
const forbiddenFiles = files.filter((filePath) =>
  forbiddenPrefixes.some((prefix) => filePath.startsWith(prefix)),
);

if (forbiddenFiles.length > 0) {
  throw new Error(`Unexpected files in package: ${forbiddenFiles.join(", ")}`);
}

const requiredFiles = [...new Set([
  "package.json",
  "README.md",
  "LICENSE",
  "dist/client/dev-feedback.module.css",
  packageJson.main.slice(2),
  packageJson.types.slice(2),
  ...collectBinTargets(packageJson.bin),
  ...collectPackageTargets(packageJson.exports),
])];
const missingFiles = requiredFiles.filter((filePath) => !files.includes(filePath));

if (missingFiles.length > 0) {
  throw new Error(`Required package files are missing: ${missingFiles.join(", ")}`);
}

console.log(`verified npm package allowlist (${files.length} files)`);
