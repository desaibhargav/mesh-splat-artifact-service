import puppeteer from "puppeteer";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, stat, unlink } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { exists } from "./derivative-utils.js";

type ThumbnailType = "mesh" | "splat";

interface ThumbnailOptions {
  input: string;
  output: string;
  type?: ThumbnailType;
  width: number;
  height: number;
  force: boolean;
}

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 900;
const DEFAULT_TIMEOUT_MS = 180_000;
const BACKGROUND = { r: 0.13, g: 0.13, b: 0.13, a: 1 };
const assetRoot = resolve("data/assets");
const playcanvasModule = resolve("node_modules/playcanvas/build/playcanvas.mjs");

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const type = options.type ?? inferType(options.input);

  if (!options.force && (await exists(options.output))) {
    throw new Error(`Output already exists: ${options.output}. Pass --force to overwrite.`);
  }

  await mkdir(dirname(options.output), { recursive: true });

  if (type === "splat") {
    await generateSplatThumbnail(options);
  } else {
    await generateMeshThumbnail(options);
  }

  console.log(`Wrote thumbnail: ${options.output}`);
}

async function generateSplatThumbnail(options: ThumbnailOptions) {
  await generateBrowserThumbnail(options, "splat");
}

async function generateMeshThumbnail(options: ThumbnailOptions) {
  await generateBrowserThumbnail(options, "mesh");
}

async function generateBrowserThumbnail(options: ThumbnailOptions, type: ThumbnailType) {
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start thumbnail server.");

  const assetUrl = `/assets/${encodePath(relative(assetRoot, resolve(options.input)))}`;
  const pageUrl = new URL(`http://127.0.0.1:${address.port}/thumbnail-renderer.html`);
  pageUrl.searchParams.set("asset", assetUrl);
  pageUrl.searchParams.set("width", String(options.width));
  pageUrl.searchParams.set("height", String(options.height));
  pageUrl.searchParams.set("background", `${BACKGROUND.r},${BACKGROUND.g},${BACKGROUND.b},${BACKGROUND.a}`);
  pageUrl.searchParams.set("type", type);

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--hide-scrollbars"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: options.width, height: options.height, deviceScaleFactor: 1 });
    const timeoutMs = thumbnailTimeoutMs();
    await page.goto(pageUrl.href, { waitUntil: "load", timeout: timeoutMs });
    await page.waitForFunction(() => (window as unknown as { __thumbnailReady?: boolean }).__thumbnailReady === true, {
      timeout: timeoutMs
    });

    const canvas = await page.$("canvas");
    if (!canvas) throw new Error("Thumbnail renderer did not create a canvas.");
    await canvas.screenshot({ path: options.output, type: "webp" });
  } finally {
    await browser.close();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/thumbnail-renderer.html") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(thumbnailRendererHtml());
    return;
  }

  if (url.pathname === "/vendor/playcanvas.mjs") {
    await sendFile(response, playcanvasModule, "text/javascript; charset=utf-8");
    return;
  }

  if (url.pathname === "/favicon.ico") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    const relativeAssetPath = decodeURIComponent(url.pathname.slice("/assets/".length));
    const file = resolve(assetRoot, relativeAssetPath);
    if (!isWithin(assetRoot, file)) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    await sendFile(response, file, mimeType(file));
    return;
  }

  response.writeHead(404);
  response.end("Not found");
}

async function sendFile(response: ServerResponse, file: string, contentType: string) {
  await stat(file);
  response.writeHead(200, { "content-type": contentType });
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("end", resolvePromise);
    stream.pipe(response);
  });
}

function thumbnailRendererHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Mesh thumbnail renderer</title>
  <style>
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #212121; }
    canvas { display: block; width: 100vw; height: 100vh; }
  </style>
