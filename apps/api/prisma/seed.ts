import { PrismaClient, CounterpartyType } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding FlowPOS...');

  const org = await prisma.organization.upsert({
    where: { id: 'org-default' },
    update: {},
    create: {
      id: 'org-default',
      name: 'ТОО "FlowPOS Demo"',
      inn: '123456789012',
    },
  });

  const adminRole = await prisma.role.upsert({
    where: { name: 'admin' },
    update: {},
    create: {
      name: 'admin',
      displayName: 'Администратор',
      isSystem: true,
    },
  });

  await prisma.role.upsert({
    where: { name: 'manager' },
    update: {},
    create: {
      name: 'manager',
      displayName: 'Менеджер',
      isSystem: true,
    },
  });

  await prisma.role.upsert({
    where: { name: 'cashier' },
    update: {},
    create: {
      name: 'cashier',
      displayName: 'Кассир',
      isSystem: true,
    },
  });

  await prisma.role.upsert({
    where: { name: 'hr' },
    update: {},
    create: {
      name: 'hr',
      displayName: 'HR-менеджер',
      isSystem: true,
    },
  });

  await prisma.user.upsert({
    where: { email: 'admin@flowpos.kz' },
    update: {},
    create: {
      email: 'admin@flowpos.kz',
      passwordHash: await bcrypt.hash('admin123', 10),
      firstName: 'Администратор',
      lastName: 'Системный',
      organizationId: org.id,
      userRoles: { create: [{ roleId: adminRole.id }] },
    },
  });

  const mainStore = await prisma.store.upsert({
    where: { id: 'store-main' },
    update: {},
    create: {
      id: 'store-main',
      name: 'Основной склад',
      code: 'MAIN',
      organizationId: org.id,
    },
  });

  const retailStore = await prisma.store.upsert({
    where: { id: 'store-retail' },
    update: {},
    create: {
      id: 'store-retail',
      name: 'Торговый зал',
      code: 'RETAIL',
      organizationId: org.id,
      isRetail: true,
    },
  });

  const uomPcs = await prisma.uom.upsert({
    where: { id: 'uom-pcs' },
    update: {},
    create: {
      id: 'uom-pcs',
      name: 'Штука',
      shortName: 'шт',
      isBase: true,
    },
  });

  await prisma.uom.upsert({
    where: { id: 'uom-kg' },
    update: {},
    create: {
      id: 'uom-kg',
      name: 'Килограмм',
      shortName: 'кг',
    },
  });

  const priceType = await prisma.priceType.upsert({
    where: { id: 'pt-retail' },
    update: {},
    create: {
      id: 'pt-retail',
      name: 'Розничная',
      currency: 'KZT',
      isDefault: true,
    },
  });

  await prisma.priceType.upsert({
    where: { id: 'pt-wholesale' },
    update: {},
    create: {
      id: 'pt-wholesale',
      name: 'Оптовая',
      currency: 'KZT',
    },
  });

  const sampleProducts = [
    { code: 'T-001', name: 'Яблоко Фуджи', price: 890 },
    { code: 'T-002', name: 'Молоко 3.2% 1л', price: 450 },
    { code: 'T-003', name: 'Хлеб белый нарезной', price: 350 },
    { code: 'T-004', name: 'Сахар 1кг', price: 650 },
    { code: 'T-005', name: 'Масло подсолнечное 1л', price: 1200 },
  ];

  for (const prodData of sampleProducts) {
    const productId = `prod-${prodData.code.toLowerCase()}`;
    const product = await prisma.product.upsert({
      where: { id: productId },
      update: {},
      create: {
        id: productId,
        code: prodData.code,
        name: prodData.name,
        uomId: uomPcs.id,
      },
    });

    await prisma.price.upsert({
      where: { productId_priceTypeId: { productId: product.id, priceTypeId: priceType.id } },
      update: { price: prodData.price },
      create: { productId: product.id, priceTypeId: priceType.id, price: prodData.price },
    });

    await prisma.$executeRaw`
      INSERT INTO stock (id, product_id, store_id, bin_id, qty, reserved, updated_at)
      VALUES (gen_random_uuid()::text, ${product.id}, ${mainStore.id}, NULL, 100, 0, NOW())
      ON CONFLICT (product_id, store_id, bin_id) DO NOTHING
    `;
  }

  const terminal = await prisma.pOSTerminal.upsert({
    where: { code: 'CASH-001' },
    update: {},
    create: {
      code: 'CASH-001',
      name: 'Касса №1',
      organizationId: org.id,
      storeId: retailStore.id,
      priceTypeId: priceType.id,
    },
  });

  // Create positions first
  const positionMap: Record<string, string> = {};
  for (const posName of ['Продавец-кассир', 'Менеджер склада', 'Администратор']) {
    const posId = `pos-${posName.toLowerCase().replace(/ /g, '-')}`;
    await prisma.position.upsert({
      where: { id: posId },
      update: {},
      create: { id: posId, name: posName },
    });
    positionMap[posName] = posId;
  }

  const sampleEmployees = [
    { firstName: 'Айгерим', lastName: 'Сейткали', positionName: 'Продавец-кассир' },
    { firstName: 'Данияр', lastName: 'Ахметов', positionName: 'Менеджер склада' },
    { firstName: 'Зарина', lastName: 'Нурланова', positionName: 'Администратор' },
  ];

  for (const empData of sampleEmployees) {
    await prisma.employee.upsert({
      where: { id: `emp-${empData.lastName.toLowerCase()}` },
      update: {},
      create: {
        id: `emp-${empData.lastName.toLowerCase()}`,
        firstName: empData.firstName,
        lastName: empData.lastName,
        positionId: positionMap[empData.positionName],
        hireDate: new Date('2024-01-01'),
        salary: 250000,
        isActive: true,
      },
    });
  }

  await prisma.workSchedule.upsert({
    where: { id: 'shift-standard' },
    update: {},
    create: {
      id: 'shift-standard',
      name: 'Стандартная смена (9:00-18:00)',
      startTime: '09:00',
      endTime: '18:00',
      duration: 8,
      breakTime: 1,
    },
  });

  const sampleCounterparties = [
    { id: 'cp-supplier-001', name: 'ТОО "АгроПоставка"', type: CounterpartyType.SUPPLIER, inn: '111222333001' },
    { id: 'cp-supplier-002', name: 'ИП Ахметов Ж.К.', type: CounterpartyType.SUPPLIER, inn: '111222333002' },
    { id: 'cp-customer-001', name: 'ТОО "Ритейл Маркет"', type: CounterpartyType.CUSTOMER, inn: '444555666001' },
    { id: 'cp-customer-002', name: 'ИП Нурланов А.', type: CounterpartyType.CUSTOMER, inn: '444555666002' },
  ];

  for (const cpData of sampleCounterparties) {
    await prisma.counterparty.upsert({
      where: { id: cpData.id },
      update: {},
      create: {
        ...cpData,
        deleted: false,
      },
    });
  }

  console.log('✅ Seed completed!');
  console.log(`👤 Admin: admin@flowpos.kz / admin123`);
  console.log(`🏢 Organization: ${org.name}`);
  console.log(`🏪 Terminals: ${terminal.name} (code: ${terminal.code})`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
