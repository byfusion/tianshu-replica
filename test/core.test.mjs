import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { STORYBOARD_HEADER, checkStoryboard, createRun, loadManifest, markdownDelivery, renderDeliveryMarkdown, sha, storyboardWarnings, writeJson, writeText } from "../src/core.mjs";
import { markStale, repairPlan } from "../src/review.mjs";
import { applyRepair, nextContinuityRepairAttempt, planningWatchdogMs, routeContinuityRejectToWriter, screenplayChecks } from "../src/agents.mjs";
import { inferMarketIntent, marketChecks, validateMarketSubmission } from "../src/market.mjs";
import { canonicalPersonNames } from "../src/entities.mjs";
import { loadProductionContract, productionContractDigest } from "../src/production-contract.mjs";
import { stageArtifactDigest } from "../src/semantic-review.mjs";
import { marketArtifactDigest } from "../src/market.mjs";

function board(ep=1) {
  const rows=[];
  for(let i=1;i<=12;i++){const id=`ep${String(ep).padStart(2,"0")}-s${String(i).padStart(2,"0")}`;rows.push(`| ${id} | 画面 ${i} | 中：台词<br>EN: line | 固定机位 / 中景 | 人物：A<br>场景：S | 音效：环境声<br>功能：${i%3===0?"情绪停留":"对峙"} | 8 |`);}
  return `# 第${ep}集\n\n| ${STORYBOARD_HEADER.join(' | ')} |\n|${STORYBOARD_HEADER.map(()=> '---').join('|')}|\n${rows.join('\n')}`;
}
function boardWithDurations(durations, episode=1) {
  let index=0;
  return board(episode).replace(/\| 8 \|$/gm,()=>`| ${durations[index++]} |`);
}
test('storyboard contract accepts a complete table', () => assert.deepEqual(checkStoryboard(board()), []));
test('storyboard duration contract accepts 90 and 100 seconds and rejects 101', () => {
  assert.deepEqual(checkStoryboard(boardWithDurations([8,8,8,8,8,8,7,7,7,7,7,7])),[]);
  assert.deepEqual(checkStoryboard(boardWithDurations([9,9,9,9,8,8,8,8,8,8,8,8])),[]);
  assert.ok(checkStoryboard(boardWithDurations([9,9,9,9,9,8,8,8,8,8,8,8])).some((error)=>error.includes('total duration 101')));
});
test('storyboard contract rejects a missing fixed header', () => assert.ok(checkStoryboard('| 镜头号 |\n|---|\n|1|').length));
test('storyboard warnings flag a board with no reaction beat', () => {
  const flat=board().replaceAll("情绪停留","对峙");
  assert.ok(storyboardWarnings(flat).some((w)=>w.includes("反应")));
  assert.deepEqual(storyboardWarnings(board()), []);
});
test('repair plan blocks upstream and expands pair repairs', () => {
  assert.equal(repairPlan([{episode:3,severity:'P1',scope:'pair'}], 5).episodes.join(','), '3,4');
  assert.equal(repairPlan([{episode:3,severity:'P0',scope:'local'}], 5).action, 'blocked');
});
test('stale propagation invalidates dependent tasks', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tianshu-test-'));
  const {dir}=createRun(root,{title:'测试',episodes:30,input:'x'});
  const stale=markStale(dir,[3]);
  assert.deepEqual(stale,['screenplay-ep-04','storyboard-ep-03','storyboard-ep-04']);
  assert.equal(loadManifest(dir).episodes,30);
});
test('applyRepair routes storyboard findings back to the Storyboard Agent task', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tianshu-test-'));
  const {dir}=createRun(root,{title:'测试',episodes:30,input:'x'});
  writeJson(path.join(dir,'canonical','market.json'),{country:'United States',anchors:['美国'],bannedContext:[]});writeText(path.join(dir,'canonical','market-contract.md'),'美国市场');
  for(let episode=1;episode<=30;episode++){writeText(path.join(dir,'screenplay',`ep-${String(episode).padStart(2,'0')}.md`),`# 第${episode}集`);writeText(path.join(dir,'storyboard',`ep-${String(episode).padStart(2,'0')}.md`),board(episode));}
  const contractDigest=productionContractDigest(loadProductionContract(dir));
  const finding={id:'pace-ep03',stage:'storyboard',episode:3,severity:'P1',scope:'local',category:'pace',evidence:'EP03 opening is static',reason:'No cold open',acceptance:'Conflict visible by second 3',repairInstruction:'Open on the conflict',preserve:['plot'],doNotChange:['screenplay'],disposition:'repair'};
  const plan={stage:'storyboard',action:'repair',cycle:1,artifactDigest:stageArtifactDigest(dir,'storyboard'),contractDigest,episodes:[3],findings:[finding]};
  const result=applyRepair(dir,{plan,marketDigest:marketArtifactDigest(dir)});
  assert.ok(result.stale.includes('storyboard-ep-03'));
  const task=JSON.parse(fs.readFileSync(path.join(dir,'tasks','storyboard-ep-03.json')));
  assert.equal(task.state,'stale');
  assert.match(task.repairInstruction,/Open on the conflict/);
  assert.match(task.repairInstruction,/不得改动：screenplay/);
});
test('continuity rejection becomes a durable bounded Writer repair task across resume', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tianshu-continuity-route-')),{dir}=createRun(root,{title:'连续性路由',episodes:30,input:'x'}),taskFile=path.join(dir,'tasks','screenplay-ep-03.json'),error=Object.assign(new Error('rejected'),{code:'CONTINUITY_REJECTED',review:{reason:'钥匙状态冲突'}});routeContinuityRejectToWriter(dir,{episode:3,error,taskFile,attempt:1,maxAttempts:2});const task=JSON.parse(fs.readFileSync(taskFile));assert.equal(task.state,'stale');assert.match(task.repairInstruction,/钥匙状态冲突/);assert.match(task.repairInstruction,/大纲规定的事件在正文漏写，应补回正文/);assert.match(task.repairInstruction,/不得为了通过连续性检查将其删掉、推迟到后集或标成未发生/);assert.equal(nextContinuityRepairAttempt(JSON.parse(fs.readFileSync(taskFile))),2);routeContinuityRejectToWriter(dir,{episode:3,error,taskFile,prior:task,attempt:2,maxAttempts:2});const resumed=JSON.parse(fs.readFileSync(taskFile));assert.equal(nextContinuityRepairAttempt(resumed),3);assert.throws(()=>routeContinuityRejectToWriter(dir,{episode:3,error,taskFile,prior:resumed,attempt:3,maxAttempts:2}),/rejected/);assert.equal(loadManifest(dir).state,'needs_human_review');
});
test('delivery requires every checked storyboard', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'tianshu-test-'));
  const {dir}=createRun(root,{title:'测试',episodes:30,input:'x'});
  const contractDigest=productionContractDigest(loadProductionContract(dir));
  writeText(path.join(dir,'canonical','characters.md'),'A (30): lead.');writeJson(path.join(dir,'canonical','ledger.json'),{names:['A'],facts:['x','y','z']});writeText(path.join(dir,'canonical','market-contract.md'),'US market');
  for(let ep=1;ep<=30;ep++){const screenplay=`# 第${ep}集｜已审核集名${ep}`;const storyboard=board(ep);writeText(path.join(dir,'screenplay',`ep-${String(ep).padStart(2,'0')}.md`),screenplay);writeText(path.join(dir,'storyboard',`ep-${String(ep).padStart(2,'0')}.md`),storyboard);writeJson(path.join(dir,'tasks',`storyboard-ep-${String(ep).padStart(2,'0')}.json`),{state:'passed',digest:sha(`${storyboard.trimEnd()}\n`),contractDigest,sourceScreenplayDigest:sha(`${screenplay}\n`)});}
  assert.ok(markdownDelivery(dir).includes('# 第 30 集｜已审核集名30'));
});
test('delivery headings normalize suffixes and preserve all prose and table bytes', () => {
  const manifest = { episodes: 32 };
  const header = `| ${STORYBOARD_HEADER.join(' | ')} |\r\n|${STORYBOARD_HEADER.map(()=>'---').join('|')}|`;
  const body = `\r\n\r\n创作设定：保留此处。\r\n\r\n## 制作说明\r\n原有说明。\r\n${header}\r\n| ep10-s01 | 画面 | 中：台词<br>EN: line | 运镜 | 人物 | 连续性 | 8 |\r\n`;
  const summary = '交付统计：共 1 集、1 镜；镜头合计 8 秒；单集范围 8–8 秒，平均 8 秒。\r\n\r\n';
  for (const heading of ['# 第10集｜需要一把椅子证明的王冠 分镜表', '## 第 10 集 | 需要一把椅子证明的王冠 · 分镜表', '# 第10集｜需要一把椅子证明的王冠｜分镜剧本', '# 第10集｜需要一把椅子证明的王冠']) {
    const result = renderDeliveryMarkdown(manifest, [`${heading}${body}`], ['# 第10集｜不替代已有集名']);
    assert.equal(result, `${summary}# 第 10 集｜需要一把椅子证明的王冠｜预计 8 秒${body}`);
    assert.equal(renderDeliveryMarkdown(manifest, [result]), result);
  }
  assert.equal(renderDeliveryMarkdown(manifest, [`# 第10集｜开场（172.0s）${body}`]), `${summary}# 第 10 集｜开场｜预计 8 秒${body}`);
});
test('delivery headings recover generic and missing titles from the same episode screenplay', () => {
  const manifest = { episodes: 32 };
  const header = `| ${STORYBOARD_HEADER.join(' | ')} |\n|${STORYBOARD_HEADER.map(()=>'---').join('|')}|`;
  const body = `\n\n创作设定保留。\n${header}\n| ep21-s01 | 画面 | 中：台词<br>EN: line | 运镜 | 人物 | 连续性 | 8 |\n`;
  const summary = '交付统计：共 1 集、1 镜；镜头合计 8 秒；单集范围 8–8 秒，平均 8 秒。\n\n';
  for (const heading of ['# 分镜剧本', '# 第21集', '# 第21集｜分镜表', '# 第21集｜分镜剧本']) {
    assert.equal(renderDeliveryMarkdown(manifest, [`${heading}${body}`], ['# 第21集｜日翼晶体粉']), `${summary}# 第 21 集｜日翼晶体粉｜预计 8 秒${body}`);
  }
  const missing = body.trimStart();
  assert.equal(renderDeliveryMarkdown(manifest, [missing], ['# 第21集｜日翼晶体粉']), `${summary}# 第 21 集｜日翼晶体粉｜预计 8 秒\n\n${missing}`);
  assert.equal(renderDeliveryMarkdown(manifest, [`# 分镜剧本${body}`], ['# 第22集｜其它集名']), `${summary}# 第 21 集｜预计 8 秒${body}`);
  assert.throws(() => renderDeliveryMarkdown({ episodes: 2 }, ['# 已有集名', '# 分镜表']), /no storyboard tables/);
  assert.throws(() => renderDeliveryMarkdown({ episodes: 1 }, ['# 第41集｜旧稿（172.0s）\n\n| 01 | 画面 |']), /no storyboard tables/);
});
test('US market contract rejects Chinese carryover and requires a US anchor', () => {
  const market=inferMarketIntent('目标受众：美区女性向竖屏短剧');
  assert.equal(market.country, 'United States');
  assert.ok(marketChecks('温家客厅，林晚穿旗袍。', market).length >= 2);
  assert.deepEqual(marketChecks('纽约一家曼哈顿拍卖行里，Maya studies the receipt.', market), []);
});
test('planner market submission must match the requested country', () => {
  const market=inferMarketIntent('目标市场：美国');
  const valid={country:'United States',setting:'New York contemporary auction world',characterNaming:'Natural contemporary American names',socialContext:'US family wealth and auction institutions',culturalAnchors:['New York','estate sale']};
  assert.deepEqual(validateMarketSubmission(market, valid), []);
  assert.ok(validateMarketSubmission(market, {...valid,country:'China'}).length);
});
test('market digest binds both machine-readable and Markdown contracts', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tianshu-market-digest-'));fs.mkdirSync(path.join(dir,'canonical'),{recursive:true});writeJson(path.join(dir,'canonical','market.json'),{country:'United States'});writeText(path.join(dir,'canonical','market-contract.md'),'US');const before=marketArtifactDigest(dir);writeJson(path.join(dir,'canonical','market.json'),{country:'Canada'});assert.notEqual(marketArtifactDigest(dir),before);
});
test('screenplay contract rejects dialogue that cannot fit a 120-second episode', () => {
  const words=Array.from({length:261},()=> 'word').join(' ');
  const screenplay=`# 第1集｜EP01\n\n## 场景一\n\n（EN）${words}\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`;
  assert.ok(screenplayChecks(screenplay,1,{anchors:[],bannedContext:[]}).some((error)=>error.includes('英文对白过长')));
});
test('screenplay duration counts inline English markers after Chinese dialogue', () => {
  const words=Array.from({length:261},()=> 'word').join(' ');
  const screenplay=`# 第1集｜EP01\n\n## 场景一\n\n（中）台词。 (EN) ${words}\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`;
  assert.ok(screenplayChecks(screenplay,1,{anchors:[],bannedContext:[]}).some((error)=>error.includes('英文对白过长')));
});
test('screenplay contract accepts full-width punctuation in paired EN markers', () => {
  const screenplay=`# 第1集｜EP01\n\n## 场景一\n\nMAYA（中）：成交。\nMAYA（EN）：Deal.\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`;
  assert.ok(!screenplayChecks(screenplay,1,{anchors:[],bannedContext:[]}).some((error)=>error.includes('缺少英文台词')));
});
test('screenplay episode identity accepts the standardized delivery heading', () => {
  const screenplay = `# 第1集｜成交\n\n## 场景一\n\nMAYA（中）：成交。\nMAYA（EN）：Deal.\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`;
  const market = { anchors: [], bannedContext: [] };
  assert.deepEqual(screenplayChecks(screenplay, 1, market), []);
  assert.deepEqual(screenplayChecks(screenplay.replace('# 第1集', '# 第 1 集'), 1, market), []);
});
test('fixed-entity contract rejects a known first name with a drifting surname', () => {
  const drifted=board().replace('画面 1','Rowan Hale 走进房间');
  assert.ok(checkStoryboard(drifted,['Rowan Kade']).some((error)=>error.includes('Rowan Hale')));
  assert.ok(screenplayChecks(`# 第1集｜EP01\n\n## 场景一\n\nRowan Hale 出场。\nMAYA（中）：成交。\nMAYA（EN）：Deal.\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`,1,{anchors:[],bannedContext:[]},['Rowan Kade']).some((error)=>error.includes('Rowan Hale')));
  assert.ok(!screenplayChecks(`# 第1集｜EP01\n\n## 场景一\n\nRowan Kade's coat is wet.\nMAYA（中）：成交。\nMAYA（EN）：Deal.\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`,1,{anchors:[],bannedContext:[]},['Rowan Kade']).some((error)=>error.includes('姓名漂移')));
  assert.ok(!screenplayChecks(`# 第1集｜EP01\n\n## 场景一\n\nVale Family Voting Trust.\nMAYA（中）：成交。\nMAYA（EN）：Deal.\n\n${'剧情动作。'.repeat(180)}\n\n## 【本集钩子】\n局面改变。\n\n## 【连续性检查】\n状态已记录。`,1,{anchors:[],bannedContext:[]},['Vale Row']).some((error)=>error.includes('姓名漂移')));
});
test('fixed-entity contract derives people from the character bible, not team or company names', () => {
  assert.deepEqual(canonicalPersonNames('Tessa Ward (31): analyst. Fixed entities: Windsor Foundry.', ['Tessa Ward','Windsor Foundry']),['Tessa Ward']);
});