</head>
<body>
  <canvas id="thumbnail"></canvas>
  <script type="module">
    import * as pc from "/vendor/playcanvas.mjs";

    const params = new URLSearchParams(location.search);
    const assetUrl = params.get("asset");
    const width = Number(params.get("width") || 1200);
    const height = Number(params.get("height") || 900);
    const background = (params.get("background") || "0.13,0.13,0.13,1").split(",").map(Number);
    const canvas = document.getElementById("thumbnail");
    canvas.width = width;
    canvas.height = height;

    const app = new pc.Application(canvas, {
      graphicsDeviceOptions: {
        antialias: true,
        preserveDrawingBuffer: true
      }
    });
    app.setCanvasFillMode(pc.FILLMODE_NONE);
    app.setCanvasResolution(pc.RESOLUTION_FIXED, width, height);
    app.scene.ambientLight = new pc.Color(0.38, 0.38, 0.38);
    app.start();

    const camera = new pc.Entity("thumbnail camera");
    camera.addComponent("camera", {
      clearColor: new pc.Color(background[0], background[1], background[2], background[3]),
      fov: 45,
      nearClip: 0.001,
      farClip: 1000
    });
    app.root.addChild(camera);

    const key = new pc.Entity("key light");
    key.setEulerAngles(45, 35, 0);
    key.addComponent("light", { type: "directional", intensity: 1.15 });
    app.root.addChild(key);

    const fill = new pc.Entity("fill light");
    fill.setEulerAngles(-45, -145, 0);
    fill.addComponent("light", { type: "directional", intensity: 0.35 });
    app.root.addChild(fill);

    function frameEntity(entity) {
      const renderComponents = entity.findComponents("render");
      const meshInstances = renderComponents.flatMap((component) => component.meshInstances || []);
      if (!meshInstances.length) throw new Error("No mesh instances found.");

      const bounds = new pc.BoundingBox();
      meshInstances.forEach((instance, index) => {
        if (index === 0) bounds.copy(instance.aabb);
        else bounds.add(instance.aabb);
      });

      const focus = bounds.center;
      const radius = Math.max(bounds.halfExtents.x, bounds.halfExtents.y, bounds.halfExtents.z, 0.01);
      camera.setPosition(focus.x, focus.y, focus.z + radius * 3.3);
      camera.lookAt(focus);
      camera.camera.nearClip = Math.max(radius / 1000, 0.001);
      camera.camera.farClip = Math.max(radius * 100, 1000);
    }

    function frameBounds(bounds, transformCenter) {
      const focus = transformCenter ? transformCenter(bounds.center.clone()) : bounds.center.clone();
      const radius = Math.max(bounds.halfExtents.x, bounds.halfExtents.y, bounds.halfExtents.z, 0.01);
      camera.setPosition(focus.x, focus.y, focus.z + radius * 3.3);
      camera.lookAt(focus);
      camera.camera.nearClip = Math.max(radius / 1000, 0.001);
      camera.camera.farClip = Math.max(radius * 100, 1000);
    }

    function waitFrames(count) {
      return new Promise((resolve) => {
        let remaining = count;
        const tick = () => {
          remaining -= 1;
          if (remaining <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    }

    if (!assetUrl) throw new Error("Missing asset URL.");
    const type = params.get("type") || "mesh";
    app.assets.loadFromUrl(assetUrl, type === "splat" ? "gsplat" : "container", async (error, asset) => {
      if (error) {
        window.__thumbnailError = String(error);
        throw new Error(String(error));
      }

      if (type === "splat") {
        const entity = new pc.Entity("thumbnail splat");
        entity.setEulerAngles(0, 0, 180);
        entity.addComponent("gsplat", { asset, unified: true });
        app.root.addChild(entity);
        await waitFrames(20);
        if (!asset.resource?.aabb) throw new Error("Splat asset did not expose a bounding box.");
        frameBounds(asset.resource.aabb, (center) => center.set(-center.x, -center.y, center.z));
      } else {
        const entity = asset.resource.instantiateRenderEntity();
        app.root.addChild(entity);
        await waitFrames(4);
        frameEntity(entity);
      }

      await waitFrames(20);
      window.__thumbnailReady = true;
    });
  </script>
</body>
</html>`;
}

function inferType(input: string): ThumbnailType {
  const extension = extname(input).toLowerCase();
  if (extension === ".glb") return "mesh";
  if (extension === ".json") return "splat";
  throw new Error(`Could not infer thumbnail type from input path: ${input}. Pass --type mesh or --type splat.`);
}

function parseArgs(argv: string[]): ThumbnailOptions {
  const args = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "force") {
      args.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args.set(key, value);
    index += 1;
  }

  const type = optionalType(args, "type");
  return {
    input: requiredString(args, "input"),
    output: requiredString(args, "output"),
    ...(type ? { type } : {}),
    width: optionalNumber(args, "width") ?? DEFAULT_WIDTH,
    height: optionalNumber(args, "height") ?? DEFAULT_HEIGHT,
    force: args.get("force") === true
  };
}

function requiredString(args: Map<string, string | boolean>, key: string): string {
  const value = args.get(key);
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${key} is required.`);
  return value;
}

function optionalNumber(args: Map<string, string | boolean>, key: string): number | undefined {
  const value = args.get(key);
  if (typeof value !== "string") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`--${key} must be a positive number.`);
  return number;
}

function optionalType(args: Map<string, string | boolean>, key: string): ThumbnailType | undefined {
  const value = args.get(key);
  if (value === undefined) return undefined;
  if (value === "mesh" || value === "splat") return value;
  throw new Error(`--${key} must be mesh or splat.`);
}

function thumbnailTimeoutMs(): number {
  const configured = Number(process.env.THUMBNAIL_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TIMEOUT_MS;
  return configured;
}

function mimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".mjs" || extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".glb") return "model/gltf-binary";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".webp") return "image/webp";
  return "application/octet-stream";
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function isWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath.length > 0 && !relativePath.startsWith("..") && !relativePath.includes("\0");
}

main().catch(async (error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  else console.error(error);
  if (process.argv.includes("--output")) {
    const outputIndex = process.argv.indexOf("--output") + 1;
    const output = process.argv[outputIndex];
    if (output) await unlink(`${output}.tmp.webp`).catch(() => undefined);
  }
  process.exitCode = 1;
});
