# VDocs-Bench 评测宿主

在本机批量跑 VDocs-Bench：每题用一份新文档、新语音会话，把指令以文字发给服务端，等任务结束后读回最终文档并判分，一次运行写一行 JSONL。

不修改 `packages/`、`apps/` 或 vdoc 仓库的任何文件。所有代码在 `bench/` 下，运行时生成的东西在 `bench/.cache/`、`bench/results/`（均被 git 忽略）。

## 为什么叫"宿主"

服务端只负责模型和治理，真正改文档的是 vdoc 前端声明的客户端工具（`read_document`、`apply_document_operations` 等）。评测时没有浏览器，所以需要一个"宿主"来扮演 vdoc 前端：

- `build-host.ts` 把 vdoc 仓库按固定提交导出到 `.cache/`，装好它锁定的依赖，再把 `src/host/worker.ts` 和 vdoc 自己的编辑引擎（`DocumentEngine`）、工具层（`realtimeDocumentTools`）打包在一起。
- 宿主在 worker 线程里用 jsdom 无头运行，和 vdoc 自己的测试环境相同。用线程隔离是因为 jsdom 的浏览器全局变量会让服务端的 Anthropic SDK 拒绝运行。
- 工具语义、参数校验、revision 检查、撤销都是 vdoc 的原代码，不是重写的模拟。

## 用法

```bash
npx tsx bench/src/build-host.ts          # 首次或 vdoc 更新后；默认 ~/Desktop/Vdoc 的 origin/main
npx tsx bench/src/selfcheck.ts           # 验收适配器和判分器，不调用模型
npx tsx bench/src/smoke.ts               # 假模型跑通全链路，不花钱
npx tsx bench/src/run.ts --configs S3 --tasks pilot --repeats 1
```

## 只测 GitHub 上的代码

实验在本地运行，但被测代码必须和 GitHub 上的一致。`run.ts` 开跑前会先拉取 GitHub，再核对两件事：

- 本仓库当前提交等于 GitHub 的 main，且服务端代码（`packages/`、`apps/node`、`apps/worker`、依赖和 tsconfig 文件）没有任何本地改动或多出来的文件；
- vdoc 宿主是用 GitHub 上 vdoc main 的最新提交构建的。

任何一项不符就直接停止，不发出任何请求，并说明原因：没切到 main 就先 `git switch main` 再 `git pull`；vdoc 有新提交就重新运行 `build-host.ts`。文档、`bench/` 自身等不参与运行的文件不影响核对。确实要测本地改动时加 `--allow-local`，每条结果都会记下 `versions.code_matches_github: "no"`。

## 论文实验（已定方案）

| 预设 | 配置 | 题目 | 重复 | 次数 | 用于 |
| --- | --- | --- | --- | --- | --- |
| `quick` | S3、R1、S3-noprefetch | 60 道编辑题 | 1 | 180 | 第一阶段探路 |
| `paper` | S3、S2、R1、S3-noprefetch | 同上 | 2 | 480 | 第二阶段主实验 |
| `paper2` | `paper` 再加 S3-think-low、S3-think-high、S3-sonnet | 同上 | 2 | 840 | 第三阶段：修复后的主实验与思考、模型消融 |

```bash
caffeinate -i npx tsx bench/src/run.ts --preset paper2
npx tsx bench/src/summarize.ts bench/results/paper-v2.jsonl
```

- **题目**：`bench/tasks/paper-60.json`，由 `make-subset.ts` 生成。6 类编辑题各 10 道（单步、多步各 5 道），种子 261026。写作题不在其中，所以不需要 LLM 评分。
- **`paper` 需要 `OPENAI_API_KEY`**：S2 用 OpenAI 做语音识别和合成。缺密钥时会在发出任何请求之前就停止。
- 预设里的任何一项都可以用命令行参数覆盖，比如 `--preset paper --repeats 1`。

## S2 的对齐

设计文档要求 S2 和 S3 对齐三样东西：模型、编辑规则、思考设置。评测里的 S2（`src/s2-aligned.ts`）不改服务端代码，只替换级联里 Claude 客户端发出的请求：

| | S3（Pi Worker） | 服务端原样的 S2 | 评测用的 S2 |
| --- | --- | --- | --- |
| 模型 | Haiku 5.5 | 默认 Opus（需写成 `cascade-claude:claude-haiku-5-5`） | Haiku 5.5 |
| 编辑规则 | vdoc 基础规则 + Worker 规则 | 只有 vdoc 基础规则 | vdoc 基础规则 + Worker 规则（去掉 5 条只适用于 Actor-Worker 交接的） |
| 思考 | `disabled`，不传 effort | 自适应，effort low | `disabled`，不传 effort |
| 提示缓存 | 开 | 关 | 开 |

Worker 规则在运行时从 `delegated-model.ts` 读取，不会和源码不同步；结果里记录了它的哈希（`versions.s2_rules_sha`）。每次模型请求实际用的思考、effort、缓存设置和提示长度记在 `model_requests[].params`，跑完可以用来核对对齐是否真的成立。服务端原样的级联保留为 `S2-unaligned`，需要时可以对照。

`run.ts` 参数：

