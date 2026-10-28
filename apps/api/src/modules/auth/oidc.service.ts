import { Injectable } from '@nestjs/common';
import { Issuer, Strategy, generators } from 'openid-client';

/**
 * FP-008: OIDC Service (Phase 2)
 * Handles OAuth2/OIDC authentication flow
 * Supports: Keycloak, Auth0, Google, etc.
 */
@Injectable()
export class OidcService {
  private issuer: Issuer | null = null;
  private client: any = null;

  constructor() {
    this.initializeOidc();
  }

  private async initializeOidc() {
    const providerUrl = process.env.OIDC_PROVIDER_URL;
    if (!providerUrl) {
      console.warn('OIDC_PROVIDER_URL not set, OIDC disabled');
      return;
    }

    try {
      this.issuer = await Issuer.discover(providerUrl);
      this.client = new this.issuer.Client({
        client_id: process.env.OIDC_CLIENT_ID || '',
        client_secret: process.env.OIDC_CLIENT_SECRET || '',
        redirect_uris: [process.env.OIDC_REDIRECT_URI || 'http://localhost:3000/auth/callback'],
      });
    } catch (error) {
      console.error('Failed to initialize OIDC:', error);
    }
  }

  /**
   * FP-008: Generate authorization URL for login
   * User redirects to OIDC provider
   */
  getAuthorizationUrl(): string {
    if (!this.client) {
      throw new Error('OIDC not configured');
    }

    const nonce = generators.nonce();
    const state = generators.state();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);

    // Store state/nonce/verifier in session (TODO: Redis)
    // sessionStorage[state] = { nonce, codeVerifier }

    return this.client.authorizationUrl({
      scope: 'openid profile email',
      response_type: 'code',
      response_mode: 'form_post',
      nonce,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
  }

  /**
   * FP-008: Handle OIDC callback
   * Exchange code for tokens
   */
  async handleCallback(code: string, state: string) {
    if (!this.client) {
      throw new Error('OIDC not configured');
    }

    // Retrieve state/nonce from session (TODO: Redis)
    // const session = sessionStorage[state]

    const tokenSet = await this.client.callback(
      process.env.OIDC_REDIRECT_URI || 'http://localhost:3000/auth/callback',
      { code },
      { state }, // verify state
    );

    const userInfo = await this.client.userinfo(tokenSet);

    return {
      accessToken: tokenSet.access_token,
      refreshToken: tokenSet.refresh_token,
      idToken: tokenSet.id_token,
      expiresIn: tokenSet.expires_in,
      user: {
        sub: userInfo.sub,
        email: userInfo.email,
        name: userInfo.name,
        picture: userInfo.picture,
      },
    };
  }

  /**
   * FP-008: Refresh access token
   */
  async refreshToken(refreshToken: string) {
    if (!this.client) {
      throw new Error('OIDC not configured');
    }

    const tokenSet = await this.client.refresh(refreshToken);
    return {
      accessToken: tokenSet.access_token,
      expiresIn: tokenSet.expires_in,
    };
  }

  /**
   * FP-008: Logout
   */
  async logout(idToken: string) {
    if (!this.client || !this.issuer) {
      return null;
    }

    return this.issuer.end_session_endpoint
      ? this.client.end_session_url({ id_token_hint: idToken })
      : null;
  }
}
