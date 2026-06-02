import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, CDPSession, Page } from 'playwright';

type Rect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

type DomStackItem = {
  tag: string;
  id: string;
  className: string;
  role: string | null;
  ariaLabel: string | null;
  title: string | null;
  text: string;
  rect: Rect | null;
};

export type RecoveryHarness = {
  screenshot(label?: string): Promise<string>;
  viewportScreenshot(label?: string): Promise<string>;
  fullPageScreenshot(label?: string): Promise<string>;
  jsProbe<T = unknown>(name: string, code: string): Promise<T>;
  inspectAt(x: number, y: number): Promise<DomStackItem[]>;
  domAct<T = unknown>(name: string, code: string): Promise<T>;
  clickAt(x: number, y: number): Promise<void>;
  cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

const FORBIDDEN_PROBE_PATTERNS = [
  /\bdocument\.body\.(innerText|textContent)\b/i,
  /\bdocument\.querySelectorAll\s*\(\s*['"`]\*['"`]\s*\)/i,
  /\bdocument\.querySelectorAll\s*\(\s*['"`](label|span|div|label,\s*span,\s*div|div,\s*span,\s*label)['"`]\s*\)/i,
  /\bfetch\s*\(/i,
  /\bXMLHttpRequest\b/i,
  /\bnavigator\.sendBeacon\b/i,
  /\blocation\s*=/i,
  /\blocation\.(assign|replace|reload)\s*\(/i,
  /\bhistory\.(pushState|replaceState)\s*\(/i,
  /\b(localStorage|sessionStorage)\b/i,
  /\bdocument\.cookie\b/i,
  /\.(click|submit|focus|blur)\s*\(/i,
  /\.(appendChild|removeChild|replaceChild|insertBefore)\s*\(/i,
  /\b(setAttribute|removeAttribute)\s*\(/i,
  /\bdispatchEvent\s*\(/i,
  /\b(value|checked|selected)\s*(?<![=!<>])=(?!=)/i,
  /\binnerHTML\s*=/i,
  /\bouterHTML\s*=/i,
  /\btextContent\s*=/i,
  /\binnerText\s*=/i,
];

function assertReadOnlyProbe(code: string): void {
  const matched = FORBIDDEN_PROBE_PATTERNS.find((pattern) => pattern.test(code));
  if (matched) {
    throw new Error(`jsProbe rejected non-read-only code matching ${matched}`);
  }
}

function safeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]+/g, '_') || 'harness';
}

function assertFinitePoint(x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Invalid point: x=${x}, y=${y}`);
  }
}

export async function createRecoveryHarness(params: {
  page: Page;
  browserContext: BrowserContext;
  artifactDir: string;
}): Promise<RecoveryHarness> {
  const { page, browserContext, artifactDir } = params;
  const cdpSession: CDPSession = await browserContext.newCDPSession(page);

  async function viewportScreenshot(label = 'viewport'): Promise<string> {
    fs.mkdirSync(artifactDir, { recursive: true });
    const screenshotPath = path.join(artifactDir, `${safeLabel(label)}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 30000 });
    return screenshotPath;
  }

  async function fullPageScreenshot(label = 'full-page'): Promise<string> {
    fs.mkdirSync(artifactDir, { recursive: true });
    const screenshotPath = path.join(artifactDir, `${safeLabel(label)}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 30000 });
    return screenshotPath;
  }

  async function evaluateWrapped<T>(code: string): Promise<T> {
    return page.evaluate((source) => {
      const trimmed = source.trim();
      if (trimmed.startsWith('(') || trimmed.startsWith('async ')) {
        return (0, eval)(source);
      }
      return Function(source)();
    }, code) as Promise<T>;
  }

  return {
    screenshot: viewportScreenshot,
    viewportScreenshot,
    fullPageScreenshot,
    async jsProbe<T = unknown>(_name: string, code: string): Promise<T> {
      assertReadOnlyProbe(code);
      return evaluateWrapped<T>(code);
    },
    async inspectAt(x: number, y: number): Promise<DomStackItem[]> {
      assertFinitePoint(x, y);
      return page.evaluate(`(() => {
        const pointX = ${JSON.stringify(x)};
        const pointY = ${JSON.stringify(y)};
        const textOf = (element) => (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
        const rectOf = (element) => {
          const rect = element.getBoundingClientRect();
          if (!rect || (rect.width === 0 && rect.height === 0)) return null;
          return { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
        };
        return document.elementsFromPoint(pointX, pointY).slice(0, 8).map((element) => ({
          tag: element.tagName.toLowerCase(),
          id: element.id || '',
          className: typeof element.className === 'string' ? element.className : '',
          role: element.getAttribute('role'),
          ariaLabel: element.getAttribute('aria-label'),
          title: element.getAttribute('title'),
          text: textOf(element),
          rect: rectOf(element),
        }));
      })()`) as Promise<DomStackItem[]>;
    },
    async domAct<T = unknown>(_name: string, code: string): Promise<T> {
      return evaluateWrapped<T>(code);
    },
    async clickAt(x: number, y: number): Promise<void> {
      assertFinitePoint(x, y);
      await cdpSession.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      await cdpSession.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
    },
    async cdp<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
      const send = cdpSession.send as unknown as (
        cdpMethod: string,
        cdpParams?: Record<string, unknown>,
      ) => Promise<T>;
      return send(method, params ?? {});
    },
  };
}
