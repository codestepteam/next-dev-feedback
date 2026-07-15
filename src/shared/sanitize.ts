import { redactSensitivePathname } from "./privacy.js";

export const MAX_TEXT_CONTENT_LENGTH = 2_000;
export const MAX_OUTER_HTML_LENGTH = 20_000;

const MAX_ATTRIBUTE_LENGTH = 2_000;
const SAFE_ATTRIBUTE_NAMES = new Set([
  "class",
  "id",
  "name",
  "role",
  "title",
  "type",
]);
const SENSITIVE_VALUE_PATTERN = /(?:bearer\s+[a-z0-9._~+/-]+=*|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/i;
const SENSITIVE_VALUE_PATTERN_GLOBAL = /(?:bearer\s+[a-z0-9._~+/-]+=*|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/gi;
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

function isSensitiveName(name: string): boolean {
  const compactName = name.replace(/[^a-z0-9]/gi, "").toLowerCase();

  return (
    compactName.includes("password") ||
    compactName.includes("passwd") ||
    compactName.includes("credential") ||
    compactName.includes("authorization") ||
    compactName.includes("apikey") ||
    compactName.startsWith("auth") ||
    compactName.startsWith("cookie") ||
    compactName.startsWith("csrf") ||
    compactName.startsWith("session") ||
    /(?:code|hash|jwt|secret|signature|sig|token)$/.test(compactName)
  );
}

export function truncateText(value: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || maxLength <= 0) {
    return "";
  }

  const normalizedMaxLength = Math.floor(maxLength);
  if (value.length <= normalizedMaxLength) {
    return value;
  }

  if (normalizedMaxLength === 1) {
    return "…";
  }

  return `${value.slice(0, normalizedMaxLength - 1)}…`;
}

export function sanitizeTextContent(
  value: string | null | undefined,
  maxLength = MAX_TEXT_CONTENT_LENGTH,
): string | undefined {
  if (value == null) {
    return undefined;
  }

  const normalized = value
    .replace(SENSITIVE_VALUE_PATTERN_GLOBAL, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? truncateText(normalized, maxLength) : undefined;
}

export function sanitizeElementTextContent(
  element: Element,
  maxLength = MAX_TEXT_CONTENT_LENGTH,
): string | undefined {
  const clone = element.cloneNode(true) as Element;
  removeUnsafeEmbeddedContent(clone);
  const formElements = [
    ...(clone.matches("input, textarea") ? [clone] : []),
    ...Array.from(clone.querySelectorAll("input, textarea")),
  ];

  for (const formElement of formElements) {
    formElement.textContent = "";
    formElement.removeAttribute("value");
  }

  return sanitizeTextContent(clone.textContent, maxLength);
}

function isSensitiveAttributeName(name: string): boolean {
  return name === "value" || isSensitiveName(name);
}

function redactSensitiveUrl(value: string): string {
  try {
    const url = new URL(value, "https://dev-feedback.invalid");
    url.username = "";
    url.password = "";
    for (const [key, parameterValue] of [...url.searchParams.entries()]) {
      if (
        isSensitiveName(key) ||
        SENSITIVE_VALUE_PATTERN.test(parameterValue)
      ) {
        url.searchParams.set(key, "[redacted]");
      }
    }

    const hashValue = url.hash.slice(1);
    if (hashValue.includes("=")) {
      const hashParameters = new URLSearchParams(hashValue);
      let changed = false;
      for (const [key, parameterValue] of [...hashParameters.entries()]) {
        if (
          isSensitiveName(key) ||
          SENSITIVE_VALUE_PATTERN.test(parameterValue)
        ) {
          hashParameters.set(key, "[redacted]");
          changed = true;
        }
      }
      if (changed) {
        url.hash = hashParameters.toString();
      }
    } else if (SENSITIVE_VALUE_PATTERN.test(hashValue)) {
      url.hash = "[redacted]";
    }

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
    return SENSITIVE_VALUE_PATTERN.test(value) ? "[redacted]" : value;
  }
}

function sanitizeElementAttributes(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();

    if (
      isSensitiveAttributeName(name) ||
      name.startsWith("on") ||
      name === "srcdoc" ||
      REMOVED_URL_CONTAINER_ATTRIBUTES.has(name)
    ) {
      element.removeAttribute(attribute.name);
      continue;
    }

    if (URL_ATTRIBUTE_NAMES.has(name)) {
      element.setAttribute(attribute.name, redactSensitiveUrl(attribute.value));
      continue;
    }

    if (SENSITIVE_VALUE_PATTERN.test(attribute.value)) {
      element.setAttribute(attribute.name, "[redacted]");
    }
  }
}

function sanitizeFormElement(element: Element): void {
  if (element.tagName.toLowerCase() === "input") {
    element.removeAttribute("value");
  }

  if (element.tagName.toLowerCase() === "textarea") {
    element.removeAttribute("value");
    element.textContent = "";
  }
}

function removeHtmlComments(root: Node): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === 8) {
      child.parentNode?.removeChild(child);
      continue;
    }
    removeHtmlComments(child);
  }
}

