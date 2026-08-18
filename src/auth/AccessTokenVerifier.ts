import { createRemoteJWKSet, jwtVerify } from "jose";

export interface Principal {
  subject: string;
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<Principal>;
}

export interface OidcVerifierOptions {
  issuer: string;
  audience: string;
  jwksUri: string;
}

export class OidcAccessTokenVerifier implements AccessTokenVerifier {
  private readonly keySet;

  constructor(private readonly options: OidcVerifierOptions) {
    if (new URL(options.jwksUri).protocol !== "https:") {
      throw new Error("OIDC_JWKS_URI must use HTTPS.");
    }
    this.keySet = createRemoteJWKSet(new URL(options.jwksUri));
  }

  async verify(token: string): Promise<Principal> {
    const { payload } = await jwtVerify(token, this.keySet, {
      issuer: this.options.issuer,
      audience: this.options.audience,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["exp", "iat", "iss", "aud", "sub"],
      maxTokenAge: "15m"
    });

    if (!payload.sub) {
      throw new Error("The access token has no subject.");
    }

    return { subject: payload.sub };
  }
}
