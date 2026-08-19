import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { spawn } from "node:child_process";

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
