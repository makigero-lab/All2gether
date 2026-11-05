const request = require('supertest');
const bcrypt = require('bcryptjs');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Tarefa = require('../models/Tarefa');
const Utilizador = require('../models/Utilizador');

const SENHA = 'p-de-teste-123';
const hash = bcrypt.hashSync(SENHA, 4);
let n = 0;
const auth = (t) => ({ Authorization: 'Bearer ' + t });

async function login(app, u) {
  return (await request(app).post('/api/auth/login').send({ email: u.email, password: SENHA })).body.token;
}

// Cenário base: empresa, gestor, Ana, Bia, N extras, 1 propriedade (staff_necessario = sn).
async function cenario(app, { extra = 1, sn = 2 } = {}) {
  const e = await Empresa.create({ nome: 'E' + ++n });
  const mk = (nome, role) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [] });
  const g = await mk('gestor', 'gestor');
  const ana = await mk('Ana', 'staff');
  const bia = await mk('Bia', 'staff');
  const subs = [];
  for (let i = 0; i < extra; i++) subs.push(await mk('Sub' + i, 'staff'));
  const p = await Propriedade.create({ nome: 'Casa' + ++n, empresa_id: e._id, smoobu_id: String(++n), ativo: true, capacidade_hospedes: 6, tempo_limpeza_minutos: 60, staff_necessario: sn });
  const tarefa = (dia, ex = {}, hh = '10') => Tarefa.create({ empresa_id: e._id, propriedade_id: p._id, utilizador_id: ana._id, equipa_atribuida: [ana._id, bia._id], data: new Date(`${dia}T${hh}:00:00Z`), tempo_limpeza_minutos: 60, estado: 'atribuida', ...ex });
  return { e, g, ana, bia, subs, p, tarefa, mk, token: await login(app, g), n: () => ++n };
}

module.exports = { cenario, login, auth, SENHA, hash };
