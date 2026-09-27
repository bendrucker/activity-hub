export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      const item = items[index];
      if (item === undefined) {
        throw new Error(`no work at index ${index}`);
      }
      // Awaiting here is the bound itself: a worker takes the next index
      // only once its current item settles, so `limit` items are ever in
      // flight. Promise.all over the items deletes the cap.
      // oxlint-disable-next-line no-await-in-loop
      results[index] = await run(item);
    }
  });

  await Promise.all(workers);
  return results;
}
