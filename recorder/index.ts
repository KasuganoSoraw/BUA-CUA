import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type {
  ActionRecord,
  DomEvidence,
  PointerEvidence,
  RecordingIndex,
  RecorderActionType,
  SelectorCandidate,
  StateDelta,
  TargetEvidence,
} from './types.js';

type RecorderArgs = {
  task: string;
  url: string;
  output: string;
  userDataDir?: string;
  channel?: string;
};

type BrowserEventPayload = {
  type: RecorderActionType;
  timestamp: string;
  pointer?: PointerEvidence;
  target?: TargetEvidence;
  selectorCandidates: SelectorCandidate[];
  domEvidence: DomEvidence;
};

type PageSnapshot = {
  url: string;
  title: string;
  focusedSignature?: string;
  visibleText: string[];
  hasDialog: boolean;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function parseArgs(argv: string[]): RecorderArgs {
  const parsed: Partial<RecorderArgs> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--task') {
      parsed.task = argv[++index];
    } else if (token === '--url') {
      parsed.url = argv[++index];
    } else if (token === '--output') {
      parsed.output = argv[++index];
    } else if (token === '--user-data-dir') {
      parsed.userDataDir = argv[++index];
    } else if (token === '--channel') {
      parsed.channel = argv[++index];
    }
  }

  if (!parsed.task || !parsed.url) {
    throw new Error('Usage: tsx recorder/index.ts --task <task_name> --url <url> [--output <dir>]');
  }

  return {
    task: parsed.task,
    url: parsed.url,
    output: parsed.output ?? path.join(rootDir, 'inputs', parsed.task, 'recording'),
    userDataDir: parsed.userDataDir,
    channel: parsed.channel ?? process.env.BUA_CUA_RECORDER_CHANNEL,
  };
}

function relativeToRecording(recordingDir: string, filePath: string): string {
  return path.relative(recordingDir, filePath).replaceAll(path.sep, '/');
}

function targetSummary(target?: TargetEvidence): string | undefined {
  if (!target) {
    return undefined;
  }
  const text = target.accessibleName || target.labelText || target.text || target.id || target.className;
  return [target.tagName, text].filter(Boolean).join(' ');
}

function visibleTextDelta(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((item) => !beforeSet.has(item)).slice(0, 20);
  const removed = before.filter((item) => !afterSet.has(item)).slice(0, 20);
  return { added, removed };
}

function computeStateDelta(before: PageSnapshot, after: PageSnapshot): StateDelta {
  const textDelta = visibleTextDelta(before.visibleText, after.visibleText);
  return {
    urlChanged: before.url !== after.url,
    titleChanged: before.title !== after.title,
    focusedElementChanged: before.focusedSignature !== after.focusedSignature,
    dialogAppeared: !before.hasDialog && after.hasDialog,
    visibleTextAdded: textDelta.added,
    visibleTextRemoved: textDelta.removed,
  };
}

async function safeSnapshot(page: Page): Promise<PageSnapshot> {
  try {
    return await page.evaluate(() => {
      const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim();
      const focused = document.activeElement as HTMLElement | null;
      const focusedSignature = focused
        ? [
            focused.tagName.toLowerCase(),
            focused.getAttribute('role'),
            focused.getAttribute('aria-label'),
            focused.getAttribute('name'),
            focused.id,
          ]
            .filter(Boolean)
            .join('#')
        : undefined;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const visibleText: string[] = [];
      while (visibleText.length < 120) {
        const node = walker.nextNode();
        if (!node) {
          break;
        }
        const text = normalize(node.textContent);
        if (!text || text.length < 2) {
          continue;
        }
        const parent = node.parentElement;
        if (!parent) {
          continue;
        }
        const style = window.getComputedStyle(parent);
        if (style.visibility === 'hidden' || style.display === 'none') {
          continue;
        }
        visibleText.push(text.slice(0, 160));
      }
      return {
        url: location.href,
        title: document.title,
        focusedSignature,
        visibleText,
        hasDialog: Boolean(document.querySelector('[role="dialog"], dialog[open], .modal, .ant-modal, .el-dialog')),
      };
    });
  } catch {
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      visibleText: [],
      hasDialog: false,
    };
  }
}

