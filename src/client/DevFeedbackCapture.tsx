"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";

import {
  GENERIC_SAVE_ERROR_MESSAGE,
  getSafeSaveFailureMessage,
  invokeSaveActionSafely,
  isActionBodySizeLimitError,
  shouldRetryWithoutScreenshots,
} from "../shared/action-error.js";
import { createDevFeedbackSubmission } from "../shared/metadata.js";
import { sanitizeElementTextContent } from "../shared/sanitize.js";
import { generateCssSelector } from "../shared/selector.js";
import type {
  DevFeedbackCaptureState,
  DevFeedbackSaveResponse,
  DevFeedbackScreenshotData,
  DevFeedbackSubmission,
  SerializableDOMRect,
} from "../shared/types.js";

import {
  FeedbackDialog,
  type FeedbackElementPreview,
} from "./FeedbackDialog.js";
import { FeedbackButton } from "./FeedbackButton.js";
import {
  FeedbackOverlay,
  type FeedbackRect,
} from "./FeedbackOverlay.js";
import styles from "./dev-feedback.module.css";

type CaptureStatus = DevFeedbackCaptureState;

const TOOL_ROOT_SELECTOR = "[data-dev-feedback-root]";
const CAPTURE_SURFACE_SELECTOR = "[data-dev-feedback-capture-surface]";
const DEVELOPMENT_TOOL_SELECTOR =
  "nextjs-portal, [data-nextjs-dev-overlay], [data-next-badge-root]";
const EMPTY_SCREENSHOTS: DevFeedbackScreenshotData = {
  full: null,
  target: null,
};
const MAX_ACTION_SUBMISSION_BYTES = 30 * 1024 * 1024;

