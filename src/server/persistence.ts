import {
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

import {
  redactSensitivePathname,
  redactSensitiveSourceHint,
} from "../shared/privacy.js";
import type {
  DevFeedbackMetadata,
  DevFeedbackPage,
  DevFeedbackScreenshotData,
  DevFeedbackSource,
  DevFeedbackSubmission,
  DevFeedbackSummary,
  DevFeedbackTarget,
  SerializableDOMRect,
} from "../shared/types.js";

export const MAX_REQUEST_BYTES = 30 * 1024 * 1024;
export const MAX_PNG_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CONTENT_LENGTH = 2_000;
export const MAX_OUTER_HTML_LENGTH = 20_000;

const MAX_DAILY_FEEDBACK = 999;
const MAX_FEEDBACK_REQUEST_LENGTH = 20_000;
const MAX_SUMMARY_TEXT_LENGTH = 300;
const MAX_URL_LENGTH = 8_192;
const MAX_SELECTOR_LENGTH = 4_000;
const MAX_ATTRIBUTE_COUNT = 100;
const MAX_ATTRIBUTE_NAME_LENGTH = 128;
const MAX_ATTRIBUTE_VALUE_LENGTH = 2_000;
const MAX_SOURCE_STRING_LENGTH = 2_000;
const MAX_SCREENSHOT_DATA_URL_LENGTH = Math.ceil((MAX_PNG_BYTES * 4) / 3) + 64;
const MAX_PNG_DIMENSION = 20_000;
const MAX_PNG_PIXELS = 80_000_000;
const MAX_PNG_INFLATED_BYTES = 128 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const SAFE_PNG_CHUNK_TYPES = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  // Color and pixel-density chunks emitted by browser canvas encoders.
  "cHRM",
  "gAMA",
  "sBIT",
  "sRGB",
  "bKGD",
  "tRNS",
  "pHYs",
]);
const UNIQUE_PNG_CHUNK_TYPES = new Set(
  [...SAFE_PNG_CHUNK_TYPES].filter((type) => type !== "IDAT"),
);
const SENSITIVE_ATTRIBUTE_NAME =
  /(?:authorization|cookie|credential|csrf|jwt|password|passwd|secret|session|signature|token|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|(?:^|[-_:])(?:auth|code|value)(?:$|[-_:]))/i;
