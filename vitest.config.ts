import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * One file at a time, deliberately.
     *
     * tests/tools/mutate.test.ts drives the mutation harness, which
     * writes deliberately broken code into lib/train and restores it.
     * Running that beside anything which reads the same files is a race
     * with two losing outcomes, and both happened: tests/train/build.test.ts
     * rebuilt the shipped tile from mutated source and left
     * `if (!entry && entry.off)` staged for commit, and once it stopped
     * writing it began failing at random instead, bundling a mutated
     * source to compare against a correct tile.
     *
     * It also halves peak load, which matters because the harness spawns
     * a vitest of its own per mutation.
     *
     * Cost: about 87s to about 172s for the full suite. That is the price
     * of a gate that cannot produce a poisoned artefact or a flaky red.
     */
    fileParallelism: false,
  },
})
