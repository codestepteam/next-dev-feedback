export type DevFeedbackCaptureState =
  | "idle"
  | "selecting"
  | "selected"
  | "capturing"
  | "saving"
  | "success"
  | "error";

export interface SerializableDOMRect {
  x: number;
  y: number;
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface DevFeedbackPage {
  url: string;
  pathname: string;
  search: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  userAgent: string;
}

export interface DevFeedbackTarget {
  selector: string;
  tagName: string;
  id?: string;
  className?: string;
  textContent?: string;
  outerHTML?: string;
  boundingRect: SerializableDOMRect;
  attributes: Record<string, string>;
}

export interface DevFeedbackSource {
  componentName?: string;
  filePath?: string;
  lineNumber?: number;
  columnNumber?: number;
}

/** Base64 PNG data URLs sent by the browser to the development-only API. */
export interface DevFeedbackScreenshotData {
  full: string | null;
  target: string | null;
}

/** Screenshot data plus the exact geometry used for annotation and cropping. */
export interface DevFeedbackCaptureResult extends DevFeedbackScreenshotData {
  boundingRect: SerializableDOMRect;
}

/** Relative file paths persisted in summary.json and metadata.json. */
export interface DevFeedbackScreenshotFiles {
  full: string | null;
  target: string | null;
}

export interface DevFeedbackSubmission {
  request: string;
  page: DevFeedbackPage;
  target: DevFeedbackTarget;
  source?: DevFeedbackSource;
  screenshots: DevFeedbackScreenshotData;
}

export interface DevFeedbackMetadata {
  id: string;
  createdAt: string;
  request: string;
  page: DevFeedbackPage;
  target: DevFeedbackTarget;
  source?: DevFeedbackSource;
  screenshots: DevFeedbackScreenshotFiles;
  status: "captured";
}

/** Token-efficient entry point. Read this before opening metadata.json. */
export interface DevFeedbackSummary {
  request: string;
  source?: DevFeedbackSource;
  page: Pick<DevFeedbackPage, "url" | "pathname">;
  target: Pick<DevFeedbackTarget, "selector" | "tagName" | "textContent">;
  detailFile: "metadata.json";
  screenshots: DevFeedbackScreenshotFiles;
}

export interface DevFeedbackSaveFiles {
  summary: "summary.json";
  metadata: "metadata.json";
  fullScreenshot: string | null;
  targetScreenshot: string | null;
}

export interface DevFeedbackSaveSuccess {
  success: true;
  id: string;
  directory: string;
  files: DevFeedbackSaveFiles;
}

export interface DevFeedbackSaveFailure {
  success: false;
  code:
    | "UNAVAILABLE"
    | "PAYLOAD_TOO_LARGE"
    | "INVALID_PAYLOAD"
    | "UNSUPPORTED_RUNTIME"
    | "SAVE_FAILED";
  error: string;
}

export type DevFeedbackSaveResponse =
  | DevFeedbackSaveSuccess
  | DevFeedbackSaveFailure;
