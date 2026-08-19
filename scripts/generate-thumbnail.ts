import { parseCommonArgs } from "./derivative-utils.js";

async function main() {
  parseCommonArgs(process.argv.slice(2));
  throw new Error(
    "Thumbnail generation is intentionally not implemented yet. The planned implementation uses the portal's PlayCanvas viewer in a headless browser so mesh and splat thumbnails match the real viewer."
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
