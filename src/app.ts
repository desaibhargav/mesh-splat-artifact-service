import fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { RequestAuthenticator } from "./auth/RequestAuthenticator.js";
import type { ArtifactRepository } from "./artifacts/ArtifactRepository.js";
import { registerArtifactRoutes } from "./artifacts/artifactRoutes.js";
import { HttpError } from "./errors/HttpError.js";
import { registerDemoSession } from "./auth/demoSession.js";

export interface AppDependencies {
  config: AppConfig;
  repository: ArtifactRepository;
  authenticator: RequestAuthenticator;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = fastify({
    bodyLimit: 1_048_576,
    logger:
      dependencies.config.environment === "test"
        ? false
        : {
            level: dependencies.config.environment === "production" ? "info" : "debug",
            redact: ["req.headers.authorization", "req.headers.cookie"]
          },
    requestIdHeader: false
  });

  await app.register(helmet, {
    contentSecurityPolicy: false
  });
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute"
  });
  if (dependencies.config.auth.mode === "demo-session") {
    await registerDemoSession(
      app,
      dependencies.config.auth,
      dependencies.config.environment === "production"
    );
  }
  await app.register(fastifyStatic, {
    root: dependencies.config.artifactRoot,
    serve: false
  });

  app.get("/health", { config: { rateLimit: false } }, async () => ({ status: "ok" }));
  await registerArtifactRoutes(app, dependencies);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id }
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "The request is invalid.", requestId: request.id }
      });
    }

    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(500).send({
      error: { code: "internal_error", message: "The request could not be completed.", requestId: request.id }
    });
  });

  return app;
}
