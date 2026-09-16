import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const codeRoot = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const cli = path.join(codeRoot, "bin", "tianshu.mjs");
const worker = path.join(codeRoot, "bin", "tianshu-worker.mjs");

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tianshu-shared-workflow-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, "source files");
  fs.mkdirSync(cwd);
  const brief = "保留原剧的事件顺序与身份未知项。";
  const outline = "## 第1集\n林夏发现钥匙失踪。\n## 第2集\n周舟交还钥匙。\n## 第3集\n门外来客的身份仍然未知。\n";
  fs.writeFileSync(path.join(cwd, "brief.txt"), brief);
  fs.writeFileSync(path.join(cwd, "source.md"), outline);
  const env = {
    PATH: process.env.PATH || "",
    LANG: "en_US.UTF-8",
    PI_CODING_AGENT_DIR: path.join(directory, "no-model-credentials"),
  };
  const invoke = (entry, args, extraEnv = {}) => spawnSync(process.execPath, [entry, ...args], {
    cwd, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 30_000,
  });
  return { directory, cwd, brief, outline, invoke };
}

function successful(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function seedRun(root, id, state, title = id) {
  const directory = path.join(root, "runs", id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ id, title, state, episodes: 30 }));
  return directory;
}

test("shared CLI initializes an external data root and queues it without copying code", (t) => {
  const f = fixture(t), dataRoot = path.join(f.directory, "external run data");
  const ignoredRoot = path.join(f.directory, "ignored environment root");
  const env = { TIANSHU_ROOT: ignoredRoot };
  assert.equal(fs.existsSync(dataRoot), false);
  const created = successful(f.invoke(cli, ["--root", dataRoot, "init", "brief.txt", "--title", "共享入口三集验证", "--episodes", "3", "--source-outline", "source.md"], env));
  assert.equal(created.state, "draft");
  assert.equal(created.productionRoute, "tianshu-replication");
  const run = path.join(dataRoot, "runs", created.id);
  assert.equal(fs.readFileSync(path.join(run, "canonical", "input.md"), "utf8").trimEnd(), f.brief);
  assert.equal(fs.readFileSync(path.join(run, "canonical", "source-outline.md"), "utf8").trimEnd(), f.outline.trimEnd());
  const status = successful(f.invoke(cli, ["status", created.id, "--root", dataRoot], env));
  assert.equal(status.id, created.id);
  assert.equal(status.episodes, 3);
  assert.equal(successful(f.invoke(worker, ["enqueue", created.id, "--root", dataRoot], env)).enqueued, true);
  const queue = successful(f.invoke(worker, ["--root", dataRoot, "status"], env));
  assert.equal(queue.root, dataRoot);
  assert.deepEqual(queue.jobs.map(({ runId, state }) => ({ runId, state })), [{ runId: created.id, state: "queued" }]);
  assert.deepEqual(fs.readdirSync(dataRoot).sort(), [".queue", "runs"]);
  assert.equal(fs.existsSync(ignoredRoot), false);
});

test("TIANSHU_ROOT alone selects data for both CLI and worker relative to the caller", (t) => {
  const f = fixture(t), env = { TIANSHU_ROOT: "environment data" };
  const dataRoot = path.join(f.cwd, env.TIANSHU_ROOT);
  const created = successful(f.invoke(cli, ["init", "brief.txt", "--title", "环境变量入口验证"], env));
  assert.equal(successful(f.invoke(cli, ["status", created.id], env)).id, created.id);
  assert.equal(successful(f.invoke(worker, ["enqueue", created.id], env)).enqueued, true);
  const queue = successful(f.invoke(worker, ["status"], env));
  assert.equal(queue.root, dataRoot);
  assert.deepEqual(queue.jobs.map(({ runId }) => runId), [created.id]);
  assert.deepEqual(fs.readdirSync(dataRoot).sort(), [".queue", "runs"]);
});

test("shared code keeps two external run roots and their queues separate", (t) => {
  const f = fixture(t), roots = [path.join(f.directory, "first data"), path.join(f.directory, "second data")];
  const id = "same-run-id";
  for (const [index, root] of roots.entries()) seedRun(root, id, "awaiting_approval", `project-${index}`);
  for (const [index, root] of roots.entries()) {
    assert.equal(successful(f.invoke(cli, ["status", id, "--root", root])).title, `project-${index}`);
  }
  successful(f.invoke(worker, ["--root", roots[0], "enqueue", id]));
  assert.deepEqual(successful(f.invoke(worker, ["status", "--root", roots[1]])).jobs, []);
  successful(f.invoke(worker, ["enqueue", id, "--root", roots[1]]));
  for (const root of roots) {
    const queue = successful(f.invoke(worker, ["status", "--root", root]));
    assert.equal(queue.root, root);
    assert.deepEqual(queue.jobs.map(({ runId }) => runId), [id]);
  }
});

test("omitting data-root options preserves the repository default without creating a run", (t) => {
  const f = fixture(t), id = `missing-readonly-run-${process.pid}-${Date.now()}`;
  const manifest = path.join(codeRoot, "runs", id, "manifest.json");
  assert.equal(fs.existsSync(manifest), false);
  const result = f.invoke(cli, ["status", id]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.ok(result.stderr.includes(manifest), result.stderr);
  assert.equal(successful(f.invoke(worker, ["status"])).root, codeRoot);
  assert.equal(fs.existsSync(manifest), false);
});

test("worker starts the shared CLI for an external run and reaches its local delivery gate", (t) => {
  const f = fixture(t), dataRoot = path.join(f.directory, "delivery data");
  const id = "incomplete-delivery", run = seedRun(dataRoot, id, "ready_to_deliver");
  // Local delivery must also work for legacy output with no future-model
  // binding and no credentials; the native gate still checks the real files.
  const ignoredRoot = path.join(f.directory, "wrong inherited data");
  const env = { TIANSHU_ROOT: ignoredRoot };
  successful(f.invoke(worker, ["--root", dataRoot, "enqueue", id], env));
  const result = f.invoke(worker, ["once", "--root", dataRoot], env);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing market contract/);
  assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Cannot find module/);
  const completed = JSON.parse(result.stdout);
  assert.equal(completed.processed, true);
  assert.equal(completed.action, "deliver");
  assert.equal(completed.job.state, "failed");
  assert.equal(completed.job.attempts, 1);
  assert.match(completed.job.error, /CLI deliver failed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, "manifest.json"), "utf8")).state, "ready_to_deliver");
  assert.equal(fs.existsSync(path.join(run, ".lock")), false);
  assert.equal(fs.existsSync(path.join(dataRoot, ".queue", "worker.lock")), false);
  assert.equal(fs.existsSync(ignoredRoot), false);
  assert.deepEqual(fs.readdirSync(dataRoot).sort(), [".queue", "runs"]);
});
