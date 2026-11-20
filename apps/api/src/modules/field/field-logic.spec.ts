import {
  decidePlacement, distanceM, kzDayRange, kzToday, newBindCode, newDeviceToken, normalizeBindCode, parseClientUuid, parseDeviceTime, parseFix,
  parseRoutePoints, photoKind,
} from './field-logic';

describe('«Супервайзер»: на точке или удалённо', () => {
  // Алматы, пр. Абая — две точки примерно в 111 м по широте.
  const point = { lat: 43.238, lng: 76.889, radiusM: null };

  it('расстояние считается в метрах', () => {
    expect(Math.round(distanceM(43.238, 76.889, 43.239, 76.889))).toBe(111);
    expect(distanceM(43.238, 76.889, 43.238, 76.889)).toBe(0);
  });

  it('в радиусе 100 м — на точке, дальше — удалённо', () => {
    expect(decidePlacement({ lat: 43.2384, lng: 76.889, accuracyM: 15 }, point)).toEqual({ placement: 'on_site', distanceM: 44 });
    expect(decidePlacement({ lat: 43.239, lng: 76.889, accuracyM: 15 }, point)).toEqual({ placement: 'remote', distanceM: 111 });
    expect(decidePlacement({ lat: 43.25, lng: 76.95, accuracyM: 10 }, point).placement).toBe('remote');
  });

  it('свой радиус точки', () => {
    expect(decidePlacement({ lat: 43.239, lng: 76.889 }, { ...point, radiusM: 150 }).placement).toBe('on_site');
  });

  it('нет координат у точки или телефона, или точность хуже 500 м — не определено', () => {
    expect(decidePlacement({ lat: 43.238, lng: 76.889 }, { lat: null, lng: null })).toEqual({ placement: 'unknown', distanceM: null });
    expect(decidePlacement({ lat: null, lng: null }, point)).toEqual({ placement: 'unknown', distanceM: null });
    expect(decidePlacement({ lat: 43.238, lng: 76.889, accuracyM: 900 }, point)).toEqual({ placement: 'unknown', distanceM: 0 });
    expect(decidePlacement({ lat: 43.238, lng: 76.889 }, null).placement).toBe('unknown');
  });
});

describe('«Супервайзер»: привязка телефона и данные с телефона', () => {
  it('код — 6 цифр, токен — длинный случайный', () => {
    for (let i = 0; i < 50; i++) expect(newBindCode()).toMatch(/^\d{6}$/);
    expect(normalizeBindCode(' 012-345 ')).toBe('012345');
    const t = newDeviceToken();
    expect(t).toMatch(/^fdt_[\w-]{40,}$/);
    expect(newDeviceToken()).not.toBe(t);
  });

  it('сутки — по времени Казахстана', () => {
    expect(kzDayRange('2026-11-19')).toEqual({ from: new Date('2026-11-18T19:00:00Z'), to: new Date('2026-11-19T19:00:00Z') });
    expect(kzToday(new Date('2026-11-18T19:30:00Z'))).toBe('2026-11-19');
    expect(() => kzDayRange('19.11.2026')).toThrow();
  });

  it('время с телефона: не из будущего и не старше 30 дней', () => {
    const now = new Date('2026-11-19T10:00:00Z');
    expect(parseDeviceTime('2026-11-19T09:00:00Z', now).toISOString()).toBe('2026-11-19T09:00:00.000Z');
    expect(() => parseDeviceTime('2026-11-19T11:00:00Z', now)).toThrow('будущего');
    expect(() => parseDeviceTime('2026-09-01T00:00:00Z', now)).toThrow('30 дней');
    expect(() => parseDeviceTime('вчера', now)).toThrow();
  });

  it('координаты — обе или ни одной', () => {
    expect(parseFix({ lat: 43.2, lng: 76.9, accuracy: 12 })).toEqual({ lat: 43.2, lng: 76.9, accuracyM: 12 });
    expect(parseFix({})).toEqual({ lat: null, lng: null, accuracyM: null });
    expect(() => parseFix({ lat: 43.2 })).toThrow('координаты');
    expect(() => parseFix({ lat: 95, lng: 10 })).toThrow('координаты');
  });

  it('идентификатор записи с телефона', () => {
    expect(parseClientUuid('8f0d1c2e-1111-2222-3333-444455556666')).toBe('8f0d1c2e-1111-2222-3333-444455556666');
    expect(() => parseClientUuid('../../etc')).toThrow();
    expect(() => parseClientUuid('')).toThrow();
  });

  it('фото — по содержимому файла, а не по расширению', () => {
    expect(photoKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(photoKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toEqual({ mime: 'image/png', ext: 'png' });
    expect(photoKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toEqual({ mime: 'image/webp', ext: 'webp' });
    expect(photoKind(Buffer.from('<html><script>'))).toBeNull();
  });

  it('маршрут: без повторов точек', () => {
    expect(parseRoutePoints(['a', ' b ', ''])).toEqual(['a', 'b']);
    expect(() => parseRoutePoints(['a', 'a'])).toThrow('повторяется');
    expect(() => parseRoutePoints('a')).toThrow();
  });
});
