import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const root = resolve(import.meta.dirname, "..");
const assetRoot = resolve(root, "data/assets");
const masterRoot = resolve(assetRoot, "master");
const thumbnailRoot = resolve(assetRoot, "thumbnails");
const envPath = resolve(root, ".env");

await mkdir(masterRoot, { recursive: true });
await mkdir(thumbnailRoot, { recursive: true });
if (await exists(envPath)) {
  console.log("Existing .env preserved.");
} else {
  const databaseUser = encodeURIComponent(userInfo().username);
  const environment = [
    "NODE_ENV=development",
    "HOST=127.0.0.1",
    "PORT=8080",
    `DATABASE_URL=postgresql://${databaseUser}@127.0.0.1:5432/mesh_splat`,
    "ARTIFACT_ROOT=./data/assets",
    ""
  ].join("\n");
  await writeFile(envPath, environment, { encoding: "utf8", mode: 0o600 });
  console.log("Created .env for the public local portal.");
}

await download(
  "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/ScatteringSkull/glTF-Binary/ScatteringSkull.glb",
  resolve(masterRoot, "scattering-skull.glb")
);
await download(
  "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/ScatteringSkull/screenshot/screenshot.jpg",
  resolve(thumbnailRoot, "scattering-skull.jpg")
);
await download(
  "https://www.wakufactory.jp/wxr/splats/data/sakura1.ply",
  resolve(masterRoot, "sakura-garden.ply")
);
await downloadSog("8053365a", "chess-set-gs-31", {
  position: [0.39970365166664124, 0.5802445411682129, 1.5912868976593018],
  target: [0, 0.5, 0],
  fov: 75
});
await downloadSog("65d2e9d3", "chess-set-gs-691", {
  position: [-0.6014781594276428, 0.9775305986404419, 1.452096700668335],
  target: [0, 0.5, 0],
  fov: 75
});

console.log("Local public test assets are ready.");
console.log("The contributor-provided chess mesh must be placed at data/assets/master/chess-set-photogrammetry.glb.");
console.log("Next: create the mesh_splat database, then run npm run db:push and npm run db:seed.");

interface PortalView {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

async function downloadSog(sceneId: string, directory: string, portalView: PortalView) {
  const baseUrl = `https://d28zzqy0iyovbz.cloudfront.net/${sceneId}/v1`;
  const filenames = [
    "meta.json",
    "means_l.webp",
    "means_u.webp",
    "quats.webp",
    "scales.webp",
    "sh0.webp",
    "shN_centroids.webp",
    "shN_labels.webp"
  ];
  await Promise.all(
    filenames.map((filename) => download(`${baseUrl}/${filename}`, resolve(masterRoot, directory, filename)))
  );
  await download(
    `https://s3-eu-west-1.amazonaws.com/images.playcanvas.com/splat/${sceneId}/v1/xl.webp`,
    resolve(thumbnailRoot, `${directory}.webp`)
  );

  const metadataPath = resolve(masterRoot, directory, "meta.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
  await writeFile(metadataPath, JSON.stringify({ ...metadata, portalView }), { encoding: "utf8", mode: 0o600 });
}

async function download(url: string, destination: string) {
  if (await exists(destination)) {
    console.log(`Already present: ${destination}`);
    return;
  }
  console.log(`Downloading ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.partial`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(temporary, { mode: 0o600 })
    );
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
