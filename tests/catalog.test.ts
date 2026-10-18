import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { catalogUpsert, inspectDerivative } from "../scripts/catalog.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "catalog-test-"));
  await mkdir(join(root, "derivatives", "test-object"), { recursive: true });
  await mkdir(join(root, "thumbnails"));
  await writeFile(join(root, "thumbnails", "test-object.webp"), "thumbnail");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function mesh() {
  await writeFile(join(root, "derivatives", "test-object", "content.glb"), "mesh");
  return inspectDerivative(root, "test-object");
}

async function splat() {
  const files = ["means_l.webp", "means_u.webp", "scales.webp", "quats.webp", "sh0.webp"];
  const meta = {
    version: 2, count: 10,
    means: { files: files.slice(0, 2) },
    scales: { files: [files[2]] },
    quats: { files: [files[3]] },
    sh0: { files: [files[4]] }
  };
  const directory = join(root, "derivatives", "test-object");
  await writeFile(join(directory, "meta.json"), JSON.stringify(meta));
  for (const file of files) await writeFile(join(directory, file), "texture");
  return { directory, meta };
}

describe("publishable derivatives", () => {
  it("discovers a mesh with public relative paths and byte size", async () => {
    expect(await mesh()).toMatchObject({
      type: "MESH", contentPath: "derivatives/test-object/content.glb",
      thumbnailPath: "thumbnails/test-object.webp", sizeBytes: 4n
    });
  });

  it("counts SOG metadata and every referenced texture", async () => {
    const { meta } = await splat();
    const asset = await inspectDerivative(root, "test-object");
    expect(asset.type).toBe("SPLAT");
    expect(asset.sizeBytes).toBe(BigInt(Buffer.byteLength(JSON.stringify(meta)) + 5 * 7));
  });

  it("refuses missing SOG components", async () => {
    const { directory } = await splat();
    await unlink(join(directory, "quats.webp"));
    await expect(inspectDerivative(root, "test-object")).rejects.toThrow();
  });

  it("refuses extra files that the SOG sibling route could expose", async () => {
    const { directory } = await splat();
    await writeFile(join(directory, "original.ply"), "private master");
    await expect(inspectDerivative(root, "test-object")).rejects.toThrow("Unexpected file");
  });

  it("refuses component traversal", async () => {
    const { directory, meta } = await splat();
    meta.quats.files = ["../outside.webp"];
    await writeFile(join(directory, "meta.json"), JSON.stringify(meta));
    await expect(inspectDerivative(root, "test-object")).rejects.toThrow();
  });

  it("refuses symlinked content and missing thumbnails", async () => {
    await writeFile(join(root, "master.glb"), "private master");
    const content = join(root, "derivatives", "test-object", "content.glb");
    await symlink(join(root, "master.glb"), content);
    await expect(inspectDerivative(root, "test-object")).rejects.toThrow("non-regular");
    await unlink(content);
    await unlink(join(root, "thumbnails", "test-object.webp"));
    await expect(mesh()).rejects.toThrow();
  });

  it("refuses empty or ambiguous content", async () => {
    await mesh();
    const directory = join(root, "derivatives", "test-object");
    await writeFile(join(directory, "content.glb"), "");
    await expect(inspectDerivative(root, "test-object")).rejects.toThrow("empty");
    await writeFile(join(directory, "meta.json"), "{}");
    await expect(inspectDerivative(root, "test-object")).rejects.toThrow("exactly one");
  });
});

describe("catalog identity and metadata", () => {
  it("uses an existing content path even when its catalog slug differs", async () => {
    const asset = await mesh();
    const operation = catalogUpsert(asset, [{ slug: "edited-slug", contentPath: asset.contentPath }]);
    expect(operation.where).toEqual({ slug: "edited-slug" });
    expect(operation.update).not.toHaveProperty("title");
    expect(operation.update).not.toHaveProperty("description");
    expect(operation.update).not.toHaveProperty("slug");
    expect(operation.update).not.toHaveProperty("id");
  });

  it("uses the folder identifier as the initial title without inventing metadata", async () => {
    const asset = await mesh();
    const operation = catalogUpsert(asset, []);
    expect(operation.create.title).toBe(asset.slug);
    expect(operation.create.description).toBe("");
  });

  it("refuses conflicting slugs and duplicate content registrations", async () => {
    const asset = await mesh();
    expect(() => catalogUpsert(asset, [{ slug: asset.slug, contentPath: "derivatives/other/content.glb" }]))
      .toThrow("conflicts");
    expect(() => catalogUpsert(asset, [
      { slug: asset.slug, contentPath: asset.contentPath },
      { slug: "duplicate", contentPath: asset.contentPath }
    ])).toThrow("conflicts");
  });
});
