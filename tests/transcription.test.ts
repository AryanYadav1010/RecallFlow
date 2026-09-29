import { it, expect } from "vitest";
import { WebSocketServer } from "ws";
import { DeepgramProvider, parseDeepgram } from "../packages/transcription";
import type { TranscriptionEvent } from "../packages/shared";
const result = {
  type: "Results",
  is_final: true,
  start: 0,
  duration: 1,
  channel: {
    alternatives: [
      {
        transcript: "Hello world.",
        confidence: 0.98,
        words: [
          { word: "Hello", start: 0, end: 0.3, speaker: 0 },
          {
            word: "world",
            punctuated_word: "world.",
            start: 0.4,
            end: 1,
            speaker: 1,
          },
        ],
      },
    ],
  },
};
it("keeps partials ephemeral and splits final speaker turns", () => {
  expect(
    parseDeepgram(
      { ...result, is_final: false },
      { meetingId: "m", offset: 0, session: 1 },
    ),
  ).toEqual([{ type: "partial", text: "Hello world." }]);
  const finals = parseDeepgram(result, {
    meetingId: "m",
    offset: 5000,
    session: 2,
  });
  expect(finals).toHaveLength(2);
  expect(finals[0].type === "final" && finals[0].segment.startTimeMs).toBe(
    5000,
  );
});
it("reconnects a failed stream, then flushes final results on stop", async () => {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP");
  let count = 0;
  let trainingOptOut = false;
  server.on("connection", (socket, request) => {
    trainingOptOut =
      new URL(request.url!, "http://localhost").searchParams.get(
        "mip_opt_out",
      ) === "true";
    count++;
    if (count === 1) setTimeout(() => socket.close(), 20);
    socket.on("message", (data) => {
      if (data.toString().includes("CloseStream")) {
        socket.send(JSON.stringify(result));
        socket.close();
      }
    });
  });
  const events: TranscriptionEvent[] = [];
  const session = await new DeepgramProvider(
    "test",
    `ws://127.0.0.1:${address.port}`,
    10,
  ).connect({
    meetingId: "m",
    sampleRate: 16000,
    onEvent: (e) => events.push(e),
  });
  await new Promise((r) => setTimeout(r, 100));
  session.send(Buffer.alloc(320));
  await session.close();
  expect(count).toBe(2);
  expect(trainingOptOut).toBe(true);
  expect(
    events.some((e) => e.type === "connection" && e.status === "reconnecting"),
  ).toBe(true);
  expect(events.filter((e) => e.type === "final")).toHaveLength(2);
  await new Promise<void>((r) => server.close(() => r()));
});
