/**
 * Testes de utilitários: chaves VAPID (push) e tempo de viagem via Google Maps.
 */

const webpush = require('web-push');

describe('Web Push — normalização das chaves VAPID', () => {
  const guardado = { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY };
  afterAll(() => {
    if (guardado.pub === undefined) delete process.env.VAPID_PUBLIC_KEY; else process.env.VAPID_PUBLIC_KEY = guardado.pub;
    if (guardado.priv === undefined) delete process.env.VAPID_PRIVATE_KEY; else process.env.VAPID_PRIVATE_KEY = guardado.priv;
  });

  const carregar = () => {
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const push = require('../utils/push');
    push.configurarWebPush();
    return push;
  };

  it('aceita chaves colocadas com aspas, espaços ou quebras de linha (erro comum no painel do Render)', () => {
    const k = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = `  "${k.publicKey}"\n`;
    process.env.VAPID_PRIVATE_KEY = `'${k.privateKey}' `;
    const push = carregar();
    expect(push.isConfigured()).toBe(true);
    expect(push.getPublicKey()).toBe(k.publicKey); // devolve a chave limpa ao frontend
  });

  it('continua a recusar uma chave realmente inválida, com mensagem clara', () => {
    const k = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = k.publicKey.slice(0, 30);
    process.env.VAPID_PRIVATE_KEY = k.privateKey;
    const push = carregar();
    expect(push.isConfigured()).toBe(false);
    expect(console.error.mock.calls.flat().join(' ')).toMatch(/87/);
  });
});

describe('Google Maps — origem e destino no mesmo local', () => {
  const chaveAntiga = process.env.GOOGLE_MAPS_API_KEY;
  afterEach(() => {
    jest.restoreAllMocks();
    if (chaveAntiga === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = chaveAntiga;
  });

  it('duration.value = 0 é aceite como 0 minutos (e não como falha)', async () => {
    process.env.GOOGLE_MAPS_API_KEY = 'chave-de-teste';
    const { calcularTempoViagemReal, limparCacheDistancias } = require('../utils/distancia');
    limparCacheDistancias();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'OK', rows: [{ elements: [{ status: 'OK', duration: { value: 0 }, distance: { value: 0 } }] }] }),
    });
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await calcularTempoViagemReal({ lat: 38.7, lng: -9.1 }, { lat: 38.7, lng: -9.1 });
    expect(r.origem).toBe('google_maps');
    expect(r.minutos).toBe(0);
    expect(aviso).not.toHaveBeenCalled();
  });
});
