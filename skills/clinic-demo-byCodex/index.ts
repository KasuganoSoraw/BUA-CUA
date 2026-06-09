import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { SkillContext } from '../../src/runtime/types.js';

type ClinicDemoArgs = {
  condition?: string;
  conditionSearchTerm?: string;
  status?: 'Recruiting and not yet';
  sex?: 'Male' | 'Female' | 'All';
  ageGroup?: 'Child (birth - 17)';
  resultCount?: number;
  downloadDir?: string;
};

type NormalizedArgs = Required<ClinicDemoArgs>;

function asArgs(rawArgs: Record<string, unknown>): NormalizedArgs {
  const typed = rawArgs as ClinicDemoArgs;
  return {
    condition: typed.condition ?? 'Diabetes',
    conditionSearchTerm: typed.conditionSearchTerm ?? 'dia',
    status: typed.status ?? 'Recruiting and not yet',
    sex: typed.sex ?? 'Male',
    ageGroup: typed.ageGroup ?? 'Child (birth - 17)',
    resultCount: typed.resultCount ?? 3,
    downloadDir: typed.downloadDir ?? 'downloads',
  };
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'clinicaltrials';
}

function sexLabelSelector(sex: NormalizedArgs['sex']): string {
  if (sex === 'Male') {
    return 'label[for="adv-radio-sex2"]';
  }
  if (sex === 'Female') {
    return 'label[for="adv-radio-sex1"]';
  }
  return 'label[for="adv-radio-sex0"]';
}

function sexUrlToken(sex: NormalizedArgs['sex']): string | null {
  if (sex === 'Male') {
    return 'sex:m';
  }
  if (sex === 'Female') {
    return 'sex:f';
  }
  return null;
}

function statusLabelSelector(status: NormalizedArgs['status']): string {
  if (status === 'Recruiting and not yet') {
    return 'label[for="adv-radio-status1"]';
  }
  throw new Error(`Unsupported status: ${status}`);
}

function statusUrlToken(status: NormalizedArgs['status']): string {
  if (status === 'Recruiting and not yet') {
    return 'status:not rec';
  }
  throw new Error(`Unsupported status: ${status}`);
}

function statusEncodedUrlToken(status: NormalizedArgs['status']): string {
  return statusUrlToken(status).replace(' ', '%20');
}

function ageLabelSelector(ageGroup: NormalizedArgs['ageGroup']): string {
  if (ageGroup === 'Child (birth - 17)') {
    return 'label[for="adv-check-age-0"]';
  }
  throw new Error(`Unsupported age group: ${ageGroup}`);
}

function ageUrlToken(ageGroup: NormalizedArgs['ageGroup']): string {
  if (ageGroup === 'Child (birth - 17)') {
    return 'ages:child';
  }
  throw new Error(`Unsupported age group: ${ageGroup}`);
}

async function expectSearchResults(page: Page): Promise<void> {
  await page.waitForURL(/\/search\?/, { timeout: 30000 });
  await expect(page.locator('ctg-search-hit-card').first()).toBeVisible({ timeout: 30000 });
}

async function expectAggFilterTokens(page: Page, tokens: string[]): Promise<void> {
  await expect
    .poll(
      () => {
        const url = new URL(page.url());
        return url.searchParams.get('aggFilters') ?? '';
      },
      { timeout: 30000 },
    )
    .toContain(tokens[0]);

  const aggFilters = new URL(page.url()).searchParams.get('aggFilters') ?? '';
  for (const token of tokens) {
    expect(aggFilters).toContain(token);
  }
}

async function expectSelectedResultCount(page: Page, resultCount: number): Promise<void> {
  await expect
    .poll(
      async () => page.locator('input[id^="hit-sel-"]:checked').count(),
      { timeout: 10000 },
    )
    .toBe(resultCount);
}

