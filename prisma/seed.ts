import "dotenv/config";
import { readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createPrismaClient } from "../src/database.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const root = resolve(process.env.ARTIFACT_ROOT ?? "./data/assets");
const demoUsername = process.env.DEMO_USERNAME ?? "demo-user";
const demoSubject = `demo:${demoUsername}`;
const prisma = createPrismaClient(databaseUrl);

const assets = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "scattering-skull",
    title: "Scattering Skull",
    description: "A CC0 glTF sample by Vladimir Petkovic, published by Khronos Group.",
    type: "MESH" as const,
    thumbnailPath: "thumbnails/scattering-skull.jpg",
    contentPath: "derivatives/scattering-skull/content.glb",
    contentFilename: "content.glb",
    mimeType: "model/gltf-binary"
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "sakura-garden",
    title: "Sakura Garden",
    description: "A CC0 Gaussian splat sample published by WakuFactory.",
    type: "SPLAT" as const,
    thumbnailPath: null,
    contentPath: "derivatives/sakura-garden/meta.json",
    contentFilename: "meta.json",
    mimeType: "application/json"
  },
  {
    id: "33333333-3333-4333-8333-333333333333",
    slug: "chess-set-photogrammetry",
    title: "Chess Set Photogrammetry",
    description: "A photogrammetry mesh of a chess set.",
    type: "MESH" as const,
    thumbnailPath: null,
    contentPath: "derivatives/chess-set-photogrammetry/content.glb",
    contentFilename: "content.glb",
    mimeType: "model/gltf-binary"
  },
  {
    id: "44444444-4444-4444-8444-444444444444",
    slug: "chess-set-gs-31-photos",
    title: "Chess Set GS 31 Photos",
    description: "A Gaussian splat reconstruction of a chess set generated from 31 photographs.",
    type: "SPLAT" as const,
    thumbnailPath: "thumbnails/chess-set-gs-31.webp",
    contentPath: "derivatives/chess-set-gs-31/meta.json",
    contentFilename: "meta.json",
    mimeType: "application/json"
  },
  {
    id: "55555555-5555-4555-8555-555555555555",
    slug: "chess-set-gs-691-photos",
    title: "Chess Set GS 691 Photos",
    description: "A Gaussian splat reconstruction of a chess set generated from 691 photographs.",
    type: "SPLAT" as const,
    thumbnailPath: "thumbnails/chess-set-gs-691.webp",
    contentPath: "derivatives/chess-set-gs-691/meta.json",
    contentFilename: "meta.json",
    mimeType: "application/json"
  }
];

try {
  for (const asset of assets) {
    const sizeBytes = await artifactSize(asset.contentPath, asset.contentFilename);
    await prisma.artifact.upsert({
      where: { id: asset.id },
      create: { ...asset, sizeBytes },
      update: { ...asset, sizeBytes }
    });
    await prisma.artifactPermission.upsert({
      where: { artifactId_userSubject: { artifactId: asset.id, userSubject: demoSubject } },
      create: { artifactId: asset.id, userSubject: demoSubject, canView: true },
      update: { canView: true }
    });
  }
  console.log(`Seeded ${assets.length} public demonstration artifacts with explicit permission for ${demoSubject}.`);
} finally {
  await prisma.$disconnect();
}

async function artifactSize(contentPath: string, contentFilename: string): Promise<bigint> {
  if (contentFilename !== "meta.json") {
    return BigInt((await stat(resolve(root, contentPath))).size);
  }

  const directory = resolve(root, dirname(contentPath));
  const files = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(
    files.filter((file) => file.isFile()).map(async (file) => (await stat(resolve(directory, file.name))).size)
  );
  return sizes.reduce((total, size) => total + BigInt(size), 0n);
}
