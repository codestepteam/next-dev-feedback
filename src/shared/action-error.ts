import type { DevFeedbackSaveFailure } from "./types.js";

export const GENERIC_SAVE_ERROR_MESSAGE =
  "피드백을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.";

/** Matches Next.js Server Action transport errors caused by bodySizeLimit. */
export function isActionBodySizeLimitError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    /body exceeded .+ limit/i.test(error.message) ||
    /serverActions#bodysizelimit/i.test(error.message)
  );
}

/** Converts synchronous throws and asynchronous failures to one Promise path. */
export function invokeSaveActionSafely<TInput, TResult>(
  action: (input: TInput) => Promise<TResult>,
  input: TInput,
): Promise<TResult> {
  try {
    return Promise.resolve(action(input));
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Maps typed server failures to fixed text without exposing server messages. */
export function getSafeSaveFailureMessage(
  failure: DevFeedbackSaveFailure,
): string {
  switch (failure.code) {
    case "UNAVAILABLE":
      return "UI 피드백은 개발 환경에서만 저장할 수 있습니다.";
    case "PAYLOAD_TOO_LARGE":
      return "피드백 데이터가 너무 큽니다. 스크린샷 없이 다시 시도해 주세요.";
    case "INVALID_PAYLOAD":
      return "피드백 정보가 올바르지 않습니다. 요소를 다시 선택해 주세요.";
    case "UNSUPPORTED_RUNTIME":
      return "UI 피드백 저장에는 Node.js 실행 환경이 필요합니다.";
    case "SAVE_FAILED":
      return GENERIC_SAVE_ERROR_MESSAGE;
  }
}

/** Screenshot validation/size failures may be retried without image data. */
export function shouldRetryWithoutScreenshots(
  failure: DevFeedbackSaveFailure,
  hasScreenshots: boolean,
): boolean {
  return (
    hasScreenshots &&
    (failure.code === "PAYLOAD_TOO_LARGE" ||
      failure.code === "INVALID_PAYLOAD")
  );
}
