import assert from "node:assert/strict";
import test from "node:test";
import { STATES } from "../src/core.mjs";
import { deliverUnlocked } from "../src/delivery.mjs";

function deliveryOperations(state, failAt, calls) {
  const check = (stage) => {
    calls.push(stage);
    if (stage === failAt) throw new Error(`${stage} rejected current artifacts`);
    return {};
  };
  return {
    loadManifest: () => ({ state }),
    deliveryGate: () => check("gate"),
    markdownDelivery: () => check("markdown"),
    writeText: () => assert.fail("must not replace Markdown before checks pass"),
    execFileSync: () => assert.fail("must not render Word before checks pass"),
    writeJson: () => assert.fail("must not replace delivery metadata before checks pass"),
    transition: () => assert.fail("must not change state before checks pass"),
  };
}

test("initial delivery and explicit redelivery both recheck current artifacts before replacing outputs", async () => {
  for (const state of ["ready_to_deliver", "delivered"]) {
    for (const failAt of ["gate", "markdown"]) {
      const calls = [];
      await assert.rejects(
        deliverUnlocked("unused-run", deliveryOperations(state, failAt, calls)),
        new RegExp(`${failAt} rejected current artifacts`),
      );
      assert.deepEqual(calls, failAt === "gate" ? ["gate"] : ["gate", "markdown"]);
    }
  }
});

test("explicit delivery rejects all other production states before running the gate", async () => {
  for (const state of STATES) {
    if (["ready_to_deliver", "delivered"].includes(state)) continue;
    const calls = [];
    await assert.rejects(
      deliverUnlocked("unused-run", deliveryOperations(state, "gate", calls)),
      new RegExp(`cannot deliver from ${state}`),
    );
    assert.deepEqual(calls, []);
  }
});
