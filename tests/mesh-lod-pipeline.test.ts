import { Document, NodeIO } from "@gltf-transform/core";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("counts scene instances and keeps correspondence parts consistent through the real mesh pipeline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mesh-lod-integration-"));
  try {
    const document = new Document(), buffer = document.createBuffer();
    const positions: number[] = [], indices: number[] = [];
    for (let y = 0; y <= 10; y++) for (let x = 0; x <= 10; x++) positions.push(x, y, 0);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const index = y * 11 + x; indices.push(index, index + 1, index + 11, index + 1, index + 12, index + 11);
    }
    const position = document.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer);
    const index = document.createAccessor().setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buffer);
    const mesh = document.createMesh().addPrimitive(document.createPrimitive().setAttribute("POSITION", position).setIndices(index));
    const scene = document.createScene(); document.getRoot().setDefaultScene(scene);
    scene.addChild(document.createNode().setMesh(mesh));
    scene.addChild(document.createNode().setMesh(mesh).setTranslation([30, 0, 0]));
    const input = join(directory, "source.glb"), output = join(directory, "published/content.glb"), manifest = join(directory, "private.json");
    await new NodeIO().write(input, document);
    await promisify(execFile)(process.execPath, ["--import", "tsx", resolve("scripts/process-mesh-derivative.ts"),
      "--input", input, "--output", output, "--manifest", manifest], { timeout: 30000 });
    const privateMeta = JSON.parse(await readFile(manifest, "utf8"));
    expect(privateMeta.policy.originalTriangles).toBe(400);
    const meta = JSON.parse(await readFile(join(directory, "published/lod.json"), "utf8"));
    for (const [level, ratio] of [0.7, 0.5, 0.3].entries()) {
      expect(meta.levels[level].count).toBeLessThanOrEqual(Math.floor(400 * ratio));
      expect(meta.editing.parts[level]).toHaveLength(2);
      expect(meta.editing.parts[level].reduce((sum: number, count: number) => sum + count, 0)).toBe(meta.levels[level].count);
    }
    expect(JSON.stringify(meta)).not.toContain(input);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 40000);
