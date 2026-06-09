import { expect } from '@playwright/test';
import type { SkillContext } from '../../src/runtime/types.js';

export async function run(ctx: SkillContext, args: Record<string, unknown>): Promise<void> {
  const { page, agent } = ctx;
  const condition = args.condition as string;
  const status = args.status as string;
  const sex = args.sex as string;
  const ageGroup = args.ageGroup as string;
  const resultCount = args.resultCount as number;

  // Step 1: 搜索目标疾病
  await ctx.withRecovery(
    '搜索目标疾病',
    async () => {
      await page.goto('https://clinicaltrials.gov/');
      const combobox = page.getByRole('combobox', { name: 'Condition/disease' });
      await combobox.click();
      await combobox.fill(condition);
      await page.getByRole('option', { name: condition, exact: true }).click();
    },
    {
      goal: `在 Condition/disease 输入框中输入并选择 ${condition}`,
      hints: [
        '使用 autocomplete 输入框',
        '输入关键字后，从下拉列表中选择精确匹配的 option',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`the Condition/disease combobox, type ${condition}, and select the ${condition} option from the dropdown`);
    },
    async () => {
      await expect(page.getByRole('combobox', { name: 'Condition/disease' })).toHaveValue(condition);
    },
  );

  // Step 2: 选择状态并执行搜索
  await ctx.withRecovery(
    '选择状态并执行搜索',
    async () => {
      await page.getByText(status).click();
      await page.getByRole('button', { name: 'Search' }).click();
    },
    {
      goal: `选择招募状态 ${status} 并点击 Search 按钮`,
      hints: [
        'Status 可能是 radio button 或 checkbox',
        'Search 按钮通常在表单底部或页面顶部',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`the radio button or checkbox for status ${status}, then click the Search button`);
    },
    async () => {
      await expect(page).toHaveURL(/cond=/);
    },
  );

  // Step 3: 应用高级筛选
  await ctx.withRecovery(
    '应用高级筛选',
    async () => {
      await page.getByText(new RegExp(`^${sex}\\b`)).click();
      await page.getByText(new RegExp(`^${ageGroup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).click();
      await page.getByRole('button', { name: 'Apply Filters' }).click();
    },
    {
      goal: `选择性别 ${sex} 和年龄组 ${ageGroup}，并点击 Apply Filters`,
      hints: [
        '筛选面板可能需要先点击展开',
        'Sex 通常是单选 (radio)，Age 通常是多选 (checkbox)',
        'Apply Filters 按钮在筛选面板底部',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 8,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`the radio for ${sex}, the checkbox for ${ageGroup}, and the Apply Filters button`);
    },
    async () => {
      await expect(page).toHaveURL(/aggFilters=/);
      await expect(page.locator('ctg-search-hit-card').first()).toBeVisible({ timeout: 15000 });
    },
  );

  // Step 4: 选择目标试验卡片
  await ctx.withRecovery(
    '选择目标试验卡片',
    async () => {
      const cards = page.locator('ctg-search-hit-card').locator('.usa-checkbox__label');
      const count = await cards.count();
      const toSelect = Math.min(resultCount, count);
      for (let i = 0; i < toSelect; i++) {
        await cards.nth(i).click();
      }
    },
    {
      goal: `勾选前 ${resultCount} 个临床试验卡片`,
      hints: [
        '卡片左上角有复选框，点击 label 即可勾选',
        '如果可见卡片不足 resultCount，则勾选所有可见卡片',
        '确保只勾选有效的搜索结果卡片，跳过广告或置顶',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 8,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`the checkboxes of the first ${resultCount} search result cards`);
    },
    async () => {
      await expect(page.getByText(new RegExp(`^${resultCount} selected$`))).toBeVisible();
    },
  );

  // Step 5: 打开弹窗并下载
  await ctx.withRecovery(
    '打开弹窗并下载',
    async () => {
      const downloadPromise = page.waitForEvent('download');
      await page.getByLabel('download', { exact: true }).click();
      await page.getByRole('button', { name: 'Download' }).click();
      const download = await downloadPromise;
      const path = await download.path();
      if (!path) {
        throw new Error('Download event triggered but file path is missing');
      }
    },
    {
      goal: `点击下载按钮，在弹窗中确认下载，并等待文件下载完成`,
      hints: [
        '顶部操作栏有 download 图标按钮 (aria-label="download")',
        '弹窗中有 Download 按钮',
        '必须等待 download 事件触发并获取文件路径',
      ],
      allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 6,
      risk: 'read_only',
    },
    async () => {
      await agent.aiTap(`the download icon button, then click the Download button in the modal`);
    },
    async () => {
      await expect(page.locator('#download-modal')).toHaveClass(/is-hidden/);
    },
  );
}
