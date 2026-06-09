import type { RecoveryHarness } from './harness.js';

export type RecoveryToolName =
  | 'screenshot'
  | 'viewportScreenshot'
  | 'fullPageScreenshot'
  | 'jsProbe'
  | 'inspectAt'
  | 'domAct'
  | 'clickAt'
  | 'cdp';

export type RecoveryOptions = {
  goal: string;
  hints?: string[];
  allowedTools?: RecoveryToolName[];
  maxTurns?: number;
  risk?: string;
};

export type RecoveryRequest = {
  skillName: string;
  stepName: string;
  failure: unknown;
  failureKind?: 'primary_failed' | 'verify_failed' | 'recovery_verify_failed';
  primaryStatus?: 'passed' | 'failed' | 'not_run';
  options: RecoveryOptions;
  harness: RecoveryHarness;
  log(type: string, message?: string, data?: Record<string, unknown>, level?: 'info' | 'warn' | 'error'): void;
};

export type RecoveryResult = {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  evidence?: Record<string, unknown>;
};