function removeUnsafeEmbeddedContent(root: Element): void {
  if (root.matches("script, style, template")) {
    root.textContent = "[redacted]";
  } else {
    for (const unsafeElement of root.querySelectorAll(
      "script, style, template",
    )) {
      unsafeElement.remove();
    }
  }
  removeHtmlComments(root);
}

export function sanitizeOuterHTML(
  element: Element,
  maxLength = MAX_OUTER_HTML_LENGTH,
): string {
  const clone = element.cloneNode(true) as Element;
  removeUnsafeEmbeddedContent(clone);

  const elements = [clone, ...Array.from(clone.querySelectorAll("*"))];

  for (const current of elements) {
    sanitizeElementAttributes(current);
    sanitizeFormElement(current);
  }

  return truncateText(clone.outerHTML, maxLength);
}

export function collectSafeAttributes(element: Element): Record<string, string> {
  const attributes: Record<string, string> = {};

  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    const isUseful =
      SAFE_ATTRIBUTE_NAMES.has(name) ||
      name.startsWith("aria-") ||
      name.startsWith("data-");

    if (!isUseful || isSensitiveAttributeName(name)) {
      continue;
    }

    const value = sanitizeAttributeValueForStorage(attribute.value);
    attributes[name] = truncateText(value, MAX_ATTRIBUTE_LENGTH);
  }

  return attributes;
}

export function sanitizeAttributeValueForStorage(value: string): string {
  if (SENSITIVE_VALUE_PATTERN.test(value)) {
    return "[redacted]";
  }

  const trimmed = value.trim();
  const looksLikeUrl =
    /^(?:https?:|\/|\.\.?\/|\?|#)/i.test(trimmed) || /[?#][^#]*=/.test(trimmed);
  return looksLikeUrl ? redactSensitiveUrl(value) : value;
}

/** Redacts credentials and sensitive query/hash parameters from a page URL. */
export function sanitizePageUrl(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    url.username = "";
    url.password = "";
    url.pathname = redactSensitivePathname(url.pathname);

    for (const [key, value] of [...url.searchParams.entries()]) {
      if (
        isSensitiveName(key) ||
        SENSITIVE_VALUE_PATTERN.test(value)
      ) {
        url.searchParams.set(key, "[redacted]");
      }
    }

    const hashValue = url.hash.slice(1);
    if (hashValue.includes("=")) {
      const hashParameters = new URLSearchParams(hashValue);
      let changed = false;
      for (const [key, value] of [...hashParameters.entries()]) {
        if (
          isSensitiveName(key) ||
          SENSITIVE_VALUE_PATTERN.test(value)
        ) {
          hashParameters.set(key, "[redacted]");
          changed = true;
        }
      }
      if (changed) {
        url.hash = hashParameters.toString();
      }
    } else if (SENSITIVE_VALUE_PATTERN.test(hashValue)) {
      url.hash = "[redacted]";
    }

    return url.toString();
  } catch {
    return "";
  }
}
