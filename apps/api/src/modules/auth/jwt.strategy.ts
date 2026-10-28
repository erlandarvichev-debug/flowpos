import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

// FP-008: JWT payload structure (tenantId, grants-based)
export interface JwtPayload {
  sub: string; // user ID
  email: string;
  tenantId: string;
  organizationId: string;
  grants: Array<{
    organizationId: string;
    action: string;
    scope: string;
  }>;
  iat: number;
  exp: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'flowpos-secret',
    });
  }

  // FP-008: Validate JWT structure
  async validate(payload: JwtPayload) {
    return {
      sub: payload.sub,
      email: payload.email,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      grants: payload.grants,
    };
  }
}
