import type {
  DevFeedbackCaptureResult,
  SerializableDOMRect,
} from "./types.js";

const DEFAULT_CROP_PADDING = 30;
const MAX_CANVAS_SCALE = 2;
const CAPTURE_ANNOTATION_ATTRIBUTE = "data-dev-feedback-capture-annotation";

export interface CaptureFeedbackScreenshotsOptions {
  cropPadding?: number;
  label?: string;
}

function requireBrowserEnvironment(): { document: Document; window: Window } {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new Error("Screenshots can only be captured in a browser.");
  }

  return { document, window };
}

function createCaptureAnnotation(
  target: Element,
  targetRect: DOMRect,
  labelText: string,
  captureDocument: Document,
): HTMLElement {
  const annotation = captureDocument.createElement("div");
  annotation.setAttribute(CAPTURE_ANNOTATION_ATTRIBUTE, "true");
  annotation.setAttribute("aria-hidden", "true");
  Object.assign(annotation.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "2147483646",
  });

  const highlight = captureDocument.createElement("div");
  Object.assign(highlight.style, {
    position: "fixed",
    left: `${targetRect.left}px`,
    top: `${targetRect.top}px`,
    width: `${targetRect.width}px`,
    height: `${targetRect.height}px`,
    boxSizing: "border-box",
    border: "3px solid #f43f5e",
    background: "rgba(244, 63, 94, 0.18)",
    boxShadow: "0 0 0 1px rgba(255, 255, 255, 0.9)",
  });

  const label = captureDocument.createElement("div");
  const viewportWidth = captureDocument.defaultView?.innerWidth ?? 0;
  const viewportHeight = captureDocument.defaultView?.innerHeight ?? 0;
  const labelLeft = Math.max(4, Math.min(targetRect.left, viewportWidth - 180));
  const labelTop =
    targetRect.top >= 34
      ? targetRect.top - 30
      : Math.min(targetRect.bottom + 4, viewportHeight - 28);
  Object.assign(label.style, {
    position: "fixed",
    left: `${labelLeft}px`,
    top: `${Math.max(4, labelTop)}px`,
    maxWidth: "260px",
    padding: "4px 8px",
    borderRadius: "5px",
    color: "#ffffff",
    background: "#e11d48",
    font: "600 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.3)",
  });
  label.textContent = labelText || `1 · ${target.tagName.toLowerCase()}`;

  annotation.append(highlight, label);
  return annotation;
}

function isFeedbackToolElement(element: Element): boolean {
  if (element.hasAttribute(CAPTURE_ANNOTATION_ATTRIBUTE)) {
    return false;
  }

  if (
    element.tagName.toLowerCase() === "iframe" ||
    element.hasAttribute("data-dev-feedback-root") ||
    element.hasAttribute("data-dev-feedback-ui")
  ) {
    return true;
  }

  const className = element.getAttribute("class") ?? "";
  return className.split(/\s+/).some((name) => name.startsWith("dev-feedback-"));
}

function serializeRect(rect: DOMRect): SerializableDOMRect {
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

function redactFormValuesInClone(clonedDocument: Document): void {
  for (const input of clonedDocument.querySelectorAll("input")) {
    input.value = "";
    input.removeAttribute("value");
  }

  for (const textarea of clonedDocument.querySelectorAll("textarea")) {
    textarea.value = "";
    textarea.textContent = "";
    textarea.removeAttribute("value");
  }
}

function getCaptureBackground(captureDocument: Document): string {
  const captureWindow = captureDocument.defaultView;
  if (!captureWindow) {
    return "#ffffff";
  }

  for (const element of [captureDocument.body, captureDocument.documentElement]) {
    const color = captureWindow.getComputedStyle(element).backgroundColor;
    if (color !== "transparent" && color !== "rgba(0, 0, 0, 0)") {
      return color;
    }
  }

  return "#ffffff";
}

function cropTargetCanvas(
  fullCanvas: HTMLCanvasElement,
  targetRect: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
  cropPadding: number,
  captureDocument: Document,
): HTMLCanvasElement {
  const left = Math.max(0, targetRect.left - cropPadding);
  const top = Math.max(0, targetRect.top - cropPadding);
  const right = Math.min(viewportWidth, targetRect.right + cropPadding);
  const bottom = Math.min(viewportHeight, targetRect.bottom + cropPadding);

  if (right <= left || bottom <= top) {
    throw new Error("The selected element is outside the current viewport.");
  }

  const scaleX = fullCanvas.width / viewportWidth;
  const scaleY = fullCanvas.height / viewportHeight;
  const sourceX = Math.floor(left * scaleX);
  const sourceY = Math.floor(top * scaleY);
  const sourceWidth = Math.max(1, Math.ceil((right - left) * scaleX));
  const sourceHeight = Math.max(1, Math.ceil((bottom - top) * scaleY));
  const targetCanvas = captureDocument.createElement("canvas");
  targetCanvas.width = sourceWidth;
  targetCanvas.height = sourceHeight;

  const context = targetCanvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create a canvas context for the target crop.");
  }

  context.drawImage(
    fullCanvas,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    sourceWidth,
    sourceHeight,
  );

  return targetCanvas;
}

/**
 * Captures the visible viewport and a padded crop around the target.
 * html2canvas-pro is loaded only when this function runs, keeping it out of the
 * initial client execution path. The maintained fork supports the modern CSS
 * color functions emitted by Tailwind CSS v4. Errors are deliberately
 * propagated so callers can continue saving textual metadata with null images.
 */
export async function captureFeedbackScreenshots(
  target: Element,
  options: CaptureFeedbackScreenshotsOptions = {},
): Promise<DevFeedbackCaptureResult> {
  const environment = requireBrowserEnvironment();
  let annotation: HTMLElement | null = null;

  try {
    const { default: html2canvas } = await import("html2canvas-pro");
    const targetRect = target.getBoundingClientRect();
    const viewportWidth = environment.window.innerWidth;
    const viewportHeight = environment.window.innerHeight;

    if (targetRect.width <= 0 || targetRect.height <= 0) {
      throw new Error(
        "The selected element does not have a visible capture area.",
      );
    }

    const cropPadding = Math.max(
      0,
      Math.min(100, options.cropPadding ?? DEFAULT_CROP_PADDING),
    );
    annotation = createCaptureAnnotation(
      target,
      targetRect,
      options.label ?? "",
      environment.document,
    );
    environment.document.body.append(annotation);

    const fullCanvas = await html2canvas(environment.document.documentElement, {
      allowTaint: false,
      backgroundColor: getCaptureBackground(environment.document),
      height: viewportHeight,
      ignoreElements: isFeedbackToolElement,
      logging: false,
      onclone: redactFormValuesInClone,
      removeContainer: true,
      scale: Math.min(
        MAX_CANVAS_SCALE,
        Math.max(1, environment.window.devicePixelRatio || 1),
      ),
      scrollX: environment.window.scrollX,
      scrollY: environment.window.scrollY,
      useCORS: true,
      width: viewportWidth,
      windowHeight: viewportHeight,
      windowWidth: viewportWidth,
      x: environment.window.scrollX,
      y: environment.window.scrollY,
    });

    const targetCanvas = cropTargetCanvas(
      fullCanvas,
      targetRect,
      viewportWidth,
      viewportHeight,
      cropPadding,
      environment.document,
    );

    return {
      full: fullCanvas.toDataURL("image/png"),
      target: targetCanvas.toDataURL("image/png"),
      boundingRect: serializeRect(targetRect),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown capture error";
    throw new Error(`Unable to capture the current viewport: ${message}`);
  } finally {
    annotation?.remove();
  }
}
