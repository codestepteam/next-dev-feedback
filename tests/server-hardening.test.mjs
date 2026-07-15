import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  parsePngDataUrl,
  saveDevFeedback,
  validateFeedbackSubmission,
} from "../src/server/persistence.ts";

const ONE_PIXEL_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createPngChunk(type, data) {
  assert.match(type, /^[A-Za-z]{4}$/);
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(
    crc32(Buffer.concat([typeBytes, data])),
    data.length + 8,
  );
  return chunk;
}

function insertChunkBefore(dataUrl, beforeType, type, data) {
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const currentType = png.toString("ascii", offset + 4, offset + 8);
    if (currentType === beforeType) {
      const result = Buffer.concat([
        png.subarray(0, offset),
        createPngChunk(type, data),
        png.subarray(offset),
      ]);
      return `data:image/png;base64,${result.toString("base64")}`;
    }
    offset += length + 12;
  }
  throw new Error(`PNG chunk ${beforeType} was not found`);
}

function replaceFirstChunkData(dataUrl, targetType, transform) {
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const currentType = png.toString("ascii", offset + 4, offset + 8);
    if (currentType === targetType) {
      const currentData = png.subarray(offset + 8, offset + 8 + length);
      const replacement = createPngChunk(targetType, transform(currentData));
      const result = Buffer.concat([
        png.subarray(0, offset),
        replacement,
        png.subarray(offset + length + 12),
      ]);
      return `data:image/png;base64,${result.toString("base64")}`;
    }
    offset += length + 12;
  }
  throw new Error(`PNG chunk ${targetType} was not found`);
}

function pngWithDimensions(dataUrl, width, height) {
  return replaceFirstChunkData(dataUrl, "IHDR", (header) => {
    const updated = Buffer.from(header);
    updated.writeUInt32BE(width, 0);
    updated.writeUInt32BE(height, 4);
    return updated;
  });
}

function rawSubmission(filePath, screenshots = { full: null, target: null }) {
  return {
    request: "선택한 UI를 개선해 주세요.",
    page: {
      url: "http://localhost:3000/dashboard",
      pathname: "/dashboard",
      search: "",
      viewportWidth: 1280,
      viewportHeight: 720,
      devicePixelRatio: 2,
      scrollX: 0,
      scrollY: 0,
      userAgent: "server-hardening-test",
    },
    target: {
      selector: "main > button",
      tagName: "button",
      textContent: "저장",
      outerHTML: "<button>저장</button>",
      boundingRect: {
        x: 10,
        y: 20,
        top: 20,
        left: 10,
        right: 110,
        bottom: 60,
        width: 100,
        height: 40,
      },
      attributes: { "data-testid": "save" },
    },
    source: {
      componentName: "SaveButton",
      filePath,
      lineNumber: 12,
      columnNumber: 3,
    },
    screenshots,
  };
}

test("source.filePath accepts only repository-relative POSIX paths", () => {
  const validPaths = [
    "src/components/SaveButton.tsx",
    "app/(dashboard)/page.tsx",
    "packages/화면/components/버튼.tsx",
  ];
  for (const filePath of validPaths) {
    assert.equal(
      validateFeedbackSubmission(rawSubmission(filePath)).source?.filePath,
      filePath,
    );
  }

  const invalidPaths = [
    "/etc/passwd",
    "../outside.tsx",
    "src/../outside.tsx",
    "./src/Button.tsx",
    "src//Button.tsx",
    "src/Button.tsx/",
    "C:/repo/src/Button.tsx",
    "C:\\repo\\src\\Button.tsx",
    "C:src/Button.tsx",
    "\\\\server\\share\\Button.tsx",
    "//server/share/Button.tsx",
    "https://example.com/Button.tsx",
    "file:///tmp/Button.tsx",
    "data:text/plain,Button.tsx",
    "~/src/Button.tsx",
    "src/Button.tsx?raw",
    "src/Button.tsx#L12",
    "src/Button.tsx\0",
    "src/Button.tsx\n",
    "src/\u2028Button.tsx",
  ];
  for (const filePath of invalidPaths) {
    assert.throws(
      () => validateFeedbackSubmission(rawSubmission(filePath)),
      /repository-relative POSIX path/,
      filePath,
    );
  }

  assert.throws(
    () =>
      validateFeedbackSubmission(
        rawSubmission(
          "src/eyJabcdefgh.abcdefgh.abcdefgh/SaveButton.tsx",
        ),
      ),
    /must not contain sensitive values/,
  );
});

test("server validation redacts sensitive pathname and component values", () => {
  const submission = rawSubmission("src/components/SaveButton.tsx");
  submission.page.url =
    "http://localhost:3000/invite/path-secret?tab=open";
  submission.page.pathname = "/invite/path-secret";
  submission.page.search = "?tab=open";
  submission.source.componentName = "token=component-secret";

  const validated = validateFeedbackSubmission(submission);
  assert.equal(
    validated.page.pathname,
    "/invite/%5Bredacted%5D",
  );
  assert.equal(new URL(validated.page.url).pathname, validated.page.pathname);
  assert.equal(validated.source?.componentName, "token=[redacted]");
  assert.doesNotMatch(
    JSON.stringify(validated),
    /path-secret|component-secret/,
  );
});

