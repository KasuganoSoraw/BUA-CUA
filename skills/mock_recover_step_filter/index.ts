import { expect } from '@playwright/test';
import type { SkillContext } from '../../src/runtime/types.js';

export async function run(ctx: SkillContext): Promise<void> {
  const { page } = ctx;

  await ctx.step('加载 mock recoverStep 页面', async () => {
    await page.setContent(`
      <main>
        <h1>Mock Recover Step Table</h1>
        <table>
          <thead>
            <tr>
              <th>
                <span>Subnet</span>
                <span class="ev_table_col_right_icons">
                  <button class="ev_table_col_filter_button" type="button"></button>
                </span>
              </th>
              <th>VLAN</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>10.0.0.0/24</td><td>100</td></tr>
          </tbody>
        </table>
        <section id="filter-panel" hidden>Subnet column filter panel</section>
      </main>
      <script>
        document.querySelector('.ev_table_col_filter_button').addEventListener('click', () => {
          document.querySelector('#filter-panel').hidden = false;
        });
      </script>
    `);
  });

  await ctx.recoverStep(
    '直接打开 Subnet 列筛选',
    {
      goal: '打开 Subnet 列筛选面板',
      hints: [
        '当前页面有一个表格，Subnet 表头右侧有一个没有 aria-label 的筛选按钮',
        '可以通过 Subnet 表头限定局部 DOM，再寻找 class 包含 filter 的 button',
        '筛选面板的 DOM id 是 filter-panel，打开成功后 document.querySelector("#filter-panel").hidden 应为 false',
        '确认 filter-panel.hidden 为 false 后直接回复 done，不需要继续探索',
      ],
      allowedTools: ['viewportScreenshot', 'fullPageScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 8,
      risk: 'read_only',
    },
    async () => {
      await ctx.harness.domAct('fallback open subnet filter', `
        const headers = Array.from(document.querySelectorAll('th'));
        const subnetHeader = headers.find((header) => header.textContent?.includes('Subnet'));
        const button = subnetHeader?.querySelector('.ev_table_col_filter_button');
        if (!button) {
          throw new Error('Subnet filter button not found');
        }
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return { ok: true, evidence: { className: button.className } };
      `);
    },
    async () => {
      await expect(page.getByText('Subnet column filter panel')).toBeVisible();
    },
  );
}
