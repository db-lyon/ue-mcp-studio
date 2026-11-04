// STUB: owned by composer
import type { MentionSearchRequest, MentionSearchResponse } from "@ue-mcp-studio/shared";

export type MentionSearchFn = (request: MentionSearchRequest, signal: AbortSignal) => Promise<MentionSearchResponse>;
