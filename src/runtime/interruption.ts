import type { Locator, Page } from 'playwright';
import type { ActionOptions, LogLevel, SkillManifest } from './types.js';

const DEFAULT_SAFE_LABELS = [
  'close',
  'ok',
  'okay',
  'cancel',
  'dismiss',
  'got it',
  'i understand',
  'understood',
  '知道了',
  '关闭',
  '取消',
  '确定',
  '我知道了',
];

const DEFAULT_FORBIDDEN_LABELS = [
  'submit',
  'confirm',
  'delete',
  'remove',
  'pay',
  'purchase',
  'checkout',
  'download',
  'apply',
  'save',
  'send',
  'place order',
  '提交',
  '确认',
  '删除',
  '移除',
  '支付',
  '购买',
  '下载',
  '应用',
  '保存',
  '发送',
];

const DEFAULT_FORBIDDEN_TEXT = [
  'delete',
  'remove',
  'payment',
  'purchase',
  'checkout',
  'download',
  'submit',
  'confirm submission',
  'irreversible',
  'permanent',
  '删除',
  '支付',
  '购买',
  '下载',
  '提交',
  '不可撤销',
];

type InterruptionLog = (
  type: string,
  message?: string,
  data?: Record<string, unknown>,
  level?: LogLevel,
) => void;

export type InterruptionResult =
  | { dismissed: true; method: 'dom' | 'midscene'; evidence?: Record<string, unknown> }
  | { dismissed: false; reason: string; evidence?: Record<string, unknown> };

export async function maybeDismissInterruption(params: {
  page: Page;
  agent: any;
  manifest: SkillManifest;
  actionName: string;
  cause: unknown;
  options?: ActionOptions;
  log: InterruptionLog;
}): Promise<InterruptionResult> {
  const { page, agent, manifest, actionName, cause, log } = params;
  const options = normalizeOptions(params.options, manifest);
  if (options.interruption === 'disabled' || options.retries <= 0) {
    log('interruption_noop', 'interruption disabled', { actionName }, 'info');
    return { dismissed: false, reason: 'disabled' };
  }

  log('interruption_check_start', errorMessage(cause), { actionName }, 'info');

  try {
    const candidate = await findDismissibleInterruption(page, options);
    if (candidate.status === 'forbidden') {
      log('interruption_noop', 'visible dialog looks business-critical', candidate.evidence, 'info');
      return { dismissed: false, reason: 'forbidden_dialog', evidence: candidate.evidence };
    }
    if (candidate.status === 'found') {
      log('interruption_detected', 'dismissible dialog candidate found', candidate.evidence, 'warn');
      log('interruption_dismissed', 'dismissed by DOM rule', candidate.evidence, 'warn');
      return { dismissed: true, method: 'dom', evidence: candidate.evidence };
    }
  } catch (error) {
    log('interruption_failed', errorMessage(error), { actionName, phase: 'dom' }, 'warn');
  }

  if (!options.useMidscene || !agent?.aiTap) {
    log('interruption_noop', 'no dismissible interruption found', { actionName }, 'info');
    return { dismissed: false, reason: 'not_found' };
  }

  if (options.risk !== 'read_only') {
    log('interruption_noop', 'midscene interruption handling disabled for non-read-only action', {
      actionName,
      risk: options.risk,
    }, 'info');
    return { dismissed: false, reason: 'non_read_only_midscene_disabled' };
  }

  try {
    const safeLabels = options.safeLabels.join(', ');
    const forbiddenLabels = options.forbiddenLabels.join(', ');
    log('interruption_detected', 'trying Midscene non-business dialog dismiss', { actionName }, 'warn');
    await agent.aiTap(
      [
        'If there is a visible non-business interruption dialog, dismiss it safely.',
        `Only click one of these safe controls if present: ${safeLabels}.`,
        `Do not click business-progressing controls such as: ${forbiddenLabels}.`,
        'Do not submit, confirm, delete, download, apply, pay, save, or continue the business workflow.',
        'If no safe non-business interruption is visible, do nothing.',
      ].join(' '),
    );
    await page.waitForTimeout(500);
    log('interruption_dismissed', 'Midscene dismiss attempted', { actionName }, 'warn');
    return { dismissed: true, method: 'midscene' };
  } catch (error) {
    log('interruption_failed', errorMessage(error), { actionName, phase: 'midscene' }, 'warn');
    return { dismissed: false, reason: errorMessage(error) };
  }
}

