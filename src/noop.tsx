/**
 * Production-safe runtime entry.
 *
 * The package export map resolves this module for production and for tools
 * that do not explicitly opt in to the `development` condition. Keep this
 * file dependency-free so the feedback UI and Server Action cannot enter an
 * application production graph.
 */
export async function DevFeedbackCapture(): Promise<null> {
  return null;
}
