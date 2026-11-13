# 这个 router 在 personal agent 场景里表现如何

结论先说：**机制是对的，单位是错的。**

- 它把「新任务 / 续接 / 忽略 / 停止」四种动作定义得很干净，幂等、可审计、失败隔离都扎实；
- 但分组单位是 **Thread**，不是 **任务**。GitHub 里 Issue/PR 就是任务，所以成立；个人助理只有一个聊天流，Thread 变成了"用户"，第一条 accept 之后，整个对话就归第一张票所有。
- 把归属从订阅上摘下来（`ownership: 'routed'`）后，真实模型在四个场景、三次重复里 **零串台、零丢消息**；剩下的分歧几乎都是"任务粒度算多细"的产品决策，而不是路由错误。
- 换成真实语料（Aime 六周、321 条用户消息）后，最突出的问题换了一个：**约 1/3 的消息是内联问答，router 没有"直接回答"这个结果**；同时 schema 的 coding 语境让模型把"跑授权、做对比"这类真实任务判成"没有代码改动，无需建票"。

下面的数字全部可用 `src/sim/sweep.ts` 与 `src/sim/run.ts` 复现。

## 1. 怎么测的

- **驱动**：`Lab` 直接驱动抽取出来的 `Engine`，与宿主同一条路径：`receive` → `tick`（一个 pass）→ 候选卡片 → `orchestrator_route` → worker `deliver` / `handback` / `report`。
- **两类变量**：
  - **机制**：`oracle` 知道 ground truth，代表"模型永远判断正确"。它失败的地方就是机制的问题。
  - **模型**：DeepSeek `deepseek-flash`（默认）与 `deepseek-v4-pro`，真实 API 调用。提示词只给候选卡片 + 最近 8 条对话 + 工具字段约束，不给代码、不给 ground truth。
- **语料**（任务归属是 fixture 的人工标注，路由器看不到）：

| 场景 | 消息 | 任务 | 考点 |
|---|---|---|---|
| `personal-chat` | 16 | 4 | 任务交错、来回切、中途叫停 |
| `many-tasks` | 12 | 10 | 十个任务后回头找最早的那个（卡片只显示 8 张） |
| `twin-subjects` | 7 | 3 | A/B/C 三个团队的同名周报模板：相似主题不能合并 |
| `long-stream` | 20 | 6 | 两次回到已完成的任务（resume）、长距离上下文 |
| `burst` / `burst-split` | 3 | 3 | 三条无关请求同批到达 vs 分三个 pass |

- **指标**：
  - `strict`：机器可判定的正确率，续接必须落在"任务的同一张票"上；
  - `safe`：**没有串台、没有丢失、没有未看到、没有拒绝，stop 真的停了** —— 允许拆成更细的子任务；
  - `leaked`：消息落进别的任务的票（最严重的错误）；
  - `tickets/任务`：粒度，不等于对错。
- **归属模式**：`thread` 是原实现语义（订阅扇出）；`routed` 是本仓库新增的开关（人的消息一律先到 router，只有 accept/attach 能落票）。

## 2. 机制上限：thread 13%，routed 100%

| 路由器 | 归属=thread | 归属=routed |
|---|---|---|
| oracle | 2/16 (13%) | **16/16 (100%)** |
| LLM flash | **2/16 (13%)** | 10.7/16 strict · **16/16 safe** |
| LLM v4-pro | — | 15/16 strict · **16/16 safe** |
| keyword（词面） | 2/16 (13%) | 10/16 (63%) |
| always-new | 2/16 (13%) | 5/16 (31%) |

`thread` 列里连完美路由器都只有 13%，原因不是模型：

