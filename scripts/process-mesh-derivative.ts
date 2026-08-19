import { NodeIO, Primitive } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, prune, quantize, simplify, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptSimplifier } from "meshoptimizer";
import {
  defaultManifestPath,
  fileSize,
  parseCommonArgs,
  prepareOutput,
  writeManifest
} from "./derivative-utils.js";

const TARGET_RATIO = 0.3;
const MAX_TRIANGLES = 1_000_000;

async function main() {
  const options = parseCommonArgs(process.argv.slice(2));
  const manifestPath = options.manifest ?? defaultManifestPath(options.output);

  await prepareOutput(options.output, options.force);
  await prepareOutput(manifestPath, true);
  await MeshoptDecoder.ready;
  await MeshoptSimplifier.ready;

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({
      "meshopt.decoder": MeshoptDecoder
    });

  const document = await io.read(options.input);
  const originalTriangles = countTriangles(document);
  const appliedRatio = originalTriangles > 0 ? Math.min(TARGET_RATIO, MAX_TRIANGLES / originalTriangles) : TARGET_RATIO;

  await document.transform(
    prune({ keepExtras: false, keepAttributes: false }),
    dedup(),
    weld(),
    simplify({
      simplifier: MeshoptSimplifier,
      ratio: appliedRatio,
      error: 1,
      lockBorder: false
    }),
    quantize({
      quantizationVolume: "mesh",
      quantizePosition: 10,
      quantizeNormal: 8,
      quantizeTexcoord: 10,
      quantizeColor: 8,
      quantizeWeight: 8,
      quantizeGeneric: 8,
      normalizeWeights: true
    }),
    prune({ keepExtras: false, keepAttributes: false }),
    dedup()
  );

  await io.write(options.output, document);
  const derivativeTriangles = countTriangles(document);

  await writeManifest(manifestPath, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      inputPath: options.input,
      inputBytes: await fileSize(options.input)
    },
    derivative: {
      outputPath: options.output,
      outputBytes: await fileSize(options.output),
      publicRouteEligible: true
    },
    policy: {
      kind: "mesh",
      simplificationRequired: true,
      targetRatio: TARGET_RATIO,
      appliedRatio,
      maxTriangles: MAX_TRIANGLES,
      originalTriangles,
      derivativeTriangles,
      weldBeforeSimplify: true,
      quantization: {
        positionBits: 10,
        normalBits: 8,
        texcoordBits: 10,
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
  console.log(`Triangles: ${originalTriangles} -> ${derivativeTriangles}`);
}

function countTriangles(document: Awaited<ReturnType<NodeIO["read"]>>): number {
  let triangles = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const indices = primitive.getIndices();
      const position = primitive.getAttribute("POSITION");
      triangles += Math.floor((indices?.getCount() ?? position?.getCount() ?? 0) / 3);
    }
  }
  return triangles;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
