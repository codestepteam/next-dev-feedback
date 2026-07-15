const MAX_SELECTOR_CLASSES = 4;
const MAX_STABLE_CLASS_LENGTH = 80;
const SENSITIVE_SELECTOR_VALUE_PATTERN = /(?:bearer\s+[a-z0-9._~+/-]+=*|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/i;

const STATE_CLASS_PATTERN = /^(?:is-|has-)?(?:active|checked|closed|closing|collapsed|current|disabled|dragging|entered|entering|error|expanded|focus|focused|hidden|hover|invalid|loading|open|opening|pressed|selected|success|transitioning|valid|visible)$/i;
const GENERATED_CLASS_PATTERNS = [
  /^css-[a-z0-9_-]{5,}$/i,
  /^jsx-\d+$/i,
  /^sc-[a-z0-9_-]{5,}$/i,
  /^__[a-z0-9_-]{6,}$/i,
  /(?:^|[-_])[a-f0-9]{7,}(?:$|[-_])/i,
  /(?:^|[-_])module__[a-z0-9_-]{4,}(?:__|$)/i,
  /^.+_.+__[a-z0-9]{5,6}$/i,
  /__[a-z0-9_-]*[a-z]\d[a-z0-9_-]{3,}$/i,
];

/** A CSS.escape-compatible identifier escaper that is also usable in DOM test runners. */
export function escapeCssIdentifier(value: string): string {
  const nativeEscape = globalThis.CSS?.escape;
  if (nativeEscape) {
    return nativeEscape(value);
  }

  if (value.length === 0) {
    return "\\0 ";
  }

  const characters = Array.from(value);

  return characters
    .map((character, index) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const isAsciiLetter =
        (codePoint >= 65 && codePoint <= 90) ||
        (codePoint >= 97 && codePoint <= 122);
      const isDigit = codePoint >= 48 && codePoint <= 57;
      const isSafe = isAsciiLetter || isDigit || character === "-" || character === "_";
      const mustEscapeLeadingDigit = isDigit && index === 0;
      const mustEscapeSecondDigit = isDigit && index === 1 && characters[0] === "-";
      const mustEscapeSingleHyphen = character === "-" && characters.length === 1;

      if (
        isSafe &&
        !mustEscapeLeadingDigit &&
        !mustEscapeSecondDigit &&
        !mustEscapeSingleHyphen
      ) {
        return character;
      }

      if (codePoint === 0) {
        return "\uFFFD";
      }

      return `\\${codePoint.toString(16)} `;
    })
    .join("");
}

export function escapeCssAttributeValue(value: string): string {
  return value
    .replaceAll("\0", "\uFFFD")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\a ")
    .replaceAll("\r", "\\d ")
    .replaceAll("\f", "\\c ");
}

export function isStableClassName(className: string): boolean {
  if (
    className.length === 0 ||
    className.length > MAX_STABLE_CLASS_LENGTH ||
    /\s/.test(className) ||
    SENSITIVE_SELECTOR_VALUE_PATTERN.test(className) ||
    STATE_CLASS_PATTERN.test(className)
  ) {
    return false;
  }

  return !GENERATED_CLASS_PATTERNS.some((pattern) => pattern.test(className));
}

export function getStableClassNames(element: Element): string[] {
  return Array.from(element.classList)
    .filter(isStableClassName)
    .slice(0, MAX_SELECTOR_CLASSES);
}

export function selectorMatchesOnlyElement(
  selector: string,
  element: Element,
  root: ParentNode = element.ownerDocument,
): boolean {
  try {
    const matches = root.querySelectorAll(selector);
    return matches.length === 1 && matches.item(0) === element;
  } catch {
    return false;
  }
}

function attributeSelector(name: string, value: string): string {
  return `[${name}="${escapeCssAttributeValue(value)}"]`;
}

function getAttributeSegment(element: Element): string | null {
  const testId = element.getAttribute("data-testid")?.trim();
  if (testId && !SENSITIVE_SELECTOR_VALUE_PATTERN.test(testId)) {
    return attributeSelector("data-testid", testId);
  }

  const component = element.getAttribute("data-component")?.trim();
  if (component && !SENSITIVE_SELECTOR_VALUE_PATTERN.test(component)) {
    return attributeSelector("data-component", component);
  }

  return null;
}

