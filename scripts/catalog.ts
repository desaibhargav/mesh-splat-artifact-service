import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const filename = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.webp$/);
const textures = (count: number) => z.object({ files: z.array(filename).length(count) });
const sogSchema = z.object({
  version: z.literal(2),
  count: z.number().int().positive(),
  means: textures(2),
  scales: textures(1),
  quats: textures(1),
  sh0: textures(1),
  shN: textures(2).optional()
});

export interface CatalogAsset {
  slug: string;
  type: "MESH" | "SPLAT";
  contentPath: string;
  contentFilename: string;
  thumbnailPath: string;
  mimeType: string;
  sizeBytes: bigint;
}

export async function inspectDerivative(root: string, slug: string): Promise<CatalogAsset> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("Invalid derivative directory name.");
  const directory = join(root, "derivatives", slug);
  if (!(await lstat(directory)).isDirectory()) throw new Error("Expected a derivative directory, not a symlink.");
  const files = await readdir(directory);
  const mesh = files.includes("content.glb");
  const splat = files.includes("meta.json");
  if (mesh === splat) throw new Error("Expected exactly one of content.glb or meta.json.");

  const contentFilename = mesh ? "content.glb" : "meta.json";
  let contentFiles = [contentFilename];
  if (splat) {
    await publicFileSize(join(directory, contentFilename));
    const meta = sogSchema.parse(JSON.parse(await readFile(join(directory, contentFilename), "utf8")));
    contentFiles.push(...meta.means.files, ...meta.scales.files, ...meta.quats.files, ...meta.sh0.files,
      ...(meta.shN?.files ?? []));
    if (new Set(contentFiles).size !== contentFiles.length) throw new Error("SOG component names must be unique.");
    // The public SOG route can serve siblings, so the directory must contain only its components.
    if (files.some(file => !contentFiles.includes(file))) throw new Error("Unexpected file in SOG derivative directory.");
  }

  let sizeBytes = 0n;
  for (const file of contentFiles) sizeBytes += await publicFileSize(join(directory, file));
  const thumbnailPath = `thumbnails/${slug}.webp`;
  if (!(await lstat(join(root, "thumbnails"))).isDirectory()) throw new Error("Expected a thumbnails directory, not a symlink.");
  await publicFileSize(join(root, thumbnailPath));

  return {
    slug,
    type: mesh ? "MESH" : "SPLAT",
    contentPath: `derivatives/${slug}/${contentFilename}`,
    contentFilename,
    thumbnailPath,
    mimeType: mesh ? "model/gltf-binary" : "application/json",
    sizeBytes
  };
}

async function publicFileSize(file: string): Promise<bigint> {
  const info = await lstat(file);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing, empty, or non-regular file: ${file}`);
  return BigInt(info.size);
}

export function catalogUpsert(asset: CatalogAsset, matches: { slug: string; contentPath: string }[]) {
  if (matches.length > 1 || (matches[0] && matches[0].contentPath !== asset.contentPath)) {
    throw new Error("Catalog slug conflicts with a different content path.");
  }
  const { slug, ...delivery } = asset;
  return {
    where: { slug: matches[0]?.slug ?? slug },
    create: { ...asset, title: slug, description: "" },
    update: delivery
  };
}
