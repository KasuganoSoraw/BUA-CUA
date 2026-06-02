import type { Browser, BrowserContext, Page } from 'playwright';
import type { RecoveryHarness } from '../recovery/harness.js';

export type SkillArgs = Record<string, unknown>;

export type SkillManifest = {
  name: string;
  type: 'task';
  version: string;
  description?: string;
  entry: string;
  risk: 'read_only' | 'write_review_required' | 'destructive_review_required';
  requiresSession?: boolean;
  preSkills?: string[];
  argsSchema: Record<string, unknown>;
};

export type LogLevel = 'info' | 'warn' | 'error';

export type RuntimeEvent = {
  runId: string;
  timestamp: string;
  level: LogLevel;
  type: string;
  skill: string;
  step?: string;
  message?: string;
  data?: Record<string, unknown>;
};

export type SkillContext = {
  page: Page;
  browser: Browser;
  browserContext: BrowserContext;
  agent: any;
  harness: RecoveryHarness;
  runId: string;
  skillName: string;
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  withFallback<T>(
    name: string,
    primary: () => Promise<T>,
    fallback: (error: unknown) => Promise<T>,
    verify?: () => Promise<void>,
  ): Promise<T>;
  log(type: string, message?: string, data?: Record<string, unknown>, level?: LogLevel): void;
  screenshot(label: string): Promise<string>;
  saveStorageState(path?: string): Promise<void>;
  fail(message: string): never;
};

export type SkillModule = {
  run(ctx: SkillContext, args: SkillArgs): Promise<void>;
};
