import { NodeIO, Primitive } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { createChunkDataPool, getInputFormat, materializeToDataTable, readFile as readSplats, type ChunkSource } from "@playcanvas/splat-transform";
import { Mat4, Vec3 } from "playcanvas";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./derivative-utils.js";
import { splatFileSystem } from "./splat-info.js";

interface Centers { values: Float32Array; parts: number[] }

async function meshCenters(filename: string): Promise<Centers> {
  const document = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(filename);
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  if (!scene) throw new Error("LOD has no scene.");
  const values: number[] = [], parts: number[] = [];
  const point = new Vec3(), center = new Vec3(), matrix = new Mat4(), local: number[] = [];
  scene.traverse(node => {
    matrix.set(node.getWorldMatrix());
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      if (primitive.getMode() !== Primitive.Mode.TRIANGLES) throw new Error("LOD correspondence requires triangle geometry.");
      const position = primitive.getAttribute("POSITION")!;
      const indices = primitive.getIndices();
      const count = (indices?.getCount() ?? position.getCount()) / 3;
      parts.push(count);
      for (let face = 0; face < count; face++) {
        center.set(0, 0, 0);
        for (let corner = 0; corner < 3; corner++) {
          position.getElement(indices?.getScalar(face * 3 + corner) ?? face * 3 + corner, local);
          matrix.transformPoint(point.set(local[0]!, local[1]!, local[2]!), point);
          center.add(point);
        }
        center.mulScalar(1 / 3); values.push(center.x, center.y, center.z);
      }
    }
  });
  return { values: new Float32Array(values), parts };
}

async function splatCenters(filename: string): Promise<Centers> {
  const sources: ChunkSource[] = await readSplats({ filename, inputFormat: getInputFormat(filename), fileSystem: splatFileSystem });
  const pool = createChunkDataPool();
  try {
    const source = sources[0]!;
    const table = await materializeToDataTable(source, pool, new Set(["position"]));
    const columns = ["x", "y", "z"].map(name => table.getColumnByName(name)!.data as Float32Array);
    const values = new Float32Array(table.numRows * 3);
    for (let index = 0; index < table.numRows; index++) {
      for (let axis = 0; axis < 3; axis++) values[index * 3 + axis] = columns[axis]![index]!;
    }
    return { values, parts: [table.numRows] };
  } finally { for (const source of sources) await source.close(); pool.destroy(); }
}

export async function writeLodCorrespondence(directory: string, kind: "mesh" | "splat", levels: { level: number; file?: string }[]) {
  const temporary = await mkdtemp(join(tmpdir(), "lod-correspondence-"));
  try {
    const inputs: string[] = [], parts: number[][] = [], chunks: { file: number; level: number; offset: number; count: number }[] = [];
    const stream = kind === "splat" ? JSON.parse(await readFile(join(directory, "stream/lod-meta.json"), "utf8")) as {
      filenames: string[];
      tree: unknown;
    } : null;
    // Native file names carry the writer's structural LOD. Do not infer it from
    // geometry sizes: independently simplified levels may have equal counts.
    const fileLevels = new Map<number, number>();
    const visit = (node: { lods?: Record<string, { file: number }>; children?: unknown[] }) => {
      for (const [level, ref] of Object.entries(node.lods ?? {})) {
        if (fileLevels.has(ref.file) && fileLevels.get(ref.file) !== Number(level)) {
          throw new Error("A streamed file cannot belong to different LODs.");
        }
        fileLevels.set(ref.file, Number(level));
      }
      for (const child of node.children ?? []) visit(child as typeof node);
    };
    if (stream) visit(stream.tree as Parameters<typeof visit>[0]);
    for (const level of levels) {
      let centers: Centers;
      if (kind === "mesh") centers = await meshCenters(join(directory, level.file!));
      else {
        const arrays: Float32Array[] = [];
        let offset = 0;
        for (const [file, name] of stream!.filenames.entries()) {
          if (fileLevels.get(file) !== level.level) continue;
          const current = await splatCenters(join(directory, "stream", name));
          chunks.push({ file, level: level.level, offset, count: current.values.length / 3 });
          offset += current.values.length / 3;
          arrays.push(current.values);
        }
        const values = new Float32Array(offset * 3);
        let cursor = 0;
        for (const array of arrays) { values.set(array, cursor); cursor += array.length; }
        centers = { values, parts: [offset] };
      }
      const input = join(temporary, `${level.level}.bin`);
      await writeFile(input, new Uint8Array(centers.values.buffer));
      inputs.push(input); parts.push(centers.parts);
    }
    const config = join(temporary, "config.json");
    await writeFile(config, JSON.stringify({ inputs, output: join(directory, "editing") }));
    await run("python3", [fileURLToPath(new URL("./lod-correspondence.py", import.meta.url)), config]);
    return { centers: "editing/centers.bin.gz", parts, chunks,
      levels: levels.map(({ level }) => level === 0 ? { identity: true as const } :
        { to: `editing/to-${level}.bin.gz`, from: `editing/from-${level}.bin.gz` }) };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
