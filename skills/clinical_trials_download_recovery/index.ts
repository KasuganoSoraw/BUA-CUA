import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { SkillContext } from '../../src/runtime/types.js';

type ClinicalTrialsArgs = {
  query: string;
  statusFilter?: string;
  downloadDir?: string;
  downloadFormat?: 'csv';
};

function asArgs(rawArgs: Record<string, unknown>): Required<ClinicalTrialsArgs> {
  const args = rawArgs as ClinicalTrialsArgs;
  return {
    query: args.query,
    statusFilter: args.statusFilter ?? 'Recruiting and not yet recruiting',
    downloadDir: args.downloadDir ?? 'downloads',
    downloadFormat: args.downloadFormat ?? 'csv',
  };
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'clinical-trials';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function run(ctx: SkillContext, rawArgs: Record<string, unknown>): Promise<void> {
  const args = asArgs(rawArgs);
  const { page, agent } = ctx;

  await ctx.step('打开 ClinicalTrials.gov 首页', async () => {
    await page.goto('https://clinicaltrials.gov/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await expect(page.getByRole('button', { name: /Find Studies/i })).toBeVisible({ timeout: 30000 });
  });

  await ctx.recoverStep(
    '搜索临床研究关键词',
    {
      goal: `在 ClinicalTrials.gov 中搜索 Condition/disease 关键词：${args.query}`,
      hints: [
        '不要使用右侧 glossary 搜索框，glossary-search 不是业务搜索框',
        '业务搜索框的稳定 DOM 通常是 input#advcond，aria-label 为 Condition/disease，name 为 advcond',
        `可以用 domAct 给 #advcond 设置值 ${args.query}，触发 input/change 事件，然后点击文本为 Search 的业务按钮`,
        '输入关键词后提交搜索，目标是进入 Search Results 页面',
        '完成后如果 URL 包含 /search 且 h2 显示 Search Results，请回复 done',
      ],
      allowedTools: ['viewportScreenshot', 'fullPageScreenshot', 'jsProbe', 'domAct', 'clickAt'],
      maxTurns: 10,
      risk: 'read_only',
    },
    async () => {
      await agent.aiInput('ClinicalTrials.gov 主搜索区域中的 Condition/disease 输入框，不是 glossary 搜索框', { value: args.query });
      await agent.aiTap('ClinicalTrials.gov 主搜索区域中的 Search 按钮');
    },
    async () => {
      await expect(page).toHaveURL(/\/search/, { timeout: 45000 });
      await expect(page.locator('h2').filter({ hasText: 'Search Results' })).toBeVisible({ timeout: 45000 });
      await expect(page.locator(`a[href*="/study/"][href*="${encodeURIComponent(args.query)}"]`).first()).toBeVisible({ timeout: 45000 });
    },
  );

  await ctx.recoverStep(
    '应用招募状态筛选',
    {
      goal: `在搜索结果页应用 Status 筛选：${args.statusFilter}`,
      hints: [
        '当前页面左侧通常是 Advanced Search 或筛选侧栏，包含 Status 区域',
        '目标状态通常对应 Recruiting 和 Not yet recruiting 两个复选框，或一个组合选项 Recruiting and not yet recruiting',
        '在搜索结果页中，Not yet recruiting 通常是 input#adv-check0-status0，Recruiting 通常是 input#adv-check0-status1',
        '可以分别点击这两个 checkbox，然后点击 #apply-filters',
        '如需滚动，只滚动左侧筛选区域或页面到 Status 区域',
        '选择状态后需要点击 Apply Filters 按钮',
        '应用成功后 URL 通常包含 aggFilters=status:not%20rec，标题会包含 Not yet recruiting, Recruiting studies',
        '不要点击 Save、RSS、PRS Login 或反馈按钮',
      ],
      allowedTools: ['viewportScreenshot', 'fullPageScreenshot', 'jsProbe', 'domAct', 'clickAt'],
      maxTurns: 10,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`左侧 Study Status 或 Status 筛选中的 ${args.statusFilter}`);
      await agent.aiTap('左侧筛选区域的 Apply Filters 按钮');
    },
    async () => {
      await expect(page).toHaveURL(/\/search/, { timeout: 45000 });
      await expect(page.locator('h2').filter({ hasText: 'Search Results' })).toBeVisible({ timeout: 45000 });
      await expect(page).toHaveTitle(/Not yet recruiting, Recruiting studies/i, { timeout: 45000 });
      await expect(page.locator('#clear-filters')).toContainText(/Clear Filters \([2-9]\)/, {
        timeout: 45000,
      });
      await expect(page.locator('button').filter({ hasText: /Search Details/ }).first()).toContainText(/Not yet recruiting, Recruiting studies/i, {
        timeout: 45000,
      });
    },
  );

  await ctx.step('下载搜索结果 CSV', async () => {
    await ctx.recoverStep(
      '打开 Download 弹窗并确认 CSV 格式',
      {
        goal: '打开搜索结果页的 Download 弹窗，并确认 CSV 格式已选中。不要点击弹窗底部最终 Download 按钮。',
        hints: [
          '搜索结果上方 action bar 有 Download 按钮，id 可能是 action-bar-download-btn',
          '只需要打开 Download 弹窗并确认 CSV 格式已选中，不要触发最终下载',
          'Download 弹窗里 CSV 单选项通常是 #download-format-csv，默认已经选中',
          '如果能找到 #action-bar-download-btn，可以先点击它打开弹窗',
          '如果弹窗要求选择结果范围或字段，保留默认即可',
          '看到 #download-format-csv 存在且 checked 为 true 后回复 done',
          '不要点击 Save、RSS、Display 或站点反馈按钮',
        ],
        allowedTools: ['viewportScreenshot', 'fullPageScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
        maxTurns: 14,
        risk: 'read_only',
      },
      async () => {
        await agent.aiTap('搜索结果 action bar 中的 Download 按钮');
        await expect(page.locator('#download-format-csv')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('#download-format-csv')).toBeChecked({ timeout: 30000 });
      },
      async () => {
        await expect(page.locator('#download-format-csv')).toBeVisible({ timeout: 30000 });
        await expect(page.locator('#download-format-csv')).toBeChecked({ timeout: 30000 });
      },
    );

    const downloadPromise = page
      .waitForEvent('download', { timeout: 120000 })
      .then((download) => ({ ok: true as const, download }))
      .catch((error: unknown) => ({ ok: false as const, error }));

    try {
      await agent.aiTap('Download 弹窗底部的 Download 按钮');
    } catch (error) {
      ctx.log('midscene_download_tap_failed', error instanceof Error ? error.message : String(error), undefined, 'warn');
      await page.locator('button').filter({ hasText: /^Download$/ }).last().click();
    }

    const downloadResult = await downloadPromise;
    if (!downloadResult.ok) {
      throw downloadResult.error;
    }

    const outputDir = path.resolve(process.cwd(), args.downloadDir);
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${safeFilePart(args.query)}-clinical-trials-${Date.now()}.${args.downloadFormat}`);
    await downloadResult.download.saveAs(outputPath);

    const stats = await fs.stat(outputPath);
    if (stats.size <= 0) {
      ctx.fail(`CSV 下载文件为空: ${outputPath}`);
    }

    ctx.log('csv_downloaded', 'ClinicalTrials.gov CSV 下载完成', {
      outputPath,
      bytes: stats.size,
      suggestedFilename: downloadResult.download.suggestedFilename(),
    });
  });
}
