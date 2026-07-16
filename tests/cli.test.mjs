import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CliError,
  parseCliArgs,
  runInit,
  transformGitignore,
  transformNextConfig,
  transformRootLayout,
} from "../src/cli/init.ts";

const BASE_LAYOUT = `import "./globals.css";

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>
        {children}
      </body>
    </html>
  );
}
`;

function initOptions(projectRoot, overrides = {}) {
  return {
    projectRoot,
    yes: true,
    dryRun: false,
    check: false,
    metadataOnly: false,
    bodySizeLimit: "32mb",
    layout: true,
    gitignore: true,
    config: true,
    ...overrides,
  };
}

async function createProject({
  layout = BASE_LAYOUT,
  config = "const nextConfig = { reactStrictMode: true };\nexport default nextConfig;\n",
  edgeFile,
} = {}) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "next-dev-feedback-cli-"));
  await mkdir(path.join(projectRoot, "src/app"), { recursive: true });
  await writeFile(
    path.join(projectRoot, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      dependencies: { next: "16.2.10", react: "19.2.4" },
    }),
  );
  await writeFile(path.join(projectRoot, "src/app/layout.tsx"), layout);
  if (config !== null) {
    await writeFile(path.join(projectRoot, "next.config.ts"), config);
  }
  if (edgeFile) {
    await mkdir(path.dirname(path.join(projectRoot, edgeFile)), { recursive: true });
    await writeFile(
      path.join(projectRoot, edgeFile),
      `export const runtime = "edge";\nexport default function Page() { return null; }\n`,
    );
  }
  return projectRoot;
}

test("CLI arguments support initialization modes and reject unsafe values", () => {
  const options = parseCliArgs([
    "init",
    "--yes",
    "--dry-run",
    "--metadata-only",
    "--body-size-limit=48mb",
    "--no-gitignore",
  ]);
  assert.equal(options.yes, true);
  assert.equal(options.dryRun, true);
  assert.equal(options.metadataOnly, true);
  assert.equal(options.bodySizeLimit, "48mb");
  assert.equal(options.gitignore, false);
  assert.throws(
    () => parseCliArgs(["init", "--body-size-limit", "large"]),
    CliError,
  );
  assert.throws(() => parseCliArgs(["install"]), CliError);
});

test("root layout insertion is development-only, mode-aware, and idempotent", () => {
  const first = transformRootLayout(BASE_LAYOUT);
  assert.equal(first.changed, true);
  assert.match(
    first.content,
    /import \{ DevFeedbackCapture \} from "@tallpizza\/next-dev-feedback";/,
  );
  assert.match(
    first.content,
    /process\.env\.NODE_ENV === "development"[\s\S]*<DevFeedbackCapture \/>/,
  );
  assert.ok(first.content.indexOf("<DevFeedbackCapture />") < first.content.indexOf("</body>"));

  const second = transformRootLayout(first.content);
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);

  const metadataOnly = transformRootLayout(first.content, { metadataOnly: true });
  assert.equal(metadataOnly.changed, true);
  assert.match(metadataOnly.content, /<DevFeedbackCapture metadataOnly \/>/);
  assert.equal(
    transformRootLayout(metadataOnly.content, { metadataOnly: true }).changed,
    false,
  );

  const fullAgain = transformRootLayout(metadataOnly.content);
  assert.match(fullAgain.content, /<DevFeedbackCapture \/>/);
  assert.doesNotMatch(fullAgain.content, /metadataOnly/);
});

test("root layout import detection does not cross an earlier named import", () => {
  const initialized = transformRootLayout(BASE_LAYOUT);
  const withEarlierNamedImport = initialized.content.replace(
    'import { DevFeedbackCapture } from "@tallpizza/next-dev-feedback";',
    `import { Geist } from "next/font/google";
import { DevFeedbackCapture } from "@tallpizza/next-dev-feedback";`,
  );

  const result = transformRootLayout(withEarlierNamedImport);
  assert.equal(result.changed, false);
  assert.equal(result.content, withEarlierNamedImport);
  assert.equal(
    result.content.match(/from "@tallpizza\/next-dev-feedback"/g)?.length,
    1,
  );
});

test("root layout uses a neutral alias when the default local name is occupied", () => {
  const source = BASE_LAYOUT.replace(
    "export default function RootLayout",
    "const DevFeedbackCapture = null;\n\nexport default function RootLayout",
  );

  const result = transformRootLayout(source);
  assert.match(
    result.content,
    /import \{ DevFeedbackCapture as NextDevFeedbackCapture \} from "@tallpizza\/next-dev-feedback";/,
  );
  assert.match(result.content, /<NextDevFeedbackCapture \/>/);
});

test("root layout transform refuses ambiguous or incompatible layouts", () => {
  assert.throws(
    () => transformRootLayout("export default function Layout() { return <main />; }"),
    /closing <\/body>/,
  );
  assert.throws(
    () => transformRootLayout(`"use client";\n${BASE_LAYOUT}`),
    /use-client\/use-server/,
  );
  assert.throws(
    () =>
      transformRootLayout(
        BASE_LAYOUT.replace(
          "{children}",
          "{children}<DevFeedbackCapture />",
        ),
      ),
    /without a recognizable development-only condition/,
  );
});

