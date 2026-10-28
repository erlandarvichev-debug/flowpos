import { Test, TestingModule } from '@nestjs/testing';
import { PosService } from './pos.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

const mockPrisma = {
  pOSTerminal: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn() },
  cashShift: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), count: jest.fn() },
  receipt: { aggregate: jest.fn(), create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  receiptItem: { createMany: jest.fn() },
  stock: { findUnique: jest.fn(), upsert: jest.fn() },
  $transaction: jest.fn(),
};

const mockTerminal = { id: 'term1', name: 'Касса 1', organizationId: 'org1', isActive: true, warehouseId: 'wh1' };
const mockShift = { id: 'shift1', terminalId: 'term1', status: 'OPEN', number: 'CM-000001', openedAt: new Date(), openBalance: 0 };

describe('PosService', () => {
  let service: PosService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PosService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<PosService>(PosService);
  });

  describe('findTerminals', () => {
    it('возвращает активные кассы организации', async () => {
      mockPrisma.pOSTerminal.findMany.mockResolvedValue([mockTerminal]);
      const result = await service.findTerminals('org1');
      expect(result).toHaveLength(1);
      expect(mockPrisma.pOSTerminal.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ organizationId: 'org1', isActive: true }) }),
      );
    });
  });

  describe('openShift', () => {
    it('открывает смену для кассы', async () => {
      mockPrisma.pOSTerminal.findUnique.mockResolvedValue(mockTerminal);
      mockPrisma.cashShift.findFirst.mockResolvedValue(null);
      mockPrisma.cashShift.count.mockResolvedValue(0);
      mockPrisma.cashShift.create.mockResolvedValue(mockShift);

      const result = await service.openShift('term1', { openBalance: 5000 });
      expect(result.status).toBe('OPEN');
      expect(result.number).toBe('CM-000001');
    });

    it('выбрасывает NotFoundException если касса не найдена', async () => {
      mockPrisma.pOSTerminal.findUnique.mockResolvedValue(null);
      await expect(service.openShift('bad-term', {})).rejects.toThrow(NotFoundException);
    });

    it('выбрасывает BadRequestException если смена уже открыта', async () => {
      mockPrisma.pOSTerminal.findUnique.mockResolvedValue(mockTerminal);
      mockPrisma.cashShift.findFirst.mockResolvedValue(mockShift);
      await expect(service.openShift('term1', {})).rejects.toThrow(BadRequestException);
    });
  });

  describe('closeShift', () => {
    it('закрывает смену и суммирует продажи', async () => {
      mockPrisma.cashShift.findUnique.mockResolvedValue(mockShift);
      mockPrisma.receipt.aggregate.mockResolvedValue({ _sum: { totalAmount: 150000 } });
      mockPrisma.cashShift.update.mockResolvedValue({ ...mockShift, status: 'CLOSED', totalSales: 150000 });

      const result = await service.closeShift('shift1');
      expect(result.status).toBe('CLOSED');
      expect(result.totalSales).toBe(150000);
    });

    it('выбрасывает NotFoundException если смена не найдена', async () => {
      mockPrisma.cashShift.findUnique.mockResolvedValue(null);
      await expect(service.closeShift('bad-shift')).rejects.toThrow(NotFoundException);
    });

    it('выбрасывает BadRequestException если смена уже закрыта', async () => {
      mockPrisma.cashShift.findUnique.mockResolvedValue({ ...mockShift, status: 'CLOSED' });
      await expect(service.closeShift('shift1')).rejects.toThrow(BadRequestException);
    });
  });
});
