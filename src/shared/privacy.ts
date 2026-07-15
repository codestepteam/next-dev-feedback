const REDACTION_MARKER = "[redacted]";
const ENCODED_REDACTION_MARKER = "%5Bredacted%5D";

const SENSITIVE_VALUE_PATTERN =
  /(?:bearer\s+[a-z0-9._~+/-]+=*|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/i;
const SENSITIVE_VALUE_PATTERN_GLOBAL =
  /(?:bearer\s+[a-z0-9._~+/-]+=*|eyj[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,})/gi;
const SENSITIVE_KEY_VALUE_PATTERN =
  /((?:access[-_]?token|api[-_]?key|authorization|auth[-_]?code|credential|csrf|id[-_]?token|jwt|password|passwd|refresh[-_]?token|secret|session|signature|token)\s*[:=]\s*)(?:["']?)[^\s,;"']+/gi;
const SENSITIVE_PATH_KEY_PATTERN =
  /^(?:access[-_]?token|api[-_]?key|authorization|auth[-_]?code|callback|code|credential|csrf|id[-_]?token|invite|invitation|jwt|magic|magic[-_]?link|password|password[-_]?reset|passwd|refresh[-_]?token|reset|reset[-_]?password|secret|session|signature|token|verification?|verify[-_]?token)$/i;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LONG_HEX_PATTERN = /^[0-9a-f]{32,}$/i;

function safelyDecodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function looksLikeSensitivePathValue(value: string): boolean {
  return (
    SENSITIVE_VALUE_PATTERN.test(value) ||
    UUID_PATTERN.test(value) ||
    LONG_HEX_PATTERN.test(value)
  );
}

/**
 * Removes credentials embedded in an otherwise descriptive source hint.
 * Component names remain useful unless they contain an actual credential value.
 */
export function redactSensitiveSourceHint(value: string): string {
  return value
    .replace(SENSITIVE_VALUE_PATTERN_GLOBAL, REDACTION_MARKER)
    .replace(SENSITIVE_KEY_VALUE_PATTERN, `$1${REDACTION_MARKER}`);
}

/**
 * Redacts route parameters commonly used for credentials while preserving the
 * route shape. The function accepts and returns a URL-encoded pathname.
 */
export function redactSensitivePathname(pathname: string): string {
  const segments = pathname.split("/");
  let redactNextSegment = false;

  return segments
    .map((segment) => {
      if (!segment) {
        return segment;
      }

      const decoded = safelyDecodePathSegment(segment);
      if (redactNextSegment || looksLikeSensitivePathValue(decoded)) {
        redactNextSegment = false;
        return ENCODED_REDACTION_MARKER;
      }

      const separatorIndex = decoded.search(/[:=]/);
      if (separatorIndex > 0) {
        const key = decoded.slice(0, separatorIndex).trim();
        if (SENSITIVE_PATH_KEY_PATTERN.test(key)) {
          return `${encodeURIComponent(key)}=${ENCODED_REDACTION_MARKER}`;
        }
      }

      if (SENSITIVE_PATH_KEY_PATTERN.test(decoded)) {
        redactNextSegment = true;
      }

      return segment;
    })
    .join("/");
}
