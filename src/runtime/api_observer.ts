import fs from 'node:fs';
import path from 'node:path';
import type { Page, Request, Response } from 'playwright';

type ObservedRequest = {
  id: string;
  startedAt: string;
  endedAt?: string;
  method: string;
  url: string;
  resourceType: string;
  query: Record<string, string[]>;
  postDataPreview?: string;
  response?: {
    status: number;
    ok: boolean;
    mimeType?: string;
    contentLength?: number;
    bodySummary?: unknown;
  };
  error?: string;
};

type ApiObservation = {
  schemaVersion: 1;
  generatedAt: string;
  source: 'live-gui-network';
  requests: ObservedRequest[];
  notes: string[];
};

const MAX_BODY_BYTES = 512 * 1024;
const MAX_TEXT_PREVIEW = 4000;
const SENSITIVE_QUERY_KEYS = /token|key|secret|signature|auth|session|cookie/i;

function shouldObserveRequest(request: Request): boolean {
  const url = new URL(request.url());
  const pageUrl = request.frame().page().url();
  const pageOrigin = pageUrl && pageUrl !== 'about:blank' ? new URL(pageUrl).origin : undefined;
  if (pageOrigin && url.origin !== pageOrigin) {
    return false;
  }
  const pathLike = `${url.pathname} ${url.search}`;
  if (/\/api\/|\/graphql|\/download|export|csv|json/i.test(pathLike)) {
    return true;
  }
  return (request.resourceType() === 'xhr' || request.resourceType() === 'fetch')
    && !/\.(js|css|png|jpg|jpeg|gif|svg|woff2?)$/i.test(url.pathname);
}

function queryObject(rawUrl: string): Record<string, string[]> {
  const url = new URL(rawUrl);
  const result: Record<string, string[]> = {};
  for (const [key, value] of url.searchParams.entries()) {
    const safeValue = SENSITIVE_QUERY_KEYS.test(key) ? '<redacted>' : value;
    result[key] ??= [];
    result[key].push(safeValue);
  }
  return result;
}

function redactUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  for (const key of Array.from(url.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEYS.test(key)) {
      url.searchParams.set(key, '<redacted>');
    }
  }
  return url.toString();
}

function summarizeJson(value: unknown, depth = 0): unknown {
  if (depth > 3) {
    return '<max-depth>';
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sample: value.slice(0, 3).map((item) => summarizeJson(item, depth + 1)),
    };
  }
  const object = value as Record<string, unknown>;
  const entries = Object.entries(object).slice(0, 30);
  const summary: Record<string, unknown> = {
    type: 'object',
    keys: Object.keys(object).slice(0, 50),
  };
  for (const [key, item] of entries) {
    summary[key] = summarizeJson(item, depth + 1);
  }
  return summary;
}

function contentLength(response: Response): number | undefined {
  const header = response.headers()['content-length'];
  if (!header) {
    return undefined;
  }
  const parsed = Number.parseInt(header, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function bodySummary(response: Response): Promise<unknown> {
  const mimeType = response.headers()['content-type'] ?? '';
  const length = contentLength(response);
  if (length !== undefined && length > MAX_BODY_BYTES) {
    return { skipped: 'content-length-too-large', bytes: length };
  }
  if (!/json|text|csv|xml|html/i.test(mimeType)) {
    return { skipped: 'non-text-response', mimeType };
  }
  try {
    const text = await response.text();
    if (/json/i.test(mimeType)) {
      try {
        return summarizeJson(JSON.parse(text));
      } catch {
        return { textPreview: text.slice(0, MAX_TEXT_PREVIEW), parseError: 'invalid-json' };
      }
    }
    return {
      textPreview: text.slice(0, MAX_TEXT_PREVIEW),
      bytes: Buffer.byteLength(text),
    };
  } catch (error) {
    return {
      skipped: 'body-unavailable',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function requestId(request: Request): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${request.method()}`;
}

export function startApiObservation(params: {
  page: Page;
  outputPath: string;
  log?: (type: string, message?: string, data?: Record<string, unknown>, level?: 'info' | 'warn' | 'error') => void;
}): () => Promise<ApiObservation> {
  const { page, outputPath, log } = params;
  const ids = new WeakMap<Request, string>();
  const records = new Map<string, ObservedRequest>();

  function onRequest(request: Request): void {
    if (!shouldObserveRequest(request)) {
      return;
    }
    const id = requestId(request);
    ids.set(request, id);
    const postData = request.postData();
    records.set(id, {
      id,
      startedAt: new Date().toISOString(),
      method: request.method(),
      url: redactUrl(request.url()),
      resourceType: request.resourceType(),
      query: queryObject(request.url()),
      ...(postData ? { postDataPreview: postData.slice(0, MAX_TEXT_PREVIEW) } : {}),
    });
    log?.('api_observe_request', request.method(), { url: redactUrl(request.url()), resourceType: request.resourceType() });
  }

  async function onResponse(response: Response): Promise<void> {
    const request = response.request();
    const id = ids.get(request);
    if (!id) {
      return;
    }
    const record = records.get(id);
    if (!record) {
      return;
    }
    record.endedAt = new Date().toISOString();
    record.response = {
      status: response.status(),
      ok: response.ok(),
      mimeType: response.headers()['content-type'],
      contentLength: contentLength(response),
      bodySummary: await bodySummary(response),
    };
    log?.('api_observe_response', String(response.status()), { url: record.url, ok: response.ok() });
  }

  function onRequestFailed(request: Request): void {
    const id = ids.get(request);
    if (!id) {
      return;
    }
    const record = records.get(id);
    if (!record) {
      return;
    }
    record.endedAt = new Date().toISOString();
    record.error = request.failure()?.errorText ?? 'request failed';
    log?.('api_observe_request_failed', record.error, { url: record.url }, 'warn');
  }

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  return async () => {
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
    const observation: ApiObservation = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: 'live-gui-network',
      requests: Array.from(records.values()),
      notes: [
        'Captured while running the GUI mainline. This is observation evidence, not an approved API fast path.',
        'Sensitive query keys matching token/key/secret/signature/auth/session/cookie are redacted.',
      ],
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(observation, null, 2)}\n`, 'utf-8');
    log?.('api_observation_saved', outputPath, { requests: observation.requests.length });
    return observation;
  };
}
