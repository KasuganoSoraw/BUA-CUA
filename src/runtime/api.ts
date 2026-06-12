import fs from 'node:fs';
import path from 'node:path';
import type { APIRequestContext } from 'playwright';
import type { JsonlLogger } from './logger.js';
import type { SkillManifest } from './types.js';

export type ApiQueryValue = string | number | boolean | Array<string | number | boolean> | undefined | null;

export type ApiRequestSpec = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  query?: Record<string, ApiQueryValue>;
  headers?: Record<string, string>;
  json?: unknown;
  data?: string | Buffer;
  timeoutMs?: number;
};

export type ApiDownloadResult = {
  path: string;
  bytes: number;
  status: number;
  url: string;
};

export type ApiHelper = {
  requestJson<T = unknown>(label: string, spec: ApiRequestSpec): Promise<T>;
  download(label: string, spec: ApiRequestSpec & { outputPath?: string }): Promise<ApiDownloadResult>;
  verify(condition: unknown, message: string, data?: Record<string, unknown>): asserts condition;
};

function buildUrl(rawUrl: string, query?: Record<string, ApiQueryValue>): string {
  const url = new URL(rawUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function safeFilename(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'api-download';
}

export function createApiHelper(params: {
  request: APIRequestContext;
  logger: JsonlLogger;
  manifest: SkillManifest;
  artifactDir: string;
}): ApiHelper {
  const { request, logger, manifest, artifactDir } = params;

  async function fetch(label: string, spec: ApiRequestSpec) {
    const method = spec.method ?? 'GET';
    const url = buildUrl(spec.url, spec.query);
    logger.info(manifest.name, 'api_request_start', label, {
      method,
      url,
    });
    const response = await request.fetch(url, {
      method,
      headers: spec.headers,
      data: spec.data,
      timeout: spec.timeoutMs,
      ...(spec.json === undefined ? {} : { data: JSON.stringify(spec.json), headers: {
        'content-type': 'application/json',
        ...spec.headers,
      } }),
    });
    logger.info(manifest.name, 'api_request_end', label, {
      method,
      url,
      status: response.status(),
      ok: response.ok(),
    });
    return { response, url };
  }

  return {
    async requestJson<T = unknown>(label: string, spec: ApiRequestSpec): Promise<T> {
      const { response, url } = await fetch(label, spec);
      if (!response.ok()) {
        throw new Error(`API request failed for ${label}: ${response.status()} ${response.statusText()} ${url}`);
      }
      return (await response.json()) as T;
    },
    async download(label: string, spec: ApiRequestSpec & { outputPath?: string }): Promise<ApiDownloadResult> {
      const { response, url } = await fetch(label, spec);
      if (!response.ok()) {
        throw new Error(`API download failed for ${label}: ${response.status()} ${response.statusText()} ${url}`);
      }
      const outputPath = spec.outputPath ?? path.join(artifactDir, `${safeFilename(label)}-${Date.now()}`);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const body = await response.body();
      fs.writeFileSync(outputPath, body);
      const bytes = fs.statSync(outputPath).size;
      logger.info(manifest.name, 'api_download_saved', label, {
        path: outputPath,
        bytes,
        url,
        status: response.status(),
      });
      return {
        path: outputPath,
        bytes,
        status: response.status(),
        url,
      };
    },
    verify(condition: unknown, message: string, data?: Record<string, unknown>): asserts condition {
      if (!condition) {
        logger.warn(manifest.name, 'api_verify_failed', message, data);
        throw new Error(message);
      }
      logger.info(manifest.name, 'api_verify_passed', message, data);
    },
  };
}
