import { Test, TestingModule } from '@nestjs/testing';
import { ItemsService } from './items.service';
import { PrismaService } from '../../prisma/prisma.service';
import { NotFoundException } from '@nestjs/common';

const mockPrisma = {
  item: {
    findMany: jest.fn(),
    count: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  stock: { findMany: jest.fn() },
  itemGroup: { findMany: jest.fn() },
  unit: { findMany: jest.fn() },
};

const mockItem = {
  id: 'item1',
  name: 'Ноутбук Dell',
  code: 'NB-001',
  article: 'DELL-001',
  isArchived: false,
  unit: { id: 'uom1', name: 'шт' },
  group: { id: 'g1', name: 'Электроника' },
  barcodes: [{ barcode: '4600000000001' }],
};

describe('ItemsService', () => {
  let service: ItemsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ItemsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<ItemsService>(ItemsService);
  });

  describe('findAll', () => {
    it('возвращает список товаров с пагинацией', async () => {
      mockPrisma.item.findMany.mockResolvedValue([mockItem]);
      mockPrisma.item.count.mockResolvedValue(1);

      const result = await service.findAll({});

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pages).toBe(1);
    });

    it('фильтрует по поиску', async () => {
      mockPrisma.item.findMany.mockResolvedValue([]);
      mockPrisma.item.count.mockResolvedValue(0);

      await service.findAll({ search: 'Dell' });

      expect(mockPrisma.item.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: expect.any(Array) }),
        }),
      );
    });

    it('фильтрует по группе', async () => {
      mockPrisma.item.findMany.mockResolvedValue([]);
      mockPrisma.item.count.mockResolvedValue(0);

      await service.findAll({ groupId: 'g1' });

      expect(mockPrisma.item.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ groupId: 'g1' }),
        }),
      );
    });

    it('использует page и limit из запроса', async () => {
      mockPrisma.item.findMany.mockResolvedValue([]);
      mockPrisma.item.count.mockResolvedValue(100);

      const result = await service.findAll({ page: 2, limit: 10 });

      expect(result.page).toBe(2);
      expect(result.limit).toBe(10);
      expect(result.pages).toBe(10);
      expect(mockPrisma.item.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
    });
  });

  describe('findOne', () => {
    it('возвращает товар по id', async () => {
      mockPrisma.item.findUnique.mockResolvedValue(mockItem);
      const result = await service.findOne('item1');
      expect(result.name).toBe('Ноутбук Dell');
    });

    it('выбрасывает NotFoundException если товар не найден', async () => {
      mockPrisma.item.findUnique.mockResolvedValue(null);
      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create', () => {
    it('создаёт товар без штрихкодов', async () => {
      mockPrisma.item.create.mockResolvedValue(mockItem);
      const result = await service.create({ name: 'Ноутбук Dell', unitId: 'uom1' });
      expect(mockPrisma.item.create).toHaveBeenCalled();
      expect(result.name).toBe('Ноутбук Dell');
    });

    it('создаёт товар со штрихкодами', async () => {
      mockPrisma.item.create.mockResolvedValue(mockItem);
      await service.create({ name: 'Товар', unitId: 'uom1', barcodes: [{ barcode: '123' }] });

      expect(mockPrisma.item.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            barcodes: { create: [{ barcode: '123' }] },
          }),
        }),
      );
    });
  });

  describe('update', () => {
    it('обновляет товар', async () => {
      mockPrisma.item.findUnique.mockResolvedValue(mockItem);
      mockPrisma.item.update.mockResolvedValue({ ...mockItem, name: 'Dell XPS' });

      const result = await service.update('item1', { name: 'Dell XPS' });
      expect(result.name).toBe('Dell XPS');
    });

    it('выбрасывает NotFoundException при обновлении несуществующего', async () => {
      mockPrisma.item.findUnique.mockResolvedValue(null);
      await expect(service.update('bad-id', { name: 'X' })).rejects.toThrow(NotFoundException);
    });
  });

  describe('archive', () => {
    it('архивирует товар', async () => {
      mockPrisma.item.findUnique.mockResolvedValue(mockItem);
      mockPrisma.item.update.mockResolvedValue({ ...mockItem, isArchived: true });

      await service.archive('item1');

      expect(mockPrisma.item.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isArchived: true } }),
      );
    });
  });

  describe('getStock', () => {
    it('возвращает остатки по товару', async () => {
      mockPrisma.stock.findMany.mockResolvedValue([{ qty: 10, warehouse: { name: 'Основной склад' } }]);
      const result = await service.getStock('item1');
      expect(result).toHaveLength(1);
      expect(result[0].qty).toBe(10);
    });
  });

  describe('findGroups', () => {
    it('возвращает группы товаров', async () => {
      mockPrisma.itemGroup.findMany.mockResolvedValue([{ id: 'g1', name: 'Электроника' }]);
      const result = await service.findGroups();
      expect(result).toHaveLength(1);
    });
  });

  describe('findUnits', () => {
    it('возвращает единицы измерения', async () => {
      mockPrisma.unit.findMany.mockResolvedValue([{ id: 'u1', name: 'шт' }]);
      const result = await service.findUnits();
      expect(result).toHaveLength(1);
    });
  });
});
