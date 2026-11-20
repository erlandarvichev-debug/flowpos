import { allSolutionStates, parseSubscriptionInput, solutionState } from './subscriptions';

describe('подписки на решения', () => {
  const now = new Date('2026-11-19T10:00:00Z');

  it('учётная система и бухгалтерия без строки подписки — включены: у существующих организаций ничего не пропадает', () => {
    expect(solutionState('trade', null, now)).toMatchObject({ enabled: true, status: 'none' });
    expect(solutionState('accounting', null, now)).toMatchObject({ enabled: true, status: 'none' });
  });

  it('«Супервайзер» без подписки — выключен', () => {
    expect(solutionState('supervisor', null, now)).toMatchObject({ enabled: false, reason: 'Решение не подключено' });
  });

  it('приостановлено или срок истёк — выключено с понятной причиной', () => {
    expect(solutionState('accounting', { solution: 'accounting', status: 'suspended', validUntil: null, seats: null }, now)).toMatchObject({ enabled: false, reason: 'Подписка приостановлена' });
    const expired = solutionState('supervisor', { solution: 'supervisor', status: 'active', validUntil: new Date('2026-11-18T18:59:59Z'), seats: 5 }, now);
    expect(expired.enabled).toBe(false);
    expect(expired.reason).toContain('Срок подписки истёк');
  });

  it('пробная и активная с неистёкшим сроком — включено, места передаются', () => {
    expect(solutionState('supervisor', { solution: 'supervisor', status: 'trial', validUntil: new Date('2026-12-01T00:00:00Z'), seats: 3 }, now)).toMatchObject({ enabled: true, status: 'trial', seats: 3 });
    expect(solutionState('supervisor', { solution: 'supervisor', status: 'active', validUntil: null, seats: null }, now)).toMatchObject({ enabled: true });
  });

  it('неизвестный статус в базе считается приостановленным', () => {
    expect(solutionState('supervisor', { solution: 'supervisor', status: 'paid', validUntil: null, seats: null }, now).enabled).toBe(false);
  });

  it('состояние всех решений сразу', () => {
    const all = allSolutionStates([{ solution: 'supervisor', status: 'active', validUntil: null, seats: 2 }], now);
    expect(all.trade.enabled).toBe(true);
    expect(all.accounting.enabled).toBe(true);
    expect(all.supervisor).toMatchObject({ enabled: true, seats: 2 });
  });

  it('ввод из админки: срок — до конца дня по Казахстану, проверка мест и статуса', () => {
    const p = parseSubscriptionInput({ status: 'active', validUntil: '2026-12-31', seats: '5', note: 'оплачено' });
    expect(p.validUntil?.toISOString()).toBe('2026-12-31T18:59:59.999Z');
    expect(p.seats).toBe(5);
    expect(parseSubscriptionInput({ status: 'trial', seats: '' })).toMatchObject({ seats: null, validUntil: null });
    expect(() => parseSubscriptionInput({ status: 'paid' })).toThrow('Статус');
    expect(() => parseSubscriptionInput({ status: 'active', validUntil: '31.12.2026' })).toThrow('ГГГГ-ММ-ДД');
    expect(() => parseSubscriptionInput({ status: 'active', seats: 2.5 })).toThrow('Число мест');
  });
});
