import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { LOD_RATIOS, LOD_POLICY_VERSION } from "./lodPolicy.js";

export const relativeFile = z.string().max(1024).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/);
const texture = z.object({ files: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*\.webp$/)) });
const sog = z.object({ version: z.literal(2), count: z.number().int().positive(),
  means: texture.extend({ files: texture.shape.files.length(2) }),
  scales: texture.extend({ files: texture.shape.files.length(1) }),
  quats: texture.extend({ files: texture.shape.files.length(1) }),
  sh0: texture.extend({ files: texture.shape.files.length(1) }),
  shN: texture.extend({ files: texture.shape.files.length(2) }).optional() });
const level = z.object({ level: z.number().int().min(0).max(2), ratio: z.number().min(0.3).max(0.7), count: z.number().int().positive() });
const editing = z.object({
  centers: z.literal("editing/centers.bin.gz"),
  parts: z.array(z.array(z.number().int().positive()).min(1)).length(LOD_RATIOS.length),
  chunks: z.array(z.object({ file: z.number().int().nonnegative(), level: z.number().int().min(0).max(2),
    offset: z.number().int().nonnegative(), count: z.number().int().positive() }).strict()),
  levels: z.array(z.union([z.object({ identity: z.literal(true) }).strict(),
    z.object({ to: z.string().regex(/^editing\/to-[12]\.bin\.gz$/),
      from: z.string().regex(/^editing\/from-[12]\.bin\.gz$/) }).strict()])).length(LOD_RATIOS.length)
}).strict();
const lod = z.discriminatedUnion("kind", [
  z.object({ version: z.literal(LOD_POLICY_VERSION), kind: z.literal("mesh"), editing: editing.optional(), levels: z.array(level.extend({
    file: z.string().regex(/^(content\.glb|lod\/[12]\/content\.glb)$/)
  }).strict()).length(3) }).strict(),
  z.object({ version: z.literal(LOD_POLICY_VERSION), kind: z.literal("splat"), editing: editing.optional(), levels: z.array(level.strict()).length(3),
    stream: z.literal("stream/lod-meta.json") }).strict()
]);
const stream = z.object({ version: z.literal(1), lodLevels: z.literal(3),
  filenames: z.array(z.string().regex(/^[A-Za-z0-9_-]+\/meta\.json$/)), counts: z.array(z.number().int().nonnegative()).length(3) });

// Check every path component. Lexical containment alone does not stop symlinks.
export async function regularFile(root: string, path: string): Promise<number> {
  relativeFile.parse(path);
  const segments = path.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const info = await lstat(current);
    if (index < segments.length - 1 ? !info.isDirectory() : !info.isFile() || info.size === 0) {
      throw new Error("Missing, empty, or non-regular file, or symlink parent.");
    }
    if (index === segments.length - 1) return info.size;
  }
  throw new Error("Missing file.");
}

export async function derivativeFiles(root: string, contentPath: string): Promise<Set<string>> {
  if (!/^derivatives\/[a-z0-9][a-z0-9-]*\/(content\.glb|meta\.json)$/.test(contentPath)) {
    throw new Error("Public content must belong to the derivative namespace.");
  }
  const directory = dirname(contentPath);
  const files = new Set<string>();
  async function json(path: string): Promise<unknown> {
    await regularFile(root, path);
    files.add(path);
    return JSON.parse(await readFile(join(root, path), "utf8"));
  }
  async function addSog(path: string) {
    const meta = sog.parse(await json(path));
    const names = [meta.means, meta.scales, meta.quats, meta.sh0, ...(meta.shN ? [meta.shN] : [])].flatMap(item => item.files);
    if (new Set(names).size !== names.length) throw new Error("SOG component names must be unique.");
    for (const name of names) files.add(join(dirname(path), name));
  }
  if (contentPath.endsWith("meta.json")) await addSog(contentPath);
  else files.add(contentPath);
  const descriptor = join(directory, "lod.json");
  try { await lstat(join(root, descriptor)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return files; throw error; }
  const metadata = lod.parse(await json(descriptor));
  if ((metadata.kind === "splat") !== contentPath.endsWith("meta.json")) throw new Error("LOD kind differs from content.");
  metadata.levels.forEach((item, index) => {
    if (item.level !== index || item.ratio !== LOD_RATIOS[index]) throw new Error("Unexpected LOD policy.");
  });
  if (metadata.editing) {
    files.add(join(directory, metadata.editing.centers));
    for (const item of metadata.editing.levels) {
      if ("to" in item) { files.add(join(directory, item.to)); files.add(join(directory, item.from)); }
    }
  }
  if (metadata.kind === "mesh") {
    for (const item of metadata.levels) files.add(join(directory, item.file));
  } else {
    const path = join(directory, metadata.stream);
    const streamed = stream.parse(await json(path));
    if (streamed.counts.some((count, index) => count !== metadata.levels[index]!.count)) throw new Error("Streamed LOD counts differ from descriptor.");
    for (const name of streamed.filenames) await addSog(join(dirname(path), name));
  }
  return files;
}
