import "server-only";

export interface DevFeedbackCaptureProps {
  /** Skip image capture so Next.js can keep its default 1MB Action limit. */
  metadataOnly?: boolean;
}

/**
 * Server Component entry point. The browser UI and filesystem Action are only
 * loaded while Next.js is running in development mode.
 */
export async function DevFeedbackCapture({
  metadataOnly = false,
}: DevFeedbackCaptureProps = {}) {
  if (process.env.NODE_ENV !== "development") {
    return null;
  }

  const [{ DevFeedbackCaptureClient }, { saveDevFeedbackAction }] =
    await Promise.all([
      import("./client/DevFeedbackCapture.js"),
      import("./server/save-feedback-action.js"),
    ]);

  return (
    <DevFeedbackCaptureClient
      metadataOnly={metadataOnly}
      saveFeedbackAction={saveDevFeedbackAction}
    />
  );
}

export type {
  DevFeedbackMetadata,
  DevFeedbackSaveResponse,
  DevFeedbackSubmission,
  DevFeedbackSummary,
} from "./shared/types.js";
