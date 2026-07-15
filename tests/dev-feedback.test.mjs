import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseHTML } from "linkedom";

import {
  formatLocalDate,
  parsePngDataUrl,
  resolveSafePath,
  sanitizeOuterHtmlString,
  saveDevFeedback,
  validateFeedbackSubmission,
} from "../src/server/persistence.ts";
import {
  collectSafeAttributes,
  sanitizeElementTextContent,
  sanitizeOuterHTML,
  sanitizePageUrl,
  truncateText,
} from "../src/shared/sanitize.ts";
import {
  escapeCssIdentifier,
  generateCssSelector,
  isStableClassName,
} from "../src/shared/selector.ts";
import { findSourceInfo } from "../src/shared/source.ts";

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

function pngWithDimensions(dataUrl, width, height) {
  const png = Buffer.from(dataUrl.split(",", 2)[1], "base64");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  return `data:image/png;base64,${png.toString("base64")}`;
}

test("safe paths cannot escape the feedback directory", () => {
  assert.match(
    resolveSafePath("/tmp/project/.feedback", "2026-07-14-001"),
    /\.feedback[\\/]2026-07-14-001$/,
  );
  assert.throws(() => resolveSafePath("/tmp/project/.feedback", "../outside"));
  assert.throws(() => resolveSafePath("/tmp/project/.feedback", ".."));
});

test("PNG data URLs are decoded and malformed data is rejected", () => {
  const png = parsePngDataUrl(ONE_PIXEL_PNG);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.throws(() => parsePngDataUrl("data:image/png;base64,AAAA"));
  assert.throws(() => parsePngDataUrl(ONE_PIXEL_PNG, 10));
  assert.throws(() =>
    parsePngDataUrl(pngWithDimensions(ONE_PIXEL_PNG, 100_000, 100_000)),
  );
});

test("server-side HTML defense removes form values and limits output", () => {
  const sanitized = sanitizeOuterHtmlString(
    '<div style="background:url(/asset?token=style-secret)"><!-- private --><script>window.token="script-secret"</script><style>.x{background:url(/asset?token=css-secret)}</style><template>template-secret</template><img srcset="/asset?token=srcset-secret 2x"><input type="password" value="secret" data-token="opaque"><textarea value="x">hidden</textarea></div>',
  );
  assert.doesNotMatch(
    sanitized,
    /secret|hidden|opaque|private|value=|data-token|srcset=|style=|<script|<template/i,
  );
  assert.match(sanitized, /\[redacted\]/);
  assert.equal(sanitizeOuterHtmlString("x".repeat(30_000)).length, 20_000);

  const sanitizedUrl = sanitizeOuterHtmlString(
    '<a href="/asset?tab=one&amp;access_token=secret">Asset</a>',
  );
  assert.doesNotMatch(sanitizedUrl, /secret|amp;amp/i);
  assert.match(sanitizedUrl, /tab=one&amp;access_token=%5Bredacted%5D/);
});

test("browser HTML sanitization drops form values and embedded code", () => {
  const { document } = parseHTML(`
    <div id="target" data-image-url="/asset?access_token=opaque&variant=2">
      <!-- private-comment -->
      <input type="password" value="initial-secret">
      <textarea>textarea-secret</textarea>
      <script>window.secret = "script-secret"</script>
      <style>.x { background: url('/asset?token=css-secret') }</style>
    </div>
  `);
  const target = document.querySelector("#target");
  assert.ok(target);

  const html = sanitizeOuterHTML(target);
  const text = sanitizeElementTextContent(target);
  const attributes = collectSafeAttributes(target);
  assert.doesNotMatch(
    html,
    /initial-secret|textarea-secret|script-secret|css-secret|private-comment/i,
  );
  assert.doesNotMatch(
    text ?? "",
    /initial-secret|textarea-secret|script-secret|css-secret/i,
  );
  assert.doesNotMatch(attributes["data-image-url"], /opaque/);
  assert.match(attributes["data-image-url"], /variant=2/);
});

test("text truncation keeps the configured maximum", () => {
  assert.equal(truncateText("123456", 5), "1234…");
  assert.equal(truncateText("123", 5), "123");
});

test("validated target text and HTML use storage length limits", () => {
  const submission = validateFeedbackSubmission({
    request: "Verify persisted limits.",
    page: {
      url: "http://localhost:3000/test",
      pathname: "/test",
      search: "",
      viewportWidth: 1280,
      viewportHeight: 720,
      devicePixelRatio: 1,
      scrollX: 0,
      scrollY: 0,
      userAgent: "test",
    },
    target: {
      selector: "main",
      tagName: "main",
      textContent: "t".repeat(10_000),
      outerHTML: `<main>${"h".repeat(30_000)}</main>`,
      boundingRect: {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 100,
        bottom: 100,
        width: 100,
        height: 100,
      },
      attributes: {
        "data-image-url": "/asset?access_token=opaque&variant=2",
      },
    },
    screenshots: { full: null, target: null },
  });

  assert.equal(submission.target.textContent?.length, 2_000);
  assert.equal(submission.target.outerHTML?.length, 20_000);
  assert.equal(submission.request, "Verify persisted limits.");
  assert.equal("title" in submission, false);
  assert.equal("description" in submission, false);
  assert.doesNotMatch(submission.target.attributes["data-image-url"], /opaque/);
  assert.match(submission.target.attributes["data-image-url"], /variant=2/);
});

