import axios from 'axios';
import { MoyskladHttpClient } from './http-client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockCreate = jest.fn();
mockedAxios.create = jest.fn().mockReturnValue({ get: mockCreate, post: mockCreate });

const TOKEN = 'test-token-123';
const client = new MoyskladHttpClient({ token: TOKEN });

describe('MoyskladHttpClient', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('iterateDelta', () => {
    it('возвращает пустой генератор если items пустой', async () => {
      mockCreate.mockResolvedValueOnce({
        data: { meta: { limit: 1000, offset: 0, size: 0 }, rows: [] },
      });

      const results: any[] = [];
      for await (const batch of client.iterateDelta('product')) {
        results.push(...batch);
      }
      expect(results).toHaveLength(0);
    });

    it('возвращает один батч если все записи влезают', async () => {
      const rows = [{ id: '1', name: 'Товар 1', updated: '2026-01-01T00:00:00Z', archived: false, meta: { href: '', type: 'product', mediaType: '' } }];
      mockCreate.mockResolvedValueOnce({
        data: { meta: { limit: 1000, offset: 0, size: 1 }, rows },
      });

      const results: any[] = [];
      for await (const batch of client.iterateDelta('product')) {
        results.push(...batch);
      }
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Товар 1');
    });

    it('пагинирует через несколько страниц', async () => {
      const makeRow = (i: number) => ({ id: String(i), name: `Товар ${i}`, updated: '2026-01-01T00:00:00Z', archived: false, meta: { href: '', type: 'product', mediaType: '' } });
      const page1 = Array.from({ length: 1000 }, (_, i) => makeRow(i));
      const page2 = Array.from({ length: 5 }, (_, i) => makeRow(1000 + i));

      mockCreate
        .mockResolvedValueOnce({ data: { meta: { limit: 1000, offset: 0, size: 1005 }, rows: page1 } })
        .mockResolvedValueOnce({ data: { meta: { limit: 1000, offset: 1000, size: 1005 }, rows: page2 } });

      const results: any[] = [];
      for await (const batch of client.iterateDelta('product')) {
        results.push(...batch);
      }
      expect(results).toHaveLength(1005);
    });

    it('передаёт updatedFrom как filter параметр', async () => {
      mockCreate.mockResolvedValueOnce({
        data: { meta: { limit: 1000, offset: 0, size: 0 }, rows: [] },
      });

      for await (const _ of client.iterateDelta('counterparty', '2026-01-01T00:00:00Z')) { /* noop */ }

      expect(mockCreate).toHaveBeenCalledWith(
        '/entity/counterparty',
        expect.objectContaining({ params: expect.objectContaining({ filter: 'updated>2026-01-01T00:00:00Z' }) }),
      );
    });
  });

  describe('getPriceTypes', () => {
    it('возвращает массив типов цен', async () => {
      const rows = [{ id: 'pt1', name: 'Розничная', externalCode: 'retail', meta: { href: '', type: 'pricetype', mediaType: '' } }];
      mockCreate.mockResolvedValueOnce({ data: { meta: { limit: 100, offset: 0, size: 1 }, rows } });

      const result = await client.getPriceTypes();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('Розничная');
    });
  });

  describe('ping', () => {
    it('возвращает true если API доступен', async () => {
      mockCreate.mockResolvedValueOnce({ data: { id: 'emp1' } });
      const result = await client.ping();
      expect(result).toBe(true);
    });

    it('возвращает false если API недоступен', async () => {
      mockCreate.mockRejectedValueOnce(new Error('Network Error'));
      const result = await client.ping();
      expect(result).toBe(false);
    });
  });
});
