export async function mapConcurrent(items, limit, worker) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("concurrency limit must be a positive integer");
  const results = new Array(items.length);
  let next = 0, failed = false, firstError;
  async function runWorker() {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        if (!failed) { failed = true; firstError = error; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runWorker));
  if (failed) throw firstError;
  return results;
}
