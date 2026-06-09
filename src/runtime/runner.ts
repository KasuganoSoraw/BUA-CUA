import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { runStepRecovery } from '../recovery/agent.js';
import { createRecoveryHarness } from '../recovery/harness.js';
import type { RecoveryOptions } from '../recovery/types.js';
import { JsonlLogger } from './logger.js';
import { applyProviderEnvironment, type ProviderName } from './providers.js';
import type { SkillArgs, SkillContext, SkillManifest, SkillModule } from './types.js';

dotenv.config();

const ROOT_DIR = process.cwd();
const AUTH_STATE_PATH = path.join(ROOT_DIR, 'auth', 'storage-state.json');
const MIDSCENE_FALLBACK_TIMEOUT_MS = Number.parseInt(
  process.env.BUA_CUA_MIDSCENE_FALLBACK_TIMEOUT_MS ?? '120000',
  10,
);

type RunnerOptions = {
  skill: string;
  argsPath: string;
  headless: boolean;
  skipPreSkills: boolean;
  provider?: ProviderName;
};

function parseOptions(argv: string[]): RunnerOptions {
  const options: RunnerOptions = {
    skill: '',
    argsPath: '',
    headless: false,
    skipPreSkills: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--skill') {
      options.skill = argv[++index] ?? '';
    } else if (arg === '--args') {
      options.argsPath = argv[++index] ?? '';
    } else if (arg === '--headless') {
      options.headless = true;
    } else if (arg === '--skip-pre-skills') {
      options.skipPreSkills = true;
    } else if (arg === '--qwen') {
      if (options.provider) {
        throw new Error('Use only one provider flag: --qwen or --minimax');
      }
      options.provider = 'qwen';
    } else if (arg === '--minimax') {
      if (options.provider) {
        throw new Error('Use only one provider flag: --qwen or --minimax');
      }
      options.provider = 'minimax';
    } else if (arg === '--headed') {
      options.headless = false;
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

function loadManifest(skillDir: string): SkillManifest {
  return readJson<SkillManifest>(path.join(skillDir, 'skill.json'));
}

function loadInferredIntent(skillDir: string, manifest: SkillManifest): string | undefined {
  if (!manifest.inferredIntent) {
    return undefined;
  }
  const intentPath = path.join(skillDir, manifest.inferredIntent);
  if (!fs.existsSync(intentPath)) {
    throw new Error(`Missing inferred intent file: ${intentPath}`);
  }
  return fs.readFileSync(intentPath, 'utf-8');
}

function validateArgs(manifest: SkillManifest, args: SkillArgs): void {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(manifest.argsSchema);
  if (!validate(args)) {
    const details = ajv.errorsText(validate.errors, { separator: '\n' });
    throw new Error(`Invalid args for ${manifest.name}:\n${details}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function loadSkillModule(skillDir: string, manifest: SkillManifest): Promise<SkillModule> {
  const entryPath = path.join(skillDir, manifest.entry);
  const moduleUrl = pathToFileURL(entryPath).href;
  const module = (await import(moduleUrl)) as SkillModule;
  if (typeof module.run !== 'function') {
    throw new Error(`Skill entry does not export run(ctx, args): ${entryPath}`);
  }
  return module;
}

function makeContext(params: {
  manifest: SkillManifest;
  logger: JsonlLogger;
  page: SkillContext['page'];
  browser: SkillContext['browser'];
  browserContext: SkillContext['browserContext'];
  agent: SkillContext['agent'];
  harness: SkillContext['harness'];
  inferredIntent?: string;
}): SkillContext {
  const { manifest, logger, page, browser, browserContext, agent, harness, inferredIntent } = params;

  async function screenshot(label: string): Promise<string> {
    const filename = `${label.replace(/[^a-zA-Z0-9_-]+/g, '_')}-${Date.now()}.png`;
    const screenshotPath = path.join(logger.artifactDir, filename);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  }

  return {
    page,
    browser,
    browserContext,
    agent,
    harness,
    runId: logger.runId,
    skillName: manifest.name,
    inferredIntent,
    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      logger.info(manifest.name, 'step_start', name, undefined, name);
      try {
        const result = await fn();
        logger.info(manifest.name, 'step_end', name, undefined, name);
        return result;
      } catch (error) {
        const screenshotPath = await screenshot(`failed-${name}`);
        logger.error(manifest.name, 'step_failed', error instanceof Error ? error.message : String(error), { screenshotPath }, name);
        throw error;
      }
    },
    async withFallback<T>(
      name: string,
      primary: () => Promise<T>,
      fallback: (error: unknown) => Promise<T>,
      verify?: () => Promise<void>,
    ): Promise<T> {
      return this.step(name, async () => {
        let result: T;
        try {
          logger.info(manifest.name, 'primary_start', undefined, undefined, name);
          result = await primary();
          logger.info(manifest.name, 'primary_end', undefined, undefined, name);
        } catch (error) {
          logger.warn(manifest.name, 'primary_failed', error instanceof Error ? error.message : String(error), undefined, name);
          logger.info(manifest.name, 'fallback_start', undefined, undefined, name);
          result = await fallback(error);
          logger.info(manifest.name, 'fallback_end', undefined, undefined, name);
        }
        if (verify) {
          logger.info(manifest.name, 'verify_start', undefined, undefined, name);
          await verify();
          logger.info(manifest.name, 'verify_end', undefined, undefined, name);
        }
        return result;
      });
    },
    async withRecovery<T>(
      name: string,
      primary: () => Promise<T>,
      recoveryOptions: RecoveryOptions,
      midsceneFallback: (error: unknown) => Promise<T>,
      verify?: () => Promise<void>,
    ): Promise<T> {
      return this.step(name, async () => {
        let result: T | undefined;
        let triggerError: unknown;
        let failureKind: 'primary_failed' | 'verify_failed' | 'recovery_verify_failed' = 'primary_failed';
        let primaryStatus: 'passed' | 'failed' = 'failed';

        async function runVerify(
          failureEvent: 'verify_failed' | 'recovery_verify_failed' | undefined,
        ): Promise<{ ok: true } | { ok: false; error: unknown }> {
          if (!verify) {
            return { ok: true };
          }
          logger.info(manifest.name, 'verify_start', undefined, undefined, name);
          try {
            await verify();
            logger.info(manifest.name, 'verify_end', undefined, undefined, name);
            return { ok: true };
          } catch (error) {
            if (failureEvent) {
              logger.warn(
                manifest.name,
                failureEvent,
                error instanceof Error ? error.message : String(error),
                undefined,
                name,
              );
            }
            return { ok: false, error };
          }
        }

        try {
          logger.info(manifest.name, 'primary_start', undefined, undefined, name);
          result = await primary();
          primaryStatus = 'passed';
          logger.info(manifest.name, 'primary_end', undefined, undefined, name);
        } catch (error) {
          triggerError = error;
          failureKind = 'primary_failed';
          primaryStatus = 'failed';
          logger.warn(manifest.name, 'primary_failed', error instanceof Error ? error.message : String(error), undefined, name);
        }

        if (!triggerError) {
          const initialVerify = await runVerify('verify_failed');
          if (initialVerify.ok) {
            return result as T;
          }
          triggerError = initialVerify.error;
          failureKind = 'verify_failed';
        }

        if (triggerError) {
          const recoveryResult = await runStepRecovery({
            skillName: manifest.name,
            stepName: name,
            failure: triggerError,
            failureKind,
            primaryStatus,
            options: recoveryOptions,
            harness,
            log(type, message, data, level) {
              logger.write({ level: level ?? 'info', type, skill: manifest.name, step: name, message, data });
            },
          });

          if (recoveryResult.ok) {
            const recoveryVerify = await runVerify('recovery_verify_failed');
            if (recoveryVerify.ok) {
              return (primaryStatus === 'passed' ? result : undefined) as T;
            }
            triggerError = recoveryVerify.error;
            failureKind = 'recovery_verify_failed';
          }

          const fallbackReason = recoveryResult.ok
            ? errorMessage(triggerError)
            : recoveryResult.reason;
          logger.warn(manifest.name, 'midscene_fallback_start', fallbackReason, undefined, name);
          try {
            result = await withTimeout(
              `Midscene fallback for step "${name}"`,
              midsceneFallback(triggerError),
              MIDSCENE_FALLBACK_TIMEOUT_MS,
            );
            logger.info(manifest.name, 'midscene_fallback_end', undefined, undefined, name);
          } catch (error) {
            logger.warn(
              manifest.name,
              'midscene_fallback_failed',
              error instanceof Error ? error.message : String(error),
              { timeoutMs: MIDSCENE_FALLBACK_TIMEOUT_MS },
              name,
            );
            throw error;
          }
          if (verify) {
            logger.info(manifest.name, 'verify_start', undefined, undefined, name);
            await verify();
            logger.info(manifest.name, 'verify_end', undefined, undefined, name);
          }
        }

        return result as T;
      });
    },
    async recoverStep(
      name: string,
      recoveryOptions: RecoveryOptions,
      midsceneFallback?: (error: unknown) => Promise<void>,
      verify?: () => Promise<void>,
    ): Promise<void> {
      return this.step(name, async () => {
        const recoveryResult = await runStepRecovery({
          skillName: manifest.name,
          stepName: name,
          failure: new Error('No Playwright primary was provided for this recovery-driven step'),
          options: recoveryOptions,
          harness,
          log(type, message, data, level) {
            logger.write({ level: level ?? 'info', type, skill: manifest.name, step: name, message, data });
          },
        });

        if (!recoveryResult.ok) {
          if (!recoveryResult.skipped && verify) {
            try {
              logger.info(manifest.name, 'recovery_verify_start', undefined, undefined, name);
              await verify();
              logger.info(manifest.name, 'recovery_success_by_verifier', recoveryResult.reason, undefined, name);
              return;
            } catch (verifyError) {
              logger.warn(
                manifest.name,
                'recovery_verify_failed',
                verifyError instanceof Error ? verifyError.message : String(verifyError),
                undefined,
                name,
              );
            }
          }
          logger.warn(manifest.name, 'midscene_fallback_start', recoveryResult.reason, undefined, name);
          if (!midsceneFallback) {
            throw new Error(`Recovery step failed: ${recoveryResult.reason ?? 'unknown'}`);
          }
          try {
            await withTimeout(
              `Midscene fallback for step "${name}"`,
              midsceneFallback(new Error(recoveryResult.reason ?? 'recovery_failed')),
              MIDSCENE_FALLBACK_TIMEOUT_MS,
            );
            logger.info(manifest.name, 'midscene_fallback_end', undefined, undefined, name);
          } catch (error) {
            logger.warn(
              manifest.name,
              'midscene_fallback_failed',
              error instanceof Error ? error.message : String(error),
              { timeoutMs: MIDSCENE_FALLBACK_TIMEOUT_MS },
              name,
            );
            throw error;
          }
        }

        if (verify) {
          logger.info(manifest.name, 'verify_start', undefined, undefined, name);
          await verify();
          logger.info(manifest.name, 'verify_end', undefined, undefined, name);
        }
      });
    },
    log(type: string, message?: string, data?: Record<string, unknown>, level = 'info') {
      logger.write({ level, type, skill: manifest.name, message, data });
    },
    screenshot,
    async saveStorageState(outputPath = AUTH_STATE_PATH): Promise<void> {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      await browserContext.storageState({ path: outputPath });
      logger.info(manifest.name, 'storage_state_saved', outputPath);
    },
    fail(message: string): never {
      throw new Error(message);
    },
  };
}

async function runSkill(params: {
  skillDir: string;
  args: SkillArgs;
  ctx: SkillContext;
}): Promise<void> {
  const manifest = loadManifest(params.skillDir);
  validateArgs(manifest, params.args);
  const inferredIntent = loadInferredIntent(params.skillDir, manifest);
  const module = await loadSkillModule(params.skillDir, manifest);
  await module.run({ ...params.ctx, skillName: manifest.name, inferredIntent }, params.args);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  applyProviderEnvironment(options.provider);
  const skillDir = resolveSkillDir(options.skill);
  const manifest = loadManifest(skillDir);
  const inferredIntent = loadInferredIntent(skillDir, manifest);
  const args = readJson<SkillArgs>(path.resolve(options.argsPath));
  validateArgs(manifest, args);

  const logger = new JsonlLogger(ROOT_DIR, manifest.name);
  logger.info(manifest.name, 'run_start', undefined, {
    skillDir,
    headless: options.headless,
    provider: options.provider ?? 'env',
    inferredIntent: manifest.inferredIntent,
  });
  if (inferredIntent) {
    logger.info(manifest.name, 'inferred_intent_loaded', undefined, {
      path: manifest.inferredIntent,
      chars: inferredIntent.length,
    });
  }

  const browser = await chromium.launch({ headless: options.headless });
  const storageState = fs.existsSync(AUTH_STATE_PATH) ? AUTH_STATE_PATH : undefined;
  const browserContext = await browser.newContext({
    ...(storageState ? { storageState } : {}),
    ignoreHTTPSErrors: true,
    acceptDownloads: true,
  });
  const page = await browserContext.newPage();
  const agent = new PlaywrightAgent(page);
  const harness = await createRecoveryHarness({
    page,
    browserContext,
    artifactDir: logger.artifactDir,
  });
  const ctx = makeContext({ manifest, logger, page, browser, browserContext, agent, harness, inferredIntent });

  try {
    if (!options.skipPreSkills) {
      for (const preSkill of manifest.preSkills ?? []) {
        const preSkillDir = resolveSkillDir(preSkill);
        logger.info(manifest.name, 'pre_skill_start', preSkill);
        await runSkill({ skillDir: preSkillDir, args: {}, ctx });
        logger.info(manifest.name, 'pre_skill_end', preSkill);
      }
    }

    await runSkill({ skillDir, args, ctx });
    logger.info(manifest.name, 'run_end');
  } catch (error) {
    const screenshotPath = await ctx.screenshot('run-failed');
    logger.error(
      manifest.name,
      'run_failed',
      error instanceof Error ? error.message : String(error),
      { screenshotPath },
    );
    process.exitCode = 1;
  } finally {
    if (typeof agent.destroy === 'function') {
      await agent.destroy();
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
