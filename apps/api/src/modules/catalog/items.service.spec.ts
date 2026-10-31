import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ItemsService } from './items.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Scope } from '../../common/scope';

// Модели Prisma: product / productGroup / uom / stock. Область (клиент + организация) — FP-007;
// проверка на настоящей БД — test/legacy-scope.int-spec.ts.
const mockPrisma = {
  product: {
    findMany: jest.fn(),
    count: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  stock: { findMany: jest.fn() },
  productGroup: { findMany: jest.fn() },
  uom: { findMany: jest.fn() },
};

const s: Scope = { tenantId: 't1', organizationId: 'org1', userId: 'u1' };
const inScope = { tenantId: 't1', OR: [{ organizationId: null }, { organizationId: 'org1' }] };

const mockItem = {
  id: 'item1',
  name: 'Ноутбук Dell',
  code: 'NB-001',
  uom: { id: 'uom1', name: 'шт' },
  group: { id: 'g1', name: 'Электроника' },
  barcodes: [{ barcode: '4600000000001' }],
};

describe('ItemsService', () => {
  let service: ItemsService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.product.create.mockReturnValue(Promise.resolve(mockItem));
    mockPrisma.product.update.mockReturnValue(Promise.resolve(mockItem));
    service = new ItemsService(mockPrisma as unknown as PrismaService);
  });

  describe('findAll', () => {
    it('возвращает список товаров клиента с пагинацией', async () => {
      mockPrisma.product.findMany.mockResolvedValue([mockItem]);
      mockPrisma.product.count.mockResolvedValue(1);

      const result = await service.findAll(s, {});

      expect(result).toMatchObject({ total: 1, page: 1, pages: 1 });
      expect(result.items).toHaveLength(1);
      expect(mockPrisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ...inScope, deleted: false } }));
    });

    it('поиск не отменяет область клиента', async () => {
      mockPrisma.product.findMany.mockResolvedValue([]);
      mockPrisma.product.count.mockResolvedValue(0);

      await service.findAll(s, { search: 'dell' });

      const where = mockPrisma.product.findMany.mock.calls[0][0].where;
      expect(where).toMatchObject(inScope);
      expect(where.AND[0].OR).toEqual([
        { name: { contains: 'dell', mode: 'insensitive' } },
        { code: { contains: 'dell', mode: 'insensitive' } },
        { article: { contains: 'dell', mode: 'insensitive' } },
        { barcodes: { some: { barcode: 'dell' } } },
        { plu: 'dell' },
      ]);
    });

    it('фильтрует по группе и учитывает page/limit', async () => {
      mockPrisma.product.findMany.mockResolvedValue([]);
      mockPrisma.product.count.mockResolvedValue(100);

      const result = await service.findAll(s, { groupId: 'g1', page: 3, limit: 10 });

      expect(mockPrisma.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ groupId: 'g1' }), skip: 20, take: 10 }));
      expect(result.pages).toBe(10);
    });
  });

  describe('findOne', () => {
    it('ищет товар только в области клиента', async () => {
      mockPrisma.product.findFirst.mockResolvedValue(mockItem);
      expect(await service.findOne(s, 'item1')).toEqual(mockItem);
      expect(mockPrisma.product.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'item1', ...inScope } }));
    });

    it('товар вне области — NotFoundException', async () => {
      mockPrisma.product.findFirst.mockResolvedValue(null);
      await expect(service.findOne(s, 'чужой')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('клиент — из области, общий справочник; id/клиент из тела игнорируются', async () => {
      await service.create(s, { id: 'x', tenantId: 'чужой', name: 'Товар', uomId: 'uom1' });
      const data = mockPrisma.product.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ name: 'Товар', uomId: 'uom1', tenantId: 't1', organizationId: null });
      expect(data.id).toBeUndefined();
    });

    it('личный товар — только своей организации; чужая — ForbiddenException', async () => {
      await service.create(s, { name: 'Свой', uomId: 'uom1', organizationId: 'org1' });
      expect(mockPrisma.product.create.mock.calls[0][0].data.organizationId).toBe('org1');
      await expect(service.create(s, { name: 'Чужой', uomId: 'uom1', organizationId: 'org2' })).rejects.toThrow(ForbiddenException);
    });

    it('создаёт штрихкоды без чужих полей; тип — по содержимому; неверный EAN — ошибка', async () => {
      await service.create(s, { name: 'Товар', uomId: 'uom1', barcodes: [{ barcode: ' 4870000000012 ', tenantId: 'чужой', productId: 'p' }, { barcode: '123' }] });
      expect(mockPrisma.product.create.mock.calls[0][0].data.barcodes).toEqual({ create: [
        { barcode: '4870000000012', kind: 'EAN13', source: 'MANUAL' },
        { barcode: '123', kind: 'CODE128', source: 'MANUAL' },
      ] });
      await expect(service.create(s, { name: 'Товар', uomId: 'uom1', barcodes: [{ barcode: '4870000000015', kind: 'EAN13' }] })).rejects.toMatchObject({ response: { code: 'BARCODE_CHECK_DIGIT' } });
    });

    it('FP-025: идентификаторы обмена, статус и архив из тела не принимаются', async () => {
      await service.create(s, { name: 'Товар', uomId: 'uom1', msId: 'x', onecGuid: 'y', syncStatus: 'SYNCED', deleted: true, owner: 'FLOWPOS' });
      const data = mockPrisma.product.create.mock.calls[0][0].data;
      for (const k of ['msId', 'onecGuid', 'syncStatus', 'deleted', 'owner']) expect(data).not.toHaveProperty(k);
    });
  });

  describe('update / archive', () => {
    it('обновляет товар своей области без полей области', async () => {
      mockPrisma.product.findFirst.mockResolvedValue(mockItem);
      await service.update(s, 'item1', { name: 'Новое имя', tenantId: 'чужой' });
      expect(mockPrisma.product.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'item1' }, data: { name: 'Новое имя', updatedBy: 'u1' } }));
    });

    it('товар вне области не обновляется и не архивируется', async () => {
      mockPrisma.product.findFirst.mockResolvedValue(null);
      await expect(service.update(s, 'чужой', { name: 'x' })).rejects.toThrow(NotFoundException);
      await expect(service.archive(s, 'чужой')).rejects.toThrow(NotFoundException);
      expect(mockPrisma.product.update).not.toHaveBeenCalled();
    });

    it('архивирует товар', async () => {
      mockPrisma.product.findFirst.mockResolvedValue(mockItem);
      await service.archive(s, 'item1');
      expect(mockPrisma.product.update).toHaveBeenCalledWith({ where: { id: 'item1' }, data: { deleted: true, updatedBy: 'u1' } });
    });
  });

  describe('справочники', () => {
    it('остатки — по складам своей организации', async () => {
      mockPrisma.product.findFirst.mockResolvedValue(mockItem);
      mockPrisma.stock.findMany.mockResolvedValue([]);
      await service.getStock(s, 'item1');
      expect(mockPrisma.stock.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { productId: 'item1', store: { organizationId: 'org1' } } }));
    });

    it('группы и единицы — своего клиента', async () => {
      mockPrisma.productGroup.findMany.mockResolvedValue([]);
      mockPrisma.uom.findMany.mockResolvedValue([]);
      await service.findGroups(s);
      await service.findUnits(s);
      expect(mockPrisma.productGroup.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 't1' } }));
      expect(mockPrisma.uom.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 't1' } }));
    });
  });
});
