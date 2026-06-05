import { expect } from '@playwright/test';
import type { SkillContext } from '../../src/runtime/types.js';

export async function run(ctx: SkillContext, args: Record<string, unknown>): Promise<void> {
  const { page, agent } = ctx;
  const condition = (args.condition as string) || 'Diabetes';
  const status = (args.status as string) || 'Recruiting and not yet';
  const gender = (args.gender as string) || 'Male';
  const ageGroup = (args.ageGroup as string) || 'Child (birth - 17)';

  await ctx.withRecovery(
    '导航至临床试验网站',
    async () => {
      await page.goto('https://clinicaltrials.gov/');
    },
    {
      goal: '打开 ClinicalTrials.gov 首页',
      hints: ['直接访问指定 URL', '等待页面完全加载'],
      maxTurns: 3,
      risk: 'read_only',
    },
    async () => {
      await agent.aiAssert('ClinicalTrials.gov 首页已加载');
    },
    async () => {
      await expect(page).toHaveURL('https://clinicaltrials.gov/');
    }
  );

  await ctx.withRecovery(
    '输入并选择疾病条件',
    async () => {
      await page.getByRole('combobox', { name: 'Condition/disease' }).click();
      await page.getByRole('combobox', { name: 'Condition/disease' }).fill(condition);
      await page.getByRole('option', { name: condition, exact: true }).click();
    },
    {
      goal: `在 Condition/disease 输入框中输入 ${condition} 并从下拉列表选择精确匹配项`,
      hints: ['点击输入框激活自动补全', '输入关键字后等待选项出现', '点击包含目标文本的 option'],
      maxTurns: 5,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`select ${condition} from the condition dropdown`);
    },
    async () => {
      await expect(page.getByRole('combobox', { name: 'Condition/disease' })).toHaveValue(condition);
    }
  );

  await ctx.withRecovery(
    '选择研究状态并执行搜索',
    async () => {
      await page.getByText(status).click();
      await page.getByRole('button', { name: 'Search' }).click();
    },
    {
      goal: `选择状态 ${status} 并点击 Search 按钮`,
      hints: ['点击包含状态文本的标签或单选按钮', '点击 Search 按钮触发查询'],
      maxTurns: 5,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`select status ${status} and click Search`);
    },
    async () => {
      await expect(page.getByText('Clear Filters')).toBeVisible();
    }
  );

  await ctx.withRecovery(
    '应用性别与年龄筛选',
    async () => {
      await page.getByText(gender).click();
      await page.getByText(ageGroup).click();
      await page.getByRole('button', { name: 'Apply Filters' }).click();
    },
    {
      goal: `勾选 ${gender} 和 ${ageGroup} 筛选条件，并点击 Apply Filters`,
      hints: ['在筛选面板中找到对应文本并点击', '点击后等待结果刷新'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`select ${gender} and ${ageGroup} filters, then click Apply Filters`);
    },
    async () => {
      await expect(page).toHaveURL(/cond=.*&aggFilters=/);
    }
  );

  await ctx.withRecovery(
    '选择目标临床试验记录',
    async () => {
      const cards = page.locator('ctg-search-hit-card');
      await cards.nth(0).locator('.selection > .usa-checkbox__label').click();
      await cards.nth(1).locator('.selection > .usa-checkbox__label').click();
      await cards.nth(2).locator('.selection > .usa-checkbox__label').click();
    },
    {
      goal: '勾选搜索结果列表中的前 3 个临床试验卡片',
      hints: ['定位 ctg-search-hit-card 组件', '点击卡片头部区域的 checkbox label'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap('select the first three study cards in the results list');
    },
    async () => {
      await expect(page.getByText('3 selected')).toBeVisible();
    }
  );

  await ctx.withRecovery(
    '导出选中记录',
    async () => {
      await page.getByLabel('download', { exact: true }).click();
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download' }).click();
      await downloadPromise;
    },
    {
      goal: '点击下载按钮，在弹窗中确认下载',
      hints: ['点击顶部下载图标打开弹窗', '点击弹窗内的 Download 按钮触发文件下载'],
      maxTurns: 5,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap('click the download icon and confirm download in the modal');
    },
    async () => {
      await expect(page.getByRole('button', { name: 'Download' })).not.toBeVisible();
    }
  );
}