const SENSITIVE_VALUE =
  /(?:bearer\s+[a-z0-9._~+/-]+=*|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/i;
const SENSITIVE_VALUE_GLOBAL =
  /(?:bearer\s+[a-z0-9._~+/-]+=*|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/gi;
const URL_ATTRIBUTE_NAMES = new Set([
  "action",
  "cite",
  "data",
  "formaction",
  "href",
  "longdesc",
  "manifest",
  "poster",
  "src",
  "usemap",
  "xlink:href",
]);
const REMOVED_URL_CONTAINER_ATTRIBUTES = new Set(["ping", "srcset", "style"]);
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const FEEDBACK_README = `# 개발 UI 피드백

이 폴더에는 로컬 개발 화면에서 선택한 UI 요소와 사용자 요청이 저장됩니다.
기존 기록은 그대로 보존하고 새 기록만 추가하는 방식으로 사용하세요.

## 토큰을 아끼는 읽기 순서

새 피드백은 반드시 \`summary.json\`부터 확인하세요. 대부분의 수정 탐색에는 이
파일만으로 충분하며, \`metadata.json\`과 PNG는 필요한 경우에만 추가로 엽니다.

1. \`summary.json\`에서 \`request\`, \`source\`, \`page\`, \`target\`을 확인합니다.
2. \`source.filePath\`가 있으면 해당 파일부터 찾습니다. 이 단계에서 대상 코드가
   명확하면 \`metadata.json\`은 열지 않아도 됩니다.
3. 소스 힌트가 없거나 selector가 모호하거나 DOM 구조·좌표·속성이 필요할 때만
   \`metadata.json\`을 엽니다.
4. 실제 배치와 시각적 문맥이 필요할 때만 PNG를 확인합니다.

## 파일 구조

- \`YYYY-MM-DD-NNN/summary.json\`: 먼저 읽는 토큰 절약용 핵심 정보
- \`YYYY-MM-DD-NNN/metadata.json\`: 전체 페이지·DOM·좌표·속성 상세 정보
- \`YYYY-MM-DD-NNN/screenshot-full.png\`: 선택 영역이 표시된 viewport 이미지(선택적)
- \`YYYY-MM-DD-NNN/screenshot-target.png\`: 선택 요소 주변을 자른 이미지(선택적)

\`summary.json\`에는 사용자 요청 원문, 선택적 소스 위치, URL/pathname, selector,
tagName, 최대 300자의 텍스트 미리보기와 관련 파일명만 저장됩니다.
\`metadata.json\`에는 viewport, 스크롤, userAgent, boundingRect, attributes,
최대 2,000자의 textContent와 최대 20,000자의 outerHTML이 추가로 들어 있습니다.

과거 기록처럼 \`summary.json\`이 없는 폴더에서는 다음 명령으로 상세 메타데이터의
핵심 키만 먼저 볼 수 있습니다.

\`\`\`bash
jq '{request, source, page: {url: .page.url, pathname: .page.pathname}, target: {selector: .target.selector, tagName: .target.tagName, textContent: (.target.textContent // "" | .[:300])}, screenshots}' metadata.json
\`\`\`

## data 속성 베스트 프랙티스

data 속성이 전혀 없어도 선택과 캡처는 동작합니다. 소스 파일을 더 빠르게
찾아야 하는 주요 컴포넌트 경계에만 다음 힌트를 선택적으로 추가하세요.

\`\`\`tsx
<section
  data-component="OrdersTable"
  data-source-file="src/components/orders/OrdersTable.tsx"
  data-source-line="42"
  data-source-column="5"
>
  <table data-testid="orders-table">...</table>
</section>
\`\`\`

- \`data-testid\`: 화면에서 안정적이고 고유한 이름을 사용합니다. 배열 index,
  임의 UUID, 빌드 해시처럼 실행마다 바뀌는 값은 피하세요.
- \`data-component\`: React 컴포넌트 이름을 기록합니다.
- \`data-source-file\`: 절대 경로가 아닌 저장소 기준 상대 경로를 기록합니다.
- \`data-source-line\`, \`data-source-column\`: 정확히 유지할 수 있을 때만 사용합니다.

모든 요소에 속성을 추가하지 마세요. 선택 요소에 힌트가 없으면 부모 방향으로
최대 10단계까지 가장 가까운 소스 정보를 찾습니다. 끝까지 정보가 없더라도
고유 id, 안정적인 class, DOM 계층, \`nth-of-type\` 순서로 selector를 만들고
텍스트와 정제된 HTML을 함께 저장합니다.

## 개인정보 보호

비밀번호, input/textarea의 현재 값, 쿠키, 브라우저 저장소, Authorization 정보는
수집하지 않습니다. 다만 화면에 이미 표시된 텍스트와 픽셀은 포함될 수 있으므로
운영 고객 정보나 비밀 값이 표시된 화면은 캡처하지 마세요.
`;

export class FeedbackValidationError extends Error {
  constructor(message = "Invalid feedback payload") {
    super(message);
    this.name = "FeedbackValidationError";
  }
}

export class FeedbackPayloadTooLargeError extends Error {
  constructor(message = "Feedback payload is too large") {
    super(message);
    this.name = "FeedbackPayloadTooLargeError";
  }
}

export interface SaveFeedbackResult {
  id: string;
  directory: string;
  files: {
    summary: "summary.json";
    metadata: "metadata.json";
    fullScreenshot: "screenshot-full.png" | null;
    targetScreenshot: "screenshot-target.png" | null;
  };
}

export interface SaveFeedbackOptions {
  /** Project directory that will contain .feedback. Defaults to process.cwd(). */
  projectRoot?: string;
  /** Injectable clock used by focused utility tests. */
  now?: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new FeedbackValidationError(`${field} must be an object`);
  }
  return value;
}

function ownField(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

interface StringOptions {
  maxLength: number;
  allowEmpty?: boolean;
  optional?: boolean;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  options: StringOptions,
): string | undefined {
  const value = ownField(record, key);
  if (value === undefined && options.optional) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new FeedbackValidationError(`${key} must be a string`);
  }
  if (value.length > options.maxLength) {
    throw new FeedbackValidationError(`${key} is too long`);
  }
  if (!options.allowEmpty && value.trim().length === 0) {
    throw new FeedbackValidationError(`${key} is required`);
  }
  return value;
}

interface NumberOptions {
  min: number;
  max: number;
  integer?: boolean;
  optional?: boolean;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  options: NumberOptions,
): number | undefined {
  const value = ownField(record, key);
  if (value === undefined && options.optional) {
    return undefined;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < options.min ||
    value > options.max ||
    (options.integer === true && !Number.isInteger(value))
  ) {
    throw new FeedbackValidationError(`${key} is invalid`);
  }
  return value;
}

function requireStringValue(
  value: string | undefined,
  field: string,
): string {
  if (value === undefined) {
    throw new FeedbackValidationError(`${field} is required`);
  }
  return value;
}

function requireNumberValue(
  value: number | undefined,
  field: string,
): number {
  if (value === undefined) {
    throw new FeedbackValidationError(`${field} is required`);
  }
  return value;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function redactSensitiveValues(value: string): string {
  return value.replace(SENSITIVE_VALUE_GLOBAL, "[redacted]");
}

function validatePathSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("\0") ||
    segment.includes("/") ||
    segment.includes("\\") ||
    path.isAbsolute(segment)
  ) {
    throw new FeedbackValidationError("Unsafe feedback path segment");
  }
}

/** Resolves path segments and proves that the result remains under baseDirectory. */
export function resolveSafePath(
  baseDirectory: string,
  ...segments: string[]
): string {
  for (const segment of segments) {
    validatePathSegment(segment);
  }

  const base = path.resolve(/* turbopackIgnore: true */ baseDirectory);
  const candidate = path.resolve(
    /* turbopackIgnore: true */ base,
    ...segments,
  );
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) {
    throw new FeedbackValidationError("Unsafe feedback path");
  }
  return candidate;
}

