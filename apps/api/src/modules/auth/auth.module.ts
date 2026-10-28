import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OidcService } from './oidc.service';
import { JwtStrategy } from './jwt.strategy';

// FP-008: Auth module with JWT + OIDC support
@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      useFactory: () => ({
        secret: process.env.JWT_SECRET || 'flowpos-secret',
        // FP-008: Short-lived access tokens (15min default, not 7d)
        signOptions: { expiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, OidcService, JwtStrategy],
  exports: [AuthService, OidcService, JwtModule],
})
export class AuthModule {}
