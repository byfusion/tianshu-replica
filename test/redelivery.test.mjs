import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { STATES } from "../src/core.mjs";

const cli = fs.readFileSync(new URL("../bin/tianshu.mjs", import.meta.url), "utf8");
const source = cli.match(/^async function deliverUnlocked\(d\).*$/m)[0];

function delivery(state, failAt, calls) {
  const check = (stage) => {
    calls.push(stage);
    if (stage === failAt) throw new Error(`${stage} rejected current artifacts`);
    return {};
  };
  return vm.runInNewContext(`(${source})`, {
    loadManifest: () => ({ state }),
    deliveryGate: () => check("gate"),
    markdownDelivery: () => check("markdown"),
    writeText: () => assert.fail("must not replace Markdown before checks pass"),
    execFileSync: () => assert.fail("must not render Word before checks pass"),
    writeJson: () => assert.fail("must not replace delivery metadata before checks pass"),
    transition: () => assert.fail("must not change state before checks pass"),
  });
}

test("initial delivery and explicit redelivery both recheck current artifacts before replacing outputs", async () => {
  for (const state of ["ready_to_deliver", "delivered"]) {
    for (const failAt of ["gate", "markdown"]) {
      const calls = [];
      await assert.rejects(delivery(state, failAt, calls)("unused-run"), new RegExp(`${failAt} rejected current artifacts`));
      assert.deepEqual(calls, failAt === "gate" ? ["gate"] : ["gate", "markdown"]);
    }
  }
});

test("explicit delivery rejects all other production states before running the gate", async () => {
  for (const state of STATES) {
    if (["ready_to_deliver", "delivered"].includes(state)) continue;
    const calls = [];
    await assert.rejects(delivery(state, "gate", calls)("unused-run"), new RegExp(`cannot deliver from ${state}`));
    assert.deepEqual(calls, []);
  }
});
