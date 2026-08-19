import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  thumbnailPath: "test-thumbnail.webp",
  contentPath: "test-model.glb",
  contentFilename: "test-model.glb",
  mimeType: "model/gltf-binary",
  sizeBytes: 10
};

const sogArtifact: ArtifactRecord = {
  ...artifact,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Test SOG",
  type: "splat",
  thumbnailPath: null,
  contentPath: "test-sog/meta.json",
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
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("public artifact catalog", () => {
  it("returns catalog results without authentication", async () => {
    const repository = new TestRepository();
    app = await buildApp({ config, repository });
    const response = await app.inject({ method: "GET", url: "/api/v1/artifacts?query=test&type=mesh" });
    expect(response.statusCode).toBe(200);
    expect(repository.lastSearch).toMatchObject({ query: "test", type: "mesh", limit: 24 });
    expect(response.json().items[0].contentUrl).toBe(`/files/${artifact.id}/test-model.glb`);
  });

  it("returns one public artifact by id", async () => {
    app = await buildApp({ config, repository: new TestRepository() });
    const response = await app.inject({ method: "GET", url: `/api/v1/artifacts/${artifact.id}` });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(artifact.id);
  });
});

describe("public derivative file boundary", () => {
  it("returns registered derivative file bytes without authentication", async () => {
    app = await buildApp({ config, repository: new TestRepository() });
    const response = await app.inject({ method: "GET", url: `/files/${artifact.id}/test-model.glb` });
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

  it("returns 404 for unknown artifacts", async () => {
    app = await buildApp({ config, repository: new TestRepository(null) });
    const response = await app.inject({ method: "GET", url: `/files/${artifact.id}/test-model.glb` });
    expect(response.statusCode).toBe(404);
  });
});
