# dsh-superagent-router

从 `dsh-superagent-prototype`（commit `8c32a9d`，2026-10-31）里剥离出来的 **路由那一半**：Trigger 摄入、按 Thread 批量评估、Decision（accept / attach / ignore / stop）、Ticket 创建，以及 `orchestrator_route` 工具。

个人助理场景里还缺一个"直接回答"的结果：本仓库把它放在宿主层（`Lab.answer` 直接写 Outbox 并记 `ignore{answered}`），因为核心的 `Replies.answer` 要求"某个 worker 的回答"，无票的内联回答走不通。`docs/ablation.md` 量化了它的收益。

零运行时依赖，不需要构建：Node ≥ 22.18 的 TypeScript 类型擦除直接跑。领域核心是逐字复制的，只有三处标注 `[router-lab]` 的改动（见下）。

```bash
cd ~/workspace/router
node --experimental-transform-types --no-warnings --test test/*.spec.ts   # 37 个测试
node --experimental-transform-types --no-warnings src/sim/run.ts          # 个人助理场景评测（规则策略）
node --experimental-transform-types --no-warnings src/sim/run.ts --router llm --model deepseek-flash   # 真实模型
node --experimental-transform-types --no-warnings src/sim/sweep.ts --model deepseek-flash --repeat 3 \
  --scenarios personal-chat,many-tasks,twin-subjects,long-stream          # 多次采样 + token/延迟
node --experimental-transform-types --no-warnings src/sim/aime-eval.ts --mode windows --router llm
  # 真实语料：Aime 导出（--corpus 指路径，原文不入库）
npm run sim:ablate   # 消融：v0/v1/v2/v3/v4/v6/v7/v8，见 docs/ablation.md
```

`--router llm` 读取 `DEEPSEEK_API_KEY`（环境变量，或本目录的 `.env`），按请求体哈希缓存在 `src/sim/.cache/`，重放零成本。

## 目录

```
src/core/            领域核心，逐字复制自 dsh-superagent/src/core（15 个文件，~2100 行）
  engine.ts          唯一事务入口；每个命令一个 repo.atomic()
  evals.ts           Eval 批量化、gate 强度、deadline、Decision 落盘
  tickets.ts         Ticket 聚合：accept 建票、attach 投递、stop 结束、resume 唤醒
  intake.ts          摄入、去重、订阅扇出、排队评估
  model.ts           领域模型与不变量（followupOwners、settled、reaches…）
  memory.ts          内存 Repositories，供测试与实验室
src/routing/
  route-tool.ts      orchestrator_route 的纯逻辑移植（FIELDS 表、逐项校验、逐项执行）
  limits.ts          词数限制（IM 100 词 / note 30 词）
src/lab/
  session.ts         把 Engine 接上内存端口，提供 receive / tick / route / deliver / report / handback
  assessor.ts        候选卡片投影（含 related_tickets 的 8 张上限），与主 Session 看到的一致
  policy.ts          最小 Policy：允许名单内的 direct 消息 = explicit，其余 inferred
  executor.ts        记录型 Executor
  outbox.ts          内存 Outbox
src/sim/
  scenarios.ts       5 组对话语料（含 ground truth）：交错、10 任务、同名不同对象、20 条长流、批次
  router-policies.ts oracle / keyword / 基线策略
  llm.ts             真实模型路由（DeepSeek，带磁盘缓存、字段校验与 token 统计）
  run.ts             指标计算 + 报告
  sweep.ts           多次采样：strict/safe、串台、粒度、token、延迟
  aime.ts            真实导出解析、窗口切片、标注 → Scenario
  aime-labels.ts     两个窗口的人工标注（只存轮次与意图）
  aime-eval.ts       真实语料评测：判分窗口 + 60 条流量画像
  aime-scan.ts       语料统计与用户消息清单
  aime-dump.ts       打印窗口全文，供人工标注
  variants.ts        消融变体（去 coding / answer / 级联 / 指纹卡）
  ablate.ts          消融矩阵：效果、准确度、调用数、token、耗时
test/                26 个测试：核心不变量、工具语义、个人助理回归
docs/findings.md     在 personal agent 场景下的评测结论
```

## 抽取边界

| 保留（逐字） | 说明 |
|---|---|
| `src/core/**` | 领域层完全无外部依赖（只 import `node:crypto`），可直接搬用 |
| `orchestrator_route` 的决策语义 | 四种 kind、字段表、批内去重、逐项失败隔离、返回值形状 |
| `Evals.decide` 的全部不变量 | evalId 校验、accept 幂等、`workerDecides`、stop 降级、`admitsInferred`、Policy 漂移自愈 |

| 适配 | 说明 |
|---|---|
| schema | 原实现用 zod（`.strict()` + `superRefine`），这里换成手写 `parseCall` / `invalid`，规则一一对应；字段错误文案略有差别 |
| 卡片 | 原 `candidateCard` 会解析 GitHub/Feishu 链接和 PR 引用，这里只保留 routing 需要的字段；`related_tickets` 的 8 张上限与排序保持原样 |
| 端口 | Policy / Outbox / Executor / Assessor 换成内存实现；`Sessions`、DSH preset、`orchestrator_*` 其余 13 个工具不在范围内 |

| 不包含 | 原因 |
|---|---|
| DSH Session 装配（`sessions.ts`、preset、`noWait` guard） | 属于宿主运行时，不是路由判定 |
| 管理面板 / HTTP 路由 / 客户端 route | 与任务分组无关 |
| Sources（GitHub / Feishu） | 需要真实凭证；`Trigger` 形状已足够模拟 |
| 演示与记忆、worker 执行 | 属于执行侧；实验室用 `report` / `handback` 模拟 |

