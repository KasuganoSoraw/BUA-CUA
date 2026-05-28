import { expect } from '@playwright/test';
import type { SkillContext } from '../../src/runtime/types.js';

type QueryArgs = {
  neKeyword: string;
  neName: string;
  fields: string[];
};

function asQueryArgs(args: Record<string, unknown>): QueryArgs {
  return args as QueryArgs;
}

export async function run(ctx: SkillContext, rawArgs: Record<string, unknown>): Promise<void> {
  const args = asQueryArgs(rawArgs);
  const { page, agent } = ctx;

  await ctx.step('Load mock NMS page', async () => {
    await page.setContent(`
      <main>
        <h1>NMS Mock</h1>
        <label>
          Search NE
          <input aria-label="Search NE" />
        </label>
        <button>Search</button>
        <section aria-label="Search Results"></section>
        <section aria-label="E-Line Service" hidden>
          <h2>E-Line Service</h2>
          <table>
            <thead>
              <tr><th>UNI</th><th>QOS</th></tr>
            </thead>
            <tbody>
              <tr><td>UNI-1</td><td>Gold</td></tr>
            </tbody>
          </table>
        </section>
      </main>
      <script>
        const input = document.querySelector('input');
        const results = document.querySelector('[aria-label="Search Results"]');
        const service = document.querySelector('[aria-label="E-Line Service"]');
        document.querySelector('button').addEventListener('click', () => {
          results.innerHTML = '<button aria-label="Open ${args.neName}">${args.neName}</button>';
          results.querySelector('button').addEventListener('click', () => {
            service.hidden = false;
          });
        });
      </script>
    `);
  });

  await ctx.withFallback(
    'Search target NE',
    async () => {
      await page.getByLabel('Search NE').fill(args.neKeyword);
      await page.getByRole('button', { name: 'Search' }).click();
    },
    async () => {
      await agent.aiInput('Search NE input', { value: args.neKeyword });
      await agent.aiTap('Search button');
    },
    async () => {
      await expect(page.getByRole('button', { name: `Open ${args.neName}` })).toBeVisible();
    },
  );

  await ctx.withFallback(
    'Open E-Line Service',
    async () => {
      await page.getByRole('button', { name: `Open ${args.neName}` }).click();
    },
    async () => {
      await agent.aiTap(`open the NE named ${args.neName}`);
    },
    async () => {
      await expect(page.getByRole('heading', { name: 'E-Line Service' })).toBeVisible();
    },
  );

  await ctx.withFallback(
    'Extract requested fields',
    async () => {
      for (const field of args.fields) {
        await expect(page.getByRole('columnheader', { name: field })).toBeVisible();
      }
    },
    async () => {
      await agent.aiAssert(`the E-Line Service table contains these fields: ${args.fields.join(', ')}`);
    },
  );

  ctx.log('extracted_fields', 'Mock extraction completed', {
    neName: args.neName,
    fields: args.fields,
  });
}