async function expectDownloadModalReady(page: Page, resultCount: number): Promise<void> {
  const modal = page.locator('#download-modal');
  await expect(modal).toHaveClass(/is-visible/, { timeout: 10000 });
  await expect(modal.getByText('What would you like to download?')).toBeVisible({ timeout: 10000 });
  await expect(modal.getByLabel(`${resultCount} selected`)).toBeChecked({ timeout: 10000 });
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
      goal: '打开 ClinicalTrials.gov 首页并确认高级搜索表单可用',
      hints: [
        'trace action call@8 显示直接访问首页成功',
        '首页关键控件是 aria-label 为 Condition/disease 的 combobox',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 4,
      risk: 'read_only',
    },
    async () => {
      await page.goto('https://clinicaltrials.gov/');
      await agent.aiAssert('ClinicalTrials.gov 首页已打开，并且 Condition/disease 搜索框可用');
    },
    async () => {
      await expect(page.getByRole('combobox', { name: 'Condition/disease' })).toBeVisible({ timeout: 15000 });
    },
  );

  await ctx.withRecovery(
    '输入疾病条件并选择自动补全结果',
    async () => {
      const conditionInput = page.getByRole('combobox', { name: 'Condition/disease' });
      await conditionInput.click();
      await conditionInput.fill(args.conditionSearchTerm);
      await page.getByRole('option', { name: args.condition, exact: true }).click();
    },
    {
      goal: `在 Condition/disease 中输入 ${args.conditionSearchTerm}，并选择自动补全结果 ${args.condition}`,
      hints: [
        'trace action call@10/call@12/call@14 的 logs 显示 combobox click、fill、option click 均成功执行',
        'resolvedHtml 显示输入框 id 为 advcond，但该 id 只作为内部证据，不作为用户参数',
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
    '选择研究状态并执行搜索',
    async () => {
      await page.locator(statusLabelSelector(args.status)).click();
      await page.getByRole('button', { name: 'Search' }).click();
    },
    {
      goal: `选择研究状态 ${args.status} 并点击 Search 进入搜索结果页`,
      hints: [
        'trace action call@16 resolvedHtml 显示 Recruiting and not yet 对应 label[for="adv-radio-status1"]',
        'trace action call@20 的 URL delta 显示搜索后 URL 出现 cond=Diabetes 与 aggFilters=status:not rec',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`研究状态 ${args.status}`);
      await agent.aiTap('Search 按钮');
    },
    async () => {
      await expectSearchResults(page);
      await expect(page).toHaveURL(new RegExp(`cond=${encodeURIComponent(args.condition)}`));
      await expect(page).toHaveURL(new RegExp(statusEncodedUrlToken(args.status)));
    },
  );

  await ctx.withRecovery(
    '应用性别和年龄筛选',
    async () => {
      await page.locator(sexLabelSelector(args.sex)).click();
      await page.locator(ageLabelSelector(args.ageGroup)).click();
      await page.getByRole('button', { name: 'Apply Filters' }).click();
    },
    {
      goal: `应用筛选条件：性别 ${args.sex}，年龄 ${args.ageGroup}`,
      hints: [
        `trace action call@20 resolvedHtml 显示 ${args.sex} 录制时映射到 ${sexLabelSelector(args.sex)}`,
        `trace action call@22 resolvedHtml 显示 ${args.ageGroup} 录制时映射到 ${ageLabelSelector(args.ageGroup)}`,
        'trace action call@24 的 verifierCandidates 显示 aggFilters 变为 ages:child,sex:m,status:not rec',
        '如果 primary 中途失败，先通过 jsProbe 检查 sex/age 控件 checked 状态，再补做未完成动作',
      ],
      allowedTools: ['viewportScreenshot', 'fullPageScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 8,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`筛选面板中的 ${args.sex} 选项`);
      await agent.aiTap(`筛选面板中的 ${args.ageGroup} 选项`);
      await agent.aiTap('Apply Filters 按钮');
    },
    async () => {
      const tokens = [statusUrlToken(args.status), ageUrlToken(args.ageGroup)];
      const sexToken = sexUrlToken(args.sex);
      if (sexToken) {
        tokens.push(sexToken);
      }
      await expectAggFilterTokens(page, tokens);
      await expectSearchResults(page);
    },
  );

  await ctx.withRecovery(
    '选择搜索结果记录',
    async () => {
      const resultLabels = page.locator('label[for^="hit-sel-"]');
      await expect(resultLabels.nth(args.resultCount - 1)).toBeVisible({ timeout: 30000 });
      for (let index = 0; index < args.resultCount; index += 1) {
        await resultLabels.nth(index).click();
      }
    },
    {
      goal: `选择搜索结果列表中的前 ${args.resultCount} 条记录`,
      hints: [
        'trace action call@26/call@28/call@30 显示录制选择的是前三条结果，resolvedHtml 分别对应 hit-sel-0/1/2',
        'hit-sel-* 是内部 DOM 证据，不是用户参数；用户参数是 resultCount',
        'verifier 使用 input[id^="hit-sel-"]:checked 的数量，而不是宽泛的 3 selected 文本',
      ],
      allowedTools: ['viewportScreenshot', 'fullPageScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 8,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`搜索结果列表中的前 ${args.resultCount} 个选择框`);
    },
    async () => {
      await expectSelectedResultCount(page, args.resultCount);
    },
  );

  await ctx.withRecovery(
    '打开下载弹窗',
    async () => {
      await page.getByLabel('download', { exact: true }).click();
    },
    {
      goal: '打开下载弹窗，准备下载选中的搜索结果',
      hints: [
        'trace action call@32 resolvedHtml 显示下载入口是 #action-bar-download-btn，aria-label 为 download',
        'verifierCandidates 显示 #download-modal class 变为 is-visible，但不要直接断言 wrapper toBeVisible',
        `当前 step 只验证下载弹窗已打开且 ${args.resultCount} selected 配置已选中；最终 Download 按钮在下一步点击`,
        'trace action call@37 logs 显示最终 Download 按钮会 scrolling into view if needed，不应作为本 step 的 toBeVisible verifier',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap('顶部操作栏中的 Download 下载按钮');
    },
    async () => {
      await expectDownloadModalReady(page, args.resultCount);
    },
  );

  await ctx.step('下载并保存选中记录', async () => {
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('#download-modal').getByRole('button', { name: 'Download' }).click();
    const download = await downloadPromise;

    const outputDir = path.resolve(process.cwd(), args.downloadDir);
    await fs.mkdir(outputDir, { recursive: true });
    const outputPath = path.join(
      outputDir,
      `${safeFilePart(args.condition)}-${safeFilePart(args.sex)}-${Date.now()}-${download.suggestedFilename()}`,
    );
    await download.saveAs(outputPath);

    const stats = await fs.stat(outputPath);
    if (stats.size <= 0) {
      ctx.fail(`下载文件为空: ${outputPath}`);
    }

    ctx.log('download_saved', 'ClinicalTrials.gov 下载文件已保存', {
      outputPath,
      bytes: stats.size,
      sourceUrl: page.url(),
      resultCount: args.resultCount,
    });
  });
}