test("PNG parsing allows canvas color metadata and rejects data-bearing chunks", () => {
  const gamma = Buffer.alloc(4);
  gamma.writeUInt32BE(45_455);
  const pixelsPerMeter = Buffer.alloc(9);
  pixelsPerMeter.writeUInt32BE(3_780, 0);
  pixelsPerMeter.writeUInt32BE(3_780, 4);
  pixelsPerMeter.writeUInt8(1, 8);

  let canvasPng = insertChunkBefore(
    ONE_PIXEL_PNG,
    "IDAT",
    "gAMA",
    gamma,
  );
  canvasPng = insertChunkBefore(
    canvasPng,
    "IDAT",
    "sRGB",
    Buffer.from([0]),
  );
  canvasPng = insertChunkBefore(
    canvasPng,
    "IDAT",
    "pHYs",
    pixelsPerMeter,
  );
  assert.ok(parsePngDataUrl(canvasPng).length > 0);

  const forbiddenChunks = [
    ["tEXt", Buffer.from("comment\0private")],
    ["iTXt", Buffer.from("comment\0\0\0\0\0private")],
    ["zTXt", Buffer.from("comment\0\0compressed")],
    ["eXIf", Buffer.from([0x49, 0x49, 0x2a, 0])],
    ["iCCP", Buffer.from("profile\0\0compressed")],
    ["tIME", Buffer.alloc(7)],
    ["ABCD", Buffer.alloc(0)],
    ["vpAg", Buffer.alloc(0)],
  ];
  for (const [type, data] of forbiddenChunks) {
    const dataUrl = insertChunkBefore(ONE_PIXEL_PNG, "IDAT", type, data);
    assert.throws(
      () => parsePngDataUrl(dataUrl),
      /not allowed/,
      type,
    );
  }
});

test("PNG parsing bounds inflate output and validates image scanlines", () => {
  const corruptedImageData = replaceFirstChunkData(
    ONE_PIXEL_PNG,
    "IDAT",
    (imageData) => {
      const corrupted = Buffer.from(imageData);
      corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
      return corrupted;
    },
  );
  assert.throws(
    () => parsePngDataUrl(corruptedImageData),
    /PNG image data/i,
  );

  const trailingImageData = replaceFirstChunkData(
    ONE_PIXEL_PNG,
    "IDAT",
    (imageData) => Buffer.concat([imageData, Buffer.from("hidden-tail")]),
  );
  assert.throws(
    () => parsePngDataUrl(trailingImageData),
    /trailing bytes/i,
  );

  const invalidFilter = replaceFirstChunkData(
    ONE_PIXEL_PNG,
    "IDAT",
    () => deflateSync(Buffer.from([5, 0, 0])),
  );
  assert.throws(
    () => parsePngDataUrl(invalidFilter),
    /scanline filter/i,
  );

  const excessiveDecodedOutput = pngWithDimensions(
    ONE_PIXEL_PNG,
    9_000,
    8_000,
  );
  assert.throws(
    () => parsePngDataUrl(excessiveDecodedOutput),
    /decoded size is too large/i,
  );
});

test("save rejects a .feedback symlink that escapes the project root", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "next-dev-feedback-symlink-"),
  );
  const projectRoot = path.join(temporaryRoot, "project");
  const outsideRoot = path.join(temporaryRoot, "outside");
  await mkdir(projectRoot, { mode: 0o700 });
  await mkdir(outsideRoot, { mode: 0o700 });
  await symlink(outsideRoot, path.join(projectRoot, ".feedback"), "dir");

  try {
    const submission = validateFeedbackSubmission(
      rawSubmission("src/components/SaveButton.tsx"),
    );
    await assert.rejects(
      saveDevFeedback(submission, { projectRoot }),
      /\.feedback must be a real directory|escapes the project root/,
    );
    assert.deepEqual(await readdir(outsideRoot), []);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("new feedback directories and files use private permissions", async () => {
  const projectRoot = await mkdtemp(
    path.join(tmpdir(), "next-dev-feedback-mode-"),
  );

  try {
    const submission = validateFeedbackSubmission(
      rawSubmission("src/components/SaveButton.tsx", {
        full: ONE_PIXEL_PNG,
        target: ONE_PIXEL_PNG,
      }),
    );
    const result = await saveDevFeedback(submission, {
      projectRoot,
      now: new Date(2026, 6, 15, 10, 0),
    });
    const feedbackRoot = path.join(projectRoot, ".feedback");
    const recordRoot = path.join(projectRoot, result.directory);

    assert.equal((await lstat(feedbackRoot)).mode & 0o777, 0o700);
    assert.equal((await lstat(recordRoot)).mode & 0o777, 0o700);

    const privateFiles = [
      path.join(feedbackRoot, "README.md"),
      path.join(recordRoot, "summary.json"),
      path.join(recordRoot, "metadata.json"),
      path.join(recordRoot, "screenshot-full.png"),
      path.join(recordRoot, "screenshot-target.png"),
    ];
    for (const filePath of privateFiles) {
      const stats = await lstat(filePath);
      assert.equal(stats.isFile(), true);
      assert.equal(stats.mode & 0o777, 0o600, filePath);
    }

    assert.match(
      await readFile(path.join(recordRoot, "summary.json"), "utf8"),
      /선택한 UI를 개선해 주세요/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("projectRoot and .feedback must be actual directories", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "next-dev-feedback-directory-"),
  );
  const projectFile = path.join(temporaryRoot, "project-file");
  const projectWithFile = path.join(temporaryRoot, "project-with-file");
  await writeFile(projectFile, "not a directory", { mode: 0o600 });
  await mkdir(projectWithFile, { mode: 0o700 });
  await writeFile(path.join(projectWithFile, ".feedback"), "not a directory", {
    mode: 0o600,
  });
  const submission = validateFeedbackSubmission(
    rawSubmission("src/components/SaveButton.tsx"),
  );

  try {
    await assert.rejects(
      saveDevFeedback(submission, { projectRoot: projectFile }),
      /Project root must be an existing directory/,
    );
    await assert.rejects(
      saveDevFeedback(submission, { projectRoot: projectWithFile }),
      /\.feedback must be a real directory/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
