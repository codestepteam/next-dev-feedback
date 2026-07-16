import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const PACKAGE_NAME = "@tallpizza/next-dev-feedback";
const DEFAULT_BODY_SIZE_LIMIT = "32mb";
const NEXT_CONFIG_NAMES = [
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
] as const;
const LAYOUT_NAMES = ["layout.tsx", "layout.jsx", "layout.js"] as const;
const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const EDGE_RUNTIME_PATTERN =
  /\bexport\s+const\s+runtime(?:\s*:\s*[^=;\n]+)?\s*=\s*["'](?:experimental-)?edge["']/;

export const CLI_USAGE = `Usage:
  next-dev-feedback init [options]

Options:
  --yes                    Apply without asking for confirmation
  --dry-run                Show changes without writing files
  --check                  Exit non-zero when initialization is needed
  --metadata-only          Save metadata without screenshots or config changes
  --body-size-limit <size> Server Action limit (default: 32mb)
  --no-layout              Do not update the root layout
  --no-gitignore           Do not update .gitignore
  --no-config              Do not update next.config.*
  --help                   Show this help
`;

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

export interface CliOptions {
  command: "init";
  yes: boolean;
  dryRun: boolean;
  check: boolean;
  metadataOnly: boolean;
  bodySizeLimit: string;
  layout: boolean;
  gitignore: boolean;
  config: boolean;
  help: boolean;
}

export interface InitOptions
  extends Omit<CliOptions, "command" | "help"> {
  projectRoot: string;
}

export interface InitResult {
  packageName: string;
  nextVersion: string;
  appDirectory: string;
  changedFiles: string[];
  unchangedFiles: string[];
  messages: string[];
  applied: boolean;
  checkFailed: boolean;
  cancelled: boolean;
}

export interface TransformResult {
  content: string;
  changed: boolean;
}

interface FilePlan {
  absolutePath: string;
  relativePath: string;
  content: string;
  action: "create" | "update";
}

interface ProjectPackage {
  name: string;
  nextVersion: string;
}

interface AppRouterInfo {
  appDirectory: string;
  absoluteAppDirectory: string;
  layoutPath: string | null;
}

interface ObjectProperty {
  key: string;
  valueStart: number;
  valueEnd: number;
}

interface ObjectRange {
  open: number;
  close: number;
}

interface RunInitHooks {
  confirm?: (plans: readonly FilePlan[]) => Promise<boolean>;
}

function isBodySizeLimit(value: string): boolean {
  return /^(?:[1-9]\d*|(?:\d+(?:\.\d+)?)(?:b|kb|mb|gb))$/i.test(value);
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    return {
      command: "init",
      yes: false,
      dryRun: false,
      check: false,
      metadataOnly: false,
      bodySizeLimit: DEFAULT_BODY_SIZE_LIMIT,
      layout: true,
      gitignore: true,
      config: true,
      help: true,
    };
  }

  const [command, ...argumentsList] = argv;
  if (command !== "init") {
    throw new CliError("Expected the `init` command.");
  }

  const options: CliOptions = {
    command: "init",
    yes: false,
    dryRun: false,
    check: false,
    metadataOnly: false,
    bodySizeLimit: DEFAULT_BODY_SIZE_LIMIT,
    layout: true,
    gitignore: true,
    config: true,
    help: false,
  };

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!argument) {
      throw new CliError("Invalid empty CLI argument.");
    }

    switch (argument) {
      case "--yes":
        options.yes = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--check":
        options.check = true;
        break;
      case "--metadata-only":
        options.metadataOnly = true;
        break;
      case "--no-layout":
        options.layout = false;
        break;
      case "--no-gitignore":
        options.gitignore = false;
        break;
      case "--no-config":
        options.config = false;
        break;
      case "--body-size-limit": {
        const value = argumentsList[index + 1];
        if (!value || value.startsWith("--")) {
          throw new CliError("--body-size-limit requires a value such as 32mb.");
        }
        options.bodySizeLimit = value.toLowerCase();
        index += 1;
        break;
      }
      default: {
        if (argument.startsWith("--body-size-limit=")) {
          options.bodySizeLimit = argument
            .slice("--body-size-limit=".length)
            .toLowerCase();
          break;
        }
        throw new CliError(`Unknown option: ${argument}`);
      }
    }
  }

  if (!isBodySizeLimit(options.bodySizeLimit)) {
    throw new CliError(
      "Invalid --body-size-limit. Use bytes or a value such as 2048kb or 32mb.",
    );
  }

  if (!options.layout && !options.gitignore && (!options.config || options.metadataOnly)) {
    throw new CliError("No initialization step is enabled.");
  }

  return options;
}

