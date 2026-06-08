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
- 使用每个 action 的 `logs` 理解 Playwright 在录制回放时的 action-level 执行状态。`logs` 是 Playwright trace 自带的自然语言执行诊断，例如 locator resolved、element visible/enabled/stable、click/fill/select completed、navigation waited、strict mode violation 等。
- 如果 `logs` 显示 locator resolved、元素 visible/enabled/stable 且动作完成，说明该录制动作在 trace 中成功执行；生成 Skill 时不要因为后续某个 wrapper/text verifier 不稳定，就错误否定这个 action 本身。
- `logs` 只能证明 action-level success，即“录制动作被 Playwright 成功复现”；它不能自动替代 business-level verifier。搜索、筛选、下载、提交、数据提取等业务 step 仍应优先验证后置业务状态。
- 使用 `trace_evidence.json` 中每个 action 的 `state.delta` 和 `verifierCandidates` 设计 verifier：
  - `controlChecked` 优先生成 `toBeChecked()`，并用业务标签或区域定位控件；
  - `controlValue` 优先生成 `toHaveValue()`；
  - `urlQueryParam` 可用于 URL/query 参数断言；
  - `dialogLikeState` 只能说明 trace 中出现了弹窗/对话框类 DOM 或 class 状态变化，不能直接证明 wrapper 可见；弹窗 verifier 应优先验证内部可见 heading/button，或验证稳定 class/state；
  - `textAmbiguityWarning` 表示同名文本可能有多个副本或隐藏副本，遇到这类提示时不得直接使用宽泛的 `getByText(...).toBeVisible()`。
- `controlChecked`、`controlValue`、`urlQueryParam` 通常是强 verifier 候选；`dialogLikeState` 和 `textAmbiguityWarning` 更多是风险提示，需要结合当前业务 step 选择更稳定的验证目标。
- `verifierCandidates` 是工程事实候选，不是必须照抄的代码。生成 verifier 时应保留其业务语义，避免把候选中的 DOM id/class 变成用户参数。
- 如果额外提供了 Playwright trace 原始包，可在事实摘要不足时查看细节；trace 不替代运行时 fallback，也不意味着页面变化后无需 recovery。
- 模型生成的步骤描述、verifier 和 recovery hints 必须能追溯到 action id、snapshot id 或 selected frame；不得编造 trace 中不存在的动作、URL、locator 或页面文本。
- 按“页面状态转换”切分流程，而不是按每一次底层 click/fill 切分。
- verifier 应服务于业务语义 step，而不是每个底层 Playwright action。一个业务 step 内可以包含多个 Playwright action，例如“输入搜索词并选择自动补全项”“选择多个筛选项并点击 Apply Filters”“打开下载弹窗并确认下载”。这种情况下应在 step 末尾验证该 step 的业务状态，而不是每次 click/fill 后都机械断言。
- 如果一个 step 内的多个 action 已由 Playwright `logs` 证明成功执行，且后续 step 会自然暴露失败，可以减少中间 action verifier，把主要 verifier 放在业务状态转换完成后。
- verifier 强度分三层理解：
  - strong：业务状态 verifier，例如 checked/value/url/download/result visible；
  - medium：Playwright action logs 成功，且后续业务 step 能继续推进；
  - weak：Playwright action logs 成功，但缺少可靠后置状态。遇到 weak verifier 时，应在 `INFERRED_INTENT.md` 标注不确定性，并尽量给 recovery hints。
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
- 参数必须是用户能用自然语言表达、能从任务意图中抽取，或能在页面上以稳定业务语义定位的值。不要把 DOM 内部实现细节暴露成参数，例如：
  - 不要把 `hit-sel-0`、`adv-radio-sex2`、随机 id、CSS class、XPath、深层 selector 当作 `argsSchema` 或 `fixtures/input.example.json` 中的用户参数；
  - 这些 DOM 细节只能作为 `index.ts` 内部 locator 证据、trace evidence 引用或 recovery hints；
  - 如果录制中选择了“前三条结果”，对外参数应设计为 `resultCount: 3`，或在业务允许时设计为稳定的 `nctIds` / `resultTitles`；
  - 如果录制中选择了某个筛选项，对外参数应设计为可读业务值，例如 `sex: "Male"`、`ageGroup: "Child (birth - 17)"`、`status: "Recruiting and not yet"`，脚本内部再把业务值映射到稳定 locator。
- 可变筛选条件不得写死在 recovery hints 或 Midscene fallback 中。若某个筛选值进入参数，`primary`、`recoveryOptions.goal`、`recoveryOptions.hints`、Midscene fallback 和 verifier 都必须使用该参数表达当前目标，例如 `${args.sex}` / `${args.ageGroup}`，而不是固定写死 `Male` / `Child`。
- 如果只能通过 trace 中的 DOM id 复现录制动作，但无法建立用户可理解的业务参数映射，应在 `INFERRED_INTENT.md` 的“不确定点和需要人工审查的地方”中明确说明；不要假装该 DOM id 是合理的业务输入。
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
- 不得包含 DOM 内部实现细节、录制临时 handle 或 selector 片段，例如 `hit-sel-0`、`adv-radio-sex2`、`#some-id`、`.some-class`、XPath。若脚本内部需要这些值，应在 `index.ts` 中由业务参数映射得到，或作为固定 locator 证据写在脚本内部。
- 示例值应优先来自 codegen 和 trace 中出现的真实录制值；如果是模型推断，应在 `INFERRED_INTENT.md` 的不确定点中说明。
