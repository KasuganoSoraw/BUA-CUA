import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { SkillContext } from '../../src/runtime/types.js';

type ClinicDemoArgs = {
  condition?: string;
  conditionSearchTerm?: string;
  selectedResultIds?: string[];
  downloadDir?: string;
};

type NormalizedArgs = Required<ClinicDemoArgs>;

function asArgs(rawArgs: Record<string, unknown>): NormalizedArgs {
  const typed = rawArgs as ClinicDemoArgs;
  return {
    condition: typed.condition ?? 'Diabetes',
    conditionSearchTerm: typed.conditionSearchTerm ?? 'dia',
    selectedResultIds: typed.selectedResultIds ?? ['hit-sel-0', 'hit-sel-1', 'hit-sel-2'],
    downloadDir: typed.downloadDir ?? 'downloads',
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'clinicaltrials';
}

async function waitForSearchResults(page: SkillContext['page']): Promise<void> {
  await page.waitForURL(/\/search\?/, { timeout: 30000 });
  await expect(page.locator('ctg-search-hit-card').first()).toBeVisible({ timeout: 30000 });
}

export async function run(ctx: SkillContext, rawArgs: Record<string, unknown>): Promise<void> {
  const args = asArgs(rawArgs);
  const { page, agent } = ctx;

  await ctx.withRecovery(
    '打开 ClinicalTrials.gov 首页',
    async () => {
      await page.goto('https://clinicaltrials.gov/');
    },
    {
      goal: '打开 ClinicalTrials.gov 首页并确认搜索表单可用',
      hints: ['访问固定 URL', '首页应出现 Condition/disease combobox'],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 4,
      risk: 'read_only',
    },
    async () => {
      await page.goto('https://clinicaltrials.gov/');
      await agent.aiAssert('ClinicalTrials.gov 首页已经打开，并且可以看到 Condition/disease 搜索框');
    },
    async () => {
      await expect(page.getByRole('combobox', { name: 'Condition/disease' })).toBeVisible();
    },
  );

  await ctx.withRecovery(
    '输入并选择疾病条件',
    async () => {
      const conditionInput = page.getByRole('combobox', { name: 'Condition/disease' });
      await conditionInput.click();
      await conditionInput.fill(args.conditionSearchTerm);
      await page.getByRole('option', { name: args.condition, exact: true }).click();
    },
    {
      goal: `在 Condition/disease 输入框输入 ${args.conditionSearchTerm} 并选择 ${args.condition}`,
      hints: [
        'trace 显示输入框为 #advcond，aria-label 为 Condition/disease',
        `自动补全列表中应选择精确文本 ${args.condition}`,
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap('Condition/disease 搜索框');
      await agent.aiInput('Condition/disease 搜索框', { value: args.conditionSearchTerm });
      await agent.aiTap(`自动补全列表中的 ${args.condition} 选项`);
    },
    async () => {
      await expect(page.getByRole('combobox', { name: 'Condition/disease' })).toHaveValue(args.condition);
    },
  );

  await ctx.withRecovery(
    '选择招募状态并执行搜索',
    async () => {
      await page.locator('label[for="adv-radio-status1"]').click();
      await page.getByRole('button', { name: 'Search' }).click();
    },
    {
      goal: '选择 Recruiting and not yet 状态并提交搜索',
      hints: [
        'trace 中 Recruiting and not yet 状态 resolvedHtml 为 label[for="adv-radio-status1"]',
        'Search 按钮会进入搜索结果页',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap('Recruiting and not yet 状态选项');
      await agent.aiTap('Search 按钮');
    },
    async () => {
      await waitForSearchResults(page);
      await expect(page).toHaveURL(/cond=Diabetes/);
      await expect(page).toHaveURL(/status:not%20rec/);
    },
  );

  await ctx.withRecovery(
    '应用性别和年龄筛选',
    async () => {
      await page.locator('label[for="adv-radio-sex2"]').click();
      await page.locator('label[for="adv-check-age-0"]').click();
      await page.getByRole('button', { name: 'Apply Filters' }).click();
    },
    {
      goal: '选择 Male 和 Child (birth - 17) 筛选，并应用筛选条件',
      hints: [
        'trace 显示 Male 对应 label[for="adv-radio-sex2"]',
        'trace 显示 Child (birth - 17) 对应 label[for="adv-check-age-0"]',
        'Apply Filters 按钮 id 为 apply-filters',
        '筛选项可能在当前视口外，必要时应通过 DOM 证据滚动到元素后点击',
      ],
      allowedTools: ['viewportScreenshot', 'fullPageScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 8,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap('Male 筛选项');
      await agent.aiTap('Child (birth - 17) 筛选项');
      await agent.aiTap('Apply Filters 按钮');
    },
    async () => {
      await page.waitForURL(/aggFilters=.*ages:child.*sex:m.*status:not%20rec|aggFilters=.*sex:m.*ages:child.*status:not%20rec/, {
        timeout: 30000,
      });
      await expect(page.locator('ctg-search-hit-card').first()).toBeVisible({ timeout: 30000 });
    },
  );

  await ctx.withRecovery(
    '勾选目标临床试验记录',
    async () => {
      for (const resultId of args.selectedResultIds) {
        await page.locator(`label[for="${resultId}"]`).click();
      }
    },
    {
      goal: `勾选结果列表中的 ${args.selectedResultIds.join(', ')} 对应记录`,
      hints: [
        'trace 中三次结果选择 resolvedHtml 分别为 label[for="hit-sel-0"]、label[for="hit-sel-1"]、label[for="hit-sel-2"]',
        '不要用隐藏的 3 selected 下载选项作为 verifier',
        '如果 label 不在视口内，先滚动到对应 label 或其 ctg-search-hit-card 容器',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 8,
      risk: 'read_only',
    },
    async () => {
      for (const resultId of args.selectedResultIds) {
        await agent.aiTap(`结果列表中 id 为 ${resultId} 的选择框`);
      }
    },
    async () => {
      for (const resultId of args.selectedResultIds) {
        await expect(page.locator(`#${resultId}`)).toBeChecked({ timeout: 10000 });
      }
    },
  );

  await ctx.withRecovery(
    '打开下载弹窗并下载',
    async () => {
      await page.getByLabel('download', { exact: true }).click();
      await expect(page.locator('#download-modal')).toBeVisible({ timeout: 10000 });
    },
    {
      goal: '打开下载弹窗',
      hints: [
        'trace 显示下载入口为 #action-bar-download-btn，aria-label 为 download',
        '点击后应出现 #download-modal',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap('顶部操作栏中的 Download 下载按钮');
    },
    async () => {
      await expect(page.locator('#download-modal')).toBeVisible({ timeout: 10000 });
    },
  );

  await ctx.step('保存下载文件', async () => {
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download' }).click();
    const download = await downloadPromise;

    const outputDir = path.resolve(process.cwd(), args.downloadDir);
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${safeFilePart(args.condition)}-${Date.now()}-${download.suggestedFilename()}`);
    await download.saveAs(outputPath);

    const stats = await fs.stat(outputPath);
    if (stats.size <= 0) {
      ctx.fail(`下载文件为空: ${outputPath}`);
    }
    ctx.log('download_saved', 'ClinicalTrials.gov 下载文件已保存', {
      outputPath,
      bytes: stats.size,
    });
  });
}