/** Local calendar date, intentionally not UTC, to match the developer machine. */
export function formatLocalDate(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new FeedbackValidationError("Invalid feedback date");
  }
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function redactUrl(url: URL): URL {
  url.username = "";
  url.password = "";
  url.pathname = redactSensitivePathname(url.pathname);
  for (const [key, value] of [...url.searchParams.entries()]) {
    if (SENSITIVE_ATTRIBUTE_NAME.test(key) || SENSITIVE_VALUE.test(value)) {
      url.searchParams.set(key, "[redacted]");
    }
  }

  const hashValue = url.hash.slice(1);
  if (hashValue.includes("=")) {
    const hashParameters = new URLSearchParams(hashValue);
    let changed = false;
    for (const [key, value] of [...hashParameters.entries()]) {
      if (SENSITIVE_ATTRIBUTE_NAME.test(key) || SENSITIVE_VALUE.test(value)) {
        hashParameters.set(key, "[redacted]");
        changed = true;
      }
    }
    if (changed) {
      url.hash = hashParameters.toString();
    }
  } else if (SENSITIVE_VALUE.test(hashValue)) {
    url.hash = "[redacted]";
  }
  return url;
}

function parsePage(value: unknown): DevFeedbackPage {
  const page = requireRecord(value, "page");
  const url = requireStringValue(
    readString(page, "url", { maxLength: MAX_URL_LENGTH }),
    "url",
  );
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Unsupported URL protocol");
    }
  } catch {
    throw new FeedbackValidationError("url is invalid");
  }

  const pathname = requireStringValue(
    readString(page, "pathname", { maxLength: 4_096 }),
    "pathname",
  );
  if (!pathname.startsWith("/")) {
    throw new FeedbackValidationError("pathname is invalid");
  }
  const search = requireStringValue(
    readString(page, "search", { maxLength: 4_096, allowEmpty: true }),
    "search",
  );
  if (search !== "" && !search.startsWith("?")) {
    throw new FeedbackValidationError("search is invalid");
  }
  if (parsedUrl.pathname !== pathname || parsedUrl.search !== search) {
    throw new FeedbackValidationError("page URL fields do not match");
  }
  const safeUrl = redactUrl(parsedUrl);

  return {
    url: safeUrl.toString(),
    pathname: safeUrl.pathname,
    search: safeUrl.search,
    viewportWidth: requireNumberValue(
      readNumber(page, "viewportWidth", { min: 1, max: 100_000, integer: true }),
      "viewportWidth",
    ),
    viewportHeight: requireNumberValue(
      readNumber(page, "viewportHeight", { min: 1, max: 100_000, integer: true }),
      "viewportHeight",
    ),
    devicePixelRatio: requireNumberValue(
      readNumber(page, "devicePixelRatio", { min: 0.1, max: 100 }),
      "devicePixelRatio",
    ),
    scrollX: requireNumberValue(
      readNumber(page, "scrollX", { min: -100_000_000, max: 100_000_000 }),
      "scrollX",
    ),
    scrollY: requireNumberValue(
      readNumber(page, "scrollY", { min: -100_000_000, max: 100_000_000 }),
      "scrollY",
    ),
    userAgent: requireStringValue(
      readString(page, "userAgent", { maxLength: 2_000, allowEmpty: true }),
      "userAgent",
    ),
  };
}

function parseBoundingRect(value: unknown): SerializableDOMRect {
  const rect = requireRecord(value, "boundingRect");
  const coordinate = (key: keyof SerializableDOMRect): number =>
    requireNumberValue(
      readNumber(rect, key, {
        min: key === "width" || key === "height" ? 0 : -100_000_000,
        max: 100_000_000,
      }),
      key,
    );

  return {
    x: coordinate("x"),
    y: coordinate("y"),
    top: coordinate("top"),
    left: coordinate("left"),
    right: coordinate("right"),
    bottom: coordinate("bottom"),
    width: coordinate("width"),
    height: coordinate("height"),
  };
}

function isUsefulAttributeName(name: string): boolean {
  if (SENSITIVE_ATTRIBUTE_NAME.test(name) || name.startsWith("on")) {
    return false;
  }
  return (
    name === "id" ||
    name === "class" ||
    name === "role" ||
    name === "name" ||
    name === "type" ||
    name === "title" ||
    name === "alt" ||
    name === "href" ||
    name === "for" ||
    name === "tabindex" ||
    name.startsWith("data-") ||
    name.startsWith("aria-")
  );
}

function parseAttributes(value: unknown): Record<string, string> {
  const input = requireRecord(value, "attributes");
  const entries = Object.entries(input);
  if (entries.length > MAX_ATTRIBUTE_COUNT) {
    throw new FeedbackValidationError("attributes has too many entries");
  }

  const attributes: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    if (typeof rawValue !== "string") {
      throw new FeedbackValidationError("attribute values must be strings");
    }
    const name = rawName.toLowerCase();
    if (
      name.length === 0 ||
      name.length > MAX_ATTRIBUTE_NAME_LENGTH ||
      !/^[a-z_:][a-z0-9_.:-]*$/.test(name) ||
      !isUsefulAttributeName(name)
    ) {
      continue;
    }
    const trimmedValue = rawValue.trim();
    const looksLikeUrl =
      /^(?:https?:|\/|\.\.?\/|\?|#)/i.test(trimmedValue) ||
      /[?#][^#]*=/.test(trimmedValue);
    const safeValue = SENSITIVE_VALUE.test(rawValue)
      ? "[redacted]"
      : looksLikeUrl
        ? redactAttributeUrl(rawValue)
        : rawValue;
    attributes[name] = truncate(safeValue, MAX_ATTRIBUTE_VALUE_LENGTH);
  }
  return attributes;
}

function redactAttributeUrl(value: string): string {
  try {
    const url = redactUrl(new URL(value, "https://dev-feedback.invalid"));
    if (url.origin === "https://dev-feedback.invalid") {
      if (value.startsWith("#")) {
        return url.hash;
      }
      if (value.startsWith("?")) {
        return `${url.search}${url.hash}`;
      }
      if (!value.startsWith("/")) {
        return `${url.pathname.replace(/^\//, "")}${url.search}${url.hash}`;
      }
      return `${url.pathname}${url.search}${url.hash}`;
    }
    return url.toString();
  } catch {
    return SENSITIVE_VALUE.test(value) ? "[redacted]" : value;
  }
}

function quoteHtmlAttribute(value: string): string {
  return `"${value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")}"`;
}

function decodeHtmlAttribute(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|amp|quot|apos|lt|gt);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal !== undefined) {
        const codePoint = Number(decimal);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }
      if (hexadecimal !== undefined) {
        const codePoint = Number.parseInt(hexadecimal, 16);
        return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : entity;
      }

      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&quot;":
          return '"';
        case "&apos;":
          return "'";
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        default:
          return entity;
      }
    },
  );
}

