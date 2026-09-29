import { _electron as electron } from "playwright-core";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const directory = await mkdtemp(join(tmpdir(), "recallflow-desktop-test-"));
await mkdir("artifacts", { recursive: true });
let app;
const launch = async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    ...(process.env.RECALLFLOW_EXECUTABLE
      ? { executablePath: process.env.RECALLFLOW_EXECUTABLE }
      : {}),
    args: [
      ...(process.env.RECALLFLOW_EXECUTABLE ? [] : ["."]),
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
    env: {
      ...env,
      APP_MODE: process.env.APP_MODE === "database" ? "database" : "local",
      AI_PROVIDER: "mock",
      TRANSCRIPTION_PROVIDER: "mock",
      RECALLFLOW_DATA_DIR: directory,
      VITE_DEV_SERVER_URL: "",
    },
  });
  app.process().stderr.on("data", (data) => process.stderr.write(data));
  const page = await app.firstWindow();
  page.on("pageerror", (error) =>
    console.error("Renderer error:", error.message),
  );
  await page.getByRole("heading", { name: "A little more present." }).waitFor();
  return page;
};
try {
  let page = await launch();
  await page.screenshot({ path: resolve("artifacts/dashboard.png") });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "AI configuration" }).waitFor();
  await page.getByText("Provider status").waitFor();
  await page.getByText("Local Whisper", { exact: true }).first().waitFor();
  await page.screenshot({
    path: resolve("artifacts/settings-ai.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: /^Meetings/ }).click();
  await page.getByRole("button", { name: "Create your first meeting" }).click();
  await page.getByLabel("Meeting title").fill("Tomorrow test");
  await page
    .getByRole("button", { name: "Create meeting", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Tomorrow test", exact: true })
    .waitFor();
  const notes = page.getByRole("textbox", { name: "My Notes", exact: true });
  await notes.fill(
    "★ Keep the onboarding simple.\nConfirm analytics ownership.",
  );
  await page.getByText("All changes saved", { exact: true }).waitFor();
  const floatingWindow = app.waitForEvent("window", {
    predicate: (p) => p.url().includes("floating.html"),
    timeout: 20000,
  });
  await page
    .getByRole("button", { name: "Start Meeting", exact: true })
    .click();
  // The floating controls appear, and the full window steps aside once the
  // microphone is confirmed (compact mode is on by default).
  const floating = await floatingWindow;
  await floating.getByLabel("Microphone On").waitFor({ timeout: 20000 });
  await floating.getByLabel("Elapsed time").waitFor();
  const windows = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => ({
        floating: w.webContents.getURL().includes("floating.html"),
        visible: w.isVisible(),
        minimized: w.isMinimized(),
        onTop: w.isAlwaysOnTop(),
        bounds: w.getBounds(),
      })),
    );
  for (let i = 0; i < 50; i++) {
    if (!(await windows()).find((w) => !w.floating).visible) break;
    await page.waitForTimeout(100);
  }
  const during = await windows();
  const main = during.find((w) => !w.floating);
  const controls = during.find((w) => w.floating);
  assert.equal(main.visible, false, "main window steps aside on start");
  assert.equal(controls.visible, true);
  assert.equal(controls.onTop, true);
  assert.ok(controls.bounds.width <= 240 && controls.bounds.height <= 60);
  // The full window is hidden now; the meeting must keep recording.
  await floating.screenshot({
    path: resolve("artifacts/floating-collapsed.png"),
  });
  await page.waitForTimeout(16000);
  const live = await page.evaluate(
    async () => (await window.recallflow.list())[0],
  );
  assert.equal(live.status, "recording");
  assert.ok(live.segments.length >= 2, "transcript grows while hidden");
  await floating
    .getByRole("button", { name: "Expand meeting controls" })
    .click();
  await floating.getByText("Transcription").waitFor();
  await floating.getByRole("button", { name: "Quick note" }).click();
  await floating
    .getByRole("textbox", { name: "Quick note" })
    .fill("Follow up on pricing");
  await floating.getByRole("button", { name: "Add note" }).click();
  await floating.getByText("Added to My Notes").waitFor();
  await floating.screenshot({
    path: resolve("artifacts/floating-expanded.png"),
  });
  for (let i = 0; i < 50; i++) {
    const current = await page.evaluate(
      async () => (await window.recallflow.list())[0].notes,
    );
    if (current.includes("• Follow up on pricing")) break;
    await page.waitForTimeout(100);
  }
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(
      (w) => !w.webContents.getURL().includes("floating.html"),
    );
    w.restore();
    w.show();
  });
  assert.equal(
    await page
      .getByRole("button", { name: "Settings", exact: true })
      .isEnabled(),
    false,
  );
  await page.screenshot({ path: resolve("artifacts/live-meeting.png") });
  // Stop from the floating window: two clicks guard against a stray click.
  await floating.getByRole("button", { name: "Stop meeting" }).click();
  await floating.getByRole("button", { name: "Confirm stop" }).click();
  await floating.getByText("Notes ready").waitFor({ timeout: 30000 });
  await floating.screenshot({ path: resolve("artifacts/floating-ready.png") });
  await page
    .getByRole("heading", { name: "Overview", exact: true, level: 2 })
    .waitFor({ timeout: 20000 });
  await page
    .getByRole("heading", { name: "Action Items", exact: true, level: 2 })
    .waitFor();
  await floating.getByRole("button", { name: "Dismiss" }).click();
  for (let i = 0; i < 50; i++) {
    if (!(await windows()).find((w) => w.floating).visible) break;
    await page.waitForTimeout(100);
  }
  assert.equal((await windows()).find((w) => w.floating).visible, false);
  const m = await page.evaluate(async () => {
    const ms = await window.recallflow.list();
    return ms[0];
  });
  assert.equal(m.status, "complete");
  assert.ok(m.segments.length >= 3);
  assert.equal(m.actions[0].owner, "Alex");
  assert.ok(m.notes.includes("onboarding"));
  assert.ok(m.notes.includes("• Follow up on pricing"));
  await page
    .getByRole("button", { name: "View source", exact: true })
    .first()
    .click();
  await page.getByRole("dialog", { name: "Transcript sources" }).waitFor();
  await page.getByRole("button", { name: "Close source" }).click();
  await page
    .getByRole("textbox", { name: "Ask this meeting", exact: true })
    .fill("What about onboarding?");
  await page.getByRole("button", { name: "Send question" }).click();
  await page
    .getByText("Mock excerpt search (not an AI interpretation):", {
      exact: false,
    })
    .waitFor();
  await page.screenshot({
    path: resolve("artifacts/meeting-intelligence.png"),
    fullPage: true,
  });
  await app.close();
  page = await launch();
  await page
    .getByRole("textbox", { name: "Search meetings" })
    .fill("onboarding");
  await page.getByRole("button", { name: /Tomorrow test/ }).click();
  await page
    .getByRole("heading", { name: "Tomorrow test", exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "My Notes", exact: true })
      .inputValue(),
    m.notes,
  );
  page.on("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Delete meeting", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Search meetings" }).fill("");
  await page
    .getByRole("heading", { name: "Good conversations deserve good notes." })
    .waitFor();
  assert.equal((await page.evaluate(() => window.recallflow.list())).length, 0);
  console.log(
    "Desktop smoke passed: create, synthetic microphone capture, floating controls, hidden main window keeps recording, quick note, stop from floating window, mock transcript, autosave, structured intelligence, source links, chat, restart, persistence, deletion.",
  );
} catch (error) {
  if (app) {
    const page = await app.firstWindow();
    console.log("Failure page:", await page.locator("body").innerText());
  }
  throw error;
} finally {
  await app?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
