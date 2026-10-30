import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

const mockPrisma = {
  user: { findUnique: jest.fn(), update: jest.fn() },
  refreshToken: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  authSession: { create: jest.fn().mockResolvedValue({ id: 'session1', expiresAt: new Date(Date.now() + 86_400_000) }) },
};

const mockJwt = {
  sign: jest.fn().mockReturnValue('mock.jwt.token'),
  verify: jest.fn(),
};

const mockUser = {
  id: 'user1',
  email: 'test@vpnet.kz',
  passwordHash: bcrypt.hashSync('Password123', 10),
  firstName: 'Эрлан',
  lastName: 'Дарвичев',
  isActive: true,
  tenantId: 'tenant1',
  organizationId: 'org1',
  lastLoginAt: null,
  organization: { id: 'org1', name: 'VPNET' },
  userRoles: [
    {
      role: {
        name: 'admin',
        permissions: [
          { permission: { module: 'catalog', action: 'read', resource: 'item' } },
        ],
      },
    },
  ],
};

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe('login', () => {
    it('возвращает токены при правильных учётных данных', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.user.update.mockResolvedValue(mockUser);
      mockPrisma.refreshToken.create.mockResolvedValue({ token: 'refresh-token' });

      const result = await service.login({ email: 'test@vpnet.kz', password: 'Password123' });

      expect(result).toHaveProperty('accessToken');
      expect(result).toHaveProperty('refreshToken');
      expect(result.user.email).toBe('test@vpnet.kz');
    });

    it('выбрасывает UnauthorizedException если пользователь не найден', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.login({ email: 'wrong@test.kz', password: 'pass' }))
        .rejects.toThrow(UnauthorizedException);
    });

    it('выбрасывает UnauthorizedException если пароль неверный', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      await expect(service.login({ email: 'test@vpnet.kz', password: 'wrong-pass' }))
        .rejects.toThrow(UnauthorizedException);
    });

    it('выбрасывает UnauthorizedException если пользователь не активен', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ ...mockUser, isActive: false });
      await expect(service.login({ email: 'test@vpnet.kz', password: 'Password123' }))
        .rejects.toThrow(UnauthorizedException);
    });

    it('обновляет lastLoginAt при успешном входе', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(mockUser);
      mockPrisma.user.update.mockResolvedValue(mockUser);
      mockPrisma.refreshToken.create.mockResolvedValue({ token: 'refresh-token' });

      await service.login({ email: 'test@vpnet.kz', password: 'Password123' });

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ lastLoginAt: expect.any(Date) }) }),
      );
    });
  });
});
