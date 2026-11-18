/** Morada única: derivação da estrutura e geocoding robusto (fetch simulado). */
const { derivarMoradaEstruturada, expandirAbreviaturas, textoMorada } = require('../utils/morada');
const { obterCoordenadas, variantesNominatim } = require('../utils/geocoding');

const MORADA = 'Av. dos Combatentes da Grande Guerra 42, 2700-418 Amadora';

describe('derivarMoradaEstruturada', () => {
  test('morada copiada do Google Maps', () => {
    expect(derivarMoradaEstruturada(MORADA)).toEqual({
      rua: 'Av. dos Combatentes da Grande Guerra 42',
      codigo_postal: '2700-418',
      cidade: 'Amadora',
    });
  });
  test('sem vírgula antes do código postal e com andar', () => {
    expect(derivarMoradaEstruturada('Rua X 5, 3º Esq 1250-001 Lisboa')).toEqual({ rua: 'Rua X 5, 3º Esq', codigo_postal: '1250-001', cidade: 'Lisboa' });
  });
  test('sem código postal usa a última parte como cidade', () => {
    expect(derivarMoradaEstruturada('Rua das Flores 12, Porto')).toEqual({ rua: 'Rua das Flores 12', codigo_postal: '', cidade: 'Porto' });
    expect(derivarMoradaEstruturada('Rua das Flores 12')).toEqual({ rua: 'Rua das Flores 12', codigo_postal: '', cidade: '' });
  });
  test('vazios e tipos errados', () => {
    for (const v of ['', '   ', null, undefined, 5, {}]) expect(derivarMoradaEstruturada(v)).toEqual({ rua: '', codigo_postal: '', cidade: '' });
  });
  test('textoMorada: morada manda, estruturada só para clientes antigos', () => {
    expect(textoMorada('  Rua A  1 ', { rua: 'Outra' })).toBe('Rua A 1');
    expect(textoMorada('', { rua: 'Rua B 2', codigo_postal: '1000-001', cidade: 'Lisboa' })).toBe('Rua B 2, 1000-001, Lisboa');
    expect(textoMorada(undefined, null)).toBe('');
  });
});

describe('expandirAbreviaturas', () => {
  test('expande as abreviaturas comuns', () => {
    expect(expandirAbreviaturas('Av. dos X 1')).toBe('Avenida dos X 1');
    expect(expandirAbreviaturas('Avª da Liberdade 5')).toBe('Avenida da Liberdade 5');
    expect(expandirAbreviaturas('R. Augusta 3, Lg. do Chiado, Tv. A 2, Estr. B 1, Pça. C 4, Al. D 5, Calç. E 6, Bc. F 7'))
      .toBe('Rua Augusta 3, Largo do Chiado, Travessa A 2, Estrada B 1, Praça C 4, Alameda D 5, Calçada E 6, Beco F 7');
  });
});

describe('geocoding: variantes e fallback', () => {
  const guardarFetch = global.fetch;
  const guardarChave = process.env.GOOGLE_MAPS_API_KEY;
  beforeEach(() => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    global.fetch = guardarFetch;
    if (guardarChave) process.env.GOOGLE_MAPS_API_KEY = guardarChave; else delete process.env.GOOGLE_MAPS_API_KEY;
    jest.restoreAllMocks();
  });

  const resposta = (dados) => ({ ok: true, json: async () => dados });

  test('ordem das variantes, sem repetidas, a «aproximada» por último', () => {
    const v = variantesNominatim(MORADA);
    expect(v[0].params.q).toBe(MORADA);
    expect(v[1].params.q).toBe('Avenida dos Combatentes da Grande Guerra 42, 2700-418 Amadora');
    expect(v[2].params.q).toBe('Avenida dos Combatentes da Grande Guerra 42, Amadora');
    expect(v[3].params).toEqual({ street: 'Avenida dos Combatentes da Grande Guerra 42', city: 'Amadora', postalcode: '2700-418' });
    expect(v[4]).toEqual({ params: { q: '2700-418 Amadora' }, precisao: 'aproximada' });
    expect(v).toHaveLength(5);
  });

  test('tenta variantes por ordem, com pausa de 1 s e countrycodes=pt', async () => {
    const urls = [];
    global.fetch = jest.fn(async (url) => {
      urls.push(url);
      return resposta(url.includes('street=') ? [{ lat: '38.75', lon: '-9.23', display_name: 'Avenida dos Combatentes, Amadora' }] : []);
    });
    const esperar = jest.fn().mockResolvedValue();
    const r = await obterCoordenadas(MORADA, { esperar });
    expect(r).toEqual({ lat: 38.75, lng: -9.23, precisao: 'exata', morada_localizada: 'Avenida dos Combatentes, Amadora' });
    expect(urls).toHaveLength(4);
    expect(urls.every((u) => u.includes('countrycodes=pt'))).toBe(true);
    expect(esperar).toHaveBeenCalledTimes(3);
    expect(esperar.mock.calls[0][0]).toBeGreaterThanOrEqual(1000);
  });

  test('só o código postal + cidade devolve «aproximada»', async () => {
    global.fetch = jest.fn(async (url) => resposta(url.includes('q=2700-418+Amadora') ? [{ lat: '38.7', lon: '-9.2', display_name: 'Amadora' }] : []));
    const r = await obterCoordenadas(MORADA, { esperar: async () => {} });
    expect(r.precisao).toBe('aproximada');
  });

  test('nada encontrado devolve null (sem lançar)', async () => {
    global.fetch = jest.fn(async () => resposta([]));
    expect(await obterCoordenadas(MORADA, { esperar: async () => {} })).toBeNull();
    global.fetch = jest.fn(async () => { throw new Error('rede'); });
    expect(await obterCoordenadas(MORADA, { esperar: async () => {} })).toBeNull();
  });

  test('Google: usa o resultado e regista o status quando falha', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'chave';
    global.fetch = jest.fn(async () => resposta({ status: 'OK', results: [{ formatted_address: 'Av. X, Amadora', geometry: { location: { lat: 1, lng: 2 }, location_type: 'ROOFTOP' } }] }));
    expect(await obterCoordenadas(MORADA)).toEqual({ lat: 1, lng: 2, precisao: 'exata', morada_localizada: 'Av. X, Amadora' });

    global.fetch = jest.fn(async (url) => (url.includes('googleapis') ? resposta({ status: 'REQUEST_DENIED', error_message: 'key' }) : resposta([])));
    expect(await obterCoordenadas(MORADA, { esperar: async () => {} })).toBeNull();
    expect(console.error.mock.calls.some((c) => String(c[0]).includes('REQUEST_DENIED'))).toBe(true);
  });
});
