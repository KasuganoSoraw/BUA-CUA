import { expect } from '@playwright/test';
import type { RecoveryOptions } from '../../src/recovery/types.js';
import type { SkillContext } from '../../src/runtime/types.js';

const recoveryOptions: RecoveryOptions = {
  goal: 'Validate runtime interruption handling in a local mock page',
  hints: ['This mock should not need recovery when ctx.action works correctly.'],
  allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
  maxTurns: 2,
  risk: 'read_only',
};

export async function run(ctx: SkillContext): Promise<void> {
  const { page } = ctx;

  await ctx.step('Load mock interruption page', async () => {
    await page.setContent(`
      <main>
        <h1>Interruption Mock</h1>
        <p id="prepare-count">0</p>
        <p id="search-result">Idle</p>
        <p id="verify-result">Idle</p>
        <p id="business-result">Idle</p>
        <button id="prepare">Prepare</button>
        <button id="search">Search</button>
        <button id="complete">Complete</button>
        <button id="business-target">Business Target</button>
      </main>

      <div id="action-dialog" role="dialog" aria-modal="true" hidden
        style="position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.25);">
        <section style="margin: 120px auto; padding: 20px; width: 260px; background: white;">
          <p>System notice</p>
          <button id="action-close">Close</button>
        </section>
      </div>

      <div id="verify-dialog" role="dialog" aria-modal="true" hidden
        style="position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.25);">
        <section style="margin: 120px auto; padding: 20px; width: 260px; background: white;">
          <p>Background notification</p>
          <button id="verify-close">OK</button>
        </section>
      </div>

      <div id="danger-dialog" role="dialog" aria-modal="true" hidden
        style="position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, 0.25);">
        <section style="margin: 120px auto; padding: 20px; width: 260px; background: white;">
          <p>Confirm download before continuing</p>
          <button id="danger-confirm">Confirm</button>
        </section>
      </div>

      <script>
        const prepareCount = document.querySelector('#prepare-count');
        document.querySelector('#prepare').addEventListener('click', () => {
          prepareCount.textContent = String(Number(prepareCount.textContent) + 1);
          document.querySelector('#action-dialog').hidden = false;
        });
        document.querySelector('#search').addEventListener('click', () => {
          document.querySelector('#search-result').textContent = 'Done';
        });
        document.querySelector('#complete').addEventListener('click', () => {
          document.querySelector('#verify-result').textContent = 'Done';
          document.querySelector('#verify-dialog').hidden = false;
        });
        document.querySelector('#business-target').addEventListener('click', () => {
          document.querySelector('#business-result').textContent = 'Clicked';
        });
        document.querySelector('#action-close').addEventListener('click', () => {
          document.querySelector('#action-dialog').hidden = true;
        });
        document.querySelector('#verify-close').addEventListener('click', () => {
          document.querySelector('#verify-dialog').hidden = true;
        });
      </script>
    `);
  });

  await ctx.withRecovery(
    'Retry only the failed small action',
    async () => {
      await ctx.action('Prepare once', async () => {
        await page.getByRole('button', { name: 'Prepare' }).click();
      });

      await ctx.action('Click Search after notice', async () => {
        await page.getByRole('button', { name: 'Search' }).click({ timeout: 1000 });
      });
    },
    recoveryOptions,
    async (error) => {
      throw error instanceof Error ? error : new Error(String(error));
    },
    async () => {
      await expect(page.locator('#prepare-count')).toHaveText('1');
      await expect(page.locator('#search-result')).toHaveText('Done');
    },
  );

  await ctx.withRecovery(
    'Retry verifier after dismissing notice',
    async () => {
      await ctx.action('Complete action', async () => {
        await page.getByRole('button', { name: 'Complete' }).click();
      });
    },
    recoveryOptions,
    async (error) => {
      throw error instanceof Error ? error : new Error(String(error));
    },
    async () => {
      await expect(page.locator('#verify-result')).toHaveText('Done');
      await expect(page.locator('#verify-dialog')).toBeHidden({ timeout: 1000 });
    },
  );

  await ctx.step('Do not dismiss business confirmation dialog', async () => {
    await page.locator('#danger-dialog').evaluate((element) => {
      (element as HTMLElement).hidden = false;
    });

    let actionFailed = false;
    try {
      await ctx.action('Blocked by business confirmation', async () => {
        await page.getByRole('button', { name: 'Business Target' }).click({ timeout: 1000 });
      });
    } catch {
      actionFailed = true;
    }

    await expect(page.locator('#danger-dialog')).toBeVisible();
    await expect(page.locator('#business-result')).toHaveText('Idle');
    if (!actionFailed) {
      ctx.fail('business confirmation dialog was unexpectedly dismissed');
    }
  });
}
