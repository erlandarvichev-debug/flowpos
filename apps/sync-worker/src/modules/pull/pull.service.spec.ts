import { Test, TestingModule } from '@nestjs/testing';
import { PullService } from './pull.service';
import { PrismaService } from '../../prisma.service';
import { OnecHttpClient } from '@flowpos/onec-client';

const mockPrisma = {
  onecConnection: { findMany: jest.fn() },
  syncCursor: { findUnique: jest.fn(), upsert: jest.fn() },
  syncLog: { create: jest.fn() },
  product: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  counterparty: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  store: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  productGroup: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  uom: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  idMap: { upsert: jest.fn() },
  organization: { findFirst: jest.fn() },
  $transaction: jest.fn(),
};

const makeConn = () => ({
  id: 'conn1', baseUrl: 'http://1c.local', baseCode: 'main',
  username: 'admin', passwordEnc: 'pass', instanceType: 'ONPREM',
});

const makeDelta = (items: any[] = [], hasMore = false) => ({
  items, nextSince: '2026-01-02T00:00:00Z', nextGuid: undefined, hasMore,
});

describe('PullService (sync-worker 1С)', () => {
  let service: PullService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PullService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<PullService>(PullService);
  });

  describe('pullOperational', () => {
    it('пропускает если нет активных подключений', async () => {
      mockPrisma.onecConnection.findMany.mockResolvedValue([]);
      await service.pullOperational();
      expect(mockPrisma.syncLog.create).not.toHaveBeenCalled();
    });

    it('запускает синхронизацию для каждого подключения', async () => {
      mockPrisma.onecConnection.findMany.mockResolvedValue([makeConn()]);
      mockPrisma.syncCursor.findUnique.mockResolvedValue(null);
      mockPrisma.syncLog.create.mockResolvedValue({});
      mockPrisma.$transaction.mockImplementation((fn: any) => fn(mockPrisma));
      mockPrisma.uom.findFirst.mockResolvedValue({ id: 'uom1' });

      jest.spyOn(OnecHttpClient.prototype, 'getDelta').mockResolvedValue(makeDelta());

      await service.pullOperational();

      expect(mockPrisma.syncLog.create).toHaveBeenCalledTimes(5);
    });
  });

  describe('pullSlow', () => {
    it('пропускает если нет активных подключений', async () => {
      mockPrisma.onecConnection.findMany.mockResolvedValue([]);
      await service.pullSlow();
      expect(mockPrisma.syncLog.create).not.toHaveBeenCalled();
    });
  });

  describe('upsert логика', () => {
    const conn = makeConn();

    beforeEach(() => {
      mockPrisma.onecConnection.findMany.mockResolvedValue([conn]);
      mockPrisma.syncCursor.findUnique.mockResolvedValue(null);
      mockPrisma.syncCursor.upsert.mockResolvedValue({});
      mockPrisma.syncLog.create.mockResolvedValue({});
      mockPrisma.idMap.upsert.mockResolvedValue({});
      mockPrisma.$transaction.mockImplementation((fn: any) => fn(mockPrisma));
      mockPrisma.uom.findFirst.mockResolvedValue({ id: 'uom1' });
      mockPrisma.organization.findFirst.mockResolvedValue({ id: 'org1' });
    });

    it('создаёт товар из 1С если не существует', async () => {
      const item = { guid: 'g1', version: 'v1', deletionMark: false, data: { name: 'Товар 1С', code: '001' } };
      jest.spyOn(OnecHttpClient.prototype, 'getDelta')
        .mockResolvedValueOnce(makeDelta([item]))
        .mockResolvedValue(makeDelta());

      mockPrisma.product.findFirst.mockResolvedValue(null);
      mockPrisma.product.create.mockResolvedValue({ id: 'p1' });

      await service.pullOperational();

      expect(mockPrisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'Товар 1С', onecGuid: 'g1' }) }),
      );
    });

    it('помечает CONFLICT если товар DIRTY при обновлении из 1С', async () => {
      const item = { guid: 'g1', version: 'v2', deletionMark: false, data: { name: 'Обновлённый' } };
      jest.spyOn(OnecHttpClient.prototype, 'getDelta')
        .mockResolvedValueOnce(makeDelta([item]))
        .mockResolvedValue(makeDelta());

      mockPrisma.product.findFirst.mockResolvedValue({ id: 'p1', syncStatus: 'DIRTY', name: 'Локальный' });
      mockPrisma.product.update.mockResolvedValue({});

      await service.pullOperational();

      expect(mockPrisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ syncStatus: 'CONFLICT' }) }),
      );
    });

    it('обновляет товар если статус SYNCED', async () => {
      const item = { guid: 'g1', version: 'v2', deletionMark: false, data: { name: 'Новое имя', code: '001' } };
      jest.spyOn(OnecHttpClient.prototype, 'getDelta')
        .mockResolvedValueOnce(makeDelta([item]))
        .mockResolvedValue(makeDelta());

      mockPrisma.product.findFirst.mockResolvedValue({ id: 'p1', syncStatus: 'SYNCED', name: 'Старое' });
      mockPrisma.product.update.mockResolvedValue({});

      await service.pullOperational();

      expect(mockPrisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'Новое имя', syncStatus: 'SYNCED' }) }),
      );
    });

    it('записывает лог с ok=false при ошибке API', async () => {
      jest.spyOn(OnecHttpClient.prototype, 'getDelta').mockRejectedValue(new Error('Connection refused'));
      await service.pullOperational();

      expect(mockPrisma.syncLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ok: false, error: 'Connection refused' }) }),
      );
    });
  });

  describe('курсоры синхронизации', () => {
    it('использует lastTs из курсора как since', async () => {
      const conn = makeConn();
      mockPrisma.onecConnection.findMany.mockResolvedValue([conn]);
      mockPrisma.syncCursor.findUnique.mockResolvedValue({ lastTs: new Date('2026-06-01T00:00:00Z'), lastGuid: null });
      mockPrisma.syncLog.create.mockResolvedValue({});
      mockPrisma.$transaction.mockImplementation((fn: any) => fn(mockPrisma));
      mockPrisma.uom.findFirst.mockResolvedValue({ id: 'uom1' });

      const getDeltaSpy = jest.spyOn(OnecHttpClient.prototype, 'getDelta').mockResolvedValue(makeDelta());

      await service.pullOperational();

      expect(getDeltaSpy).toHaveBeenCalledWith(
        'product', '2026-06-01T00:00:00.000Z', undefined, 500,
      );
    });
  });
});
