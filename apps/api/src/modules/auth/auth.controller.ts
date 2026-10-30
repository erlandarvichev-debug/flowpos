import { Controller, Post, Body, Get, UseGuards, Request, Res } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthService } from './auth.service';
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
  constructor(private auth: AuthService) {}

  @Post('login')
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto);
    res.cookie(COOKIE, result.refreshToken, COOKIE_OPTS);
    const { refreshToken: _, ...safe } = result;
    return safe;
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
}
