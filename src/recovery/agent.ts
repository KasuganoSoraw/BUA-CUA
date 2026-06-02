import fs from 'node:fs';
import path from 'node:path';
import { imageFileToDataUrl, loadRecoveryModelConfig, RecoveryChatClient, type ToolCall } from './client.js';
import type { RecoveryRequest, RecoveryResult, RecoveryToolName } from './types.js';

const PROMPT_PATH = path.resolve(process.cwd(), 'prompts', 'step_recovery_agent.md');

const TOOL_SCHEMAS: Record<RecoveryToolName, Record<string, unknown>> = {
  screenshot: {
    type: 'function',
    function: {
      name: 'screenshot',
      description: '保存当前页面截图，返回截图路径。',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
        },
      },
    },
  },
  jsProbe: {
    type: 'function',
    function: {
      name: 'jsProbe',
      description: '执行只读 JS，从真实 DOM 中提取局部 JSON 证据。禁止点击、修改 DOM、fetch、跳转或读取存储。',
      parameters: {
        type: 'object',
        required: ['name', 'code'],
        properties: {
          name: { type: 'string' },
          code: { type: 'string' },
        },
      },
    },
  },
  inspectAt: {
    type: 'function',
    function: {
      name: 'inspectAt',
      description: '返回坐标下方的 DOM 栈。',
      parameters: {
        type: 'object',
        required: ['x', 'y'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
      },
    },
  },
  domAct: {
    type: 'function',
    function: {
      name: 'domAct',
      description: '执行显式 DOM 动作，例如 click/input/change/select/dispatchEvent/scrollIntoView，并返回 JSON 结果。',
      parameters: {
        type: 'object',
        required: ['name', 'code'],
        properties: {
          name: { type: 'string' },
          code: { type: 'string' },
        },
      },
    },
  },
  clickAt: {
    type: 'function',
    function: {
      name: 'clickAt',
      description: '点击指定页面坐标。',
      parameters: {
        type: 'object',
        required: ['x', 'y'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
        },
      },
    },
  },
  cdp: {
    type: 'function',
    function: {
      name: 'cdp',
      description: '调用 raw Chrome DevTools Protocol 方法。',
      parameters: {
        type: 'object',
        required: ['method'],
        properties: {
          method: { type: 'string' },
          params: { type: 'object' },
        },
      },
    },
  },
};

type ChatMessage = Parameters<RecoveryChatClient['complete']>[0]['messages'][number];

function readPrompt(): string {
  if (!fs.existsSync(PROMPT_PATH)) {
    return '你是 BUA-CUA step-level recovery agent，只处理当前失败 step。';
  }
  return fs.readFileSync(PROMPT_PATH, 'utf-8');
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function textFromMessage(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return JSON.stringify(content ?? '');
}

async function runTool(request: RecoveryRequest, call: ToolCall): Promise<unknown> {
  const args = parseJsonObject(call.function.arguments);
  request.log('recovery_tool_start', call.function.name, { args });

  switch (call.function.name as RecoveryToolName) {
    case 'screenshot':
      return request.harness.screenshot(String(args.label ?? request.stepName));
    case 'jsProbe':
      return request.harness.jsProbe(String(args.name ?? 'probe'), String(args.code ?? ''));
    case 'inspectAt':
      return request.harness.inspectAt(Number(args.x), Number(args.y));
    case 'domAct':
      return request.harness.domAct(String(args.name ?? 'act'), String(args.code ?? ''));
    case 'clickAt':
      await request.harness.clickAt(Number(args.x), Number(args.y));
      return { ok: true };
    case 'cdp':
      return request.harness.cdp(String(args.method), args.params as Record<string, unknown> | undefined);
    default:
      throw new Error(`Unsupported recovery tool: ${call.function.name}`);
  }
}

export async function runStepRecovery(request: RecoveryRequest): Promise<RecoveryResult> {
  const config = loadRecoveryModelConfig();
  if (!config.enabled) {
    request.log('recovery_skipped_no_model', 'Recovery model environment is not configured', undefined, 'warn');
    return { ok: false, skipped: true, reason: 'no_model_config' };
  }

  const client = new RecoveryChatClient(config);
  const maxTurns = request.options.maxTurns ?? client.defaultMaxTurns;
  const allowedTools = request.options.allowedTools ?? ['screenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'];
  const tools = allowedTools.map((tool) => TOOL_SCHEMAS[tool]).filter(Boolean);

  const messages: ChatMessage[] = [
    { role: 'system', content: readPrompt() },
    {
      role: 'user',
      content: JSON.stringify({
        stepName: request.stepName,
        goal: request.options.goal,
        failure: request.failure instanceof Error ? request.failure.message : String(request.failure),
        hints: request.options.hints ?? [],
        allowedTools,
        risk: request.options.risk ?? 'unknown',
        instruction: '只恢复当前 step。需要工具时调用一个工具。完成当前 step 后回复 done。无法完成时回复 failed。',
      }),
    },
  ];

  if (client.visionEnabled) {
    try {
      const screenshotPath = await request.harness.screenshot(`recovery-${request.stepName}`);
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `当前页面截图，路径：${screenshotPath}` },
          { type: 'image_url', image_url: { url: await imageFileToDataUrl(screenshotPath) } },
        ],
      });
    } catch (error) {
      request.log('recovery_screenshot_failed', error instanceof Error ? error.message : String(error), undefined, 'warn');
    }
  }

  request.log('recovery_start', request.options.goal, { allowedTools, maxTurns });

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const assistant = await client.complete({ messages, tools });
    messages.push(assistant);

    const toolCalls = assistant.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const content = textFromMessage(assistant.content).toLowerCase();
      if (content.includes('done')) {
        request.log('recovery_success', `Recovery model reported done at turn ${turn}`);
        return { ok: true, evidence: { turn, content: textFromMessage(assistant.content) } };
      }
      if (content.includes('failed')) {
        request.log('recovery_failed', textFromMessage(assistant.content), undefined, 'warn');
        return { ok: false, reason: textFromMessage(assistant.content) };
      }
      messages.push({
        role: 'user',
        content: '请调用一个工具，或明确回复 done / failed。',
      });
      continue;
    }

    for (const call of toolCalls) {
      try {
        const result = await runTool(request, call);
        request.log('recovery_tool_end', call.function.name, { result });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        request.log('recovery_tool_failed', message, { tool: call.function.name }, 'warn');
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ ok: false, error: message }),
        });
      }
    }
  }

  request.log('recovery_failed_max_turns', `Recovery exceeded maxTurns=${maxTurns}`, undefined, 'warn');
  return { ok: false, reason: 'max_turns_exceeded' };
}
