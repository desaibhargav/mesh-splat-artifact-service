import type { FastifyRequest } from "fastify";
import type { AccessTokenVerifier, Principal } from "./AccessTokenVerifier.js";
import { HttpError } from "../errors/HttpError.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface RequestAuthenticator {
  authenticate(request: FastifyRequest): Promise<Principal>;
}

export class OidcBearerRequestAuthenticator implements RequestAuthenticator {
  constructor(private readonly verifier: AccessTokenVerifier) {}

  async authenticate(request: FastifyRequest): Promise<Principal> {
    const authorization = request.headers.authorization;
    const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);

    if (!match?.[1]) {
      throw new HttpError(401, "authentication_required", "A bearer access token is required.");
    }

    try {
      const principal = await this.verifier.verify(match[1]);
      request.principal = principal;
      return principal;
    } catch {
      throw new HttpError(401, "invalid_access_token", "The access token is invalid or expired.");
    }
  }
}

export class DemoSessionRequestAuthenticator implements RequestAuthenticator {
  async authenticate(request: FastifyRequest): Promise<Principal> {
    const subject = request.session.get("subject");
    if (typeof subject !== "string" || subject.length === 0) {
      throw new HttpError(401, "authentication_required", "An authenticated session is required.");
    }
    const principal = { subject };
    request.principal = principal;
    return principal;
  }
}