function sanitizeHtmlTag(tag: string): string {
  return tag.replace(
    /\s+([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/giu,
    (attribute, rawName: string, rawEncodedValue: string | undefined) => {
      const name = rawName.toLowerCase();
      if (
        SENSITIVE_ATTRIBUTE_NAME.test(name) ||
        name.startsWith("on") ||
        name === "srcdoc" ||
        REMOVED_URL_CONTAINER_ATTRIBUTES.has(name)
      ) {
        return "";
      }
      if (rawEncodedValue === undefined) {
        return attribute;
      }

      const first = rawEncodedValue[0];
      const encodedValue =
        (first === '"' || first === "'") && rawEncodedValue.at(-1) === first
          ? rawEncodedValue.slice(1, -1)
          : rawEncodedValue;
      const value = decodeHtmlAttribute(encodedValue);
      if (SENSITIVE_VALUE.test(value)) {
        return ` ${rawName}="[redacted]"`;
      }
      if (URL_ATTRIBUTE_NAMES.has(name)) {
        return ` ${rawName}=${quoteHtmlAttribute(redactAttributeUrl(value))}`;
      }
      return attribute;
    },
  );
}

/** Defense in depth for HTML submitted by a client that did not run sanitization. */
export function sanitizeOuterHtmlString(value: string): string {
  const withoutNulls = value.replaceAll("\0", "");
  const withoutEmbeddedCode = withoutNulls
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, "")
    .replace(
      /<(script|style|template)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?(?:<\/\1\s*>|$)/giu,
      "",
    );
  const sanitizedTags = withoutEmbeddedCode.replace(
    /<[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/giu,
    sanitizeHtmlTag,
  );
  const withoutInputValues = sanitizedTags.replace(
    /<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu,
    (tag) =>
      tag.replace(
        /\s+value\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu,
        "",
      ),
  );
  const withoutTextareaValues = withoutInputValues
    .replace(
      /(<textarea\b(?:[^>"']|"[^"]*"|'[^']*')*>)[\s\S]*?(<\/textarea\s*>)/giu,
      "$1[redacted]$2",
    )
    .replace(
      /<textarea\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu,
      (tag) =>
        tag.replace(
          /\s+value\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu,
          "",
        ),
    );
  return truncate(
    redactSensitiveValues(withoutTextareaValues),
    MAX_OUTER_HTML_LENGTH,
  );
}

function parseTarget(value: unknown): DevFeedbackTarget {
  const target = requireRecord(value, "target");
  const selector = redactSensitiveValues(
    requireStringValue(
      readString(target, "selector", { maxLength: MAX_SELECTOR_LENGTH }),
      "selector",
    ),
  );
  if (/[\u0000\r\n]/.test(selector)) {
    throw new FeedbackValidationError("selector is invalid");
  }
  const tagName = requireStringValue(
    readString(target, "tagName", { maxLength: 64 }),
    "tagName",
  );
  if (!/^[a-z][a-z0-9-]*$/i.test(tagName)) {
    throw new FeedbackValidationError("tagName is invalid");
  }

  const id = readString(target, "id", {
    maxLength: 1_000,
    allowEmpty: true,
    optional: true,
  });
  const className = readString(target, "className", {
    maxLength: 4_000,
    allowEmpty: true,
    optional: true,
  });
  const textContent = readString(target, "textContent", {
    maxLength: 20_000,
    allowEmpty: true,
    optional: true,
  });
  const outerHTML = readString(target, "outerHTML", {
    maxLength: 100_000,
    allowEmpty: true,
    optional: true,
  });

  return {
    selector,
    tagName: tagName.toLowerCase(),
    ...(id === undefined
      ? {}
      : { id: truncate(redactSensitiveValues(id), 1_000) }),
    ...(className === undefined
      ? {}
      : { className: truncate(redactSensitiveValues(className), 2_000) }),
    ...(textContent === undefined
      ? {}
      : {
          textContent: truncate(
            redactSensitiveValues(textContent.replaceAll("\0", "")),
            MAX_TEXT_CONTENT_LENGTH,
          ),
        }),
    ...(outerHTML === undefined
      ? {}
      : { outerHTML: sanitizeOuterHtmlString(outerHTML) }),
    boundingRect: parseBoundingRect(ownField(target, "boundingRect")),
    attributes: parseAttributes(ownField(target, "attributes")),
  };
}

function validateSourceFilePath(filePath: string): string {
  const segments = filePath.split("/");
  const hasUrlScheme = /^[a-z][a-z\d+.-]*:/i.test(filePath);
  const hasWindowsDrive = /^[a-z]:/i.test(filePath);

  if (
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(filePath) ||
    filePath.includes("\\") ||
    filePath.includes("?") ||
    filePath.includes("#") ||
    filePath.startsWith("~/") ||
    path.posix.isAbsolute(filePath) ||
    path.win32.isAbsolute(filePath) ||
    hasUrlScheme ||
    hasWindowsDrive ||
    path.posix.normalize(filePath) !== filePath ||
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new FeedbackValidationError(
      "source.filePath must be a repository-relative POSIX path",
    );
  }

  return filePath;
}

function parseSource(value: unknown): DevFeedbackSource | undefined {
  if (value === undefined) {
    return undefined;
  }
  const source = requireRecord(value, "source");
  const componentName = readString(source, "componentName", {
    maxLength: MAX_SOURCE_STRING_LENGTH,
    optional: true,
  });
  const filePath = readString(source, "filePath", {
    maxLength: MAX_SOURCE_STRING_LENGTH,
    optional: true,
  });
  const lineNumber = readNumber(source, "lineNumber", {
    min: 1,
    max: 100_000_000,
    integer: true,
    optional: true,
  });
  const columnNumber = readNumber(source, "columnNumber", {
    min: 1,
    max: 100_000_000,
    integer: true,
    optional: true,
  });
  const safeComponentName =
    componentName === undefined
      ? undefined
      : redactSensitiveSourceHint(componentName);
  if (
    filePath !== undefined &&
    redactSensitiveSourceHint(filePath) !== filePath
  ) {
    throw new FeedbackValidationError(
      "source.filePath must not contain sensitive values",
    );
  }
  const parsed: DevFeedbackSource = {
    ...(safeComponentName === undefined
      ? {}
      : { componentName: safeComponentName }),
    ...(filePath === undefined
      ? {}
      : { filePath: validateSourceFilePath(filePath) }),
    ...(lineNumber === undefined ? {} : { lineNumber }),
    ...(columnNumber === undefined ? {} : { columnNumber }),
  };
  return Object.keys(parsed).length === 0 ? undefined : parsed;
}

function parseScreenshots(value: unknown): DevFeedbackScreenshotData {
  const screenshots = requireRecord(value, "screenshots");
  const parseImage = (key: "full" | "target"): string | null => {
    const image = ownField(screenshots, key);
    if (image === null) {
      return null;
    }
    if (typeof image !== "string" || image.length === 0) {
      throw new FeedbackValidationError(`${key} screenshot is invalid`);
    }
    if (image.length > MAX_SCREENSHOT_DATA_URL_LENGTH) {
      throw new FeedbackPayloadTooLargeError(`${key} screenshot is too large`);
    }
    return image;
  };
  return { full: parseImage("full"), target: parseImage("target") };
}

/** Runtime schema validation; only declared fields are copied into the result. */
export function validateFeedbackSubmission(value: unknown): DevFeedbackSubmission {
  const input = requireRecord(value, "feedback");
  const request = redactSensitiveValues(
    requireStringValue(
      readString(input, "request", { maxLength: MAX_FEEDBACK_REQUEST_LENGTH }),
      "request",
    ).replaceAll("\0", ""),
  ).trim();
  if (request.length === 0) {
    throw new FeedbackValidationError("request is required");
  }
  const source = parseSource(ownField(input, "source"));

  return {
    request,
    page: parsePage(ownField(input, "page")),
    target: parseTarget(ownField(input, "target")),
    ...(source === undefined ? {} : { source }),
    screenshots: parseScreenshots(ownField(input, "screenshots")),
  };
}

function decodedBase64Length(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

interface PngImageDataValidationOptions {
  chunks: readonly Buffer[];
  totalCompressedLength: number;
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

function validatePngImageData({
  chunks,
  totalCompressedLength,
  width,
  height,
  bitDepth,
  colorType,
}: PngImageDataValidationOptions): void {
  const channelsByColorType: Readonly<Record<number, number>> = {
    0: 1,
    2: 3,
    3: 1,
    4: 2,
    6: 4,
  };
  const channels = channelsByColorType[colorType];
  if (channels === undefined) {
    throw new FeedbackValidationError("PNG color type is invalid");
  }

  const scanlineBytes = Math.ceil((width * channels * bitDepth) / 8);
  const expectedInflatedBytes = height * (scanlineBytes + 1);
  if (
    !Number.isSafeInteger(expectedInflatedBytes) ||
    expectedInflatedBytes <= 0 ||
    expectedInflatedBytes > MAX_PNG_INFLATED_BYTES
  ) {
    throw new FeedbackValidationError("PNG decoded size is too large");
  }

  const compressed = Buffer.concat(chunks, totalCompressedLength);
  let inflated: Buffer;
  try {
    const result: unknown = inflateSync(compressed, {
      info: true,
      maxOutputLength: expectedInflatedBytes,
    });
    if (
      !isRecord(result) ||
      !Buffer.isBuffer(result.buffer) ||
      !isRecord(result.engine) ||
      typeof result.engine.bytesWritten !== "number"
    ) {
      throw new FeedbackValidationError("PNG image data is invalid");
    }
    if (result.engine.bytesWritten !== compressed.length) {
      throw new FeedbackValidationError("PNG image data has trailing bytes");
    }
    inflated = result.buffer;
  } catch (error) {
    if (error instanceof FeedbackValidationError) {
      throw error;
    }
    throw new FeedbackValidationError("PNG image data is invalid");
  }

  if (inflated.length !== expectedInflatedBytes) {
    throw new FeedbackValidationError("PNG image data length is invalid");
  }
  for (let row = 0; row < height; row += 1) {
    const filter = inflated.readUInt8(row * (scanlineBytes + 1));
    if (filter > 4) {
      throw new FeedbackValidationError("PNG scanline filter is invalid");
    }
  }
}

function validatePngChunks(buffer: Buffer): void {
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new FeedbackValidationError("Screenshot is not a valid PNG");
  }

  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let sawImageData = false;
  let sawEnd = false;
  let totalImageDataLength = 0;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let paletteEntries = 0;
  const imageDataChunks: Buffer[] = [];
  const seenChunks = new Set<string>();

  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      throw new FeedbackValidationError("PNG chunk is truncated");
    }
    const chunkLength = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const type = buffer.toString("ascii", typeStart, typeStart + 4);
    const nextOffset = offset + 12 + chunkLength;
    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      type[2] !== type[2]?.toUpperCase() ||
      nextOffset > buffer.length
    ) {
      throw new FeedbackValidationError("PNG chunk is invalid");
    }
    if (!SAFE_PNG_CHUNK_TYPES.has(type)) {
      throw new FeedbackValidationError(`PNG chunk ${type} is not allowed`);
    }
    if (UNIQUE_PNG_CHUNK_TYPES.has(type) && seenChunks.has(type)) {
      throw new FeedbackValidationError(`PNG chunk ${type} is duplicated`);
    }

    const expectedCrc = buffer.readUInt32BE(offset + 8 + chunkLength);
    const actualCrc = crc32(buffer, typeStart, offset + 8 + chunkLength);
    if (expectedCrc !== actualCrc) {
      throw new FeedbackValidationError("PNG chunk checksum is invalid");
    }

    if (chunkIndex === 0) {
      if (type !== "IHDR" || chunkLength !== 13) {
        throw new FeedbackValidationError("PNG header is invalid");
      }
      width = buffer.readUInt32BE(offset + 8);
      height = buffer.readUInt32BE(offset + 12);
      if (
        width === 0 ||
        height === 0 ||
        width > MAX_PNG_DIMENSION ||
        height > MAX_PNG_DIMENSION ||
        width * height > MAX_PNG_PIXELS
      ) {
        throw new FeedbackValidationError("PNG dimensions are invalid");
      }
      bitDepth = buffer.readUInt8(offset + 16);
      colorType = buffer.readUInt8(offset + 17);
      const validBitDepths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !validBitDepths[colorType]?.includes(bitDepth) ||
        buffer[offset + 18] !== 0 ||
        buffer[offset + 19] !== 0 ||
        buffer[offset + 20] !== 0
      ) {
        throw new FeedbackValidationError("PNG header settings are invalid");
      }
    } else if (type === "IHDR") {
      throw new FeedbackValidationError("PNG contains multiple headers");
    }

    const chunkData = buffer.subarray(offset + 8, offset + 8 + chunkLength);

    if (type !== "IHDR" && type !== "IDAT" && type !== "IEND" && sawImageData) {
      throw new FeedbackValidationError("PNG metadata must precede image data");
    }

    if (type === "PLTE") {
      if (
        chunkLength === 0 ||
        chunkLength > 768 ||
        chunkLength % 3 !== 0 ||
        colorType === 0 ||
        colorType === 4
      ) {
        throw new FeedbackValidationError("PNG palette is invalid");
      }
      paletteEntries = chunkLength / 3;
      if (colorType === 3 && paletteEntries > 2 ** bitDepth) {
        throw new FeedbackValidationError("PNG palette is too large");
      }
    } else if (type === "cHRM" && chunkLength !== 32) {
      throw new FeedbackValidationError("PNG chromaticity chunk is invalid");
    } else if (
      type === "gAMA" &&
      (chunkLength !== 4 || chunkData.readUInt32BE(0) === 0)
    ) {
      throw new FeedbackValidationError("PNG gamma chunk is invalid");
    } else if (type === "sBIT") {
      const expectedLengths: Record<number, number> = {
        0: 1,
        2: 3,
        3: 3,
        4: 2,
        6: 4,
      };
      const maximumSignificantBits = colorType === 3 ? 8 : bitDepth;
      if (
        chunkLength !== expectedLengths[colorType] ||
        [...chunkData].some(
          (value) => value === 0 || value > maximumSignificantBits,
        )
      ) {
        throw new FeedbackValidationError("PNG significant-bits chunk is invalid");
      }
    } else if (
      type === "sRGB" &&
      (chunkLength !== 1 || chunkData.readUInt8(0) > 3)
    ) {
      throw new FeedbackValidationError("PNG color-space chunk is invalid");
    } else if (type === "bKGD") {
      const expectedLengths: Record<number, number> = {
        0: 2,
        2: 6,
        3: 1,
        4: 2,
        6: 6,
      };
      if (
        chunkLength !== expectedLengths[colorType] ||
        (colorType === 3 &&
          (paletteEntries === 0 ||
            chunkData.readUInt8(0) >= paletteEntries))
      ) {
        throw new FeedbackValidationError("PNG background chunk is invalid");
      }
    } else if (type === "tRNS") {
      const validTransparency =
        (colorType === 0 && chunkLength === 2) ||
        (colorType === 2 && chunkLength === 6) ||
        (colorType === 3 &&
          paletteEntries > 0 &&
          chunkLength > 0 &&
          chunkLength <= paletteEntries);
      if (!validTransparency) {
        throw new FeedbackValidationError("PNG transparency chunk is invalid");
      }
    } else if (
      type === "pHYs" &&
      (chunkLength !== 9 || chunkData.readUInt8(8) > 1)
    ) {
      throw new FeedbackValidationError("PNG pixel-density chunk is invalid");
    }

    if (type === "IDAT") {
      if (colorType === 3 && paletteEntries === 0) {
        throw new FeedbackValidationError("PNG image-data order is invalid");
      }
      sawImageData = true;
      totalImageDataLength += chunkLength;
      imageDataChunks.push(chunkData);
    }
    if (type === "IEND") {
      if (
        !sawImageData ||
        totalImageDataLength === 0 ||
        chunkLength !== 0 ||
        nextOffset !== buffer.length
      ) {
        throw new FeedbackValidationError("PNG end chunk is invalid");
      }
      sawEnd = true;
    }

    seenChunks.add(type);
    offset = nextOffset;
    chunkIndex += 1;
  }

  if (!sawImageData || !sawEnd) {
    throw new FeedbackValidationError("PNG is incomplete");
  }

  validatePngImageData({
    chunks: imageDataChunks,
    totalCompressedLength: totalImageDataLength,
    width,
    height,
    bitDepth,
    colorType,
  });
}

function crc32(buffer: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    const tableIndex = (crc ^ buffer.readUInt8(index)) & 0xff;
    crc = CRC32_TABLE[tableIndex]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Strictly parses a canonical PNG data URL and verifies its PNG structure. */
export function parsePngDataUrl(
  dataUrl: string,
  maxBytes = MAX_PNG_BYTES,
): Buffer {
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) {
    throw new FeedbackValidationError("Screenshot must be a PNG data URL");
  }
  const base64 = dataUrl.slice(prefix.length);
  if (
    base64.length === 0 ||
    base64.length % 4 !== 0 ||
    !BASE64_PATTERN.test(base64)
  ) {
    throw new FeedbackValidationError("Screenshot Base64 is invalid");
  }
  if (decodedBase64Length(base64) > maxBytes) {
    throw new FeedbackPayloadTooLargeError("Screenshot is too large");
  }

  const buffer = Buffer.from(base64, "base64");
  if (buffer.toString("base64") !== base64) {
    throw new FeedbackValidationError("Screenshot Base64 is not canonical");
  }
  validatePngChunks(buffer);
  return buffer;
}

interface ReservedDirectory {
  id: string;
  finalName: string;
  finalPath: string;
  stagingPath: string;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    isRecord(error) &&
    typeof error.code === "string" &&
    (error.code === "EEXIST" || error.code === "ENOTEMPTY")
  );
}

function isPathWithin(rootDirectory: string, candidate: string): boolean {
  const relative = path.relative(
    /* turbopackIgnore: true */ rootDirectory,
    /* turbopackIgnore: true */ candidate,
  );
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function resolveProjectRoot(projectRoot: string): Promise<string> {
  const requestedRoot = path.resolve(/* turbopackIgnore: true */ projectRoot);
  let requestedStats;
  try {
    requestedStats = await lstat(requestedRoot);
  } catch {
    throw new FeedbackValidationError(
      "Project root must be an existing directory",
    );
  }
  if (!requestedStats.isDirectory() && !requestedStats.isSymbolicLink()) {
    throw new FeedbackValidationError(
      "Project root must be an existing directory",
    );
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(requestedRoot);
    const canonicalStats = await lstat(canonicalRoot);
    if (!canonicalStats.isDirectory() || canonicalStats.isSymbolicLink()) {
      throw new Error("Project root is not a directory");
    }
  } catch {
    throw new FeedbackValidationError(
      "Project root must be an existing directory",
    );
  }
  return canonicalRoot;
}

async function assertSafeDirectory(
  directoryPath: string,
  rootDirectory: string,
  label: string,
): Promise<string> {
  const stats = await lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new FeedbackValidationError(`${label} must be a real directory`);
  }

  const canonicalPath = await realpath(directoryPath);
  if (!isPathWithin(rootDirectory, canonicalPath)) {
    throw new FeedbackValidationError(`${label} escapes the project root`);
  }

  const canonicalStats = await lstat(canonicalPath);
  if (canonicalStats.isSymbolicLink() || !canonicalStats.isDirectory()) {
    throw new FeedbackValidationError(`${label} must be a real directory`);
  }
  return canonicalPath;
}

async function ensureFeedbackRoot(projectRoot: string): Promise<string> {
  const feedbackPath = resolveSafePath(projectRoot, ".feedback");
  try {
    await mkdir(feedbackPath, { mode: 0o700 });
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
  }
  return assertSafeDirectory(feedbackPath, projectRoot, ".feedback");
}

async function reserveDirectory(
  feedbackRoot: string,
  localDate: string,
): Promise<ReservedDirectory> {
  for (let sequence = 1; sequence <= MAX_DAILY_FEEDBACK; sequence += 1) {
    const id = `${localDate}-${String(sequence).padStart(3, "0")}`;
    const finalName = id;
    const stagingName = `.${id}.tmp`;
    const stagingPath = resolveSafePath(feedbackRoot, stagingName);

    const entries = await readdir(feedbackRoot);
    if (
      entries.some(
        (entry) => entry === finalName || entry.startsWith(`${finalName}-`),
      )
    ) {
      continue;
    }

    try {
      await mkdir(stagingPath, { mode: 0o700 });
    } catch (error) {
      if (isAlreadyExists(error)) {
        continue;
      }
      throw error;
    }
    await assertSafeDirectory(
      stagingPath,
      feedbackRoot,
      "Feedback staging directory",
    );

    // Close the scan/mkdir race if another process renamed its reservation
    // between our first scan and this successful staging mkdir.
    const entriesAfterReservation = await readdir(feedbackRoot);
    if (
      entriesAfterReservation.some(
        (entry) => entry === finalName || entry.startsWith(`${finalName}-`),
      )
    ) {
      await rm(stagingPath, { recursive: true, force: true });
      continue;
    }

    return {
      id,
      finalName,
      finalPath: resolveSafePath(feedbackRoot, finalName),
      stagingPath,
    };
  }

  throw new Error("Daily feedback limit reached");
}

async function ensureFeedbackReadme(feedbackRoot: string): Promise<void> {
  const readmePath = resolveSafePath(feedbackRoot, "README.md");
  try {
    await writeFile(readmePath, FEEDBACK_README, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
    const stats = await lstat(readmePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new FeedbackValidationError(
        ".feedback/README.md must be a regular file",
      );
    }
  }
}

/** Persists a validated submission under the project-local .feedback directory. */
export async function saveDevFeedback(
  submission: DevFeedbackSubmission,
  options: SaveFeedbackOptions = {},
): Promise<SaveFeedbackResult> {
  // Validate screenshot bytes before reserving a directory so malformed input
  // cannot leave a sequence gap or a partial final record.
  const fullScreenshot = submission.screenshots.full
    ? parsePngDataUrl(submission.screenshots.full)
    : null;
  const targetScreenshot = submission.screenshots.target
    ? parsePngDataUrl(submission.screenshots.target)
    : null;

  const now = options.now ?? new Date();
  const localDate = formatLocalDate(now);
  const projectRoot = await resolveProjectRoot(
    options.projectRoot ?? process.cwd(),
  );
  const feedbackRoot = await ensureFeedbackRoot(projectRoot);
  await ensureFeedbackReadme(feedbackRoot);

  const reserved = await reserveDirectory(feedbackRoot, localDate);
  const screenshotFiles = {
    full: fullScreenshot ? "screenshot-full.png" : null,
    target: targetScreenshot ? "screenshot-target.png" : null,
  } as const;
  const metadata: DevFeedbackMetadata = {
    id: reserved.id,
    createdAt: now.toISOString(),
    request: submission.request,
    page: submission.page,
    target: submission.target,
    ...(submission.source === undefined ? {} : { source: submission.source }),
    // Always replace untrusted data URLs with server-owned relative file names.
    screenshots: screenshotFiles,
    status: "captured",
  };
  const summary: DevFeedbackSummary = {
    request: submission.request,
    ...(submission.source === undefined ? {} : { source: submission.source }),
    page: {
      url: submission.page.url,
      pathname: submission.page.pathname,
    },
    target: {
      selector: submission.target.selector,
      tagName: submission.target.tagName,
      ...(submission.target.textContent
        ? {
            textContent: truncate(
              submission.target.textContent,
              MAX_SUMMARY_TEXT_LENGTH,
            ),
          }
        : {}),
    },
    detailFile: "metadata.json",
    screenshots: screenshotFiles,
  };

  try {
    const writes: Promise<void>[] = [
      writeFile(
        resolveSafePath(reserved.stagingPath, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      ),
      writeFile(
        resolveSafePath(reserved.stagingPath, "metadata.json"),
        `${JSON.stringify(metadata, null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      ),
    ];
    if (fullScreenshot) {
      writes.push(
        writeFile(
          resolveSafePath(reserved.stagingPath, "screenshot-full.png"),
          fullScreenshot,
          { flag: "wx", mode: 0o600 },
        ),
      );
    }
    if (targetScreenshot) {
      writes.push(
        writeFile(
          resolveSafePath(reserved.stagingPath, "screenshot-target.png"),
          targetScreenshot,
          { flag: "wx", mode: 0o600 },
        ),
      );
    }
    await Promise.all(writes);
    await rename(reserved.stagingPath, reserved.finalPath);
    await assertSafeDirectory(
      reserved.finalPath,
      feedbackRoot,
      "Feedback directory",
    );
  } catch (error) {
    await rm(reserved.stagingPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  return {
    id: reserved.id,
    directory: `.feedback/${reserved.finalName}`,
    files: {
      summary: "summary.json",
      metadata: "metadata.json",
      fullScreenshot: screenshotFiles.full,
      targetScreenshot: screenshotFiles.target,
    },
  };
}
