import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, parse, resolve } from "node:path";
import { exists, run } from "./derivative-utils.js";

type ArtifactSource = {
  slug: string;
  type: "mesh" | "splat";
  input: string;
  sourceRoot: string;
};

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const masterRoot = "data/assets/master";
const derivativeRoot = "data/assets/derivatives";

async function main() {
  const artifacts = await discoverArtifacts();
  if (artifacts.length === 0) throw new Error(`No processable master assets found under ${masterRoot}.`);

  let processed = 0;
  let skipped = 0;
  for (const [index, artifact] of artifacts.entries()) {
    const ordinal = `${index + 1}/${artifacts.length}`;
    const output = derivativeOutputPath(artifact);
    const stale = force || !(await exists(output)) || (await maxMtimeMs(artifact.sourceRoot)) > (await maxMtimeMs(output));

    console.log(`\n[${ordinal}] ${stale ? "Processing" : "Skipping current"} ${artifact.type} derivative: ${artifact.slug}`);
    console.log(`      input:  ${artifact.input}`);
    console.log(`      output: ${output}`);

    if (!stale) {
      skipped += 1;
      continue;
    }

    const command = artifact.type === "mesh" ? "process:mesh" : "process:splat";
    await run("npm", [
      "run",
      command,
      "--",
      "--input",
      artifact.input,
      "--output",
      output,
      "--force"
    ]);
    processed += 1;
  }

  console.log(`\nProcessed ${processed}/${artifacts.length} derivatives. Skipped ${skipped}/${artifacts.length} current derivatives.`);
}

async function discoverArtifacts(): Promise<ArtifactSource[]> {
  const entries = await readdir(masterRoot, { withFileTypes: true });
  const artifacts: ArtifactSource[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "README.md" || entry.name === "derivatives") continue;

    const path = join(masterRoot, entry.name);
    if (entry.isFile()) {
      const extension = extname(entry.name).toLowerCase();
      if (extension === ".glb") {
        artifacts.push({ slug: slugFromName(parse(entry.name).name), type: "mesh", input: path, sourceRoot: path });
      } else if (extension === ".ply") {
        artifacts.push({ slug: slugFromName(parse(entry.name).name), type: "splat", input: path, sourceRoot: path });
      }
      continue;
    }

    if (entry.isDirectory()) {
      const metaPath = join(path, "meta.json");
      if (await exists(metaPath)) {
        artifacts.push({ slug: slugFromName(entry.name), type: "splat", input: metaPath, sourceRoot: path });
      }
    }
  }

  return artifacts.sort((a, b) => a.slug.localeCompare(b.slug));
}

function slugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(slug)) {
    throw new Error(`Cannot derive safe slug from asset name: ${name}`);
  }
  return slug;
}

function derivativeOutputPath(artifact: ArtifactSource) {
  return resolve(derivativeRoot, artifact.slug, artifact.type === "mesh" ? "content.glb" : "meta.json");
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
