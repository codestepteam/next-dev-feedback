import assert from "node:assert/strict";
import test from "node:test";

import {
  GENERIC_SAVE_ERROR_MESSAGE,
  getSafeSaveFailureMessage,
  invokeSaveActionSafely,
  isActionBodySizeLimitError,
  shouldRetryWithoutScreenshots,
} from "../src/shared/action-error.ts";

test("recognizes Next.js Server Action body limit transport errors", () => {
  assert.equal(
    isActionBodySizeLimitError(new Error("Body exceeded 1 MB limit")),
    true,
  );
  assert.equal(
    isActionBodySizeLimitError(
      new Error(
        "To configure the body size limit, see serverActions#bodysizelimit",
      ),
    ),
    true,
  );
  assert.equal(isActionBodySizeLimitError(new Error("Failed to fetch")), false);
  assert.equal(isActionBodySizeLimitError("Body exceeded 1 MB limit"), false);
});

test("save action failures use fixed UI text instead of server details", () => {
  const serverDetail = "/Users/developer/private/.feedback failed";
  const message = getSafeSaveFailureMessage({
    success: false,
    code: "SAVE_FAILED",
    error: serverDetail,
  });

  assert.equal(message, GENERIC_SAVE_ERROR_MESSAGE);
  assert.doesNotMatch(message, /Users|private|\.feedback|failed/i);
  assert.match(
    getSafeSaveFailureMessage({
      success: false,
      code: "INVALID_PAYLOAD",
      error: "Invalid feedback payload at /private/path",
    }),
    /피드백 정보가 올바르지 않습니다/,
  );
});

test("save action invocation converts synchronous throws to rejections", async () => {
  const synchronousFailure = new Error("private transport detail");
  await assert.rejects(
    invokeSaveActionSafely(() => {
      throw synchronousFailure;
    }, undefined),
    (error) => error === synchronousFailure,
  );

  assert.equal(
    await invokeSaveActionSafely(async (value) => value + 1, 41),
    42,
  );
});

test("screenshot-specific typed failures allow one metadata-only retry", () => {
  for (const code of ["PAYLOAD_TOO_LARGE", "INVALID_PAYLOAD"]) {
    const failure = { success: false, code, error: "server detail" };
    assert.equal(shouldRetryWithoutScreenshots(failure, true), true);
    assert.equal(shouldRetryWithoutScreenshots(failure, false), false);
  }
  assert.equal(
    shouldRetryWithoutScreenshots(
      { success: false, code: "SAVE_FAILED", error: "server detail" },
      true,
    ),
    false,
  );
});
