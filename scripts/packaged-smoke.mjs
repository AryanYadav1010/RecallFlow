import { resolve } from "node:path";
if (process.platform !== "darwin")
  throw new Error(
    "This launcher targets the macOS package; set RECALLFLOW_EXECUTABLE and run scripts/smoke.mjs for other platforms.",
  );
process.env.RECALLFLOW_EXECUTABLE = resolve(
  `release/mac${process.arch === "arm64" ? "-arm64" : ""}/RecallFlow.app/Contents/MacOS/RecallFlow`,
);
await import("./smoke.mjs");