## 与原始实现的差异

1. **`EngineOptions.ownership`（`[router-lab]`，`src/core/part.ts` + `intake.ts`）**
   `thread`（默认）保持原语义：人在某个 Thread 上发言，扇出给所有订阅该 Thread 的 Ticket，由它们的 worker 判断归属；主 Session 只能 stop。
   `routed`：人的消息不按订阅扇出，一律进 Eval，只有主 Session 的 accept/attach 能把消息放进某张票。用于「一个 Thread 承载多个任务」的场景（例如个人助理的单一聊天流）。非人类消息（bot/CI）两种模式都照旧扇出。
   默认值下行为与原实现一致，全部原测试语义不变。

2. **zod → 手写校验**：`parseCall` 复刻 `.strict()`、1–20 条上限、未知键拒绝；`invalid` 复刻「按 kind 读/需字段」的表。缺字段的报错文案从 zod 的英文句式改成 `accept needs title`，语义相同。

3. **`ticketCard` 裁剪**：只保留 `ticket_id / title / state / strength / preview / read`，状态推导沿用原 `cardState`（`person/*`、`working`、`idle`、已结束 outcome）。

实验开关（默认不影响原语义）：

- `RouteToolOptions.requireWorktreeName`（`src/routing/route-tool.ts`）：个人助理可以不给 git worktree 名，默认仍必填。
- `LabOptions.cardStyle: 'index'`（`src/lab/assessor.ts`）：把 8 张全量票卡换成 12 条 `title + keywords + state` 任务指纹。
- `Lab.answer`（`src/lab/session.ts`）：内联回答的宿主实现（见上）。

## 行为清单（测试锁住）

- accept 建票：`origin.triggerIds`、Thread 订阅、`mandate.scope = title`、acknowledgement 入 Outbox。
- accept 幂等：同一 Trigger 二次 accept 返回同一 Decision，不新建 Ticket。
- stop：只有 explicit 消息能停；inferred 的 stop 降级为 `ignore{stopNotExplicit}`；不存在/已结束的票 → `ignore{stopUnknown}`。
- 归属：worker 仍拥有消息时，accept / attach / ignore 一律 `UserError('workerDecides')`，stop 例外。
- 批次：同一 Thread 的 pending 合成一个 Eval；**一条 accept 决定整批**，并把整批写进 `origin.triggerIds`。
- attach：订阅 Thread、投递 Input、结束 Eval；handback 过的消息不能 attach 回同一张票；人停过的票拒绝 attach。
- resume：attach 到已结束且 Mandate 仍有效的票会唤醒它；人停过的票不醒。
- 工具：逐项校验、逐项执行、顺序与入参一致；一项被拒不影响其余；每次调用请求一次 pass。
- 已知缝隙（测试如实记录）：`attach` 不登记批内 `decided`，同一 call 里后续的 `ignore` 会落到 Engine —— 但此时票已拥有该消息，`leftToWorkers` 会拒绝，因此不会产生第二条 Decision。
- 被拒的路由命令会释放 Eval（`ignore{notAttachable}`），不再把整个 Thread 锁到超时。
- `acceptBatch: 'primary'` 让一条 accept 只接收自己的 Trigger；`batchSplitter`（`splitBatches`）在同批到达时按相似度切分。
- 卡片召回：最近 8 张 + 关键词命中的旧票（≤4）。
- 向量级联（`embeddingCascade`）实现完成但实测更差，默认关闭；见 `docs/ablation.md` 第 8 节。

## 接入自己的运行时

```ts
import { Engine, MemoryRepositories } from './src/core/index.ts'
import { executeRoute } from './src/routing/route-tool.ts'

const engine = new Engine({ repo, now, policy, scope, assessor, executor, outbox, emit, ownership: 'routed' })
engine.receive(trigger)     // source → intake
engine.evaluateDue()        // 一个 pass：开始到期的 Eval
// assessor 收到 Candidate → 序列化成卡片递给模型 → 模型回 items
executeRoute(host, { decisions: items })   // host 只需 decide/attach/ticket/decisionOf/requestPass/quietly
```

`host` 的六个方法就是主 Session 与 Engine 的全部接触面；换成 DSH、HTTP 或本地 CLI 都只影响这一层。

## 评测

`docs/findings.md` 是完整结论。摘要（16 条消息、4 个任务、真实交错）：

| 场景（routed） | 消息 | oracle | flash strict | flash safe | v4-pro strict | 串台 |
|---|---|---|---|---|---|---|
| 任务交错 | 16 | 16 | 10.7 (67%) | **16** | **15 (94%)** | 0 |
| 十个任务后回头 | 12 | 12 | 10.3 | 12 | 10.5 | 0 |
| 同名不同团队 | 7 | 7 | **7 (100%)** | 7 | — | 0 |
| 20 条长流 + resume | 20 | 20 | 18.7 | **20** | — | 0 |
| 三条同批到达 | 3 | 1 | 1 | 1 | — | 0 |
| 三条分开到达 | 3 | 3 | **3** | 3 | — | 0 |

原语义（`thread`）下，同样的 16 条消息，**完美路由器和真实模型都只有 2/16**：第一条 accept 之后，整个聊天流就归第一张票所有，14 条串台、11 条 router 根本看不到。把归属从订阅上摘下来后，真实模型零串台、零丢消息；扣分项主要是"任务粒度"（把行程拆成机票/酒店/天气），而不是分错。

另有两条硬约束（见 `docs/findings.md` 第 5、6 节）：一个 Eval 批次只能产出一张票（模型逐条输出三个 accept 也一样），以及一次被拒的路由命令会让 Eval 卡住、同 Thread 的后续消息全部排队。
