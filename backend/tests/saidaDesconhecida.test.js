/**
 * Reserva do Smoobu SEM departure cuja consulta REST falha (5xx, timeout, 401): a limpeza nunca fica
 * em silêncio no dia de chegada. Fica por atribuir, com o motivo, sem pessoa nem oferta; os gestores são
 * avisados uma só vez; o WebhookLog fica em erro com a mensagem; uma sincronização posterior com a data
 * real corrige o dia e atribui, sem duplicados. `fetch` é simulado: nada chama o Smoobu real.
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
const Notificacao = require('../models/Notificacao');
const {
  processarWebhookSmoobu,
  sincronizarReservas,
} = require('../controllers/smoobuController');

const MOTIVO = 'Data de saída desconhecida: o Smoobu não respondeu. Confirma a data.';

let mongod;
let empresa;
let gestor;
const fetchOriginal = global.fetch;

const dados = (id, extra = {}) => ({
  id,
  type: 'reservation',
  arrival: '2031-09-10',
  departure: '2031-09-14',
  apartment: { id: 888, name: 'Casa S' },
  'guest-name': 'Hospede Teste',
  adults: 2,
  children: 0,
  ...extra,
});
// Webhook novo do Smoobu: só traz arrival (sem departure).
const semSaida = (id) => ({ action: 'newReservation', user: 1, data: { ...dados(id), departure: undefined } });
const resposta = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  json: async () => body,
  text: async () => JSON.stringify(body),
});
const dia = (t) => t.data.toISOString().slice(0, 10);
const tarefasDe = (id) => Tarefa.find({ smoobu_reserva_id: String(id) });

// Corre o webhook como na produção (com o WebhookLog) e devolve o log final.
const receber = async (payload) => {
  const log = await WebhookLog.create({ payload, status: 'recebido', empresa_id: empresa._id });
  await processarWebhookSmoobu(payload, log._id, empresa._id, empresa._id);
  return WebhookLog.findById(log._id);
};
const sincronizar = async (reservas) => {
  global.fetch = jest.fn().mockResolvedValue(resposta(200, { bookings: reservas, page_count: 1 }));
  const out = { status: null, body: null };
  await sincronizarReservas(
    { user: { empresa_id: empresa._id }, reconciliacao: true, pausaMs: 0 },
    { status: (c) => ({ json: (b) => { out.status = c; out.body = b; } }) }
  );
  return out;
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
  empresa = await Empresa.create({
    nome: 'Empresa Saída',
    integracoes: { smoobu: { api_key: 'chave-de-teste', ativo: true } },
  });
  await Propriedade.create({
    nome: 'Casa S', empresa_id: empresa._id, smoobu_id: '888', ativo: true, capacidade_hospedes: 4,
  });
  const hash = await bcrypt.hash('password-de-teste-1', 10);
  gestor = await Utilizador.create({
    nome: 'Gestora', email: 'g@s.pt', password_hash: hash, empresa_id: empresa._id, role: 'gestor', ativo: true,
  });
  await Utilizador.create({
    nome: 'Ana', email: 'ana@s.pt', password_hash: hash, empresa_id: empresa._id, role: 'staff', ativo: true, dias_folga: [],
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

describe('Consulta à data de saída falhada', () => {
  it.each([
    ['5xx', 7001, () => resposta(503, { message: 'indisponível' })],
    ['timeout', 7002, () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; }],
    ['401', 7003, () => resposta(401, { message: 'unauthorized' })],
  ])('%s: limpeza por atribuir, com motivo, sem pessoa nem oferta, gestor avisado e log em erro', async (_n, id, mk) => {
    global.fetch = jest.fn().mockImplementation(async () => mk());
    const log = await receber(semSaida(id));

    const ts = await tarefasDe(id);
    expect(ts).toHaveLength(1);
    const t = ts[0];
    expect(t.estado).toBe('por_atribuir');
    expect(t.motivo_nao_atribuicao).toBe(MOTIVO);
    expect(t.utilizador_id).toBeNull();
    expect(t.equipa_atribuida).toHaveLength(0);
    expect(t.oferta_estado || null).not.toBe('aberta');
    expect(t.data_saida_desconhecida).toBe(true);
    expect(dia(t)).toBe('2031-09-10'); // dia de chegada, provisório

    // Gestor avisado (sino), uma vez.
    const avisos = await Notificacao.find({ utilizador_id: gestor._id, chave: `smoobu_saida_desconhecida:${empresa._id}:${id}` });
    expect(avisos).toHaveLength(1);

    // WebhookLog com estado e mensagem que permitem perceber.
    expect(log.status).toBe('erro');
    expect(log.erro_msg).toContain(MOTIVO);
  });

  it('o mesmo webhook repetido não duplica a limpeza nem o aviso', async () => {
    global.fetch = jest.fn().mockResolvedValue(resposta(503, {}));
    await receber(semSaida(7010));
    await receber(semSaida(7010));
    expect(await tarefasDe(7010)).toHaveLength(1);
    expect(await Notificacao.countDocuments({ chave: `smoobu_saida_desconhecida:${empresa._id}:7010` })).toBe(1);
  });

  it('um update sem data de saída (e consulta falhada) não move uma limpeza que já tinha dia', async () => {
    global.fetch = jest.fn().mockResolvedValue(resposta(200, dados(7011)));
    await receber(semSaida(7011)); // consulta bem-sucedida: dia 14
    const antes = (await tarefasDe(7011))[0];
    expect(dia(antes)).toBe('2031-09-14');
    global.fetch = jest.fn().mockResolvedValue(resposta(500, {}));
    await receber({ action: 'updateReservation', user: 1, data: { ...dados(7011), departure: undefined } });
    const depois = await tarefasDe(7011);
    expect(depois).toHaveLength(1);
    expect(dia(depois[0])).toBe('2031-09-14');
    expect(depois[0].data_saida_desconhecida).toBe(false);
  });

  it('a sincronização seguinte com a data real corrige o dia, atribui e fecha o erro do log, sem duplicados', async () => {
    global.fetch = jest.fn().mockResolvedValue(resposta(503, {}));
    const log = await receber(semSaida(7020));
    expect(log.status).toBe('erro');
    expect((await tarefasDe(7020))[0].estado).toBe('por_atribuir');

    const r = await sincronizar([dados(7020)]);
    expect(r.status).toBe(200);
    expect(r.body.erros).toBe(0);

    const ts = await tarefasDe(7020);
    expect(ts).toHaveLength(1);
    const t = ts[0];
    expect(dia(t)).toBe('2031-09-14');
    expect(t.data_saida_desconhecida).toBe(false);
    expect(t.estado).toBe('atribuida');
    expect(t.utilizador_id).not.toBeNull();
    expect(t.motivo_nao_atribuicao || null).toBeNull();
    expect(t.alerta || '').not.toMatch(/Data de saída desconhecida/);

    const logDepois = await WebhookLog.findById(log._id);
    expect(logDepois.status).toBe('processado');
    expect(logDepois.erro_msg).toMatch(/confirmada/);
  });

  it('um novo webhook com departure também corrige', async () => {
    global.fetch = jest.fn().mockResolvedValue(resposta(401, {}));
    await receber(semSaida(7030));
    const novo = { action: 'updateReservation', user: 1, data: dados(7030) };
    const log = await receber(novo);
    expect(log.status).toBe('processado');
    const ts = await tarefasDe(7030);
    expect(ts).toHaveLength(1);
    expect(dia(ts[0])).toBe('2031-09-14');
    expect(ts[0].data_saida_desconhecida).toBe(false);
  });
});

describe('Caminho normal sem alterações', () => {
  it('webhook com departure: cria no dia de saída, não consulta o Smoobu e o log fica processado', async () => {
    global.fetch = jest.fn();
    const log = await receber({ action: 'newReservation', user: 1, data: dados(7100) });
    expect(global.fetch).not.toHaveBeenCalled();
    const ts = await tarefasDe(7100);
    expect(ts).toHaveLength(1);
    expect(dia(ts[0])).toBe('2031-09-14');
    expect(ts[0].data_saida_desconhecida).toBe(false);
    expect(ts[0].estado).toBe('atribuida');
    expect(log.status).toBe('processado');
    expect(await Notificacao.countDocuments({ chave: new RegExp('^smoobu_saida_desconhecida') , tarefa_id: ts[0]._id })).toBe(0);
  });

  it('sem departure mas consulta bem-sucedida: usa a data de saída da consulta', async () => {
    global.fetch = jest.fn().mockResolvedValue(resposta(200, dados(7101)));
    const log = await receber(semSaida(7101));
    const ts = await tarefasDe(7101);
    expect(dia(ts[0])).toBe('2031-09-14');
    expect(ts[0].data_saida_desconhecida).toBe(false);
    expect(log.status).toBe('processado');
  });
});