function normalizeOptions(options: ActionOptions | undefined, manifest: SkillManifest): Required<ActionOptions> {
  const manifestRisk = manifest.risk === 'read_only' ? 'read_only' : manifest.risk;
  const risk = options?.risk ?? manifestRisk;
  return {
    interruption: options?.interruption ?? 'dismiss-non-business',
    retries: options?.retries ?? 1,
    useMidscene: options?.useMidscene ?? true,
    safeLabels: options?.safeLabels ?? DEFAULT_SAFE_LABELS,
    forbiddenLabels: options?.forbiddenLabels ?? DEFAULT_FORBIDDEN_LABELS,
    forbiddenText: options?.forbiddenText ?? DEFAULT_FORBIDDEN_TEXT,
    risk,
  };
}

async function findDismissibleInterruption(
  page: Page,
  options: Required<ActionOptions>,
): Promise<
  | { status: 'none'; evidence?: Record<string, unknown> }
  | { status: 'forbidden'; evidence: Record<string, unknown> }
  | { status: 'found'; evidence: Record<string, unknown> }
> {
  const safeLabels = options.safeLabels.map((label) => label.toLowerCase());
  const forbiddenLabels = options.forbiddenLabels.map((label) => label.toLowerCase());
  const forbiddenText = options.forbiddenText.map((label) => label.toLowerCase());
  const dialogSelector = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[aria-modal="true"]',
    'dialog',
    '.modal',
    '.dialog',
    '.popup',
    '.overlay',
    '.toast',
    '.notification',
    '.el-dialog',
    '.ant-modal',
    '.modal-dialog',
  ].join(',');
  const buttonSelector = [
    'button',
    '[role="button"]',
    'a',
    'input[type="button"]',
    'input[type="submit"]',
  ].join(',');

  const roots = page.locator(dialogSelector);
  const rootCount = Math.min(await roots.count(), 10);
  let visibleDialogCount = 0;

  for (let rootIndex = 0; rootIndex < rootCount; rootIndex += 1) {
    const root = roots.nth(rootIndex);
    if (!(await isLocatorVisible(root))) {
      continue;
    }
    visibleDialogCount += 1;
    const rootText = (await locatorText(root)).slice(0, 600);
    const buttons = root.locator(buttonSelector);
    const buttonCount = Math.min(await buttons.count(), 12);
    const buttonEvidence: Array<{ text: string; index: number }> = [];
    let safeButton: Locator | undefined;
    let safeButtonText = '';

    for (let buttonIndex = 0; buttonIndex < buttonCount; buttonIndex += 1) {
      const button = buttons.nth(buttonIndex);
      if (!(await isLocatorVisible(button))) {
        continue;
      }
      const text = (await locatorText(button)).slice(0, 120);
      buttonEvidence.push({ text, index: buttonIndex });
      if (!safeButton && matchesAny(text, safeLabels)) {
        safeButton = button;
        safeButtonText = text;
      }
    }

    const hasForbiddenText = matchesAny(rootText, forbiddenText);
    const hasForbiddenButton = buttonEvidence.some((button) => matchesAny(button.text, forbiddenLabels));
    const evidence = {
      rootIndex,
      rootText,
      buttons: buttonEvidence,
      hasForbiddenText,
      hasForbiddenButton,
    };

    if (hasForbiddenText || hasForbiddenButton) {
      return { status: 'forbidden', evidence };
    }
    if (safeButton) {
      await safeButton.click({ timeout: 3000 });
      await page.waitForTimeout(300);
      return {
        status: 'found',
        evidence: {
          ...evidence,
          buttonText: safeButtonText,
        },
      };
    }
  }

  return { status: 'none', evidence: { visibleDialogCount } };
}

async function isLocatorVisible(locator: Locator): Promise<boolean> {
  return await locator.isVisible({ timeout: 300 }).catch(() => false);
}

async function locatorText(locator: Locator): Promise<string> {
  const value = await locator.inputValue({ timeout: 300 }).catch(() => '');
  if (value) {
    return normalizeText(value);
  }
  const ariaLabel = await locator.getAttribute('aria-label', { timeout: 300 }).catch(() => '');
  if (ariaLabel) {
    return normalizeText(ariaLabel);
  }
  const title = await locator.getAttribute('title', { timeout: 300 }).catch(() => '');
  if (title) {
    return normalizeText(title);
  }
  return normalizeText(await locator.innerText({ timeout: 300 }).catch(() => ''));
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function matchesAny(text: string, labels: string[]): boolean {
  const lower = text.toLowerCase();
  return labels.some((label) => lower === label || lower.includes(label));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