function maskComments(source: string): string {
  let output = "";
  let index = 0;

  while (index < source.length) {
    if (source[index] === "/" && source[index + 1] === "/") {
      output += "  ";
      index += 2;
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      continue;
    }

    if (source[index] === "/" && source[index + 1] === "*") {
      output += "  ";
      index += 2;
      while (index < source.length) {
        if (source[index] === "*" && source[index + 1] === "/") {
          output += "  ";
          index += 2;
          break;
        }
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    output += source[index];
    index += 1;
  }

  return output;
}

function maskNonCode(source: string): string {
  const commentsMasked = maskComments(source);
  let output = "";
  let index = 0;

  while (index < commentsMasked.length) {
    const character = commentsMasked[index];
    if (character !== '"' && character !== "'" && character !== "`") {
      output += character;
      index += 1;
      continue;
    }

    const quote = character;
    output += " ";
    index += 1;
    while (index < commentsMasked.length) {
      const current = commentsMasked[index];
      output += current === "\n" ? "\n" : " ";
      index += 1;
      if (current === "\\") {
        if (index < commentsMasked.length) {
          output += commentsMasked[index] === "\n" ? "\n" : " ";
          index += 1;
        }
        continue;
      }
      if (current === quote) {
        break;
      }
    }
  }

  return output;
}

function skipTrivia(source: string, start: number, limit = source.length): number {
  let index = start;
  while (index < limit) {
    if (/\s/.test(source[index] ?? "")) {
      index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < limit && source[index] !== "\n") index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1 || end >= limit) {
        throw new CliError("Unterminated comment in next.config.*.");
      }
      index = end + 2;
      continue;
    }
    break;
  }
  return index;
}

function skipQuoted(source: string, start: number, limit: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < limit) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  throw new CliError("Unterminated string in next.config.*.");
}

function findMatchingBrace(source: string, open: number): number {
  if (source[open] !== "{") {
    throw new CliError("Expected an object literal in next.config.*.");
  }
  let depth = 1;
  let index = open + 1;

  while (index < source.length) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(source, index, source.length);
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1) throw new CliError("Unterminated comment in next.config.*.");
      index = end + 2;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }

  throw new CliError("Unbalanced object literal in next.config.*.");
}

function findPropertyValueEnd(
  source: string,
  start: number,
  objectClose: number,
): number {
  const stack: string[] = [];
  let index = start;
  const matching: Record<string, string> = { "{": "}", "[": "]", "(": ")" };

  while (index < objectClose) {
    const character = source[index];
    if (!character) break;
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(source, index, objectClose);
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < objectClose && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end === -1 || end >= objectClose) {
        throw new CliError("Unterminated comment in next.config.*.");
      }
      index = end + 2;
      continue;
    }
    const closingCharacter = matching[character];
    if (closingCharacter) {
      stack.push(closingCharacter);
      index += 1;
      continue;
    }
    if (stack.at(-1) === character) {
      stack.pop();
      index += 1;
      continue;
    }
    if (character === "," && stack.length === 0) return index;
    index += 1;
  }

  return objectClose;
}

