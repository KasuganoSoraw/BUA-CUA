import fs from 'node:fs';
import path from 'node:path';
import type { ApiHelper, ApiQueryValue, ApiRequestSpec } from './api.js';
import type { SkillArgs, SkillManifest } from './types.js';

type FastPathStatus = 'candidate' | 'probed' | 'approved' | 'rejected';
type FastPathRisk = 'read_only' | 'write_review_required' | 'destructive_review_required';
type FallbackPolicy = 'gui_on_failure' | 'stop_on_uncertain' | 'forbidden';

type ApiRegistryStep = {
  id?: string;
  kind?: 'requestJson' | 'download';
  type?: 'requestJson' | 'download';
  method?: ApiRequestSpec['method'];
  url: string;
  queryTemplate?: Record<string, ApiQueryValue | string>;
  query?: Record<string, ApiQueryValue | string>;
  outputPath?: string;
  saveAs?: string;
};

type ApiFastPath = {
  id: string;
  status: FastPathStatus;
  kind?: 'query' | 'download';
  risk: FastPathRisk;
  fallbackPolicy?: FallbackPolicy;
  method?: ApiRequestSpec['method'];
  url?: string;
  paramTemplate?: Record<string, ApiQueryValue | string>;
  argMappings?: Record<string, Record<string, string>>;
  steps?: ApiRegistryStep[];
  observed?: Record<string, unknown>;
  lastProbe?: Record<string, unknown>;
};

export type ApiRegistry = {
  schemaVersion: number;
  status?: FastPathStatus;
  risk?: FastPathRisk;
  fallbackPolicy?: FallbackPolicy;
  fastPaths?: ApiFastPath[];
  notes?: string[];
  [key: string]: unknown;
};

export type ApiFastPathResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  data?: Record<string, unknown>;
};

type ApiFastPathEventLogger = (
  type: string,
  message?: string,
  data?: Record<string, unknown>,
  level?: 'info' | 'warn' | 'error',
) => void;

const NCT_ID_PATTERN = /^NCT\d+$/;

export function loadApiRegistry(skillDir: string, manifest: SkillManifest): ApiRegistry | undefined {
  if (!manifest.apiRegistry) {
    return undefined;
  }
  const registryPath = path.join(skillDir, manifest.apiRegistry);
  if (!fs.existsSync(registryPath)) {
    throw new Error(`Missing API registry file: ${registryPath}`);
  }
  return JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as ApiRegistry;
}

export function saveApiRegistry(skillDir: string, manifest: SkillManifest, registry: ApiRegistry): void {
  if (!manifest.apiRegistry) {
    throw new Error('Cannot save API registry because skill.json has no apiRegistry field');
  }
  const registryPath = path.join(skillDir, manifest.apiRegistry);
  fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf-8');
}

function isExecutableStatus(status: FastPathStatus | undefined, allowCandidate: boolean): boolean {
  return status === 'approved' || status === 'probed' || (allowCandidate && status === 'candidate');
}

function checkedKeysFromObserved(fastPath: ApiFastPath, groupId: string): string[] {
  const groups = fastPath.observed?.aggFilterGroups;
  if (!Array.isArray(groups)) {
    return [];
  }
  const group = groups.find((item) => {
    return typeof item === 'object' && item !== null && (item as { id?: unknown }).id === groupId;
  }) as { options?: Array<{ key?: unknown; checked?: unknown }> } | undefined;
  return (group?.options ?? [])
    .filter((option) => option.checked === true && typeof option.key === 'string')
    .map((option) => option.key as string);
}

