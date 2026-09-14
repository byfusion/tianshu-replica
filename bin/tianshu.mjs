#!/usr/bin/env node
import fs from "node:fs";
import { bindRunModel, executionContractStatus } from "../src/execution-contract.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createRun, loadManifest, markdownDelivery, readText, runRoot, saveManifest, transition, writeJson, writeText } from "../src/core.mjs";
import { applyRepair, plan, produceScripts, produceStoryboards, reviewScripts, reviewStoryboards } from "../src/agents.mjs";
import { clearStaleRunLock, deliveryGate, readRunLock, runProduction, withRunLock } from "../src/runtime.mjs";
import { readRunMetrics } from "../src/metrics.mjs";
import { extractSourceOutline } from "../src/extract-outline.mjs";
import { loadSourceEpisodes } from "../src/source-input.mjs";
import { loadSourceMaterials } from "../src/source-materials.mjs";
import { deliveryScope, sampleLabel } from "../src/sample.mjs";
import { loadReviewedRepairs, registerReviewedRepairs } from "../src/reviewed-repairs.mjs";
const CODE_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const rawArgs=process.argv.slice(2);
let DATA_ROOT=path.resolve(process.env.TIANSHU_ROOT||CODE_ROOT);
let cmd,args;
const findRun=(id)=>path.join(runRoot(DATA_ROOT),id);
const help=()=>console.log("tianshu [--root data-directory] extract-source <source.md|txt|docx> --episodes N [--output inputs/materials.json | --preview] | extract-video <episodes.json> [--output inputs/materials.json [--resume [--repair-episode N]] | --preview] | extract-outline <source.md|txt|docx> --episodes N [--output inputs/outline.md | --preview] | init <input> [--model kimi|deepseek|ds|gpt] [--agent-dir directory] [--title T] [--episodes N] [--source-materials materials.json | --source-outline outline.md] [--sample] [--source-episodes N] [--contract production-contract.json] | bind-model <run> --model kimi|deepseek|gpt [--agent-dir directory] | plan <run> [--note repair-note.txt] | set-delivery-title <run> <title> | status <run> | metrics <run> | approve <run> | run <run> | resume <run> | produce <run> | review <run> [--note review-note.txt] | repair <run> | storyboard <run> | storyboard-review <run> [--note review-note.txt] | approve-delivery <run> | return <run> <note> | accept-corrections <run> <reviewed-record.json> | deliver <run> | lock-status <run> | unlock-stale <run>\nText models are frozen at init: kimi=kimi-coding/k3-256k, deepseek(ds)=deepseek/deepseek-flash, gpt=openai-codex/gpt-6-astra. Source extraction is independent; GPT text runs never invoke Gemini. Legacy runs require explicit bind-model for subsequent execution; historical identity stays unknown.\nData directory: --root (before or after the command) > TIANSHU_ROOT > this repository. Input/output file paths remain relative to the current working directory.\ninit episode counts: original 30|60 (default 30); full-series replication separates sourceEpisodes from output episodes; --source-episodes checks complete source coverage, --episodes is an optional planning reference, and the approved outline/map determines the output count; --sample exactly 3 (default 3).\nNew full-series replication timing: target 60–90 seconds, usually 75 (pacing.targetDurationSeconds / pacing.preferredDurationSeconds); planned targetSeconds must be <=90, with a hard episode limit of 100 seconds. Natural endings over 90 and up to 100 seconds may be kept with a Reviewer pacing note; above 100, prefer more episodes. Frozen runs keep their existing contracts, including old 120-second limits. Sample and original scopes are unchanged.");
const flag=(name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const mutateRun=(id,operation)=>{const d=findRun(id);return withRunLock(d,()=>operation(d));};
async function deliverUnlocked(d){const m=loadManifest(d);if(!["ready_to_deliver","delivered"].includes(m.state))throw new Error(`cannot deliver from ${m.state}`);const readiness=deliveryGate(d);const md=markdownDelivery(d);const deliveryTitle=m.deliveryTitle?`${sampleLabel(m)}${m.deliveryTitle}`:`${sampleLabel(m)}${m.title}｜分镜剧本`;const out=path.join(d,"deliverables",`${deliveryTitle}.md`);const docx=path.join(d,"deliverables",`${deliveryTitle}.docx`);writeText(out,md);execFileSync(process.env.TIANSHU_PYTHON||"python3",[path.join(CODE_ROOT,"src","experiments","render_storyboard_docx.py"),out,docx,m.deliveryTitle?deliveryTitle:"",path.join(d,"screenplay")]);if(!fs.existsSync(docx)||fs.statSync(docx).size<1000)throw new Error("DOCX render failed");const corrections=loadReviewedRepairs(d);writeJson(path.join(d,"delivery.json"),{...deliveryScope(m),title:deliveryTitle,markdown:out,docx,...(corrections?{reviewedCorrections:{file:path.join(d,"reviewed-repairs.json"),registeredAt:corrections.registeredAt,provenance:corrections.provenance,appliedCells:corrections.changes.length,pendingSourceFindingIds:corrections.pendingSourceFindingIds||[],reviewBasis:"independent editorial corrections; generation stage reviews remain separate"}}:{}),digest:(await import("../src/core.mjs")).sha(md),readiness});return transition(d,"delivered","Markdown and DOCX delivery generated after fresh delivery gate");}
try {
  const rootIndex=rawArgs.indexOf("--root");
  if(rootIndex>=0){
    const value=rawArgs[rootIndex+1];
    if(!value?.trim()||value.startsWith("--"))throw new Error("--root requires a run data directory");
    DATA_ROOT=path.resolve(value);
    rawArgs.splice(rootIndex,2);
  }
  [cmd,...args]=rawArgs;
  if(cmd==="extract-outline"||cmd==="extract-source"){
  const count=Number(flag("--episodes")||3);
  if(args.includes("--preview")){
    const source=await loadSourceEpisodes(args[0],count);
    console.log(JSON.stringify({sourcePath:source.sourcePath,sourceKind:source.sourceKind,totalEpisodes:source.totalEpisodes,selectedEpisodes:source.episodes.map(({episode,text,reference})=>({episode,characters:text.length,reference})),plannedMaterials:cmd==="extract-source"?["creative","characters","outline"]:["outline"],directVideoUnderstanding:false,modelRequestSent:false},null,2));
  }else{
    const output=flag("--output");
    if(!output||output.startsWith("--"))throw new Error("--output requires a local output path; use --preview to inspect without a model call");
    const extract=cmd==="extract-source"?(await import("../src/extract-source.mjs")).extractSourceMaterials:extractSourceOutline;
    console.log(JSON.stringify(await extract({sourcePath:args[0],episodes:count,outputPath:output}),null,2));
  }
}
else if(cmd==="extract-video"){
  const {extractVideoMaterials,previewVideoMaterials}=await import("../src/extract-video.mjs");
  if(args.includes("--preview"))console.log(JSON.stringify(await previewVideoMaterials(args[0]),null,2));
  else{const output=flag("--output");if(!output||output.startsWith("--"))throw new Error("--output requires a local JSON path; use --preview before a model call");console.log(JSON.stringify(await extractVideoMaterials({manifestPath:args[0],outputPath:output,resume:args.includes("--resume"),...(args.includes("--repair-episode")?{repairEpisode:Number(flag("--repair-episode"))}:{})}),null,2));}
}
else if(cmd==="init"){
  const input=readText(args[0]),title=flag("--title")||input.split("\n")[0].slice(0,50);
  const contractFile=flag("--contract"),productionContract=contractFile?JSON.parse(readText(contractFile)):undefined;
  const sourceFile=flag("--source-outline"),materialsFile=flag("--source-materials");
  if(args.includes("--source-outline")&&(!sourceFile||sourceFile.startsWith("--")))throw new Error("--source-outline requires a Markdown file");
  if(args.includes("--source-materials")&&(!materialsFile||materialsFile.startsWith("--")))throw new Error("--source-materials requires a JSON file");
  if(sourceFile&&materialsFile)throw new Error("use --source-materials or --source-outline, not both");
  const sample=args.includes("--sample"),count=flag("--episodes")===null?undefined:Number(flag("--episodes")),sourceCount=flag("--source-episodes");
  for(const name of ["--model","--agent-dir"])if(args.includes(name)&&(!flag(name)||flag(name).startsWith("--")))throw new Error(`${name} requires a value`);
  const {id,manifest}=createRun(DATA_ROOT,{title,model:flag("--model")??undefined,agentDir:flag("--agent-dir")??undefined,episodes:count,sample,sourceTotalEpisodes:sourceCount===null?null:Number(sourceCount),input,...(sourceFile?{sourceOutline:readText(sourceFile)}:{}),...(materialsFile?{sourceMaterials:loadSourceMaterials(materialsFile,sample?3:undefined)}:{}),...(productionContract?{productionContract}:{})});
  console.log(JSON.stringify({id,state:"draft",executionModel:executionContractStatus(findRun(id)),productionRoute:manifest.productionRoute,...(manifest.sourceEpisodes?{sourceEpisodes:manifest.sourceEpisodes}:{}),...deliveryScope(manifest)}));
}
else if(cmd==="set-delivery-title"){const title=args.slice(1).join(" ").trim();if(!title||/[\\/\0\r\n]/.test(title))throw new Error("delivery title must be a filename-safe single line");console.log(JSON.stringify(await mutateRun(args[0],async(d)=>{const m=loadManifest(d);if(m.state==="delivered")throw new Error("set the delivery title before export");m.deliveryTitle=title;saveManifest(d,m);return {id:m.id,state:m.state,deliveryTitle:m.deliveryTitle};})));}
else if(cmd==="bind-model"){for(const name of ["--model","--agent-dir"])if(args.includes(name)&&(!flag(name)||flag(name).startsWith("--")))throw new Error(`${name} requires a value`);console.log(JSON.stringify(await mutateRun(args[0],(d)=>bindRunModel(d,{model:flag("--model"),agentDir:flag("--agent-dir")??undefined})),null,2));}
else if(cmd==="status"){const d=findRun(args[0]);console.log(JSON.stringify({...loadManifest(d),executionModel:executionContractStatus(d)},null,2));}
else if(cmd==="metrics"){const d=findRun(args[0]);loadManifest(d);console.log(JSON.stringify(readRunMetrics(d),null,2));}
else if(cmd==="lock-status"){console.log(JSON.stringify(readRunLock(findRun(args[0])),null,2));}
else if(cmd==="unlock-stale"){console.log(JSON.stringify(clearStaleRunLock(findRun(args[0])),null,2));}
else if(cmd==="approve"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>{const m=loadManifest(d);if(m.state!=="awaiting_approval")throw new Error(`cannot approve from ${m.state}`);return transition(d,"approved","human phase-A approval");})));}
else if(cmd==="plan"){const note=flag("--note");if(args.includes("--note")&&(!note||note.startsWith("--")))throw new Error("--note requires a local repair-note file");console.log(JSON.stringify(await mutateRun(args[0],async(d)=>{await plan(d,{operatorNote:note?readText(note):""});return loadManifest(d);})));}
else if(cmd==="produce"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>{await produceScripts(d);return loadManifest(d);})));}
else if(cmd==="review"){const note=flag("--note");console.log(JSON.stringify(await mutateRun(args[0],d=>reviewScripts(d,{operatorNote:note?readText(note):""}))));}
else if(cmd==="repair"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>applyRepair(d))));}
else if(cmd==="run"||cmd==="resume"){const d=findRun(args[0]);await withRunLock(d,async()=>{await runProduction(d,undefined,{lock:false});if(loadManifest(d).state==="ready_to_deliver")await deliverUnlocked(d);});console.log(JSON.stringify(loadManifest(d)));}
else if(cmd==="storyboard"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>{await produceStoryboards(d);return loadManifest(d);})));}
else if(cmd==="storyboard-review"){const note=flag("--note");console.log(JSON.stringify(await mutateRun(args[0],d=>reviewStoryboards(d,{operatorNote:note?readText(note):""}))));}
else if(cmd==="approve-delivery"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>{const m=loadManifest(d);if(m.state!=="awaiting_delivery_approval")throw new Error(`cannot approve delivery from ${m.state}`);return transition(d,"ready_to_deliver","human final delivery approval");})));}
else if(cmd==="return"){console.log(JSON.stringify(await mutateRun(args[0],async(d)=>transition(d,"returned",args.slice(1).join(" ")))));}
else if(cmd==="accept-corrections"){if(!args[1])throw new Error("accept-corrections requires an independently reviewed corrections JSON file");console.log(JSON.stringify(await mutateRun(args[0],async(d)=>{const m=loadManifest(d);if(!["ready_to_deliver","delivered"].includes(m.state))throw new Error(`cannot register delivery corrections from ${m.state}`);const baseMarkdown=markdownDelivery(d,{includeReviewedRepairs:false});const result=registerReviewedRepairs(d,args[1],{baseMarkdown,sourceRunId:m.id});return {id:m.id,state:m.state,registeredCorrections:path.join(d,"reviewed-repairs.json"),appliedCells:result.appliedCells,affectedEpisodes:result.affectedEpisodes,pendingSourceFindingIds:result.pendingSourceFindingIds};})));}
else if(cmd==="deliver"){const d=findRun(args[0]);console.log(JSON.stringify(await withRunLock(d,()=>deliverUnlocked(d))));}
else help(); } catch(e){console.error(`error: ${e.message}`);process.exitCode=1;}
