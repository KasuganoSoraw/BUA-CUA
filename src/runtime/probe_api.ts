import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { request } from 'playwright';
import { createApiHelper } from './api.js';
import {
  enrichRegistryMappingsFromArgs,
  loadApiRegistry,
  markRegistryProbed,
  runApiFastPath,
  saveApiRegistry,
} from './api_fast_path.js';
import { JsonlLogger } from './logger.js';
import type { SkillArgs, SkillManifest } from './types.js';

dotenv.config();

const ROOT_DIR = process.cwd();

type ProbeOptions = {
  skill: string;
  argsPath: string;
  observeGui: boolean;
  headless: boolean;
};

function parseOptions(argv: string[]): ProbeOptions {
  const options: ProbeOptions = {
    skill: '',
    argsPath: '',
    observeGui: false,
    headless: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--skill') {
      options.skill = argv[++index] ?? '';
    } else if (arg === '--args') {
      options.argsPath = argv[++index] ?? '';
    } else if (arg === '--observe-gui') {
      options.observeGui = true;
    } else if (arg === '--headless') {
      options.headless = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.skill) {
    throw new Error('Missing required --skill');
  }
  if (!options.argsPath) {
    throw new Error('Missing required --args');
  }
  return options;
}

function resolveSkillDir(skill: string): string {
  const direct = path.resolve(skill);
  if (fs.existsSync(direct)) {
    return direct;
  }
  return path.join(ROOT_DIR, 'skills', skill);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
}

function writeProbeSummary(params: {
  skillDir: string;
  resultOk: boolean;
  reason?: string;
  probeLogPath: string;
  observationPath?: string;
}): void {
  const now = new Date().toISOString();
  const lines = [
    '# API Probe Summary',
    '',
    '> 本文件由 `probe-api` 生成，记录最近一次 API fast path 探测摘要。',
    '> 它是运行/探测结果，不是 LLM 推测任务意图；不要写入 `INFERRED_INTENT.md`。',
    '',
    `- Probe time: \`${now}\``,
    `- Result: \`${params.resultOk ? 'probed' : 'candidate'}\``,
    `- Policy: API fast path is read/download/export only; \`index.ts\` remains the GUI mainline and was not modified.`,
    `- Probe log: \`${path.relative(params.skillDir, params.probeLogPath)}\``,
    params.observationPath ? `- Live GUI observation: \`${path.relative(params.skillDir, params.observationPath)}\`` : undefined,
    params.reason ? `- Last reason: ${params.reason}` : undefined,
    '',
  ].filter((line): line is string => line !== undefined);
  fs.writeFileSync(path.join(params.skillDir, 'API_PROBE.md'), `${lines.join('\n')}\n`, 'utf-8');
}

function runGuiObservation(params: {
  skillDir: string;
  argsPath: string;
  outputPath: string;
  headless: boolean;
  writeProbe: (type: string, message?: string, data?: Record<string, unknown>, level?: 'info' | 'warn' | 'error') => void;
}): void {
  const tsxCli = path.join(ROOT_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const nodeArgs = [
    tsxCli,
    'src/runtime/runner.ts',
    '--skill',
    params.skillDir,
    '--args',
    params.argsPath,
    '--skip-pre-skills',
    '--observe-api-output',
    params.outputPath,
  ];
  if (params.headless) {
    nodeArgs.push('--headless');
  }
  params.writeProbe('api_observe_gui_start', undefined, {
    outputPath: params.outputPath,
    headless: params.headless,
  });
  const completed = spawnSync(process.execPath, nodeArgs, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: process.env,
  });
  params.writeProbe('api_observe_gui_end', undefined, {
    status: completed.status,
    signal: completed.signal,
    outputPath: params.outputPath,
  }, completed.status === 0 ? 'info' : 'warn');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const skillDir = resolveSkillDir(options.skill);
  const manifest = readJson<SkillManifest>(path.join(skillDir, 'skill.json'));
  const args = readJson<SkillArgs>(path.resolve(options.argsPath));

  if (manifest.risk !== 'read_only') {
    throw new Error(`probe-api only supports read_only skills in the first version: ${manifest.risk}`);
  }
  if (!manifest.apiRegistry) {
    throw new Error('skill.json has no apiRegistry field; nothing to probe');
  }

  const logger = new JsonlLogger(ROOT_DIR, `${manifest.name}-api-probe`);
  const probeDir = path.join(ROOT_DIR, 'runs', logger.runId);
  fs.mkdirSync(probeDir, { recursive: true });
  const probeLogPath = path.join(probeDir, 'api_probe.jsonl');
  function writeProbe(type: string, message?: string, data?: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info'): void {
    const event = {
      timestamp: new Date().toISOString(),
      level,
      type,
      skill: manifest.name,
      message,
      data,
    };
    fs.appendFileSync(probeLogPath, `${JSON.stringify(event)}\n`, 'utf-8');
    logger.write({ level, type, skill: manifest.name, message, data });
  }

  const loadedRegistry = loadApiRegistry(skillDir, manifest);
  if (!loadedRegistry) {
    throw new Error('No API registry is available for this skill');
  }
  const registry = enrichRegistryMappingsFromArgs(loadedRegistry, args);
  const observationPath = path.join(probeDir, 'api_observation.json');
  const requestContext = await request.newContext({ ignoreHTTPSErrors: true });
  const api = createApiHelper({
    request: requestContext,
    logger,
    manifest,
    artifactDir: logger.artifactDir,
  });

  try {
    writeProbe('api_probe_start', undefined, {
      skillDir,
      argsPath: path.resolve(options.argsPath),
      apiRegistry: manifest.apiRegistry,
      observeGui: options.observeGui,
    });
    if (options.observeGui) {
      runGuiObservation({
        skillDir,
        argsPath: path.resolve(options.argsPath),
        outputPath: observationPath,
        headless: options.headless,
        writeProbe,
      });
    }
    const result = await runApiFastPath({
      registry,
      args,
      manifest,
      api,
      allowCandidate: true,
      log: writeProbe,
    });
    const nextRegistry = markRegistryProbed(registry, result, args);
    if (options.observeGui && fs.existsSync(observationPath)) {
      nextRegistry.lastObservation = {
        observedAt: new Date().toISOString(),
        source: 'live-gui-network',
        path: path.relative(ROOT_DIR, observationPath),
      };
    }
    saveApiRegistry(skillDir, manifest, nextRegistry);
    writeProbeSummary({
      skillDir,
      resultOk: result.ok,
      reason: result.reason,
      probeLogPath,
      observationPath: options.observeGui && fs.existsSync(observationPath) ? observationPath : undefined,
    });
    writeProbe(result.ok ? 'api_probe_success' : 'api_probe_failed', result.reason, {
      registryPath: path.join(skillDir, manifest.apiRegistry),
      probeLogPath,
    }, result.ok ? 'info' : 'warn');
    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    await requestContext.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