export function enrichRegistryMappingsFromArgs(registry: ApiRegistry, args: SkillArgs): ApiRegistry {
  const next = structuredClone(registry) as ApiRegistry;
  const sharedCheckedKeys = {
    status: (next.fastPaths ?? []).flatMap((fastPath) => checkedKeysFromObserved(fastPath, 'status'))[0],
    sex: (next.fastPaths ?? []).flatMap((fastPath) => checkedKeysFromObserved(fastPath, 'sex'))[0],
    ages: (next.fastPaths ?? []).flatMap((fastPath) => checkedKeysFromObserved(fastPath, 'ages'))[0],
  };
  const sharedStatusKeys = (next.fastPaths ?? []).flatMap((fastPath) => checkedKeysFromObserved(fastPath, 'status'));
  for (const fastPath of next.fastPaths ?? []) {
    const mappings = { ...(fastPath.argMappings ?? {}) };
    if (typeof args.status === 'string' && !mappings.statusAggFilter) {
      const keys = checkedKeysFromObserved(fastPath, 'status');
      if (keys.length > 0) {
        mappings.statusAggFilter = { [args.status]: `status:${keys.join(' ')}` };
      } else if (sharedStatusKeys.length > 0) {
        mappings.statusAggFilter = { [args.status]: `status:${sharedStatusKeys.join(' ')}` };
      }
    }
    if (typeof args.sex === 'string' && !mappings.sexAggFilter) {
      const keys = checkedKeysFromObserved(fastPath, 'sex');
      if (keys.length > 0) {
        mappings.sexAggFilter = { [args.sex]: `sex:${keys[0]}` };
      } else if (sharedCheckedKeys.sex) {
        mappings.sexAggFilter = { [args.sex]: `sex:${sharedCheckedKeys.sex}` };
      }
    }
    if (typeof args.ageGroup === 'string' && !mappings.ageAggFilter) {
      const keys = checkedKeysFromObserved(fastPath, 'ages');
      if (keys.length > 0) {
        mappings.ageAggFilter = { [args.ageGroup]: `ages:${keys[0]}` };
      } else if (sharedCheckedKeys.ages) {
        mappings.ageAggFilter = { [args.ageGroup]: `ages:${sharedCheckedKeys.ages}` };
      }
    }
    if (Object.keys(mappings).length > 0) {
      fastPath.argMappings = mappings;
    }
    fastPath.fallbackPolicy ??= 'gui_on_failure';
  }
  return next;
}

function extractNctIds(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') {
    if (NCT_ID_PATTERN.test(value) && !output.includes(value)) {
      output.push(value);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      extractNctIds(item, output);
    }
    return output;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      extractNctIds(item, output);
    }
  }
  return output;
}

function valueFromArgs(name: string, args: SkillArgs, state: Record<string, unknown>, fastPath: ApiFastPath): unknown {
  if (Object.prototype.hasOwnProperty.call(args, name)) {
    return args[name];
  }
  if (Object.prototype.hasOwnProperty.call(state, name)) {
    return state[name];
  }
  if (name === 'condition') {
    return args.condition ?? args.query;
  }
  if (name === 'limit') {
    return args.resultCount ?? args.limit;
  }
  if (name === 'selectedIdsCsv') {
    const selectedIds = state.selectedIds;
    if (Array.isArray(selectedIds) && selectedIds.every((item) => typeof item === 'string')) {
      return selectedIds.join(',');
    }
  }
  const mapping = fastPath.argMappings?.[name];
  if (mapping) {
    const sourceArg = name === 'statusAggFilter' ? args.status
      : name === 'sexAggFilter' ? args.sex
        : name === 'ageAggFilter' ? args.ageGroup
          : undefined;
    if (typeof sourceArg === 'string' && Object.prototype.hasOwnProperty.call(mapping, sourceArg)) {
      return mapping[sourceArg];
    }
    throw new Error(`API parameter mapping is missing for ${name}: ${String(sourceArg)}`);
  }
  throw new Error(`API template variable is unresolved: ${name}`);
}

