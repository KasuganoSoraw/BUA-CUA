import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv } from 'ajv';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';
import { JsonlLogger } from './logger.js';
import type { SkillArgs, SkillContext, SkillManifest, SkillModule } from './types.js';

dotenv.config();

const ROOT_DIR = process.cwd();
const AUTH_STATE_PATH = path.join(ROOT_DIR, 'auth', 'storage-state.json');

type RunnerOptions = {
  skill: string;
  argsPath: string;
  headless: boolean;
  skipPreSkills: boolean;
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

function validateArgs(manifest: SkillManifest, args: SkillArgs): void {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(manifest.argsSchema);
  if (!validate(args)) {
    const details = ajv.errorsText(validate.errors, { separator: '\n' });
    throw new Error(`Invalid args for ${manifest.name}:\n${details}`);
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
}): SkillContext {
  const { manifest, logger, page, browser, browserContext, agent } = params;

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
    runId: logger.runId,
    skillName: manifest.name,
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
  const module = await loadSkillModule(params.skillDir, manifest);
  await module.run({ ...params.ctx, skillName: manifest.name }, params.args);
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const skillDir = resolveSkillDir(options.skill);
  const manifest = loadManifest(skillDir);
  const args = readJson<SkillArgs>(path.resolve(options.argsPath));
  validateArgs(manifest, args);

  const logger = new JsonlLogger(ROOT_DIR, manifest.name);
  logger.info(manifest.name, 'run_start', undefined, { skillDir, headless: options.headless });

  const browser = await chromium.launch({ headless: options.headless });
  const storageState = fs.existsSync(AUTH_STATE_PATH) ? AUTH_STATE_PATH : undefined;
  const browserContext = await browser.newContext({
    ...(storageState ? { storageState } : {}),
    ignoreHTTPSErrors: true,
  });
  const page = await browserContext.newPage();
  const agent = new PlaywrightAgent(page);
  const ctx = makeContext({ manifest, logger, page, browser, browserContext, agent });

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
