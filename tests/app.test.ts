import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hash } from "argon2";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { AccessTokenVerifier } from "../src/auth/AccessTokenVerifier.js";
import { OidcBearerRequestAuthenticator } from "../src/auth/RequestAuthenticator.js";
import { DemoSessionRequestAuthenticator } from "../src/auth/RequestAuthenticator.js";
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

const verifier: AccessTokenVerifier = {
  async verify(token) {
    if (token === "valid-token") return { subject: "professor" };
    if (token === "attacker-token") return { subject: "attacker" };
    throw new Error("invalid");
  }
};
const authenticator = new OidcBearerRequestAuthenticator(verifier);

class TestRepository implements ArtifactRepository {
  lastSearch?: ArtifactSearch;

  constructor(private readonly record: ArtifactRecord = artifact) {}

  async searchAuthorized(search: ArtifactSearch) {
    this.lastSearch = search;
    return { items: [this.record], nextCursor: null };
  }

  async findAuthorizedById(subject: string, artifactId: string) {
    return subject === "professor" && artifactId === this.record.id ? this.record : null;
  }
}

const config: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 8080,
  databaseUrl: "postgresql://unused",
  artifactRoot: resolve("tests/fixtures"),
  auth: {
    mode: "oidc-bearer",
    issuer: "https://identity.example.edu",
    audience: "test",
    jwksUri: "https://identity.example.edu/jwks"
  }
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("artifact security boundary", () => {
  it("rejects a catalog request without a bearer token", async () => {
    app = await buildApp({ config, repository: new TestRepository(), authenticator });
    const response = await app.inject({ method: "GET", url: "/api/v1/artifacts" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("authentication_required");
  });

  it("does not trust an identity header supplied by the gateway", async () => {
    app = await buildApp({ config, repository: new TestRepository(), authenticator });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts",
      headers: { "x-authenticated-user": "professor" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("filters catalog results using the independently verified subject", async () => {
    const repository = new TestRepository();
    app = await buildApp({ config, repository, authenticator });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts?query=test&type=mesh",
      headers: { authorization: "Bearer valid-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(repository.lastSearch?.subject).toBe("professor");
    expect(response.json().items[0].contentUrl).toBe(`/files/${artifact.id}/test-model.glb`);
  });

  it("rechecks artifact authorization before returning file bytes", async () => {
    app = await buildApp({ config, repository: new TestRepository(), authenticator });
    const response = await app.inject({
      method: "GET",
      url: `/files/${artifact.id}/test-model.glb`,
      headers: { authorization: "Bearer valid-token" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).toBe("test-model\n");
  });

  it("limits a valid token to that subject's artifact permissions", async () => {
    app = await buildApp({ config, repository: new TestRepository(), authenticator });
    const response = await app.inject({
      method: "GET",
      url: `/files/${artifact.id}/test-model.glb`,
      headers: { authorization: "Bearer attacker-token" }
    });
    expect(response.statusCode).toBe(404);
  });

  it("rechecks authorization for every component of a streamed SOG artifact", async () => {
    app = await buildApp({ config, repository: new TestRepository(sogArtifact), authenticator });
    const authorized = await app.inject({
      method: "GET",
      url: `/files/${sogArtifact.id}/means_l.webp`,
      headers: { authorization: "Bearer valid-token" }
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.headers["content-type"]).toContain("image/webp");
    expect(authorized.headers["cache-control"]).toBe("private, no-store");

    const unauthorized = await app.inject({
      method: "GET",
      url: `/files/${sogArtifact.id}/means_l.webp`,
      headers: { authorization: "Bearer attacker-token" }
    });
    expect(unauthorized.statusCode).toBe(404);
  });

  it("returns 404 instead of revealing an unauthorized artifact", async () => {
    const repository: ArtifactRepository = {
      async searchAuthorized() {
        return { items: [], nextCursor: null };
      },
      async findAuthorizedById() {
        return null;
      }
    };
    app = await buildApp({ config, repository, authenticator });
    const response = await app.inject({
      method: "GET",
      url: `/files/${artifact.id}/test-model.glb`,
      headers: { authorization: "Bearer valid-token" }
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("temporary professor authentication adapter", () => {
  it("issues an encrypted session and uses it on protected artifact requests", async () => {
    const demoConfig: AppConfig = {
      ...config,
      auth: {
        mode: "demo-session",
        username: "professor",
        passwordHash: await hash("correct-horse-battery-staple"),
        sessionKey: Buffer.alloc(32, 7),
        sessionTtlSeconds: 3_600
      }
    };
    app = await buildApp({
      config: demoConfig,
      repository: new TestRepository(),
      authenticator: new DemoSessionRequestAuthenticator()
    });

    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { username: "professor", password: "correct-horse-battery-staple" }
    });
    expect(login.statusCode).toBe(204);
    const cookie = login.cookies.find(({ name }) => name === "mesh_splat_demo");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Strict");

    const catalog = await app.inject({
      method: "GET",
      url: "/api/v1/artifacts",
      cookies: { mesh_splat_demo: cookie?.value ?? "" }
    });
    expect(catalog.statusCode).toBe(200);
  });

  it("does not issue a session for invalid demo credentials", async () => {
    const demoConfig: AppConfig = {
      ...config,
      auth: {
        mode: "demo-session",
        username: "professor",
        passwordHash: await hash("correct-password"),
        sessionKey: Buffer.alloc(32, 9),
        sessionTtlSeconds: 3_600
      }
    };
    app = await buildApp({
      config: demoConfig,
      repository: new TestRepository(),
      authenticator: new DemoSessionRequestAuthenticator()
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { username: "professor", password: "wrong-password" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.cookies).toHaveLength(0);
  });
});
