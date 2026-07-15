import type { CSSProperties } from "react";

import styles from "./dev-feedback.module.css";

export interface FeedbackRect {
  x: number;
  y: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

interface FeedbackOverlayProps {
  errorMessage?: string | null;
  label: string | null;
  mode: "selecting" | "selected";
  rect: FeedbackRect | null;
}

const VIEWPORT_GUTTER = 8;
const LABEL_HEIGHT = 30;

function getLabelStyle(rect: FeedbackRect): CSSProperties {
  const viewportWidth =
    typeof window === "undefined" ? rect.right : window.innerWidth;
  const viewportHeight =
    typeof window === "undefined" ? rect.bottom : window.innerHeight;
  const left = Math.min(
    Math.max(rect.left, VIEWPORT_GUTTER),
    Math.max(VIEWPORT_GUTTER, viewportWidth - 240),
  );
  const top =
    rect.top >= LABEL_HEIGHT + VIEWPORT_GUTTER
      ? rect.top - LABEL_HEIGHT - 4
      : Math.min(rect.bottom + 4, viewportHeight - LABEL_HEIGHT - VIEWPORT_GUTTER);

  return { left, top: Math.max(VIEWPORT_GUTTER, top) };
}

export function FeedbackOverlay({
  errorMessage = null,
  label,
  mode,
  rect,
}: FeedbackOverlayProps) {
  return (
    <>
      {mode === "selecting" ? (
        <>
          <div
            className={styles.devFeedbackCaptureSurface}
            data-dev-feedback-capture-surface=""
            aria-hidden="true"
          />
          <div
            className={`${styles.devFeedbackSelectionNotice} ${
              errorMessage ? styles.devFeedbackSelectionNoticeError : ""
            }`}
            role="status"
            aria-live="polite"
          >
            <span className={styles.devFeedbackSelectionDot} aria-hidden="true" />
            <span>
              {errorMessage ?? "개선할 요소를 선택하세요"}
              <small>
                {errorMessage ? "다른 요소를 선택해 주세요" : "취소하려면 ESC"}
              </small>
            </span>
          </div>
        </>
      ) : null}

      {rect ? (
        <>
          <div
            className={styles.devFeedbackHighlight}
            data-dev-feedback-highlight=""
            style={{
              left: rect.left,
              top: rect.top,
              width: Math.max(0, rect.width),
              height: Math.max(0, rect.height),
            }}
            aria-hidden="true"
          />
          {label ? (
            <div
              className={styles.devFeedbackTargetLabel}
              style={getLabelStyle(rect)}
              aria-hidden="true"
            >
              {label}
            </div>
          ) : null}
        </>
      ) : null}
    </>
  );
}
