import assert from "node:assert/strict";
import { createVitest } from "vitest/node";

// Use the runner's discovered specifications and configured sequencer. CLI
// `list --shard` returns the full list on Vitest 5.0.4.
const vitest = await createVitest({ config: "vitest.config.node.ts", watch: false });
try {
  const files = await vitest.globTestSpecifications();
  assert(files.length > 0, "Node test discovery must not be empty");
  const key = (file) => `${file.project.name}:${file.moduleId}`;
  const expected = new Set(files.map(key));
  assert.equal(expected.size, files.length, "Duplicate discovered Node files");
  const seen = new Set();
  const Sequencer = vitest.config.sequence.sequencer;
  const sequencer = new Sequencer(vitest);
  for (let index = 1; index <= 2; index++) {
    vitest.config.shard = { index, count: 2 };
    const shard = await sequencer.shard([...files]);
    assert(shard.length > 0, `Shard ${index} must not be empty`);
    for (const file of shard) {
      const id = key(file);
      assert(expected.has(id), `Unknown file in shard ${index}: ${id}`);
      assert(!seen.has(id), `Duplicate shard membership: ${id}`);
      seen.add(id);
    }
    console.log(`Node shard ${index}/2: ${shard.length} files`);
  }
  assert.deepEqual(seen, expected, "Every Node file must belong to exactly one shard");
  console.log(`Verified ${seen.size} Node files, no missing or duplicate membership`);
} finally {
  await vitest.close();
}
