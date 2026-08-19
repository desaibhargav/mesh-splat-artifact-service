import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exists, run } from "./derivative-utils.js";

type DerivativeArtifact = {
  slug: string;
  type: "mesh" | "splat";
  input: string;
  derivativeRoot: string;
};

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const derivativeRoot = "data/assets/derivatives";
const thumbnailRoot = "data/assets/thumbnails";

async function main() {
  const artifacts = await discoverDerivatives();
  if (artifacts.length === 0) throw new Error(`No derivative assets found under ${derivativeRoot}.`);

  let processed = 0;
  let skipped = 0;
  for (const [index, artifact] of artifacts.entries()) {
    const ordinal = `${index + 1}/${artifacts.length}`;
    const output = resolve(thumbnailRoot, `${artifact.slug}.webp`);
    const stale =
      force ||
      !(await exists(output)) ||
      (await maxMtimeMs(artifact.derivativeRoot)) > (await maxMtimeMs(output));

    console.log(`\n[${ordinal}] ${stale ? "Generating" : "Skipping current"} thumbnail: ${artifact.slug}`);
    console.log(`      input:  ${artifact.input}`);
    console.log(`      output: ${output}`);

    if (!stale) {
      skipped += 1;
      continue;
    }

    await run("npm", [
      "run",
      "generate:thumbnail",
      "--",
      "--type",
      artifact.type,
      "--input",
      artifact.input,
      "--output",
      output,
      "--force"
    ]);
    processed += 1;
  }

  console.log(`\nGenerated ${processed}/${artifacts.length} thumbnails. Skipped ${skipped}/${artifacts.length} current thumbnails.`);
}

async function discoverDerivatives(): Promise<DerivativeArtifact[]> {
  const entries = await readdir(derivativeRoot, { withFileTypes: true });
  const artifacts: DerivativeArtifact[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const root = join(derivativeRoot, entry.name);
    const mesh = join(root, "content.glb");
    const splat = join(root, "meta.json");
    if (await exists(mesh)) {
      artifacts.push({ slug: entry.name, type: "mesh", input: mesh, derivativeRoot: root });
    } else if (await exists(splat)) {
      artifacts.push({ slug: entry.name, type: "splat", input: splat, derivativeRoot: root });
    }
  }

  return artifacts.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function maxMtimeMs(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.mtimeMs;

  const entries = await readdir(path, { withFileTypes: true });
  const mtimes = await Promise.all(entries.map((entry) => maxMtimeMs(join(path, entry.name))));
  return Math.max(info.mtimeMs, ...mtimes);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
