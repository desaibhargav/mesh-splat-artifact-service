import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { derivativeFiles, regularFile } from "../src/artifacts/derivativeFiles.js";
import { buildApp } from "../src/app.js";
import type { ArtifactRecord } from "../src/artifacts/ArtifactRepository.js";
import { inspectDerivative } from "../scripts/catalog.js";
import { stageDerivative, validateDerivativePaths } from "../scripts/derivative-utils.js";

let root: string;
let app: FastifyInstance | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lod-bundle-"));
  await mkdir(join(root, "derivatives/test"), { recursive: true });
  await mkdir(join(root, "thumbnails"));
  await writeFile(join(root, "thumbnails/test.webp"), "thumbnail");
});
afterEach(async () => { await app?.close(); app = undefined; await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const directory = join(root, "derivatives/test");
  const meta = { version: 2, count: 7, means: { files: ["means_l.webp", "means_u.webp"] },
    scales: { files: ["scales.webp"] }, quats: { files: ["quats.webp"] }, sh0: { files: ["sh0.webp"] } };
  for (const [folder, count] of [[directory, 7], [join(directory, "stream/0_0"), 7],
    [join(directory, "stream/1_0"), 5], [join(directory, "stream/2_0"), 3]] as const) {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "meta.json"), JSON.stringify({ ...meta, count }));
    for (const name of ["means_l", "means_u", "scales", "quats", "sh0"]) await writeFile(join(folder, `${name}.webp`), "texture");
  }
  await writeFile(join(directory, "lod.json"), JSON.stringify({
    version: 1, kind: "splat", stream: "stream/lod-meta.json",
    editing: { centers: "editing/centers.bin.gz", parts: [[7],[5],[3]], chunks: [
      {file:0,level:0,offset:0,count:7}, {file:1,level:1,offset:0,count:5}, {file:2,level:2,offset:0,count:3}],
      levels:[{identity:true},{to:"editing/to-1.bin.gz",from:"editing/from-1.bin.gz"},{to:"editing/to-2.bin.gz",from:"editing/from-2.bin.gz"}] },
    levels: [0.3, 0.15, 0.075].map((ratio, level) => ({ level, ratio, count: 7 - level * 2 }))
  }));
  await writeFile(join(directory, "stream/lod-meta.json"), JSON.stringify({
    version: 1, lodLevels: 3, counts: [7, 5, 3], filenames: ["0_0/meta.json", "1_0/meta.json", "2_0/meta.json"]
  }));
  await mkdir(join(directory,"editing"));
  for(const name of ["centers","to-1","from-1","to-2","from-2"]) await writeFile(join(directory,`editing/${name}.bin.gz`), "data");
  return directory;
}