function resolveTemplateValue(
  value: ApiQueryValue | string,
  args: SkillArgs,
  state: Record<string, unknown>,
  fastPath: ApiFastPath,
): ApiQueryValue {
  if (typeof value !== 'string') {
    return value;
  }
  const exact = value.match(/^\{\{([a-zA-Z0-9_.$-]+)\}\}$/);
  if (exact) {
    const resolved = valueFromArgs(exact[1], args, state, fastPath);
    if (
      resolved === undefined
      || resolved === null
      || typeof resolved === 'string'
      || typeof resolved === 'number'
      || typeof resolved === 'boolean'
      || (Array.isArray(resolved) && resolved.every((item) => ['string', 'number', 'boolean'].includes(typeof item)))
    ) {
      return resolved as ApiQueryValue;
    }
    throw new Error(`API template variable resolved to unsupported value: ${exact[1]}`);
  }
  return value.replace(/\{\{([a-zA-Z0-9_.$-]+)\}\}/g, (_match, name: string) => {
    const resolved = valueFromArgs(name, args, state, fastPath);
    if (resolved === undefined || resolved === null) {
      return '';
    }
    if (Array.isArray(resolved)) {
      return resolved.join(',');
    }
    return String(resolved);
  });
}

function resolveQuery(
  template: Record<string, ApiQueryValue | string> | undefined,
  args: SkillArgs,
  state: Record<string, unknown>,
  fastPath: ApiFastPath,
): Record<string, ApiQueryValue> | undefined {
  if (!template) {
    return undefined;
  }
  const query: Record<string, ApiQueryValue> = {};
  for (const [key, value] of Object.entries(template)) {
    query[key] = resolveTemplateValue(value, args, state, fastPath);
  }
  return query;
}

function normalizeSteps(fastPath: ApiFastPath): ApiRegistryStep[] {
  if (fastPath.steps && fastPath.steps.length > 0) {
    return fastPath.steps;
  }
  if (!fastPath.url) {
    return [];
  }
  return [{
    id: fastPath.id,
    kind: fastPath.kind === 'download' ? 'download' : 'requestJson',
    method: fastPath.method,
    url: fastPath.url,
    queryTemplate: fastPath.paramTemplate,
  }];
}

function safeFastPath(fastPath: ApiFastPath): ApiFastPathResult | undefined {
  if (fastPath.risk !== 'read_only') {
    return {
      ok: false,
      skipped: true,
      reason: `API fast path ${fastPath.id} is not read_only: ${fastPath.risk}`,
    };
  }
  const policy = fastPath.fallbackPolicy ?? 'gui_on_failure';
  if (policy === 'forbidden') {
    return {
      ok: false,
      skipped: true,
      reason: `API fast path ${fastPath.id} fallbackPolicy is forbidden`,
    };
  }
  return undefined;
}

async function executeFastPath(params: {
  fastPath: ApiFastPath;
  args: SkillArgs;
  api: ApiHelper;
  state: Record<string, unknown>;
  log: ApiFastPathEventLogger;
}): Promise<void> {
  const { fastPath, args, api, state, log } = params;
  const steps = normalizeSteps(fastPath);
  if (steps.length === 0) {
    throw new Error(`API fast path ${fastPath.id} has no executable steps`);
  }

  for (const step of steps) {
    const kind = step.kind ?? step.type ?? 'requestJson';
    const query = resolveQuery(step.queryTemplate ?? step.query, args, state, fastPath);
    const label = step.id ?? fastPath.id;
    const spec: ApiRequestSpec = {
      method: step.method ?? fastPath.method ?? 'GET',
      url: step.url,
      query,
      timeoutMs: 120000,
    };
    log('api_fast_path_step_start', label, { kind, method: spec.method, url: step.url, query });
    if (kind === 'download') {
      const download = await api.download(label, { ...spec, outputPath: step.outputPath });
      if (download.bytes <= 0) {
        throw new Error(`API download file is empty for ${label}`);
      }
      state.lastDownload = download;
      log('api_fast_path_step_end', label, { kind, download });
    } else {
      const data = await api.requestJson(label, spec);
      const ids = extractNctIds(data).slice(0, Number(args.resultCount ?? args.limit ?? 10));
      if (ids.length > 0) {
        state.selectedIds = ids;
      }
      if (typeof data === 'object' && data !== null && 'hits' in data) {
        const hits = (data as { hits?: unknown }).hits;
        if (!Array.isArray(hits)) {
          throw new Error(`API response hits is not an array for ${label}`);
        }
        const requested = Number(args.resultCount ?? args.limit ?? 1);
        if (hits.length < requested) {
          throw new Error(`API response has fewer hits than requested for ${label}: ${hits.length} < ${requested}`);
        }
      }
      state[step.saveAs ?? label] = data;
      log('api_fast_path_step_end', label, { kind, selectedIds: state.selectedIds });
    }
  }
}

