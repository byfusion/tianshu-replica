import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { mapConcurrent } from "../src/concurrency.mjs";

test("bounded map runs eight independent workers and preserves input order", async () => {
  const items = Array.from({ length: 12 }, (_, index) => index);
  const gates = items.map(() => Promise.withResolvers());
  const started = [];
  let active = 0, maximum = 0;
  const result = mapConcurrent(items, 8, async (item, index) => {
    assert.equal(item, index);
    started.push(item); active++; maximum = Math.max(maximum, active);
    await gates[index].promise;
    active--;
    return item * 10;
  });
  await setImmediate();
  assert.deepEqual(started, items.slice(0, 8));
  gates[5].resolve();
  await setImmediate();
  assert.deepEqual(started, items.slice(0, 9));
  gates[1].resolve();
  await setImmediate();
  assert.deepEqual(started, items.slice(0, 10));
  for (const gate of gates) gate.resolve();
  assert.deepEqual(await result, items.map((item) => item * 10));
  assert.equal(maximum, 8);
  assert.equal(active, 0);
});

test("failure stops dispatch and waits for already running work", async () => {
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  const failure = new Error("first worker failed"), started = [];
  let settled = false, secondCompleted = false;
  const result = mapConcurrent([0, 1, 2, 3], 2, async (item) => {
    started.push(item);
    if (item === 0) return first.promise;
    await second.promise;
    secondCompleted = true;
  });
  const observed = result.then(() => { settled = true; }, () => { settled = true; });
  first.reject(failure);
  await setImmediate();
  assert.deepEqual(started, [0, 1]);
  assert.equal(settled, false);
  second.resolve();
  await assert.rejects(result, (error) => error === failure);
  await observed;
  assert.equal(secondCompleted, true);
  assert.deepEqual(started, [0, 1]);
});