function serializeRect(rect: DOMRect): FeedbackRect {
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

function isSelectableElement(element: Element | null): element is Element {
  if (!element || element === document.documentElement || element === document.body) {
    return false;
  }

  return !element.closest(
    `${TOOL_ROOT_SELECTOR}, ${DEVELOPMENT_TOOL_SELECTOR}`,
  );
}

function findSelectableElementAtPoint(clientX: number, clientY: number) {
  const captureSurfaces = Array.from(
    document.querySelectorAll<HTMLElement>(CAPTURE_SURFACE_SELECTOR),
  );
  const previousPointerEvents = captureSurfaces.map(
    (surface) => surface.style.pointerEvents,
  );

  try {
    // The full-screen capture surface must receive the real pointer events, but
    // it must not participate in this hit test. Some browsers only return the
    // top overlay (plus html/body) from elementsFromPoint(), which otherwise
    // makes every page element appear unselectable.
    captureSurfaces.forEach((surface) => {
      surface.style.pointerEvents = "none";
    });

    const element = document.elementFromPoint(clientX, clientY);
    return isSelectableElement(element) ? element : null;
  } finally {
    captureSurfaces.forEach((surface, index) => {
      surface.style.pointerEvents = previousPointerEvents[index] ?? "";
    });
  }
}

function getEventElement(event: Event) {
  const target = event.target;
  if (
    target instanceof Element &&
    target.matches(CAPTURE_SURFACE_SELECTOR) &&
    "clientX" in event &&
    "clientY" in event
  ) {
    return findSelectableElementAtPoint(
      Number(event.clientX),
      Number(event.clientY),
    );
  }

  return target instanceof Element && isSelectableElement(target) ? target : null;
}

function getElementLabel(element: Element) {
  const tagName = element.tagName.toLowerCase();
  const id = element.getAttribute("id")?.trim();
  const classes = (element.getAttribute("class") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((className) => `.${className}`)
    .join("");
  const label = `${tagName}${id ? `#${id}` : ""}${classes}`;

  return label.length > 90 ? `${label.slice(0, 87)}…` : label;
}

function getPreviewText(element: Element) {
  const text = (sanitizeElementTextContent(element) ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function createPreview(element: Element, selector: string): FeedbackElementPreview {
  return {
    tagName: element.tagName.toLowerCase(),
    selector,
    id: element.getAttribute("id") || undefined,
    className: element.getAttribute("class") || undefined,
    text: getPreviewText(element),
    rect: serializeRect(element.getBoundingClientRect()),
  };
}

function stopPageInteraction(event: Event) {
  if (event.cancelable) {
    event.preventDefault();
  }
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function stopPagePropagation(event: Event) {
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function getSubmissionSize(submission: DevFeedbackSubmission): number {
  return new TextEncoder().encode(JSON.stringify(submission)).byteLength;
}

export interface DevFeedbackCaptureClientProps {
  metadataOnly?: boolean;
  saveFeedbackAction: (
    submission: DevFeedbackSubmission,
  ) => Promise<DevFeedbackSaveResponse>;
}

export function DevFeedbackCaptureClient({
  metadataOnly = false,
  saveFeedbackAction,
}: DevFeedbackCaptureClientProps) {
  const [status, setStatus] = useState<CaptureStatus>("idle");
  const [hoverRect, setHoverRect] = useState<FeedbackRect | null>(null);
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);
  const [preview, setPreview] = useState<FeedbackElementPreview | null>(null);
  const [request, setRequest] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [screenshotWarning, setScreenshotWarning] = useState<string | null>(
    null,
  );
  const [successDirectory, setSuccessDirectory] = useState<string | null>(null);
  const hoveredElementRef = useRef<Element | null>(null);
  const selectedElementRef = useRef<Element | null>(null);
  const selectedSelectorRef = useRef("");
  const animationFrameRef = useRef<number | null>(null);
  const saveInFlightRef = useRef(false);
  const [, startActionTransition] = useTransition();

  const invokeSaveAction = useCallback(
    (submission: DevFeedbackSubmission) =>
      new Promise<DevFeedbackSaveResponse>((resolve, reject) => {
        startActionTransition(() => {
          void invokeSaveActionSafely(saveFeedbackAction, submission).then(
            resolve,
            reject,
          );
        });
      }),
    [saveFeedbackAction],
  );

  const reset = useCallback(() => {
    if (saveInFlightRef.current) {
      return;
    }
    hoveredElementRef.current = null;
    selectedElementRef.current = null;
    selectedSelectorRef.current = "";
    setHoverRect(null);
    setHoverLabel(null);
    setPreview(null);
    setRequest("");
    setErrorMessage(null);
    setScreenshotWarning(null);
    setSuccessDirectory(null);
    setStatus("idle");
  }, []);

  const startSelecting = useCallback(() => {
    hoveredElementRef.current = null;
    selectedElementRef.current = null;
    selectedSelectorRef.current = "";
    setHoverRect(null);
    setHoverLabel(null);
    setPreview(null);
    setRequest("");
    setErrorMessage(null);
    setScreenshotWarning(null);
    setSuccessDirectory(null);
    setStatus("selecting");
  }, []);

  useEffect(() => {
    if (status !== "selecting") {
      return;
    }

    const previousHtmlCursor = document.documentElement.style.cursor;
    const previousBodyCursor = document.body.style.cursor;
    document.documentElement.style.cursor = "crosshair";
    document.body.style.cursor = "crosshair";

    const updateHover = (element: Element | null) => {
      hoveredElementRef.current = element;
      if (!element || !element.isConnected) {
        setHoverRect(null);
        setHoverLabel(null);
        return;
      }
      setHoverRect(serializeRect(element.getBoundingClientRect()));
      setHoverLabel(getElementLabel(element));
    };

    const scheduleHoverUpdate = (element: Element | null) => {
      hoveredElementRef.current = element;
      if (animationFrameRef.current !== null) {
        return;
      }
      animationFrameRef.current = window.requestAnimationFrame(() => {
        animationFrameRef.current = null;
        updateHover(hoveredElementRef.current);
      });
    };

    const handleMove = (event: Event) => {
      const element = getEventElement(event);
      stopPageInteraction(event);
      scheduleHoverUpdate(element);
    };

    const handlePointerSequence = (event: Event) => {
      // The capture surface is the event target, so the underlying link/button
      // cannot run. Do not prevent the pointer sequence's default here: on some
      // browsers cancelling pointerdown suppresses the click event that commits
      // the selection. The click handler below still prevents all defaults.
      stopPagePropagation(event);
    };

    const handleBlockedInteraction = (event: Event) => {
      stopPageInteraction(event);
    };

    const handleWheel = (event: Event) => {
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const handleClick = (event: MouseEvent) => {
      const element = getEventElement(event) ?? hoveredElementRef.current;
      stopPageInteraction(event);
      if (!isSelectableElement(element)) {
        return;
      }

      let selector: string;
      try {
        selector = generateCssSelector(element);
        const matches = document.querySelectorAll(selector);
        if (matches.length !== 1 || matches[0] !== element) {
          throw new Error("The generated selector is not unique.");
        }
      } catch {
        setErrorMessage(
          "이 요소를 다시 찾을 고유한 selector를 만들 수 없습니다.",
        );
        return;
      }

      selectedElementRef.current = element;
      selectedSelectorRef.current = selector;
      const nextPreview = createPreview(element, selector);
      setPreview(nextPreview);
      setHoverRect(nextPreview.rect);
      setHoverLabel(getElementLabel(element));
      setStatus("selected");
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      stopPageInteraction(event);
      reset();
    };

    const handleGeometryChange = () => {
      scheduleHoverUpdate(hoveredElementRef.current);
    };

    document.addEventListener("pointermove", handleMove, {
      capture: true,
      passive: false,
    });
    document.addEventListener("mousemove", handleMove, {
      capture: true,
      passive: false,
    });
    document.addEventListener("pointerdown", handlePointerSequence, true);
    document.addEventListener("mousedown", handlePointerSequence, true);
    document.addEventListener("pointerup", handlePointerSequence, true);
    document.addEventListener("mouseup", handlePointerSequence, true);
    document.addEventListener("click", handleClick, true);
    document.addEventListener("auxclick", handleBlockedInteraction, true);
    document.addEventListener("contextmenu", handleBlockedInteraction, true);
    document.addEventListener("dragstart", handleBlockedInteraction, true);
    document.addEventListener("wheel", handleWheel, { capture: true, passive: true });
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleGeometryChange, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", handleGeometryChange, { passive: true });

    return () => {
      document.documentElement.style.cursor = previousHtmlCursor;
      document.body.style.cursor = previousBodyCursor;
      document.removeEventListener("pointermove", handleMove, true);
      document.removeEventListener("mousemove", handleMove, true);
      document.removeEventListener("pointerdown", handlePointerSequence, true);
      document.removeEventListener("mousedown", handlePointerSequence, true);
      document.removeEventListener("pointerup", handlePointerSequence, true);
      document.removeEventListener("mouseup", handlePointerSequence, true);
      document.removeEventListener("click", handleClick, true);
      document.removeEventListener("auxclick", handleBlockedInteraction, true);
      document.removeEventListener("contextmenu", handleBlockedInteraction, true);
      document.removeEventListener("dragstart", handleBlockedInteraction, true);
      document.removeEventListener("wheel", handleWheel, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleGeometryChange, true);
      window.removeEventListener("resize", handleGeometryChange);
      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [reset, status]);

  useEffect(() => {
    if (
      status === "idle" ||
      status === "selecting" ||
      !selectedElementRef.current
    ) {
      return;
    }

    const updateSelectedGeometry = () => {
      const element = selectedElementRef.current;
      if (!element?.isConnected) {
        return;
      }
      const rect = serializeRect(element.getBoundingClientRect());
      setHoverRect(rect);
      setPreview((current) => (current ? { ...current, rect } : current));
    };

    window.addEventListener("scroll", updateSelectedGeometry, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", updateSelectedGeometry, { passive: true });

    return () => {
      window.removeEventListener("scroll", updateSelectedGeometry, true);
      window.removeEventListener("resize", updateSelectedGeometry);
    };
  }, [status]);

  const saveFeedback = useCallback(async () => {
    const element = selectedElementRef.current;
    const selector = selectedSelectorRef.current;
    const trimmedRequest = request.trim();
    if (
      !element ||
      !selector ||
      !trimmedRequest ||
      saveInFlightRef.current
    ) {
      return;
    }

    saveInFlightRef.current = true;
    setErrorMessage(null);
    setScreenshotWarning(null);
    setStatus("capturing");

    let screenshots = EMPTY_SCREENSHOTS;
    let capturedRect: SerializableDOMRect | undefined;
    let captureWarning: string | null = null;
    if (metadataOnly) {
      captureWarning =
        "메타데이터 전용 모드로 스크린샷 없이 저장합니다.";
    } else {
      try {
        await waitForPaint();
        const { captureFeedbackScreenshots } = await import(
          "../shared/screenshot.js"
        );
        const captureResult = await captureFeedbackScreenshots(element);
        screenshots = {
          full: captureResult.full,
          target: captureResult.target,
        };
        capturedRect = captureResult.boundingRect;
        if (!screenshots.full || !screenshots.target) {
          captureWarning =
            "일부 스크린샷을 만들지 못했습니다. 텍스트 메타데이터는 정상적으로 저장됩니다.";
        }
      } catch (error) {
        console.warn("[dev-feedback] Screenshot capture failed", error);
        screenshots = EMPTY_SCREENSHOTS;
        captureWarning =
          "스크린샷 캡처에 실패했습니다. 텍스트 메타데이터만 저장합니다.";
      }
    }

    setScreenshotWarning(captureWarning);
    setStatus("saving");

    try {
      let submission = createDevFeedbackSubmission({
        request: trimmedRequest,
        element,
        selector,
        screenshots,
        boundingRect: capturedRect,
      });
      if (
        (submission.screenshots.full || submission.screenshots.target) &&
        getSubmissionSize(submission) > MAX_ACTION_SUBMISSION_BYTES
      ) {
        setScreenshotWarning(
          "스크린샷 용량이 너무 커서 텍스트 메타데이터만 저장했습니다.",
        );
        submission = { ...submission, screenshots: EMPTY_SCREENSHOTS };
      }

      let responseBody: DevFeedbackSaveResponse;
      try {
        responseBody = await invokeSaveAction(submission);
      } catch (error) {
        if (
          !isActionBodySizeLimitError(error) ||
          (!submission.screenshots.full && !submission.screenshots.target)
        ) {
          throw error;
        }

        setScreenshotWarning(
          "Server Action 요청 한도를 초과해 텍스트 메타데이터만 저장했습니다.",
        );
        responseBody = await invokeSaveAction({
          ...submission,
          screenshots: EMPTY_SCREENSHOTS,
        });
        submission = { ...submission, screenshots: EMPTY_SCREENSHOTS };
      }

      if (
        !responseBody.success &&
        shouldRetryWithoutScreenshots(
          responseBody,
          Boolean(
            submission.screenshots.full || submission.screenshots.target,
          ),
        )
      ) {
        setScreenshotWarning(
          responseBody.code === "PAYLOAD_TOO_LARGE"
            ? "스크린샷 용량이 너무 커서 텍스트 메타데이터만 저장했습니다."
            : "스크린샷 형식을 저장할 수 없어 텍스트 메타데이터만 저장했습니다.",
        );
        responseBody = await invokeSaveAction({
          ...submission,
          screenshots: EMPTY_SCREENSHOTS,
        });
      }

      if (!responseBody.success) {
        setErrorMessage(getSafeSaveFailureMessage(responseBody));
        setStatus("error");
        return;
      }

      setSuccessDirectory(responseBody.directory);
      setStatus("success");
    } catch {
      setErrorMessage(GENERIC_SAVE_ERROR_MESSAGE);
      setStatus("error");
    } finally {
      saveInFlightRef.current = false;
    }
  }, [invokeSaveAction, metadataOnly, request]);

  const dialogStatus =
    status === "selected" ||
    status === "capturing" ||
    status === "saving" ||
    status === "success" ||
    status === "error"
      ? status
      : null;

  return (
    <div
      className={styles.devFeedbackRoot}
      data-dev-feedback-root=""
      data-dev-feedback-status={status}
    >
      {status === "idle" ? (
        <FeedbackButton onClick={startSelecting} />
      ) : null}

      {status === "selecting" ? (
        <FeedbackOverlay
          mode="selecting"
          rect={hoverRect}
          label={hoverLabel}
          errorMessage={errorMessage}
        />
      ) : null}

      {dialogStatus && preview ? (
        <>
          <FeedbackOverlay mode="selected" rect={hoverRect} label={hoverLabel} />
          <FeedbackDialog
            request={request}
            preview={preview}
            status={dialogStatus}
            errorMessage={errorMessage}
            screenshotWarning={screenshotWarning}
            successDirectory={successDirectory}
            onRequestChange={setRequest}
            onSubmit={saveFeedback}
            onCancel={reset}
          />
        </>
      ) : null}
    </div>
  );
}
