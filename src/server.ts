import "dotenv/config";
import { buildApp } from "./app.js";
import { OidcAccessTokenVerifier } from "./auth/AccessTokenVerifier.js";
import {
  DemoSessionRequestAuthenticator,
  OidcBearerRequestAuthenticator
} from "./auth/RequestAuthenticator.js";
import { PrismaArtifactRepository } from "./artifacts/PrismaArtifactRepository.js";
import { loadConfig } from "./config.js";
import { createPrismaClient } from "./database.js";

const config = loadConfig();
const prisma = createPrismaClient(config.databaseUrl);
const authenticator = config.auth.mode === "oidc-bearer"
  ? new OidcBearerRequestAuthenticator(new OidcAccessTokenVerifier(config.auth))
  : new DemoSessionRequestAuthenticator();
const app = await buildApp({
  config,
  repository: new PrismaArtifactRepository(prisma),
  authenticator
});

async function close(signal: string) {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.once("SIGINT", () => void close("SIGINT"));
process.once("SIGTERM", () => void close("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, "Unable to start artifact service");
  await prisma.$disconnect();
  process.exit(1);
}
