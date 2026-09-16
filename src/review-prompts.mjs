import {
  createProductionContract,
  createReplicationProductionContract,
} from "./production-contract.mjs";
import { reviewAttractionGuidance, episodePacingGuidance } from "./attraction.mjs";
import { sampleContext } from "./sample.mjs";
import { isResegmentedReplication } from "./episode-map.mjs";

const candidateReviewRules =
  "定向一致性候选只是风险线索，不是已确认缺陷。逐项对照候选 quotes 和正文上下文，提交 candidateDispositions；每个 candidateId 恰好一次。disposition=finding 时用 findingId 关联本次同集 finding；dismissed 表示原文排除了疑点；needs_source 表示现有证据不足，保留未知、不补造事实。每项 evidence 必须直接摘录一条提供的 quote 或其充分片段，reason 写明判断理由。不要因为候选存在就判整集失败或要求重写整集。";

export function reviewPrompt(
  stage,
  contractText,
  manifest = {},
  contract = isResegmentedReplication(manifest)
    ? createReplicationProductionContract()
    : createProductionContract(),
) {
  const stageRules =
    stage === "planning"
      ? `检查题材承诺、主角能动性、前三集宣发钩子、${manifest.scope?.kind === "sample" ? "样例范围内的冲突推进" : "全季升级线"}、目标市场、人物和账本是否自洽。规划尚未获用户批准，可以要求 Planner 修订上游内容；复刻项目须服从提供的源大纲保留边界。`
      : stage === "screenplay"
        ? "检查真实剧情、跨集连续性、因果代价、人物能动性、自然双语、市场制度和每集结尾钩子。只用 screenplay 约束验收剧本。storyboard 的镜数和单镜3–10秒约束属于下游分镜，剧本中的短拍点或参考时间码不能据此阻断；Storyboard Agent 会合并或拆分为合规镜头。"
        : "逐镜对照源剧本，检查信息遗漏或篡改、前几集冷开与可剪宣发桥段、节奏时长、动作反应、连续性、双语、可拍性和安全边界。";
  const mappingRules = isResegmentedReplication(manifest)
    ? "输出集编号与源集编号分离，以episode-map.json的sourceEpisodes、startEvent、endEvent和targetSeconds为准。规划阶段允许增加输出集数，把长源集沿完整动作、反转、揭示或未决选择自然拆为符合冻结合同目标的短集；检查全源剧情覆盖、事件顺序和新集界，不能要求每个输出集重演整个源集。规划批准后按本输出集分配的事件验收，相邻输出集尚未发生的内容不能报成本集遗漏；重复使用一个源集作参考不等于应重复演同一事件。保留真实情绪转折，删同义复述和无变化等待；口播与必要表演时间应能在预算内完成，不能只缩数字。语速或停顿的孤立意见沿现有局部审稿处理，不建立逐镜内容规则导致整集短路。"
    : "";
  const sourceRules =
    stage === "planning"
      ? ""
      : "复刻项目按主冲突、关键反转、人物关系、状态变化和事件先后判断大纲保留；动作形式、对白和环境音允许补充或自然转述，须保留已给出的原句信息、说话对应和有据场景状态，不以逐字相同为硬门。相同台词、类似音效、服装颜色或外貌相似均不能单独证明同一时刻或同一人物；身份判断须合看人物小传、已证映射与场景证据，不能要求每场重新点名才能沿用已知制作身份。时间矛盾须有明确时间断言或不可能并存的状态支持。尚未得到证据解决的人物映射、关系或画外过程须保留未知，不得把未知当作缺陷，也不得要求新增未获大纲支持的画外事件来补齐因果。若扩写新增了没有依据的断言，应优先删除新增断言，不得通过补更多未批准事件来填平矛盾。正文是验收对象，头尾自检描述不准确应与真实剧情错误区分。不要把纯偏好报成缺陷。真实非阻断问题可由终审标为 accepted_non_blocking，不得为制造修订任务而虚构问题。";
  return `你是 TianshuAgent 内部独立 Reviewer，只审不写。${stageRules}${sourceRules}\n\n${mappingRules}\n\n${episodePacingGuidance(contract)}\n\n${manifest.productionRoute === "tianshu-replication" ? reviewAttractionGuidance : ""}\n\n${contractText}\n\n${sampleContext(manifest)}\n\n每个 finding 必须有稳定 id、category、原文证据、明确修复验收标准、修复指令以及必须保留/不得改动的内容。P0=必须改已批准合同或系统性根基；P1=交付前必须修；P2=真实但非阻断问题。没有问题也必须调用提交工具并提交空数组。禁止用“符合要求”“没有问题”制造 P2。`;
}

export function windowReviewPrompt(stage, contractText, manifest, contract) {
  return `${reviewPrompt(stage, contractText, manifest, contract)}\n\n窗口审稿必须为窗口内每一集提交摘要、结尾状态、钩子和可剪宣发桥段；这些带 artifact digest 的摘要会交给独立全剧 Reviewer 做跨集审查。\n\n${candidateReviewRules}`;
}

export function seriesReviewPrompt(stage, contractText, manifest, contract) {
  const evidenceRules =
    stage === "planning"
      ? ""
      : "窗口 summary 和 findings 只是线索。保留任何 P1 或 disposition=repair 的 P2 前，必须调用 read_review_episodes 核对相关正式稿及相邻集上下文；窗口摘要省略的动作和正式稿已有的未知说明均不能虚构为缺陷。scope 按实际修复范围判断：仅当必须修改已批准的 canonical 规划或生产合同时用 upstream；一集或相邻几集的台词承接、恢复已批准内容用 local 或 pair，不能因为举证引用多集就用 series。";
  return `${reviewPrompt(stage, contractText, manifest, contract)}\n\n你是当前交付范围的终审，与创作 Agent 和窗口 Reviewer 使用全新的独立 session。窗口 findings 只是线索，必须复核后自行决定保留、删除或补充。${evidenceRules}完成审核后再提交 summary，写明实际审核结论，不得提交“待补充”或“placeholder”占位；确无问题时 findings 可为空。每个 P2 必须选择 repair 或 accepted_non_blocking；P0/P1 的 disposition 固定填 repair。\n\n${candidateReviewRules}\n终审仅需为窗口 disposition=finding 的候选提交复核处置；保留或删除均须说明理由，不能以空 findings 静默丢弃。窗口已排除或 needs_source 的候选保留记录，不要求重复全量审查；源证据不足的未知项不得补造结论。`;
}
