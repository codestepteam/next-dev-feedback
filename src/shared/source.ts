import { redactSensitiveSourceHint } from "./privacy.js";
import type { DevFeedbackSource } from "./types.js";

const DEFAULT_MAX_SOURCE_DEPTH = 10;
const MAX_SOURCE_VALUE_LENGTH = 1_000;

function readNonEmptyAttribute(
  element: Element,
  attributeName: string,
): string | undefined {
  const value = element.getAttribute(attributeName)?.trim();
  return value ? value.slice(0, MAX_SOURCE_VALUE_LENGTH) : undefined;
}

function readPositiveIntegerAttribute(
  element: Element,
  attributeName: string,
): number | undefined {
  const value = readNonEmptyAttribute(element, attributeName);
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Reads explicit source hints from the selected element and at most ten of its
 * ancestors. Each field uses the closest available value, so a component name
 * and its file information may be supplied by adjacent wrapper elements.
 */
export function findSourceInfo(
  element: Element,
  maxDepth = DEFAULT_MAX_SOURCE_DEPTH,
): DevFeedbackSource | undefined {
  const normalizedMaxDepth = Math.max(0, Math.min(10, Math.floor(maxDepth)));
  const source: DevFeedbackSource = {};
  let current: Element | null = element;

  for (let depth = 0; current && depth <= normalizedMaxDepth; depth += 1) {
    const componentName = readNonEmptyAttribute(current, "data-component");
    source.componentName ??= componentName
      ? redactSensitiveSourceHint(componentName)
      : undefined;
    const filePath = readNonEmptyAttribute(current, "data-source-file");
    source.filePath ??=
      filePath && redactSensitiveSourceHint(filePath) === filePath
        ? filePath
        : undefined;
    source.lineNumber ??= readPositiveIntegerAttribute(
      current,
      "data-source-line",
    );
    source.columnNumber ??= readPositiveIntegerAttribute(
      current,
      "data-source-column",
    );

    if (
      source.componentName &&
      source.filePath &&
      source.lineNumber &&
      source.columnNumber
    ) {
      break;
    }

    current = current.parentElement;
  }

  return Object.keys(source).length > 0 ? source : undefined;
}
