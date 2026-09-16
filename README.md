# Tianshu Replica · 原片材料提取与剧本重写

## 三条纯文本链与托管

天书复刻从创意、人物小传、分集大纲三份源材料开始，文本生产不依赖 VLM。
`extract-source` / `extract-video` 是独立前置步骤；已有合格材料时直接 `init --source-materials`。
选择 GPT 不会自动调用 Gemini 或重新读取原片。
事件摘要的软字数不限制关键对白和场景证据：世界规则、动机、关系等原句保留说话者、
对象及来源，人物小传分开记录稳定身份和按场景生效的服装、伤势、持物、物种与形态。
规划、写作、分镜和独审沿用这些证据；允许自然转述，不能靠删关键信息压时长。

| `init --model` | 规划、写作、分镜、审稿 |
| --- | --- |
| `kimi` | kimi-coding / k3-256k |
| `deepseek` 或 `ds` | deepseek / deepseek-flash |
| `gpt` | openai-codex / gpt-6-astra |

```bash
node bin/tianshu.mjs --root /absolute/data init /absolute/brief.txt \
  --source-materials /absolute/materials.json --model gpt \
  --agent-dir /absolute/existing-pi-account
node bin/tianshu-worker.mjs --root /absolute/data enqueue RUN_ID
node bin/tianshu-worker.mjs --root /absolute/data drain --max-jobs 10
```

新 run 在 `canonical/execution-contract.json` 冻结模型和配置目录引用，不保存密钥。
换 shell 环境不会换掉任务模型；同一个队列可以处理三种模型的不同剧。
没有执行合同的旧 run 显示 `legacy-unbound`；需生成新内容时先通过
`bind-model RUN_ID --model ... --agent-dir ...` 明确绑定后续执行，历史实际用模保持未知。
已经冻结的 run 不允许原地换链路。

草稿自动规划后停在大纲批准处；制作人批准后继续 drain，即可推进剧本、修订、分镜和交付。
每轮最多处理指定数量的候选剧，每剧最多一次，缺配置或失败只暂停该剧。
失败后的重试需先处理原因，再显式 `worker retry RUN_ID`，不无限消费额度。
本地生成和最终制作人审阅仍是两个状态，队列不会替人批准大纲或宣布飞书已完成。

各阶段按具体剧情保留说话对象、关系变化、犹豫与回应。言情、亲情和悬疑等题材
不套用统一快剪模板。保留现有60–90秒目标、通常75秒、100秒硬上限和自然增集规则；
不通过删除必要互动或加速对白压缩时长，旧合同的时长继续按旧合同读取。
新增规则沿用现有局部审稿和限定修订，不增加整集内容拒绝门。
最终交付先验证并应用已审定修正，再过滤已知内部生产说明并重算时长；
台词、画面、动作、道具与拍摄指示保留，Markdown 与 DOCX 使用同一份投影。

依赖固定 Pi SDK 0.85.1。配置目录需已有对应模型注册与凭据；离线元数据检查
只证明模型存在，不能证明登录可用或生成质量。使用已配置 python-docx 的 Python：

```bash
TIANSHU_PYTHON=/absolute/python-with-docx npm test
```

### GPT 并发与缓存

GPT 与 DeepSeek 分镜默认由 8 路动态领取待做集，完成一集立即补位；每个独立会话最多复用 5 集后轮换。已通过且源稿与合同仍匹配的分镜在创建会话前跳过。窗口审稿保持 8 路独立会话，全剧终审等待全部窗口完成。Writer 与连续性审查依照剧情依赖逐集执行。

`worker drain` 默认并行推进最多 8 部独立剧目，可用 `--concurrency 1–8` 调整；`--max-jobs` 继续限定本轮最多领取的剧目数。每部剧最多尝试一次，审批、暂停、失败和冻结模型按各剧分别处理。

同一数据目录下，所有 GPT 进程共用 `.provider-slots/gpt-requests` 的 8 个 FIFO 请求槽。槽覆盖一个逻辑 stream 及其顺序重试，排队时间不计入任务 watchdog；该上限与并发指标以逻辑 stream 计数。多剧需使用同一个 `--root`，不同数据目录的请求池互相独立。

同剧同类角色使用稳定的 `prompt_cache_key`，各会话仍保持独立。审稿的公共材料放在窗口正文前，尾窗使用相同工具定义。缓存键仅是服务端路由提示，当前正文始终完整发送，真实命中以返回的 `cacheRead` 为准。完成的分镜及窗口审稿继续沿用既有恢复检查点。

