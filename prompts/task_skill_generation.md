# 任务级 Skill 生成 Prompt

本 prompt 用于生成具体网页任务的 **Task Skill**，不是生成 BUA-CUA Toolkit 本身。BUA-CUA Toolkit 是本仓库提供的生成与执行工具包；Task Skill 是位于 `skills/<task_name>/` 的具体任务脚本。

你需要基于下面输入，生成一个经过人工审查后可执行的 BUA-CUA 任务级 Skill：

1. 用户的自然语言任务描述。
2. 一段由人工成功示范录制得到的 Playwright codegen 脚本。
3. 必须提供的 trace facts summary：`inputs/<task>/trace/trace_evidence.json`。
4. 可选的 enhanced recorder raw evidence，例如 `inputs/<task>/recording/recording.json`、`actions/*.json` 和截图。
5. 可选的 Playwright trace evidence 原始包，例如 `inputs/<task>/trace/trace.zip`，用于必要时查看细节。

你必须一次性输出且只输出五个文件的内容：`skill.json`、`SKILL.md`、`INFERRED_INTENT.md`、`index.ts`、`fixtures/input.example.json`。

其中 `INFERRED_INTENT.md` 是模型根据 `intent.md`、`codegen.spec.ts`、`trace_evidence.json` 和可选 recorder evidence 推测出的任务意图与步骤理解。它不是工程事实层，不得写成“用户明确说过”。如果用户的 `intent.md` 很简略或为空，应明确说明哪些内容是根据轨迹推断出来的。

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

每个有网页操作的业务语义步骤默认使用 `ctx.withRecovery(name, primary, recoveryOptions, midsceneFallback, verify)`，执行链路必须是：

```text
Playwright primary
  -> primary 失败时启动 step recovery agent，使用 CDP/DOM/截图工具尝试完成当前 step
  -> recovery 失败或未配置模型时再进入 Midscene fallback
  -> 最后执行 verifier
```

示例：

```ts
await ctx.withRecovery(
  'Open target NE',
  async () => {
    await page.getByRole('row', { name: neName }).dblclick();
  },
  {
    goal: `打开名为 ${neName} 的 NE 详情页`,
    hints: [
      '只处理当前 step，不重新规划整个任务',
      '优先使用当前页面局部 DOM、locator 证据和截图判断目标控件',
    ],
    allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
    maxTurns: 6,
    risk: 'read_only',
  },
  async () => {
    await agent.aiTap(`open the NE named ${neName}`);
  },
  async () => {
    await expect(page.getByText(neName)).toBeVisible();
  },
);
```

只有以下情况可以使用 `ctx.withFallback`：

- 该 step 没有真实网页交互，只是本地文件处理、参数转换或纯 Playwright assertion；
- 该 step 的 primary 失败后不适合由 recovery agent 自主尝试，例如高风险写操作；
- 用户或 Skill 文档明确要求跳过 recovery。

没有稳定 Playwright primary path 的网页操作步骤可以使用 `ctx.recoverStep(name, recoveryOptions, midsceneFallback, verify)`，但普通 codegen 派生的 Task Skill 应优先使用 `ctx.withRecovery`。

不要创建另一套动作 DSL。不要把所有 Playwright/Midscene API 再包装成自定义点击、输入、断言函数。

## 生成规则