function parseObjectProperties(
  source: string,
  range: ObjectRange,
): ObjectProperty[] {
  const properties: ObjectProperty[] = [];
  let index = range.open + 1;

  while (true) {
    index = skipTrivia(source, index, range.close);
    if (index >= range.close) return properties;
    if (source[index] === ",") {
      index += 1;
      continue;
    }
    if (source.startsWith("...", index)) {
      throw new CliError(
        "next.config.* contains an object spread. Use --no-config and merge serverActions.bodySizeLimit manually.",
      );
    }
    if (source[index] === "[") {
      throw new CliError(
        "next.config.* contains a computed property. Use --no-config and update it manually.",
      );
    }

    let key = "";
    if (source[index] === '"' || source[index] === "'") {
      const keyEnd = skipQuoted(source, index, range.close);
      key = source.slice(index + 1, keyEnd - 1);
      index = keyEnd;
    } else {
      const keyMatch = /^[A-Za-z_$][\w$]*/.exec(source.slice(index));
      if (!keyMatch) {
        throw new CliError(
          "next.config.* is not a simple object export. Use --no-config and update it manually.",
        );
      }
      key = keyMatch[0];
      index += key.length;
    }

    index = skipTrivia(source, index, range.close);
    if (source[index] !== ":") {
      throw new CliError(
        "next.config.* contains shorthand or method properties. Use --no-config and update it manually.",
      );
    }

    const valueStart = skipTrivia(source, index + 1, range.close);
    const valueEnd = findPropertyValueEnd(source, valueStart, range.close);
    properties.push({ key, valueStart, valueEnd });
    index = valueEnd;
  }
}

function propertyByName(
  properties: readonly ObjectProperty[],
  name: string,
): ObjectProperty | null {
  const matches = properties.filter((property) => property.key === name);
  if (matches.length > 1) {
    throw new CliError(`next.config.* contains more than one ${name} property.`);
  }
  return matches[0] ?? null;
}

function propertyObjectRange(
  source: string,
  property: ObjectProperty,
  label: string,
): ObjectRange {
  const open = skipTrivia(source, property.valueStart, property.valueEnd);
  if (source[open] !== "{") {
    throw new CliError(
      `${label} is not a plain object. Use --no-config and merge bodySizeLimit manually.`,
    );
  }
  const close = findMatchingBrace(source, open);
  if (skipTrivia(source, close + 1, property.valueEnd) !== property.valueEnd) {
    throw new CliError(
      `${label} uses a complex expression. Use --no-config and merge bodySizeLimit manually.`,
    );
  }
  return { open, close };
}

function locateExportedObject(source: string): ObjectRange {
  const masked = maskNonCode(source);
  const esmExports = [...masked.matchAll(/\bexport\s+default\s+/g)];
  const cjsExports = [...masked.matchAll(/\bmodule\s*\.\s*exports\s*=\s*/g)];
  if (esmExports.length + cjsExports.length !== 1) {
    throw new CliError(
      "Expected exactly one simple default export in next.config.*. Use --no-config for complex configs.",
    );
  }

  const exportMatch = esmExports[0] ?? cjsExports[0];
  if (!exportMatch) {
    throw new CliError("Could not locate the Next config export.");
  }
  let expressionStart = skipTrivia(
    source,
    (exportMatch.index ?? 0) + exportMatch[0].length,
  );
  if (source[expressionStart] === "{") {
    return { open: expressionStart, close: findMatchingBrace(source, expressionStart) };
  }

  const identifierMatch = /^[A-Za-z_$][\w$]*/.exec(source.slice(expressionStart));
  if (!identifierMatch) {
    throw new CliError(
      "next.config.* exports a function or wrapped expression. Use --no-config and update it manually.",
    );
  }
  const identifier = identifierMatch[0];
  expressionStart += identifier.length;
  const exportTail = source.slice(
    expressionStart,
    source.indexOf("\n", expressionStart) === -1
      ? source.length
      : source.indexOf("\n", expressionStart),
  );
  if (!/^\s*;?\s*$/.test(exportTail)) {
    throw new CliError(
      "next.config.* has a complex default export. Use --no-config and update it manually.",
    );
  }

  const declarationPattern = new RegExp(
    `\\b(?:const|let|var)\\s+${identifier.replace(/[$]/g, "\\$")}\\b`,
    "g",
  );
  const declarations = [...masked.matchAll(declarationPattern)];
  if (declarations.length !== 1) {
    throw new CliError(
      "Could not identify one exported Next config object. Use --no-config and update it manually.",
    );
  }
  const declaration = declarations[0];
  if (!declaration) {
    throw new CliError("Could not locate the exported Next config declaration.");
  }
  const declarationStart = (declaration.index ?? 0) + declaration[0].length;
  const equals = masked.indexOf("=", declarationStart);
  const lineEnd = masked.indexOf("\n", declarationStart);
  if (equals === -1 || (lineEnd !== -1 && equals > lineEnd)) {
    throw new CliError(
      "The exported Next config declaration is too complex. Use --no-config and update it manually.",
    );
  }
  const objectOpen = skipTrivia(source, equals + 1);
  if (source[objectOpen] !== "{") {
    throw new CliError(
      "The exported Next config is not a plain object. Use --no-config and update it manually.",
    );
  }

  const range = { open: objectOpen, close: findMatchingBrace(source, objectOpen) };
  const outsideObject = `${masked.slice(0, range.open)} ${masked.slice(range.close + 1)}`;
  const mutationPattern = new RegExp(`\\b${identifier.replace(/[$]/g, "\\$")}\\s*\\.`);
  if (mutationPattern.test(outsideObject)) {
    throw new CliError(
      "The exported Next config is mutated after declaration. Use --no-config and update it manually.",
    );
  }
  return range;
}

