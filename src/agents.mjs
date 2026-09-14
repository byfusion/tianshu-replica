import fs from "node:fs";
import path from "node:path";
import { Type, Compile, createPiExperimentSession, defineTool, promptWithWatchdog, readText, sha, writeJson, writeText } from "./experiments/lib.mjs";
import { STORYBOARD_HEADER, checkStoryboard, loadManifest, saveManifest, storyboardWarnings, taskPath } from "./core.mjs";
import { screenplayBilingualErrors } from "./bilingual.mjs";
import { canonicalPersonNames, fixedEntityErrors } from "./entities.mjs";
import { continuityContext, continuityIsAccepted, extractContinuityUpdate, invalidateContinuityFrom, reviewContinuityUpdate, stageContinuityProposal } from "./continuity.mjs";
import { inferMarketIntent, marketArtifactDigest, marketChecks, marketContractMarkdown, validateMarketSubmission } from "./market.mjs";
import { createProductionContract, createReplicationProductionContract, episodeDurationPolicy, loadProductionContract, productionContractDigest, productionContractMarkdown } from "./production-contract.mjs";
import { reviewStage, stageArtifactDigest } from "./semantic-review.mjs";
import { appendRunMetrics } from "./metrics.mjs";
import { parseSourceOutline, replicationPlannerContext, replicationWriterContext } from "./replication.mjs";
import { performanceAttractionGuidance, episodePacingGuidance } from "./attraction.mjs";
import { sampleContext } from "./sample.mjs";
import { mapConcurrent } from "./concurrency.mjs";
import { normalizeEpisodeDraft } from "./draft-contract.mjs";
import { isResegmentedReplication, validateEpisodeMap, loadEpisodeMap } from "./episode-map.mjs";
import { executionContractStatus } from "./execution-contract.mjs";

