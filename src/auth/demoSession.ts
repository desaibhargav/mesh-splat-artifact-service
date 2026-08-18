import crypto from "node:crypto";
import secureSession from "@fastify/secure-session";
import { verify } from "argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AuthConfig } from "../config.js";

declare module "@fastify/secure-session" {
  interface SessionData {
    subject: string;
  }
}

const credentialsSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(1_000)
});

export async function registerDemoSession(
  app: FastifyInstance,
  config: Extract<AuthConfig, { mode: "demo-session" }>,
  production: boolean
) {
  await app.register(secureSession, {
    key: config.sessionKey,
    cookieName: "mesh_splat_demo",
    expiry: config.sessionTtlSeconds,
    cookie: {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
      secure: production
    }
  });

  app.get("/api/v1/auth/session", { config: { rateLimit: false } }, async (request, reply) => {
    const subject = request.session.get("subject");
    if (typeof subject !== "string") return reply.code(401).send({ authenticated: false });
    return { authenticated: true, subject };
  });

  app.post(
    "/api/v1/auth/session",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const credentials = credentialsSchema.parse(request.body);
      const usernameMatches = timingSafeTextEqual(credentials.username, config.username);
      const passwordMatches = await verify(config.passwordHash, credentials.password);
      if (!usernameMatches || !passwordMatches) {
        return reply.code(401).send({
          error: { code: "invalid_credentials", message: "The username or password is incorrect." }
        });
      }
      request.session.set("subject", `demo:${config.username}`);
      return reply.code(204).send();
    }
  );

  app.delete("/api/v1/auth/session", async (request, reply) => {
    request.session.delete();
    return reply.code(204).send();
  });
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  if (leftBytes.length !== rightBytes.length) return false;
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}
