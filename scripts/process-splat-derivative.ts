import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultManifestPath,
  fileSize,
  parseCommonArgs,
  prepareOutput,
  run,
  writeManifest
} from "./derivative-utils.js";

const TARGET_RATIO = 0.3;
const TARGET_RATIO_PERCENT = "30%";

async function main() {
  const options = parseCommonArgs(process.argv.slice(2));
  const manifestPath = options.manifest ?? defaultManifestPath(options.output);
  const tempDir = await mkdtemp(resolve(tmpdir(), "mesh-splat-splat-"));
  const decimatedPly = resolve(tempDir, "decimated.ply");

  await prepareOutput(options.output, options.force);
  await prepareOutput(manifestPath, true);

  try {
    await run("npx", [
      "splat-transform",
      "--overwrite",
      options.input,
      "--filter-nan",
      "--decimate",
      TARGET_RATIO_PERCENT,
      decimatedPly
    ]);

    await run("npx", ["splat-transform", "--overwrite", decimatedPly, options.output]);

    await writeManifest(manifestPath, {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: {
        inputPath: options.input,
        inputBytes: await fileSize(options.input)
      },
      derivative: {
        outputPath: options.output,
        outputBytes: await directorySize(dirname(options.output)),
        publicRouteEligible: true
      },
      policy: {
        kind: "splat",
        decimationRequired: true,
        targetRatio: TARGET_RATIO,
        targetRatioPercent: TARGET_RATIO_PERCENT,
        format: "SOG",
        streamedSog: false,
        lod: false,
        publicScaleMetadata: false
      },
      tools: {
        playcanvasSplatTransform: "3.3.0"
      },
      notes: [
        "The preservation master is not served by the portal.",
        "This derivative is intentionally decimated and converted to SOG for browser viewing.",
        "Only generated SOG files should be placed behind public /files routes."
      ]
    });

    console.log(`Wrote splat derivative: ${options.output}`);
    console.log(`Wrote private manifest: ${manifestPath}`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function directorySize(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  const sizes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => (await stat(resolve(path, entry.name))).size)
  );
  return sizes.reduce((total, size) => total + size, 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
