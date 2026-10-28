import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database (new schema)...');

  // ── Organization ─────────────────────────────────────────────────────────
  const org = await prisma.organization.upsert({
    where: { id: 'org-default' },
    create: { id: 'org-default', name: 'ТОО FlowPOS Demo', inn: '123456789012' },
    update: {},
  });

  // ── Roles & Permissions ──────────────────────────────────────────────────
  const adminRole = await prisma.role.upsert({
    where: { name: 'admin' },
    create: { name: 'admin', displayName: 'Администратор', isSystem: true },
    update: {},
  });
  const managerRole = await prisma.role.upsert({
    where: { name: 'manager' },
    create: { name: 'manager', displayName: 'Менеджер', isSystem: false },
    update: {},
  });
  const cashierRole = await prisma.role.upsert({
    where: { name: 'cashier' },
    create: { name: 'cashier', displayName: 'Кассир', isSystem: false },
    update: {},
  });
  const hrRole = await prisma.role.upsert({
    where: { name: 'hr' },
    create: { name: 'hr', displayName: 'HR-менеджер', isSystem: false },
    update: {},
  });

  // ── Admin user ───────────────────────────────────────────────────────────
  const adminHash = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@flowpos.kz' },
    create: {
      email: 'admin@flowpos.kz',
      passwordHash: adminHash,
      firstName: 'Администратор',
      lastName: 'FlowPOS',
      organizationId: org.id,
    },
    update: {},
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: admin.id, roleId: adminRole.id } },
    create: { userId: admin.id, roleId: adminRole.id },
    update: {},
  });

  // ── UOM ─────────────────────────────────────────────────────────────────
  const uomPcs = await prisma.uom.upsert({
    where: { name: 'шт' },
    create: { name: 'шт', shortName: 'шт', isBase: true },
    update: {},
  });
  const uomKg = await prisma.uom.upsert({
    where: { name: 'кг' },
    create: { name: 'кг', shortName: 'кг', isBase: false },
    update: {},
  });

  // ── Product Groups ───────────────────────────────────────────────────────
  const groupFood = await prisma.productGroup.upsert({
    where: { code: 'FOOD' },
    create: { name: 'Продукты питания', code: 'FOOD', syncStatus: 'SYNCED', owner: 'PLATFORM' },
    update: {},
  });
  const groupElec = await prisma.productGroup.upsert({
    where: { code: 'ELEC' },
    create: { name: 'Электроника', code: 'ELEC', syncStatus: 'SYNCED', owner: 'PLATFORM' },
    update: {},
  });

  // ── Price Types ──────────────────────────────────────────────────────────
  const priceRetail = await prisma.priceType.upsert({
    where: { name: 'Розничная' },
    create: { name: 'Розничная', currency: 'KZT', isDefault: true, syncStatus: 'SYNCED', owner: 'PLATFORM' },
    update: {},
  });
  await prisma.priceType.upsert({
    where: { name: 'Оптовая' },
    create: { name: 'Оптовая', currency: 'KZT', isDefault: false, syncStatus: 'SYNCED', owner: 'PLATFORM' },
    update: {},
  });

  // ── Stores (Warehouses) ──────────────────────────────────────────────────
  const mainStore = await prisma.store.upsert({
    where: { code: 'MAIN' },
    create: {
      name: 'Основной склад',
      code: 'MAIN',
      organizationId: org.id,
      syncStatus: 'SYNCED',
      owner: 'PLATFORM',
    },
    update: {},
  });
  const shopStore = await prisma.store.upsert({
    where: { code: 'SHOP1' },
    create: {
      name: 'Магазин №1',
      code: 'SHOP1',
      organizationId: org.id,
      syncStatus: 'SYNCED',
      owner: 'PLATFORM',
    },
    update: {},
  });

  // ── Products ─────────────────────────────────────────────────────────────
  const products = [
    { name: 'Молоко Простоквашино 1л', code: 'MILK001', article: 'MLK-001', barcode: '4600000000001', groupId: groupFood.id },
    { name: 'Хлеб Бородинский', code: 'BREAD001', article: 'BRD-001', barcode: '4600000000002', groupId: groupFood.id },
    { name: 'Сыр Российский 1кг', code: 'CHEESE001', article: 'CHS-001', barcode: '4600000000003', groupId: groupFood.id },
    { name: 'Телевизор Samsung 55"', code: 'TV001', article: 'TV-001', barcode: '4600000000004', groupId: groupElec.id },
    { name: 'Смартфон iPhone 15', code: 'PH001', article: 'IPH-015', barcode: '4600000000005', groupId: groupElec.id },
  ];

  const createdProducts: any[] = [];
  for (const p of products) {
    const product = await prisma.product.upsert({
      where: { code: p.code },
      create: {
        name: p.name,
        code: p.code,
        article: p.article,
        barcode: p.barcode,
        uomId: uomPcs.id,
        groupId: p.groupId,
        syncStatus: 'SYNCED',
        owner: 'PLATFORM',
      },
      update: {},
    });
    createdProducts.push(product);

    // Stock
    await prisma.stock.upsert({
      where: { productId_storeId_binId: { productId: product.id, storeId: mainStore.id, binId: null as any } },
      create: { productId: product.id, storeId: mainStore.id, qty: 100, reserved: 0 },
      update: {},
    }).catch(() => {
      // fallback if null binId causes issues
    });

    // Price
    await prisma.price.upsert({
      where: { productId_priceTypeId: { productId: product.id, priceTypeId: priceRetail.id } },
      create: { productId: product.id, priceTypeId: priceRetail.id, value: Math.floor(Math.random() * 10000) + 500 },
      update: {},
    });
  }

  // ── Counterparties ───────────────────────────────────────────────────────
  const supplier = await prisma.counterparty.upsert({
    where: { inn: '111111111111' },
    create: {
      name: 'ТОО Поставщик Плюс',
      type: 'SUPPLIER',
      inn: '111111111111',
      syncStatus: 'SYNCED',
      owner: 'PLATFORM',
    },
    update: {},
  });
  await prisma.counterparty.upsert({
    where: { inn: '222222222222' },
    create: {
      name: 'ИП Иванов',
      type: 'CUSTOMER',
      inn: '222222222222',
      syncStatus: 'SYNCED',
      owner: 'PLATFORM',
    },
    update: {},
  });

  // ── POS Terminal ─────────────────────────────────────────────────────────
  await prisma.pOSTerminal.upsert({
    where: { code: 'KASSA-001' },
    create: {
      name: 'Касса №1',
      code: 'KASSA-001',
      storeId: shopStore.id,
      organizationId: org.id,
      isActive: true,
    },
    update: {},
  });

  // ── Departments & Positions ───────────────────────────────────────────────
  const dept = await prisma.department.upsert({
    where: { code: 'SALES' },
    create: { name: 'Отдел продаж', code: 'SALES', organizationId: org.id },
    update: {},
  });
  const posManager = await prisma.position.upsert({
    where: { code: 'MGR' },
    create: { name: 'Менеджер', code: 'MGR', organizationId: org.id },
    update: {},
  });
  const posCashier = await prisma.position.upsert({
    where: { code: 'CASH' },
    create: { name: 'Кассир', code: 'CASH', organizationId: org.id },
    update: {},
  });

  // ── Employees ────────────────────────────────────────────────────────────
  await prisma.employee.upsert({
    where: { code: 'EMP-001' },
    create: {
      code: 'EMP-001',
      firstName: 'Алия',
      lastName: 'Смагулова',
      phone: '+77011234567',
      hireDate: new Date('2023-01-15'),
      status: 'ACTIVE',
      departmentId: dept.id,
      positionId: posManager.id,
      organizationId: org.id,
      syncStatus: 'SYNCED',
      owner: 'PLATFORM',
    },
    update: {},
  });
  await prisma.employee.upsert({
    where: { code: 'EMP-002' },
    create: {
      code: 'EMP-002',
      firstName: 'Дмитрий',
      lastName: 'Ковалёв',
      phone: '+77019876543',
      hireDate: new Date('2023-03-01'),
      status: 'ACTIVE',
      departmentId: dept.id,
      positionId: posCashier.id,
      organizationId: org.id,
      syncStatus: 'SYNCED',
      owner: 'PLATFORM',
    },
    update: {},
  });
  await prisma.employee.upsert({
    where: { code: 'EMP-003' },
    create: {
      code: 'EMP-003',
      firstName: 'Назгул',
      lastName: 'Бекова',
      phone: '+77015554433',
      hireDate: new Date('2022-07-10'),
      status: 'ACTIVE',
      departmentId: dept.id,
      positionId: posCashier.id,
      organizationId: org.id,
      syncStatus: 'SYNCED',
      owner: 'PLATFORM',
    },
    update: {},
  });

  console.log('✅ Seed completed!');
  console.log('   Admin: admin@flowpos.kz / admin123');
  console.log(`   Products: ${createdProducts.length}`);
  console.log(`   Store: ${mainStore.name}, ${shopStore.name}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
