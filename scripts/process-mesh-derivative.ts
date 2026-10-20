import { writeLodCorrespondence } from "./lod-correspondence.js";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { LOD_POLICY_VERSION, assertLodCount, lodTargets } from "../src/artifacts/lodPolicy.js";
import { NodeIO, Primitive } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, normals, prune, quantize, simplify, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";
import {
  defaultManifestPath,
  fileSize,
  parseCommonArgs,
  prepareOutput,
  directorySize,
  stageDerivative,
  validateDerivativePaths,
  writeManifest
} from "./derivative-utils.js";


async function main() {
  const options = parseCommonArgs(process.argv.slice(2));
  const manifestPath = options.manifest ?? defaultManifestPath(options.output);

  await prepareOutput(options.output, options.force);
  await prepareOutput(manifestPath, true);
  await validateDerivativePaths(options, manifestPath);
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "meshopt.decoder": MeshoptDecoder
    });

  const source = await io.read(options.input);
  const originalTriangles = countTriangles(source);
  const levels = await stageDerivative(options.output, options.force, async directory => {
    const records = [];
    for (const target of lodTargets(originalTriangles)) {
      // Reload the master for every level: never simplify an already reduced LOD.
      const document = await io.read(options.input);
      removeNormals(document);
      await document.transform(
        prune({ keepExtras: false, keepAttributes: false }), dedup(), weld(),
        simplify({ simplifier: MeshoptSimplifier, ratio: target.ratio, error: 1, lockBorder: false }),
        normals({ overwrite: true }),
        quantize({ quantizationVolume: "mesh", quantizePosition: 10, quantizeNormal: 8,
          quantizeTexcoord: 12, quantizeColor: 8, quantizeWeight: 8, quantizeGeneric: 8, normalizeWeights: true }),
        prune({ keepExtras: false, keepAttributes: false }), dedup()
      );
      const count = countTriangles(document);
      assertLodCount(count, target.count);
      const file = target.level === 0 ? basename(options.output) : `lod/${target.level}/content.glb`;
      await mkdir(join(directory, file, ".."), { recursive: true });
      await io.write(join(directory, file), document);
      records.push({ ...target, count, file });
    }
    const editing = await writeLodCorrespondence(directory, "mesh", records);
    await writeFile(join(directory, "lod.json"), JSON.stringify({
      version: LOD_POLICY_VERSION, kind: "mesh", levels: records, editing
    }, null, 2));
    return { records, bytes: await directorySize(directory) };
  });

  await writeManifest(manifestPath, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      inputPath: options.input,
      inputBytes: await fileSize(options.input)
    },
    derivative: {
      outputPath: options.output,
      outputBytes: levels.bytes,
      publicRouteEligible: true
    },
    policy: {
      kind: "mesh",
      simplificationRequired: true,
      lodPolicyVersion: LOD_POLICY_VERSION,
      levels: levels.records,
      originalTriangles,
      normalsRegeneratedAfterSimplify: true,
      quantization: {
        positionBits: 10,
        normalBits: 8,
        texcoordBits: 12,
        colorBits: 8,
        weightBits: 8,
        genericBits: 8
      },
      compression: "none",
      meshoptCompressionEmitted: false,
      meshoptSimplifierUsed: true,
      meshoptCompressionDeferredReason: "Current PlayCanvas viewer path did not reliably load required EXT_meshopt_compression derivatives.",
      dracoFallback: false,
      publicScaleMetadata: false
    },
    tools: {
      gltfTransform: "4.4.2",
      meshoptimizer: "1.2.0"
    },
    notes: [
      "The preservation master is not served by the portal.",
      "This derivative is intentionally simplified and quantized for browser viewing."
    ]
  });

  console.log(`Wrote mesh derivative: ${options.output}`);
  console.log(`Wrote private manifest: ${manifestPath}`);
  console.log(`Triangles: ${originalTriangles} -> ${levels.records.map(level => level.count).join(" / ")}`);
}

function removeNormals(document: Awaited<ReturnType<NodeIO["read"]>>): number {
  let removed = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const normal = primitive.getAttribute("NORMAL");
      if (!normal) continue;
      primitive.setAttribute("NORMAL", null);
      if (normal.listParents().length === 0) normal.dispose();
      removed += 1;
    }
  }
  return removed;
}

function countTriangles(document: Awaited<ReturnType<NodeIO["read"]>>): number {
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  if (!scene) throw new Error("Mesh source has no scene.");
  let triangles = 0;
  scene.traverse(node => {
    for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
      if (primitive.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const indices = primitive.getIndices();
      const position = primitive.getAttribute("POSITION");
      triangles += Math.floor((indices?.getCount() ?? position?.getCount() ?? 0) / 3);
    }
  });
  return triangles;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
