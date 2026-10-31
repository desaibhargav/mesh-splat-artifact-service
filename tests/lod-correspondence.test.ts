import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";

const execute = promisify(execFile);
it("uses library nearest-centre decoding with coincident points and rejects nonfinite geometry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lod-map-test-"));
  const fine = new Float32Array([0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 100, 0, 0]);
  const coarse = new Float32Array([0, 0, 0, 2, 0, 0, 100, 0, 0]);
  try {
    const input = join(directory, "fine.bin"), second = join(directory, "coarse.bin"), config = join(directory, "config.json");
    await writeFile(input, new Uint8Array(fine.buffer));
    await writeFile(second, new Uint8Array(coarse.buffer));
    await writeFile(config, JSON.stringify({ inputs: [input, second], output: join(directory, "editing") }));
    await execute("python3", [resolve("scripts/lod-correspondence.py"), config]);
    const values = gunzipSync(await readFile(join(directory, "editing/to-1.bin.gz")));
    const indices = Array.from({ length: values.length / 4 }, (_, index) => values.readUInt32LE(index * 4));
    expect(indices).toHaveLength(5);
    expect(indices.map((value, index) => Math.abs(coarse[value * 3]! - fine[index * 3]!))).toEqual([0, 0, 1, 0, 0]);
    expect(gunzipSync(await readFile(join(directory, "editing/centers.bin.gz"))))
      .toEqual(Buffer.from(fine.buffer));
    await expect(readFile(join(directory, "editing/to-0.bin.gz"))).rejects.toThrow();
    fine[0] = NaN; await writeFile(input, new Uint8Array(fine.buffer));
    await expect(execute("python3", [resolve("scripts/lod-correspondence.py"), config])).rejects.toThrow("finite xyz");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
