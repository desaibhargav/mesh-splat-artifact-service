import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { hash } from "argon2";

const root = resolve(import.meta.dirname, "..");
const assetRoot = resolve(root, "data/assets");
const envPath = resolve(root, ".env");
const generatedUsername = `demo-${randomBytes(6).toString("hex")}`;
const generatedPassword = randomBytes(15).toString("base64url");

await mkdir(assetRoot, { recursive: true });
if (await exists(envPath)) {
  console.log("Existing .env preserved.");
} else {
  const passwordHash = await hash(generatedPassword, { type: 2 });
  const databaseUser = encodeURIComponent(userInfo().username);
  const environment = [
    "NODE_ENV=development",
    "HOST=127.0.0.1",
    "PORT=8080",
    `DATABASE_URL=postgresql://${databaseUser}@127.0.0.1:5432/mesh_splat`,
    "ARTIFACT_ROOT=./data/assets",
    "AUTH_MODE=demo-session",
    `DEMO_USERNAME=${generatedUsername}`,
    `DEMO_PASSWORD_HASH=${passwordHash}`,
    `DEMO_SESSION_KEY=${randomBytes(32).toString("hex")}`,
    "DEMO_SESSION_TTL_SECONDS=3600",
    ""
  ].join("\n");
  await writeFile(envPath, environment, { encoding: "utf8", mode: 0o600 });
  console.log("Created .env with local-only credentials:");
  console.log(`  username: ${generatedUsername}`);
  console.log(`  password: ${generatedPassword}`);
  console.log("Save the password now; it is not stored in plaintext.");
}

await download(
  "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/ScatteringSkull/glTF-Binary/ScatteringSkull.glb",
  resolve(assetRoot, "scattering-skull.glb")
);
await download(
  "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/ScatteringSkull/screenshot/screenshot.jpg",
  resolve(assetRoot, "scattering-skull.jpg")
);
await download(
  "https://www.wakufactory.jp/wxr/splats/data/sakura1.ply",
  resolve(assetRoot, "sakura-garden.ply")
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
console.log("The contributor-provided chess mesh must be placed at data/assets/chess-set-photogrammetry.glb.");
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
    filenames.map((filename) => download(`${baseUrl}/${filename}`, resolve(assetRoot, directory, filename)))
  );
  await download(
    `https://s3-eu-west-1.amazonaws.com/images.playcanvas.com/splat/${sceneId}/v1/xl.webp`,
    resolve(assetRoot, directory, "thumbnail.webp")
  );

  const metadataPath = resolve(assetRoot, directory, "meta.json");
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
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o600 }));
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
