import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { derivativeFiles, regularFile } from "../src/artifacts/derivativeFiles.js";

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
  const contentPath = `derivatives/${slug}/${contentFilename}`;
  const contentFiles = await derivativeFiles(root, contentPath);
  const actual = await readdir(directory, { recursive: true, withFileTypes: true });
  for (const entry of actual) {
    if (entry.isDirectory()) continue;
    const path = join(entry.parentPath, entry.name);
    if (!contentFiles.has(relative(root, path))) throw new Error("Unexpected file in derivative directory.");
  }
  let sizeBytes = 0n;
  for (const file of contentFiles) sizeBytes += BigInt(await regularFile(root, file));
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