定向离线验证（需要 Node 与支持 `fcntl` 的 Python）：

```bash
node --test --test-concurrency=1 test/concurrency.test.mjs test/request-slots.test.mjs test/model-request-concurrency.test.mjs test/storyboard-concurrency.test.mjs test/review-window-concurrency.test.mjs test/prompt-cache.test.mjs test/queue-drain.test.mjs
```


Tianshu Replica 是供短剧创作者在本机使用的 CLI：先根据原片提取创意、人物小传、分集大纲，再由天书依据这三份材料重写剧本；人物名字和细节允许略微迁移，身份关系、剧情骨架和已知事实保持对应。基于 [byfusion/TianshuAgent](https://github.com/byfusion/TianshuAgent)，本机负责流程和文件，文本创作由任务执行合同选定的远端 Kimi、DeepSeek 或 GPT 完成；前置素材提取独立选择入口和模型。

本仓库维护复刻输入、源大纲对照审稿、用量统计和可重复的离线验证，保留上游的原创入口及创作角色分工。默认按需在本机运行，不自动部署 Mac mini 或安装常驻后台服务。真实素材、账号配置和生产产物由使用者在本地管理；复刻功能只附带合成样例，既有上游测试样例保留。上游来源保留在 Git 历史中，未为上游代码新增开源许可证。

DeepSeek 抽帧材料到规划、剧本、分镜和文档交付的链路已完成真实任务运行与产物核对。该证据来自图片与可见字幕，不等同于原生视频或音频理解；Kimi 原生视频入口仍需单独完成真实素材验收。链路跑通和离线测试均不能代替内容审稿，也不能证明创作质量或 token 节省。

原创项目默认使用女频竖屏短剧合同：30 集、每集 90–100 秒、12–24 镜。新的整剧复刻以每集 60–90 秒为目标，通常按 75 秒规划，8–32 镜，单集硬上限为 100 秒。Planner 根据剧情转折确定输出集数；源剧 32 集可以规划为 54 集等实际合适的长度。EP1–3 保留冷开和可剪宣发桥段。

合同保存在 `canonical/production-contract.json`。新建整剧复刻合同用 `pacing.targetDurationSeconds` 记录目标范围，用 `pacing.preferredDurationSeconds` 记录通常采用的 75 秒；剧本与分镜的 `episodeDurationSeconds` 保持一致的 60–100 秒硬范围。规划中的 `targetSeconds` 不得超过 90 秒。成稿超过 90 秒、但在 100 秒内自然收尾时可以保留，由 Reviewer 给出节奏提醒；超过 100 秒时优先增加集数，保留必要的对白、动作和情绪落点。

## 默认工作流

```text
原片分集视频 → 提取创意、人物小传、分集大纲
→ 三份源材料 + brief
→ Planner 写规划
→ 独立规划 Reviewer 审稿
→ Planner 按 Repair Plan 修订，最多 3 轮
→ 用户批准最终大纲
→ Writer 写剧本
→ 窗口 Reviewer + 全剧 Reviewer
→ Writer 修订并复审，最多 3 轮
→ Storyboard Agent 拆分镜
→ 窗口 Reviewer + 全剧 Reviewer
→ Storyboard Agent 修订并复审，最多 3 轮
→ delivery gate
→ Markdown + DOCX
```

“通过”要求当前合同下的硬检查全部成功、独立终审没有 P0/P1，所有 P2 都已修复或标记为 `accepted_non_blocking`。遇到 P0、需要改已批准大纲的上游问题、同类问题影响至少 3 集、相同 finding 修后仍存在或修订轮次用尽时，任务进入 `needs_human_review`。Reviewer 没有正式提交或暂时不可用时，流程停在当前 reviewing 状态并保留恢复点，不会假装通过。

## 阅读代码

从 CLI 入口沿生产顺序阅读即可，不需要先理解全部模块：

| 要了解的行为 | 入口与职责 |
| --- | --- |
| 命令如何进入生产流程 | `bin/tianshu.mjs` 解析参数、选择数据目录并调用相应操作；`src/runtime.mjs` 推进完整生产流程。 |
| 多部剧如何并行 | `src/queue.mjs` 管理各剧任务；`src/request-slots.mjs` 与 `scripts/provider_slots.py` 管理共享 GPT 请求槽。 |
| 如何规划、写作和制作分镜 | `src/agents.mjs` 编排各阶段；提示词单独放在 `src/agent-prompts.mjs`，提交工具负责校验和保存正式稿。 |
| 如何独立审稿与恢复 | `src/semantic-review.mjs` 组织窗口审稿、检查点复用与全剧终审；`src/review-prompts.mjs` 集中审稿提示词。 |
| 如何验证并交付 | `src/core.mjs` 检查分镜、组装交付文本；`src/delivery.mjs` 执行交付门禁与文件导出。 |

关键编排测试直接导入正式模块，通过可选参数替换模型调用，使用合成材料和临时目录验证状态与产物。阅读测试时，先看场景、调用和断言，再看 fixture 的材料准备。

## 使用

使用 Node ≥22.19，克隆仓库后安装依赖并运行离线测试：

```bash
git clone https://github.com/HaokaiDing/tianshu-replica.git
cd tianshu-replica
npm ci --ignore-scripts --no-audit --no-fund
npm run test:replication
```

若仓库位于 iCloud 等云同步目录，依赖文件可能在读取时等待同步。可按同一份 `package.json` 和 `package-lock.json`，在非同步的项目专用目录（例如 `$HOME/.local/share/tianshu-replica/dependencies`）安装依赖，再让仓库的 `node_modules` 链接到该目录。更新依赖时仍以主仓库锁文件为准；依赖目录不存放素材或凭据，也不使用某部剧的 runtime 作为长期依赖来源。

生产统一使用这份仓库的代码，单剧只隔离数据。CLI 和 worker 的数据目录优先级为 `--root` → `TIANSHU_ROOT` → 当前 CLI 所属仓库；所选目录下保存 `runs/<run-id>/` 和 `.queue/`。模型适配、Runtime 与 DOCX 导出器始终从本仓库加载，更新本仓库后，各剧继续使用同一份实现，无需向单剧目录复制 `src/`、`bin/` 或依赖。

例如，从本仓库调用 CLI，将生产数据保存在独立目录；以下初始化只读已有源材料，不调用模型：

```bash
npm run tianshu -- --root /path/to/production init inputs/brief.txt \
  --title "剧名" --source-episodes 32 \
  --source-materials inputs/source-materials.json \
  --contract inputs/production-contract.json
```

将示例集数替换为源材料的实际集数。brief、素材清单、合同等命令行输入文件的相对路径仍从调用时的工作目录解析，清单内的视频路径仍相对清单文件解析；`--root` 只选择生产数据目录。后续命令继续传相同的 `--root`，或为当前 shell 显式设置：

```bash
export TIANSHU_ROOT=/path/to/production
npm run tianshu -- status <run-id>
```

以下示例均沿用所选的数据目录；省略 `--root` 和 `TIANSHU_ROOT` 时保留原有仓库内运行方式。新 run 通过 `--model` 与 `--agent-dir` 或初始化时的环境变量选择模型和配置目录，后续执行按冻结合同读取；数据目录不会替换凭据配置。

用仓库内已有大纲的合成样例创建一个离线草稿，不调用模型。这个兼容入口只演示初始化；完整三份材料流程见下方“三份源材料与重写”：

```bash
npm run tianshu -- init fixtures/replication-synthetic/brief.txt \
  --title "复刻样例" --episodes 60 \
  --source-outline fixtures/replication-synthetic/source-outline.md \
  --contract fixtures/replication-synthetic/production-contract.json
```

实际生产时换成自己的 brief、大纲与合同，完成下方账号配置后再执行：

```bash
# Planner 与独立 Reviewer 对照源大纲进行规划
npm run tianshu -- plan <run-id>

# 用户批准最终大纲后，进入细节扩写与交付
npm run tianshu -- approve <run-id>
npm run tianshu -- run <run-id>

# 中断后恢复，或只读查看状态与用量
npm run tianshu -- resume <run-id>
npm run tianshu -- status <run-id>
npm run tianshu -- metrics <run-id>
```

普通原创流程沿用 `init brief.md --title "剧名"`，省略 `--source-outline` 即可。

自定义合同：

```bash
npm run tianshu -- init briefs/show.md \
  --title "剧名" \
  --contract contracts/custom-production-contract.json
```

`run` 会取得 run 级 `.lock`，同一个项目不能被两个 Orchestrator 同时生产。新合同默认在全部质量门通过后自动生成 Markdown 和 DOCX；自定义合同可以把 `delivery.autoDeliver` 设为 `false`，让流程停在 `awaiting_delivery_approval`。

分集标题统一为“第 N 集｜集名”：Writer 根据本集已批准的内容确定集名，Storyboard 沿用对应剧本的集名。最终 Markdown 每集使用一个一级标题，DOCX 使用真正的 Heading 1，使文档目录能够按集跳转。导出时统一清除标题中的“分镜表”“分镜剧本”等类型后缀；分镜缺少有效集名时，复用本集已通过审稿的剧本集名。

七列表格及中英台词、表演、走位、连续性、制作说明保持原有规范，镜头数与时长仍由生产合同控制。DOCX 将单元格内的 `<br>` 导出为段内换行，保留内容与换行位置，减少飞书导入时产生的段落块；导入后的完整性仍需实际回读核验。

导出格式更新后，可对 `delivered` 状态的项目显式执行 `npm run tianshu -- deliver <run-id>`。命令会重新执行完整交付检查，使用当前导出格式更新原 `deliverables/` 中的 Markdown、DOCX，并刷新 `delivery.json`，状态仍为 `delivered`；不会重新调用模型或改写已审核的剧本、分镜。线上文档和生产表仍需另行同步并回读。

外层交付应读取 `delivery.json` 中的正式文件路径；QA 目录中的校验副本不替代正式交付文件。导入飞书后，生产表使用 `[文档标题](在线文档URL)` 回填带标题的超链接，并回读确认标题、地址和链接类型，保持与已有交付一致。

Runtime 在每集任务开始时重置草稿与提交状态，只有本轮 `write_draft` 产生的稿件能够进入检查和提交，旧正式稿不能充当本轮成功结果。标题、镜头集号和已识别的格式换行在工作稿写入时归一；无依据的集名只保留集号。`read_artifact` 返回分页位置和截断标记，后续正文通过 `offset` 继续读取。

Storyboard 每集显式获得已批准人物、静态连续性合同及当集原片材料，不能把末集动态快照当成本集前态。现有 Reviewer 会话附上带原文引用的一致性候选，并记录“确认问题 / 排除 / 待核源”的逐项处置；候选本身不判定内容错误，也不触发整集重生成。终审保留 P1 或待修 P2 前必须实际读取对应集正文。结构检查通过与语义审稿覆盖分别记录，不能互相替代。

对已独立审定的交付修正，可执行 `npm run tianshu -- accept-corrections <run-id> <修正记录.json>`，再执行 `deliver <run-id>`。修正记录包含按最终镜号与列号定位的 `changes`（`shot`、`column`、`old`、`new`）；Runtime 严格匹配原文，保存受影响集的源稿文本，每次导出从原稿重放同一份修正。原生成稿及其模型审稿不被冒充为修订后审批，`delivery.json` 单独记录编辑修正来源和待核源项。源稿变化或补丁冲突只暂停导出，供人工重新核定；不会自动重跑创作模型。顺序调整若已体现在最终位置的单元格差异中，不能再执行一遍重排。

## 三份源材料与重写

提取阶段分别记录创意、人物小传和分集大纲，并保留来源与未知项；重写阶段允许一致地略微调整人物名字和细节。人物身份、关系和剧情骨架须有对应依据，避免只凭简短大纲另造人物身份。

三份材料以 JSON 包传递，字段为 `creative`、`characters`、`outline`、`provenance`。初始化时分别原样存入 `canonical/source-creative.md`、`source-characters.md`、`source-outline.md`；Planner 与独立规划 Reviewer 同时读取三份材料。缺一项会在创建项目之前报错。

### 原片输入

`extract-video` 接收明确集序的 MP4 清单；路径相对清单文件解析，不猜测整部合辑的分集边界：

```json
{"episodes":[{"episode":1,"path":"ep-01.mp4"},{"episode":2,"path":"ep-02.mp4"},{"episode":3,"path":"ep-03.mp4"}]}
```

```bash
npm run tianshu -- extract-video inputs/episodes.json --preview
npm run tianshu -- extract-video inputs/episodes.json --output inputs/source-materials.json
```

整剧复刻用 `sourceEpisodes` 记录实际源集数，源大纲仍须完整覆盖 1..N；`--source-episodes N` 用于校对这个源总数。`--episodes` 可省略，或作为初始规划参考数；Planner 提交的输出大纲和 `canonical/episode-map.json` 共同确定最终集数，批准后冻结。每个输出集记录源集引用、起止事件和 60–90 秒的规划目标，通常为 75 秒；同一长源集可在自然冲突或悬念处拆成多个输出集。普通原创仍使用 30/60 集，`--sample` 仍固定原剧前 3 集。

可按任务切换到 DeepSeek V4.1 Flash，凭据目录中的 `auth.json` 使用 `deepseek` provider，`models.json` 注册官方 `deepseek-flash`：

```bash
export PI_CODING_AGENT_DIR="/absolute/path/to/deepseek-agent"
export TIANSHU_MODEL_PROVIDER=deepseek
export TIANSHU_MODEL_ID=deepseek-flash
npm run tianshu -- plan <run-id>
```

用户明确批准定向返修后，可先通过 `return` 记录返修，再用 `plan <run-id> --note <repair-note.txt>` 把具体意见同时交给 Planner 和独立 Reviewer。该入口保留当前规划作为修订依据，不提高自动审稿轮次预算。

同样的环境下，`extract-video` 用 `ffmpeg` 每秒抽取 2 帧，向 DeepSeek 发送带时间戳的图片和可见字幕；保留逐帧 JPEG 与采样记录，不读取音轨。超过 600 张输入图片或 48 MiB 请求体时停止并报告，不能静默降低采样率。清单项可显式指定 `framesPerImage: 2`，把连续两帧左右并排成一张图片，源采样仍为 2 fps；每个 panel 的时间和末尾空 panel 都会单独标注。`sourceNote` 可记录候选核心区、相邻集上下文和未确认集界，原样进入提取输入与来源记录。历史成功提取可以通过 `--resume` 复用，原始失败响应必须保留；该路径不计为原生视频理解。官方契约见 [DeepSeek 模型](https://api-docs.deepseek.com/quick_start/pricing/)和[图片输入](https://api-docs.deepseek.com/guides/vision/)。

DeepSeek 已返回完整 2xx 响应、但遗漏必需字段或提交结构不合格时，可显式补交这一集：

```bash
npm run tianshu -- --root /path/to/production extract-video inputs/episodes.json \
  --output inputs/source-materials.json --resume --repair-episode 21
```

补交复用该集已保存的图片及此前成功材料，原响应保持不变，单次补交证据另存于 `ep-021-repair/`；成功后继续后续集数。普通 `--resume` 会复用已成功的补交。没有完整响应、结果未知或补交再次失败时停止，不自动重复付费请求。

按一集一次、串行使用 Kimi Code `k3` 的原生视频接口，提完释放该集请求；Pi 的 `k3-256k` 继续负责后续文本创作。[Kimi 官方视频输入说明](https://www.kimi.com/code/docs/third-party-tools/hermes.html#第三步-启用视频分析)。当前 Pi SDK 输入仅支持文本和图片，视频不伪装为图片。每个文件上限 32 MiB 是本工具的本地内存预算，不是供应商的文件限制；视频过大时先明确裁切或压缩方案，不自动降低画质。没有本地模型和默认转码。尚未取得并通过真实原片验证时，只能报告接口与离线检查完成。

### 已有文本证据输入

已有原片分析、字幕整理或剧本 DOCX 时，可从文本提取同样三份材料；这条路径会明确记为文本证据，`directVideoUnderstanding=false`，不能声称重新看过原片：

```bash
npm run tianshu -- extract-source inputs/source.docx --episodes 3 --preview
npm run tianshu -- extract-source inputs/source.docx --episodes 3 --output inputs/source-materials.json
```

每批最多三集，保留原名、关系疑点、倒叙和集界。多批次只汇总创意与人物材料，已提取的逐集大纲保持顺序。提取使用简短材料，不套用旧版 30 KB 人物稿门槛。已有输出或提取记录时拒绝覆盖，失败用量仍计入。

### 交给天书重写

```bash
npm run tianshu -- init inputs/brief.txt --title "三集验证" \
  --sample --source-episodes 50 \
  --source-materials inputs/source-materials.json \
  --contract inputs/production-contract.json
npm run tianshu -- plan <run-id>
```

大纲批准后可通过本地队列继续创作。默认 `run` 沿用现有剧本与分镜交付流程；只需先查看完整剧本时，可用 `produce` 与 `review` 分阶段执行，不必为验收三份源材料重跑已完成的分镜。

## 已有大纲入口

`extract-outline` 与 `--source-outline` 保留给已有大纲场景，它们不代表已完成创意、人物小传和分集大纲三项提取。

### 从原剧本文本或已有分镜提炼大纲

输入支持按集排列的 Markdown、TXT 和 DOCX。DOCX 读取使用 Python 标准库，保留正文、表格与播出集序；不会直接理解视频。已有原片分析分镜可以作为输入，但应注明它是原片分析的派生材料。

```bash
# 只检查分集、范围和输入长度，不调用模型、不创建提炼任务
npm run tianshu -- extract-outline inputs/source.docx --episodes 3 --preview

# 调用已配置的 Kimi，提炼原剧前三集
npm run tianshu -- extract-outline inputs/source.docx --episodes 3 \
  --output inputs/source-outline.md
```

提炼按每三集顺序执行，只保留核心事件、主冲突、反转、结尾状态和钩子，同时保留来源依据与疑点。缺失信息写“未知”；人物别名矛盾和倒叙原样保留，不编造身份映射、不重排故事时间。每集约 150–300 个中文字符是压缩目标，不能为了缩短而删掉关键事实。

原文快照、各批结果与用量写在 `<output>.extraction/`，全部批次成功后才产生指定的大纲文件。已有输出或记录目录时拒绝再次执行，避免不知情地重复调用；失败后的中间结果留在原目录供检查，当前入口没有自动恢复或覆盖行为。

### 三集小样

```bash
npm run tianshu -- init inputs/brief.txt --title "小样名称" \
  --sample --source-episodes 50 \
  --source-outline inputs/source-outline.md \
  --contract inputs/production-contract.json
```

`--sample` 明确创建原剧第 1–3 集的独立样例，`--source-episodes` 记录已确认的原剧总集数，未知时省略。整剧复刻的源数与输出数分别记录；输出数由规划阶段按剧情和时长确定，`--episodes N` 为初始参考。普通原创仍使用 30/60 集。小样沿用规划、独立审稿、大纲批准、剧本、分镜和交付流程，不补占位集；第三集可以保留未解冲突或倒叙，不被要求写成全剧结局。状态、审稿与用量报告、Markdown/DOCX 均标明样例范围。

生成规划并经独立审稿后，用户仍须批准最终大纲，才能执行 `run`。素材对应的目标市场、单集时长与最终交付类型应在小样开始前确定。

规划已正式提交、但审稿调用或结果接收失败时，重新执行 `plan <run-id>` 会复用该轮已完成的规划，只重试审稿。终审工具会在接收时校验 P2 的处置字段，缺失时要求 Reviewer 补齐，避免先接受后在流程外报错。

小样的窗口审稿和终审各设 5 分钟等待上限。窗口审稿成功后立即保存结果；恢复同轮审稿时，只有完整材料和审稿指令均未变化才复用，避免终审中断后重复支付已完成的窗口审稿。超时会保留当前产物和 reviewing 状态，不视为审稿通过。

对已经阻断的剧本审稿，如有明确源证据或规则层级错误，可用 `review <run-id> --note inputs/review-note.txt` 请求有据复核。意见会留在新报告中，Reviewer 仍须核对正文；此命令不改剧本、不重置修订预算。新结果若为 `repair`，先执行 `repair <run-id>` 再 `run <run-id>`，由 Writer 定向修订。此前仅被阻断、尚未修订的问题，不会被误算成“修后仍存在”。

分镜对应入口为 `storyboard-review <run-id> --note inputs/review-note.txt`，支持复核尚未执行的修订要求或已阻断的分镜审稿。对源稿有意保留的身份、时间疑点，审稿不能以新增幕后事件或身份关系作为修复条件。

### 使用已有大纲

有完整源大纲时，用 `--source-outline` 初始化复刻项目。源文件单独保存为 `canonical/source-outline.md`，路线记录为 `tianshu-replication`；普通 `init` 仍走原创路线。初始化只读入文件，不请求模型，也不会批准大纲。

```bash
npm run tianshu -- init brief.md --title "剧名" --episodes 60 \
  --source-outline source-outline.md --contract production-contract.json
```

`brief.md` 写明目标市场、复刻目标和允许的文化适配。源大纲按 `## 第1集` 到 `## 第N集` 排列，也支持纯文本集标题；N 为实际源集数，`--source-episodes N` 可以校对源覆盖；输出集数独立规划。模板见 [source-outline.template.md](examples/source-outline.template.md)。每集建议保留核心事件、主冲突、反转、起止状态、尾钩和跨集承接；已有信息写在正文中即可，不强制新增固定字段。程序只检查集号完整、有序且正文非空。

Planner 会保留这些剧情骨架，补齐人物、市场资料和连续性台账，同时提交每个输出集的源映射与起止事件；长源集优先增加输出集数。对白、动作编排和场景细节留给 Writer。原始大纲会完整交给 Planner 和独立规划 Reviewer；后续 Writer、Storyboard 和 Reviewer 使用同一份已批准映射；完整源集只作上下文，当前稿仅展开分配到本输出集的事件，前后段用来核对承接及避免重播。源大纲里的监控、DNA 等既有情节由语义审稿判断，复刻模式不因关键词直接拒绝整集；双语、格式、时长和其它结构检查继续执行。

源大纲与 60–90 秒规划目标难以兼顾时，先在规划阶段增加集数，保留必要的对白、动作和情绪落点。100 秒是成稿硬上限；Planner 的 `targetSeconds` 仍须控制在 90 秒以内。分镜允许一镜完成连续对白、动作与即时反应，钩子可以落在已有末镜上；删重复复述和机械停顿，不强制每句之后另加停留镜。独立 Reviewer 核对全源覆盖、起止事件、重复与切点；规划通过后仍由用户批准一次，之后才能 `run`。

已产生剧本的 run 不直接改变映射和输出数，重分集需创建新规划 run，避免复用旧任务与连续性状态。已冻结 run 的合同不会自动修改；旧合同若允许 120 秒，仍按旧合同验收。新策略仅适用于新建整剧复刻，sample 与原创的范围保持不变，已有源编号仍按原有方式读取。Markdown、DOCX 交付在已审定单元格修正生效后重新累加镜头秒数，在每集标题和全剧摘要中显示；这些是单语言配音的分镜估时，实际成片时长另行测量。

### 已有样例与离线验证

[合成 60 集样例](fixtures/replication-synthetic/source-outline.md)用于验证完整集数、源稿保留和自定义生产合同。另有 [合成 30 集样例](fixtures/replication-example.md) 和 [审核正反例](fixtures/replication-review.json)。这些都是测试材料，不代表真实生产或创作质量已经通过验收。

```bash
npm run test:replication
```

`npm run test:replication` 是 `npm test` 的别名，两者均运行完整离线测试；同一份未变化的代码执行一次即可。测试覆盖源稿完整保留、规划与修订输入、独立审稿举证、草稿提交边界、人物与连续性上下文、队列、真实 CLI 初始化、原创路径、标准化 Markdown/DOCX、已审定修正重放及用量累计。全部使用本地文件或事件样本，不调用模型；通过这些测试不代表创作质量或成本改善已通过真实生成验证。

### 用量与路线对比

```bash
npm run tianshu -- metrics <run-id>
```

该命令只读 `metrics/*.json`，按角色和全任务汇总所有已记录尝试，包含失败、重试及 Planner 各轮。`usageTotal` 表示已记录消息中字段完整的用量；缺报显示 `null`，`usageKnown` 保留已观测小计。`usageCoverage` 只覆盖 assistant 消息，`promptRequestCoverage` 另记录每次 `session.prompt` 的成功、失败、超时和重试；一次 prompt 可以包含多次模型请求。原始 provider 请求总数与账单金额没有观测时保持未知，不能把消息字段齐全称为整条路线精确计费。

提纲提炼的用量位于 `<output>.extraction/metrics/`，须与后续写作、审稿及分镜一起计入本次路线；使用历史大纲时，其历史提炼成本未知，不能当零。原始 usage 与模型名称均保留，不自行推断缓存是否包含在 input 或 reasoning 是否包含在 output。

`wallElapsedMs` 是已记录尝试最早开始至最晚结束的跨度，包含中间空隙，重叠阶段不相加；它不是模型纯执行时间。与 ReelClaw 对比时须统一来源集段、市场、时长、交付类型和计时起止；没有同范围的实际对照结果就报告未知，不计算节省百分比。

使用飞书生产表时，可由表拥有者创建“产出路线”单选列（[字段定义](examples/production-route-field.json)），再选择“天书复刻”或“ReelClaw”。分别记录路线、剧本交付、分镜交付和人工审阅状态，成片进度不能代替剧本验收。两路线按同一素材、集数与交付范围比较耗时、token 和人工审阅结果；CLI 不会自动修改生产表。

## 本机环境与按需运行

### 本地自动生产

后台入口使用 Node 标准库读取所选数据目录下 `.queue/` 中的任务，每次最多启动一个创作进程。空队列立即退出，实际生成才加载 Pi SDK；每个 run 按冻结的执行合同使用远端 Kimi、DeepSeek 或 GPT。worker 启动本仓库的 CLI，并传入同一数据目录，单剧数据目录无需包含代码。人物继续保存在 `canonical/characters.md`，分集骨架在 `outline.md`，身份和连续性由 `ledger.json` 与连续性快照承接，不另建人物数据库或常驻 Web 服务。

旧版天书值得沿用的是人物关系、分集状态变化与相邻集接缝；其人物文件最低 30 KB 的长度规则及并发节点池不适合作为本项目的轻量目标。[旧版人物输入](https://github.com/byfusion/tianshu/blob/main/drama-skills/src/prompts.js#L143)、[旧版长度规则](https://github.com/byfusion/tianshu/blob/main/drama-skills/src/status.js#L22)。

先用现有 `init` 创建带明确素材、大纲和生产合同的 run，再显式入队：

```bash
export TIANSHU_ROOT=/path/to/production
npm run worker -- enqueue <run-id>
npm run worker -- status
npm run worker -- once
```

worker 与 CLI 使用相同的目录优先级，也可显式执行 `npm run worker -- --root /path/to/production once`。

草稿入队后自动规划，停在大纲批准处。执行 `npm run tianshu -- approve <run-id>` 后，再次运行本地 worker 即可继续剧本、修订、分镜与交付。生成完成的队列状态为 `awaiting_producer_review`：制作人在开制作前自行审改，AI 终审与本地导出不代表制作人已审核。

失败任务保留恢复点并停为 `failed`，处理实际原因后显式执行 `npm run worker -- retry <run-id>`。后台不会每分钟重复失败的模型请求。`needs_human_review`、大纲批准和交付批准状态都会暂停；每个 run 的锁也始终保留原有 `lock-status / unlock-stale` 处理流程。队列完成后，由使用者把文档交到选定的交付位置，并单独记录人工审阅结果。

默认不安装 launchd 或其它常驻服务。`worker once` 完成一个任务后退出；`worker drain --max-jobs N` 串行处理有限队列，独立任务的失败或等待人工不阻止后续项目；空队列时只短暂读取 JSON，不加载 Pi SDK。仓库中的 launchd 配置生成脚本不会自行安装或启动服务；Mac mini 部署需要另外配置和授权。

新建生产任务时通过 `--model` 与 `--agent-dir`（或当时的 `PI_CODING_AGENT_DIR`）冻结链路；CLI 与 worker 按任务的执行合同选择配置目录，不复制凭据、不修改默认公司配置，凭据值不写入队列。空闲检查的短暂开销与真实生成峰值要分别测量；视频 Base64 和会话上下文都会产生临时内存，不能把空队列 RSS 当作整剧峰值。

在本机项目目录使用 Node ≥22.19 和仓库锁定的 Pi SDK 0.85.1，凭据独立放在该设备，不复制个人配置：

```bash
npm ci --ignore-scripts --no-audit --no-fund
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
export TIANSHU_PYTHON="$PWD/.venv/bin/python"
export PI_CODING_AGENT_DIR="$PWD/.pi-company"
npm run check:environment
```

`check:environment` 仅检查本机依赖、磁盘和凭据文件是否存在，不读凭据值，不探测模型节点，也不刷新登录。它的通过只说明依赖就绪，不能证明公司账号已登录或服务器可生产。`TIANSHU_PYTHON` 与 `PI_CODING_AGENT_DIR` 也需保留在实际生产进程的环境中。

公司账号可在仓库内运行 `./node_modules/.bin/pi`，然后执行 `/login kimi-coding`，按 **Sign in with Kimi Code** 完成设备码授权。Pi 也支持公司 `KIMI_API_KEY`；既有 `auth.json` 优先于该环境变量，因此应使用独立公司凭据目录，并确认登录身份。不要把密码、Key 或授权码写入 brief、Git 或日志。上述目录已忽略提交。

首次生产前确认素材、目标市场、集数、交付范围及账号预算，再审核最终大纲。离线测试不会发起模型请求；实际质量、耗时和 token 节省需由同一素材、同一交付范围的真实样例验证。

## 产物和审计

项目事实都在所选数据目录的 `runs/<run-id>/`：

- `canonical/`：brief、生产合同、市场合同、大纲、人物和台账
- `screenplay/`：通过提交工具提升的单集剧本
- `continuity/`：逐集连续性快照、历史事件和失效存档
- `storyboard/`：通过提交工具提升的固定 7 列分镜
- `reviews/`：每轮窗口审稿、全剧审稿、Repair Plan 和最终 PASS 证明
- `tasks/`：任务状态、产物摘要、输入合同摘要和修订指令
- `events.jsonl`：Runtime 状态变化
- `deliverables/`：最终 Markdown 和 DOCX

早期剧本修订会把连续性回退到上一集，顺序复核后续状态，并使受影响的分镜和审稿证明失效。交付前会重新检查 task 状态、文件摘要、生产合同、市场合同、源剧本摘要、连续性和最终审稿证明。

完整设计见 [docs/ARCHITECTURE_PLAN.md](docs/ARCHITECTURE_PLAN.md)。

## 开发验证

```bash
npm test
```

实验脚本保留在 `src/experiments/`，不属于正式 `runs/` 生产路径。
