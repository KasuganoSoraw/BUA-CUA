# 任务级 Task Skill 生成 Prompt

本 prompt 用于生成具体网页任务的 **Task Skill**，不是生成 BUA-CUA Toolkit 本身。BUA-CUA Toolkit 是本仓库提供的生成与执行工具包；Task Skill 是位于 `skills/<task_name>/` 的具体任务脚本。

你需要基于以下输入，生成一个经过人工审查后可执行的 BUA-CUA 任务级 Skill：

1. 用户自然语言任务描述。
2. 人工成功示范录制得到的 Playwright `codegen.spec.ts`。
3. 工程提取的 `trace_evidence.json`。
4. 可选人工步骤说明或 recorder raw evidence。

必须输出且只输出这些文件：

- `skill.json`
- `SKILL.md`
- `INFERRED_INTENT.md`
- `index.ts`
- `fixtures/input.example.json`

其中 `INFERRED_INTENT.md` 是模型根据输入证据推断出的任务意图与步骤理解。它不是工程事实层，不得写成“用户明确说过”。如果用户的 `intent.md` 很简略或为空，应明确说明哪些内容是根据轨迹推断出来的。

## Runtime 契约

`index.ts` 必须导出：

```ts
export async function run(ctx: SkillContext, args: Record<string, unknown>): Promise<void>
```

脚本应直接使用原生 Playwright、Midscene 和 BUA-CUA runtime API：

```ts
const { page, agent } = ctx;
await page.getByRole('button', { name: 'Search' }).click();
await agent.aiTap('click the visible target item');
```

有网页操作的业务 step 默认使用：

```ts
await ctx.withRecovery(
  '中文业务步骤名',
  async () => {
    // Playwright primary path
  },
  {
    goal: '只描述当前 step 的业务目标',
    hints: [
      '只处理当前 step，不重新规划整个任务',
      '引用与当前 step 相关的 codegen action id、trace evidence 或局部 DOM 证据',
    ],
    allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
    maxTurns: 6,
    risk: 'read_only',
  },
  async () => {
    // Midscene fallback, after recovery fails
  },
  async () => {
    // business-level verifier
  },
);
```

`ctx.withRecovery` 的语义是：先执行 Playwright primary，再执行 verifier；如果 primary 抛错或 verifier 失败，都会启动 step recovery agent。recovery 后会再次执行 verifier；如果仍失败，才进入 Midscene fallback；fallback 后还会再次执行 verifier。生成 verifier 时不要把它当成“失败即终止”的唯一出口，而要把它视为判断当前业务 step 是否需要 recovery 的业务状态检查。

只有在以下情况才使用 `ctx.withFallback`：

- 该 step 没有真实网页交互，只是本地文件处理、参数转换或纯 Playwright assertion。
- 该 step 不适合 recovery agent 自主尝试，例如高风险写操作。
- 用户或 Skill 文档明确要求跳过 recovery。

没有稳定 Playwright primary path 的实验性网页操作可以使用 `ctx.recoverStep`，但普通 codegen 派生的 Task Skill 应优先使用 `ctx.withRecovery`。

不要创建另一套动作 DSL。不要把 Playwright / Midscene API 再包装成自定义点击、输入、断言函数。

## 生成原则

- 保留 codegen 脚本体现的人类示范业务顺序。
- 按“页面状态转换”切分业务 step，而不是按每个底层 `click` / `fill` 机械切分。
- 一个业务 step 可以包含多个 Playwright action，例如“输入搜索词并选择自动补全项”“选择多个筛选项并应用”“打开导出面板并确认下载”。
- 每个网页业务 step 应包含：
  - Playwright primary path；
  - step recovery agent 配置；
  - Midscene fallback；
  - 必要的 business-level verifier。
- 生成内容使用中文说明；代码 API、路径、字段名保持英文。
- 不得硬编码模型 provider API key。
- 真实业务 Skill 第一次执行前必须人工审查。

## 使用 trace evidence

- `trace_evidence.json` 是工程事实层，不是模型推理层。
- 必须用其中的 facts 理解 codegen action 的 before/action/after 状态、locator 实际目标、页面跳转、状态变化和 verifier 候选。
- 使用每个 action 的 `logs` 理解 Playwright 在录制回放时的 action-level 执行状态。`logs` 可能包含 locator resolved、元素 visible/enabled/stable、scrolling into view、click/fill/select completed、navigation waited、strict mode violation 等信息。
- 如果 `logs` 显示 locator resolved、元素 actionability 通过且动作完成，说明该录制 action 在 trace 中成功执行。不要因为某个后续 wrapper/text verifier 不稳定而否定该 action 本身。
- `logs` 只能证明 action-level success，不能自动替代 business-level verifier。
- `state.delta` 和 `verifierCandidates` 用于设计 verifier，但不得照抄成脆弱断言。
- `controlChecked`、`controlValue`、`urlQueryParam` 通常是强 verifier 候选。
- `dialogLikeState` 和 `textAmbiguityWarning` 更多是风险提示，需要结合当前业务 step 选择稳定验证目标。
- 模型生成的步骤描述、verifier 和 recovery hints 应能追溯到 action id、snapshot id、selected frame、locator、URL 或状态变化。
- 不要编造 trace 中不存在的动作、URL、locator 或页面文本。

## Primary 生成策略

