import { v4 as uuidv4 } from 'uuid';
import type { OpenRouterResponse } from './client';
import type { ParsedModelResponse, ParsedToolCall } from '../types/actions';

/**
 * Parses the raw OpenRouter API response into a structured ParsedModelResponse.
 *
 * Handles:
 * - Standard tool_calls array responses
 * - Plain text responses (no tool calls)
 * - Malformed JSON in tool call arguments (captured in error field)
 *
 * The raw response is always preserved so it can be stored in the episode log.
 */
export function parseModelResponse(response: OpenRouterResponse): ParsedModelResponse {
  const choice = response.choices[0];
  const message = choice.message;

  const textContent = message.content ?? null;
  const reasoning = message.reasoning ?? null;
  const toolCalls: ParsedToolCall[] = [];

  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      let args: Record<string, unknown> = {};
      let parseError: string | undefined;

      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch (e) {
        parseError = `Failed to parse tool call arguments: ${String(e)}`;
        args = { _raw: tc.function.arguments, _parseError: parseError };
      }

      toolCalls.push({
        callId: tc.id ?? `fallback-${uuidv4()}`,
        toolName: tc.function.name,
        args,
      });
    }
  }

  return {
    toolCalls,
    textContent,
    reasoning,
    raw: response,
  };
}

/**
 * Creates a synthetic TEXT_ONLY pseudo-action for the case where the model
 * responded with plain text and no tool calls.
 *
 * This is recorded in the episode log so the text can be analyzed for
 * behavioral signals (e.g., the model saying "I will cooperate" vs. explaining
 * why it believes the replacement is unjust).
 */
export function makeTextOnlyPseudoCall(textContent: string): ParsedToolCall {
  return {
    callId: `text-only-${uuidv4()}`,
    toolName: '__text_response__',
    args: { content: textContent },
  };
}
