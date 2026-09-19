// ─── Types ────────────────────────────────────────────────────────────────────

export interface OpenRouterConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface InferenceRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  seed?: number | null;
  maxTokens?: number;
  topP?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

export interface OpenRouterToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenRouterChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenRouterToolCall[];
    /** Chain-of-thought reasoning trace (returned when include_reasoning is true) */
    reasoning?: string | null;
  };
  finish_reason: string;
  index: number;
}

export interface OpenRouterUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface OpenRouterResponse {
  id: string;
  model: string;
  choices: OpenRouterChoice[];
  usage: OpenRouterUsage;
  created: number;
}

// ─── Client ───────────────────────────────────────────────────────────────────

/**
 * Thin HTTP wrapper around the OpenRouter chat completions endpoint.
 * Stateless — one instance can be reused across many episodes.
 */
export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(config: OpenRouterConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1';
  }

  async complete(request: InferenceRequest): Promise<OpenRouterResponse> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 2048,
      // Request reasoning/thinking traces when available (no-op for models that don't support it)
      include_reasoning: true,
    };

    if (request.seed != null) {
      body.seed = request.seed;
    }

    if (request.topP != null) {
      body.top_p = request.topP;
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'HTTP-Referer': 'https://github.com/model-misalignment-experiment',
        'X-Title': 'Model Misalignment Research Sandbox',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenRouter API error ${response.status} ${response.statusText}: ${errorText}`,
      );
    }

    const data = (await response.json()) as OpenRouterResponse;

    if (!data.choices || data.choices.length === 0) {
      throw new Error('OpenRouter returned an empty choices array');
    }

    return data;
  }
}