function lineIndent(source: string, position: number): string {
  const start = source.lastIndexOf("\n", position - 1) + 1;
  return /^\s*/.exec(source.slice(start, position))?.[0] ?? "";
}

function indentLines(value: string, indent: string): string {
  return value
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

function insertFirstProperty(
  source: string,
  range: ObjectRange,
  propertyText: string,
): string {
  const childIndent = `${lineIndent(source, range.open)}  `;
  const firstContent = skipTrivia(source, range.open + 1, range.close);
  const formattedProperty = indentLines(propertyText, childIndent);

  if (firstContent === range.close) {
    return `${source.slice(0, range.open + 1)}\n${formattedProperty}\n${lineIndent(
      source,
      range.open,
    )}${source.slice(range.close)}`;
  }

  return `${source.slice(0, range.open + 1)}\n${formattedProperty},\n${childIndent}${source.slice(
    firstContent,
  )}`;
}

function normalizeExpression(value: string): string {
  return value.replace(/\s+/g, "").replace(/'/g, '"').replace(/;$/, "");
}

function bodySizeExpression(size: string): string {
  return `process.env.NODE_ENV === "development" ? "${size}" : "1mb"`;
}

export function transformNextConfig(
  source: string | null,
  bodySizeLimit = DEFAULT_BODY_SIZE_LIMIT,
): TransformResult {
  if (!isBodySizeLimit(bodySizeLimit)) {
    throw new CliError(`Invalid Server Action body size limit: ${bodySizeLimit}`);
  }

  if (source === null) {
    const expression = bodySizeExpression(bodySizeLimit);
    return {
      changed: true,
      content: `/** @type {import("next").NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: {
      bodySizeLimit:
        ${expression},
    },
  },
};

export default nextConfig;
`,
    };
  }

  const root = locateExportedObject(source);
  const rootProperties = parseObjectProperties(source, root);
  const experimental = propertyByName(rootProperties, "experimental");
  const expression = bodySizeExpression(bodySizeLimit);

  if (!experimental) {
    const content = insertFirstProperty(
      source,
      root,
      `experimental: {\n  serverActions: {\n    bodySizeLimit:\n      ${expression},\n  },\n}`,
    );
    return { content, changed: true };
  }

  const experimentalRange = propertyObjectRange(
    source,
    experimental,
    "experimental",
  );
  const experimentalProperties = parseObjectProperties(source, experimentalRange);
  const serverActions = propertyByName(experimentalProperties, "serverActions");

  if (!serverActions) {
    const content = insertFirstProperty(
      source,
      experimentalRange,
      `serverActions: {\n  bodySizeLimit:\n    ${expression},\n}`,
    );
    return { content, changed: true };
  }

  const serverActionsRange = propertyObjectRange(
    source,
    serverActions,
    "experimental.serverActions",
  );
  const serverActionProperties = parseObjectProperties(source, serverActionsRange);
  const existingBodySizeLimit = propertyByName(
    serverActionProperties,
    "bodySizeLimit",
  );

  if (!existingBodySizeLimit) {
    const content = insertFirstProperty(
      source,
      serverActionsRange,
      `bodySizeLimit:\n  ${expression}`,
    );
    return { content, changed: true };
  }

  const existingExpression = source.slice(
    existingBodySizeLimit.valueStart,
    existingBodySizeLimit.valueEnd,
  );
  if (normalizeExpression(existingExpression) === normalizeExpression(expression)) {
    return { content: source, changed: false };
  }

  throw new CliError(
    "experimental.serverActions.bodySizeLimit already has a different value. Keep it or update it manually, then rerun with --no-config.",
  );
}

function findCaptureImport(source: string): string | null {
  const packagePattern = PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const importPattern = new RegExp(
    `import\\s*\\{([^{}]*)\\}\\s*from\\s*["']${packagePattern}["']`,
    "g",
  );

  for (const match of source.matchAll(importPattern)) {
    const specifiers = (match[1] ?? "").split(",");
    for (const specifier of specifiers) {
      const namedMatch = /^\s*DevFeedbackCapture(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(
        specifier,
      );
      if (namedMatch) return namedMatch[1] ?? "DevFeedbackCapture";
    }
  }
  return null;
}

function chooseCaptureLocalName(source: string): string {
  const imported = findCaptureImport(source);
  if (imported) return imported;
  if (/<DevFeedbackCapture\b/.test(maskNonCode(source))) {
    return "DevFeedbackCapture";
  }
  if (!/\bDevFeedbackCapture\b/.test(maskNonCode(source))) {
    return "DevFeedbackCapture";
  }
  if (!/\bNextDevFeedbackCapture\b/.test(maskNonCode(source))) {
    return "NextDevFeedbackCapture";
  }
  throw new CliError(
    "The root layout already declares DevFeedbackCapture identifiers. Add the package import manually and rerun with --no-layout.",
  );
}

function addCaptureImport(source: string, localName: string): string {
  if (findCaptureImport(source)) return source;
  const specifier =
    localName === "DevFeedbackCapture"
      ? "DevFeedbackCapture"
      : `DevFeedbackCapture as ${localName}`;
  return `import { ${specifier} } from "${PACKAGE_NAME}";\n${source}`;
}

function componentPattern(localName: string): RegExp {
  return new RegExp(`<${localName}\\b([^>]*)\\/>`, "g");
}

function hasDevelopmentCondition(source: string, localName: string): boolean {
  const escapedName = localName.replace(/[$]/g, "\\$");
  const beforeComponent = new RegExp(
    `process\\.env\\.NODE_ENV\\s*===\\s*["']development["'][\\s\\S]{0,500}<${escapedName}\\b`,
  );
  return beforeComponent.test(source);
}

function updateExistingCaptureMode(
  source: string,
  localName: string,
  metadataOnly: boolean,
): TransformResult | null {
  const matches = [...source.matchAll(componentPattern(localName))];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new CliError(
      "The root layout contains more than one DevFeedbackCapture. Update it manually and use --no-layout.",
    );
  }
  if (!hasDevelopmentCondition(source, localName)) {
    throw new CliError(
      "DevFeedbackCapture already exists without a recognizable development-only condition. Wrap it in a NODE_ENV development check or use --no-layout.",
    );
  }

  const match = matches[0];
  if (!match) return null;
  const fullMatch = match[0];
  const attributes = match[1] ?? "";
  const hasMetadataOnly = /\bmetadataOnly(?:\s*=\s*\{?true\}?)?\b/.test(attributes);
  if (hasMetadataOnly === metadataOnly) {
    return { content: source, changed: false };
  }
  if (metadataOnly) {
    const replacement = fullMatch.replace(/\s*\/>$/, " metadataOnly />");
    return {
      content: `${source.slice(0, match.index)}${replacement}${source.slice(
        (match.index ?? 0) + fullMatch.length,
      )}`,
      changed: true,
    };
  }

  const replacement = fullMatch.replace(
    /\s+metadataOnly(?:\s*=\s*\{?true\}?)?/,
    "",
  );
  return {
    content: `${source.slice(0, match.index)}${replacement}${source.slice(
      (match.index ?? 0) + fullMatch.length,
    )}`,
    changed: true,
  };
}

export function transformRootLayout(
  source: string,
  options: { metadataOnly?: boolean } = {},
): TransformResult {
  const commentsMasked = maskComments(source);
  if (/^\s*["']use\s+(?:client|server)["']\s*;?/.test(commentsMasked)) {
    throw new CliError(
      "The root layout has a use-client/use-server directive and cannot safely host the package Server Component. Use --no-layout and wire a Server Component manually.",
    );
  }

  const bodyMatches = [...maskNonCode(source).matchAll(/<\/body\s*>/gi)];
  if (bodyMatches.length !== 1) {
    throw new CliError(
      "Expected exactly one closing </body> in the root layout. Add it or use --no-layout.",
    );
  }

  const localName = chooseCaptureLocalName(source);
  const existing = updateExistingCaptureMode(
    source,
    localName,
    options.metadataOnly ?? false,
  );
  if (existing) {
    const withImport = addCaptureImport(existing.content, localName);
    return {
      content: withImport,
      changed: existing.changed || withImport !== existing.content,
    };
  }

  const bodyMatch = bodyMatches[0];
  if (!bodyMatch) {
    throw new CliError("Could not locate the root layout closing body tag.");
  }
  const closingStart = bodyMatch.index ?? 0;
  const lineStart = source.lastIndexOf("\n", closingStart - 1) + 1;
  const prefixOnLine = source.slice(lineStart, closingStart);
  const closingIndent = /^\s*$/.test(prefixOnLine)
    ? prefixOnLine
    : /^\s*/.exec(prefixOnLine)?.[0] ?? "";
  const childIndent = `${closingIndent}  `;
  const metadataProp = options.metadataOnly ? " metadataOnly" : "";
  const block = `${childIndent}{process.env.NODE_ENV === "development" ? (\n${childIndent}  <${localName}${metadataProp} />\n${childIndent}) : null}`;

  let withComponent: string;
  if (/^\s*$/.test(prefixOnLine)) {
    withComponent = `${source.slice(0, lineStart)}${block}\n${source.slice(lineStart)}`;
  } else {
    withComponent = `${source.slice(0, closingStart)}\n${block}\n${closingIndent}${source.slice(
      closingStart,
    )}`;
  }

  return {
    content: addCaptureImport(withComponent, localName),
    changed: true,
  };
}

export function transformGitignore(source: string | null): TransformResult {
  const content = source ?? "";
  const hasFeedbackRule = content
    .split(/\r?\n/)
    .some((line) => /^\/?\.feedback\/?$/.test(line.trim()));
  if (hasFeedbackRule) return { content, changed: false };

  const separator = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  return {
    content: `${content}${separator}# Local UI feedback captures\n.feedback/\n`,
    changed: true,
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readProjectPackage(projectRoot: string): Promise<ProjectPackage> {
  const packagePath = path.join(projectRoot, "package.json");
  let raw: string;
  try {
    raw = await readFile(packagePath, "utf8");
  } catch {
    throw new CliError(`No package.json found in ${projectRoot}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError("package.json is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError("package.json must contain an object.");
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : path.basename(projectRoot);
  const dependencyGroups = [
    record.dependencies,
    record.devDependencies,
    record.peerDependencies,
  ];
  let nextVersion: string | null = null;
  for (const group of dependencyGroups) {
    if (typeof group !== "object" || group === null || Array.isArray(group)) continue;
    const candidate = (group as Record<string, unknown>).next;
    if (typeof candidate === "string") {
      nextVersion = candidate;
      break;
    }
  }
  if (!nextVersion) {
    throw new CliError("Next.js was not found in package.json dependencies.");
  }
  const majorMatch = /(?:^|[^\d])(\d+)(?:\.|$)/.exec(nextVersion);
  if (majorMatch && Number(majorMatch[1]) < 14) {
    throw new CliError(
      `Next.js ${nextVersion} is not supported. Server Actions must be stable (Next.js 14 or newer).`,
    );
  }
  return { name, nextVersion };
}

async function discoverAppRouter(projectRoot: string): Promise<AppRouterInfo> {
  const appCandidates = ["src/app", "app"];
  const existingDirectories: string[] = [];
  for (const candidate of appCandidates) {
    if (await pathExists(path.join(projectRoot, candidate))) {
      existingDirectories.push(candidate);
    }
  }
  if (existingDirectories.length === 0) {
    throw new CliError("No App Router directory found (expected src/app or app).");
  }
  if (existingDirectories.length > 1) {
    throw new CliError(
      "Both src/app and app exist. Remove the unused directory or initialize manually.",
    );
  }

  const appDirectory = existingDirectories[0];
  if (!appDirectory) {
    throw new CliError("Could not determine the App Router directory.");
  }
  const absoluteAppDirectory = path.join(projectRoot, appDirectory);
  const layouts: string[] = [];
  for (const layoutName of LAYOUT_NAMES) {
    const candidate = path.join(absoluteAppDirectory, layoutName);
    if (await pathExists(candidate)) layouts.push(candidate);
  }
  if (layouts.length > 1) {
    throw new CliError(
      `Multiple root layouts found in ${appDirectory}. Keep one layout file before running init.`,
    );
  }
  return {
    appDirectory,
    absoluteAppDirectory,
    layoutPath: layouts[0] ?? null,
  };
}

async function findEdgeRuntimeFiles(directory: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
        continue;
      }
      if (!entry.isFile() || !CODE_EXTENSIONS.has(path.extname(entry.name))) continue;
      const source = await readFile(entryPath, "utf8");
      if (EDGE_RUNTIME_PATTERN.test(maskComments(source))) found.push(entryPath);
    }
  }

  await walk(directory);
  return found;
}

async function discoverConfig(projectRoot: string): Promise<string | null> {
  const configs: string[] = [];
  for (const name of NEXT_CONFIG_NAMES) {
    const candidate = path.join(projectRoot, name);
    if (await pathExists(candidate)) configs.push(candidate);
  }
  if (configs.length > 1) {
    throw new CliError(
      `Multiple Next config files found: ${configs
        .map((config) => path.basename(config))
        .join(", ")}. Keep one or use --no-config.`,
    );
  }
  return configs[0] ?? null;
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.dev-feedback-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function defaultConfirm(plans: readonly FilePlan[]): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new CliError("Interactive confirmation is unavailable. Rerun with --yes.");
  }
  const interfaceInstance = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await interfaceInstance.question(
      `Apply ${plans.length} file change${plans.length === 1 ? "" : "s"}? [y/N] `,
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    interfaceInstance.close();
  }
}

export async function runInit(
  options: InitOptions,
  hooks: RunInitHooks = {},
): Promise<InitResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const projectPackage = await readProjectPackage(projectRoot);
  const appRouter = await discoverAppRouter(projectRoot);
  const edgeFiles = await findEdgeRuntimeFiles(appRouter.absoluteAppDirectory);
  if (edgeFiles.length > 0) {
    throw new CliError(
      `Edge Runtime cannot write .feedback files. Found runtime = "edge" in: ${edgeFiles
        .map((file) => path.relative(projectRoot, file))
        .join(", ")}. Remove it for these routes or initialize manually.`,
    );
  }

  const plans: FilePlan[] = [];
  const unchangedFiles: string[] = [];
  const messages = [
    `Detected ${projectPackage.name} with Next.js ${projectPackage.nextVersion}.`,
    `Detected App Router at ${appRouter.appDirectory}.`,
  ];

  if (options.layout) {
    if (!appRouter.layoutPath) {
      throw new CliError(
        `No root layout found in ${appRouter.appDirectory}. Create layout.tsx or use --no-layout.`,
      );
    }
    const source = await readFile(appRouter.layoutPath, "utf8");
    const transformed = transformRootLayout(source, {
      metadataOnly: options.metadataOnly,
    });
    const relativePath = path.relative(projectRoot, appRouter.layoutPath);
    if (transformed.changed) {
      plans.push({
        absolutePath: appRouter.layoutPath,
        relativePath,
        content: transformed.content,
        action: "update",
      });
    } else {
      unchangedFiles.push(relativePath);
    }
  }

  if (options.gitignore) {
    const gitignorePath = path.join(projectRoot, ".gitignore");
    const exists = await pathExists(gitignorePath);
    const source = exists ? await readFile(gitignorePath, "utf8") : null;
    const transformed = transformGitignore(source);
    if (transformed.changed) {
      plans.push({
        absolutePath: gitignorePath,
        relativePath: ".gitignore",
        content: transformed.content,
        action: exists ? "update" : "create",
      });
    } else {
      unchangedFiles.push(".gitignore");
    }
  }

  if (options.config && !options.metadataOnly) {
    const configPath = await discoverConfig(projectRoot);
    const source = configPath ? await readFile(configPath, "utf8") : null;
    const transformed = transformNextConfig(source, options.bodySizeLimit);
    const resolvedPath = configPath ?? path.join(projectRoot, "next.config.mjs");
    const relativePath = path.relative(projectRoot, resolvedPath);
    if (transformed.changed) {
      plans.push({
        absolutePath: resolvedPath,
        relativePath,
        content: transformed.content,
        action: configPath ? "update" : "create",
      });
    } else {
      unchangedFiles.push(relativePath);
    }
  } else if (options.metadataOnly) {
    messages.push(
      "Metadata-only mode enabled; screenshots and next.config.* changes are skipped.",
    );
  }

  for (const plan of plans) {
    messages.push(`${plan.action === "create" ? "Create" : "Update"} ${plan.relativePath}`);
  }
  for (const file of unchangedFiles) messages.push(`Already configured ${file}`);

  const resultBase = {
    packageName: projectPackage.name,
    nextVersion: projectPackage.nextVersion,
    appDirectory: appRouter.appDirectory,
    changedFiles: plans.map((plan) => plan.relativePath),
    unchangedFiles,
    messages,
  };

  if (options.check) {
    return {
      ...resultBase,
      applied: false,
      checkFailed: plans.length > 0,
      cancelled: false,
    };
  }
  if (options.dryRun || plans.length === 0) {
    return {
      ...resultBase,
      applied: false,
      checkFailed: false,
      cancelled: false,
    };
  }

  const confirmed = options.yes
    ? true
    : await (hooks.confirm ?? defaultConfirm)(plans);
  if (!confirmed) {
    return {
      ...resultBase,
      applied: false,
      checkFailed: false,
      cancelled: true,
    };
  }

  for (const plan of plans) {
    await writeTextAtomic(plan.absolutePath, plan.content);
  }
  return {
    ...resultBase,
    applied: true,
    checkFailed: false,
    cancelled: false,
  };
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let parsed: CliOptions;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid arguments.";
    console.error(`Error: ${message}\n\n${CLI_USAGE}`);
    return 1;
  }

  if (parsed.help) {
    console.log(CLI_USAGE);
    return 0;
  }

  try {
    const result = await runInit({
      projectRoot: process.cwd(),
      yes: parsed.yes,
      dryRun: parsed.dryRun,
      check: parsed.check,
      metadataOnly: parsed.metadataOnly,
      bodySizeLimit: parsed.bodySizeLimit,
      layout: parsed.layout,
      gitignore: parsed.gitignore,
      config: parsed.config,
    });
    for (const message of result.messages) console.log(message);
    if (result.cancelled) {
      console.log("Initialization cancelled; no files were changed.");
      return 0;
    }
    if (parsed.check) {
      console.log(
        result.checkFailed
          ? "Initialization is required."
          : "Dev feedback is initialized.",
      );
      return result.checkFailed ? 1 : 0;
    }
    if (parsed.dryRun) {
      console.log("Dry run complete; no files were changed.");
    } else if (result.applied) {
      console.log("Dev feedback initialized successfully.");
    } else {
      console.log("Dev feedback is already initialized.");
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Initialization failed.";
    console.error(`Error: ${message}`);
    return 1;
  }
}
