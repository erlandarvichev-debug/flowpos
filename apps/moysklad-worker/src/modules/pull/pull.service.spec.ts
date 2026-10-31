import { Test, TestingModule } from '@nestjs/testing';
import { MsPullService } from './pull.service';
import { PrismaService } from '../../prisma.service';
import { MoyskladHttpClient } from '@flowpos/moysklad-client';

const mockPrisma = {
  moyskladConnection: { findMany: jest.fn() },
  moyskladSyncCursor: { findUnique: jest.fn(), upsert: jest.fn() },
  moyskladSyncLog: { create: jest.fn() },
  product: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  productBarcode: { deleteMany: jest.fn(), createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  counterparty: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  store: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  productGroup: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  uom: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  organization: { findFirst: jest.fn() },
  $transaction: jest.fn(),
};

const makeProduct = (id: string, name: string) => ({
  id, accountId: 'acc1', name, updated: '2026-01-01T10:00:00Z', archived: false,
  meta: { href: '', type: 'product', mediaType: '' },
});

async function* mockGen<T>(batches: T[][]) {
  for (const batch of batches) yield batch;
}

describe('MsPullService', () => {
  let service: MsPullService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MsPullService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<MsPullService>(MsPullService);
  });

  describe('pullOperational', () => {
    it('ничего не делает если нет активных подключений', async () => {
      mockPrisma.moyskladConnection.findMany.mockResolvedValue([]);
      await service.pullOperational();
      expect(mockPrisma.moyskladSyncLog.create).not.toHaveBeenCalled();
    });

    it('тянет данные для каждого активного подключения', async () => {
      const conn = { id: 'conn1', tokenEnc: 'token123', accountId: 'acc1', organizationId: 'org1', organization: { tenantId: 't1' } };
      mockPrisma.moyskladConnection.findMany.mockResolvedValue([conn]);
      mockPrisma.moyskladSyncCursor.findUnique.mockResolvedValue(null);
      mockPrisma.moyskladSyncLog.create.mockResolvedValue({});
      mockPrisma.$transaction.mockImplementation((fn: any) => fn(mockPrisma));

      jest.spyOn(MoyskladHttpClient.prototype, 'getProducts').mockResolvedValue(mockGen([]));
      jest.spyOn(MoyskladHttpClient.prototype, 'getCounterparties').mockResolvedValue(mockGen([]));
      jest.spyOn(MoyskladHttpClient.prototype, 'getStores').mockResolvedValue(mockGen([]));

      await service.pullOperational();

      expect(mockPrisma.moyskladSyncLog.create).toHaveBeenCalledTimes(3);
    });
  });

  describe('pullSlow', () => {
    it('ничего не делает если нет активных подключений', async () => {
      mockPrisma.moyskladConnection.findMany.mockResolvedValue([]);
      await service.pullSlow();
      expect(mockPrisma.moyskladSyncLog.create).not.toHaveBeenCalled();
    });
  });

  describe('upsert логика (через pullOperational)', () => {
    const conn = { id: 'conn1', tokenEnc: 'token123', accountId: 'acc1', organizationId: 'org1', organization: { tenantId: 't1' } };

    beforeEach(() => {
      mockPrisma.moyskladConnection.findMany.mockResolvedValue([conn]);
      mockPrisma.moyskladSyncCursor.findUnique.mockResolvedValue(null);
      mockPrisma.moyskladSyncCursor.upsert.mockResolvedValue({});
      mockPrisma.moyskladSyncLog.create.mockResolvedValue({});
      mockPrisma.$transaction.mockImplementation((fn: any) => fn(mockPrisma));
      mockPrisma.organization.findFirst.mockResolvedValue({ id: 'org1' });
      mockPrisma.uom.findFirst.mockResolvedValue({ id: 'uom1' });
      jest.spyOn(MoyskladHttpClient.prototype, 'getCounterparties').mockResolvedValue(mockGen([]));
      jest.spyOn(MoyskladHttpClient.prototype, 'getStores').mockResolvedValue(mockGen([]));
    });

    it('создаёт новый товар если не существует', async () => {
      const product = makeProduct('ms-p1', 'Новый товар');
      jest.spyOn(MoyskladHttpClient.prototype, 'getProducts').mockResolvedValue(mockGen([[product]]));
      mockPrisma.product.findFirst.mockResolvedValue(null);
      mockPrisma.product.create.mockResolvedValue({ id: 'local-p1' });

      await service.pullOperational();

      expect(mockPrisma.product.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'Новый товар', msId: 'ms-p1' }) }),
      );
    });

    it('обновляет существующий товар в статусе SYNCED', async () => {
      const product = makeProduct('ms-p1', 'Обновлённый товар');
      jest.spyOn(MoyskladHttpClient.prototype, 'getProducts').mockResolvedValue(mockGen([[product]]));
      mockPrisma.product.findFirst.mockResolvedValue({ id: 'local-p1', syncStatus: 'SYNCED' });
      mockPrisma.product.update.mockResolvedValue({});

      await service.pullOperational();

      expect(mockPrisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'Обновлённый товар' }) }),
      );
    });

    it('FP-025: все штрихкоды товара — в таблицу штрихкодов; убранные в МойСклад удаляются; чужой код не перехватывается', async () => {
      const product = { ...makeProduct('ms-p1', 'Сок'), barcodes: [{ ean13: '4870000000014' }, { code128: ' AB 12 ' }, { gtin: '04870000000014' }, { ean13: '4870000000014' }] };
      jest.spyOn(MoyskladHttpClient.prototype, 'getProducts').mockResolvedValue(mockGen([[product]]));
      mockPrisma.product.findFirst.mockResolvedValue({ id: 'local-p1', syncStatus: 'SYNCED' });
      mockPrisma.product.update.mockResolvedValue({});
      mockPrisma.productBarcode.findMany.mockResolvedValue([{ barcode: 'AB12' }]);
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

      await service.pullOperational();

      expect(mockPrisma.productBarcode.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 't1', productId: 'local-p1', source: 'MOYSKLAD', barcode: { notIn: ['4870000000014', 'AB12', '04870000000014'] } } });
      expect(mockPrisma.productBarcode.createMany).toHaveBeenCalledWith({
        data: [
          { tenantId: 't1', productId: 'local-p1', barcode: '4870000000014', kind: 'EAN13', source: 'MOYSKLAD' },
          { tenantId: 't1', productId: 'local-p1', barcode: 'AB12', kind: 'CODE128', source: 'MOYSKLAD' },
          { tenantId: 't1', productId: 'local-p1', barcode: '04870000000014', kind: 'GTIN14', source: 'MOYSKLAD' },
        ],
        skipDuplicates: true,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('AB12'));
    });

    it('помечает конфликт если товар DIRTY', async () => {
      const product = makeProduct('ms-p1', 'Товар из МойСклад');
      jest.spyOn(MoyskladHttpClient.prototype, 'getProducts').mockResolvedValue(mockGen([[product]]));
      mockPrisma.product.findFirst.mockResolvedValue({ id: 'local-p1', syncStatus: 'DIRTY' });
      mockPrisma.product.update.mockResolvedValue({});

      await service.pullOperational();

      expect(mockPrisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ syncStatus: 'CONFLICT' }) }),
      );
    });

    it('записывает лог с ok=true при успехе', async () => {
      jest.spyOn(MoyskladHttpClient.prototype, 'getProducts').mockResolvedValue(mockGen([]));
      await service.pullOperational();

      expect(mockPrisma.moyskladSyncLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ok: true, entity: 'product' }) }),
      );
    });

    it('записывает лог с ok=false при ошибке', async () => {
      jest.spyOn(MoyskladHttpClient.prototype, 'getProducts').mockRejectedValue(new Error('API Error'));
      await service.pullOperational();

      expect(mockPrisma.moyskladSyncLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ ok: false, error: 'API Error' }) }),
      );
    });
  });
});
