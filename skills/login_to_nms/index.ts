import type { SkillContext } from '../../src/runtime/types.js';

export async function run(ctx: SkillContext): Promise<void> {
  await ctx.step('Mock login session', async () => {
    await ctx.page.setContent(`
      <main>
        <h1>NMS Mock Login</h1>
        <p data-testid="session-status">session ready</p>
      </main>
    `);
    await ctx.saveStorageState();
  });
}
