import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { UserFacingError } from "../shared";
import { StructuredAIProvider, policy } from "./index";
type Message = { role: "system" | "user" | "assistant"; content: string };
const OUTPUT_TOKENS = 4096;
/** Roughly 3 characters per token for English JSON; errs on the large side. */
const estimateTokens = (text: string) => Math.ceil(text.length / 3);
export function parseStructured<T>(
  raw: string,
  schema: z.ZodType<T>,
): { ok: true; data: T } | { ok: false; problem: string } {
  // Thinking models may prefix their answer with reasoning.
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: "The response was not valid JSON." };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : {
        ok: false,
        problem: parsed.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; "),
      };
}
/**
 * Runs meeting intelligence on a local Ollama server. Output is constrained
 * with a JSON schema, validated with Zod, repaired at most once, and never
 * filled in when the model fails.
 */
export class OllamaAIProvider extends StructuredAIProvider {
  constructor(
    private config: { host: string; model: string; maxContext: number },
    private request: typeof fetch = fetch,
  ) {
    super();
  }
  private async chat(messages: Message[], format: unknown, numCtx: number) {
    let response: Response;
    try {
      response = await this.request(
        new URL("/api/chat", this.config.host).href,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Local generation on a laptop can take minutes for a long meeting.
          signal: AbortSignal.timeout(10 * 60000),
          body: JSON.stringify({
            model: this.config.model,
            messages,
            format,
            stream: false,
            think: false,
            options: { temperature: 0, num_ctx: numCtx },
          }),
        },
      );
    } catch (error) {
      throw new UserFacingError(
        error instanceof Error && error.name === "TimeoutError"
          ? `Ollama (${this.config.model}) took longer than 10 minutes. Try a smaller model or a shorter meeting.`
          : `Ollama is not reachable at ${this.config.host}. Start Ollama and retry.`,
      );
    }
    if (response.status === 404)
      throw new UserFacingError(
        `The Ollama model "${this.config.model}" is not installed. Run: ollama pull ${this.config.model}`,
      );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new UserFacingError(
        `Ollama returned an error (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}.`,
      );
    }
    const body = (await response.json()) as { message?: { content?: string } };
    return body.message?.content ?? "";
  }
  protected async structured<T>(
    _name: string,
    schema: z.ZodType<T>,
    instruction: string,
    data: unknown,
  ): Promise<T> {
    const system = `${policy}\n${instruction}\nRespond with a single JSON object that matches the provided schema. No prose.`;
    const content = JSON.stringify(data);
    const needed = estimateTokens(system + content) + OUTPUT_TOKENS;
    if (needed > this.config.maxContext)
      throw new UserFacingError(
        `This meeting needs about ${needed} tokens, more than the local context limit (${this.config.maxContext}). Raise OLLAMA_NUM_CTX if you have the memory, or use a cloud provider for this meeting.`,
      );
    // Allocate only what this meeting needs: context size drives RAM use.
    const numCtx = Math.min(
      this.config.maxContext,
      Math.ceil(Math.max(8192, needed) / 4096) * 4096,
    );
    const format = zodToJsonSchema(schema, { $refStrategy: "none" });
    const messages: Message[] = [
      { role: "system", content: system },
      { role: "user", content },
    ];
    const first = await this.chat(messages, format, numCtx);
    const result = parseStructured(first, schema);
    if (result.ok) return result.data;
    const repaired = parseStructured(
      await this.chat(
        [
          ...messages,
          { role: "assistant", content: first },
          {
            role: "user",
            content: `That output is invalid: ${result.problem} Return the corrected JSON object only. Do not add anything that is not supported by the meeting data.`,
          },
        ],
        format,
        numCtx,
      ),
      schema,
    );
    if (repaired.ok) return repaired.data;
    throw new UserFacingError(
      `The local model (${this.config.model}) returned output that did not match the required structure, even after one repair attempt. Nothing from it was saved. Retry, or try a larger model.`,
    );
  }
}
