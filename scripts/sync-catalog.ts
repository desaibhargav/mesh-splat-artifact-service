import "dotenv/config";
import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createPrismaClient } from "../src/database.js";
import { catalogUpsert, inspectDerivative } from "./catalog.js";

async function main() {
  const { values } = parseArgs({ options: {
    "asset-root": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", default: false }
  } });
  if (values.help) {
    console.log("Usage: npm run catalog:sync -- [--asset-root PATH] [--dry-run]");
    return;
  }
  const root = resolve(values["asset-root"] ?? process.env.ARTIFACT_ROOT ?? "data/assets");
  const derivatives = resolve(root, "derivatives");
  if (!(await lstat(derivatives)).isDirectory()) throw new Error("Expected a derivatives directory, not a symlink.");
  const entries = (await readdir(derivatives, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!values["dry-run"] && !process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  const prisma = values["dry-run"] ? null : createPrismaClient(process.env.DATABASE_URL!);
  let ready = 0;
  let failed = 0;
  try {
    for (const entry of entries) {
      try {
        const asset = await inspectDerivative(root, entry.name);
        if (prisma) {
          const matches = await prisma.artifact.findMany({
            where: { OR: [{ slug: asset.slug }, { contentPath: asset.contentPath }] },
            select: { slug: true, contentPath: true }
          });
          const record = await prisma.artifact.upsert(catalogUpsert(asset, matches));
          console.log(`Synced ${entry.name}: /artifacts/${record.id}`);
        } else {
          console.log(`Ready ${entry.name} (${asset.type.toLowerCase()}, ${asset.sizeBytes} bytes)`);
        }
        ready += 1;
      } catch (error) {
        failed += 1;
        console.error(`Skipped ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await prisma?.$disconnect();
  }
  console.log(`${values["dry-run"] ? "Validated" : "Synced"} ${ready}; skipped ${failed}.`);
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