const ep = (n) => String(n).padStart(2, "0");
const batches = (total) => Array.from({length:Math.ceil(total/5)},(_,i)=>({from:i*5+1,to:Math.min(total,i*5+5)}));
const appendAgentEvent=(runDir,event)=>fs.appendFileSync(path.join(runDir,"events.jsonl"),`${JSON.stringify({at:new Date().toISOString(),...event})}\n`);
export const planningWatchdogMs = (episodes) => Number(episodes) > 30 ? 600_000 : 180_000;
export const nextContinuityRepairAttempt=(task={})=>Number(task.continuityRepairAttempt||0)+1;
export function routeContinuityRejectToWriter(runDir,{episode,error,taskFile,prior={},attempt,maxAttempts=2}) {
  if(error.code!=="CONTINUITY_REJECTED")throw error;
  appendAgentEvent(runDir,{type:"continuity_rejected",actorRole:"ContinuityAgent",episode,attempt,reason:error.review?.reason||error.message});
  if(attempt>maxAttempts){const blocked=loadManifest(runDir);blocked.state="needs_human_review";blocked.note=`continuity repair budget exhausted at episode ${episode}: ${error.review?.reason||error.message}`;saveManifest(runDir,blocked);throw error;}
  const instruction=[`连续性复核拒绝了当前第 ${episode} 集。`,`证据：${error.review?.reason||error.message}`,`验收：重写本集，使本集真实事件能够从上一集已接受快照自然发生，并提交准确的 continuityUpdate。`,`若本集已批准大纲规定的事件在正文漏写，应补回正文；不得为了通过连续性检查将其删掉、推迟到后集或标成未发生，源事实及未知边界仍须保留。`,`必须保留：已批准大纲、人物身份、市场合同和本集仍有效的剧情功能。`,`不得改动：既有连续性合同和此前已接受的事实。`].join("\n");
  writeJson(taskFile,{...prior,state:"stale",repairInstruction:instruction,continuityRepairAttempt:attempt});return {routed:true,attempt};
}
function outlineWindow(outline, episode, total) {
  const parts = outline.split(/(?=^## 第\d+集)/m);
  const wanted = new Set([episode - 1, episode, episode + 1].filter((n) => n >= 1 && n <= total));
  return parts.filter((part) => wanted.has(Number(part.match(/^## 第(\d+)集/m)?.[1]))).join("\n\n");
}
export function artifactTools(runDir, workDir, { normalize = (markdown) => markdown, onWrite = () => {} } = {}) {
  const roots=['canonical','screenplay','storyboard','continuity','reviews','research'];
  const read=defineTool({name:'read_artifact',label:'Read artifact',description:'Read an approved, non-stale project artifact by relative path. When truncated, call again with nextOffset until the complete artifact has been read.',parameters:Type.Object({ref:Type.String(),offset:Type.Optional(Type.Integer({minimum:0}))}),async execute(_id,p){const f=path.resolve(runDir,p.ref);if(!roots.some(r=>f.startsWith(path.join(runDir,r)+path.sep))||!fs.existsSync(f))return {content:[{type:'text',text:'REJECTED artifact unavailable'}],details:{},terminate:false};const content=readText(f),match=p.ref.match(/^(screenplay|storyboard)\/ep-(\d+)\.md$/);if(match){const task=taskPath(runDir,`${match[1]}-ep-${match[2]}`);if(!fs.existsSync(task))return {content:[{type:'text',text:'REJECTED artifact has no approved task'}],details:{},terminate:false};const record=JSON.parse(readText(task));if(record.state!=="passed"||record.digest!==sha(content))return {content:[{type:'text',text:'REJECTED artifact is stale'}],details:{},terminate:false};}const offset=p.offset??0,end=Math.min(offset+12000,content.length),truncated=end<content.length;return {content:[{type:'text',text:content.slice(offset,end)},...(truncated?[{type:'text',text:`TRUNCATED: continue read_artifact with ref=${JSON.stringify(p.ref)} and offset=${end}; totalChars=${content.length}`}]:[])],details:{ref:p.ref,offset,totalChars:content.length,nextOffset:truncated?end:null,truncated}};}});
  const write=defineTool({name:'write_draft',label:'Write draft',description:'Write the complete current-episode draft only inside this task workspace. Runtime normalizes episode metadata and observed table separators. This is not the final submission.',parameters:Type.Object({markdown:Type.String({minLength:700})}),async execute(_id,p){writeText(path.join(workDir,'draft.md'),normalize(p.markdown));onWrite();return {content:[{type:'text',text:'draft saved for this episode; run checks next'}],details:{}};}});
  return [read,write];
}

export function storyboardSourceContext(runDir, episode) {
  const canonical = path.join(runDir, "canonical");
  const characters = readText(path.join(canonical, "characters.md"));
  const contractFile = path.join(canonical, "continuity-contract.md");
  const contract = fs.existsSync(contractFile) ? readText(contractFile) : "未提供独立静态连续性合同；以已批准人物及剧本为准。";
  return `\n\n【已批准人物参考数据开始】\n${characters}\n【已批准人物参考数据结束】\n\n【静态连续性合同参考数据开始】\n${contract}\n【静态连续性合同参考数据结束】${replicationWriterContext(runDir, episode)}`;
}
const writeBatchMetrics = appendRunMetrics;
export function shortcutChecks(markdown) {
  const failures=[];
  if (/(?:监控(?:摄像头|录像)?|录像|CCTV|security camera|surveillance)/i.test(markdown)) failures.push('禁止把监控或录像作为剧情证据');
  if (/(?:DNA|基因鉴定)/i.test(markdown)) failures.push('禁止使用 DNA 作为翻盘手段');
  return failures;
}
function plotChecks(markdown, productionRoute) {
  return productionRoute === "tianshu-replication" ? [] : shortcutChecks(markdown);
}
export function storyboardChecks(markdown, market, canonicalNames, productionContract, productionRoute = null) {
  return [...checkStoryboard(markdown, canonicalNames, productionContract), ...marketChecks(markdown, market), ...plotChecks(markdown, productionRoute)];
}
export function screenplayChecks(markdown, episode, market, canonicalNames = [], productionContract = null, productionRoute = null) {
  const failures=[];
  const contract = productionContract || { screenplay: { englishDialogueWordLimit: 260, maxScenes: 4 } };
  if (markdown.length < 700) failures.push('剧本过短');
  const lines = markdown.split('\n');
  const englishSegments=[];
  for(let index=0;index<lines.length;index++){
    const marker=lines[index].match(/(?:（EN）|\(EN\)|EN\s*[:：])/);
    if(!marker)continue;
    let value=lines[index].slice((marker.index||0)+marker[0].length).trim();
    if(!value&&index+1<lines.length)value=lines[index+1].trim();
    englishSegments.push(value);
  }
  const englishDialogue = englishSegments.join(' ').trim();
  const englishDialogueWords = englishDialogue ? englishDialogue.split(/\s+/).filter(Boolean).length : 0;
  if (englishDialogueWords > contract.screenplay.englishDialogueWordLimit) failures.push(`英文对白过长 ${englishDialogueWords} 词（上限 ${contract.screenplay.englishDialogueWordLimit}）`);
  const sceneCount = (markdown.match(/^##\s*(?:场景|场\s*\d+|SCENE\b)/gim) || []).length;
  if (sceneCount > contract.screenplay.maxScenes) failures.push(`场景过多 ${sceneCount}（上限 ${contract.screenplay.maxScenes}）`);
  if (!/【本集钩子】/.test(markdown)) failures.push('缺少【本集钩子】');
  if (!/【连续性检查】/.test(markdown)) failures.push('缺少【连续性检查】');
  if (!/(?:（EN）|\(EN\)|(?:EN|英)\s*[:：])|^[A-Za-z][A-Za-z .'-]{1,40}[:：]|\/\s*[A-Za-z][A-Za-z .,'"'!?—-]{4,}/m.test(markdown)) failures.push('缺少英文台词');
  if (!new RegExp(`(?:第?\\s*${episode}\\s*集|EP(?:ISODE)?\\s*${episode})`, 'i').test(markdown)) failures.push('缺少本集标识');
  // A source story may legitimately contain a recording or DNA event. In replica
  // mode, source fidelity and plot quality belong to the independent Reviewer.
  const plotErrors = plotChecks(markdown, productionRoute);
  return [...failures, ...screenplayBilingualErrors(markdown, canonicalNames), ...fixedEntityErrors(markdown, canonicalNames), ...marketChecks(markdown, market), ...plotErrors];
}
export function planningSystemPrompt(manifest, contract = isResegmentedReplication(manifest) ? createReplicationProductionContract() : createProductionContract()) {
  const replica = manifest.productionRoute === "tianshu-replication";
  const goal = isResegmentedReplication(manifest)
    ? `Adapt all ${manifest.sourceEpisodes} source episodes into naturally divided output episodes. ${episodePacingGuidance(contract)} The initial count ${manifest.episodes} is a planning reference, not a fixed total. Increase the output count when the source needs more room; preserve every core event, its order, character states, causality and meaningful interaction. Choose boundaries at completed actions, reversals, discoveries or unanswered decisions already present in the source. Do not invent cliffhangers, pad short episodes with repeated pauses, compress dialogue beyond performability, or repeat a source event in both halves. Submit an episodeMap alongside the output outline: one entry per output episode with sourceEpisodes, startEvent, endEvent and targetSeconds. A source episode may span several consecutive output episodes; the assigned start/end events identify the part each output owns. Keep the source episode count unchanged.`
    : replica
    ? `Adapt the supplied source outline into a ${manifest.episodes}-episode planning bundle. Preserve its event order, conflicts, reversals, character states, and episode hooks; do not invent a new story. Keep planning compact while retaining the source interactions that carry character appeal or emotional turns; leave their full dialogue and staging to Writer. Preserve the source protagonist and story mechanisms, including evidence devices when already part of the source; do not impose a different protagonist or genre.`
    : `Create a strong ${manifest.episodes}-episode vertical-drama plan from the brief. Use one emotion engine, concrete hooks, active heroine, no police/court/DNA/surveillance shortcuts.`;
  return `You are Tianshu Planner. ${goal} The target market and production contract are hard creative constraints.${replica ? " If a source event conflicts with those constraints, identify it for independent review rather than silently replacing the source event." : ""} ${replica ? "The first promotional episodes should preserve the source appeal and offer extractable character, relationship, emotional or conflict beats without inventing a new hook." : "The first promotional episodes need immediate, visually legible conflict and extractable payoff beats."} Also write a natural-language continuity baseline: immutable identities and world rules, opening custody/debt/knowledge states, and any hard future rails. Do not pretend later episode changes have already happened; those are maintained by the Continuity Agent. Submit only through the tool.${sampleContext(manifest) ? `\n\n${sampleContext(manifest)}` : ""}`;
}
export function planningTaskPrompt(runDir, productionContract, intent, repair = null) {
  const input = readText(path.join(runDir, "canonical", "input.md"));
  const sourceContext = replicationPlannerContext(runDir);
  const repairContext = repair ? `\n\nThis is a bounded planning repair. Preserve every approved strength and change only what the findings require. 当修订明确要求仅对acts.md或characters.md做局部精确片段替换时，只调用submit_planning_patch，提交file、old_text、new_text组成的replacements，不重写完整规划包；其它类型修订仍使用submit_planning_bundle。一次选择一个提交工具。\nCurrent planning bundle:\n${["acts.md","design.md","outline.md","episode-map.json","characters.md","ledger.json","continuity-contract.md"].map((name)=>{const file=path.join(runDir,"canonical",name);return fs.existsSync(file)?`## ${name}\n${readText(file)}`:"";}).join("\n\n")}\n\nRepair plan:\n${JSON.stringify(repair.findings)}` : "";
  const scopeContext = sampleContext(loadManifest(runDir));
  return `Brief:\n${input}\n\nNon-negotiable market intent:\n${marketContractMarkdown(intent)}\n\nProduction contract:\n${productionContractMarkdown(productionContract)}${repairContext}${sourceContext ? `\n\n${sourceContext}` : ""}${scopeContext ? `\n\n${scopeContext}` : ""}`;
}

export function planningBundleParameters(manifest, contract = isResegmentedReplication(manifest) ? createReplicationProductionContract() : createProductionContract()) {
  const resegmented = isResegmentedReplication(manifest);
  const { target } = episodeDurationPolicy(contract);
  return Type.Object({
    market:Type.Object({country:Type.String(),setting:Type.String({minLength:20}),characterNaming:Type.String({minLength:20}),socialContext:Type.String({minLength:20}),culturalAnchors:Type.Array(Type.String({minLength:2}),{minItems:2})}),
    acts:Type.String({minLength:100}), design:Type.String({minLength:100}), characters:Type.String({minLength:100}),
    ledger:Type.Object({names:Type.Array(Type.String(),{minItems:2}),facts:Type.Array(Type.String(),{minItems:3})}),
    continuityContract:Type.String({minLength:200}),
    outline:Type.Array(Type.String({minLength:40}), resegmented ? {minItems:1} : {minItems:manifest.episodes,maxItems:manifest.episodes}),
    ...(resegmented ? {episodeMap:Type.Array(Type.Object({
      sourceEpisodes:Type.Array(Type.Integer({minimum:1}),{minItems:1}),
      startEvent:Type.String({minLength:1}), endEvent:Type.String({minLength:1}),
      targetSeconds:Type.Integer({minimum:target.min,maximum:target.max}),
    }),{minItems:1})} : {}),
  });
}

export function validatePlanningEpisodeSubmission(manifest, bundle, { episodeDurationSeconds, targetDurationSeconds = episodeDurationSeconds, currentEpisodeMap = null, hasScreenplays = false } = {}) {
  if (!Array.isArray(bundle.outline) || !bundle.outline.length) return ["outline must contain output episodes"];
  if (!isResegmentedReplication(manifest)) {
    return bundle.outline.length === manifest.episodes ? [] : [`outline must contain exactly ${manifest.episodes} episodes`];
  }
  const errors = validateEpisodeMap(bundle.episodeMap, { sourceEpisodes: manifest.sourceEpisodes, outputEpisodes: bundle.outline.length, episodeDurationSeconds, targetDurationSeconds });
  if (errors.length) return errors;
  const mapValues = (map) => Array.isArray(map) ? map.map((entry) => [entry.sourceEpisodes, entry.startEvent, entry.endEvent, entry.targetSeconds]) : null;
  if (hasScreenplays && (bundle.outline.length !== manifest.episodes || JSON.stringify(mapValues(bundle.episodeMap)) !== JSON.stringify(mapValues(currentEpisodeMap)))) {
    errors.push("screenplays already exist; changing output count or episodeMap requires a new planning run");
  }
  return errors;
}

export function planningBudgetGuidance(runDir, episode, productionContract) {
  const manifest = loadManifest(runDir);
  const mapping = isResegmentedReplication(manifest) ? loadEpisodeMap(runDir)[episode - 1] : null;
  return `本输出第 ${episode} 集${mapping ? `映射目标 ${mapping.targetSeconds} 秒。` : "。"}${episodePacingGuidance(productionContract)}中英对白是两种配音版本，只按一种语言的实际口播安排时长。对白、动作和有意义的反应可以同镜完成，必要情绪留白也计入总预算；删除同义复述、重复威胁和无变化停顿，不靠只缩秒数、加速念词或删核心因果达标。${mapping ? "只展开本集映射的起止事件，相邻输出集承担的源内容不得重复写入；源集编号不等于输出集编号。" : ""}`;
}

async function generatePlanningBundle(runDir, repair = null) {
  const m=loadManifest(runDir), input=readText(path.join(runDir,"canonical","input.md")), intent=inferMarketIntent(input); let accepted=false;
  const productionContract = loadProductionContract(runDir);
  const durationPolicy = episodeDurationPolicy(productionContract);
  const taskPrompt = planningTaskPrompt(runDir, productionContract, intent, repair);
  const role = `planner-cycle-${Number(m.reviewCycles?.planning || 0) + 1}`;
  const promote = (p, changedFiles = null) => {
    const screenplayDir = path.join(runDir, "screenplay");
    const hasScreenplays = fs.existsSync(screenplayDir) && fs.readdirSync(screenplayDir).some((name) => /^ep-\d+\.md$/.test(name));
    const currentEpisodeMap = isResegmentedReplication(m) ? loadEpisodeMap(runDir, { required: false }) : null;
    const errors = [...validateMarketSubmission(intent,p.market), ...validatePlanningEpisodeSubmission(m,p,{
      episodeDurationSeconds:durationPolicy.hard, targetDurationSeconds:durationPolicy.target, currentEpisodeMap, hasScreenplays,
    })];
    if(errors.length)return {content:[{type:'text',text:`REJECTED ${errors.join('；')}`}],details:{errors},terminate:false};
    if (changedFiles) {
      for (const file of changedFiles) writeText(path.join(runDir, "canonical", file), p[file === "acts.md" ? "acts" : "characters"]);
    } else {
      const contract={...intent,...p.market};
      writeJson(path.join(runDir,"canonical","market.json"),contract);
      writeText(path.join(runDir,"canonical","market-contract.md"),marketContractMarkdown(contract));
      writeText(path.join(runDir,"canonical","acts.md"),p.acts);
      writeText(path.join(runDir,"canonical","design.md"),p.design);
      writeText(path.join(runDir,"canonical","characters.md"),p.characters);
      writeJson(path.join(runDir,"canonical","ledger.json"),p.ledger);
      writeText(path.join(runDir,"canonical","continuity-contract.md"),p.continuityContract);
      writeText(path.join(runDir,"canonical","outline.md"),p.outline.map((x,i)=>`## 第${i+1}集\n${x}`).join("\n\n"));
      if (isResegmentedReplication(m)) {
        writeJson(path.join(runDir,"canonical","episode-map.json"),p.episodeMap);
        m.episodes = p.outline.length;
        saveManifest(runDir,m);
      }
    }
    accepted=true;
    return {content:[{type:"text",text:"ACCEPTED planning, continuity, and market contracts"}],details:{},terminate:true};
  };
  const submit=defineTool({
    name:"submit_planning_bundle",
    label:"Submit planning",
    description:"Submit a complete planning bundle, natural-language continuity baseline, target-market contract, and exact episode outline.",
    parameters:planningBundleParameters(m,productionContract),
    async execute(_id,p){ return promote(p); }
  });
  const fullBundleCheck = repair ? Compile(submit.parameters) : null;
  const patch = repair ? defineTool({
    name: "submit_planning_patch", label: "Submit exact planning repair",
    description: "Replace uniquely matching text only in existing acts.md or characters.md; validate the complete candidate bundle before formal submission. Other files remain unchanged.",
    parameters: Type.Object({ replacements: Type.Array(Type.Object({ file: Type.Union([Type.Literal("acts.md"), Type.Literal("characters.md")]), old_text: Type.String({ minLength: 1 }), new_text: Type.String() }), { minItems: 1 }) }),
    async execute(_id, p) {
      const canonical = path.join(runDir, "canonical");
      const bundle = {
        market: JSON.parse(readText(path.join(canonical, "market.json"))),
        acts: readText(path.join(canonical, "acts.md")), design: readText(path.join(canonical, "design.md")), characters: readText(path.join(canonical, "characters.md")),
        ledger: JSON.parse(readText(path.join(canonical, "ledger.json"))), continuityContract: readText(path.join(canonical, "continuity-contract.md")),
        outline: parseSourceOutline(readText(path.join(canonical, "outline.md")), m.episodes).episodes.map(({ text }) => text.slice(text.indexOf("\n") + 1)),
        ...(isResegmentedReplication(m) ? {episodeMap:loadEpisodeMap(runDir)} : {}),
      };
      const changedFiles = new Set();
      for (const replacement of p.replacements) {
        const field = replacement.file === "acts.md" ? "acts" : "characters", text = bundle[field];
        const start = text.indexOf(replacement.old_text);
        if (start < 0 || text.indexOf(replacement.old_text, start + 1) >= 0) return { content: [{ type: "text", text: `REJECTED ${replacement.file}: old_text must match exactly once` }], details: {}, terminate: false };
        bundle[field] = text.slice(0, start) + replacement.new_text + text.slice(start + replacement.old_text.length);
        changedFiles.add(replacement.file);
      }
      writeJson(path.join(runDir, "work", role, "patch-candidate.json"), { replacements: p.replacements, bundle });
      const errors = fullBundleCheck.Errors(bundle).map((error) => `${error.instancePath}: ${error.message}`);
      if (errors.length) return { content: [{ type: "text", text: `REJECTED ${errors.join("; ")}` }], details: { errors }, terminate: false };
      return promote(bundle, changedFiles);
    },
  }) : null;
  const tools = patch ? [submit, patch] : [submit];
  const {session,metrics}=await createPiExperimentSession({runDir,role,systemPrompt:planningSystemPrompt(m,productionContract),customTools:tools,toolNames:tools.map((tool) => tool.name)});
  let outcome = "completed";
  try {
    await promptWithWatchdog(session, metrics, taskPrompt, planningWatchdogMs(m.episodes));
    if (!accepted) throw new Error("planner did not submit");
    return metrics;
  } catch (error) {
    outcome = "failed";
    throw error;
  } finally {
    session.dispose();
    appendRunMetrics(runDir, role, metrics, outcome);
  }
}

export function completedPlanningMetrics(runDir) {
  const manifest = loadManifest(runDir);
  if (manifest.state !== "planning") return null;
  const cycle = Number(manifest.reviewCycles?.planning || 0) + 1;
  const file = path.join(runDir, "metrics", `planner-cycle-${cycle}.json`);
  if (!fs.existsSync(file)) return null;
  const metrics = JSON.parse(readText(file));
  const artifacts = ["acts.md", "design.md", "outline.md", "characters.md", "ledger.json", "continuity-contract.md", "market.json", "market-contract.md"];
  if (metrics.outcome !== "completed" || !artifacts.every((name) => fs.existsSync(path.join(runDir, "canonical", name)))) return null;
  if (isResegmentedReplication(manifest)) {
    try {
      if (!loadEpisodeMap(runDir)) return null;
      parseSourceOutline(readText(path.join(runDir,"canonical","outline.md")),manifest.episodes);
    } catch { return null; }
  }
  return metrics;
}

export async function plan(runDir, { operatorNote = "" } = {}) {
  const manifest = loadManifest(runDir);
  if (!["draft", "planning", "returned"].includes(manifest.state)) throw new Error(`plan requires draft, planning, or returned; got ${manifest.state}`);
  let pendingMetrics = operatorNote ? null : completedPlanningMetrics(runDir);
  manifest.state = "planning";
  saveManifest(runDir, manifest);
  let repair = operatorNote ? { findings: [{ repairInstruction: operatorNote }] } : null;
  while (true) {
    const metrics = pendingMetrics || await generatePlanningBundle(runDir, repair);
    pendingMetrics = null;
    const report = await reviewStage(runDir, "planning", { operatorNote });
    const current = loadManifest(runDir);
    current.planMetrics = metrics;
    if (report.plan.action === "pass") {
      current.state = "awaiting_approval";
      current.note = "planning passed independent review";
      saveManifest(runDir, current);
      return report;
    }
    if (report.plan.action === "blocked") {
      current.state = "needs_human_review";
      current.note = report.plan.reasons.map((item) => item.reason).join("; ");
      saveManifest(runDir, current);
      return report;
    }
    repair = report.plan;
    current.revision += 1;
    current.state = "planning";
    saveManifest(runDir, current);
  }
}
export async function produceScripts(runDir) {
  const m=loadManifest(runDir);
  if(!["approved","screenplay_producing","screenplay_repairing"].includes(m.state))throw new Error(`produce requires approved or screenplay repair state, got ${m.state}`);
  const outline=readText(path.join(runDir,"canonical","outline.md"));
  const chars=readText(path.join(runDir,"canonical","characters.md"));
  const ledger=readText(path.join(runDir,"canonical","ledger.json"));
  const ledgerNames=canonicalPersonNames(chars,JSON.parse(ledger).names||[]);
  const market=JSON.parse(readText(path.join(runDir,"canonical","market.json")));
  const marketContract=readText(path.join(runDir,"canonical","market-contract.md"));
  const productionContract=loadProductionContract(runDir), contractDigest=productionContractDigest(productionContract), contractText=productionContractMarkdown(productionContract);
  m.state="screenplay_producing";saveManifest(runDir,m);
  for(const b of batches(m.episodes)){
    let active={episode:b.from,hasDraft:false,submitted:false};
    const workDir=path.join(runDir,'work',`writer-${b.from}-${b.to}`);
    const routeContinuityReject=(episode,error,taskFile,prior={})=>{const durable=fs.existsSync(taskFile)?JSON.parse(readText(taskFile)):prior,attempt=nextContinuityRepairAttempt(durable);return routeContinuityRejectToWriter(runDir,{episode,error,taskFile,prior:durable,attempt,maxAttempts:productionContract.revision.maxContinuityRepairAttempts}).routed;};
    let lastChecks=[];
    const runChecks=defineTool({name:'run_checks',label:'Check screenplay',description:'Validate the draft for the current episode before submission, including the target-market and production contracts.',parameters:Type.Object({}),async execute(){const draft=path.join(workDir,'draft.md');if(!active.hasDraft||!fs.existsSync(draft))lastChecks=['本轮尚未调用 write_draft 写入当前集草稿'];else lastChecks=screenplayChecks(readText(draft),active.episode,market,ledgerNames,productionContract,m.productionRoute);return {content:[{type:'text',text:lastChecks.length?`FAIL: ${lastChecks.join('；')}`:'PASS: draft is eligible for submission'}],details:{failures:lastChecks},terminate:false};}});
    const submit=defineTool({
      name:"submit_screenplay",
      label:"Submit screenplay",
      description:"Submit the checked draft plus a natural-language continuity update. The tool reads the saved draft; never paste a screenplay into this call.",
      parameters:Type.Object({episode:Type.Integer(),continuityUpdate:Type.String({minLength:8})}),
      async execute(_id,p){
        if(p.episode!==active.episode)return {content:[{type:"text",text:"REJECTED wrong episode"}],details:{},terminate:false};
        const draft=path.join(workDir,'draft.md');
        if(!active.hasDraft||!fs.existsSync(draft))return {content:[{type:'text',text:'REJECTED write_draft must save the current episode in this task first'}],details:{},terminate:false};
        const markdown=readText(draft), errors=screenplayChecks(markdown,p.episode,market,ledgerNames,productionContract,m.productionRoute);
        if(errors.length)return {content:[{type:'text',text:`REJECTED ${errors.join('；')}`}],details:{errors},terminate:false};
        writeText(path.join(runDir,"screenplay",`ep-${ep(p.episode)}.md`),markdown);
        stageContinuityProposal(runDir,{episode:p.episode,screenplay:markdown,proposedUpdate:p.continuityUpdate});
        const continuity=continuityContext(runDir);
        const taskFile=taskPath(runDir,`screenplay-ep-${ep(p.episode)}`),priorTask=fs.existsSync(taskFile)?JSON.parse(readText(taskFile)):{};
        writeJson(taskFile,{...priorTask,state:"passed",digest:sha(markdown),contractDigest,marketDigest:marketArtifactDigest(runDir),previousContinuityDigest:continuity.current.snapshotDigest,actorRole:"TianshuWriter"});
        active.submitted=true;
        return {content:[{type:"text",text:"ACCEPTED screenplay; continuity proposal staged for independent review"}],details:{},terminate:true};
      }
    });
    const tools=artifactTools(runDir,workDir,{normalize:(markdown)=>normalizeEpisodeDraft(markdown,{stage:"screenplay",episode:active.episode}),onWrite:()=>{active.hasDraft=true;active.submitted=false;}}), role=`writer-${b.from}-${b.to}`;
    const {session,metrics}=await createPiExperimentSession({runDir,role,systemPrompt:`你是天书剧本作者，一次只做指定的一集。剧本首行必须是唯一的一级标题“# 第 N 集｜集名”，N 使用当前集数的阿拉伯数字；根据本集已批准的大纲和剧情确定有意义的集名，不用“剧本”“分镜表”“分镜剧本”等文档类型作集名或标题后缀。产物是按场景组织的剧本、动作与双语对白，不预先生成逐镜分镜表或逐镜时间码；具体拆镜与单镜时长交下游分镜阶段。每次任务必须严格走三步：1) 用 write_draft 写完整剧本；2) 调用 run_checks；3) 仅在收到 PASS 后调用 submit_screenplay，提交当前集数和本集自然语言 continuityUpdate。continuityUpdate 只写本集真正发生的状态变化。你不能直接修改连续性合同，独立 Continuity Agent 会复核。submit 会读取草稿，绝不把剧本粘进参数。不要输出解释、不要停在半成品。每句对白必须连续写成角色（中）和角色（EN）两行。剧本必须有【本集钩子】和【连续性检查】。冲突必须产生后果。市场合同、生产合同与连续性合同都是硬约束。\n\n${contractText}`,customTools:[...tools,runChecks,submit],toolNames:["read_artifact","write_draft","run_checks","submit_screenplay"]});
    let outcome='completed';
    try{
      for(let n=b.from;n<=b.to;n++){
        const task=taskPath(runDir,`screenplay-ep-${ep(n)}`);
        const artifact=path.join(runDir,"screenplay",`ep-${ep(n)}.md`);
        const prior=fs.existsSync(task)?JSON.parse(readText(task)):null;
        if(prior?.state==='passed'&&fs.existsSync(artifact)&&prior.digest===sha(readText(artifact))&&prior.contractDigest===contractDigest&&prior.marketDigest===marketArtifactDigest(runDir)){
          const screenplay=readText(artifact);
          if(continuityIsAccepted(runDir,n,sha(screenplay)))continue;
          const recordPath=path.join(runDir,"continuity",`ep-${ep(n)}.json`);
          const proposed=fs.existsSync(recordPath)?JSON.parse(readText(recordPath)).proposedUpdate:extractContinuityUpdate(screenplay);
          if(!proposed)throw new Error(`episode ${n} is missing a continuity proposal`);
          const previousContinuityDigest=continuityContext(runDir).current.snapshotDigest;
          try{await reviewContinuityUpdate(runDir,{episode:n,screenplay,proposedUpdate:proposed});}catch(error){if(routeContinuityReject(n,error,task,prior)){n-=1;continue;}}
          writeJson(task,{...prior,previousContinuityDigest,continuityDigest:JSON.parse(readText(recordPath)).snapshotDigest});
          continue;
        }
        active.episode=n;active.hasDraft=false;active.submitted=false;lastChecks=[];
        const continuity=continuityContext(runDir);
        const nearby=[n-1,n+1].filter(x=>x>=1&&x<=m.episodes).map(x=>{const f=path.join(runDir,'screenplay',`ep-${ep(x)}.md`);return fs.existsSync(f)?`第${x}集：\n${readText(f).slice(0,14000)}`:'';}).filter(Boolean).join('\n\n');
        const repair=prior?.repairInstruction?`\n这是修订任务。保留下面现有剧本的有效内容，只修复列出的缺陷。\n现有剧本：\n${fs.existsSync(artifact)?readText(artifact).slice(0,30000):''}\n修订要求：\n${prior.repairInstruction}`:"";
        const taskPrompt=`${sampleContext(m)}\n${planningBudgetGuidance(runDir,n,productionContract)}\n只写第 ${n} 集，并按 write_draft → run_checks → submit_screenplay 的顺序调用工具。\n市场与文化合同：\n${marketContract}\n\n生产合同：\n${contractText}\n\n静态连续性合同：\n${continuity.contract.slice(0,18000)}\n\n截至上一集的动态连续性快照：\n${continuity.current.snapshot}\n\n本集及相邻集大纲：\n${outlineWindow(outline,n,m.episodes)}\n人物：${chars.slice(0,12000)}\n初始台账：${ledger.slice(0,8000)}\n相邻集上下文：\n${nearby}${replicationWriterContext(runDir,n)}${repair}`;
        await promptWithWatchdog(session,metrics,taskPrompt,1800000);
        if(!active.submitted)await promptWithWatchdog(session,metrics,`上一回合没有提交第 ${n} 集本轮正式稿。现在只做三步：write_draft；run_checks；submit_screenplay，同时提交 continuityUpdate。不要解释，不要开始别集。`,120000);
        if(!active.submitted||!fs.existsSync(artifact))throw new Error(`writer did not submit episode ${n}`);
        const screenplay=readText(artifact);
        const recordPath=path.join(runDir,"continuity",`ep-${ep(n)}.json`);
        const proposed=fs.existsSync(recordPath)?JSON.parse(readText(recordPath)).proposedUpdate:extractContinuityUpdate(screenplay);
        if(!proposed)throw new Error(`writer did not submit continuity for episode ${n}`);
        try{await reviewContinuityUpdate(runDir,{episode:n,screenplay,proposedUpdate:proposed});}catch(error){if(routeContinuityReject(n,error,task,JSON.parse(readText(task)))){n-=1;continue;}}
        const acceptedContinuity=JSON.parse(readText(recordPath)),taskRecord=JSON.parse(readText(task));
        writeJson(task,{...taskRecord,continuityDigest:acceptedContinuity.snapshotDigest});
      }
    }catch(error){outcome='failed';writeBatchMetrics(runDir,role,metrics,outcome,{error:error.message});throw error;}finally{session.dispose();}
    writeBatchMetrics(runDir,role,metrics,outcome);
  }
  m.state="screenplay_reviewing";saveManifest(runDir,m);
}
export async function produceStoryboards(runDir) {
  const m=loadManifest(runDir);if(!["screenplay_passed","storyboard_producing","storyboard_repairing"].includes(m.state))throw new Error(`storyboard requires screenplay_passed or storyboard repair state, got ${m.state}`);const market=JSON.parse(readText(path.join(runDir,"canonical","market.json"))),marketContract=readText(path.join(runDir,"canonical","market-contract.md")),characters=readText(path.join(runDir,"canonical","characters.md")),ledgerNames=canonicalPersonNames(characters,JSON.parse(readText(path.join(runDir,"canonical","ledger.json"))).names||[]),productionContract=loadProductionContract(runDir),contractDigest=productionContractDigest(productionContract),contractText=productionContractMarkdown(productionContract);m.state="storyboard_producing";saveManifest(runDir,m);
  await mapConcurrent(batches(m.episodes), executionContractStatus(runDir).family === "deepseek" ? 8 : 1, async (b) => {let active={episode:b.from,hasDraft:false,submitted:false};const workDir=path.join(runDir,'work',`storyboard-${b.from}-${b.to}`);const runChecks=defineTool({name:'run_checks',label:'Check storyboard',description:'Validate the saved draft for the current episode before submission, including the target-market and production contracts.',parameters:Type.Object({}),async execute(){const draft=path.join(workDir,'draft.md'),errors=active.hasDraft&&fs.existsSync(draft)?storyboardChecks(readText(draft),market,ledgerNames,productionContract,m.productionRoute):["本轮尚未调用 write_draft 写入当前集草稿"];const warnings=active.hasDraft&&fs.existsSync(draft)?storyboardWarnings(readText(draft),productionContract):[];const warn=warnings.length?`\nWARN(不阻断，但提交前应尽量修正): ${warnings.join('；')}`:'';return {content:[{type:'text',text:(errors.length?`FAIL: ${errors.join('；')}`:'PASS: storyboard is eligible for submission')+warn}],details:{errors,warnings},terminate:false};}});const submit=defineTool({name:"submit_storyboard",label:"Submit storyboard",description:"Submit the checked saved draft. The tool reads the saved draft; never paste a storyboard into this call.",parameters:Type.Object({episode:Type.Integer()}),async execute(_id,p){const draft=path.join(workDir,'draft.md');const errors=p.episode===active.episode&&active.hasDraft&&fs.existsSync(draft)?storyboardChecks(readText(draft),market,ledgerNames,productionContract,m.productionRoute):['wrong episode or no write_draft in the current task'];if(errors.length)return {content:[{type:"text",text:`REJECTED ${errors.join("; ")}`}],details:{errors},terminate:false};const markdown=readText(draft),source=readText(path.join(runDir,"screenplay",`ep-${ep(p.episode)}.md`));writeText(path.join(runDir,"storyboard",`ep-${ep(p.episode)}.md`),markdown);writeJson(taskPath(runDir,`storyboard-ep-${ep(p.episode)}`),{state:"passed",digest:sha(markdown),sourceScreenplayDigest:sha(source),contractDigest,marketDigest:marketArtifactDigest(runDir),actorRole:"TianshuStoryboardAgent"});active.submitted=true;return {content:[{type:"text",text:"ACCEPTED storyboard"}],details:{},terminate:true};}});
    const tools=artifactTools(runDir,workDir,{normalize:(markdown)=>normalizeEpisodeDraft(markdown,{stage:"storyboard",episode:active.episode,screenplay:readText(path.join(runDir,"screenplay",`ep-${ep(active.episode)}.md`))}),onWrite:()=>{active.hasDraft=true;active.submitted=false;}}), role=`storyboard-${b.from}-${b.to}`;
    const {session,metrics}=await createPiExperimentSession({runDir,role,systemPrompt:`你是天书分镜导演。分镜首行必须是唯一的一级标题“# 第 N 集｜集名”，后接固定七列表格；N 使用当前集数的阿拉伯数字，集名必须沿用本集已通过审稿的剧本集名，不另起名字，也不用“分镜表”“分镜剧本”等文档类型作集名或标题后缀。每次任务必须严格走三步：1) 用 write_draft 写完整分镜；2) 调用 run_checks；3) 只有 PASS 后调用 submit_storyboard 并传当前集数。submit 会读取草稿，绝不把分镜粘进 submit 参数。不要输出解释。表头必须是：| ${STORYBOARD_HEADER.join(" | ")} |。镜头号格式为 epNN-sNN（两位集号+两位镜号）。单元格内换行用 <br>：台词格写"角色：中文台词<br>EN: English line<br>表演：……"（无台词写"无台词"）；运镜格写"运镜 / 景别<br>走位：……"；人物图/场景图格写"人物：……<br>场景：……<br>道具：……"；备注格写"音效：……<br>功能：一个叙事功能标签（如 建立/反应/情绪停留/对峙/揭示/钩子定格）<br>连续性：与上一镜的衔接关系<br>制作：……"。\n\n${contractText}
${m.productionRoute === "tianshu-replication" ? performanceAttractionGuidance : ""}
节奏与衔接原则：
- 以剧本正文的实际动作、对白和时间线为准；头部钩子说明和尾部自检若与正文不符，不能覆盖正文，也不能据其添加新事件。
- 母本若带拍点或参考时间码，保留其剧情和节奏功能，再按生产合同合并或拆分为合规镜头；参考拍点不等于必须原样照搬的最终镜头。
- 以完整表演节拍拆镜：同一轮连续对白、动作和对方反应可以在同镜完成，不把一句话逐小句拆镜。
- 反应有变化才留：认知、情绪或关系发生变化时保留落点；可用同镜表演、视线或接话承载，不在每句台词后机械加停留镜。
- 必要呼吸计入预算：高潮前后允许留白，但删去重复威胁、重复解释、无变化的凝视与等待；按实际动作和一种语言的口播安排秒数。
- 尾钩落在已有剧情上：末镜动作、对白或反应形成悬念即可，不强制再加独立定格镜，不重复本集最后一个信息。
- 衔接显式化：同时空连续镜在备注格"连续性"行写明继承的视线、站位、道具；时空跳转先给建立镜再切近景。市场合同是硬约束：镜头中的人物、场景、道具、建筑、机构、服装和视觉提示必须属于目标国家，而非默认中国语境。`,customTools:[...tools,runChecks,submit],toolNames:["read_artifact","write_draft","run_checks","submit_storyboard"]});
    let outcome='completed';try{for(let n=b.from;n<=b.to;n++){const task=taskPath(runDir,`storyboard-ep-${ep(n)}`);const artifact=path.join(runDir,"storyboard",`ep-${ep(n)}.md`);const source=readText(path.join(runDir,"screenplay",`ep-${ep(n)}.md`));const prior=fs.existsSync(task)?JSON.parse(readText(task)):null;if(prior?.state==='passed'&&fs.existsSync(artifact)&&prior.digest===sha(readText(artifact))&&prior.contractDigest===contractDigest&&prior.sourceScreenplayDigest===sha(source))continue;active.episode=n;active.hasDraft=false;active.submitted=false;const repair=prior?.repairInstruction?`\n\n这是受约束的分镜修订任务。保留有效内容，只修下面的问题。\n现有分镜：\n${fs.existsSync(artifact)?readText(artifact):""}\n修订要求：\n${prior.repairInstruction}`:"";await promptWithWatchdog(session,metrics,`${sampleContext(m)}\n${planningBudgetGuidance(runDir,n,productionContract)}\n只制作第 ${n} 集，按 write_draft → run_checks → submit_storyboard 的顺序调用工具。\n市场与文化合同：\n${marketContract}\n\n生产合同：\n${contractText}\n\n剧本：\n${source}${storyboardSourceContext(runDir,n)}${repair}`,1800000);if(!active.submitted||!fs.existsSync(artifact))throw new Error(`storyboard agent did not submit episode ${n}`);}}catch(error){outcome='failed';writeBatchMetrics(runDir,role,metrics,outcome,{error:error.message});throw error;}finally{session.dispose();}writeBatchMetrics(runDir,role,metrics,outcome);});
  m.state="storyboard_reviewing";saveManifest(runDir,m);
}

export async function reviewScripts(runDir, { operatorNote = "" } = {}) {
  const m=loadManifest(runDir);
  if(m.state!=="screenplay_reviewing") {
    const latest=path.join(runDir,"reviews","screenplay-latest.json");
    if(m.state!=="needs_human_review"||!operatorNote.trim()||!fs.existsSync(latest)||JSON.parse(readText(latest)).plan?.action!=="blocked")throw new Error(`screenplay review requires screenplay_reviewing, or an explicit review note for a blocked screenplay review; got ${m.state}`);
  }
  const report=await reviewStage(runDir,"screenplay",{operatorNote}),current=loadManifest(runDir);
  if(report.plan.action==="pass"){current.state="screenplay_passed";current.note="screenplay passed independent series review";}
  else if(report.plan.action==="repair"){current.state="screenplay_repairing";current.note=`screenplay repair cycle ${report.cycle}`;}
  saveManifest(runDir,current);return report;
}

export async function reviewStoryboards(runDir, { operatorNote = "" } = {}) {
  const m=loadManifest(runDir);
  if(m.state!=="storyboard_reviewing") {
    const latest=path.join(runDir,"reviews","storyboard-latest.json");
    const expectedAction=m.state==="storyboard_repairing"?"repair":m.state==="needs_human_review"?"blocked":null;
    if(!expectedAction||!operatorNote.trim()||!fs.existsSync(latest)||JSON.parse(readText(latest)).plan?.action!==expectedAction)throw new Error(`storyboard review requires storyboard_reviewing, or an explicit review note for a pending repair or blocked storyboard review; got ${m.state}`);
  }
  const report=await reviewStage(runDir,"storyboard",{operatorNote}),current=loadManifest(runDir);
  if(report.plan.action==="pass"){current.state="final_review";current.note="storyboard passed independent series review";}
  else if(report.plan.action==="repair"){current.state="storyboard_repairing";current.note=`storyboard repair cycle ${report.cycle}`;}
  saveManifest(runDir,current);return report;
}

function latestRepairReport(runDir) {
  for(const stage of ["storyboard","screenplay","planning"]){const file=path.join(runDir,"reviews",`${stage}-latest.json`);if(fs.existsSync(file)){const report=JSON.parse(readText(file));if(report.plan?.action==="repair")return report;}}
  throw new Error("no active repair plan");
}

function repairInstruction(findings) {
  return findings.map((finding,index)=>[
    `${index+1}. [${finding.id}] ${finding.repairInstruction}`,
    `   证据：${finding.evidence}`,
    `   验收：${finding.acceptance}`,
    finding.preserve?.length?`   必须保留：${finding.preserve.join("；")}`:"",
    finding.doNotChange?.length?`   不得改动：${finding.doNotChange.join("；")}`:"",
  ].filter(Boolean).join("\n")).join("\n");
}

function removeReviewProof(runDir,stages){for(const stage of stages){const file=path.join(runDir,"reviews",`${stage}-final.json`);if(fs.existsSync(file))fs.unlinkSync(file);}}

export function applyRepair(runDir,suppliedReport=null) {
  const m=loadManifest(runDir),report=suppliedReport||latestRepairReport(runDir),plan=report.plan;
  if(plan.action!=="repair")throw new Error(`repair plan action is ${plan.action}`);
  if(stageArtifactDigest(runDir,plan.stage)!==plan.artifactDigest)throw new Error("repair plan artifact digest is stale");
  const contractDigest=productionContractDigest(loadProductionContract(runDir));if(plan.contractDigest!==contractDigest)throw new Error("repair plan production contract is stale");
  if(report.marketDigest!==marketArtifactDigest(runDir))throw new Error("repair plan market contract is stale");
  const repairable=plan.findings.filter((finding)=>finding.severity==="P1"||(finding.severity==="P2"&&finding.disposition==="repair")),grouped=new Map();
  for(const finding of repairable){const targets=finding.scope==="pair"&&finding.episode<m.episodes?[finding.episode,finding.episode+1]:[finding.episode];for(const episode of targets)grouped.set(episode,[...(grouped.get(episode)||[]),finding]);}
  const stale=[];
  if(plan.stage==="screenplay"){
    const earliest=Math.min(...grouped.keys()),continuity=invalidateContinuityFrom(runDir,earliest,m.episodes,`screenplay repair cycle ${plan.cycle}`);
    appendAgentEvent(runDir,{type:"continuity_rewound",actorRole:"Runtime",fromEpisode:earliest,restoredThrough:continuity.restoredThrough,cycle:plan.cycle});
    for(const [episode,findings] of grouped){const id=`screenplay-ep-${ep(episode)}`,file=taskPath(runDir,id),prior=fs.existsSync(file)?JSON.parse(readText(file)):{id};writeJson(file,{...prior,state:"stale",repairInstruction:repairInstruction(findings),repairCycle:plan.cycle});stale.push(id);}
    for(let episode=earliest;episode<=m.episodes;episode++){const id=`storyboard-ep-${ep(episode)}`,file=taskPath(runDir,id),prior=fs.existsSync(file)?JSON.parse(readText(file)):{id};writeJson(file,{...prior,state:"stale",staleReason:`screenplay changed from episode ${earliest}`});stale.push(id);}
    removeReviewProof(runDir,["screenplay","storyboard"]);m.state="screenplay_producing";m.note=`Tianshu Writer repair cycle ${plan.cycle}`;saveManifest(runDir,m);return {plan,stale:[...new Set(stale)].sort(),continuity};
  }
  if(plan.stage==="storyboard"){
    for(const [episode,findings] of grouped){const id=`storyboard-ep-${ep(episode)}`,file=taskPath(runDir,id),prior=fs.existsSync(file)?JSON.parse(readText(file)):{id};writeJson(file,{...prior,state:"stale",repairInstruction:repairInstruction(findings),repairCycle:plan.cycle});stale.push(id);}
    removeReviewProof(runDir,["storyboard"]);m.state="storyboard_producing";m.note=`Tianshu Storyboard Agent repair cycle ${plan.cycle}`;saveManifest(runDir,m);return {plan,stale:stale.sort()};
  }
  throw new Error(`applyRepair does not directly edit ${plan.stage} artifacts`);
}
