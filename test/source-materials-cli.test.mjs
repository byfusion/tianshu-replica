import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "bin", "tianshu.mjs");
const invoke = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", timeout: 30_000 });
function fixture(t, episodes = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-materials-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const materials = {
    creative: "# 创意\n店主守住旧店的钥匙。依据：第1集。",
    characters: "# 人物小传\n林夏是店主；周舟是修理师，双方家庭关系未知。依据：第1集。",
    outline: "## 第1集\n林夏发现钥匙丢失。\n## 第2集\n周舟交还钥匙，门外出现陌生人。\n## 第3集\n倒叙到一小时前；陌生人身份未知。\n",
    provenance: { evidenceType: "synthetic-text-test", directVideoUnderstanding: false },
  };
  if (episodes !== 3) materials.outline = Array.from({ length: episodes }, (_, index) => `## 第${index + 1}集\n第${index + 1}集的源事件与集尾状态。`).join("\n\n");
  const input = path.join(dir, "brief.txt"), packet = path.join(dir, "materials.json"), source = path.join(dir, "source.md");
  fs.writeFileSync(input, "本地合成三集验证，保留身份未知和倒叙。");
  fs.writeFileSync(packet, JSON.stringify(materials));
  fs.writeFileSync(source, materials.outline);
  return { dir, input, packet, source, materials };
}

test("CLI triad preview is read-only and distinguishes textual evidence from video", (t) => {
  const f = fixture(t), before = fs.readdirSync(f.dir);
  const result = invoke(["extract-source", f.source, "--episodes", "3", "--preview"]);
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.deepEqual(preview.plannedMaterials, ["creative", "characters", "outline"]);
  assert.equal(preview.modelRequestSent, false);
  assert.equal(preview.directVideoUnderstanding, false);
  assert.equal(preview.selectedEpisodes.length, 3);
  assert.deepEqual(fs.readdirSync(f.dir), before);
});

test("CLI initializes all three source materials and still requires approval", (t) => {
  const f = fixture(t);
  const result = invoke(["init", f.input, "--title", "三材料CLI离线验证", "--sample", "--source-materials", f.packet]);
  assert.equal(result.status, 0, result.stderr);
  const created = JSON.parse(result.stdout), run = path.join(root, "runs", created.id);
  t.after(() => fs.rmSync(run, { recursive: true, force: true }));
  assert.equal(created.state, "draft");
  assert.equal(created.productionRoute, "tianshu-replication");
  for (const field of ["creative", "characters", "outline"]) {
    assert.equal(fs.readFileSync(path.join(run, "canonical", `source-${field}.md`), "utf8"), f.materials[field]);
  }
  const refused = invoke(["run", created.id]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /draft/);
  assert.deepEqual(fs.readdirSync(path.join(run, "metrics")), []);
  const conflict = invoke(["init", f.input, "--sample", "--source-materials", f.packet, "--source-outline", f.source]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /not both/);
});

test("CLI infers 32 source episodes independently from the optional output episode reference", (t) => {
  const f = fixture(t, 32);
  for (const [flag, file] of [["--source-materials", f.packet], ["--source-outline", f.source]]) {
    for (const outputEpisodes of [undefined, 53]) {
      const dataRoot = path.join(f.dir, `${flag.slice(2)}-${outputEpisodes ?? "inferred"}`);
      const args = ["--root", dataRoot, "init", f.input, "--title", `源32集CLI验证${flag}`, "--source-episodes", "32", flag, file];
      if (outputEpisodes !== undefined) args.push("--episodes", String(outputEpisodes));
      const result = invoke(args);
      assert.equal(result.status, 0, result.stderr);
      const created = JSON.parse(result.stdout), run = path.join(dataRoot, "runs", created.id);
      assert.equal(created.state, "draft");
      assert.equal(created.productionRoute, "tianshu-replication");
      assert.equal(created.episodes, outputEpisodes ?? 32);
      assert.equal(created.isFullSeries, true);
      assert.deepEqual(created.scope, { kind: "full-series" });
      const manifest = JSON.parse(fs.readFileSync(path.join(run, "manifest.json"), "utf8"));
      assert.equal(manifest.episodes, outputEpisodes ?? 32);
      assert.equal(manifest.sourceEpisodes, 32);
      const outline = fs.readFileSync(path.join(run, "canonical", "source-outline.md"), "utf8");
      assert.equal(outline.trimEnd(), f.materials.outline);
      assert.deepEqual([...outline.matchAll(/^## 第(\d+)集$/gm)].map((match) => Number(match[1])), Array.from({ length: 32 }, (_, index) => index + 1));
      assert.deepEqual(fs.readdirSync(path.join(run, "metrics")), []);
    }
  }
});

test("CLI preserves original and sample counts while refusing incomplete declared source coverage", (t) => {
  const f = fixture(t, 32);
  for (const episodes of [30, 60]) {
    const result = invoke(["init", f.input, "--title", `原创${episodes}集CLI验证`, "--episodes", String(episodes)]);
    assert.equal(result.status, 0, result.stderr);
    const created = JSON.parse(result.stdout), run = path.join(root, "runs", created.id);
    t.after(() => fs.rmSync(run, { recursive: true, force: true }));
    assert.equal(created.productionRoute, "tianshu-original");
    assert.equal(created.episodes, episodes);
  }
  const original = invoke(["init", f.input, "--episodes", "32"]);
  assert.equal(original.status, 1);
  assert.match(original.stderr, /30 or 60/);
  const sampleSource = fixture(t, 3);
  const sample = invoke(["init", f.input, "--sample", "--episodes", "32", "--source-outline", sampleSource.source]);
  assert.equal(sample.status, 1);
  assert.match(sample.stderr, /exactly 3/);
  for (const episodes of ["0", "-1", "1.5", "NaN", "Infinity"]) {
    const result = invoke(["init", f.input, "--episodes", episodes, "--source-outline", f.source]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /episodes.*positive/);
  }
  for (const [flag, file] of [["--source-materials", f.packet], ["--source-outline", f.source]]) {
    const dataRoot = path.join(f.dir, `missing-${flag.slice(2)}`);
    const result = invoke(["--root", dataRoot, "init", f.input, "--episodes", "53", "--source-episodes", "50", flag, file]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /source total|source.*cover|完整覆盖|源.*集/i);
    const runs = path.join(dataRoot, "runs");
    assert.deepEqual(fs.existsSync(runs) ? fs.readdirSync(runs) : [], []);
  }
});

test("CLI video preview inspects only file metadata and never presents it as understanding", (t) => {
  const f = fixture(t), manifest = path.join(f.dir, "videos.json");
  // Deliberately not a decodable video: preview verifies paths/size/order only.
  fs.writeFileSync(path.join(f.dir, "test-only.mp4"), "synthetic transport fixture");
  fs.writeFileSync(manifest, JSON.stringify({ episodes: [{ episode: 1, path: "test-only.mp4" }] }));
  const before = fs.readdirSync(f.dir), result = invoke(["extract-video", manifest, "--preview"]);
  assert.equal(result.status, 0, result.stderr);
  const preview = JSON.parse(result.stdout);
  assert.equal(preview.modelRequestSent, false);
  assert.equal(preview.model, "k3");
  assert.equal(preview.episodes, 1);
  assert.equal(preview.directVideoUnderstanding, undefined);
  assert.deepEqual(fs.readdirSync(f.dir), before);
});
