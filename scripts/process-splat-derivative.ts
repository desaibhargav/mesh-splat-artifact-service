import { writeLodCorrespondence } from "./lod-correspondence.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { LOD_POLICY_VERSION, assertLodCount, lodTargets } from "../src/artifacts/lodPolicy.js";
import { splatInfo } from "./splat-info.js";
import { recoverPly } from "./ply-recovery.js";
import {
  defaultManifestPath,
  fileSize,
  directorySize,
  stageDerivative,
  validateDerivativePaths,
  parseCommonArgs,
  prepareOutput,
  run,
  writeManifest
} from "./derivative-utils.js";


async function main() {
  const options = parseCommonArgs(process.argv.slice(2));
  const manifestPath = options.manifest ?? defaultManifestPath(options.output);
  const tempDir = await mkdtemp(resolve(tmpdir(), "mesh-splat-splat-"));

  try {
    await prepareOutput(options.output, options.force);
    await prepareOutput(manifestPath, true);
    await validateDerivativePaths(options, manifestPath);
    const prepared = await recoverPly(options.input, resolve(tempDir, "recovered.ply"));
    const sourceInfo = await splatInfo(prepared.input);
    if (!sourceInfo.gaussian) throw new Error("The source does not contain Gaussian splat data.");
    const targets = lodTargets(sourceInfo.numGaussians);
    const levels = await stageDerivative(options.output, options.force, async directory => {
      const records: ReturnType<typeof lodTargets> = [];
      const taggedInputs: string[] = [];
      for (const target of targets) {
        const ply = resolve(tempDir, `level-${target.level}.ply`);
        // Each decimation starts from the validated/recovered master, not LOD 0.
        await run("npx", ["splat-transform", "--overwrite", prepared.input,
          "--filter-nan", "--decimate", String(target.count), ply]);
        const info = await splatInfo(ply);
        assertLodCount(info.numGaussians, target.count);
        taggedInputs.push(ply, "--tag-lod", String(target.level));
        records.push({ ...target, count: info.numGaussians });
        if (target.level === 0) {
          // Keep the flat entry point for existing clients; the portal uses stream/.
          await run("npx", ["splat-transform", "--overwrite", ply, resolve(directory, basename(options.output))]);
        }
      }
      await mkdir(resolve(directory, "stream"));
      await run("npx", ["splat-transform", "--overwrite", ...taggedInputs, resolve(directory, "stream/lod-meta.json")]);
      const streamed = await splatInfo(resolve(directory, "stream/lod-meta.json"));
      if (streamed.lodCounts.some((count: number, level: number) => count !== records[level]?.count)) {
        throw new Error("Native streamed output counts differ from generated levels.");
      }
      const editing = await writeLodCorrespondence(directory, "splat", records);
      await writeFile(resolve(directory, "lod.json"), JSON.stringify({
        version: LOD_POLICY_VERSION, kind: "splat", stream: "stream/lod-meta.json", levels: records, editing
      }, null, 2));
      return { records, bytes: await directorySize(directory) };
    });

    await writeManifest(manifestPath, {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: {
        inputPath: options.input,
        inputBytes: await fileSize(options.input),
        ...(prepared.recovery ? { recovery: prepared.recovery } : {})
      },
      derivative: {
        outputPath: options.output,
        outputBytes: levels.bytes,
        publicRouteEligible: true
      },
      policy: {
        kind: "splat",
        decimationRequired: true,
        lodPolicyVersion: LOD_POLICY_VERSION,
        levels: levels.records,
        format: "SOG",
        streamedSog: true,
        lod: true,
        publicScaleMetadata: false
      },
      tools: {
        playcanvasSplatTransform: "3.3.0"
      },
      notes: [
        "The preservation master is not served by the portal.",
        "This derivative is intentionally decimated and converted to SOG for browser viewing.",
        "Only generated derivative bundle files belong behind public /files routes."
      ]
    });

    console.log(`Wrote splat derivative: ${options.output}`);
    console.log(`Wrote private manifest: ${manifestPath}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
