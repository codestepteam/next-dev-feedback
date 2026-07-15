import assert from "node:assert/strict";
import test from "node:test";

import { saveDevFeedbackAction } from "../src/server/save-feedback-action.ts";

async function withEnvironment(values, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("Server Action is unavailable outside development", async () => {
  const response = await withEnvironment(
    { NODE_ENV: "production", NEXT_RUNTIME: undefined },
    () => saveDevFeedbackAction({}),
  );

  assert.deepEqual(response, {
    success: false,
    code: "UNAVAILABLE",
    error: "Not found",
  });
});

test("Server Action rejects Edge runtime without exposing internals", async () => {
  const response = await withEnvironment(
    { NODE_ENV: "development", NEXT_RUNTIME: "edge" },
    () => saveDevFeedbackAction({}),
  );

  assert.equal(response.success, false);
  assert.equal(response.code, "UNSUPPORTED_RUNTIME");
  assert.doesNotMatch(response.error, /Users|node:fs|\.feedback/);
});

test("Server Action validates input and enforces its own 30MiB limit", async () => {
  const invalidResponse = await withEnvironment(
    { NODE_ENV: "development", NEXT_RUNTIME: "nodejs" },
    () => saveDevFeedbackAction({}),
  );
  assert.equal(invalidResponse.success, false);
  assert.equal(invalidResponse.code, "INVALID_PAYLOAD");

  const largeResponse = await withEnvironment(
    { NODE_ENV: "development", NEXT_RUNTIME: "nodejs" },
    () =>
      saveDevFeedbackAction({
        padding: "x".repeat(30 * 1024 * 1024),
      }),
  );
  assert.equal(largeResponse.success, false);
  assert.equal(largeResponse.code, "PAYLOAD_TOO_LARGE");
});
