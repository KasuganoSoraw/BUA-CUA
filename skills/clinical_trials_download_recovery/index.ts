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
      allowedTools: ['screenshot', 'jsProbe', 'domAct', 'clickAt'],
      maxTurns: 10,
      risk: 'read_only',
    },
    async () => {
      await ctx.harness.domAct('fallback search clinical trials', `
        const input = document.querySelector('#advcond');
        if (!input) {
          throw new Error('Condition/disease input #advcond not found');
        }
        input.focus();
        input.value = ${JSON.stringify(args.query)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const searchButton = Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Search');
        if (!searchButton) {
          throw new Error('Search button not found');
        }
        searchButton.click();
        return { ok: true };
      `);
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
      allowedTools: ['screenshot', 'jsProbe', 'domAct', 'clickAt'],
      maxTurns: 10,
      risk: 'read_only',
    },
    async () => {
      await ctx.harness.domAct('fallback apply recruitment status filters', `
        const notYet = document.querySelector('#adv-check0-status0');
        const recruiting = document.querySelector('#adv-check0-status1');
        const apply = document.querySelector('#apply-filters');
        if (!notYet || !recruiting || !apply) {
          throw new Error('Status checkbox or Apply Filters button not found');
        }
        if (!notYet.checked) notYet.click();
        if (!recruiting.checked) recruiting.click();
        apply.click();
        return { ok: true, notYet: notYet.checked, recruiting: recruiting.checked };
      `);
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
    const downloadPromise = page.waitForEvent('download', { timeout: 240000 });

    await ctx.recoverStep(
      '打开 Download 弹窗并触发 CSV 下载',
      {
        goal: '打开搜索结果页的 Download 弹窗，选择 CSV 格式，下载当前搜索结果',
        hints: [
          '搜索结果上方 action bar 有 Download 按钮，id 可能是 action-bar-download-btn',
          'Download 弹窗里选择 CSV 格式，不选择 JSON 或 RIS',
          '如果能找到 #action-bar-download-btn，可以先点击它打开弹窗',
          '如果弹窗要求选择结果范围，保留默认范围即可',
          '如果弹窗要求选择字段，保留默认字段即可',
          '最后点击弹窗中的 Download 按钮触发浏览器下载',
          '不要点击 Save、RSS、Display 或站点反馈按钮',
        ],
        allowedTools: ['screenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
        maxTurns: 10,
        risk: 'read_only',
      },
      async () => {
        await ctx.harness.domAct('fallback trigger csv download', `
          (async () => {
          const openButton = document.querySelector('#action-bar-download-btn');
          if (!openButton) {
            throw new Error('Download action bar button not found');
          }
          openButton.click();
          await new Promise((resolve) => setTimeout(resolve, 1000));
          const csv = document.querySelector('#download-format-csv');
          if (csv && !csv.checked) {
            csv.click();
          }
          const allResults = document.querySelector('#download-results-all');
          if (allResults && !allResults.checked) {
            allResults.click();
          }
          const modalDownload = Array.from(document.querySelectorAll('button')).find((button) => {
            const text = button.textContent?.trim();
            return text === 'Download' && !button.id;
          });
          if (!modalDownload) {
            throw new Error('Modal Download button not found');
          }
          modalDownload.click();
          return { ok: true };
          })()
        `);
      },
    );

    const download = await downloadPromise;
    const outputDir = path.resolve(process.cwd(), args.downloadDir);
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(outputDir, `${safeFilePart(args.query)}-clinical-trials-${Date.now()}.${args.downloadFormat}`);
    await download.saveAs(outputPath);

    const stats = await fs.stat(outputPath);
    if (stats.size <= 0) {
      ctx.fail(`CSV 下载文件为空: ${outputPath}`);
    }

    ctx.log('csv_downloaded', 'ClinicalTrials.gov CSV 下载完成', {
      outputPath,
      bytes: stats.size,
      suggestedFilename: download.suggestedFilename(),
    });
  });
}