test("page URLs redact common credentials", () => {
  const sanitized = sanitizePageUrl(
    "https://user:pass@example.com/reset-password/path-secret?token=secret&tab=one#access_token=hidden",
  );
  assert.doesNotMatch(sanitized, /user:pass|path-secret|token=secret|hidden/);
  assert.match(new URL(sanitized).pathname, /reset-password\/%5Bredacted%5D/i);
  assert.match(sanitized, /tab=one/);

  const opaqueResetToken = sanitizePageUrl(
    "https://example.com/reset/aZ_7Qp9v-K2mN4xR8sT1",
  );
  assert.doesNotMatch(opaqueResetToken, /aZ_7Qp9v-K2mN4xR8sT1/);
  assert.match(new URL(opaqueResetToken).pathname, /reset\/%5Bredacted%5D/i);
});

test("source hints redact component credentials and omit unsafe file hints", () => {
  const { document } = parseHTML(`
    <section
      data-component="token=component-secret"
      data-source-file="src/eyJabcdefgh.abcdefgh.abcdefgh/Button.tsx"
      data-source-line="12"
    ><button id="target">Save</button></section>
  `);
  const target = document.querySelector("#target");
  assert.ok(target);

  const source = findSourceInfo(target);
  assert.equal(source?.componentName, "token=[redacted]");
  assert.equal(source?.filePath, undefined);
  assert.equal(source?.lineNumber, 12);
  assert.doesNotMatch(JSON.stringify(source), /component-secret|eyJabcdefgh/);
});

test("selector helpers reject unstable classes and escape identifiers", () => {
  assert.equal(isStableClassName("active"), false);
  assert.equal(isStableClassName("css-1a2b3c4d"), false);
  assert.equal(isStableClassName("table-header"), true);
  assert.equal(escapeCssIdentifier("1item"), "\\31 item");
});

test("CSS selector generation follows stable priority and stays unique", () => {
  const { document } = parseHTML(`<!doctype html><html><body>
    <button id="save-button">Save</button>
    <button data-testid="cancel-button">Cancel</button>
    <section data-component="SummaryCard">Summary</section>
    <button class="css-1a2b3c4d stable-action">Action</button>
    <ul><li><span>First</span></li><li><span data-target="yes">Second</span></li></ul>
  </body></html>`);

  const cases = [
    [document.querySelector("#save-button"), "#save-button"],
    [document.querySelector('[data-testid="cancel-button"]'), '[data-testid="cancel-button"]'],
    [document.querySelector('[data-component="SummaryCard"]'), '[data-component="SummaryCard"]'],
    [document.querySelector("button.stable-action"), "button.stable-action"],
  ];

  for (const [element, expected] of cases) {
    assert.ok(element);
    const selector = generateCssSelector(element, document);
    assert.equal(selector, expected);
    assert.equal(document.querySelector(selector), element);
    assert.equal(document.querySelectorAll(selector).length, 1);
  }

  const repeatedTarget = document.querySelector('[data-target="yes"]');
  assert.ok(repeatedTarget);
  const positionalSelector = generateCssSelector(repeatedTarget, document);
  assert.match(positionalSelector, /nth-of-type\(2\)/);
  assert.equal(document.querySelector(positionalSelector), repeatedTarget);
  assert.equal(document.querySelectorAll(positionalSelector).length, 1);
});

