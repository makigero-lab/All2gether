/**
 * Achados do @Tester sobre a chave do Smoobu da empresa cifrada (A1 a A7): estado "ilegível", job, webhook sem
 * departure, scripts (cifrar, rotação, reversão), listagem do admin, export RGPD e verificação de arranque.
 */
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

jest.mock('../utils/geocoding', () => ({
  obterCoordenadas: jest.fn().mockResolvedValue({ lat: 38.7223, lng: -9.1393 }),
  googleMapsAtivo: () => false,
}));

const app = require('../server');
const Empresa = require('../models/Empresa');
const Utilizador = require('../models/Utilizador');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const WebhookLog = require('../models/WebhookLog');
const { cifrarChaveSmoobu } = require('../scripts/cifrar-chave-smoobu');
const { decifrarChaveSmoobu } = require('../scripts/decifrar-chave-smoobu');
const { rodarChaveIcal } = require('../scripts/rodarChaveIcal');
const { limparSegredos } = require('../utils/rgpdEmpresa');
const { verificarCredenciaisSmoobu } = require('../utils/verificarCredenciaisSmoobu');
const { executarSincronizacaoSmoobu } = require('../jobs/sincronizacaoSmoobu');
const { processarWebhookSmoobu, testarLigacaoSmoobu } = require('../controllers/smoobuController');
const seg = require('../utils/segredoEmpresa');

const hash = bcrypt.hashSync('p-de-teste-123', 4);
const CHAVES_ENV = ['ICAL_CHAVES', 'ICAL_CHAVE_ATUAL', 'ICAL_HMAC_CHAVE', 'SMOOBU_API_KEY', 'SMOOBU_API_SECRET'];
const guardado = {};
const CHAVE = 'chave-smoobu-secreta-123456';
const SEGREDO = 'segredo-hmac-smoobu-abcdef';
const b64 = () => crypto.randomBytes(32).toString('base64');
let mongod;
let n = 0;
let fetchOriginal;

const chave1 = b64();
const chave2 = b64();
function ligarChaves(extra = {}) {
  process.env.ICAL_CHAVES = `1:${chave1}`;
  process.env.ICAL_CHAVE_ATUAL = '1';
  process.env.ICAL_HMAC_CHAVE = b64();
  Object.assign(process.env, extra);
}
function desligarChaves() { CHAVES_ENV.forEach((k) => delete process.env[k]); }
/** Perde as chaves: o valor cifrado continua na BD mas o servidor já não o decifra. */
function perderChaves() { process.env.ICAL_CHAVES = `1:${b64()}`; }

