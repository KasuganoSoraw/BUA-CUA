# 任务级 Skill 生成 Prompt

本 prompt 用于生成具体网页任务的 **Task Skill**，不是生成 BUA-CUA Toolkit 本身。BUA-CUA Toolkit 是本仓库提供的生成与执行工具包；Task Skill 是位于 `skills/<task_name>/` 的具体任务脚本。

你需要基于下面两类输入，生成一个经过人工审查后可执行的 BUA-CUA 任务级 Skill：

1. 用户的自然语言任务描述。
2. 一段由人工成功示范录制得到的 Playwright codegen 脚本。

你必须一次性输出且只输出三个文件的内容：`skill.json`、`SKILL.md`、`index.ts`。

## Runtime 契约

生成的 `index.ts` 必须导出：

```ts
export async function run(ctx: SkillContext, args: Record<string, unknown>): Promise<void>
```

脚本应直接使用原生 Playwright 和 Midscene API：

```ts
const { page, agent } = ctx;
await page.getByRole('button', { name: 'Search' }).click();
await agent.aiTap('the target NE node on the topology canvas');
await agent.aiAssert('the E-Line Service page is open');
```

每个业务语义步骤优先使用 `ctx.withFallback(name, primary, fallback, verify)`：

```ts
await ctx.withFallback(
  'Open target NE',
  async () => {
    await page.getByRole('row', { name: neName }).dblclick();
  },
  async () => {
    await agent.aiTap(`open the NE named ${neName}`);
  },
  async () => {
    await expect(page.getByText(neName)).toBeVisible();
  },
);
```

不要创建另一套动作 DSL。不要把所有 Playwright/Midscene API 再包装成自定义点击、输入、断言函数。

## 生成规则

- 保留 codegen 脚本中体现出来的人类示范业务顺序。
- 按“页面状态转换”切分流程，而不是按每一次底层 click/fill 切分。
- 每个业务语义步骤都应包含：
  - Playwright 主路径；
  - Midscene 视觉 fallback；
  - 有意义时，对达成后的业务状态做 verifier。
- 优先使用稳定 Playwright locator：
  - role；
  - text；
  - label；
  - test id；
  - 邻近稳定文本。
- 除非没有更好选择，否则应把以下 codegen locator 视为不稳定：
  - 动态 id；
  - 长随机 class；
  - 深层 CSS 层级链；
  - 过度依赖 `nth()`；
  - 框架生成的选择器。
- 如果无法推断稳定 locator，应将 Midscene 作为该步骤的 fallback，必要时作为该步骤主操作。
- 只参数化业务数据：
  - NE 名称；
  - 搜索关键字；
  - 业务对象名；
  - tab 或字段列表；
  - 筛选值。
- 固定导航菜单、固定按钮文案、稳定产品 UI 文案默认保持字面量，除非用户任务明确说明这些值可变。
- 生成的 Skill 不得硬编码模型供应商密钥。
- 生成的 Skill 在第一次连接真实系统执行前必须经过人工审查。

## `skill.json` 要求

`argsSchema` 必须使用 JSON Schema。

必填字段：

- `name`
- `type`：固定为 `"task"`
- `version`
- `entry`：通常为 `"index.ts"`
- `risk`
- `argsSchema`

可选字段：

- `description`
- `requiresSession`
- `preSkills`

如果业务 Skill 依赖登录态，应通过 `preSkills` 声明登录 Skill，例如：

```json
{
  "preSkills": ["login_to_nms"],
  "requiresSession": true
}
```

## `SKILL.md` 要求

使用中文描述：

- 任务目的；
- 必需参数；
- 前置条件；
- 生成的步骤大纲；
- verifier 策略；
- 有风险操作的人工审查注意事项。

## `index.ts` 要求

- 如果使用 Playwright 断言，从 `@playwright/test` 导入 `expect`。
- 从 `../../src/runtime/types.js` 导入 `SkillContext` 类型。
- Runtime 已经完成 JSON Schema 校验，但脚本内部仍应做局部类型转换，让代码可读。
- step 名称使用中文业务状态描述，例如：
  - `搜索目标 NE`；
  - `打开 NE Explorer`；
  - `打开 E-Line Service`；
  - `切换到 QOS 页签`；
  - `提取目标字段`。