1. **订阅即归属**：[intake.ts](<router/src/core/intake.ts#L38>) 把人的消息扇出给该 Thread 上每一张订阅票，活的、已结束的都算（人停过的除外）。
2. **router 被锁死**：消息既然已经到达票，`followupOwners` 就认为票的 worker 决定它，accept / attach / ignore 全部被 `workerDecides` 拒绝，只剩 stop。
3. **`wake` 自动恢复**：已结束的票收到人的消息就自己醒，不需要任何 Decision。

20 条消息的 `long-stream` 更明显：thread 模式下 oracle 3/20、真实模型 3/20，17 条串台、18 条 router 没看到。

具体故障：

- **"算了邮件先不写了"停不掉**：与邮件票同任务，worker 当普通输入收下，而 worker 没有停止权。只能靠 `follow_up` notice 用 `kind: stop` 补停，但它同时被扇出给了别的票。
- **一句"谢谢"复活已完成的任务**（`resume 3 / 空转 1`）。
- **两条无关新请求被"救援"成新票，但各自已经被 2~3 张票读过一遍**。

## 3. 真实模型实测（routed，零串台）

DeepSeek 真实调用，每个场景独立采样（每次全新缓存），temperature 0。`strict` / `safe` 见 §1。

| 场景 | oracle | flash strict | flash safe | v4-pro strict | v4-pro safe | 串台 | tickets/任务 |
|---|---|---|---|---|---|---|---|
| `personal-chat` 16 条 | 16 | **10.7 (67%)** | **16/16** | **15 (94%)** | **16/16** | 0 | flash 7.7 / pro 5.5（期望 4） |
| `many-tasks` 12 条 | 12 | 10.3 (86%) | 12/12 | 10.5 (88%) | 12/12 | 0 | 10.3 / 10.5（期望 10） |
| `twin-subjects` 7 条 | 7 | **7 (100%)** | 7/7 | — | — | 0 | 3/3 |
| `long-stream` 20 条 | 20 | **18.7 (93%)** | **20/20** | — | — | 0 | 7（期望 6） |
| `burst` 3 条 | 1 | 1/3 | 1/3 | — | — | 0 | **1/3，swept 2** |
| `burst-split` 3 条 | 3 | **3/3** | 3/3 | — | — | 0 | 3/3 |

**结论一：分组是安全的。** 4 个场景 × 3 次运行，`leaked = 0`、`lost = 0`、`unseen = 0`。模型没有把任何一条消息塞进别的任务的票里；同名不同对象（A/B/C 团队模板）三次全对。

**结论二：扣分项主要是"粒度"，不是"分错"。** flash 在 `personal-chat` 上开了 7.7 张票（期望 4）：它把"大阪行程"拆成机票 / 酒店 / 天气几个子任务，之后每条续接都正确地落在对应子任务上。按"一任务一票"的标注算碎片，按语义算对。真正的语义错误只有 2 条左右：

- 「把刚才那个周报模板导出成 PDF」→ 开了新票（应续接）；
- 「周报里再加一列本周风险」→ 开了新票（应续接）；
- 「对了，上周那个周报模板还在吗」→ 直接 ignore（这是一个产品判断：纯问题要不要建票）。

v4-pro 只有 1 条真错（「PR 的测试挂了，帮我看看」→ 新票），并把票数压到 5.5 张，说明**粒度可以靠模型能力收敛**。

**结论三：8 张票的召回上限会制造重复，不会制造串台。** `many-tasks` 里连续开 10 个任务后回头续接第 1 个：卡片只显示最新 8 张，第 1 张不在其中，两个模型都只好新建一张同主题的票（`tickets 10.3~10.5`），但 `leaked = 0`、`safe = 12/12`。这是**看起来对、实际上重复**的失败模式，个人助理里会表现为"同一件事被做了两遍"。

**结论四：成本与延迟。**

| 模型 | 每次决策 prompt / completion | 平均延迟 | 推理 token 占比 |
|---|---|---|---|
| `deepseek-flash` | ~1.1k / ~290 | ~2.0s | ~20% |
| `deepseek-v4-pro` | ~1.1k / ~730 | ~8.5s | ~90% |

（一次 16 条消息的会话，flash 约 100 秒、5.5 万 prompt token；v4-pro 约 6 分钟、4.7 万 prompt token。全部缓存可重放。）

**结论五：JSON 合法率接近 100%，但需要字段级校验。** 在提示词里写清字段名之后，首次 JSON 合法率 100%（65 次调用 0 次修复）；`many-tasks` 的 38 次调用里出现 2 次缺字段，一次修复即通过。**校验必须发生在调用工具之前**：一个缺 `ticket_id` 的 attach 会让 Eval 保持 in-progress，把整个会话卡住（见 §5）。

## 3.5 真实语料：Aime 六周、321 条用户消息

上面都是我自己编的对话。真实语料是 `~/Downloads/Aime_用户发起对话_2026-09-30至2026-11-14.txt`：**880 条正文、321 条用户消息、559 条回复、35 天、单一会话**——正是"无限对话流"本身。解析器与标注在 `src/sim/aime.ts`、`aime-labels.ts`、`aime-eval.ts`；原文不进仓库，标注只存轮次与意图。

两个窗口做了逐条人工标注（规则见 `aime-labels.ts`：`new` = 需要交付物与跟进，`continue` = 同一任务上补约束/追问/改稿，`chitchat` = 一句能直接答的话）：

| 窗口 | 消息 | oracle | flash strict | safe | 串台 | tickets |
|---|---|---|---|---|---|---|
| A 开场：GitHub 授权 → 完整推广方案 → 竞品对比 | 16 | 16 | **12 (75%)** | 12 | 0 | 2/3 |
| B 审片三版 + issue #9 + 突然转到"翡翠"英文 | 14 | 14 | **11 (79%)** | 11 | 0 | 3/4 |

- **keyword 在真实文本上直接失效**：A 1/16、B 3/14。真实续接靠指代（指代上一版视频、要求把结论写回 issue、确认完成），不靠重复词；合成语料里 63% 的词面成绩是虚高的。
- **thread 模式在真实语料上更差**：A 的 oracle 只有 5/16、B 只有 2/14（B 有 12/14 串台）。
- **长任务没有过度拆分**：窗口 A 里第 7–15 轮连续 9 次 attach 到同一份推广方案，说明真实上下文足够强时模型不会乱开票——之前合成语料里的"机票/酒店"拆分更像是粒度选择，不是能力缺陷。
- **resume 成立**：窗口 B 第 9 轮发来 v4 附件，attach 到已完成的审片票并唤醒它。

前 60 条用户消息的结构画像（未标注，只统计结构；worker 全部收下，避免合成 handback 干扰）：

| 归属 | accept | attach | ignore | 未看到 | tickets | 平均扇出 |
|---|---|---|---|---|---|---|
| routed | 15 | 26 | **19** | 0 | 15 | 0.43 |
| thread | 1 | 0 | 5 | **54** | 1 | 0.90 |

这张表说明三件事：

1. **真实个人助理的流量里约 1/3 是"内联问答"**（19/60 被 ignore），约 1/4 会变成持久任务（15 张票），其余是续接。router 只有 accept / attach / ignore / stop，**没有"直接回答"这个结果**——`ignore` 之后这条消息没有任何回复记录。要把它当个人助理用，必须补一个 `answer` 出口（`orchestrator_reply` 已经支持只带 `trigger_id` 的 answer，但没有和 ignore 串起来）。
2. **被 ignore 的不都是噪声，而是一整类任务**。窗口 A 第 2–5 轮是一件真实的、多步骤的活（打通私有仓库授权），模型全部 ignore，理由原文是"不涉及代码改动，无需建票""属于信息问答"。这是 schema 的偏置：`accept` 要 `worktree_name`、prompt 来自 coding agent，模型就把"票"理解成"改代码"。个人助理里，跑授权、约会议、订票、写文档都不是代码改动，却都是任务。
3. **thread 模式下 60 条里只有 6 条到达路由器**，54 条被订阅扇出直接吞掉，最终只建了 1 张票。

## 4. 每任务一线程：正解，但 router 被旁路

| 路由器 | 正确 | 未看到 |
|---|---|---|
| oracle | 16/16 (100%) | 11 |
| keyword | 16/16 (100%) | 11 |
| LLM（单次） | 12–14/16 | 10 |

正确率满分，但 router 只看到 5/16 —— 分组是订阅做的，路由判定只在"新任务第一条"和 handback 之后出现。**这个设计里 router 更像异常处理器，不是分组器。** 个人助理没有"每任务一线程"这种客户端能力，所以这条路径不能作为答案。

## 5. 批次是原子的：三条连发 = 一张票

三条互不相关的请求在同一个 pass 窗口内到达同一个 Thread。**模型完全照提示词做了：它一条 call 输出了三个 accept**（`msg-1/2/3` 各一条），结果仍然是 1 张票：

| 场景 | 路由器 | tickets | 吞并（swept） | 正确 |
|---|---|---|---|---|
| 同一批 | oracle | 1/3 | **2** | 1/3 |
| 同一批 | oracle + 逐条决定 | 1/3 | 2 | 1/3 |
| 同一批 | LLM（输出 3 条 accept） | 1/3 | **2** | 1/3 |
| 分三个 pass | oracle | **3/3** | 0 | 3/3 |
| 分三个 pass | LLM | **3/3** | 0 | 3/3 |

原因在 [evals.ts](<router/src/core/evals.ts#L306>)：`accept` 用 `evaluation.triggerIds`（整批）建票、写 `origin`、把整批标记为已决。第一条 accept 之后，其余 Trigger 的 accept 会因为 `accepted(thread)` 命中而幂等返回同一张票 —— **一条批次只能产出一张票**，逐条决定也拆不开；把 peer 忽略掉又等于丢需求。

这是比 Thread 更硬的约束：**批次的正确性必须在 Eval 之前保证**。个人助理里"用户连发三条"极其常见，2 秒的 pass 窗口足以把无关请求粘在一起。

## 6. 一次被拒的路由命令会卡住整个会话

模型很容易犯的错：把消息 attach 回一张已经被停掉的票（`ticketStopped`），或 attach 一条 worker 已 handback 的消息（`handedBackHere`）。`Engine.attach` 在 `withdraw` 之前就抛错，于是 **Eval 保持 in-progress**，同 Thread 的后续消息全部排队，直到 `evalTimeoutMs` 到期。

复现（`test/core.spec.ts`："a failed attach leaves the Eval open and locks the whole Thread"）：

```
pending: [next]   evaluating: [orphan]   ← 新消息连候选卡片都拿不到
```

早期实测里，一次这样的失败让 `many-tasks` 后 7 条消息全部 `unseen`；后来把字段校验提前到调用工具之前，`unseen` 降到 0。**建议**：路由命令被拒时，为那条 Trigger 记一条 `ignore{notAttachable}` 或单独重排队，让 Eval 结束。

## 7. 什么时候该新开，什么时候该 resume

| 动作 | 机制要求 | 模型实际用得对不对 |
|---|---|---|
| `accept` 新任务 | 可准入；inferred 还需命中启用规则 | 对：新对象、新交付物、同名不同团队都新开 |
| `attach` 续接 | 必须显式指向那张票（引用/回复/同一对象的后续修改）；票 open 或 Mandate 仍有效；未被 handback；非人停 | 大体对；模糊续接（"再加一列"）容易开新票 |
| 自动 resume | thread 模式：人的消息到达订阅票且票已结束 → 立即唤醒，无 Decision | **个人助理里应该禁掉**："谢谢"会复活任务 |
| `ignore` | 无需任务；inferred 可以"看图忽略" | 分歧最大：纯问题（"模板还在吗""查天气"）被 ignore，是否建票是产品决策 |
| `stop` | 必须 explicit；只有它能在 worker 拥有消息时穿透 | 对：明确叫停时一次命中，且能穿透 worker 的所有权 |

缺的能力：

1. **任务身份**。票卡只有 `title` + 最近报告预览（160 字），`related_tickets` 只给 **8 张**、open 优先、新的在前（[cards.ts](<dsh-superagent-prototype/src/app/cards.ts#L93>)）。第 9 个任务起，resume 只能靠 `orchestrator_read` 翻列表，而 dispatch 提示词并不要求模型这么做 —— 实测表现为重复建票。
2. **相似 ≠ 同一**没有可计算边界。目前靠模型自觉；A/B/C 场景证明模型能做到，但机制不保证。
3. **任务级并发**。一个 Thread 同时只能有一个 Eval；卡住就全卡住。
4. **resume 不可拒绝**。thread 模式下唤醒是扇出的副作用。
5. **批次没有意图边界**。见 §5。

## 8. 如果要做 personal agent，建议的最小改动

按性价比排序（每一条都有消融数据支撑，见 [ablation.md](ablation.md)）：

1. **归属与订阅解耦**（已实现，`ownership: 'routed'`）：13% → 100%（oracle）/ 0 串台（真实模型）。
2. **批次按意图切分，或让 accept 只吃自己**（二选一）：
   - 在 `Evals.start` 之前把 pending 按"回复关系 + 任务相似度"分组，每组一个 Eval（app 层，不动核心）；
   - 或给 `accept` 加 `triggerIds`：只接受列出的 Trigger，其余重新排队（`Evals.accept` + `finish`，约 15 行）。
   实测：三条连发 → 1 张票（模型已逐条决定）；分开到达 → 3/3。
3. **票卡带任务指纹**：`Ticket.keywords: string[]`（accept 时模型给 2–5 个词），召回从"最近 8 张"改成"关键词命中 ∪ 最近 8 张"，并提示还有多少张未展示。直接针对 §3 结论三的重复建票。
4. **路由命令被拒时释放 Eval**（§6），否则一次误判赔上整个会话。
5. **让 resume 成为决策**；若保留 thread 模式，给 `wake` 加范围不匹配则不唤醒的 gate。
6. **把"要不要建票"写成显式策略**（问题类、查询类是否建票），否则同一句"查一下天气"在不同运行里时建时不建。

实测的四条杠杆（真实窗口 A+B，两次采样）：

| 杠杆 | 效果 |
|---|---|
| 保留对话历史（8 条） | 去掉会让严格正确 24/30 → 15/30 |
| `answer` 出口 + 去 coding 化（v2） | 45/60 → **48/60**，安全送达 47 → **52**，14 条内联回答 |
| 规则级联 | 调用 −10%、耗时 −12%，准确率不变 |
| 任务指纹卡 | `many-tasks` 重复建票 11 → 9，token −5% |

## 9. 复现与成本

```bash
cd ~/workspace/router
node --experimental-transform-types --no-warnings --test test/*.spec.ts        # 30 个测试
node --experimental-transform-types --no-warnings src/sim/run.ts               # 规则策略全表
node --experimental-transform-types --no-warnings src/sim/run.ts --router llm --model deepseek-flash
node --experimental-transform-types --no-warnings src/sim/sweep.ts \
  --model deepseek-flash --repeat 3 --ownership routed \
  --scenarios personal-chat,many-tasks,twin-subjects,long-stream
node --experimental-transform-types --no-warnings src/sim/sweep.ts \
  --model deepseek-v4-pro --repeat 2 --scenarios personal-chat,many-tasks

# 真实语料（需要导出文件；原文不进仓库）
node --experimental-transform-types --no-warnings src/sim/aime-eval.ts --mode windows --router llm
node --experimental-transform-types --no-warnings src/sim/aime-eval.ts --mode stream --from 1 --to 60 --router llm
node --experimental-transform-types --no-warnings src/sim/aime-scan.ts --from 1 --to 40   # 看清单
```

LLM 结果按请求体哈希缓存在 `src/sim/.cache/`（sweep 用独立目录，保证每次是真采样）；删除即可重新采样。密钥读 `DEEPSEEK_API_KEY` 或本目录 `.env`，不会写入日志。

## 10. 这套评测的边界

- `oracle` 知道 ground truth，代表"机制允许的最优"；`keyword` 只看词面，是下界。真实模型有采样波动（flash 在 `personal-chat` 上 10–12），所以用区间/多次统计。
- **"什么算一个任务"是产品决策，不是客观真值**。fixture 认为"大阪行程"是一件，模型倾向拆成机票/酒店/天气；按我的标注算 67%，按 `safe` 算 100%。任何这类评测都必须先固定粒度，否则数字会误导。
- worker 是固定规则（投递 → 跨任务 handback → 到点 ready），没有真实执行；真实系统里 worker 的 handback 判断会改变串台的纠错率。
- 没有模拟超时（`evalTimeoutMs` 设为 10 分钟）、没有多用户并发、没有 `follow_up` 之外的通知。
- 8 张上限是代码事实；"任务数增长 → 重复率增长"的曲线只测了 10 个任务的单点。
- 真实语料只有 **两个窗口、30 条用户消息**做了逐条标注；其余 291 条只用于结构统计。标注本身有主观性（"跑授权算不算任务""翡翠英文算不算任务"），报告里把有争议的条目单列了理由。导出文件含真实聊天内容，**不入库**，只按路径读取。