test('canonical names use shared character-entry prefixes without harvesting annotations or locations', () => {
  const characters = 'Ava Miller（源字幕偶作 eva、Evan）：护理员。\nKael（源字幕偶作 Kyle，待确认）：黑龙王。\nKnox / Nox（同一幼龙，拼写并存）：黑鳞小王子。\nRoyal Palace Baby Care Hall / 育婴殿：场景。\nCradle Holy Seal 摇篮圣印：道具。\n附注提到 Hidden Person (31)，不构成人物条目。';
  const ledgerNames = ['Ava Miller（源字幕偶作 eva、Evan；保留原拼写）', 'Kael（源字幕偶作 Kyle，待确认）', 'Knox / Nox（同一幼龙，黑鳞小王子）', 'Kyle', 'Hidden Person', 'Royal Palace Baby Care Hall / 育婴殿', 'Cradle Holy Seal 摇篮圣印'];
  assert.deepEqual(canonicalPersonNames(characters, ledgerNames), ['Ava Miller', 'Kael', 'Knox', 'Nox']);
});
test('planning over 30 episodes gets the existing longer watchdog while 3 and 30 stay unchanged', () => {
  assert.equal(planningWatchdogMs(3),180_000);
  assert.equal(planningWatchdogMs(30),180_000);
  assert.equal(planningWatchdogMs(32),600_000);
  assert.equal(planningWatchdogMs(60),600_000);
});

