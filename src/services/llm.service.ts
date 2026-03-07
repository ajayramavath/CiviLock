import Anthropic from "@anthropic-ai/sdk";
import { trackAPIUsage, checkAPIBudget } from "./rate-limiter.service.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface LLMCallOptions {
  chatId: string;
  model?: string;
  maxTokens?: number;
  system?: string;
  messages: Anthropic.MessageParam[];
  purpose: string; // "conversation" | "schedule_parse" | "photo_parse" | "check_in" | "bulk_plan"
}

interface LLMCallResult {
  text: string;
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  inputTokens: number;
  outputTokens: number;
  budgetOk: boolean;
}

/**
 * Make an LLM call with automatic budget check and usage tracking.
 * Use this instead of calling anthropic.messages.create() directly.
 */
export async function llmCall(opts: LLMCallOptions): Promise<LLMCallResult> {
  // const budget = await checkAPIBudget();
  // if (!budget.allowed) {
  //   console.log(`[LLM] ⚠️ Budget exceeded (${budget.callsUsed}/${budget.limit})`);
  //   return {
  //     text: "I'm temporarily unable to process this. Please try again later or use /today or /week.",
  //     content: [],
  //     stopReason: "budget_exceeded",
  //     inputTokens: 0,
  //     outputTokens: 0,
  //     budgetOk: false,
  //   };
  // }

  const model = opts.model || "claude-haiku-4-5-20251001";

  console.log(`[LLM] ${model} | chatId=${opts.chatId} | purpose=${opts.purpose}`);
  const startTime = Date.now();

  const response = await anthropic.messages.create({
    model,
    max_tokens: opts.maxTokens || 1024,
    system: opts.system,
    messages: opts.messages,
  });

  const elapsed = Date.now() - startTime;
  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;

  console.log(`[LLM] Done | ${elapsed}ms | in=${inputTokens} out=${outputTokens} | stop=${response.stop_reason}`);

  await trackAPIUsage(opts.chatId, model, inputTokens, outputTokens, opts.purpose);

  const textBlock = response.content.find((b) => b.type === "text");
  const text = textBlock?.type === "text" ? textBlock.text : "";

  return {
    text,
    content: response.content,
    stopReason: response.stop_reason,
    inputTokens,
    outputTokens,
    budgetOk: true,
  };
}

export function parseJSONResponse(text: string): any | null {
  const clean = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

/** Direct client access for image inputs. Track usage manually with trackAPIUsage(). */
export { anthropic };