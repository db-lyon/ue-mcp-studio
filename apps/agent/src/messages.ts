/**
 * The message shapes Studio keeps a session's conversation in: the Messages
 * format, whatever route the model runs on. The durable harness converts at
 * its own edge; Studio's copy is what a moved session is seeded from and what
 * an edit or a fork cuts.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type ContentBlock = Anthropic.Beta.BetaContentBlock;

/** Where each OpenAI-compatible vendor lists its models. */
export const OPENAI_BASE_URLS = {
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
} as const;
