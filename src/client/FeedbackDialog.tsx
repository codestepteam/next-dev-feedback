import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
} from "react";

import type { FeedbackRect } from "./FeedbackOverlay.js";
import styles from "./dev-feedback.module.css";

export type FeedbackDialogStatus =
  | "selected"
  | "capturing"
  | "saving"
  | "success"
  | "error";

export interface FeedbackElementPreview {
  className?: string;
  id?: string;
  rect: FeedbackRect;
  selector: string;
  tagName: string;
  text: string;
}

interface FeedbackDialogProps {
  errorMessage: string | null;
  onCancel: () => void;
  onRequestChange: (value: string) => void;
  onSubmit: () => void;
  preview: FeedbackElementPreview;
  request: string;
  screenshotWarning: string | null;
  status: FeedbackDialogStatus;
  successDirectory: string | null;
}

function formatNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function FeedbackDialog({
  errorMessage,
  onCancel,
  onRequestChange,
  onSubmit,
  preview,
  request,
  screenshotWarning,
  status,
  successDirectory,
}: FeedbackDialogProps) {
  const panelRef = useRef<HTMLElement>(null);
  const requestInputRef = useRef<HTMLTextAreaElement>(null);
  const isBusy = status === "capturing" || status === "saving";
  const isSuccess = status === "success";

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const frame = window.requestAnimationFrame(() => {
      requestInputRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(frame);
      if (previouslyFocused instanceof HTMLElement) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isBusy && !isSuccess && request.trim()) {
      onSubmit();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !isBusy) {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) {
      return;
    }

    const first = focusable.item(0);
    const last = focusable.item(focusable.length - 1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className={styles.devFeedbackDialogLayer}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !isBusy) {
          onCancel();
        }
      }}
    >
      <aside
        ref={panelRef}
        className={styles.devFeedbackDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dev-feedback-dialog-title"
        aria-describedby={
          isSuccess ? undefined : "dev-feedback-dialog-description"
        }
        onKeyDown={handleKeyDown}
      >
        <header className={styles.devFeedbackDialogHeader}>
          <div>
            <p className={styles.devFeedbackEyebrow}>Development feedback</p>
            <h2 id="dev-feedback-dialog-title">
              {isSuccess ? "피드백을 저장했습니다" : "UI 개선 요청"}
            </h2>
          </div>
          <button
            type="button"
            className={styles.devFeedbackIconButton}
            onClick={onCancel}
            disabled={isBusy}
            aria-label="피드백 패널 닫기"
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>

        {isSuccess ? (
          <div className={styles.devFeedbackSuccess} role="status">
            <span className={styles.devFeedbackSuccessIcon} aria-hidden="true">
              ✓
            </span>
            <div>
              <strong>프로젝트에 안전하게 저장되었습니다.</strong>
              <p>
                먼저 summary.json을 확인하고, 상세 DOM 정보가 필요할 때만
                metadata.json을 여세요.
              </p>
            </div>
            {successDirectory ? (
              <code className={styles.devFeedbackDirectory}>
                {successDirectory}
              </code>
            ) : null}
            {screenshotWarning ? (
              <p className={styles.devFeedbackWarning}>{screenshotWarning}</p>
            ) : null}
            <button
              type="button"
              className={styles.devFeedbackPrimaryButton}
              onClick={onCancel}
            >
              닫기
            </button>
          </div>
        ) : (
          <form className={styles.devFeedbackForm} onSubmit={handleSubmit}>
            <p
              id="dev-feedback-dialog-description"
              className={styles.devFeedbackDialogIntro}
            >
              선택한 요소와 현재 화면을 함께 기록합니다. 비밀번호와 입력 필드의
              현재 값은 저장하지 않습니다.
            </p>

            <section
              className={styles.devFeedbackPreview}
              aria-labelledby="dev-feedback-preview-title"
            >
              <div className={styles.devFeedbackSectionHeading}>
                <h3 id="dev-feedback-preview-title">선택한 요소</h3>
                <span className={styles.devFeedbackTag}>{preview.tagName}</span>
              </div>
              <dl className={styles.devFeedbackDefinitionList}>
                <div>
                  <dt>Selector</dt>
                  <dd>
                    <code title={preview.selector}>{preview.selector}</code>
                  </dd>
                </div>
                <div>
                  <dt>Text</dt>
                  <dd>{preview.text || "텍스트 없음"}</dd>
                </div>
                <div>
                  <dt>Position</dt>
                  <dd>
                    x {formatNumber(preview.rect.x)} · y{" "}
                    {formatNumber(preview.rect.y)} · {formatNumber(preview.rect.width)} ×{" "}
                    {formatNumber(preview.rect.height)}
                  </dd>
                </div>
              </dl>
            </section>

            <label className={styles.devFeedbackField}>
              <span>
                사용자 요청 <b aria-hidden="true">*</b>
              </span>
              <textarea
                ref={requestInputRef}
                value={request}
                rows={6}
                maxLength={10_000}
                onChange={(event) => onRequestChange(event.target.value)}
                placeholder="예: 이 테이블 헤더를 페이지 스크롤 중에도 상단에 고정해 주세요."
                required
                disabled={isBusy}
              />
            </label>

            {status === "capturing" ? (
              <p className={styles.devFeedbackProgress} role="status">
                <span aria-hidden="true" /> 화면을 캡처하고 있습니다…
              </p>
            ) : null}
            {status === "saving" ? (
              <p className={styles.devFeedbackProgress} role="status">
                <span aria-hidden="true" /> 프로젝트에 저장하고 있습니다…
              </p>
            ) : null}
            {screenshotWarning ? (
              <p className={styles.devFeedbackWarning} role="status">
                {screenshotWarning}
              </p>
            ) : null}
            {status === "error" && errorMessage ? (
              <p className={styles.devFeedbackError} role="alert">
                {errorMessage}
              </p>
            ) : null}

            <footer className={styles.devFeedbackDialogActions}>
              <button
                type="button"
                className={styles.devFeedbackSecondaryButton}
                onClick={onCancel}
                disabled={isBusy}
              >
                취소
              </button>
              <button
                type="submit"
                className={styles.devFeedbackPrimaryButton}
                disabled={isBusy || !request.trim()}
              >
                {status === "capturing"
                  ? "캡처 중…"
                  : status === "saving"
                    ? "저장 중…"
                    : status === "error"
                      ? "다시 저장"
                      : "피드백 저장"}
              </button>
            </footer>
          </form>
        )}
      </aside>
    </div>
  );
}