test("Next config transform preserves simple config fields and is idempotent", () => {
  const source = `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["macmini"],
};

export default nextConfig;
`;
  const first = transformNextConfig(source, "32mb");
  assert.equal(first.changed, true);
  assert.match(first.content, /allowedDevOrigins: \["macmini"\]/);
  assert.match(
    first.content,
    /bodySizeLimit:\s*process\.env\.NODE_ENV === "development" \? "32mb" : "1mb"/,
  );
  const second = transformNextConfig(first.content, "32mb");
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);
});

test("Next config transform merges nested objects without replacing user fields", () => {
  const source = `export default {
  experimental: {
    serverActions: {
      allowedOrigins: ["proxy.local"],
    },
    optimizePackageImports: ["icons"],
  },
};
`;
  const transformed = transformNextConfig(source, "40mb");
  assert.match(transformed.content, /allowedOrigins: \["proxy\.local"\]/);
  assert.match(transformed.content, /optimizePackageImports: \["icons"\]/);
  assert.match(transformed.content, /"40mb"/);

  assert.throws(
    () =>
      transformNextConfig(
        `export default withBundleAnalyzer({ experimental: {} });\n`,
      ),
    /complex default export|function or wrapped expression/,
  );
  assert.throws(
    () => transformNextConfig(`export default { ...sharedConfig };\n`),
    /object spread/,
  );
  assert.throws(
    () =>
      transformNextConfig(
        `export default { experimental: { serverActions: { bodySizeLimit: "8mb" } } };\n`,
      ),
    /different value/,
  );
});

test("missing Next config creates an ESM config and gitignore stays idempotent", () => {
  const config = transformNextConfig(null);
  assert.match(config.content, /export default nextConfig/);
  assert.match(config.content, /"32mb"/);
  assert.equal(transformNextConfig(config.content).changed, false);

  const ignored = transformGitignore("node_modules/\n");
  assert.equal(ignored.content, "node_modules/\n# Local UI feedback captures\n.feedback/\n");
  assert.equal(transformGitignore(ignored.content).changed, false);
});

test("init dry-run, apply, and check form an idempotent workflow", async () => {
  const projectRoot = await createProject();
  try {
    const layoutPath = path.join(projectRoot, "src/app/layout.tsx");
    const configPath = path.join(projectRoot, "next.config.ts");
    const layoutBefore = await readFile(layoutPath, "utf8");
    const configBefore = await readFile(configPath, "utf8");

    const dryRun = await runInit(initOptions(projectRoot, { dryRun: true }));
    assert.deepEqual(
      dryRun.changedFiles.sort(),
      [".gitignore", "next.config.ts", "src/app/layout.tsx"].sort(),
    );
    assert.equal(dryRun.applied, false);
    assert.equal(await readFile(layoutPath, "utf8"), layoutBefore);
    assert.equal(await readFile(configPath, "utf8"), configBefore);

    const applied = await runInit(initOptions(projectRoot));
    assert.equal(applied.applied, true);
    assert.match(await readFile(layoutPath, "utf8"), /DevFeedbackCapture/);
    assert.match(await readFile(configPath, "utf8"), /bodySizeLimit/);
    assert.match(await readFile(path.join(projectRoot, ".gitignore"), "utf8"), /\.feedback\//);

    const check = await runInit(initOptions(projectRoot, { check: true }));
    assert.equal(check.checkFailed, false);
    assert.deepEqual(check.changedFiles, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("metadata-only mode does not create or update Next config", async () => {
  const projectRoot = await createProject({ config: null });
  try {
    const result = await runInit(
      initOptions(projectRoot, { metadataOnly: true }),
    );
    assert.equal(result.applied, true);
    assert.deepEqual(
      result.changedFiles.sort(),
      [".gitignore", "src/app/layout.tsx"].sort(),
    );
    assert.match(
      await readFile(path.join(projectRoot, "src/app/layout.tsx"), "utf8"),
      /<DevFeedbackCapture metadataOnly \/>/,
    );
    await assert.rejects(readFile(path.join(projectRoot, "next.config.mjs"), "utf8"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("preflight errors leave every project file untouched", async () => {
  const projectRoot = await createProject({
    edgeFile: "src/app/edge/page.tsx",
  });
  try {
    const layoutPath = path.join(projectRoot, "src/app/layout.tsx");
    const layoutBefore = await readFile(layoutPath, "utf8");
    await assert.rejects(
      runInit(initOptions(projectRoot)),
      /Edge Runtime cannot write \.feedback files/,
    );
    assert.equal(await readFile(layoutPath, "utf8"), layoutBefore);
    await assert.rejects(readFile(path.join(projectRoot, ".gitignore"), "utf8"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("multiple and complex Next configs fail before writes", async () => {
  const projectRoot = await createProject();
  try {
    await writeFile(
      path.join(projectRoot, "next.config.mjs"),
      "export default {};\n",
    );
    const layoutPath = path.join(projectRoot, "src/app/layout.tsx");
    const layoutBefore = await readFile(layoutPath, "utf8");
    await assert.rejects(runInit(initOptions(projectRoot)), /Multiple Next config files/);
    assert.equal(await readFile(layoutPath, "utf8"), layoutBefore);
    await assert.rejects(readFile(path.join(projectRoot, ".gitignore"), "utf8"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
