import { expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SkillContext } from '../../src/runtime/types.js';

const STATUS_AGG_FILTERS: Record<string, string> = {
  'Recruiting and not yet': 'status:not rec',
};

const SEX_AGG_FILTERS: Record<string, string> = {
  Male: 'sex:m',
};

const AGE_AGG_FILTERS: Record<string, string> = {
  'Child (birth - 17)': 'ages:child',
};

function asNonEmptyString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`参数 ${key} 必须是非空字符串`);
  }
  return value.trim();
}

function asPositiveInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`参数 ${key} 必须是正整数`);
  }
  return value;
}

function knownMappedValue(map: Record<string, string>, value: string): string | undefined {
  return map[value];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function labelWithOptionalCountRegex(label: string): RegExp {
  // 结果页筛选项在 trace 中带有动态计数，例如 "Male (2,623)"、
  // "Child (birth - 17) (399)"。这里只把业务标签作为参数，允许尾部出现计数。
  return new RegExp(`^\\s*${escapeRegex(label)}(?:\\s*\\([\\d,]+\\))?\\s*$`, 'i');
}

function labelByBusinessText(page: Page, label: string) {
  return page.locator('label').filter({ hasText: labelWithOptionalCountRegex(label) }).first();
}

async function isBusinessLabelChecked(page: Page, label: string): Promise<boolean> {
  const locator = labelByBusinessText(page, label);
  if ((await locator.count().catch(() => 0)) === 0) {
    return false;
  }
  return await locator.evaluate((element) => {
    const labelElement = element instanceof HTMLLabelElement ? element : element.closest('label');
    if (!labelElement) {
      return false;
    }
    const explicitFor = labelElement.getAttribute('for');
    const explicitControl = explicitFor ? document.getElementById(explicitFor) : undefined;
    const control = labelElement.control ?? explicitControl ?? labelElement.querySelector('input');
    if (control instanceof HTMLInputElement) {
      return control.checked;
    }
    return labelElement.getAttribute('aria-checked') === 'true'
      || labelElement.className.includes('selected')
      || labelElement.className.includes('checked');
  });
}

function urlParam(page: Page, name: string): string {
  return new URL(page.url()).searchParams.get(name) ?? '';
}

function urlPathname(page: Page): string {
  return new URL(page.url()).pathname;
}

function conditionTypingPrefix(condition: string): string {
  // 录制中对 Diabetes 先输入 dia，再选择 Diabetes。对其他条件保守使用前三个字符触发自动补全。
  return condition.length > 3 ? condition.slice(0, 3) : condition;
}

async function selectedResultCount(page: Page): Promise<number> {
  const checkedCount = await page
    .locator('ctg-search-hit-card input[type="checkbox"]:checked')
    .count()
    .catch(() => 0);
  if (checkedCount > 0) {
    return checkedCount;
  }

  // trace 对 "3 selected" 类文本提示有重复/隐藏副本风险。这里仅作为复选框 checked 状态不可用时的辅助兜底，
  // 并读取 document.body.innerText，尽量避免把隐藏模板文本计入结果。
  const visibleText = await page.evaluate(() => document.body.innerText).catch(() => '');
  const matches = Array.from(visibleText.matchAll(/(\d+)\s+selected/g), (match) => Number(match[1]));
  return matches.length > 0 ? Math.max(...matches) : 0;
}

async function downloadModalClass(page: Page): Promise<string> {
  return (await page.locator('#download-modal').getAttribute('class').catch(() => '')) ?? '';
}

async function selectCondition(page: Page, condition: string): Promise<void> {
  const conditionBox = page.getByRole('combobox', { name: 'Condition/disease' });
  await conditionBox.click();
  await conditionBox.fill(conditionTypingPrefix(condition));
  const exactOption = page.getByRole('option', { name: new RegExp(`^\\s*${escapeRegex(condition)}\\s*$`, 'i') });
  if ((await exactOption.count().catch(() => 0)) > 0) {
    await exactOption.first().click();
    return;
  }
  await conditionBox.fill(condition);
  const typedOption = page.getByRole('option', { name: new RegExp(escapeRegex(condition), 'i') }).first();
  if ((await typedOption.count().catch(() => 0)) > 0) {
    await typedOption.click();
    return;
  }
  await conditionBox.press('Enter');
}

function sanitizeFilename(filename: string): string {
  const sanitized = filename.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  return sanitized || 'clinicaltrials-download';
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function run(ctx: SkillContext, args: Record<string, unknown>): Promise<void> {
  const { page, agent } = ctx;

  const condition = asNonEmptyString(args, 'condition');
  const status = asNonEmptyString(args, 'status');
  const sex = asNonEmptyString(args, 'sex');
  const ageGroup = asNonEmptyString(args, 'ageGroup');
  const resultCount = asPositiveInteger(args, 'resultCount');

  const statusAggFilter = knownMappedValue(STATUS_AGG_FILTERS, status);
  const sexAggFilter = knownMappedValue(SEX_AGG_FILTERS, sex);
  const ageAggFilter = knownMappedValue(AGE_AGG_FILTERS, ageGroup);

  await ctx.withRecovery(
    '打开 ClinicalTrials.gov 首页',
    async () => {
      await page.goto('https://clinicaltrials.gov/', { waitUntil: 'load' });
    },
    {
      goal: '打开 ClinicalTrials.gov 首页，并停留在可输入 Condition/disease 的搜索页面',
      hints: [
        'trace action call@8 显示录制从 about:blank 导航到 https://clinicaltrials.gov/',
        '首页 verifier 不依赖宽泛文本；优先检查 URL 和 aria-label 为 Condition/disease 的 combobox',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap('open the ClinicalTrials.gov home page');
    },
    async () => {
      await expect.poll(() => new URL(page.url()).origin, { timeout: 15000 }).toBe('https://clinicaltrials.gov');
      await expect(page.getByRole('combobox', { name: 'Condition/disease' })).toBeEnabled({ timeout: 15000 });
    },
  );

  await ctx.withRecovery(
    '选择疾病条件和研究状态并搜索',
    async () => {
      await selectCondition(page, condition);
      await labelByBusinessText(page, status).click();
      await page.getByRole('button', { name: 'Search' }).click();
      await page
        .waitForURL(
          (url) => url.pathname.includes('/search') && url.searchParams.get('cond') === condition,
          { timeout: 15000 },
        )
        .catch(() => undefined);
    },
    {
      goal: `在首页选择 Condition/disease 为 ${condition}，选择研究状态 ${status}，然后点击 Search 进入结果页`,
      hints: [
        'trace actions call@10/call@12/call@14 对应 Condition/disease combobox、填入 dia、选择 Diabetes 自动补全项',
        `当前参数 condition=${condition}，不要写死 Diabetes；可先输入条件名前缀再选择精确 option`,
        'trace action call@16 显示状态是点击可见 label，resolvedHtml 为 label[for="adv-radio-status1"]；不要把内部 id 当成参数',
        'trace action call@20 的 URL 证据显示搜索结果页包含 cond、aggFilters=status:not rec、viewType=Card',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 8,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`select the condition or disease named ${condition} in the Condition/disease field`);
      await agent.aiTap(`select the study status ${status}`);
      await agent.aiTap('click the Search button');
    },
    async () => {
      await expect.poll(() => urlPathname(page), { timeout: 20000 }).toContain('/search');
      await expect.poll(() => urlParam(page, 'cond'), { timeout: 20000 }).toBe(condition);
      await expect.poll(() => urlParam(page, 'viewType'), { timeout: 20000 }).toBe('Card');
      if (statusAggFilter) {
        await expect.poll(() => urlParam(page, 'aggFilters'), { timeout: 20000 }).toContain(statusAggFilter);
      } else {
        await expect.poll(async () => await page.locator('ctg-search-hit-card').count(), { timeout: 20000 }).toBeGreaterThan(0);
      }
    },
  );

  await ctx.withRecovery(
    '选择性别和年龄组筛选并应用',
    async () => {
      await labelByBusinessText(page, sex).click();
      await labelByBusinessText(page, ageGroup).click();
      await page.getByRole('button', { name: 'Apply Filters' }).click();
      await page
        .waitForURL(
          (url) => {
            if (!sexAggFilter || !ageAggFilter) {
              return url.pathname.includes('/search');
            }
            const aggFilters = url.searchParams.get('aggFilters') ?? '';
            return aggFilters.includes(sexAggFilter) && aggFilters.includes(ageAggFilter);
          },
          { timeout: 15000 },
        )
        .catch(() => undefined);
    },
    {
      goal: `在结果页筛选 ${sex} 和 ${ageGroup}，并点击 Apply Filters 使筛选生效`,
      hints: [
        `trace action call@20 点击的是性别 label，录制文本包含动态计数；当前目标 sex=${sex}，不要依赖括号中的数量`,
        `trace action call@22 点击的是年龄组 label，录制文本包含动态计数；当前目标 ageGroup=${ageGroup}，不要依赖括号中的数量`,
        'trace action call@24 显示 Apply Filters 后 URL 的 aggFilters 更新为 ages:child,sex:m,status:not rec',
        '不要把短暂的 Loading results… 作为必须出现的成功条件；优先验证最终 URL query 参数',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 8,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`select the sex filter ${sex}`);
      await agent.aiTap(`select the age group filter ${ageGroup}`);
      await agent.aiTap('click Apply Filters');
    },
    async () => {
      if (statusAggFilter) {
        await expect.poll(() => urlParam(page, 'aggFilters'), { timeout: 20000 }).toContain(statusAggFilter);
      }
      if (sexAggFilter && ageAggFilter) {
        await expect.poll(() => urlParam(page, 'aggFilters'), { timeout: 20000 }).toContain(sexAggFilter);
        await expect.poll(() => urlParam(page, 'aggFilters'), { timeout: 20000 }).toContain(ageAggFilter);
      } else {
        await expect.poll(async () => await isBusinessLabelChecked(page, sex), { timeout: 20000 }).toBe(true);
        await expect.poll(async () => await isBusinessLabelChecked(page, ageGroup), { timeout: 20000 }).toBe(true);
        await expect.poll(async () => await page.locator('ctg-search-hit-card').count(), { timeout: 20000 }).toBeGreaterThan(0);
      }
    },
  );

  await ctx.withRecovery(
    '勾选搜索结果卡片',
    async () => {
      const cards = page.locator('ctg-search-hit-card');
      await expect.poll(async () => await cards.count(), { timeout: 20000 }).toBeGreaterThanOrEqual(resultCount);

      for (let index = 0; index < resultCount; index += 1) {
        const card = cards.nth(index);
        await card.locator('.selection > .usa-checkbox__label').first().click();
      }
    },
    {
      goal: `勾选搜索结果列表中的前 ${resultCount} 个结果卡片`,
      hints: [
        'trace actions call@26/call@28/call@30 依次勾选 hit-sel-0、hit-sel-1、hit-sel-2，对应最终 3 selected',
        '录制选择器包含 nth-child 和内部 hit id，属于弱证据；优先在 ctg-search-hit-card 结果卡片内寻找 selection 区域的 checkbox/label',
        `当前目标 resultCount=${resultCount}，不要固定写死 3 条`,
        '如果卡片不在视口中，允许滚动到对应结果卡片再勾选；只处理当前勾选步骤，不重新规划搜索条件',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 10,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`select the first ${resultCount} clinical trial result cards by checking their selection checkboxes`);
    },
    async () => {
      await expect.poll(async () => await selectedResultCount(page), { timeout: 15000 }).toBe(resultCount);
    },
  );

  await ctx.withRecovery(
    '打开下载弹窗',
    async () => {
      await page.getByLabel('download', { exact: true }).click();
    },
    {
      goal: '点击结果页操作栏中的下载按钮，打开下载弹窗',
      hints: [
        'trace action call@32 的 locator 是 getByLabel("download", { exact: true })',
        'resolvedHtml 显示按钮 aria-label="download"、id="action-bar-download-btn"、aria-controls="download-modal"',
        '打开后 trace 显示 #download-modal class 变为 usa-modal-wrapper is-visible，body 出现 usa-js-modal--active',
        '本 step 的 verifier 应验证弹窗打开状态，不要把最终 Download 点击或下载事件提前作为成功条件',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap('open the download dialog from the selected clinical trial results action bar');
    },
    async () => {
      await expect.poll(async () => await downloadModalClass(page), { timeout: 15000 }).toContain('is-visible');
    },
  );

  let downloadedFilePath: string | undefined;
  let downloadedFileSize = 0;

  const observedDownload = new Promise<void>((resolve, reject) => {
    page.once('download', async (download) => {
      try {
        const filename = sanitizeFilename(download.suggestedFilename() || 'clinicaltrials-download');
        const targetPath = path.join(os.tmpdir(), `clinic-demo-${Date.now()}-${filename}`);
        await download.saveAs(targetPath);
        const stat = await fs.stat(targetPath);
        downloadedFilePath = targetPath;
        downloadedFileSize = stat.size;
        resolve();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
  observedDownload.catch(() => undefined);

  await ctx.withRecovery(
    '确认下载并保存文件',
    async () => {
      await page.locator('#download-modal').getByRole('button', { name: 'Download' }).click();
      await waitWithTimeout(observedDownload, 30000, '点击下载弹窗中的 Download 后未观察到 download 事件');
    },
    {
      goal: '在已打开的下载弹窗中点击 Download，触发 ClinicalTrials.gov 下载事件',
      hints: [
        'trace action call@37 的 locator 是 getByRole("button", { name: "Download" })，resolvedHtml 为弹窗内 primary-button',
        '本 step 已在脚本中预先监听 Playwright download event；如果需要点击，请只点击弹窗内的 Download 按钮',
        'trace 显示点击后 #download-modal class 变为 usa-modal-wrapper is-hidden，但最终 verifier 以 download event 和非空文件为准',
        '不要选择或修改 trace 中没有证据的下载格式、字段范围或其他弹窗选项',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap('click the Download button inside the open download modal to start the file download');
      await waitWithTimeout(observedDownload, 30000, 'Midscene fallback 点击 Download 后未观察到 download 事件');
    },
    async () => {
      await waitWithTimeout(observedDownload, 60000, '未捕获到 ClinicalTrials.gov 下载事件');
      if (!downloadedFilePath) {
        throw new Error('已捕获下载事件，但未获得保存后的文件路径');
      }
      const stat = await fs.stat(downloadedFilePath);
      downloadedFileSize = stat.size;
      expect(downloadedFileSize).toBeGreaterThan(0);
    },
  );
}
