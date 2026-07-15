import styles from "./dev-feedback.module.css";

interface FeedbackButtonProps {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function FeedbackButton({
  active = false,
  disabled = false,
  onClick,
}: FeedbackButtonProps) {
  return (
    <button
      type="button"
      className={styles.devFeedbackButton}
      aria-label="UI 피드백을 남길 요소 선택하기"
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
    >
      <svg
        className={styles.devFeedbackButtonIcon}
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path d="M12 3.75a8.25 8.25 0 0 0-6.47 13.37l-.78 3.13 3.13-.78A8.25 8.25 0 1 0 12 3.75Zm-3.25 7.5h6.5m-6.5 3h4" />
      </svg>
      <span>UI 피드백</span>
    </button>
  );
}
