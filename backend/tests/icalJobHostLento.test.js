/**
 * Job dos calendários: um host lento não bloqueia o tique (prazo por fonte, orçamento do lote, host lento posto de lado).
 * `sincronizarFonte` e o modelo são simulados; nenhum pedido real.
 */
jest.mock('../utils/calendarioExterno/sincronizar', () => ({ sincronizarFonte: jest.fn(), funcionalidadeLigada: jest.fn(() => true) }));
jest.mock('../models/FonteCalendario', () => ({ updateMany: jest.fn().mockResolvedValue({}), find: jest.fn() }));
jest.mock('../models/ReservaExterna', () => ({}));

const { sincronizarFonte } = require('../utils/calendarioExterno/sincronizar');
const FonteCalendario = require('../models/FonteCalendario');
const { processarEmLote } = require('../jobs/sincronizacaoCalendarios');

const fonte = (id, host) => ({ _id: id, url_host: host });

beforeEach(() => { sincronizarFonte.mockReset(); FonteCalendario.updateMany.mockClear(); });

test('40 fontes do mesmo host que não responde: o lote acaba no prazo de UMA fonte, as outras são adiadas, e outros hosts são lidos', async () => {
  sincronizarFonte.mockImplementation((id) => (String(id).startsWith('lento') ? new Promise(() => {}) : Promise.resolve({ resultado: 'ok', id })));
  const fontes = [
    ...Array.from({ length: 40 }, (_, i) => fonte(`lento${i}`, 'www.airbnb.pt')),
    fonte('bom1', 'ical.booking.com'), fonte('bom2', 'www.airbnb.com'),
  ];
  const t0 = Date.now();
  const r = await processarEmLote(fontes, { prazoFonteMs: 150, orcamentoMs: 5000 });
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(r.map((x) => x.id).sort()).toEqual(['bom1', 'bom2']);
  expect(sincronizarFonte.mock.calls.filter(([id]) => String(id).startsWith('lento'))).toHaveLength(1); // só uma tentativa ao host lento
  expect(FonteCalendario.updateMany).toHaveBeenCalledTimes(1);
  const adiadas = FonteCalendario.updateMany.mock.calls[0][0]._id.$in;
  expect(adiadas).toHaveLength(40); // a que passou o prazo e as 39 que ficaram por ler
});

test('um erro de timeout devolvido pela leitura também põe o host de lado neste tique', async () => {
  sincronizarFonte.mockImplementation(async (id) => (String(id).startsWith('t') ? { resultado: 'erro', codigo: 'timeout' } : { resultado: 'ok', id }));
  const r = await processarEmLote([fonte('t1', 'h1'), fonte('t2', 'h1'), fonte('t3', 'h1'), fonte('ok', 'h2')], { prazoFonteMs: 1000 });
  expect(sincronizarFonte.mock.calls.filter(([id]) => String(id).startsWith('t'))).toHaveLength(1);
  expect(r.some((x) => x.id === 'ok')).toBe(true);
});

test('o orçamento do lote termina o tique mesmo com muitas fontes lentas de hosts diferentes', async () => {
  sincronizarFonte.mockImplementation(() => new Promise((res) => setTimeout(() => res({ resultado: 'ok' }), 120)));
  const fontes = Array.from({ length: 30 }, (_, i) => fonte(`f${i}`, `h${i}`));
  const t0 = Date.now();
  await processarEmLote(fontes, { orcamentoMs: 400, prazoFonteMs: 1000 });
  expect(Date.now() - t0).toBeLessThan(1500);
  expect(sincronizarFonte.mock.calls.length).toBeLessThan(30); // o resto fica para o tique seguinte
});

test('fontes de hosts diferentes continuam a ser lidas com concorrência', async () => {
  sincronizarFonte.mockImplementation(async (id) => ({ resultado: 'ok', id }));
  const r = await processarEmLote([fonte('a', 'h1'), fonte('b', 'h2'), fonte('c', 'h3'), fonte('d', 'h4')], {});
  expect(r).toHaveLength(4);
  expect(FonteCalendario.updateMany).not.toHaveBeenCalled();
});
