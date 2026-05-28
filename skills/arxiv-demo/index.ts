import fs from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { SkillContext } from '../../src/runtime/types.js';

type ArxivArgs = {
  query: string;
  sortBy?: 'relevance' | 'lastUpdatedDate' | 'submittedDate';
  resultIndex?: number;
  downloadDir?: string;
};

function asArxivArgs(args: Record<string, unknown>): Required<ArxivArgs> {
  const typed = args as ArxivArgs;
  return {
    query: typed.query,
    sortBy: typed.sortBy ?? 'relevance',
    resultIndex: typed.resultIndex ?? 1,
    downloadDir: typed.downloadDir ?? 'downloads',
  };
}

function sortOptionValue(sortBy: Required<ArxivArgs>['sortBy']): string {
  if (sortBy === 'lastUpdatedDate') {
    return 'lastUpdatedDate';
  }
  if (sortBy === 'submittedDate') {
    return 'submittedDate';
  }
  return '';
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'arxiv-paper';
}

export async function run(ctx: SkillContext, rawArgs: Record<string, unknown>): Promise<void> {
  const args = asArxivArgs(rawArgs);
  const { page, agent } = ctx;

  await ctx.withFallback(
    '打开 arXiv 首页',
    async () => {
      await page.goto('https://arxiv.org/');
    },
    async () => {
      await page.goto('https://arxiv.org/');
      await agent.aiAssert('arXiv 首页已经打开');
    },
    async () => {
      await expect(page.getByRole('textbox', { name: 'Search term or terms' })).toBeVisible();
    },
  );

  await ctx.withFallback(
    '搜索论文关键词',
    async () => {
      await page.getByRole('textbox', { name: 'Search term or terms' }).fill(args.query);
      await page.locator('#header').getByRole('button', { name: 'Search' }).click();
    },
    async () => {
      await agent.aiInput('右上角搜索框', { value: args.query });
      await agent.aiTap('右上角 Search 按钮');
    },
    async () => {
      await page.waitForURL(/\/search\//, { timeout: 15000 });
      await expect(page.getByText(/Showing .* results for/)).toBeVisible();
    },
  );

  await ctx.withFallback(
    '按指定方式排序搜索结果',
    async () => {
      await page.getByLabel('Sort results by').selectOption(sortOptionValue(args.sortBy));
      await page.getByRole('button', { name: 'Go' }).click();
    },
    async () => {
      await agent.aiTap(`选择 ${args.sortBy} 排序方式`);
      await agent.aiTap('Go 按钮');
    },
    async () => {
      await expect(page.getByRole('link', { name: 'pdf' }).first()).toBeVisible();
    },
  );

  await ctx.withFallback(
    '打开目标论文 PDF',
    async () => {
      await page.getByRole('link', { name: 'pdf' }).nth(args.resultIndex - 1).click();
    },
    async () => {
      await agent.aiTap(`打开排名第 ${args.resultIndex} 的论文的 pdf 链接`);
    },
    async () => {
      await page.waitForURL(/\/pdf\//, { timeout: 15000 });
      await expect(page).toHaveURL(/\/pdf\//);
    },
  );

  await ctx.withFallback(
    '下载当前论文 PDF',
    async () => {
      const pdfUrl = page.url();
      const response = await page.context().request.get(pdfUrl, { timeout: 120000 });
      if (!response.ok()) {
        ctx.fail(`PDF 下载请求失败: ${response.status()} ${response.statusText()}`);
      }

      const outputDir = path.resolve(process.cwd(), args.downloadDir);
      await fs.mkdir(outputDir, { recursive: true });
      const outputPath = path.join(outputDir, `${safeFilePart(args.query)}-${Date.now()}.pdf`);
      await fs.writeFile(outputPath, await response.body());

      const stats = await fs.stat(outputPath);
      if (stats.size <= 0) {
        ctx.fail(`PDF 文件为空: ${outputPath}`);
      }

      ctx.log('pdf_downloaded', 'PDF 下载完成', {
        outputPath,
        bytes: stats.size,
        sourceUrl: pdfUrl,
      });
    },
    async () => {
      await agent.aiTap('PDF 查看器中的下载按钮');
      await agent.aiAssert('PDF 已经开始下载或下载按钮已被点击');
    },
  );
}
