import fs from 'node:fs/promises';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | Array<Record<string, unknown>>;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ToolCall = {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
};

type ChatResponse = {
  choices?: Array<{
    message?: ChatMessage;
    finish_reason?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
};

export type RecoveryModelConfig = {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  vision: boolean;
  maxTurns: number;
  disableThinking: boolean;
};

export function loadRecoveryModelConfig(): RecoveryModelConfig {
  const baseUrl = process.env.BUA_CUA_RECOVERY_BASE_URL ?? '';
  const apiKey = process.env.BUA_CUA_RECOVERY_API_KEY ?? '';
  const model = process.env.BUA_CUA_RECOVERY_MODEL ?? 'qwen3.7-plus';
  const maxTurns = Number.parseInt(process.env.BUA_CUA_RECOVERY_MAX_TURNS ?? '6', 10);

  return {
    enabled: Boolean(baseUrl && apiKey && model),
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
    vision: (process.env.BUA_CUA_RECOVERY_VISION ?? 'true').toLowerCase() !== 'false',
    maxTurns: Number.isFinite(maxTurns) && maxTurns > 0 ? maxTurns : 6,
    disableThinking: process.env.BUA_CUA_ACTIVE_PROVIDER === 'minimax',
  };
}

export async function imageFileToDataUrl(filePath: string): Promise<string> {
  const buffer = await fs.readFile(filePath);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

export class RecoveryChatClient {
  constructor(private readonly config: RecoveryModelConfig) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  get defaultMaxTurns(): number {
    return this.config.maxTurns;
  }

  get visionEnabled(): boolean {
    return this.config.vision;
  }

  async complete(params: {
    messages: ChatMessage[];
    tools: Record<string, unknown>[];
  }): Promise<ChatMessage> {
    if (!this.config.enabled) {
      throw new Error('Recovery model is not configured');
    }

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: params.messages,
        tools: params.tools,
        tool_choice: 'auto',
        ...(this.config.disableThinking ? { thinking: { type: 'disabled' } } : {}),
      }),
    });

    const payload = (await response.json().catch(() => ({}))) as ChatResponse;
    if (!response.ok) {
      const message = payload.error?.message ?? `HTTP ${response.status}`;
      throw new Error(`Recovery model request failed: ${message}`);
    }

    const message = payload.choices?.[0]?.message;
    if (!message) {
      throw new Error('Recovery model returned no assistant message');
    }
    return message;
  }
}
