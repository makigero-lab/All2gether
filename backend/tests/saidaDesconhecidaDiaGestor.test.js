/**
 * A5: o gestor mexeu (mudar dia / atribuir) numa limpeza provisória (reserva do Smoobu sem data de saída) e
 * depois chega a data real. A data do Smoobu manda; o gestor é avisado (sino, deduplicado) se o dia real for
 * diferente do que ele pôs; a pessoa que escolheu mantém-se se estiver disponível no dia novo; senão segue o
 * fluxo normal. A marca provisória não se tira ao mexer. `fetch` é simulado.
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
const { processarWebhookSmoobu, sincronizarReservas } = require('../controllers/smoobuController');
const { mudarDiaTarefa, atribuirTarefa } = require('../controllers/tarefaController');

let mongod;
let empresa;
let gestor;
let ana;
let bia;
const fetchOriginal = global.fetch;

// 2031-09-14 é domingo (dia 0); 2031-09-10 e 2031-09-12 são dias úteis.
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
const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const aviso = (tarefaId, diaReal) => Notificacao.find({ chave: `smoobu_dia_gestor_corrigido:${tarefaId}:${diaReal}` });
const reqGestor = (tarefa, body) => ({ user: { empresa_id: empresa._id, role: 'gestor', _id: gestor._id }, params: { id: String(tarefa._id) }, body });

// Cria a limpeza provisória (consulta 503) e devolve-a.
const provisoria = async (id) => {
  global.fetch = jest.fn().mockResolvedValue(resposta(503, {}));
  const payload = semSaida(id);
  const log = await WebhookLog.create({ payload, status: 'recebido', empresa_id: empresa._id });
  await processarWebhookSmoobu(payload, log._id, empresa._id, empresa._id);
  const t = await Tarefa.findOne({ smoobu_reserva_id: String(id), empresa_id: empresa._id });
  expect(t.data_saida_desconhecida).toBe(true);
  return t;
};
const chegaDataReal = async (reservas) => {
  global.fetch = jest.fn().mockResolvedValue(resposta(200, { bookings: reservas, page_count: 1 }));
  await sincronizarReservas(
    { user: { empresa_id: empresa._id }, reconciliacao: true, pausaMs: 0 },
    { status: () => ({ json: () => {} }) }
  );
};

beforeAll(async () => {
  process.env.DATAS_SEM_LIMITES = '1';
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Tarefa.init();
  empresa = await Empresa.create({ nome: 'Empresa A5', integracoes: { smoobu: { api_key: 'chave-de-teste', ativo: true } } });
  await Propriedade.create({ nome: 'Casa S', empresa_id: empresa._id, smoobu_id: '888', ativo: true, capacidade_hospedes: 4 });
  const hash = await bcrypt.hash('password-de-teste-1', 6);
  gestor = await Utilizador.create({ nome: 'Gestora', email: 'g@s.pt', password_hash: hash, empresa_id: empresa._id, role: 'gestor', ativo: true });
  ana = await Utilizador.create({ nome: 'Ana', email: 'ana@s.pt', password_hash: hash, empresa_id: empresa._id, role: 'staff', ativo: true, dias_folga: [] });
  // Bia folga ao domingo (a data real, 14/09, é domingo).
  bia = await Utilizador.create({ nome: 'Bia', email: 'bia@s.pt', password_hash: hash, empresa_id: empresa._id, role: 'staff', ativo: true, dias_folga: [0] });
});
afterEach(() => { global.fetch = fetchOriginal; });
afterAll(async () => {
  global.fetch = fetchOriginal;
  delete process.env.DATAS_SEM_LIMITES;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('A5: o gestor mexeu na limpeza provisória e chega a data real', () => {
  it('mudar dia regista o dia e quem, sem tirar a marca provisória', async () => {
    const t = await provisoria(9901);
    const r = res();
    await mudarDiaTarefa(reqGestor(t, { data: '2031-09-12' }), r);
    expect(r.code).toBe(200);
    const t1 = await Tarefa.findById(t._id);
    expect(t1.data_saida_desconhecida).toBe(true);
    expect(t1.dia_mudado_pelo_gestor.dia).toBe('2031-09-12');
    expect(String(t1.dia_mudado_pelo_gestor.por)).toBe(String(gestor._id));
    expect(t1.dia_mudado_pelo_gestor.em).toBeInstanceOf(Date);
  });

  it('dia real diferente do que o gestor pôs: passa para o dia real e o gestor é avisado uma só vez', async () => {
    const t = await provisoria(9902);
    await mudarDiaTarefa(reqGestor(t, { data: '2031-09-12' }), res());
    await chegaDataReal([dados(9902)]);
    const t2 = await Tarefa.findById(t._id);
    expect(dia(t2)).toBe('2031-09-14'); // a data do Smoobu manda
    expect(t2.data_saida_desconhecida).toBe(false);
    expect(t2.dia_mudado_pelo_gestor && t2.dia_mudado_pelo_gestor.dia).toBeFalsy();
    const avisos = await aviso(t._id, '2031-09-14');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].mensagem).toMatch(/Casa S, que tinhas posto a 12\/09, passou para 14\/09, a data de saída real do Smoobu/);
    // Nova sincronização igual: sem segundo aviso.
    await chegaDataReal([dados(9902)]);
    expect(await aviso(t._id, '2031-09-14')).toHaveLength(1);
  });

  it('dia real igual ao que o gestor pôs: sem aviso', async () => {
    const t = await provisoria(9903);
    await mudarDiaTarefa(reqGestor(t, { data: '2031-09-14' }), res());
    await chegaDataReal([dados(9903)]);
    const t2 = await Tarefa.findById(t._id);
    expect(dia(t2)).toBe('2031-09-14');
    expect(t2.data_saida_desconhecida).toBe(false);
    expect(await Notificacao.countDocuments({ chave: new RegExp(`^smoobu_dia_gestor_corrigido:${t._id}:`) })).toBe(0);
  });

  it('sem intervenção do gestor: sem aviso de correção', async () => {
    const t = await provisoria(9904);
    await chegaDataReal([dados(9904)]);
    expect(dia(await Tarefa.findById(t._id))).toBe('2031-09-14');
    expect(await Notificacao.countDocuments({ chave: new RegExp(`^smoobu_dia_gestor_corrigido:${t._id}:`) })).toBe(0);
  });

  it('atribuir à mão: regista o dia; com a pessoa disponível no dia real ela mantém-se e o aviso diz isso', async () => {
    const t = await provisoria(9905);
    const r = res();
    await atribuirTarefa(reqGestor(t, { utilizador_id: String(ana._id) }), r);
    expect(r.code).toBe(200);
    const t1 = await Tarefa.findById(t._id);
    expect(String(t1.utilizador_id)).toBe(String(ana._id));
    expect(t1.data_saida_desconhecida).toBe(true);
    expect(t1.dia_mudado_pelo_gestor.dia).toBe('2031-09-10');

    await chegaDataReal([dados(9905)]);
    const t2 = await Tarefa.findById(t._id);
    expect(dia(t2)).toBe('2031-09-14');
    expect(String(t2.utilizador_id)).toBe(String(ana._id)); // mantém-se
    expect(t2.estado).toBe('atribuida');
    const avisos = await aviso(t._id, '2031-09-14');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].mensagem).toMatch(/tinhas posto a 10\/09, passou para 14\/09/);
    expect(avisos[0].mensagem).toMatch(/Ana mantém-se, está disponível nesse dia/);
  });

  it('pessoa escolhida indisponível no dia real (folga ao domingo): segue o fluxo normal e o aviso diz isso', async () => {
    const t = await provisoria(9906);
    await atribuirTarefa(reqGestor(t, { utilizador_id: String(bia._id) }), res());
    expect(String((await Tarefa.findById(t._id)).utilizador_id)).toBe(String(bia._id));

    await chegaDataReal([dados(9906)]);
    const t2 = await Tarefa.findById(t._id);
    expect(dia(t2)).toBe('2031-09-14');
    expect(String(t2.utilizador_id || '')).not.toBe(String(bia._id)); // Bia está de folga
    expect(t2.data_saida_desconhecida).toBe(false);
    // Atribuição automática (Ana está livre) ou, no limite, por atribuir: o aviso reflete o que aconteceu.
    const avisos = await aviso(t._id, '2031-09-14');
    expect(avisos).toHaveLength(1);
    expect(avisos[0].mensagem).toMatch(/A pessoa que escolheste não está disponível nesse dia/);
    if (t2.estado === 'atribuida') {
      expect(String(t2.utilizador_id)).toBe(String(ana._id));
      expect(avisos[0].mensagem).toMatch(/atribuída automaticamente a outra pessoa/);
    } else {
      expect(['por_atribuir', 'nao_atribuida']).toContain(t2.estado);
      expect(avisos[0].mensagem).toMatch(/ficou por atribuir/);
    }
  });
});
