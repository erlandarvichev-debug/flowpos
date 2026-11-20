// «Супервайзер»: чистая логика без БД (расстояние, «на точке / удалённо», коды привязки, даты по Казахстану).
import { createHash, randomBytes, randomInt } from 'crypto';

export const DEFAULT_RADIUS_M = 100;
/** Местоположение хуже этой точности не доказывает ни «на точке», ни «удалённо». */
export const MAX_TRUSTED_ACCURACY_M = 500;
export const BIND_CODE_TTL_MS = 15 * 60 * 1000;
export const PHOTO_RETENTION_DAYS = 180;
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const KZ_OFFSET = '+05:00';

export type Placement = 'on_site' | 'remote' | 'unknown';

export const PLACEMENT_LABELS: Record<Placement, string> = { on_site: 'На точке', remote: 'Удалённо', unknown: 'Не определено' };

/** Расстояние между двумя точками на Земле, метры (формула гаверсинусов). */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export const validLat = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
export const validLng = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;

export interface Fix { lat?: number | null; lng?: number | null; accuracyM?: number | null }
export interface PointGeo { lat?: number | null; lng?: number | null; radiusM?: number | null }

/**
 * Решает сервер, а не телефон: в пределах радиуса точки — «на точке», дальше — «удалённо».
 * Нет координат у точки или у телефона, или точность хуже 500 м — «не определено».
 */
export function decidePlacement(fix: Fix, point: PointGeo | null): { placement: Placement; distanceM: number | null } {
  if (!point || !validLat(point.lat) || !validLng(point.lng) || !validLat(fix.lat) || !validLng(fix.lng)) {
    return { placement: 'unknown', distanceM: null };
  }
  const d = Math.round(distanceM(fix.lat, fix.lng, point.lat, point.lng));
  if (fix.accuracyM != null && fix.accuracyM > MAX_TRUSTED_ACCURACY_M) return { placement: 'unknown', distanceM: d };
  const radius = point.radiusM && point.radiusM > 0 ? point.radiusM : DEFAULT_RADIUS_M;
  return { placement: d <= radius ? 'on_site' : 'remote', distanceM: d };
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Код привязки телефона: 6 цифр (первая может быть нулём). */
export const newBindCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
export const normalizeBindCode = (v: unknown) => String(v ?? '').replace(/\D/g, '');

/** Постоянный токен телефона: на сервере хранится только хэш. */
export const newDeviceToken = () => `fdt_${randomBytes(32).toString('base64url')}`;

/** Дата ГГГГ-ММ-ДД → начало и конец этих суток по времени Казахстана (UTC+5). */
export function kzDayRange(date: string): { from: Date; to: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Дата — в виде ГГГГ-ММ-ДД');
  const from = new Date(`${date}T00:00:00${KZ_OFFSET}`);
  if (Number.isNaN(from.getTime())) throw new Error('Неверная дата');
  return { from, to: new Date(from.getTime() + 24 * 3600 * 1000) };
}

/** Сегодня по Казахстану, ГГГГ-ММ-ДД. */
export function kzToday(now = new Date()): string {
  return new Date(now.getTime() + 5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** Дата ГГГГ-ММ-ДД для столбца DATE (полночь UTC — Prisma хранит только дату). */
export function dateOnly(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Дата — в виде ГГГГ-ММ-ДД');
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error('Неверная дата');
  return d;
}

/** Время с телефона: не из будущего (допуск 10 минут) и не старше 30 дней. */
export function parseDeviceTime(v: unknown, now = new Date()): Date {
  const d = new Date(String(v ?? ''));
  if (Number.isNaN(d.getTime())) throw new Error('Неверное время');
  if (d.getTime() > now.getTime() + 10 * 60 * 1000) throw new Error('Время из будущего — проверьте часы телефона');
  if (d.getTime() < now.getTime() - 30 * 24 * 3600 * 1000) throw new Error('Запись старше 30 дней не принимается');
  return d;
}

/** Идентификатор записи с телефона (повторная отправка не создаёт дубль). */
export function parseClientUuid(v: unknown): string {
  const s = String(v ?? '');
  if (!/^[\w-]{8,64}$/.test(s)) throw new Error('Нет идентификатора записи с телефона');
  return s;
}

/** Координаты с телефона: оба числа или ничего. */
export function parseFix(body: any): { lat: number | null; lng: number | null; accuracyM: number | null } {
  const lat = body?.lat == null ? null : Number(body.lat);
  const lng = body?.lng == null ? null : Number(body.lng);
  const acc = body?.accuracy ?? body?.accuracyM;
  const accuracyM = acc == null || acc === '' ? null : Number(acc);
  if (lat == null && lng == null) return { lat: null, lng: null, accuracyM: null };
  if (!validLat(lat) || !validLng(lng)) throw new Error('Неверные координаты');
  return { lat, lng, accuracyM: accuracyM != null && Number.isFinite(accuracyM) && accuracyM >= 0 ? accuracyM : null };
}

/** Фото: только JPEG/PNG/WebP по сигнатуре файла, а не по заявленному типу. */
export function photoKind(buf: Buffer): { mime: string; ext: string } | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

/** Порядок точек маршрута: без повторов, не больше 200. */
export function parseRoutePoints(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('Список точек маршрута — массив');
  const ids = v.map((x) => String(x ?? '').trim()).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error('Точка повторяется в маршруте');
  if (ids.length > 200) throw new Error('В маршруте не больше 200 точек');
  return ids;
}