async function safeScreenshot(page: Page, outputPath: string): Promise<boolean> {
  try {
    await page.screenshot({ path: outputPath, fullPage: false, timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

async function safeAnnotatedScreenshot(
  page: Page,
  outputPath: string,
  pointer: PointerEvidence,
): Promise<boolean> {
  try {
    await page.evaluate(({ x, y }) => {
      const existing = document.getElementById('__bua_cua_pointer_marker__');
      existing?.remove();

      const root = document.createElement('div');
      root.id = '__bua_cua_pointer_marker__';
      root.setAttribute('data-bua-cua-artificial-marker', 'true');
      root.style.position = 'fixed';
      root.style.left = '0';
      root.style.top = '0';
      root.style.width = '0';
      root.style.height = '0';
      root.style.zIndex = '2147483647';
      root.style.pointerEvents = 'none';

      const target = document.createElement('div');
      target.style.position = 'fixed';
      target.style.left = `${x - 18}px`;
      target.style.top = `${y - 18}px`;
      target.style.width = '36px';
      target.style.height = '36px';
      target.style.border = '4px solid #ff1744';
      target.style.borderRadius = '999px';
      target.style.boxSizing = 'border-box';
      target.style.boxShadow = '0 0 0 3px rgba(255,255,255,0.95), 0 0 18px rgba(255,23,68,0.8)';
      target.style.background = 'rgba(255,23,68,0.08)';

      const horizontal = document.createElement('div');
      horizontal.style.position = 'fixed';
      horizontal.style.left = `${x - 24}px`;
      horizontal.style.top = `${y - 1}px`;
      horizontal.style.width = '48px';
      horizontal.style.height = '2px';
      horizontal.style.background = '#ff1744';
      horizontal.style.boxShadow = '0 0 0 1px white';

      const vertical = document.createElement('div');
      vertical.style.position = 'fixed';
      vertical.style.left = `${x - 1}px`;
      vertical.style.top = `${y - 24}px`;
      vertical.style.width = '2px';
      vertical.style.height = '48px';
      vertical.style.background = '#ff1744';
      vertical.style.boxShadow = '0 0 0 1px white';

      const dot = document.createElement('div');
      dot.style.position = 'fixed';
      dot.style.left = `${x - 4}px`;
      dot.style.top = `${y - 4}px`;
      dot.style.width = '8px';
      dot.style.height = '8px';
      dot.style.borderRadius = '999px';
      dot.style.background = '#ff1744';
      dot.style.boxShadow = '0 0 0 2px white';

      root.append(target, horizontal, vertical, dot);
      document.documentElement.append(root);
    }, pointer);

    await page.screenshot({ path: outputPath, fullPage: false, timeout: 10000 });
    return true;
  } catch {
    return false;
  } finally {
    await page.evaluate(() => {
      document.getElementById('__bua_cua_pointer_marker__')?.remove();
    }).catch(() => undefined);
  }
}

async function waitForActionResult(page: Page, urlBefore: string): Promise<void> {
  await Promise.race([
    page.waitForURL((url) => url.toString() !== urlBefore, { timeout: 5000 }).catch(() => undefined),
    page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined),
    page.waitForTimeout(900),
  ]);
  await page.waitForLoadState('load', { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(500).catch(() => undefined);
}

async function installRecorderScript(page: Page): Promise<void> {
  const script = () => {
    type AnyRecord = Record<string, unknown>;
    const win = window as typeof window & {
      __buaCuaRecorderInstalled?: boolean;
      __buaCuaRecordAction?: (payload: AnyRecord) => Promise<void>;
      __buaCuaInputTimers?: WeakMap<Element, number>;
      __buaCuaInputLastValues?: WeakMap<Element, string>;
    };
    if (win.__buaCuaRecorderInstalled) {
      return;
    }
    win.__buaCuaRecorderInstalled = true;
    win.__buaCuaInputTimers = new WeakMap<Element, number>();
    win.__buaCuaInputLastValues = new WeakMap<Element, string>();
    console.info('[bua-cua-recorder] installed');

    const normalize = (value: string | null | undefined) => (value || '').replace(/\s+/g, ' ').trim();
    const rectOf = (element: Element | null) => {
      if (!element) {
        return undefined;
      }
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    };
    const textOf = (element: Element | null) => normalize(element?.textContent).slice(0, 240);
    const labelFor = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) {
        return undefined;
      }
      const id = element.id;
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (label) {
          return textOf(label);
        }
      }
      const wrappingLabel = element.closest('label');
      return wrappingLabel ? textOf(wrappingLabel) : undefined;
    };
    const accessibleNameOf = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) {
        return undefined;
      }
      return (
        normalize(element.getAttribute('aria-label')) ||
        normalize(element.getAttribute('title')) ||
        labelFor(element) ||
        normalize(element.getAttribute('placeholder')) ||
        textOf(element)
      );
    };
    const summarizeValue = (element: Element | null) => {
      if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement)) {
        return undefined;
      }
      const value = element.value || '';
      if (!value) {
        return '';
      }
      return value.length > 80 ? `${value.slice(0, 80)}...` : value;
    };
    const elementInfo = (element: Element | null) => {
      if (!(element instanceof HTMLElement || element instanceof SVGElement)) {
        return undefined;
      }
      const html = element as HTMLElement;
      return {
        tagName: element.tagName.toLowerCase(),
        role: html.getAttribute('role') || undefined,
        accessibleName: accessibleNameOf(element),
        text: textOf(element),
        labelText: labelFor(element),
        id: html.id || undefined,
        className: typeof html.className === 'string' ? html.className : undefined,
        name: html.getAttribute('name') || undefined,
        type: html.getAttribute('type') || undefined,
        valueSummary: summarizeValue(element),
        boundingBox: rectOf(element),
      };
    };
    const cssCandidate = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) {
        return undefined;
      }
      if (element.id) {
        return `#${CSS.escape(element.id)}`;
      }
      const tag = element.tagName.toLowerCase();
      const classes = typeof element.className === 'string'
        ? element.className.split(/\s+/).filter(Boolean).slice(0, 3)
        : [];
      if (classes.length) {
        return `${tag}.${classes.map((item) => CSS.escape(item)).join('.')}`;
      }
      const name = element.getAttribute('name');
      if (name) {
        return `${tag}[name="${CSS.escape(name)}"]`;
      }
      return tag;
    };
    const selectorCandidates = (element: Element | null) => {
      const candidates: Array<AnyRecord> = [];
      if (!(element instanceof HTMLElement)) {
        return candidates;
      }
      const role = element.getAttribute('role') || undefined;
      const name = accessibleNameOf(element);
      if (role && name) {
        candidates.push({ kind: 'role', value: `${role}[name="${name}"]`, confidence: 0.86, reason: 'role + accessible name' });
      }
      const label = labelFor(element);
      if (label) {
        candidates.push({ kind: 'label', value: label, confidence: 0.82, reason: 'associated label text' });
      }
      const text = textOf(element);
      if (text && text.length <= 80) {
        candidates.push({ kind: 'text', value: text, confidence: 0.62, reason: 'visible target text' });
      }
      const testId = element.getAttribute('data-testid') || element.getAttribute('data-test-id') || element.getAttribute('data-test');
      if (testId) {
        candidates.push({ kind: 'testId', value: testId, confidence: 0.9, reason: 'test id attribute' });
      }
      const css = cssCandidate(element);
      if (css) {
        candidates.push({ kind: 'css', value: css, confidence: element.id ? 0.72 : 0.4, reason: 'local CSS selector candidate' });
      }
      return candidates.slice(0, 8);
    };
    const nearbyText = (element: Element | null) => {
      const values: string[] = [];
      const push = (value: string | undefined) => {
        const clean = normalize(value);
        if (clean && !values.includes(clean)) {
          values.push(clean.slice(0, 160));
        }
      };
      let current: Element | null = element;
      for (let depth = 0; current && depth < 4; depth += 1) {
        push(textOf(current));
        for (const sibling of Array.from(current.parentElement?.children || []).slice(0, 12)) {
          push(textOf(sibling));
        }
        current = current.parentElement;
      }
      return values.filter((item) => item.length >= 2).slice(0, 20);
    };
    const contextFor = (target: Element | null) => {
      const form = target?.closest('form');
      const tableCell = target?.closest('td, th');
      const dialog = target?.closest('[role="dialog"], dialog, .modal, .ant-modal, .el-dialog');
      return {
        formContext: form ? { text: textOf(form).slice(0, 400), action: form.getAttribute('action') || undefined } : undefined,
        tableContext: tableCell ? { cellText: textOf(tableCell), rowText: textOf(tableCell.closest('tr')).slice(0, 400) } : undefined,
        dialogContext: dialog ? { text: textOf(dialog).slice(0, 400), role: dialog.getAttribute('role') || undefined } : undefined,
      };
    };
    const stackAt = (x: number, y: number) => document.elementsFromPoint(x, y).slice(0, 8).map(elementInfo).filter(Boolean);
    const dispatch = (type: string, event: Event, pointer?: { x: number; y: number }) => {
      const timestamp = new Date().toISOString();
      try {
        const target = event.target instanceof Element ? event.target : null;
        const stack = pointer ? stackAt(pointer.x, pointer.y) : [elementInfo(target)].filter(Boolean);
        const contexts = contextFor(target);
        void win.__buaCuaRecordAction?.({
          type,
          timestamp,
          pointer: pointer ? { x: pointer.x, y: pointer.y, coordinateSpace: 'viewport' } : undefined,
          target: elementInfo(target),
          selectorCandidates: selectorCandidates(target),
          domEvidence: {
            elementStack: stack,
            nearbyText: nearbyText(target),
            ...contexts,
          },
        });
      } catch (error) {
        console.warn('[bua-cua-recorder] dispatch evidence failed', error);
        void win.__buaCuaRecordAction?.({
          type,
          timestamp,
          pointer: pointer ? { x: pointer.x, y: pointer.y, coordinateSpace: 'viewport' } : undefined,
          selectorCandidates: [],
          domEvidence: {
            elementStack: [],
            nearbyText: [],
          },
        });
      }
    };

    document.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) {
        return;
      }
      dispatch('click', event, { x: event.clientX, y: event.clientY });
    }, true);
    document.addEventListener('input', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) {
        return;
      }
      const existing = win.__buaCuaInputTimers?.get(target);
      if (existing) {
        window.clearTimeout(existing);
      }
      const timer = window.setTimeout(() => {
        const value = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
          ? target.value
          : normalize(target.textContent);
        if (win.__buaCuaInputLastValues?.get(target) === value) {
          return;
        }
        win.__buaCuaInputLastValues?.set(target, value);
        dispatch('input', event);
      }, 1500);
      win.__buaCuaInputTimers?.set(target, timer);
    }, true);
    document.addEventListener('change', (event) => {
      const target = event.target;
      const type = target instanceof HTMLSelectElement ? 'select' : 'input';
      dispatch(type, event);
    }, true);
    document.addEventListener('keydown', (event) => {
      if (['Enter', 'Escape', 'Tab'].includes(event.key)) {
        dispatch('keypress', event);
      }
    }, true);
  };

  const content = `(() => {
    const __name = (target) => target;
    (${script.toString()})();
  })();`;
  await page.addInitScript({ content });
  await page.evaluate((source) => {
    const run = new Function(source);
    run();
  }, content).catch(() => undefined);
}

