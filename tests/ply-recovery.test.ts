import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChunkDataPool, MemoryReadFileSystem, readFileInfo, readPly } from "@playcanvas/splat-transform";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recoverPly } from "../scripts/ply-recovery.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ply-recovery-test-")); vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(async () => {
  vi.restoreAllMocks();
  try { expect((await readdir(root)).filter(name => name.startsWith(".ply-recovery-"))).toEqual([]); }
  finally { await rm(root, { recursive: true, force: true }); }
});
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

it("rejects an incomplete header", async () => {
  const input = join(root, "broken.ply"); await writeFile(input, "ply\nformat binary_little_endian 1.0\n");
  await expect(recoverPly(input, join(root, "output.ply"))).rejects.toThrow("Invalid PLY header");
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
    await expect(recoverPly(f.input, f.output)).rejects.toThrow("Invalid PLY header");
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

async function customFile(header: string, payload: Buffer | string) {
  const input = join(root, "source.ply"), output = join(root, "recovered.ply");
  const bytes = Buffer.concat([Buffer.from(header), Buffer.from(payload)]);
  await writeFile(input, bytes);
  return { input, output, bytes };
}

async function nativeInfo(path: string) {
  const fs = new MemoryReadFileSystem(); fs.set("recovered.ply", await readFile(path));
  return readFileInfo({ filename: "recovered.ply", inputFormat: "ply", fileSystem: fs });
}

it.each(["ascii", "binary_little_endian", "binary_big_endian"])("recovers %s vertices through RPly and converts to native-loadable little-endian", async format => {
  const header = ["ply", `format ${format} 1.0`, "comment preserve this", "obj_info provenance",
    "element vertex 8", ...properties.map(name => `property float ${name}`), "end_header", ""].join("\n");
  const floats = Array.from({ length: properties.length * 3 + 2 }, (_, i) => i + 0.25);
  const binary = Buffer.alloc(floats.length * 4);
  floats.forEach((value, index) => format === "binary_big_endian" ? binary.writeFloatBE(value, index * 4) : binary.writeFloatLE(value, index * 4));
  const f = await customFile(header, format === "ascii" ? `${floats.join(" ")}\n` : binary);
  const result = await recoverPly(f.input, f.output);
  expect(result.recovery).toMatchObject({ declaredVertices: 8, recoveredVertices: 3, decoder: "RPly 1.1.4" });
  const bytes = await readFile(result.input);
  const end = bytes.indexOf("end_header\n") + "end_header\n".length;
  expect(bytes.subarray(0, end).toString()).toContain("format binary_little_endian 1.0");
  expect(bytes.subarray(0, end).toString()).toContain("comment preserve this\ncomment obj_info provenance");
  for (let i = 0; i < properties.length * 3; ++i) expect(bytes.readFloatLE(end + i * 4)).toBe(floats[i]);
  expect(await readFile(f.input)).toEqual(f.bytes);
  expect(await nativeInfo(result.input)).toMatchObject({ numGaussians: 3, gaussian: true });
});

it.each(["ascii", "binary_little_endian", "binary_big_endian"])("recovers complete variable-length lists in multi-element %s files", async format => {
  const header = `ply\nformat ${format} 1.0\nelement vertex 2\nproperty float x\nelement face 3\nproperty list uchar int vertex_indices\nend_header\n`;
  const payload = Buffer.alloc(8 + 1 + 1 + 8 + 1 + 4);
  const writeFloat = (value: number, at: number) => format === "binary_big_endian" ? payload.writeFloatBE(value, at) : payload.writeFloatLE(value, at);
  const writeInt = (value: number, at: number) => format === "binary_big_endian" ? payload.writeInt32BE(value, at) : payload.writeInt32LE(value, at);
  writeFloat(1.25, 0); writeFloat(2.5, 4);
  payload[8] = 0; payload[9] = 2; writeInt(0, 10); writeInt(1, 14);
  payload[18] = 2; writeInt(0, 19); // Missing the second index of the third face.
  const f = await customFile(header, format === "ascii" ? "1.25 2.5\n0\n2 0 1\n2 0\n" : payload);
  const result = await recoverPly(f.input, f.output);
  expect(result.recovery?.elements).toEqual([{ name: "vertex", declared: 2, recovered: 2 }, { name: "face", declared: 3, recovered: 2 }]);
  const bytes = await readFile(result.input);
  const end = bytes.indexOf("end_header\n") + "end_header\n".length;
  expect(bytes.subarray(0, end).toString()).toContain("element face 2");
  expect(bytes.readFloatLE(end)).toBe(1.25);
  expect([...bytes.subarray(end + 8)]).toEqual([0, 2, 0, 0, 0, 0, 1, 0, 0, 0]);
  expect(await recoverPly(result.input, join(root, "again.ply"))).toEqual({ input: result.input });
});

it("handles zero-count blocks and an unvisited block after truncated vertices", async () => {
  const header = "ply\nformat ascii 1.0\nelement edge 0\nproperty int label\nelement vertex 3\nproperty float x\nproperty float y\nelement face 2\nproperty list uchar int vertex_indices\nend_header\n";
  const f = await customFile(header, "1.25 2.5\n3.75\n");
  const result = await recoverPly(f.input, f.output);
  expect(result.recovery?.elements.map(element => element.recovered)).toEqual([0, 1, 0]);
  expect(await recoverPly(result.input, join(root, "again.ply"))).toEqual({ input: result.input });
});

it.each(["1.25", "1.25\n", "1.25\n\n  "])("keeps complete ASCII records unchanged, including EOF without whitespace (%j)", async payload => {
  const f = await customFile("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n", payload);
  expect(await recoverPly(f.input, f.output)).toEqual({ input: f.input });
});

it("recovers underreported ASCII and variable-length single-element counts", async () => {
  const f = await customFile("ply\nformat ascii 1.0\nelement vertex 1\nproperty list uchar int samples\nend_header\n", "0\n2 1 2\n1 3\n");
  const result = await recoverPly(f.input, f.output);
  expect(result.recovery?.recoveredVertices).toBe(3);
  expect(await recoverPly(result.input, join(root, "again.ply"))).toEqual({ input: result.input });
});

it.each([
  "ply\nformat garbage 1.0\nelement vertex 1\nproperty float x\nend_header\n",
  "ply\nformat ascii 9.9\nelement vertex 1\nproperty float x\nend_header\n",
  "ply\nformat ascii 1.0\nelement vertex -1\nproperty float x\nend_header\n",
  "ply\nformat ascii 1.0\nelement vertex 1junk\nproperty float x\nend_header\n",
  "ply\nformat ascii 1.0\nelement vertex 1\nproperty list float int samples\nend_header\n",
  "ply\nformat ascii 1.0\nelement vertex 1\nproperty list uchar list samples\nend_header\n",
  "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float x\nend_header\n"
])("rejects malformed schemas without publishing a repair (%j)", async header => {
  const f = await customFile(header, "1\n");
  await expect(recoverPly(f.input, f.output)).rejects.toThrow();
  await expect(readFile(f.output)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["garbage", "garbage\n", "1e999\n"])("does not mistake an invalid final numeric token for truncation (%j)", async invalid => {
  const f = await customFile("ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nend_header\n", `1 2\n3 4\n5 ${invalid}`);
  await expect(recoverPly(f.input, f.output)).rejects.toThrow("Cannot recover malformed PLY data");
  await expect(readFile(f.output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("rejects negative list lengths rather than treating them as complete empty lists", async () => {
  const f = await customFile("ply\nformat ascii 1.0\nelement vertex 3\nproperty list int float samples\nend_header\n", "1 2.5\n-1\n");
  await expect(recoverPly(f.input, f.output)).rejects.toThrow("Invalid list length");
});

it("rejects ambiguous trailing bytes after multiple declared blocks", async () => {
  const f = await customFile("ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty uchar x\nelement face 0\nproperty list uchar int vertex_indices\nend_header\n", Buffer.from([1, 2]));
  await expect(recoverPly(f.input, f.output)).rejects.toThrow("boundaries are ambiguous");
});

it("preserves mixed scalar boundary values and precision through RPly writing", async () => {
  const header = "ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty uint id\nproperty int label\nproperty double confidence\nproperty float x\nend_header\n";
  const payload = Buffer.alloc(20);
  payload.writeUInt32LE(0xffffffff, 0); payload.writeInt32LE(-0x80000000, 4);
  payload.writeDoubleLE(1.0000000000000002, 8); payload.writeFloatLE(-0, 16);
  const f = await customFile(header, payload);
  const result = await recoverPly(f.input, f.output);
  const bytes = await readFile(result.input);
  expect(bytes.subarray(-payload.length)).toEqual(payload);
});

it("preserves non-finite float values for the existing downstream NaN filter", async () => {
  const header = "ply\nformat binary_little_endian 1.0\nelement vertex 5\nproperty float x\nend_header\n";
  const payload = Buffer.alloc(16);
  [NaN, Infinity, -Infinity, -0].forEach((value, index) => payload.writeFloatLE(value, index * 4));
  const f = await customFile(header, payload);
  const result = await recoverPly(f.input, f.output);
  const bytes = await readFile(result.input);
  const end = bytes.indexOf("end_header\n") + "end_header\n".length;
  expect(bytes.readFloatLE(end)).toBeNaN();
  expect(bytes.readFloatLE(end + 4)).toBe(Infinity);
  expect(bytes.readFloatLE(end + 8)).toBe(-Infinity);
  expect(Object.is(bytes.readFloatLE(end + 12), -0)).toBe(true);
});
