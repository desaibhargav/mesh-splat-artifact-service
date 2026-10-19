import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChunkDataPool, MemoryReadFileSystem, readFileInfo, readPly } from "@playcanvas/splat-transform";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recoverPly } from "../scripts/ply-recovery.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ply-recovery-test-")); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
const properties = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];

async function fixture(declared: number, actual: number, trailing = 0, newline = "\n") {
  const header = ["ply", "format binary_little_endian 1.0", `element vertex ${declared}`,
    ...properties.map(name => `property float ${name}`), "end_header", ""].join(newline);
  const payload = Buffer.alloc(actual * properties.length * 4 + trailing);
  for (let i = 0; i < actual; i++) payload.writeFloatLE(i + 1, i * properties.length * 4);
  const bytes = Buffer.concat([Buffer.from(header), payload]);
  const input = join(root, "source.ply"), output = join(root, "recovered.ply");
  await writeFile(input, bytes);
  return { input, output, bytes, header, payload };
}

it("passes valid PLY and non-PLY sources through without copying or warning", async () => {
  const f = await fixture(2, 2);
  expect(await recoverPly(f.input, f.output)).toEqual({ input: f.input });
  expect(await recoverPly(join(root, "meta.json"), f.output)).toEqual({ input: join(root, "meta.json") });
  await expect(readFile(f.output)).rejects.toMatchObject({ code: "ENOENT" });
  expect(console.warn).not.toHaveBeenCalled();
});

it.each(["\n", "\r\n"])("recovers complete records, preserves master/payload, and loads with PlayCanvas (%j)", async newline => {
  const f = await fixture(10, 3, 7, newline);
  const result = await recoverPly(f.input, f.output);
  expect(result.recovery).toMatchObject({ declaredVertices: 10, recoveredVertices: 3, recordBytes: 56, discardedBytes: 7 });
  expect(await readFile(f.input)).toEqual(f.bytes);
  const bytes = await readFile(result.input);
  expect(bytes).toEqual(Buffer.concat([Buffer.from(f.header.replace(/\r\n/g, "\n").replace("vertex 10", "vertex 3")), f.payload.subarray(0, 3 * 56)]));
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Data may be incomplete"));
  const fs = new MemoryReadFileSystem(), pool = createChunkDataPool(); fs.set("recovered.ply", bytes);
  const source = await readPly(await fs.createSource("recovered.ply"), pool);
  try {
    expect(source.meta.numGaussians).toBe(3);
    const data = pool.acquire("position", source.meta.layouts.position!, 3);
    try { await source.read({ chunkIndex: 0, position: data }); expect(new Float32Array(data.data)[0]).toBe(1); }
    finally { data.release(); }
  } finally { await source.close(); pool.destroy(); }
});

it("corrects an underreported count using all complete records", async () => {
  const f = await fixture(1, 3);
  expect((await recoverPly(f.input, f.output)).recovery).toMatchObject({ declaredVertices: 1, recoveredVertices: 3, discardedBytes: 0 });
});

it("fails when no complete record remains and never overwrites an existing file", async () => {
  const empty = await fixture(2, 0, 7);
  await expect(recoverPly(empty.input, empty.output)).rejects.toThrow("no complete vertex records");
  const f = await fixture(2, 1);
  await writeFile(f.output, "existing");
  await expect(recoverPly(f.input, f.output)).rejects.toMatchObject({ code: "EEXIST" });
  expect(await readFile(f.output, "utf8")).toBe("existing");
});

it("leaves compressed, list-valued, ASCII, and multi-element layouts to the native loader", async () => {
  const f = await fixture(2, 1);
  for (const header of [
    f.header.replace("property float x", "property uint packed_position"),
    f.header.replace("property float x", "property list uchar float x"),
    f.header.replace("binary_little_endian", "ascii"),
    f.header.replace("end_header", "element face 1\nproperty list uchar int vertex_indices\nend_header")
  ]) {
    await writeFile(f.input, Buffer.concat([Buffer.from(header), f.payload]));
    expect(await recoverPly(f.input, f.output)).toEqual({ input: f.input });
  }
  expect(console.warn).not.toHaveBeenCalled();
});

it("rejects an incomplete header", async () => {
  const input = join(root, "broken.ply"); await writeFile(input, "ply\nformat binary_little_endian 1.0\n");
  await expect(recoverPly(input, join(root, "output.ply"))).rejects.toThrow("missing complete end_header");
});

it("derives record width from mixed scalar properties rather than a fixed GS schema", async () => {
  const f = await fixture(8, 1);
  const header = f.header.replace("end_header", "property uchar flag\nproperty short label\nproperty double confidence\nend_header");
  const stride = properties.length * 4 + 1 + 2 + 8;
  const payload = Buffer.alloc(3 * stride + 3);
  await writeFile(f.input, Buffer.concat([Buffer.from(header), payload]));
  expect((await recoverPly(f.input, f.output)).recovery).toMatchObject({ recordBytes: stride, recoveredVertices: 3, discardedBytes: 3 });
  expect((await readFile(f.output)).subarray(-3 * stride)).toEqual(payload.subarray(0, 3 * stride));
});

it("accepts ordinary header spacing and rewrites the parsed vertex declaration", async () => {
  const f = await fixture(10, 3);
  const header = f.header.replace("format binary_little_endian 1.0", "format   binary_little_endian  1.0")
    .replace("element vertex 10", "element   vertex   10").replaceAll("property float", "property  float");
  await writeFile(f.input, Buffer.concat([Buffer.from(header), f.payload]));
  const result = await recoverPly(f.input, f.output);
  expect(result.recovery?.recoveredVertices).toBe(3);
  const fs = new MemoryReadFileSystem(), pool = createChunkDataPool();
  fs.set("recovered.ply", await readFile(result.input));
  const source = await readPly(await fs.createSource("recovered.ply"), pool);
  try { expect(source.meta.numGaussians).toBe(3); }
  finally { await source.close(); pool.destroy(); }
});

it("does not rewrite malformed element or property declarations", async () => {
  const f = await fixture(10, 3);
  for (const header of [f.header.replace("vertex 10", "vertex 10 extra"),
    f.header.replace("property float x", "property float x extra"),
    f.header.replace("property float x", "property constructor x")]) {
    await writeFile(f.input, Buffer.concat([Buffer.from(header), f.payload]));
    expect(await recoverPly(f.input, f.output)).toEqual({ input: f.input });
  }
  expect(console.warn).not.toHaveBeenCalled();
});

it("keeps native validation: public metadata reads reject the source and accept the recovered copy", async () => {
  const f = await fixture(10, 3);
  const fs = new MemoryReadFileSystem(); fs.set("source.ply", f.bytes);
  await expect(readFileInfo({ filename: "source.ply", inputFormat: "ply", fileSystem: fs })).rejects.toThrow("header-implied");
  const result = await recoverPly(f.input, f.output);
  fs.set("recovered.ply", await readFile(result.input));
  expect(await readFileInfo({ filename: "recovered.ply", inputFormat: "ply", fileSystem: fs }))
    .toMatchObject({ numGaussians: 3, gaussian: true });
});
