import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const sources = ["scripts/native-ply.ts", "scripts/native/recover-ply.cpp", "vendor/rply/rply.c", "vendor/rply/rply.h", "vendor/rply/rplyfile.h"];
let build: Promise<string> | undefined;

export function nativePly(): Promise<string> {
  return build ??= buildNativePly();
}

async function buildNativePly(): Promise<string> {
  const hash = createHash("sha256");
  for (const source of sources) hash.update(await readFile(join(root, source)));
  const directory = join(root, "node_modules/.cache/ply-recovery", `${process.platform}-${process.arch}-${hash.digest("hex")}`);
  const executable = join(directory, "recover-ply");
  try { await access(executable); return executable; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(dirname(directory), { recursive: true });
  const temporary = await mkdtemp(`${directory}-`);
  try {
    const object = join(temporary, "rply.o");
    await execute("cc", ["-std=c11", "-O2", "-c", join(root, "vendor/rply/rply.c"), "-o", object]);
    await execute("c++", ["-std=c++17", "-O2", "-I", join(root, "vendor/rply"),
      join(root, "scripts/native/recover-ply.cpp"), object, "-o", join(temporary, "recover-ply")]);
    await mkdir(directory, { recursive: true });
    await rename(join(temporary, "recover-ply"), executable);
    return executable;
  } catch (error) {
    throw new Error(`Cannot build RPly recovery helper (requires C/C++ build tools): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
