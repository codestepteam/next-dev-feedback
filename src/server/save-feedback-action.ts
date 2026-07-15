"use server";

import { Buffer } from "node:buffer";

import type { DevFeedbackSaveResponse } from "../shared/types.js";
import {
  FeedbackPayloadTooLargeError,
  FeedbackValidationError,
  MAX_REQUEST_BYTES,
  saveDevFeedback,
  validateFeedbackSubmission,
} from "./persistence.js";

function getSerializedSize(input: unknown): number {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new FeedbackValidationError("Feedback must be serializable");
  }

  if (serialized === undefined) {
    throw new FeedbackValidationError("Feedback must be serializable");
  }

  return Buffer.byteLength(serialized, "utf8");
}

/** Development-only Server Action used by the client capture surface. */
export async function saveDevFeedbackAction(
  input: unknown,
): Promise<DevFeedbackSaveResponse> {
  if (process.env.NODE_ENV !== "development") {
    return { success: false, code: "UNAVAILABLE", error: "Not found" };
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    return {
      success: false,
      code: "UNSUPPORTED_RUNTIME",
      error: "Dev feedback requires the Node.js runtime",
    };
  }

  try {
    if (getSerializedSize(input) > MAX_REQUEST_BYTES) {
      throw new FeedbackPayloadTooLargeError();
    }

    const submission = validateFeedbackSubmission(input);
    const saved = await saveDevFeedback(submission);
    return { success: true, ...saved };
  } catch (error) {
    if (error instanceof FeedbackPayloadTooLargeError) {
      return {
        success: false,
        code: "PAYLOAD_TOO_LARGE",
        error: "Feedback payload is too large",
      };
    }
    if (error instanceof FeedbackValidationError) {
      return {
        success: false,
        code: "INVALID_PAYLOAD",
        error: "Invalid feedback payload",
      };
    }

    // Keep absolute filesystem paths and implementation details on the server.
    console.error("[next-dev-feedback] Failed to save feedback", error);
    return {
      success: false,
      code: "SAVE_FAILED",
      error: "Failed to save feedback",
    };
  }
}
