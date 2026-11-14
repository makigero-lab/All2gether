/**
 * Achados do @Legal sobre as integrações: retenção das observações das reservas manuais, chave Smoobu da
 * empresa cifrada em repouso e WebhookLog só com o mínimo para diagnóstico.
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
const ReservaManual = require('../models/ReservaManual');
const WebhookLog = require('../models/WebhookLog');
const { executarRetencao } = require('../jobs/retencao');
const { cifrarChaveSmoobu } = require('../scripts/cifrar-chave-smoobu');
const { limparWebhookLogs } = require('../scripts/limpar-webhooklogs');
const seg = require('../utils/segredoEmpresa');
const { minimizarPayload } = require('../utils/minimizarPayloadWebhook');
const { obterApiKeySmoobu } = require('../controllers/smoobuController');

const DIA = 86400000;
const antes = (d) => new Date(Date.now() - d * DIA);
const hash = bcrypt.hashSync('p-de-teste-123', 4);
const CHAVES_ENV = ['ICAL_CHAVES', 'ICAL_CHAVE_ATUAL', 'ICAL_HMAC_CHAVE'];
const guardado = {};
let mongod;
let n = 0;

function ligarChaves() {
  process.env.ICAL_CHAVES = `1:${crypto.randomBytes(32).toString('base64')}`;
  process.env.ICAL_CHAVE_ATUAL = '1';
  process.env.ICAL_HMAC_CHAVE = crypto.randomBytes(32).toString('base64');
}
function desligarChaves() { CHAVES_ENV.forEach((k) => delete process.env[k]); }

beforeAll(async () => {
  CHAVES_ENV.forEach((k) => { guardado[k] = process.env[k]; });
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  CHAVES_ENV.forEach((k) => { if (guardado[k] === undefined) delete process.env[k]; else process.env[k] = guardado[k]; });
  await mongoose.disconnect();
  await mongod.stop();
});
beforeEach(desligarChaves);

// ---------------------------------------------------------------- 1. retenção
describe('retenção: observações das reservas manuais', () => {
  const oid = () => new mongoose.Types.ObjectId();
  const base = () => ({ propriedade_id: oid(), parceiro_id: oid(), empresa_id: oid() });

  test('passado o prazo limpa nome e observações e mantém datas, casa e n.º de hóspedes', async () => {
    const velha = await ReservaManual.collection.insertOne({
      ...base(), check_in: antes(125), check_out: antes(120), hospedes: 3, observacoes: 'Sr. Silva, tel 912345678', nome_hospede: 'Silva',
    });
    const soObs = await ReservaManual.collection.insertOne({ ...base(), check_in: antes(125), check_out: antes(120), hospedes: 2, observacoes: 'alergia a gatos' });
    const recente = await ReservaManual.collection.insertOne({ ...base(), check_in: antes(20), check_out: antes(10), observacoes: 'chega tarde', nome_hospede: 'Costa' });

    const r = await executarRetencao();
    expect(r.hospedes).toBeGreaterThanOrEqual(2);

    const v = await ReservaManual.collection.findOne({ _id: velha.insertedId });
    expect(v.observacoes).toBe('');
    expect(v.nome_hospede).toBeNull();
    expect(v.hospedes).toBe(3);
    expect(v.check_in).toBeInstanceOf(Date);
    expect(v.propriedade_id).toBeTruthy();
    expect((await ReservaManual.collection.findOne({ _id: soObs.insertedId })).observacoes).toBe('');
    const rc = await ReservaManual.collection.findOne({ _id: recente.insertedId });
    expect(rc.observacoes).toBe('chega tarde');
    expect(rc.nome_hospede).toBe('Costa');
  });

  test('é idempotente: a segunda passagem não trata nada', async () => {
    await ReservaManual.collection.insertOne({ ...base(), check_in: antes(130), check_out: antes(125), observacoes: 'x' });
    await executarRetencao();
    const r2 = await executarRetencao();
    expect(r2.hospedes).toBe(0);
  });

  test('respeita RETENCAO_HOSPEDES_DIAS', async () => {
    process.env.RETENCAO_HOSPEDES_DIAS = '200';
    try {
      const d = await ReservaManual.collection.insertOne({ ...base(), check_in: antes(130), check_out: antes(125), observacoes: 'ainda guarda' });
      await executarRetencao();
      expect((await ReservaManual.collection.findOne({ _id: d.insertedId })).observacoes).toBe('ainda guarda');
    } finally { delete process.env.RETENCAO_HOSPEDES_DIAS; }
  });
});

// ---------------------------------------------------------------- 2. chave Smoobu cifrada
describe('chave Smoobu da empresa cifrada em repouso', () => {
  const CHAVE = 'chave-smoobu-secreta-123456';
  const SEGREDO = 'segredo-hmac-smoobu-abcdef';

  async function gestor(smoobu = {}) {
    n++;
    const e = await Empresa.create({ nome: 'L' + n, integracoes: { smoobu: { ativo: true, ...smoobu } } });
    const g = await Utilizador.create({ nome: 'g', email: `g${n}@x.pt`, password_hash: hash, empresa_id: e._id, role: 'gestor', ativo: true, dias_folga: [] });
    const login = await request(app).post('/api/auth/login').send({ email: g.email, password: 'p-de-teste-123' });
    return { e, token: login.body.token };
  }
  const bruto = (id) => Empresa.collection.findOne({ _id: id }).then((d) => d.integracoes.smoobu);

  test('cifra e decifra; o AAD liga o valor à empresa e ao campo', () => {
    ligarChaves();
    const a = new mongoose.Types.ObjectId();
    const c = seg.protegerSegredo(CHAVE, a, 'api_key');
    expect(c).toMatch(/^v1:/);
    expect(c).not.toContain(CHAVE);
    expect(seg.estaCifrado(c)).toBe(true);
    expect(seg.lerSegredo(c, a, 'api_key')).toBe(CHAVE);
    const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(seg.lerSegredo(c, new mongoose.Types.ObjectId(), 'api_key')).toBe('');
    expect(seg.lerSegredo(c, a, 'api_secret')).toBe('');
    expect(erro.mock.calls.flat().join(' ')).not.toContain(CHAVE);
    erro.mockRestore();
  });

  test('leitura aceita os dois formatos (claro antigo e cifrado novo)', () => {
    const a = new mongoose.Types.ObjectId();
    expect(seg.lerSegredo(CHAVE, a, 'api_key')).toBe(CHAVE); // sem chaves, claro
    ligarChaves();
    expect(seg.lerSegredo(CHAVE, a, 'api_key')).toBe(CHAVE); // com chaves, claro antigo
    const c = seg.protegerSegredo(CHAVE, a, 'api_key');
    expect(seg.lerSegredo(c, a, 'api_key')).toBe(CHAVE);
    expect(seg.credenciaisSmoobu({ api_key: c, api_secret: seg.protegerSegredo(SEGREDO, a, 'api_secret') }, a)).toEqual({ chave: CHAVE, segredo: SEGREDO });
    expect(seg.credenciaisSmoobu({ api_key: CHAVE, api_secret: SEGREDO }, a)).toEqual({ chave: CHAVE, segredo: SEGREDO });
  });

  test('sem chaves grava em claro, com aviso no log que não leva a chave', () => {
    const aviso = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const a = new mongoose.Types.ObjectId();
    expect(seg.protegerSegredo(CHAVE, a, 'api_key')).toBe(CHAVE);
    expect(seg.setChaveSmoobu(CHAVE, a)['integracoes.smoobu.api_key_hmac']).toBe('');
    expect(aviso.mock.calls.flat().join(' ')).not.toContain(CHAVE);
    aviso.mockRestore();
  });

  test('PUT /configuracoes sem chaves: grava em claro; com chaves: cifrado (chave e segredo)', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const a = await gestor();
    let r = await request(app).put('/api/gestor/configuracoes').set('Authorization', `Bearer ${a.token}`).send({ smoobu_api_key: CHAVE, smoobu_api_secret: SEGREDO });
    expect(r.status).toBe(200);
    let s = await bruto(a.e._id);
    expect(s.api_key).toBe(CHAVE);
    expect(s.api_secret).toBe(SEGREDO);

    ligarChaves();
    r = await request(app).put('/api/gestor/configuracoes').set('Authorization', `Bearer ${a.token}`).send({ smoobu_api_key: CHAVE, smoobu_api_secret: SEGREDO });
    expect(r.status).toBe(200);
    s = await bruto(a.e._id);
    expect(s.api_key).toMatch(/^v1:/);
    expect(s.api_secret).toMatch(/^v1:/);
    expect(s.api_key_hmac).toMatch(/^[0-9a-f]{64}$/);
    // nunca na resposta
    expect(JSON.stringify(r.body)).not.toContain(CHAVE);
    expect(JSON.stringify(r.body)).not.toContain(SEGREDO);
    expect(r.body.tem_api_key).toBe(true);
    expect(r.body.smoobu_api_key_mascarada).toMatch(/3456$/);
    console.warn.mockRestore();
  });

  test('PUT /configuracoes/integracoes cifra e o GET mascara sem expor', async () => {
    ligarChaves();
    const a = await gestor();
    const put = await request(app).put('/api/gestor/configuracoes/integracoes').set('Authorization', `Bearer ${a.token}`).send({ smoobu: { api_key: CHAVE, api_secret: SEGREDO } });
    expect(put.status).toBe(200);
    const s = await bruto(a.e._id);
    expect(s.api_key).toMatch(/^v1:/);
    const get = await request(app).get('/api/gestor/configuracoes/integracoes').set('Authorization', `Bearer ${a.token}`);
    const txt = JSON.stringify(get.body) + JSON.stringify(put.body);
    expect(txt).not.toContain(CHAVE);
    expect(txt).not.toContain(SEGREDO);
    expect(get.body.smoobu.configurado).toBe(true);
    expect(get.body.smoobu.tem_segredo).toBe(true);
    expect(get.body.smoobu.api_key_mascarada).toMatch(/3456$/);
    // limpar a chave apaga também o HMAC
    await request(app).put('/api/gestor/configuracoes/integracoes').set('Authorization', `Bearer ${a.token}`).send({ smoobu: { api_key: '' } });
    const limpo = await bruto(a.e._id);
    expect(limpo.api_key).toBe('');
    expect(limpo.api_key_hmac).toBe('');
  });

  test('smoobuApi: obterApiKeySmoobu devolve a chave e o segredo decifrados (e o claro antigo)', async () => {
    ligarChaves();
    const e = await Empresa.create({ nome: 'O' + ++n, integracoes: { smoobu: { ativo: true } } });
    await Empresa.collection.updateOne({ _id: e._id }, { $set: {
      'integracoes.smoobu.api_key': seg.protegerSegredo(CHAVE, e._id, 'api_key'),
      'integracoes.smoobu.api_secret': seg.protegerSegredo(SEGREDO, e._id, 'api_secret'),
    } });
    expect(await obterApiKeySmoobu(e._id)).toEqual({ chave: CHAVE, segredo: SEGREDO, origem: 'empresa' });
    // formato antigo em claro
    await Empresa.collection.updateOne({ _id: e._id }, { $set: { 'integracoes.smoobu.api_key': CHAVE, 'integracoes.smoobu.api_secret': SEGREDO } });
    expect(await obterApiKeySmoobu(e._id)).toEqual({ chave: CHAVE, segredo: SEGREDO, origem: 'empresa' });
    // sem chaves e com valor cifrado: não parte (cai no fallback, sem chave)
    await Empresa.collection.updateOne({ _id: e._id }, { $set: { 'integracoes.smoobu.api_key': seg.protegerSegredo(CHAVE, e._id, 'api_key') } });
    desligarChaves();
    const erro = jest.spyOn(console, 'error').mockImplementation(() => {});
    const antesEnv = process.env.SMOOBU_API_KEY; delete process.env.SMOOBU_API_KEY;
    expect((await obterApiKeySmoobu(e._id)).chave).toBeNull();
    if (antesEnv !== undefined) process.env.SMOOBU_API_KEY = antesEnv;
    erro.mockRestore();
  });

  test('webhook autentica com a chave guardada cifrada (HMAC) e em claro antigo', async () => {
    ligarChaves();
    const cifrada = await gestor();
    await request(app).put('/api/gestor/configuracoes').set('Authorization', `Bearer ${cifrada.token}`).send({ smoobu_api_key: CHAVE + 'A' });
    const antigo = await Empresa.create({ nome: 'A' + ++n, integracoes: { smoobu: { api_key: CHAVE + 'B', ativo: true } } });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const corpo = { action: 'newReservation', data: { id: 1, arrival: '2030-01-01', departure: '2030-01-03', 'guest-name': 'Fulano' } };
    const r1 = await request(app).post(`/api/smoobu/webhook?key=${CHAVE}A`).send(corpo);
    const r2 = await request(app).post(`/api/smoobu/webhook?key=${CHAVE}B`).send(corpo);
    const r3 = await request(app).post(`/api/smoobu/webhook?key=errada`).send(corpo);
    log.mockRestore();
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(401);
    const doc = await WebhookLog.findOne({ empresa_id: cifrada.e._id }).lean();
    expect(doc).toBeTruthy();
    expect(antigo).toBeTruthy();
  });

  test('script cifrar-chave-smoobu: sem chaves recusa; simula; aplica; idempotente; nada em claro nos logs', async () => {
    await Empresa.deleteMany({});
    const e1 = await Empresa.create({ nome: 'S1', integracoes: { smoobu: { api_key: CHAVE, ativo: true } } });
    await Empresa.collection.updateOne({ _id: e1._id }, { $set: { 'integracoes.smoobu.api_secret': SEGREDO } });
    const e2 = await Empresa.create({ nome: 'S2' });
    await expect(cifrarChaveSmoobu({ aplicar: true })).rejects.toThrow(/não estão configuradas/);
    expect((await bruto(e1._id)).api_key).toBe(CHAVE);

    ligarChaves();
    const sim = await cifrarChaveSmoobu();
    expect(sim).toMatchObject({ aplicado: false, empresas: 1, a_cifrar: 1, cifradas: 0 });
    expect((await bruto(e1._id)).api_key).toBe(CHAVE);

    const out = jest.spyOn(console, 'error').mockImplementation(() => {});
    const ap = await cifrarChaveSmoobu({ aplicar: true });
    expect(ap).toMatchObject({ aplicado: true, a_cifrar: 1, cifradas: 1, falhas: 0 });
    const s = await bruto(e1._id);
    expect(s.api_key).toMatch(/^v1:/);
    expect(s.api_secret).toMatch(/^v1:/);
    expect(seg.lerSegredo(s.api_key, e1._id, 'api_key')).toBe(CHAVE);
    expect(seg.lerSegredo(s.api_secret, e1._id, 'api_secret')).toBe(SEGREDO);
    expect(s.api_key_hmac).toBe(seg.hmacChave(CHAVE));
    expect(JSON.stringify(ap)).not.toContain(CHAVE);
    expect(out.mock.calls.flat().join(' ')).not.toContain(CHAVE);
    out.mockRestore();

    const antes2 = await bruto(e1._id);
    const de_novo = await cifrarChaveSmoobu({ aplicar: true });
    expect(de_novo).toMatchObject({ a_cifrar: 0, cifradas: 0, ja_cifradas: 1 });
    expect(await bruto(e1._id)).toEqual(antes2);
    expect(e2).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 3. WebhookLog mínimo
describe('WebhookLog guarda só o mínimo', () => {
  const completo = () => ({
    action: 'newReservation',
    user: 12345,
    data: {
      id: 987, type: 'reservation', arrival: '2030-02-01', departure: '2030-02-04', 'is-blocked-booking': false,
      'created-at': '2030-01-01 10:00:00', adults: 2, children: 1, price: 480, notice: 'Chega às 22h, alergia',
      'guest-name': 'Maria Silva', firstname: 'Maria', lastname: 'Silva', email: 'maria@exemplo.pt', phone: '+351912345678',
      address: { street: 'Rua das Flores 1', city: 'Lisboa' }, language: 'pt', 'guest-app-url': 'https://x.pt/guest/abc',
      apartment: { id: 55, name: 'Casa do Mar' }, channel: { id: 1, name: 'Airbnb' },
      nested: { email: 'outro@exemplo.pt' },
    },
  });
  const texto = (o) => JSON.stringify(o);

  test('minimizarPayload: lista de campos permitidos, sem dados pessoais', () => {
    const m = minimizarPayload(completo());
    expect(m).toEqual({
      action: 'newReservation',
      data: { id: 987, type: 'reservation', arrival: '2030-02-01', departure: '2030-02-04', 'is-blocked-booking': false, 'created-at': '2030-01-01 10:00:00', adults: 2, children: 1, apartment: { id: 55 }, channel: { id: 1 } },
    });
    for (const x of ['Maria', 'Silva', 'maria@', '912345678', 'Rua das Flores', 'Lisboa', 'alergia', 'Casa do Mar', 'guest/abc', 'outro@']) expect(texto(m)).not.toContain(x);
  });

  test('campo novo desconhecido é descartado e objeto no lugar de um id também', () => {
    const m = minimizarPayload({ action: 'a', campo_novo: 'dados', data: { id: { nome: 'Fulano' }, novo: 'x', type: 'cancellation' } });
    expect(m).toEqual({ action: 'a', data: { type: 'cancellation' } });
    expect(minimizarPayload(null)).toEqual({});
    expect(minimizarPayload('texto')).toEqual({});
    expect(minimizarPayload([1])).toEqual({});
  });

  test('log processado ou com erro fica mínimo; recebido guarda a cópia completa para a retoma', async () => {
    const rec = await WebhookLog.create({ payload: completo(), status: 'recebido' });
    expect((await WebhookLog.findById(rec._id).lean()).payload.data['guest-name']).toBe('Maria Silva');

    await WebhookLog.findByIdAndUpdate(rec._id, { status: 'processado' });
    const p = await WebhookLog.findById(rec._id).lean();
    expect(p.payload_minimo).toBe(true);
    expect(texto(p.payload)).not.toContain('Maria');
    expect(p.payload.data.id).toBe(987);
    expect(p.payload.data.departure).toBe('2030-02-04');

    const rec2 = await WebhookLog.create({ payload: completo(), status: 'recebido' });
    await WebhookLog.findByIdAndUpdate(rec2._id, { status: 'erro', erro_msg: 'falhou' });
    const e = await WebhookLog.findById(rec2._id).lean();
    expect(e.erro_msg).toBe('falhou');
    expect(texto(e.payload)).not.toContain('maria@');

    const rejeitado = await WebhookLog.create({ payload: completo(), status: 'erro', erro_msg: 'Autenticação falhou' });
    expect(texto((await WebhookLog.findById(rejeitado._id).lean()).payload)).not.toContain('912345678');
  });

  test('mantém o TTL: expira_em = check-out + 30 dias', async () => {
    const l = await WebhookLog.create({ payload: completo(), status: 'processado' });
    expect(l.expira_em.getTime()).toBe(new Date('2030-02-04').getTime() + 30 * DIA);
    const idx = (await WebhookLog.collection.indexes()).find((i) => i.key && i.key.expira_em === 1);
    expect(idx.expireAfterSeconds).toBe(0);
  });

  test('webhook real: o processamento usa a cópia completa e o log fica mínimo', async () => {
    await WebhookLog.deleteMany({});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await Empresa.create({ nome: 'W' + ++n, integracoes: { smoobu: { api_key: 'chave-do-webhook-real', ativo: true } } });
    const r = await request(app).post('/api/smoobu/webhook?key=chave-do-webhook-real').send(completo());
    expect(r.status).toBe(200);
    for (let i = 0; i < 40; i++) {
      const l = await WebhookLog.findById(r.body.log_id).lean();
      if (l && l.status !== 'recebido') break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    log.mockRestore();
    const l = await WebhookLog.findById(r.body.log_id).lean();
    expect(['processado', 'erro']).toContain(l.status);
    expect(texto(l.payload)).not.toContain('maria@');
    expect(texto(l.payload)).not.toContain('Maria');
  });

  test('script limpar-webhooklogs: simula, aplica, idempotente, não toca nos recebidos recentes', async () => {
    await WebhookLog.deleteMany({});
    const antigo = (extra) => WebhookLog.collection.insertOne({ payload: completo(), status: 'processado', createdAt: antes(40), updatedAt: antes(40), expira_em: new Date(Date.now() + 5 * DIA), ...extra });
    const a = await antigo();
    const b = await antigo({ status: 'recebido', createdAt: antes(20) });
    const recente = await antigo({ status: 'recebido', createdAt: antes(1) });
    const c = await antigo({ payload_minimo: true, payload: minimizarPayload(completo()) });

    const sim = await limparWebhookLogs();
    expect(sim).toMatchObject({ aplicado: false, a_limpar: 2, limpos: 0 });
    expect(texto((await WebhookLog.collection.findOne({ _id: a.insertedId })).payload)).toContain('Maria');

    const ap = await limparWebhookLogs({ aplicar: true });
    expect(ap).toMatchObject({ aplicado: true, a_limpar: 2, limpos: 2 });
    for (const x of [a, b]) {
      const d = await WebhookLog.collection.findOne({ _id: x.insertedId });
      expect(d.payload_minimo).toBe(true);
      expect(texto(d.payload)).not.toContain('Maria');
      expect(d.payload.data.id).toBe(987);
    }
    expect(texto((await WebhookLog.collection.findOne({ _id: recente.insertedId })).payload)).toContain('Maria');
    expect(c).toBeTruthy();

    const de_novo = await limparWebhookLogs({ aplicar: true });
    expect(de_novo).toMatchObject({ a_limpar: 0, limpos: 0 });
  });

  test('retenção diária reduz os recebidos presos há mais de 8 dias', async () => {
    await WebhookLog.deleteMany({});
    const preso = await WebhookLog.collection.insertOne({ payload: completo(), status: 'recebido', createdAt: antes(9), updatedAt: antes(9), expira_em: new Date(Date.now() + 5 * DIA) });
    const novo = await WebhookLog.collection.insertOne({ payload: completo(), status: 'recebido', createdAt: antes(2), updatedAt: antes(2), expira_em: new Date(Date.now() + 5 * DIA) });
    const r = await executarRetencao();
    expect(r.webhooklogs_minimizados).toBe(1);
    expect(texto((await WebhookLog.collection.findOne({ _id: preso.insertedId })).payload)).not.toContain('Maria');
    expect(texto((await WebhookLog.collection.findOne({ _id: novo.insertedId })).payload)).toContain('Maria');
    expect((await executarRetencao()).webhooklogs_minimizados).toBe(0);
  });
});