- 优先使用 codegen 录制成功的 locator 形态，除非它明显不稳定。
- 如果 codegen 使用稳定 text / role / label / test id，应优先保留或做轻量参数化。
- 如果 codegen locator 包含动态 id、随机 class、深层 CSS 链、框架生成 selector、过度 `nth()`，应改写为更稳定的业务 locator。
- 改写 locator 时必须保留“人类实际操作目标”的语义，不要把一个已经在 trace 中证明成功的可见目标改写成不可点击的内部实现元素。
- 如果无法确定稳定 primary path，应写清 recovery hints，让 recovery agent 用当前页面的截图和局部 DOM 证据完成当前 step。

## 自定义 radio / checkbox 控件

- 对自定义 `radio` / `checkbox` 控件，不要机械地把 codegen 中成功点击的可见文本或 label 改写为 `page.getByRole('radio' | 'checkbox', { name }).click()`。
- 很多企业 UI 会把真实 `input[type=radio|checkbox]` 绝对定位到视口外，只让用户点击可见 `label` 或自绘容器。此时 role locator 可能命中离屏 input 并失败。
- 如果 codegen 或 trace logs 显示用户成功点击的是 `getByText(...)`、`label` 或可见文本区域，且 DOM evidence 表明 input 可能隐藏、离屏、绝对定位或存在关联 label，应优先生成“可见业务 label/text/container”定位。
- 可使用 scoped `getByText(new RegExp(...)).click()`、`locator('label').filter({ hasText: ... }).click()`，或在脚本内部通过业务值查找对应 `label[for]` 后点击 label。
- 对这类控件的泛化目标不是 HTML role 本体，而是用户实际操作的可见业务目标。
- 只有 trace 证明 `getByRole('radio' | 'checkbox')` 自身可 actionably click，且没有离屏 input 风险时，才优先使用 role locator 点击。
- verifier 可以验证对应业务状态，例如 checked 状态、URL 参数、筛选 chip、结果变化或下载事件；但执行点击动作时应优先点击可见 label/text/container。

## Verifier 策略

- verifier 应验证当前业务 step 的后置状态，而不是验证“刚才点击过”。
- 不要把“下一步要点击的目标”当作“当前 step 已完成”的 verifier。
- 如果下一条 trace action 的 logs 显示 `scrolling into view if needed`，说明该目标可能不在当前视口内。不要在上一 step 中用该目标 `toBeVisible()` 作为 verifier；应让下一步 Playwright `click()` 自己滚动并执行。
- 对“打开弹窗 / 菜单 / 面板”类 step，verifier 应验证容器打开状态、标题、已选配置或关键区域存在，而不是验证面板底部需要滚动后才可见的提交按钮。
- 下载类 step 应以 Playwright download event、保存文件路径和非空文件大小作为最终 verifier。
- 使用文本 verifier 时，应确认文本是用户可见业务状态；如果页面存在同名隐藏文本、模板、label 或副本，应缩小作用域，或改用 checked/value/url/download/result 状态。
- 对动态 SPA 页面，避免要求短暂 loading 文本必须出现；优先等待最终状态稳定。
- 如果 verifier 只能达到 weak 级别，应在 `INFERRED_INTENT.md` 标注不确定性，并提供 recovery hints。

## 参数化策略

- 只参数化业务数据，例如搜索关键词、对象名称、筛选值、tab 名、字段列表、结果数量、导出格式、下载目录。
- 参数必须是用户能用自然语言表达、能从任务意图中抽取，或能在页面中以稳定业务语义定位的值。
- 不得把 DOM 内部实现细节暴露成用户参数，例如随机 id、CSS class、XPath、深层 selector、录制临时 handle、内部 hit id。
- 如果录制选择“前 N 条结果”，对外参数应设计为 `resultCount`，或在业务允许时设计为稳定业务标识列表。
- 如果录制选择某个筛选项，对外参数应设计为可读业务值，脚本内部再把业务值映射到稳定 locator。
- 可变筛选条件不得写死在 recovery hints 或 Midscene fallback 中。若某个筛选值进入参数，`primary`、`recoveryOptions.goal`、`recoveryOptions.hints`、Midscene fallback 和 verifier 都必须使用该参数表达当前目标。
- 如果只能通过 trace 中的 DOM id 复现录制动作，但无法建立用户可理解的业务参数映射，应在 `INFERRED_INTENT.md` 的不确定点中说明。

## `skill.json` 要求

`argsSchema` 必须使用 JSON Schema。

必填字段：

- `name`
- `type`: 固定为 `"task"`
- `version`
- `entry`: 通常为 `"index.ts"`
- `inferredIntent`: 通常为 `"INFERRED_INTENT.md"`
- `risk`
- `argsSchema`

`risk` 只能使用：

- `"read_only"`：只读查询、筛选、导出或下载公开/允许访问的数据。
- `"write_review_required"`：会提交表单、创建、修改配置或影响远程系统状态。
- `"destructive_review_required"`：删除、重启、清空、覆盖或不可逆操作。

可选字段：

- `description`
- `requiresSession`
- `preSkills`

如果业务 Skill 依赖登录态，应通过 `preSkills` 声明登录 Skill。

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
- step 名称使用中文业务状态描述。
- 不要生成 `recordings/codegen.spec.ts`，该文件由工具复制原始 codegen。

## `fixtures/input.example.json` 要求

- 必须匹配 `skill.json` 中的 `argsSchema`。
- 只包含运行该 Task Skill 所需的业务参数。
- 不得包含 DOM 内部实现细节、录制临时 handle 或 selector 片段。
- 示例值应优先来自 codegen 和 trace 中出现的真实录制值；如果是模型推断，应在 `INFERRED_INTENT.md` 的不确定点中说明。
