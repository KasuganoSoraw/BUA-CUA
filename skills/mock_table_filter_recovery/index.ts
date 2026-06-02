import { expect } from '@playwright/test';
import type { SkillContext } from '../../src/runtime/types.js';

export async function run(ctx: SkillContext): Promise<void> {
  const { page } = ctx;

  await ctx.step('加载 mock 表格页面', async () => {
    await page.setContent(`
      <main>
        <h1>Mock Table</h1>
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

  await ctx.withRecovery(
    '打开 Subnet 列筛选',
    async () => {
      await page.getByRole('button', { name: 'Subnet filter' }).click({ timeout: 1000 });
    },
    {
      goal: '打开 Subnet 列筛选面板',
      hints: [
        '目标通常位于 Subnet 表头右侧',
        '筛选按钮可能是空 button，没有 aria-label',
        '可以通过表头文本 Subnet 限定局部 DOM',
      ],
      allowedTools: ['screenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
      maxTurns: 6,
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