| 参数 | 含义 |
| --- | --- |
| `--configs` | 逗号分隔，见 `src/configs.ts`；多个配置在每个"题×重复"块内按 seed=261026 打乱顺序交替运行 |
| `--tasks` | `all`、`pilot`（交接包第 6 节的 10 题）、类别（`FMT`、`MD`…）或逗号分隔的题号 |
| `--repeats` | 每题重复次数，正式实验为 5 |
| `--out` | 结果文件，默认 `bench/results/<时间>.jsonl`；追加写入 |
| `--bench` | 任务集目录，默认 `bench/data/VDocs-Bench-v1.0` |
| `--resume` | 保留 `--out` 里已完成的运行，只补缺失的；被服务商拒绝（密钥无效、余额不足）的运行会先移出结果文件（保留备份）再重跑 |
| `--budget` | 本次估算的 Claude 花费达到这么多美元就停（如 `--budget 5`）。Boson 和 OpenAI 的用量这里看不到，请同时在各自控制台设上限 |

模型密钥从仓库根目录 `.env` 读取。模型接口返回 401/403（密钥无效）时会立即停止，不会继续消耗实时模型那边的费用。

## 汇总

```bash
npx tsx bench/src/summarize.ts bench/results/a.jsonl [b.jsonl …] [--baseline S3]
```

在第一个文件旁边生成 `.summary.md`（论文用的表）、`.summary.json`（全部数字）和 `.runs.csv`（一次运行一行，用来画图）。内容包括：

- 成功率（只算确定性题）、部分完成率、误改率、超时率；95% 置信区间按"题"重抽样（同一题的重复运行不独立）。
- 延迟中位数和 P95：分别给出全部可观测运行和成功子集，并标出样本数 n。没发生的事件不计入，不当成 0。
- 按类别、按单步/多步拆分。
- 每个配置对基准配置（默认 S3）的配对比较：成功率差、完成时间差及其置信区间，以及更好/更差的题数。
- 模型请求数、token、按价格表估算的 Claude 花费（`src/pricing.ts`）。
- 失败原因：每次失败归一个主要原因（超时、模型 HTTP 错误、WORKER_FAILED 等错误码、治理拦截、工具错误、没有写入、误改、做错或没做完）。这是启发式分类，原始事件都保留在结果文件里。
- 重复运行的一致性：同一题结果不一致的比例、完成时间的变异系数。用来决定正式实验要重复几次。

## 配置现状

| 配置 | 状态 |
| --- | --- |
| S3、S3-noprefetch、S3-think-low/medium/high、S3-sonnet | 只改环境变量，可直接跑 |
| R1（`boson`） | 可直接跑 |
| R2（`openai`） | 需要 `OPENAI_API_KEY` |
| S2（对齐版）、S2-unaligned | 需要 `OPENAI_API_KEY` |
| S3-nobatch | 缺"批量修改"规则的开关（`delegated-model.ts`） |
| S3-olddelegation | 需要在 `74228068` 的检出上运行 |

缺开关的配置会被拒绝运行，不会悄悄跑成别的东西。

## 每次运行记录什么

见 `src/runner.ts` 的 `RunRecord`。主要字段：

- `latency`（毫秒，从发出文字算起；没发生的事件记 `null`，不填 0）：首次工具调用、首次读取、首次和最后一次成功写入、Worker 首次模型请求、首段回复文字、轮次结束。
- `counts`：工具调用数、写入成功和失败数、模型请求数、token 数。模型请求是在进程里包装 `fetch` 记录的，没有改服务端代码。
- `tool_calls`、`model_requests`、`server_events`、`server_warnings`、`client_errors`：用于失败原因分类。
- `late_writes`：轮次结束后再观察 2 秒内出现的写入次数（交接包 §3.3）。
- `score`：判分结果，见下。

## 判分

`src/checker.ts` 实现交接包 §3.1–3.2：

- `task_success`：最终文档与答案逐属性一致，且没有误改。
- `steps`：逐步判定。替换按局部上下文判断，同一段里的两处替换分别判。
- `collateral_edit` / `collateral`：只把"答案保持不变的属性被改了"算误改，漏改不算。
- `content_equal`：不看块身份的宽松比较。模型若删掉再重建一个块，严格判定按规范算不同的块，这个字段可以单独统计这种情况。
- 写作题：自动检查保护范围、字数、能机器判定的结构、标题样式和固定尾句。事实与质量要等 LLM 评分器，所以 `task_success` 为 `null`（若已有硬性失败或误改则为 `false`）。

`selfcheck.ts` 的验收结果：225 份初始/答案文档经 vdoc 往返全部不变；105 道确定性题的正确答案（新块换成 vdoc 生成的 ID 后）全部判成功；原封不动的文档全部判漏改且无误改；在保护块上加一处下划线的探针 103 题全部判为误改（另 2 题所有块都在授权范围内，没有可探测的保护块）。

## 适配器做的决定（需要告诉出题人）

1. **字号单位**：题面写"磅"，vdoc 只有整数 px（默认 16px，相当于 12pt）。14、16、20、22 磅换成 px 都不是整数，vdoc 的接口表达不了，所以按数字 1:1 对应（`font_size_pt: 24` ↔ `fontSize: "24px"`）。建议任务集下一版把题面改成"字号"或明确单位。
2. **标题加粗**：vdoc 的标题默认显示为粗体，但没有 bold 标记。按规范 §2 第 5 条，只认显式 bold 标记为加粗。
3. **空段占位**：vdoc 在文末列表或表格后会自动补一个空段，空文档也有一个占位空段。判分前删除"初始文档里没有的空段"，删除数量记在 `removed_placeholders`，需要严格统计时可以用它。

## 还没做的

- 语音输入（需要录音和推送）、实验四的打断场景、写作题的 LLM 评分器。
- 只支持一次跑一个任务：模型请求按时间归属到运行，并发会混淆。并发也会影响延迟测量。
