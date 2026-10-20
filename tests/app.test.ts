import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type {
  ArtifactRecord,
  ArtifactRepository,
  ArtifactSearch
} from "../src/artifacts/ArtifactRepository.js";
import type { AppConfig } from "../src/config.js";

const artifact: ArtifactRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Test Mesh",
  description: "Public test asset",
  type: "mesh",
  thumbnailPath: "thumbnails/test-thumbnail.webp",
  contentPath: "derivatives/test-mesh/content.glb",
  contentFilename: "content.glb",
  mimeType: "model/gltf-binary",
  sizeBytes: 10
};

const sogArtifact: ArtifactRecord = {
  ...artifact,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Test SOG",
  type: "splat",
  thumbnailPath: null,
  contentPath: "derivatives/test-sog/meta.json",
  contentFilename: "meta.json",
  mimeType: "application/json"
};

class TestRepository implements ArtifactRepository {
  lastSearch?: ArtifactSearch;

  constructor(private readonly record: ArtifactRecord | null = artifact) {}

  async search(search: ArtifactSearch) {
    this.lastSearch = search;
    return { items: this.record ? [this.record] : [], nextCursor: null };
  }

  async findById(artifactId: string) {
    return artifactId === this.record?.id ? this.record : null;
  }
}

const config: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 8080,
  databaseUrl: "postgresql://unused",
  artifactRoot: resolve("tests/fixtures")
};

let app: FastifyInstance | undefined;
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "delivery-test-"));
  config.artifactRoot = root;
  await mkdir(join(root, "derivatives/test-mesh"), { recursive: true });
  await mkdir(join(root, "derivatives/test-sog"), { recursive: true });
  await mkdir(join(root, "thumbnails"));
  await cp("tests/fixtures/test-model.glb", join(root, artifact.contentPath));
  await cp("tests/fixtures/test-thumbnail.webp", join(root, artifact.thumbnailPath!));
  const meta = { version: 2, count: 1,
    means: { files: ["means_l.webp", "means_u.webp"] }, scales: { files: ["scales.webp"] },
    quats: { files: ["quats.webp"] }, sh0: { files: ["sh0.webp"] } };
  await writeFile(join(root, sogArtifact.contentPath), JSON.stringify(meta));
  for (const file of ["means_l.webp", "means_u.webp", "scales.webp", "quats.webp", "sh0.webp"]) {
    await writeFile(join(root, "derivatives/test-sog", file), "texture");
  }
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(root, { recursive: true, force: true });
});

