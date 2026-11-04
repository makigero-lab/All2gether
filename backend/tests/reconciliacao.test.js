/**
 * Testes: cancelamento que chega antes da reserva, reconciliação periódica, retoma de
 * webhooks presos, corridas na criação e atualização de `hospedes`. `fetch` é simulado:
 * nenhuma chamada à API real do Smoobu.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const WebhookLog = require('../models/WebhookLog');
const {
  processarReservaSmoobu,
  sincronizarReservas,
} = require('../controllers/smoobuController');
const { retomarWebhooksPresos, executarSincronizacaoSmoobu } = require('../jobs/sincronizacaoSmoobu');

let mongod;
let empresa;
const fetchOriginal = global.fetch;

const dados = (id, extra = {}) => ({
  id,
  type: 'reservation',
  arrival: '2031-05-10',
  departure: '2031-05-14',
  apartment: { id: 777, name: 'Casa R' },
  'guest-name': 'Hospede Teste',
  adults: 2,
  children: 0,
  ...extra,
});
const payload = (action, id, extra) => ({ action, user: 1, data: dados(id, extra) });
const resposta = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const tarefaDe = (id) => Tarefa.findOne({ smoobu_reserva_id: String(id) });
const novaReserva = (id, extra) =>
  processarReservaSmoobu(payload('newReservation', id, extra), empresa._id, empresa._id);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init(); // garante o índice único (reserva, empresa)
  empresa = await Empresa.create({
    nome: 'Empresa Reconciliação',
    integracoes: { smoobu: { api_key: 'chave-de-teste', ativo: true } },
  });
  await Propriedade.create({
    nome: 'Casa R', empresa_id: empresa._id, smoobu_id: '777', ativo: true, capacidade_hospedes: 6,
  });
});

afterEach(() => {
  global.fetch = fetchOriginal;
});

afterAll(async () => {
  global.fetch = fetchOriginal;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('Cancelamento que chega antes da reserva', () => {
  const logCancelamento = (id, extra = {}) =>
    WebhookLog.create({ payload: payload('cancelReservation', id, extra), status: 'processado', empresa_id: empresa._id });

  it('confirmado como cancelado no Smoobu: não cria a tarefa e regista no log', async () => {
    await logCancelamento(5001);
    const logAtual = await WebhookLog.create({ payload: payload('newReservation', 5001), status: 'recebido', empresa_id: empresa._id });
    global.fetch = jest.fn().mockResolvedValue(resposta(200, dados(5001, { type: 'cancellation' })));
    const r = await processarReservaSmoobu(payload('newReservation', 5001), empresa._id, empresa._id, { logId: logAtual._id });
    expect(r).toBeNull();
    expect(await tarefaDe(5001)).toBeNull();
    expect((await WebhookLog.findById(logAtual._id)).erro_msg).toMatch(/cancelamento recebido antes/i);
  });

  it('id numérico no log anterior e update com type cancellation também contam', async () => {
    await WebhookLog.create({
      payload: { action: 'updateReservation', data: { ...dados(5002, { type: 'cancellation' }), id: 5002 } },
      status: 'processado',
      empresa_id: empresa._id,
    });
    global.fetch = jest.fn().mockResolvedValue(resposta(200, dados(5002, { type: 'cancellation' })));
    expect(await novaReserva('5002')).toBeNull(); // id string no evento atual
    expect(await tarefaDe(5002)).toBeNull();
  });

  it('Smoobu diz que está ativa: cria normalmente, sem alerta', async () => {
    await logCancelamento(5003);
    global.fetch = jest.fn().mockResolvedValue(resposta(200, dados(5003)));
    await novaReserva(5003);
    const t = await tarefaDe(5003);
    expect(t).not.toBeNull();
    expect(t.alerta || '').not.toMatch(/Cancelamento recebido/);
  });

  it.each([
    ['404', 5101, () => resposta(404, {})],
    ['erro de rede', 5102, () => { throw new Error('rede em baixo'); }],
    ['resposta vazia', 5103, () => resposta(200, {})],
  ])('consulta falhou (%s): cria a tarefa com alerta visível', async (_nome, id, mk) => {
    await logCancelamento(id);
    global.fetch = jest.fn().mockImplementation(async () => mk());
    await novaReserva(id);
    const t = await tarefaDe(id);
    expect(t).not.toBeNull();
    expect(t.alerta).toMatch(/Cancelamento recebido antes da reserva/);
  });

  it('sem evento anterior de cancelamento o fluxo não muda (não consulta o Smoobu)', async () => {
    global.fetch = jest.fn();
    await novaReserva(5004);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await tarefaDe(5004)).not.toBeNull();
  });
});

describe('Reconciliação periódica', () => {
  const listaSmoobu = (reservas) =>
    jest.fn().mockResolvedValue(resposta(200, { bookings: reservas, page_count: 1 }));
  const resCapturada = () => {
    const out = { status: null, body: null };
    return { out, res: { status: (c) => ({ json: (b) => { out.status = c; out.body = b; } }) } };
  };

  it('não reativa canceladas nem mexe em concluídas/em curso; a manual mantém o comportamento', async () => {
    for (const [id, estado] of [[6001, 'cancelada'], [6002, 'concluida'], [6003, 'em_curso']]) {
      await novaReserva(id);
      await Tarefa.updateOne({ smoobu_reserva_id: String(id) }, { $set: { estado } });
    }
    const reservas = [6001, 6002, 6003].map((id) => dados(id, { arrival: '2031-06-01', departure: '2031-06-03' }));

    global.fetch = listaSmoobu(reservas);
    const rec = resCapturada();
    await sincronizarReservas({ user: { empresa_id: empresa._id }, reconciliacao: true, pausaMs: 0 }, rec.res);
    expect(rec.out.status).toBe(200);
    expect((await tarefaDe(6001)).estado).toBe('cancelada');
    expect((await tarefaDe(6002)).estado).toBe('concluida');
    const emCurso = await tarefaDe(6003);
    expect(emCurso.estado).toBe('em_curso');
    expect(emCurso.data.toISOString().slice(0, 10)).toBe('2031-05-14'); // data não foi alterada

    global.fetch = listaSmoobu(reservas);
    const man = resCapturada();
    await sincronizarReservas({ user: { empresa_id: empresa._id } }, man.res);
    expect((await tarefaDe(6001)).estado).not.toBe('cancelada'); // manual reativa, como antes
  });

  it('cria as reservas em falta', async () => {
    global.fetch = listaSmoobu([dados(6010)]);
    const rec = resCapturada();
    await sincronizarReservas({ user: { empresa_id: empresa._id }, reconciliacao: true, pausaMs: 0 }, rec.res);
    expect(rec.out.body.criadas).toBe(1);
    expect(await tarefaDe(6010)).not.toBeNull();
  });
});

describe('Retoma de webhooks presos', () => {
  const logPreso = async (action, id, minutos) => {
    const log = await WebhookLog.create({ payload: payload(action, id), status: 'recebido', empresa_id: empresa._id });
    const quando = new Date(Date.now() - minutos * 60 * 1000);
    await WebhookLog.collection.updateOne({ _id: log._id }, { $set: { updatedAt: quando, createdAt: quando } });
    return log._id;
  };

  it('processa logs recebido há mais de 10 min, ignora os recentes, e é idempotente', async () => {
    const velho = await logPreso('newReservation', 7001, 30);
    const recente = await logPreso('newReservation', 7002, 2);
    const r1 = await retomarWebhooksPresos();
    expect(r1.retomados).toBe(1);
    expect(await tarefaDe(7001)).not.toBeNull();
    expect(await tarefaDe(7002)).toBeNull();
    expect((await WebhookLog.findById(velho)).status).toBe('processado');
    expect((await WebhookLog.findById(recente)).status).toBe('recebido');
    const r2 = await retomarWebhooksPresos();
    expect(r2.retomados).toBe(0);
    expect(await Tarefa.countDocuments({ smoobu_reserva_id: '7001' })).toBe(1);
  });

  it('respeita o limite por execução', async () => {
    for (const id of [7010, 7011, 7012]) await logPreso('newReservation', id, 60);
    const r = await retomarWebhooksPresos({ limite: 2 });
    expect(r.retomados).toBe(2);
  });

  it('não retoma um evento antigo se já houve um posterior processado (não desfaz cancelamentos)', async () => {
    await novaReserva(7020);
    const antigo = await logPreso('newReservation', 7020, 60);
    await WebhookLog.create({ payload: payload('cancelReservation', 7020), status: 'processado', empresa_id: empresa._id });
    await processarReservaSmoobu(payload('cancelReservation', 7020), empresa._id, empresa._id);
    const r = await retomarWebhooksPresos();
    expect(r.saltados).toBeGreaterThanOrEqual(1);
    expect((await tarefaDe(7020)).estado).toBe('cancelada');
    expect((await WebhookLog.findById(antigo)).status).toBe('processado');
  });
});

describe('Webhooks simultâneos e hóspedes', () => {
  it('webhooks simultâneos da mesma reserva criam 1 só tarefa', async () => {
    const resultados = await Promise.all([novaReserva(8001), novaReserva(8001), novaReserva(8001)]);
    expect(resultados.every(Boolean)).toBe(true);
    expect(await Tarefa.countDocuments({ smoobu_reserva_id: '8001', empresa_id: empresa._id })).toBe(1);
  });

  it('hospedes acompanha o pax no update e mantém o valor se o pax vier vazio', async () => {
    await novaReserva(8002, { adults: 3, children: 0 });
    expect((await tarefaDe(8002)).hospedes).toBe(3);

    await processarReservaSmoobu(payload('updateReservation', 8002, { adults: 5, children: 0 }), empresa._id, empresa._id);
    expect((await tarefaDe(8002)).hospedes).toBe(5);

    await processarReservaSmoobu(payload('updateReservation', 8002, { adults: undefined, children: undefined }), empresa._id, empresa._id);
    expect((await tarefaDe(8002)).hospedes).toBe(5);
  });
});

describe('Elegibilidade da reconciliação automática', () => {
  const envOriginal = process.env.SMOOBU_API_KEY;
  afterEach(async () => {
    if (envOriginal === undefined) delete process.env.SMOOBU_API_KEY;
    else process.env.SMOOBU_API_KEY = envOriginal;
    await Empresa.deleteMany({ nome: /^Elegib/ });
  });
  const nova = (nome, extra) =>
    Empresa.create({ nome, rotinas: { sincronizacao_automatica: true, frequencia_horas: 1 }, ...extra });
  const soElegib = async (fn) => {
    // Desliga o toggle das outras empresas de teste para isolar o resultado.
    await Empresa.updateMany({ nome: { $not: /^Elegib/ } }, { $set: { 'rotinas.sincronizacao_automatica': false } });
    return fn();
  };

  it('chave só em env: elegível e ultima_sincronizacao fica gravada', async () => {
    process.env.SMOOBU_API_KEY = 'chave-env';
    const e = await nova('Elegib env', {});
    global.fetch = jest.fn().mockResolvedValue(resposta(200, { bookings: [], page_count: 1 }));
    const r = await soElegib(() => executarSincronizacaoSmoobu());
    expect(r.processadas).toBe(1);
    expect((await Empresa.findById(e._id)).integracoes.smoobu.ultima_sincronizacao).toBeTruthy();
    const r2 = await executarSincronizacaoSmoobu(); // não volta a correr no tick seguinte
    expect(r2.processadas).toBe(0);
  });

  it('chave na BD com ativo=false: saltada (mesmo com env definida)', async () => {
    process.env.SMOOBU_API_KEY = 'chave-env';
    await nova('Elegib off', { integracoes: { smoobu: { api_key: 'k', ativo: false } } });
    global.fetch = jest.fn();
    const r = await soElegib(() => executarSincronizacaoSmoobu());
    expect(r.processadas).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sem chave nenhuma: saltada com aviso', async () => {
    delete process.env.SMOOBU_API_KEY;
    await nova('Elegib sem chave', {});
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {});
    global.fetch = jest.fn();
    const r = await soElegib(() => executarSincronizacaoSmoobu());
    expect(r.processadas).toBe(0);
    expect(aviso.mock.calls.some((c) => /NÃO há chave Smoobu/.test(String(c[0])))).toBe(true);
    aviso.mockRestore();
  });
});
