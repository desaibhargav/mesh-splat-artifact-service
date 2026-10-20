import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { derivativeFiles, regularFile } from "../src/artifacts/derivativeFiles.js";
import { inspectDerivative } from "../scripts/catalog.js";
import { stageDerivative, validateDerivativePaths } from "../scripts/derivative-utils.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lod-bundle-"));
  await mkdir(join(root, "derivatives/test"), { recursive: true });
  await mkdir(join(root, "thumbnails"));
  await writeFile(join(root, "thumbnails/test.webp"), "thumbnail");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const directory = join(root, "derivatives/test");
  const meta = { version: 2, count: 7, means: { files: ["means_l.webp", "means_u.webp"] },
    scales: { files: ["scales.webp"] }, quats: { files: ["quats.webp"] }, sh0: { files: ["sh0.webp"] } };
  for (const folder of [directory, join(directory, "stream/0_0")]) {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "meta.json"), JSON.stringify(meta));
    for (const name of ["means_l", "means_u", "scales", "quats", "sh0"]) await writeFile(join(folder, `${name}.webp`), "texture");
  }
  await writeFile(join(directory, "lod.json"), JSON.stringify({
    version: 1, kind: "splat", stream: "stream/lod-meta.json",
    levels: [0.7, 0.5, 0.3].map((ratio, level) => ({ level, ratio, count: 7 - level * 2 }))
  }));
  await writeFile(join(directory, "stream/lod-meta.json"), JSON.stringify({
    version: 1, lodLevels: 3, counts: [7, 5, 3], filenames: ["0_0/meta.json"]
  }));
  return directory;
}

describe("native LOD publication boundary", () => {
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