test('screenplay scene limit counts English SCENE headings used by the Writer', () => {
  const market = { anchors: [], bannedContext: [] };
  const markdown = Array.from({ length: 5 }, (_, i) => `## SCENE ${i + 1}\n一段动作与对白。`).join('\n');
  assert.ok(screenplayChecks(markdown, 1, market).includes('场景过多 5（上限 4）'));
});

test('screenplay scene limit rejects nine numbered Writer scenes when the contract allows eight', () => {
  const market = { anchors: [], bannedContext: [] };
  const contract = { screenplay: { englishDialogueWordLimit: 1000, maxScenes: 8 } };
  for (const title of ['场', '场 ', '场景', 'SCENE ']) {
    const markdown = Array.from({ length: 9 }, (_, i) => `## ${title}${i + 1}｜场内动作\n一段动作与对白。`).join('\n');
    assert.ok(screenplayChecks(markdown, 9, market, [], contract).includes('场景过多 9（上限 8）'), title);
  }
});

test('screenplay scene limit accepts eight numbered scenes and ignores scene words in body text', () => {
  const markdown = Array.from({ length: 8 }, (_, i) => `## 场${i + 1}｜场内动作\n对白提到场9，场景也在正文中。`).join('\n');
  const errors = screenplayChecks(markdown, 9, { anchors: [], bannedContext: [] }, [], { screenplay: { englishDialogueWordLimit: 1000, maxScenes: 8 } });
  assert.ok(!errors.some((error) => error.startsWith('场景过多')));
});