beforeAll(async () => {
  CHAVES_ENV.forEach((k) => { guardado[k] = process.env[k]; });
  fetchOriginal = global.fetch;
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  CHAVES_ENV.forEach((k) => { if (guardado[k] === undefined) delete process.env[k]; else process.env[k] = guardado[k]; });
  global.fetch = fetchOriginal;
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(() => {
  desligarChaves();
  global.fetch = fetchOriginal;
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const bruto = (id) => Empresa.collection.findOne({ _id: id }).then((d) => d.integracoes.smoobu);
const comCifra = async (e, chave = CHAVE, segredo = SEGREDO) => {
  await Empresa.collection.updateOne({ _id: e._id }, { $set: {
    'integracoes.smoobu.api_key': seg.protegerSegredo(chave, e._id, 'api_key'),
    'integracoes.smoobu.api_key_hmac': seg.hmacChave(chave),
    'integracoes.smoobu.api_secret': seg.protegerSegredo(segredo, e._id, 'api_secret'),
  } });
};
async function gestor(role = 'gestor', smoobu = { ativo: true }, extra = {}) {
  n++;
  const e = await Empresa.create({ nome: 'A' + n, integracoes: { smoobu }, ...extra });
  const g = await Utilizador.create({ nome: 'g', email: `a${n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const login = await request(app).post('/api/auth/login').send({ email: g.email, password: 'p-de-teste-123' });
  return { e, token: login.body.token };
}
const aut = (t) => ({ Authorization: `Bearer ${t}` });
const resposta = (status, corpo) => ({ ok: status >= 200 && status < 300, status, statusText: '', json: async () => corpo, text: async () => JSON.stringify(corpo) });

// ---------------------------------------------------------------- A1
describe('A1: chaves ICAL_* perdidas depois de cifrar', () => {
  test('estado ilegível nas Configurações (as duas rotas) e tem_* não dizem verdadeiro com a máscara vazia', async () => {
    ligarChaves();
    const g = await gestor();
    await comCifra(g.e);
    // antes de perder as chaves: tudo normal
    let r = await request(app).get('/api/gestor/configuracoes').set(aut(g.token));
    expect(r.body).toMatchObject({ tem_api_key: true, tem_segredo: true, ilegivel: false });
    expect(r.body.smoobu_api_key_mascarada).toMatch(/3456$/);

    perderChaves();
    r = await request(app).get('/api/gestor/configuracoes').set(aut(g.token));
    expect(r.body).toMatchObject({ tem_api_key: false, tem_segredo: false, ilegivel: true, smoobu_api_key_mascarada: '' });
    expect(r.body.mensagem_ilegivel).toBe(seg.MSG_CREDENCIAIS_ILEGIVEIS);
    expect(r.body.mensagem_ilegivel).toContain('ICAL_CHAVES');
    const r2 = await request(app).get('/api/gestor/configuracoes/integracoes').set(aut(g.token));
    expect(r2.body.smoobu).toMatchObject({ ilegivel: true, tem_api_key: false, tem_segredo: false, api_key_mascarada: '' });
    expect(r2.body.smoobu.mensagem_ilegivel).toBe(seg.MSG_CREDENCIAIS_ILEGIVEIS);
    expect(JSON.stringify([r.body, r2.body])).not.toContain('v1:');
  });

  test('"Testar ligação" e as ações manuais dizem que a chave está ilegível (não "falta a chave")', async () => {
    ligarChaves();
    const g = await gestor();
    await comCifra(g.e);
    perderChaves();
    global.fetch = jest.fn();
    const t = await request(app).post('/api/gestor/configuracoes/integracoes/testar').set(aut(g.token)).send({});
    expect(t.body).toMatchObject({ ok: false, mensagem: seg.MSG_CREDENCIAIS_ILEGIVEIS });
    expect((await testarLigacaoSmoobu(g.e._id)).mensagem).not.toMatch(/Falta a chave/);
    const p = await request(app).get('/api/gestor/smoobu/propriedades').set(aut(g.token));
    expect(p.status).toBe(400);
    expect(p.body.erro).toBe(seg.MSG_CREDENCIAIS_ILEGIVEIS);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sem cifra nada muda: claro continua a funcionar e sem chave continua a dizer "falta a chave"', async () => {
    const g = await gestor('gestor', { ativo: true, api_key: CHAVE });
    await Empresa.collection.updateOne({ _id: g.e._id }, { $set: { 'integracoes.smoobu.api_secret': SEGREDO } });
    const r = await request(app).get('/api/gestor/configuracoes').set(aut(g.token));
    expect(r.body).toMatchObject({ tem_api_key: true, tem_segredo: true, ilegivel: false, smoobu_ativo: true });
    expect(await require('../controllers/smoobuController').obterApiKeySmoobu(g.e._id)).toEqual({ chave: CHAVE, segredo: SEGREDO, origem: 'empresa' });
    const vazia = await gestor();
    expect((await testarLigacaoSmoobu(vazia.e._id)).mensagem).toMatch(/Falta a chave/);
    expect(await require('../controllers/smoobuController').obterApiKeySmoobu(vazia.e._id)).toEqual({ chave: null, segredo: '', origem: null });
  });

  test('o job horário regista o erro na empresa e uma sincronização boa seguinte limpa-o', async () => {
    await Empresa.updateMany({}, { $set: { 'rotinas.sincronizacao_automatica': false } });
    ligarChaves();
    const g = await gestor('gestor', { ativo: true, ultimo_resultado: { em: new Date(Date.now() - 86400000), ok: true, mensagem: 'Sincronização concluída.' } }, { rotinas: { sincronizacao_automatica: true, frequencia_horas: 1 } });
    await comCifra(g.e);
    perderChaves();
    global.fetch = jest.fn();
    await executarSincronizacaoSmoobu();
    let s = await bruto(g.e._id);
    expect(s.ultimo_resultado.ok).toBe(false);
    expect(s.ultimo_resultado.mensagem).toBe(seg.MSG_CREDENCIAIS_ILEGIVEIS);
    expect(s.ultimo_resultado.em.getTime()).toBeGreaterThan(Date.now() - 60000);
    const ecra = await request(app).get('/api/gestor/configuracoes/integracoes').set(aut(g.token));
    expect(ecra.body.smoobu.ultimo_resultado).toMatchObject({ ok: false, mensagem: seg.MSG_CREDENCIAIS_ILEGIVEIS });
    expect(global.fetch).not.toHaveBeenCalled();

    // chaves repostas: a sincronização corre e o resultado volta a "ok"
    process.env.ICAL_CHAVES = `1:${chave1}`;
    global.fetch = jest.fn().mockResolvedValue(resposta(200, { bookings: [], page_count: 1 }));
    await executarSincronizacaoSmoobu();
    s = await bruto(g.e._id);
    expect(s.ultimo_resultado.ok).toBe(true);
    await Empresa.updateMany({}, { $set: { 'rotinas.sincronizacao_automatica': false } });
  });

  describe('webhook de reserva nova sem departure', () => {
    const payload = (id, extra = {}) => ({ action: 'newReservation', data: { id, type: 'reservation', arrival: '2032-02-01', apartment: { id: 5551 }, 'guest-name': 'Fulano', adults: 2, children: 0, ...extra } });
    async function preparar(smoobu) {
      const g = await gestor('gestor', smoobu);
      await Propriedade.create({ nome: 'Casa ' + n, empresa_id: g.e._id, smoobu_id: '5551', ativo: true, capacidade_hospedes: 4 });
      return g;
    }
    const processar = async (g, corpo) => {
      const log = await WebhookLog.create({ payload: corpo, status: 'recebido' });
      await processarWebhookSmoobu(corpo, log._id, g.e._id, g.e._id);
      return WebhookLog.findById(log._id).lean();
    };

    test('comportamento atual em produção (claro): a sincronização completa vai buscar a saída e a limpeza fica no check-out', async () => {
      const g = await preparar({ ativo: true, api_key: CHAVE });
      await Empresa.collection.updateOne({ _id: g.e._id }, { $set: { 'integracoes.smoobu.api_secret': SEGREDO } });
      global.fetch = jest.fn().mockResolvedValue(resposta(200, { id: 8101, arrival: '2032-02-01', departure: '2032-02-05', 'guest-name': 'Fulano' }));
      const l = await processar(g, payload(8101));
      expect(l.status).toBe('processado');
      const t = await Tarefa.findOne({ smoobu_reserva_id: '8101' }).lean();
      expect(new Date(t.data_hora_agendada || t.data_limite || t.data).toISOString().slice(0, 10)).toBe('2032-02-05');
    });

    test('com a chave ilegível NÃO cria a limpeza no dia de chegada: o log fica com erro explícito e o gestor é avisado', async () => {
      ligarChaves();
      const g = await preparar({ ativo: true });
      await comCifra(g.e);
      perderChaves();
      global.fetch = jest.fn();
      const l = await processar(g, payload(8102));
      expect(l.status).toBe('erro');
      expect(l.erro_msg).toContain('ICAL_CHAVES');
      expect(l.erro_msg).toContain('8102');
      expect(await Tarefa.countDocuments({ smoobu_reserva_id: '8102' })).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
      const Notificacao = require('../models/Notificacao');
      expect(await Notificacao.countDocuments({ chave: `smoobu_credenciais_ilegiveis:${g.e._id}` })).toBeGreaterThan(0);
    });

    test('com departure no webhook e chave ilegível processa normalmente (não precisa de consultar)', async () => {
      ligarChaves();
      const g = await preparar({ ativo: true });
      await comCifra(g.e);
      perderChaves();
      global.fetch = jest.fn();
      const l = await processar(g, payload(8103, { departure: '2032-02-06' }));
      expect(l.status).toBe('processado');
      expect(await Tarefa.countDocuments({ smoobu_reserva_id: '8103' })).toBe(1);
    });
  });

  test('cifrar-chave-smoobu --aplicar com a chave de cifra errada ABORTA em vez de dizer "falhas: 0"', async () => {
    await Empresa.deleteMany({});
    ligarChaves();
    const e = await Empresa.create({ nome: 'C1', integracoes: { smoobu: { ativo: true } } });
    await comCifra(e);
    const antes = await bruto(e._id);
    perderChaves();
    const sim = await cifrarChaveSmoobu();
    expect(sim).toMatchObject({ aplicado: false, ilegiveis: 1, falhas: 1, ja_cifradas: 0 });
    await expect(cifrarChaveSmoobu({ aplicar: true })).rejects.toThrow(/Abortado, nada foi escrito.*decifrar/);
    expect(await bruto(e._id)).toEqual(antes);
  });

  test('repor só a chave (segredo ilegível) dá mensagem a pedir também o segredo; chave e segredo juntos repõem tudo', async () => {
    ligarChaves();
    const g = await gestor();
    await comCifra(g.e);
    perderChaves();
    const so = await request(app).put('/api/gestor/configuracoes').set(aut(g.token)).send({ smoobu_api_key: 'nova-chave-654321' });
    expect(so.status).toBe(400);
    expect(so.body.erro).toMatch(/também o segredo/);
    const so2 = await request(app).put('/api/gestor/configuracoes/integracoes').set(aut(g.token)).send({ smoobu: { api_key: 'nova-chave-654321' } });
    expect(so2.status).toBe(400);
    expect(so2.body.erro).toMatch(/segredo/);
    const soSeg = await request(app).put('/api/gestor/configuracoes/integracoes').set(aut(g.token)).send({ smoobu: { api_secret: 'novo-segredo-1234' } });
    expect(soSeg.status).toBe(400);
    expect(soSeg.body.erro).toMatch(/a chave/);
    // nada mudou na BD
    expect((await bruto(g.e._id)).api_key).toMatch(/^v1:/);

    const ok = await request(app).put('/api/gestor/configuracoes').set(aut(g.token)).send({ smoobu_api_key: 'nova-chave-654321', smoobu_api_secret: 'novo-segredo-1234' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ilegivel: false, tem_api_key: true, tem_segredo: true });
    expect(ok.body.smoobu_api_key_mascarada).toMatch(/4321$/);
    // e outros campos continuam a poder mudar sem mexer nas credenciais ilegíveis
    const outro = await gestor();
    await comCifra(outro.e);
    perderChaves();
    const nome = await request(app).put('/api/gestor/configuracoes').set(aut(outro.token)).send({ nome: 'Novo nome' });
    expect(nome.status).toBe(200);
  });
});

// ---------------------------------------------------------------- A2
describe('A2: a rotação cobre o Smoobu da empresa', () => {
  test('simula, aplica, lê com a chave nova e avisa enquanto restar algo cifrado com a antiga', async () => {
    await Empresa.deleteMany({});
    ligarChaves();
    const e = await Empresa.create({ nome: 'R1', integracoes: { smoobu: { ativo: true } } });
    await comCifra(e);
    const velho = await bruto(e._id);
    expect(velho.api_key).toMatch(/^v1:1:/);
    process.env.ICAL_CHAVES = `1:${chave1},2:${chave2}`;
    process.env.ICAL_CHAVE_ATUAL = '2';

    const sim = await rodarChaveIcal();
    expect(sim.smoobu).toMatchObject({ precisam_de_rodar: 1, rodadas: 0 });
    expect(sim.ainda_cifrados_por_chave['1']).toBe(2);
    expect(sim.avisos[0]).toMatch(/ainda há 2 valores cifrados com a chave 1/);
    expect(await bruto(e._id)).toEqual(velho);

    const ap = await rodarChaveIcal({ aplicar: true });
    expect(ap.smoobu).toMatchObject({ precisam_de_rodar: 1, rodadas: 1, falhas: 0 });
    expect(ap.avisos).toEqual([]);
    expect(ap.ainda_cifrados_por_chave).toEqual({ '2': 2 });
    const novo = await bruto(e._id);
    expect(novo.api_key).toMatch(/^v1:2:/);
    expect(novo.api_secret).toMatch(/^v1:2:/);
    expect(novo.api_key_hmac).toBe(velho.api_key_hmac);
    expect(JSON.stringify(ap)).not.toContain(CHAVE);

    // já pode retirar a chave 1: continua a ler
    process.env.ICAL_CHAVES = `2:${chave2}`;
    expect(seg.estadoCredenciaisSmoobu(novo, e._id)).toMatchObject({ chave: CHAVE, segredo: SEGREDO, ilegivel: false });
    // idempotente
    expect((await rodarChaveIcal({ aplicar: true })).smoobu.precisam_de_rodar).toBe(0);
  });
});

// ---------------------------------------------------------------- A3
describe('A3: reversão (decifrar-chave-smoobu)', () => {
  test('simula, aplica e é idempotente; repõe o claro de antes e limpa o HMAC', async () => {
    await Empresa.deleteMany({});
    ligarChaves();
    const e = await Empresa.create({ nome: 'D1', integracoes: { smoobu: { ativo: true } } });
    await comCifra(e);
    const cifrado = await bruto(e._id);

    const sim = await decifrarChaveSmoobu();
    expect(sim).toMatchObject({ aplicado: false, a_decifrar: 1, decifradas: 0, falhas: 0 });
    expect(await bruto(e._id)).toEqual(cifrado);

    const ap = await decifrarChaveSmoobu({ aplicar: true });
    expect(ap).toMatchObject({ aplicado: true, decifradas: 1, falhas: 0 });
    const s = await bruto(e._id);
    expect(s.api_key).toBe(CHAVE);
    expect(s.api_secret).toBe(SEGREDO);
    expect(s.api_key_hmac).toBe('');
    expect(JSON.stringify(ap)).not.toContain(CHAVE);

    expect(await decifrarChaveSmoobu({ aplicar: true })).toMatchObject({ a_decifrar: 0, decifradas: 0, ja_em_claro: 1 });
    // e o código lê o claro sem as chaves
    desligarChaves();
    expect(seg.credenciaisSmoobu(s, e._id)).toEqual({ chave: CHAVE, segredo: SEGREDO });
  });

  test('um valor que não se decifra conta como falha e fica intocado', async () => {
    await Empresa.deleteMany({});
    ligarChaves();
    const e = await Empresa.create({ nome: 'D2', integracoes: { smoobu: { ativo: true } } });
    await comCifra(e);
    const antes = await bruto(e._id);
    perderChaves();
    const r = await decifrarChaveSmoobu({ aplicar: true });
    expect(r).toMatchObject({ falhas: 1, decifradas: 0 });
    expect(await bruto(e._id)).toEqual(antes);
  });
});

// ---------------------------------------------------------------- A4
describe('A4: o objeto Empresa nunca sai com chave, segredo, HMAC nem cifrados', () => {
  test('GET /api/admin/empresas (claro e cifrado) e POST /api/admin/empresas', async () => {
    await Empresa.deleteMany({});
    const admin = await gestor('admin');
    // claro (produção antes do passo de cifrar)
    await Empresa.collection.updateOne({ _id: admin.e._id }, { $set: { 'integracoes.smoobu.api_key': CHAVE, 'integracoes.smoobu.api_secret': SEGREDO } });
    let r = await request(app).get('/api/admin/empresas').set(aut(admin.token));
    expect(r.status).toBe(200);
    let txt = JSON.stringify(r.body);
    expect(txt).not.toContain(CHAVE);
    expect(txt).not.toContain(SEGREDO);
    const emp = r.body.empresas.find((x) => x._id === String(admin.e._id));
    expect(emp.integracoes.smoobu).toMatchObject({ ativo: true, tem_api_key: true, tem_segredo: true, ilegivel: false });
    expect(emp.integracoes.smoobu.api_key_mascarada).toMatch(/3456$/);
    expect(emp.integracoes.smoobu).not.toHaveProperty('api_key');
    expect(emp.integracoes.smoobu).not.toHaveProperty('api_secret');

    // cifrado, legível e ilegível
    ligarChaves();
    await comCifra(admin.e);
    r = await request(app).get('/api/admin/empresas').set(aut(admin.token));
    txt = JSON.stringify(r.body);
    for (const x of [CHAVE, SEGREDO, 'v1:', 'api_key_hmac']) expect(txt).not.toContain(x);
    perderChaves();
    r = await request(app).get('/api/admin/empresas').set(aut(admin.token));
    txt = JSON.stringify(r.body);
    for (const x of [CHAVE, SEGREDO, 'v1:', 'api_key_hmac']) expect(txt).not.toContain(x);
    expect(r.body.empresas[0].integracoes.smoobu).toMatchObject({ ilegivel: true, tem_api_key: false });

    const nova = await request(app).post('/api/admin/empresas').set(aut(admin.token)).send({ nome: 'Nova' });
    expect(nova.status).toBe(201);
    expect(JSON.stringify(nova.body)).not.toContain('api_key_hmac');
  });

  test('empresaPublica aceita documentos mongoose e empresas sem integrações', () => {
    expect(seg.empresaPublica(null)).toBeNull();
    expect(seg.empresaPublica({ _id: 1, nome: 'x' })).toEqual({ _id: 1, nome: 'x' });
    const doc = new Empresa({ nome: 'm', integracoes: { smoobu: { api_key: CHAVE, ativo: true } } });
    const pub = seg.empresaPublica(doc);
    expect(JSON.stringify(pub)).not.toContain(CHAVE);
    expect(pub.integracoes.smoobu.tem_api_key).toBe(true);
  });
});

// ---------------------------------------------------------------- A5
describe('A5: exportação RGPD sem HMAC nem segredos', () => {
  test('limparSegredos apanha api_key_hmac e api_secret em profundidade', () => {
    const limpo = limparSegredos({ nome: 'E', integracoes: { smoobu: { ativo: true, api_key: 'a', api_key_hmac: 'b', api_secret: 'c', ultimo_resultado: { ok: true } } } });
    expect(limpo).toEqual({ nome: 'E', integracoes: { smoobu: { ativo: true, ultimo_resultado: { ok: true } } } });
  });

  test('o export da empresa não leva a chave, o segredo, o HMAC nem o texto cifrado', async () => {
    ligarChaves();
    const g = await gestor('gestor');
    await comCifra(g.e);
    const { exportarEmpresa } = require('../utils/rgpdEmpresa');
    let saida = '';
    await exportarEmpresa(g.e._id, async (t) => { saida += t; });
    for (const x of [CHAVE, SEGREDO, 'v1:', 'api_key_hmac', 'api_secret']) expect(saida).not.toContain(x);
    expect(saida).toMatch(/HMAC de integração não estão incluídos/);
  });
});

// ---------------------------------------------------------------- A6
describe('A6: arranque avisa quando o HMAC guardado não corresponde à ICAL_HMAC_CHAVE', () => {
  test('hmac desatualizado e valores ilegíveis são avisados no log (sem valores); tudo certo não avisa', async () => {
    await Empresa.deleteMany({});
    ligarChaves();
    const e = await Empresa.create({ nome: 'V1', integracoes: { smoobu: { ativo: true } } });
    await comCifra(e);
    let r = await verificarCredenciaisSmoobu();
    expect(r).toMatchObject({ empresas: 1, ilegiveis: 0, hmac_desatualizado: 0 });
    expect(console.error).not.toHaveBeenCalled();

    process.env.ICAL_HMAC_CHAVE = b64();
    r = await verificarCredenciaisSmoobu();
    expect(r.hmac_desatualizado).toBe(1);
    expect(console.error.mock.calls.flat().join(' ')).toMatch(/ICAL_HMAC_CHAVE/);

    console.error.mockClear();
    perderChaves();
    r = await verificarCredenciaisSmoobu();
    expect(r.ilegiveis).toBe(1);
    const log = console.error.mock.calls.flat().join(' ');
    expect(log).toMatch(/ICAL_CHAVES/);
    expect(log).not.toContain(CHAVE);
  });

  test('sem nada cifrado (produção antes do passo 5) não faz nada nem avisa', async () => {
    await Empresa.deleteMany({});
    await Empresa.create({ nome: 'V2', integracoes: { smoobu: { api_key: CHAVE, ativo: true } } });
    expect(await verificarCredenciaisSmoobu()).toEqual({ empresas: 0, ilegiveis: 0, hmac_desatualizado: 0 });
    expect(console.error).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- A7
describe('A7: o cifrar não sobrescreve uma alteração feita entretanto', () => {
  test('se a chave mudou entre a leitura e a escrita, não é tocada', async () => {
    await Empresa.deleteMany({});
    ligarChaves();
    const e1 = await Empresa.create({ nome: 'K1', integracoes: { smoobu: { api_key: CHAVE, ativo: true } } });
    const e2 = await Empresa.create({ nome: 'K2', integracoes: { smoobu: { api_key: CHAVE + 'B', ativo: true } } });
    const original = Empresa.collection.updateOne.bind(Empresa.collection);
    const espia = jest.spyOn(Empresa.collection, 'updateOne').mockImplementation(async (filtro, ...resto) => {
      // o gestor grava outra chave na e1 exatamente antes de o script escrever
      if (String(filtro._id) === String(e1._id)) await original({ _id: e1._id }, { $set: { 'integracoes.smoobu.api_key': 'chave-nova-do-gestor' } });
      return original(filtro, ...resto);
    });
    const r = await cifrarChaveSmoobu({ aplicar: true });
    espia.mockRestore();
    expect(r).toMatchObject({ a_cifrar: 2, cifradas: 1, alteradas_entretanto: 1, falhas: 0 });
    expect((await bruto(e1._id)).api_key).toBe('chave-nova-do-gestor');
    expect((await bruto(e2._id)).api_key).toMatch(/^v1:/);
    // e voltando a correr, cifra a nova
    expect(await cifrarChaveSmoobu({ aplicar: true })).toMatchObject({ cifradas: 1, alteradas_entretanto: 0 });
    expect((await bruto(e1._id)).api_key).toMatch(/^v1:/);
  });
});
