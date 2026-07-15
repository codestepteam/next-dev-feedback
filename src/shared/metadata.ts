import {
  collectSafeAttributes,
  sanitizeAttributeValueForStorage,
  sanitizeElementTextContent,
  sanitizeOuterHTML,
  sanitizePageUrl,
  truncateText,
} from "./sanitize.js";
import { findSourceInfo } from "./source.js";
import type {
  DevFeedbackPage,
  DevFeedbackScreenshotData,
  DevFeedbackSubmission,
  DevFeedbackTarget,
  SerializableDOMRect,
} from "./types.js";

const MAX_ID_LENGTH = 1_000;
const MAX_CLASS_NAME_LENGTH = 2_000;

export function serializeDomRect(rect: DOMRect | DOMRectReadOnly): SerializableDOMRect {
  return {
    x: rect.x,
    y: rect.y,
    top: rect.top,
    left: rect.left,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function requireBrowserWindow(browserWindow?: Window): Window {
  if (browserWindow) {
    return browserWindow;
  }

  if (typeof window === "undefined") {
    throw new Error("Dev feedback page metadata is only available in a browser.");
  }

  return window;
}

export function createPageMetadata(browserWindow?: Window): DevFeedbackPage {
  const currentWindow = requireBrowserWindow(browserWindow);
  const url = sanitizePageUrl(currentWindow.location.href);
  const sanitizedLocation = new URL(url || currentWindow.location.origin);

  return {
    url,
    pathname: sanitizedLocation.pathname,
    search: sanitizedLocation.search,
    viewportWidth: currentWindow.innerWidth,
    viewportHeight: currentWindow.innerHeight,
    devicePixelRatio: currentWindow.devicePixelRatio,
    scrollX: currentWindow.scrollX,
    scrollY: currentWindow.scrollY,
    userAgent: currentWindow.navigator.userAgent,
  };
}

export function createTargetMetadata(
  element: Element,
  selector: string,
  boundingRect?: SerializableDOMRect,
): DevFeedbackTarget {
  const id = element.getAttribute("id")?.trim();
  const className = element.getAttribute("class")?.trim();
  const textContent = sanitizeElementTextContent(element);

  return {
    selector,
    tagName: element.tagName.toLowerCase(),
    ...(id
      ? {
          id: truncateText(
            sanitizeAttributeValueForStorage(id),
            MAX_ID_LENGTH,
          ),
        }
      : {}),
    ...(className
      ? {
          className: truncateText(
            sanitizeAttributeValueForStorage(className),
            MAX_CLASS_NAME_LENGTH,
          ),
        }
      : {}),
    ...(textContent ? { textContent } : {}),
    outerHTML: sanitizeOuterHTML(element),
    boundingRect:
      boundingRect ?? serializeDomRect(element.getBoundingClientRect()),
    attributes: collectSafeAttributes(element),
  };
}

export interface CreateDevFeedbackSubmissionOptions {
  request: string;
  element: Element;
  selector: string;
  screenshots?: DevFeedbackScreenshotData;
  boundingRect?: SerializableDOMRect;
  browserWindow?: Window;
}

export function createDevFeedbackSubmission({
  request,
  element,
  selector,
  screenshots = { full: null, target: null },
  boundingRect,
  browserWindow,
}: CreateDevFeedbackSubmissionOptions): DevFeedbackSubmission {
  const source = findSourceInfo(element);

  return {
    request: request.trim(),
    page: createPageMetadata(browserWindow),
    target: createTargetMetadata(element, selector, boundingRect),
    ...(source ? { source } : {}),
    screenshots,
  };
}