describe("public artifact catalog", () => {
  it("returns catalog results without authentication", async () => {
    const repository = new TestRepository();
    app = await buildApp({ config, repository });
    const response = await app.inject({ method: "GET", url: "/api/v1/artifacts?query=test&type=mesh" });
    expect(response.statusCode).toBe(200);
    expect(repository.lastSearch).toMatchObject({ query: "test", type: "mesh", limit: 24 });
    expect(response.json().items[0].contentUrl).toBe(`/files/${artifact.id}/content.glb`);
  });

  it("returns one public artifact by id", async () => {
    app = await buildApp({ config, repository: new TestRepository() });
    const response = await app.inject({ method: "GET", url: `/api/v1/artifacts/${artifact.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(artifact.id);
  });
});

describe("public derivative file boundary", () => {
  it("advertises LOD and serves compressed mappings with native HTTP decoding", async () => {
    const directory = join(root, "derivatives/test-mesh");
    await mkdir(join(directory, "editing"));
    const levels = [0.7, 0.5, 0.3].map((ratio, level) => ({ level, ratio, count: 7 - level * 2,
      file: level === 0 ? "content.glb" : `lod/${level}/content.glb` }));
    for (const level of levels.slice(1)) {
      await mkdir(join(directory, "lod", String(level.level)), { recursive: true });
      await writeFile(join(directory, level.file), "lower detail");
      await writeFile(join(directory, `editing/to-${level.level}.bin.gz`), gzipSync(new Uint8Array(7 * 4)));
      await writeFile(join(directory, `editing/from-${level.level}.bin.gz`), gzipSync(new Uint8Array(level.count * 4)));
    }
    const centers = new Uint8Array(7 * 12);
    await writeFile(join(directory, "editing/centers.bin.gz"), gzipSync(centers));
    await writeFile(join(directory, "lod.json"), JSON.stringify({ version: 1, kind: "mesh", levels, editing: {
      centers: "editing/centers.bin.gz", parts: [[7], [5], [3]], chunks: [],
      levels: [{ identity: true }, ...[1, 2].map(level => ({ to: `editing/to-${level}.bin.gz`, from: `editing/from-${level}.bin.gz` }))]
    } }));
    app = await buildApp({ config, repository: new TestRepository() });
    const item = await app.inject(`/api/v1/artifacts/${artifact.id}`);
    expect(item.json().lodUrl).toBe(`/files/${artifact.id}/lod.json`);
    const response = await app.inject(`/files/${artifact.id}/editing/centers.bin.gz`);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(gunzipSync(response.rawPayload)).toEqual(Buffer.from(centers));
    const mesh = await app.inject(`/files/${artifact.id}/lod/2/content.glb`);
    expect(mesh.statusCode).toBe(200);
    expect(mesh.headers["content-type"]).toContain("model/gltf-binary");
  });
  it("returns registered derivative file bytes without authentication", async () => {
    app = await buildApp({ config, repository: new TestRepository() });
    const response = await app.inject({ method: "GET", url: `/files/${artifact.id}/content.glb` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toBe("test-model\n");
  });

  it("returns registered thumbnail bytes without authentication", async () => {
    app = await buildApp({ config, repository: new TestRepository() });
    const response = await app.inject({ method: "GET", url: `/files/${artifact.id}/thumbnail` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/webp");
  });

  it("allows SOG component files only within the registered derivative directory", async () => {
    app = await buildApp({ config, repository: new TestRepository(sogArtifact) });
    const response = await app.inject({ method: "GET", url: `/files/${sogArtifact.id}/means_l.webp` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/webp");
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("does not serve unregistered files for mesh artifacts", async () => {
    app = await buildApp({ config, repository: new TestRepository() });
    const response = await app.inject({ method: "GET", url: `/files/${artifact.id}/other-file.glb` });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a master registered as catalog content", async () => {
    await mkdir(join(root, "master"));
    await writeFile(join(root, "master/content.glb"), "private");
    app = await buildApp({ config, repository: new TestRepository({ ...artifact, contentPath: "master/content.glb" }) });
    expect((await app.inject(`/files/${artifact.id}/content.glb`)).statusCode).toBe(404);
  });

  it("rejects unreferenced SOG siblings, traversal and symlinked components", async () => {
    await writeFile(join(root, "derivatives/test-sog/private.ply"), "private");
    app = await buildApp({ config, repository: new TestRepository(sogArtifact) });
    for (const path of ["private.ply", "%2e%2e/master.ply", "stream/%252e%252e/meta.json", "%2fetc/passwd"]) {
      expect((await app.inject(`/files/${sogArtifact.id}/${path}`)).statusCode).not.toBe(200);
    }
    await rm(join(root, "derivatives/test-sog/means_l.webp"));
    await symlink(join(root, "derivatives/test-sog/private.ply"), join(root, "derivatives/test-sog/means_l.webp"));
    expect((await app.inject(`/files/${sogArtifact.id}/means_l.webp`)).statusCode).toBe(404);
  });

  it("preserves byte ranges for streamed loading", async () => {
    app = await buildApp({ config, repository: new TestRepository() });
    const response = await app.inject({ url: `/files/${artifact.id}/content.glb`, headers: { range: "bytes=0-3" } });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe("test");
  });

  it("returns 404 for unknown artifacts", async () => {
    app = await buildApp({ config, repository: new TestRepository(null) });
    const response = await app.inject({ method: "GET", url: `/files/${artifact.id}/content.glb` });
    expect(response.statusCode).toBe(404);
  });
});