export async function runApiFastPath(params: {
  registry: ApiRegistry | undefined;
  args: SkillArgs;
  manifest: SkillManifest;
  api: ApiHelper;
  allowCandidate?: boolean;
  log: ApiFastPathEventLogger;
}): Promise<ApiFastPathResult> {
  const { registry, args, manifest, api, allowCandidate = false, log } = params;
  if (!registry) {
    return { ok: false, skipped: true, reason: 'No api_registry.json is declared for this skill' };
  }
  if (manifest.risk !== 'read_only' || registry.risk && registry.risk !== 'read_only') {
    return {
      ok: false,
      skipped: true,
      reason: `API-first only supports read_only skills and registries: skill=${manifest.risk}, registry=${registry.risk ?? 'unset'}`,
    };
  }

  const executable = (registry.fastPaths ?? []).filter((fastPath) => {
    return isExecutableStatus(fastPath.status, allowCandidate) && fastPath.risk === 'read_only';
  });
  if (executable.length === 0) {
    return {
      ok: false,
      skipped: true,
      reason: allowCandidate
        ? 'No candidate/probed/approved read_only API fast path is available'
        : 'No probed/approved read_only API fast path is available',
    };
  }

  const state: Record<string, unknown> = {};
  log('api_fast_path_start', undefined, {
    allowCandidate,
    fastPaths: executable.map((fastPath) => fastPath.id),
  });
  try {
    for (const fastPath of executable) {
      const safety = safeFastPath(fastPath);
      if (safety) {
        if (safety.skipped) {
          log('api_fast_path_skipped', safety.reason, { fastPath: fastPath.id }, 'warn');
          continue;
        }
        return safety;
      }
      await executeFastPath({ fastPath, args, api, state, log });
    }
    log('api_fast_path_success', undefined, {
      selectedIds: state.selectedIds,
      lastDownload: state.lastDownload,
    });
    return { ok: true, data: state };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log('api_fast_path_failed', reason, undefined, 'warn');
    return { ok: false, reason, data: state };
  }
}

export function markRegistryProbed(registry: ApiRegistry, result: ApiFastPathResult, args: SkillArgs): ApiRegistry {
  const next = enrichRegistryMappingsFromArgs(registry, args);
  const now = new Date().toISOString();
  next.status = result.ok ? 'probed' : 'candidate';
  next.risk = next.risk ?? 'read_only';
  next.fallbackPolicy = next.fallbackPolicy ?? 'gui_on_failure';
  for (const fastPath of next.fastPaths ?? []) {
    if (fastPath.risk === 'read_only' && fastPath.status !== 'approved' && fastPath.status !== 'rejected') {
      fastPath.status = result.ok ? 'probed' : 'candidate';
    }
    fastPath.fallbackPolicy ??= 'gui_on_failure';
    fastPath.lastProbe = {
      probedAt: now,
      ok: result.ok,
      reason: result.reason,
    };
    if (!fastPath.steps || fastPath.steps.length === 0) {
      fastPath.steps = normalizeSteps(fastPath);
    }
  }
  next.lastProbe = {
    probedAt: now,
    ok: result.ok,
    reason: result.reason,
  };
  return next;
}