test("summary-first saves keep the token-efficient view separate from detailed metadata", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "dev-feedback-"));

  try {
    const targetText = `종목명 현재가 ${"상세 데이터 ".repeat(80)}`;
    const submission = validateFeedbackSubmission({
      request: "스크롤 중에도 헤더를 고정해 주세요.",
      title: "ignored legacy title",
      description: "ignored legacy description",
      page: {
        url: "http://localhost:3000/dashboard?tab=open",
        pathname: "/dashboard",
        search: "?tab=open",
        viewportWidth: 1440,
        viewportHeight: 900,
        devicePixelRatio: 2,
        scrollX: 0,
        scrollY: 720,
        userAgent: "test",
      },
      target: {
        selector: "main > table",
        tagName: "table",
        id: "orders-table",
        className: "orders-table striped",
        textContent: targetText,
        outerHTML: "<table><tr><td>내용</td></tr></table>",
        boundingRect: {
          x: 120,
          y: 180,
          top: 180,
          left: 120,
          right: 1300,
          bottom: 720,
          width: 1180,
          height: 540,
        },
        attributes: { "data-testid": "orders-table" },
      },
      source: {
        componentName: "OrdersTable",
        filePath: "src/components/orders/OrdersTable.tsx",
        lineNumber: 42,
        columnNumber: 5,
      },
      screenshots: { full: null, target: null },
    });

    const first = await saveDevFeedback(submission, {
      projectRoot,
      now: new Date(2026, 6, 14, 10, 0),
    });
    assert.equal(first.directory, ".feedback/2026-07-14-001");
    assert.equal("request" in first.files, false);
    assert.equal(first.files.summary, "summary.json");
    assert.equal(first.files.metadata, "metadata.json");
    assert.deepEqual(
      (await readdir(path.join(projectRoot, first.directory))).sort(),
      ["metadata.json", "summary.json"],
    );

    const metadataRaw = await readFile(
      path.join(projectRoot, first.directory, "metadata.json"),
      "utf8",
    );
    const summaryRaw = await readFile(
      path.join(projectRoot, first.directory, "summary.json"),
      "utf8",
    );
    const metadata = JSON.parse(metadataRaw);
    const summary = JSON.parse(summaryRaw);

    assert.ok(
      Buffer.byteLength(summaryRaw, "utf8") <
        Buffer.byteLength(metadataRaw, "utf8"),
    );
    assert.deepEqual(Object.keys(summary).sort(), [
      "detailFile",
      "page",
      "request",
      "screenshots",
      "source",
      "target",
    ]);
    assert.equal(summary.request, submission.request);
    assert.deepEqual(summary.source, submission.source);
    assert.deepEqual(summary.page, {
      url: submission.page.url,
      pathname: submission.page.pathname,
    });
    assert.deepEqual(Object.keys(summary.target).sort(), [
      "selector",
      "tagName",
      "textContent",
    ]);
    assert.equal(summary.target.selector, submission.target.selector);
    assert.equal(summary.target.tagName, submission.target.tagName);
    assert.ok(summary.target.textContent.length <= 300);
    assert.match(summary.target.textContent, /^종목명 현재가/);
    assert.equal(summary.detailFile, "metadata.json");
    assert.deepEqual(summary.screenshots, { full: null, target: null });

    for (const key of ["id", "createdAt", "status"]) {
      assert.equal(key in summary, false);
    }
    for (const key of [
      "search",
      "viewportWidth",
      "viewportHeight",
      "devicePixelRatio",
      "scrollX",
      "scrollY",
      "userAgent",
    ]) {
      assert.equal(key in summary.page, false);
    }
    for (const key of [
      "id",
      "className",
      "outerHTML",
      "boundingRect",
      "attributes",
    ]) {
      assert.equal(key in summary.target, false);
    }

    assert.equal(metadata.request, submission.request);
    assert.equal("title" in metadata, false);
    assert.equal("description" in metadata, false);
    assert.equal(metadata.page.viewportWidth, 1440);
    assert.equal(metadata.page.search, "?tab=open");
    assert.equal(metadata.target.id, "orders-table");
    assert.equal(metadata.target.outerHTML, submission.target.outerHTML);
    assert.deepEqual(metadata.target.boundingRect, submission.target.boundingRect);
    assert.deepEqual(metadata.target.attributes, submission.target.attributes);

    const readmePath = path.join(projectRoot, ".feedback", "README.md");
    const generatedReadme = await readFile(readmePath, "utf8");
    assert.match(generatedReadme, /summary\.json/i);
    assert.match(generatedReadme, /metadata\.json/i);
    assert.match(
      generatedReadme,
      /summary\.json[\s\S]*(?:먼저|우선)|(?:먼저|우선)[\s\S]*summary\.json/i,
    );
    assert.match(generatedReadme, /data-testid/);
    assert.match(generatedReadme, /data-source-file/);
    assert.match(
      generatedReadme,
      /textContent: \(\.target\.textContent \/\/ "" \| \.\[:300\]\)/,
    );
    assert.doesNotMatch(generatedReadme, /Codex|request\.md/i);

    await writeFile(readmePath, "# 사용자 메모\n", "utf8");
    const second = await saveDevFeedback(submission, {
      projectRoot,
      now: new Date(2026, 6, 14, 10, 1),
    });
    assert.equal(second.directory, ".feedback/2026-07-14-002");
    assert.equal(second.files.summary, "summary.json");
    assert.equal(await readFile(readmePath, "utf8"), "# 사용자 메모\n");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("folder dates use the local calendar date", () => {
  assert.equal(formatLocalDate(new Date(2026, 6, 14, 0, 5)), "2026-07-14");
});