function getClassSegments(element: Element): string[] {
  const tagName = element.tagName.toLowerCase();
  const classNames = getStableClassNames(element);
  const candidates: string[] = [];

  for (const className of classNames) {
    candidates.push(`${tagName}.${escapeCssIdentifier(className)}`);
  }

  if (classNames.length > 1) {
    let combined = tagName;
    for (const className of classNames) {
      combined += `.${escapeCssIdentifier(className)}`;
      candidates.push(combined);
    }
  }

  return [...new Set(candidates)];
}

function getPreferredSegment(element: Element): string {
  const tagName = element.tagName.toLowerCase();
  const id = element.getAttribute("id")?.trim();
  if (id && !SENSITIVE_SELECTOR_VALUE_PATTERN.test(id)) {
    return `${tagName}#${escapeCssIdentifier(id)}`;
  }

  const attribute = getAttributeSegment(element);
  if (attribute) {
    return `${tagName}${attribute}`;
  }

  const classNames = getStableClassNames(element);
  if (classNames.length > 0) {
    return `${tagName}${classNames
      .map((className) => `.${escapeCssIdentifier(className)}`)
      .join("")}`;
  }

  return tagName;
}

function getNthOfType(element: Element): number {
  const tagName = element.tagName;
  let index = 1;
  let sibling = element.previousElementSibling;

  while (sibling) {
    if (sibling.tagName === tagName) {
      index += 1;
    }
    sibling = sibling.previousElementSibling;
  }

  return index;
}

function siblingsMatchingSegment(element: Element, segment: string): number {
  const parent = element.parentElement;
  if (!parent) {
    return 1;
  }

  let count = 0;
  for (const child of parent.children) {
    try {
      if (child.matches(segment)) {
        count += 1;
      }
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  return count;
}

function withPositionWhenNeeded(element: Element, segment: string): string {
  if (siblingsMatchingSegment(element, segment) <= 1) {
    return segment;
  }

  return `${segment}:nth-of-type(${getNthOfType(element)})`;
}

function buildHierarchicalSelector(
  element: Element,
  root: ParentNode,
  includePositions: boolean,
): string | null {
  const segments: string[] = [];
  let current: Element | null = element;

  while (current) {
    const preferred = getPreferredSegment(current);
    segments.unshift(
      includePositions ? withPositionWhenNeeded(current, preferred) : preferred,
    );

    const candidate = segments.join(" > ");
    if (selectorMatchesOnlyElement(candidate, element, root)) {
      return candidate;
    }

    if (current.tagName.toLowerCase() === "html") {
      break;
    }
    current = current.parentElement;
  }

  return null;
}

/**
 * Generates a selector and verifies that it resolves to exactly the supplied
 * element. The fallback path includes nth-of-type only when semantic segments
 * alone cannot make the selector unique.
 */
export function generateCssSelector(
  element: Element,
  root: ParentNode = element.ownerDocument,
): string {
  const id = element.getAttribute("id")?.trim();
  if (id && !SENSITIVE_SELECTOR_VALUE_PATTERN.test(id)) {
    const idSelector = `#${escapeCssIdentifier(id)}`;
    if (selectorMatchesOnlyElement(idSelector, element, root)) {
      return idSelector;
    }
  }

  for (const name of ["data-testid", "data-component"] as const) {
    const value = element.getAttribute(name)?.trim();
    if (!value || SENSITIVE_SELECTOR_VALUE_PATTERN.test(value)) {
      continue;
    }

    const candidate = attributeSelector(name, value);
    if (selectorMatchesOnlyElement(candidate, element, root)) {
      return candidate;
    }
  }

  for (const candidate of getClassSegments(element)) {
    if (selectorMatchesOnlyElement(candidate, element, root)) {
      return candidate;
    }
  }

  const hierarchicalSelector = buildHierarchicalSelector(element, root, false);
  if (hierarchicalSelector) {
    return hierarchicalSelector;
  }

  const positionedSelector = buildHierarchicalSelector(element, root, true);
  if (positionedSelector) {
    return positionedSelector;
  }

  throw new Error("Unable to generate a unique CSS selector for the element.");
}
