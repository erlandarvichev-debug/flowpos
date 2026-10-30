import { Controller, Post, Body, Get, Delete, Param, UseGuards, Request, Res } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

const COOKIE = 'fp_refresh';
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 30 * 24 * 60 * 60 * 1000,
  path: '/api/v1/auth',
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService, private mfa: MfaService) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Request() req: any, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto, { ip: req.ip, userAgent: req.headers?.['user-agent'] });
    if (result.mfaRequired) return result; // второй шаг — POST /auth/mfa/login
    res.cookie(COOKIE, result.refreshToken, COOKIE_OPTS);
    const { refreshToken: _, ...safe } = result;
    return safe;
  }

  /** Второй шаг входа при включённой MFA: токен-вызов из /auth/login + код из приложения или код восстановления. */
  @Post('mfa/login')
  async mfaLogin(@Body() b: { mfaToken: string; code: string }, @Request() req: any, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.completeMfaLogin(b?.mfaToken, b?.code, { ip: req.ip, userAgent: req.headers?.['user-agent'] });
    res.cookie(COOKIE, result.refreshToken, COOKIE_OPTS);
    const { refreshToken: _, ...safe } = result;
    return safe;
  }

  /** Подключение MFA, шаг 1: секрет и ссылка otpauth:// для приложения-аутентификатора. */
  @Post('mfa/setup')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  mfaSetup(@Request() req) {
    return this.mfa.setup(req.user.sub);
  }

  /** Подключение MFA, шаг 2: код из приложения; в ответе — одноразовые коды восстановления (показываются один раз). */
  @Post('mfa/enable')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  mfaEnable(@Request() req, @Body() b: { code: string }) {
    return this.mfa.enable(req.user.sub, req.user.sid, b?.code);
  }

  @Post('mfa/disable')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  mfaDisable(@Request() req, @Body() b: { code: string }) {
    return this.mfa.disable(req.user.sub, req.user.sid, b?.code);
  }

  /** Подтвердить текущую сессию кодом — для привилегированных операций. */
  @Post('mfa/step-up')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  mfaStepUp(@Request() req, @Body() b: { code: string }) {
    return this.mfa.stepUp(req.user.sub, req.user.sid, b?.code);
  }

  @Post('mfa/recovery-codes')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  mfaRecovery(@Request() req, @Body() b: { code: string }) {
    return this.mfa.regenerateRecovery(req.user.sub, b?.code);
  }

  @Post('refresh')
  async refresh(@Request() req: any, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[COOKIE];
    if (!token) return res.status(401).json({ message: 'No refresh token' });
    const result = await this.auth.refresh(token);
    res.cookie(COOKIE, result.refreshToken, COOKIE_OPTS);
    return { accessToken: result.accessToken };
  }

  @Post('logout')
  async logout(@Request() req: any, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[COOKIE];
    if (token) await this.auth.logout(token);
    res.clearCookie(COOKIE, { path: '/api/v1/auth' });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  me(@Request() req) {
    return this.auth.me(req.user.sub);
  }

  /** Мои действующие сессии (устройства); текущая помечена. */
  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  sessions(@Request() req) {
    return this.auth.sessions(req.user.sub, req.user.sid);
  }

  /** Завершить одну свою сессию. */
  @Delete('sessions/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  revokeSession(@Request() req, @Param('id') id: string) {
    return this.auth.revokeSession(req.user.sub, id);
  }

  /** Выйти на всех остальных устройствах. */
  @Post('sessions/revoke-others')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  revokeOthers(@Request() req) {
    return this.auth.revokeOtherSessions(req.user.sub, req.user.sid);
  }
}