async function runRecorder(args: RecorderArgs): Promise<void> {
  const recordingDir = path.resolve(args.output);
  const actionsDir = path.join(recordingDir, 'actions');
  const screenshotsDir = path.join(recordingDir, 'screenshots');
  await fs.mkdir(actionsDir, { recursive: true });
  await fs.mkdir(screenshotsDir, { recursive: true });

  let browser: Browser | undefined;
  let context: BrowserContext;
  if (args.userDataDir) {
    context = await chromium.launchPersistentContext(path.resolve(args.userDataDir), {
      headless: false,
      channel: args.channel,
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
  } else {
    browser = await chromium.launch({
      headless: false,
      channel: args.channel,
    });
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
    });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const index: RecordingIndex = {
    schemaVersion: 1,
    taskName: args.task,
    startUrl: args.url,
    startedAt: new Date().toISOString(),
    browser: 'chromium',
    viewport: { width: 1280, height: 900 },
    actions: [],
  };
  let actionCount = 0;
  let isClosing = false;
  let finishPromise: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();

  const saveIndex = async () => {
    index.endedAt = new Date().toISOString();
    await fs.writeFile(path.join(recordingDir, 'recording.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
  };

  const recordPayload = async (sourcePage: Page, payload: BrowserEventPayload) => {
    actionCount += 1;
    const id = `action-${String(actionCount).padStart(3, '0')}`;
    const beforeSnapshot = await safeSnapshot(sourcePage);
    const beforeScreenshot = path.join(screenshotsDir, `${id}-before.png`);
    await safeScreenshot(sourcePage, beforeScreenshot);
    const annotatedScreenshot = payload.pointer ? path.join(screenshotsDir, `${id}-annotated.png`) : undefined;
    if (annotatedScreenshot && payload.pointer) {
      await safeAnnotatedScreenshot(sourcePage, annotatedScreenshot, payload.pointer);
    }

    await waitForActionResult(sourcePage, beforeSnapshot.url);

    const afterSnapshot = await safeSnapshot(sourcePage);
    const afterScreenshot = path.join(screenshotsDir, `${id}-after.png`);
    await safeScreenshot(sourcePage, afterScreenshot);

    const action: ActionRecord = {
      id,
      type: payload.type,
      timestamp: payload.timestamp,
      urlBefore: beforeSnapshot.url,
      urlAfter: afterSnapshot.url,
      titleBefore: beforeSnapshot.title,
      titleAfter: afterSnapshot.title,
      viewport: index.viewport,
      pointer: payload.pointer,
      target: payload.target,
      selectorCandidates: payload.selectorCandidates,
      domEvidence: payload.domEvidence,
      screenshots: {
        beforeViewport: relativeToRecording(recordingDir, beforeScreenshot),
        afterViewport: relativeToRecording(recordingDir, afterScreenshot),
        annotatedViewport: annotatedScreenshot ? relativeToRecording(recordingDir, annotatedScreenshot) : undefined,
      },
      annotation:
        annotatedScreenshot && payload.pointer
          ? {
              kind: 'pointer-marker',
              screenshot: relativeToRecording(recordingDir, annotatedScreenshot),
              coordinateSpace: 'viewport',
              x: payload.pointer.x,
              y: payload.pointer.y,
              note:
                'The red crosshair marker was added by BUA-CUA recorder on the pre-action viewport screenshot to indicate the human operation point. It is not part of the original web page UI.',
            }
          : undefined,
      stateDelta: computeStateDelta(beforeSnapshot, afterSnapshot),
    };
    const actionFile = path.join(actionsDir, `${id}.json`);
    await fs.writeFile(actionFile, `${JSON.stringify(action, null, 2)}\n`, 'utf-8');
    index.actions.push({
      id,
      type: payload.type,
      timestamp: payload.timestamp,
      actionFile: relativeToRecording(recordingDir, actionFile),
      beforeViewport: action.screenshots.beforeViewport,
      afterViewport: action.screenshots.afterViewport,
      annotatedViewport: action.screenshots.annotatedViewport,
      urlBefore: action.urlBefore,
      urlAfter: action.urlAfter,
      targetSummary: targetSummary(payload.target),
    });
    await saveIndex();
    console.log(`[recorded] ${id} ${payload.type} ${targetSummary(payload.target) ?? ''}`);
  };

  await context.exposeBinding('__buaCuaRecordAction', (source: { page: Page }, payload: BrowserEventPayload) => {
    if (isClosing) {
      return;
    }
    console.log(`[recorder] event ${payload.type} queued`);
    const task = recordPayload(source.page, payload).catch((error: unknown) => {
      console.error('[recorder] failed to record action:', error);
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  });

  const openPages = new Set<Page>();
  const setupPage = async (targetPage: Page) => {
    openPages.add(targetPage);
    targetPage.on('console', (message) => {
      const text = message.text();
      if (text.includes('bua-cua-recorder')) {
        console.log(`[page:${message.type()}] ${text}`);
      }
    });
    targetPage.on('pageerror', (error) => {
      console.error(`[page:error] ${error.message}`);
    });
    targetPage.on('framenavigated', async (frame) => {
      if (frame === targetPage.mainFrame()) {
        await installRecorderScript(targetPage).catch(() => undefined);
      }
    });
    targetPage.once('close', () => {
      openPages.delete(targetPage);
      if (openPages.size === 0) {
        void finish();
      }
    });
    await installRecorderScript(targetPage);
  };

  context.on('page', (newPage) => {
    void setupPage(newPage);
  });
  await setupPage(page);
  console.log(`[recorder] Opened ${args.url}`);
  console.log('[recorder] Operate the browser manually. Close the browser or press Ctrl+C to finish.');
  await page.goto(args.url, { waitUntil: 'domcontentloaded' });
  await installRecorderScript(page);
  const installed = await page.evaluate(() => {
    const win = window as typeof window & {
      __buaCuaRecorderInstalled?: boolean;
      __buaCuaRecordAction?: unknown;
    };
    return {
      scriptInstalled: Boolean(win.__buaCuaRecorderInstalled),
      bindingInstalled: typeof win.__buaCuaRecordAction === 'function',
    };
  }).catch(() => ({ scriptInstalled: false, bindingInstalled: false }));
  console.log(
    `[recorder] page hook status: script=${installed.scriptInstalled ? 'ok' : 'missing'} binding=${
      installed.bindingInstalled ? 'ok' : 'missing'
    }`,
  );

  const finish = async () => {
    if (finishPromise) {
      return finishPromise;
    }
    isClosing = true;
    finishPromise = (async () => {
      await Promise.allSettled(Array.from(pending));
      await saveIndex();
      await context.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
      console.log(`[recorder] Recording saved to ${recordingDir}`);
    })();
    return finishPromise;
  };

  process.once('SIGINT', () => {
    void finish().then(() => process.exit(0));
  });

  context.once('close', () => {
    void finish();
  });
  browser?.once('disconnected', () => {
    void finish();
  });
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    context.once('close', done);
    browser?.once('disconnected', done);
    const timer = setInterval(() => {
      if (openPages.size === 0) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
  await finish();
}

const args = parseArgs(process.argv.slice(2));
await runRecorder(args);