- 保留 codegen 脚本中体现出来的人类示范业务顺序。
- 如果提供了 enhanced recorder raw evidence，应把它作为辅助证据使用，不替代 codegen 的业务顺序。
- 使用 raw evidence 时应优先关注当前步骤相关的 before/after 状态变化、局部 DOM evidence、selector candidates 和截图；不要把全部 evidence 无差别塞入单个步骤。
- 如果截图文件名或 action 记录中出现 `annotatedViewport` / `*-annotated.png`，该图片基于操作前截图生成，其中的红色十字、圆圈和中心圆点是 BUA-CUA recorder 后处理添加的，用于指示人类操作位置，不是网页自身 UI。不得把该标记当成页面元素或业务控件。
- 必须优先使用 `trace_evidence.json` 中工程提取的 facts 来理解 codegen action 的 before/action/after 状态、locator 实际目标、页面跳转和 verifier 候选。
- 如果额外提供了 Playwright trace 原始包，可在事实摘要不足时查看细节；trace 不替代运行时 fallback，也不意味着页面变化后无需 recovery。
- 模型生成的步骤描述、verifier 和 recovery hints 必须能追溯到 action id、snapshot id 或 selected frame；不得编造 trace 中不存在的动作、URL、locator 或页面文本。
- 按“页面状态转换”切分流程，而不是按每一次底层 click/fill 切分。
- 每个业务语义步骤都应包含：
  - Playwright 主路径；
  - step recovery agent 配置；
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
- 如果无法推断稳定 locator，应优先在 `ctx.withRecovery` 的 `recoveryOptions.hints` 中写清当前 step 的目标和证据，让 recovery agent 尝试用 `jsProbe`、`inspectAt`、`domAct`、`clickAt` 等工具完成；Midscene 应作为 recovery 之后的兜底，而不是第一 fallback。
- 生成 verifier 时优先参考动作后的业务状态变化，例如 URL 变化、关键文本出现、筛选 chip 可见、下载文件存在、弹窗打开或表格内容变化；不要只验证“点击动作已执行”。
- verifier 不得把隐藏元素当作成功条件。使用文本 verifier 时，应确认目标文本是用户可见状态；如果页面存在同名隐藏 radio/label/template，应改用 `locator.filter({ hasText })` 缩小到可见业务区域、验证 checkbox/radio `checked` 状态、URL 参数、下载事件或结果卡片状态。
- 对动态 SPA 页面，避免要求短暂 loading 文本“必须先出现”。更稳的 verifier 是等待最终状态，例如 URL 参数稳定、结果卡片可见、筛选 chip/计数可见、下载事件触发。
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
- `inferredIntent`：通常为 `"INFERRED_INTENT.md"`
- `risk`
- `argsSchema`

`risk` 只能使用以下枚举值之一，不得输出其他值：

- `"read_only"`：只读查询、筛选、导出或下载公开/允许访问的数据。
- `"write_review_required"`：会提交表单、创建、修改配置或影响远程系统状态。
- `"destructive_review_required"`：删除、重启、清空、覆盖、不可逆操作。

可选字段：

- `description`
- `requiresSession`
- `preSkills`

如果生成了 `INFERRED_INTENT.md`，`skill.json` 必须引用它：

```json
{
  "inferredIntent": "INFERRED_INTENT.md"
}
```

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

`SKILL.md` 可以摘要说明模型理解的步骤，但完整的模型推测意图必须放在 `INFERRED_INTENT.md`。

## `INFERRED_INTENT.md` 要求

使用中文描述，并包含醒目的来源说明：

```md
# LLM 推测任务意图

> 本文件由 LLM 根据 `intent.md`、`codegen.spec.ts`、`trace_evidence.json` 和可选 recorder evidence 推测生成。
> 它是执行与 recovery 的参考说明，不是工程事实层，也不代表用户逐字确认过。
```

内容应包含：

- 任务目标假设；
- 参数含义假设；
- 模型归纳出的业务步骤；
- 每个步骤对应的 codegen 行号、trace action id、snapshot/frame 证据；
- verifier 设计依据；
- 不确定点和需要人工审查的地方。

不要把 `trace_evidence.json` 的全部内容复制进来；只引用关键 action id、locator、URL、截图路径或状态变化。

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

## `fixtures/input.example.json` 要求

- 必须匹配 `skill.json` 中的 `argsSchema`。
- 只包含运行该 Task Skill 所需的业务参数。
- 示例值应优先来自 codegen 和 trace 中出现的真实录制值；如果是模型推断，应在 `INFERRED_INTENT.md` 的不确定点中说明。
