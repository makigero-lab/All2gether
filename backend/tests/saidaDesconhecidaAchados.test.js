/**
 * Achados do @Tester sobre «Smoobu sem data de saída» (baseados nos testes N5, N8 e N16 dele):
 *  - A2: bloqueio descoberto pela consulta REST (sem departure) não é uma limpeza provisória: log 'processado'.
 *  - A3: update sem data numa limpeza já no dia certo: o log diz a verdade (nota, não erro).
 *  - A4: isolamento entre empresas com o mesmo id de reserva (idempotência, fecho de logs de erro).
 * `fetch` é simulado: nada chama o Smoobu real.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const bcrypt = require('bcryptjs');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
}));

const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');
const WebhookLog = require('../models/WebhookLog');
const { processarWebhookSmoobu, sincronizarReservas } = require('../controllers/smoobuController');

let mongod;
let empresa;
let empresaB;
const fetchOriginal = global.fetch;

const dados = (id, extra = {}) => ({
  id, type: 'reservation', arrival: '2031-09-10', departure: '2031-09-14',
  apartment: { id: 888, name: 'Casa S' }, 'guest-name': 'Hospede Teste', adults: 2, children: 0, ...extra,
});
const semSaida = (id) => ({ action: 'newReservation', user: 1, data: { ...dados(id), departure: undefined } });
const resposta = (status, body) => ({
  ok: status >= 200 && status < 300, status, statusText: String(status),
  json: async () => body, text: async () => JSON.stringify(body),
});
const dia = (t) => t.data.toISOString().slice(0, 10);
const tarefasDe = (id, emp = empresa) => Tarefa.find({ smoobu_reserva_id: String(id), empresa_id: emp._id });
const receber = async (payload, emp = empresa) => {
  const log = await WebhookLog.create({ payload, status: 'recebido', empresa_id: emp._id });
  await processarWebhookSmoobu(payload, log._id, emp._id, emp._id);
  return WebhookLog.findById(log._id);
};
const sincronizar = async (reservas, emp = empresa) => {
  global.fetch = jest.fn().mockResolvedValue(resposta(200, { bookings: reservas, page_count: 1 }));
  const out = {};
  await sincronizarReservas(
    { user: { empresa_id: emp._id }, reconciliacao: true, pausaMs: 0 },
    { status: (c) => ({ json: (b) => { out.status = c; out.body = b; } }) }
  );
  return out;
};

const criarEmpresa = async (nome, sufixo) => {
  const e = await Empresa.create({ nome, integracoes: { smoobu: { api_key: 'chave-de-teste', ativo: true } } });
  await Propriedade.create({ nome: 'Casa S', empresa_id: e._id, smoobu_id: '888', ativo: true, capacidade_hospedes: 4 });
  const hash = await bcrypt.hash('password-de-teste-1', 6);
  await Utilizador.create({ nome: `Gestor ${sufixo}`, email: `g${sufixo}@s.pt`, password_hash: hash, empresa_id: e._id, role: 'gestor', ativo: true });
  await Utilizador.create({ nome: `Ana ${sufixo}`, email: `ana${sufixo}@s.pt`, password_hash: hash, empresa_id: e._id, role: 'staff', ativo: true, dias_folga: [] });
  return e;
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
  empresa = await criarEmpresa('Empresa A', 'a');
  empresaB = await criarEmpresa('Empresa B', 'b');
});
afterEach(() => { global.fetch = fetchOriginal; });
afterAll(async () => {
  global.fetch = fetchOriginal;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('A2: bloqueio descoberto pela consulta REST', () => {
  it('webhook sem departure cuja consulta devolve is-blocked-booking sem departure: nada criado, log processado', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      resposta(200, { ...dados(9404), departure: undefined, 'is-blocked-booking': true })
    );
    const log = await receber(semSaida(9404));
    expect(await tarefasDe(9404)).toHaveLength(0);
    expect(log.status).toBe('processado');
    expect(log.erro_msg || '').not.toMatch(/Limpeza criada/);
  });
});

describe('A3: update sem data de saída numa limpeza já no dia certo', () => {
  it('não a move e o log diz a verdade (processado com nota, sem texto de «criada por atribuir»)', async () => {
    global.fetch = jest.fn().mockResolvedValue(resposta(200, dados(9400)));
    await receber(semSaida(9400));
    global.fetch = jest.fn().mockResolvedValue(resposta(500, {}));
    const log = await receber({ action: 'updateReservation', user: 1, data: { ...dados(9400), departure: undefined } });

    const ts = await tarefasDe(9400);
    expect(ts).toHaveLength(1);
    expect(dia(ts[0])).toBe('2031-09-14');
    expect(ts[0].data_saida_desconhecida).toBe(false);
    expect(log.status).toBe('processado');
    expect(log.erro_msg).toBe('Sem data de saída na alteração; a limpeza mantém-se em 14/09.');
  });

  it('numa limpeza ainda provisória o log fica em erro e diz que continua por atribuir', async () => {
    global.fetch = jest.fn().mockResolvedValue(resposta(503, {}));
    await receber(semSaida(9401));
    const log = await receber({ action: 'updateReservation', user: 1, data: { ...dados(9401), departure: undefined } });
    expect(log.status).toBe('erro');
    expect(log.erro_msg).toMatch(/continua por atribuir/);
    expect(log.erro_msg).not.toMatch(/Limpeza criada/);
    const ts = await tarefasDe(9401);
    expect(ts).toHaveLength(1);
    expect(ts[0].data_saida_desconhecida).toBe(true);
  });
});

describe('A4: duas empresas com o mesmo id de reserva', () => {
  it('a sincronização de uma empresa não fecha o log de erro da outra', async () => {
    global.fetch = jest.fn().mockResolvedValue(resposta(503, {}));
    const logA = await receber(semSaida(9700), empresa);
    const logB = await receber(semSaida(9700), empresaB);
    expect(await tarefasDe(9700, empresa)).toHaveLength(1);
    expect(await tarefasDe(9700, empresaB)).toHaveLength(1);

    await sincronizar([dados(9700)], empresa);

    expect((await WebhookLog.findById(logA._id)).status).toBe('processado');
    const lB = await WebhookLog.findById(logB._id);
    expect(lB.status).toBe('erro');
    const tB = await tarefasDe(9700, empresaB);
    expect(tB).toHaveLength(1);
    expect(tB[0].data_saida_desconhecida).toBe(true);
    expect(dia(tB[0])).toBe('2031-09-10');
    expect((await tarefasDe(9700, empresa))[0].data_saida_desconhecida).toBe(false);
  });

  it('idempotência com empresa: o mesmo id numa segunda empresa cria a sua própria limpeza', async () => {
    await receber({ action: 'newReservation', user: 1, data: dados(9710) }, empresa);
    await receber({ action: 'newReservation', user: 1, data: dados(9710) }, empresaB);
    expect(await tarefasDe(9710, empresa)).toHaveLength(1);
    expect(await tarefasDe(9710, empresaB)).toHaveLength(1);
    // Webhook repetido continua idempotente dentro de cada empresa.
    await receber({ action: 'newReservation', user: 1, data: dados(9710) }, empresaB);
    expect(await tarefasDe(9710, empresaB)).toHaveLength(1);
    expect(await Tarefa.countDocuments({ smoobu_reserva_id: '9710' })).toBe(2);
  });

  it('o índice único é por (reserva, empresa)', async () => {
    const idx = await Tarefa.collection.indexes();
    const u = idx.find((i) => i.name === 'smoobu_reserva_empresa_unico');
    expect(u).toBeTruthy();
    expect(u.key).toEqual({ smoobu_reserva_id: 1, empresa_id: 1 });
    expect(u.unique).toBe(true);
  });
});
