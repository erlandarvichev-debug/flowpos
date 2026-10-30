import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PosService } from './pos.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope } from '../../common/scope';

// Модели Prisma: pOSTerminal / pOSShift / document. Область (организация) — FP-007;
// проверка на настоящей БД — test/legacy-scope.int-spec.ts.
const mockPrisma = {
  pOSTerminal: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
  pOSShift: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  document: { aggregate: jest.fn() },
};

const s: Scope = { tenantId: 't1', organizationId: 'org1', userId: 'u1' };
const mockTerminal = { id: 'term1', name: 'Касса 1', organizationId: 'org1', isActive: true, storeId: 'st1' };
const openedAt = new Date('2026-10-30T08:00:00Z');
const mockShift = { id: 'shift1', terminalId: 'term1', status: 'OPEN', number: 'CM-000001', openedAt, openBalance: 0, terminal: mockTerminal };

describe('PosService', () => {
  let service: PosService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PosService(mockPrisma as unknown as PrismaService);
  });

  describe('findTerminals', () => {
    it('возвращает активные кассы своей организации', async () => {
      mockPrisma.pOSTerminal.findMany.mockResolvedValue([mockTerminal]);
      const result = await service.findTerminals(s);
      expect(result).toHaveLength(1);
      expect(mockPrisma.pOSTerminal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId: 'org1', isActive: true } }),
      );
    });
  });

  describe('openShift', () => {
    it('открывает смену для кассы своей организации', async () => {
      mockPrisma.pOSTerminal.findFirst.mockResolvedValue(mockTerminal);
      mockPrisma.pOSShift.findFirst.mockResolvedValue(null);
      mockPrisma.pOSShift.count.mockResolvedValue(0);
      mockPrisma.pOSShift.create.mockResolvedValue(mockShift);

      await service.openShift(s, 'term1', { openBalance: 5000 });

      expect(mockPrisma.pOSTerminal.findFirst).toHaveBeenCalledWith({ where: { id: 'term1', organizationId: 'org1' } });
      expect(mockPrisma.pOSShift.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ terminalId: 'term1', number: 'CM-000001', openBalance: 5000, status: 'OPEN' }),
      });
    });

    it('касса другой организации — NotFoundException, смена не создаётся', async () => {
      mockPrisma.pOSTerminal.findFirst.mockResolvedValue(null);
      await expect(service.openShift(s, 'чужая', {})).rejects.toThrow(NotFoundException);
      expect(mockPrisma.pOSShift.create).not.toHaveBeenCalled();
    });

    it('смена уже открыта — BadRequestException', async () => {
      mockPrisma.pOSTerminal.findFirst.mockResolvedValue(mockTerminal);
      mockPrisma.pOSShift.findFirst.mockResolvedValue(mockShift);
      await expect(service.openShift(s, 'term1', {})).rejects.toThrow(BadRequestException);
    });
  });

  describe('closeShift', () => {
    it('суммирует чеки своей организации со склада кассы с момента открытия смены', async () => {
      mockPrisma.pOSShift.findFirst.mockResolvedValue(mockShift);
      mockPrisma.document.aggregate.mockResolvedValue({ _sum: { total: 125000 } });
      mockPrisma.pOSShift.update.mockResolvedValue({ ...mockShift, status: 'CLOSED' });

      await service.closeShift(s, 'shift1');

      const where = mockPrisma.document.aggregate.mock.calls[0][0].where;
      expect(where.AND[0]).toMatchObject({ tenantId: 't1' });
      expect(where.AND[1]).toMatchObject({ docType: 'RETAIL_DEMAND', status: 'POSTED', storeId: 'st1', createdAt: { gte: openedAt } });
      expect(mockPrisma.pOSShift.update).toHaveBeenCalledWith({
        where: { id: 'shift1' },
        data: expect.objectContaining({ status: 'CLOSED', totalSales: 125000 }),
      });
    });

    it('смена другой организации — NotFoundException', async () => {
      mockPrisma.pOSShift.findFirst.mockResolvedValue(null);
      await expect(service.closeShift(s, 'чужая')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.pOSShift.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'чужая', terminal: { organizationId: 'org1' } } }));
    });

    it('смена уже закрыта — BadRequestException', async () => {
      mockPrisma.pOSShift.findFirst.mockResolvedValue({ ...mockShift, status: 'CLOSED' });
      await expect(service.closeShift(s, 'shift1')).rejects.toThrow(BadRequestException);
    });
  });
});