describe("native LOD publication boundary", () => {
  it("advertises native streaming and serves only registered nested files", async () => {
    await fixture();
    const record: ArtifactRecord = { id: "33333333-3333-4333-8333-333333333333", title: "Streamed test",
      description: "", type: "splat", thumbnailPath: null, contentPath: "derivatives/test/meta.json",
      contentFilename: "meta.json", mimeType: "application/json", sizeBytes: 100 };
    app = await buildApp({ config: { environment: "test", host: "127.0.0.1", port: 8080,
      databaseUrl: "postgresql://unused", artifactRoot: root }, repository: {
      search: async () => ({ items: [record], nextCursor: null }),
      findById: async id => id === record.id ? record : null
    } });
    const response = await app.inject({ method: "GET", url: `/api/v1/artifacts/${record.id}` });
    expect(response.json()).toMatchObject({ lodUrl: `/files/${record.id}/lod.json`,
      contentUrl: `/files/${record.id}/stream/lod-meta.json` });
    const chunk = await app.inject({ method: "GET", url: `/files/${record.id}/stream/1_0/means_l.webp` });
    expect(chunk.statusCode).toBe(200);
    expect(chunk.headers["content-type"]).toContain("image/webp");
    const map = await app.inject({ method: "GET", url: `/files/${record.id}/editing/centers.bin.gz` });
    expect(map.statusCode).toBe(200);
    expect(map.headers["content-encoding"]).toBe("gzip");
    const privateFile = await app.inject({ method: "GET", url: `/files/${record.id}/stream/original.ply` });
    expect(privateFile.statusCode).toBe(404);
  });
  it("authorizes nested SOG components and catalogs the entire bundle", async () => {
    await fixture();
    const files = await derivativeFiles(root, "derivatives/test/meta.json");
    expect(files.has("derivatives/test/stream/0_0/means_l.webp")).toBe(true);
    expect(files.has("derivatives/test/master.ply")).toBe(false);
    const asset = await inspectDerivative(root, "test");
    expect(asset.type).toBe("SPLAT");
    expect(asset.sizeBytes).toBeGreaterThan(100n);
  });
  it("rejects traversal in native manifests", async () => {
    const directory = await fixture();
    await writeFile(join(directory, "stream/lod-meta.json"), JSON.stringify({
      version: 1, lodLevels: 3, counts: [7, 5, 3], filenames: ["../../master/meta.json"]
    }));
    await expect(derivativeFiles(root, "derivatives/test/meta.json")).rejects.toThrow();
  });
  it("rejects correspondence that omits a published LOD level", async () => {
    const directory = await fixture();
    const path = join(directory, "lod.json");
    const descriptor = JSON.parse(await readFile(path, "utf8"));
    descriptor.editing.chunks.pop();
    await writeFile(path, JSON.stringify(descriptor));
    await expect(derivativeFiles(root, "derivatives/test/meta.json")).rejects.toThrow("files and correspondence");
  });
  it("rejects symlinked parent directories on every file request", async () => {
    await fixture();
    await mkdir(join(root, "private"));
    await writeFile(join(root, "private/secret.webp"), "secret");
    await symlink(join(root, "private"), join(root, "derivatives/test/linked"));
    await expect(regularFile(root, "derivatives/test/linked/secret.webp")).rejects.toThrow();
  });
  it("does not catalog an unreferenced extra file", async () => {
    const directory = await fixture();
    await writeFile(join(directory, "stream/original.ply"), "master");
    await expect(inspectDerivative(root, "test")).rejects.toThrow("Unexpected file");
  });
});

describe("staged bundle generation", () => {
  it("rejects source aliases and private manifests inside a public output directory", async () => {
    const input = join(root, "derivatives/test/content.glb");
    await writeFile(input, "preservation master");
    const alias = join(root, "alias.glb"); await symlink(input, alias);
    await expect(validateDerivativePaths({ input: alias, output: input, force: true }, join(root, "private.json")))
      .rejects.toThrow("preservation masters");
    const separate = join(root, "source.glb"); await writeFile(separate, "source");
    await expect(validateDerivativePaths({ input: separate, output: input, force: true }, join(root, "derivatives/test/private.json")))
      .rejects.toThrow("private processing manifest");
    const manifestAlias = join(root, "manifest.json"); await symlink(separate, manifestAlias);
    await expect(validateDerivativePaths({ input: separate, output: input, force: true }, manifestAlias))
      .rejects.toThrow("must not replace preservation masters");
  });
  it("retains the previous derivative when any level fails", async () => {
    const output = join(root, "derivatives/test/content.glb");
    await writeFile(output, "previous");
    await expect(stageDerivative(output, true, async directory => {
      await writeFile(join(directory, "content.glb"), "unfinished");
      throw new Error("coarse level failed");
    })).rejects.toThrow("coarse level failed");
    expect(await readFile(output, "utf8")).toBe("previous");
  });
  it("refuses to replace unrelated files", async () => {
    const output = join(root, "derivatives/test/content.glb");
    await writeFile(join(root, "derivatives/test/original.ply"), "master");
    await expect(stageDerivative(output, true, async () => {})).rejects.toThrow("non-derivative");
  });
});
