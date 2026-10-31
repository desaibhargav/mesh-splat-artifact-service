import { mkdir, mkdtemp, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { PlyRecovery } from "./ply-recovery.js";

export interface CommonDerivativeOptions {
  input: string;
  output: string;
  manifest?: string;
  title?: string;
  force: boolean;
}

export interface DerivativeManifest {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    inputPath: string;
    inputBytes: number;
    recovery?: PlyRecovery;
  };
  derivative: {
    outputPath: string;
    outputBytes: number;
    publicRouteEligible: true;
  };
  policy: Record<string, unknown>;
  tools: Record<string, string>;
  notes: string[];
}

export function parseCommonArgs(argv: string[]): CommonDerivativeOptions {
  const args = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    if (key === "force") {
      args.set(key, true);
      continue;
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    args.set(key, value);
    index += 1;
  }

  const parsed: CommonDerivativeOptions = {
    input: requiredString(args, "input"),
    output: requiredString(args, "output"),
    force: args.get("force") === true
  };
  const manifest = optionalString(args, "manifest");
  const title = optionalString(args, "title");
  if (manifest) parsed.manifest = manifest;
  if (title) parsed.title = title;
  return parsed;
}

export function defaultManifestPath(output: string): string {
  const parsed = parse(output);
  const baseName = parsed.name === "meta" || parsed.name === "content" ? parse(parsed.dir).name : parsed.name;
  return resolve("data/authorization/derivative-manifests", `${baseName}.json`);
}

export async function prepareOutput(path: string, force: boolean): Promise<void> {
  if (!force && (await exists(path))) {
    throw new Error(`Output already exists: ${path}. Pass --force to overwrite.`);
  }
  await mkdir(dirname(path), { recursive: true });
}

export async function writeManifest(path: string, manifest: DerivativeManifest): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with code ${code ?? "unknown"}`));
    });
  });
}

function requiredString(args: Map<string, string | boolean>, key: string): string {
  const value = args.get(key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`--${key} is required.`);
  }
  return value;
}

function optionalString(args: Map<string, string | boolean>, key: string): string | undefined {
  const value = args.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function validateDerivativePaths(options: CommonDerivativeOptions, manifest: string): Promise<void> {
  const contains = (directory: string, file: string) => {
    const path = relative(resolve(directory), resolve(file));
    return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
  };
  const directory = await realpath(dirname(resolve(options.output)));
  const source = await realpath(options.input);
  const manifestLocation = resolve(await realpath(dirname(resolve(manifest))), parse(manifest).base);
  const privateManifest = await realpath(manifestLocation).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return manifestLocation;
    throw error;
  });
  const masterRoot = await realpath(resolve("data/assets/master")).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolve("data/assets/master");
    throw error;
  });
  if (contains(directory, source) || contains(masterRoot, directory)) {
    throw new Error("Derivative output must be separate from preservation masters.");
  }
  if (privateManifest === source || contains(masterRoot, privateManifest)) {
    throw new Error("A processing manifest must not replace preservation masters.");
  }
  if (contains(directory, privateManifest)) {
    throw new Error("The private processing manifest must be outside the public bundle.");
  }
}


export async function directorySize(path: string): Promise<number> {
  const entries = await readdir(path, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(entry => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? directorySize(child) : fileSize(child);
  }));
  return sizes.reduce((sum, size) => sum + size, 0);
}

// A failed level must not leave a partly updated public bundle. Build next to
// the destination, then replace the directory, retaining the old one on error.
export async function stageDerivative<T>(output: string, force: boolean, build: (directory: string) => Promise<T>): Promise<T> {
  const destination = dirname(resolve(output));
  if (destination === process.cwd() || !["meta.json", "content.glb"].includes(parse(output).base)) {
    throw new Error("Use content.glb or meta.json in a dedicated derivative directory.");
  }
  if (await exists(destination)) {
    const allowed = /^(content\.glb|meta\.json|lod\.json|lod|stream|editing|[A-Za-z0-9_-]+\.webp)$/;
    if ((await readdir(destination)).some(name => !allowed.test(name))) {
      throw new Error("Refusing to replace a directory containing non-derivative files.");
    }
  }
  await prepareOutput(output, force);
  const staging = await mkdtemp(resolve(dirname(destination), ".derivative-"));
  const backup = `${staging}.previous`;
  let moved = false;
  try {
    const result = await build(staging);
    if (await exists(destination)) { await rename(destination, backup); moved = true; }
    try { await rename(staging, destination); }
    catch (error) { if (moved) await rename(backup, destination); throw error; }
    await rm(backup, { recursive: true, force: true });
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
