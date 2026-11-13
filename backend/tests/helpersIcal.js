/** Ajudantes dos testes dos calendários externos (iCal): chaves de teste, feeds de exemplo e transporte falso (sem rede). */
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Empresa = require('../models/Empresa');
const Propriedade = require('../models/Propriedade');
const Utilizador = require('../models/Utilizador');

function configurarChaves() {
  process.env.ICAL_CHAVES = `1:${crypto.randomBytes(32).toString('base64')}`;
  process.env.ICAL_CHAVE_ATUAL = '1';
  process.env.ICAL_HMAC_CHAVE = crypto.randomBytes(32).toString('base64');
  process.env.ICAL_HORAS_MINIMAS_FALTA = '0';
  delete process.env.ICAL_SYNC_ATIVO;
  delete process.env.ICAL_MODO_TESTE;
}

const SENHA = 'p-de-teste-123';
const hash = bcrypt.hashSync(SENHA, 4);
let n = 0;

const dia = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const comp = (offset) => dia(offset).replace(/-/g, '');

let seqUrl = 0;
/** Links únicos (o mesmo link não pode estar em duas casas): usa-se um por cenário. */
const urlAirbnb = () => `https://www.airbnb.pt/calendar/ical/${100000 + ++seqUrl}.ics?s=segredoabc9F3x${seqUrl}`;
const urlBooking = () => `https://ical.booking.com/v1/export?t=segredobooking-${seqUrl++}-123e4567`;
const URL_AIRBNB = 'https://www.airbnb.pt/calendar/ical/123456789.ics?s=segredoabc9F3x';
const URL_BOOKING = 'https://ical.booking.com/v1/export?t=segredobooking-123e4567';

function vevento({ uid, ci, co, summary = 'Reserved', desc = null, extra = '' }) {
  return ['BEGIN:VEVENT', `DTEND;VALUE=DATE:${comp(co)}`, `DTSTART;VALUE=DATE:${comp(ci)}`, `UID:${uid}`,
    ...(desc ? [`DESCRIPTION:${desc}`] : []), `SUMMARY:${summary}`, ...(extra ? [extra] : []), 'END:VEVENT'].join('\r\n');
}
const calendario = (prodid, eventos) => ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${prodid}`, ...eventos.map(vevento), 'END:VCALENDAR', ''].join('\r\n');
const PRODID_AIRBNB = '-//Airbnb Inc//Hosting Calendar 0.8.8//EN';
const PRODID_BOOKING = '-//Booking.com//Extranet//EN';

/** Transporte falso: `estado[host]` = { status, corpo (texto ou Buffer), headers, atraso } ; conta os pedidos. */
function criarTransporte(estado) {
  const fn = async (url) => {
    fn.pedidos.push(url.href);
    const e = typeof estado === 'function' ? estado(url) : estado[url.hostname];
    if (!e) throw Object.assign(new Error('sem rota'), { code: 'ENOTFOUND' });
    if (e.erro) throw e.erro;
    const corpo = Buffer.isBuffer(e.corpo) ? e.corpo : Buffer.from(String(e.corpo ?? ''), 'utf8');
    return { status: e.status ?? 200, headers: e.headers || {}, corpo, ip: '203.0.113.10' };
  };
  fn.pedidos = [];
  return fn;
}

async function cenario({ smoobu = false } = {}) {
  const e = await Empresa.create({ nome: 'IC' + ++n });
  const mk = (nome, role, x = {}) => Utilizador.create({ nome, email: `${nome}${++n}@x.pt`, password_hash: hash, empresa_id: e._id, role, ativo: true, dias_folga: [], ...x });
  const g = await mk('gestor', 'gestor');
  const staff = await mk('Ana', 'staff');
  const dono = await mk('Dono', 'parceiro');
  const outro = await mk('Outro', 'parceiro');
  const casa = await Propriedade.create({ nome: 'Casa' + ++n, empresa_id: e._id, origem: smoobu ? 'smoobu' : 'manual', smoobu_id: smoobu ? String(6000 + n) : null, ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, parceiro_id: dono._id });
  const alheia = await Propriedade.create({ nome: 'Alheia' + ++n, empresa_id: e._id, origem: 'manual', ativo: true, capacidade_hospedes: 4, tempo_limpeza_minutos: 60, parceiro_id: outro._id });
  return { e, g, staff, dono, outro, casa, alheia, escopoP: { empresaId: e._id, parceiroId: dono._id }, escopoG: { empresaId: e._id }, ator: { tipo: 'parceiro', id: dono._id, nome: 'Dono' }, atorG: { tipo: 'gestor', id: g._id, nome: 'Gestor' } };
}

module.exports = { configurarChaves, SENHA, dia, comp, URL_AIRBNB, URL_BOOKING, urlAirbnb, urlBooking, vevento, calendario, PRODID_AIRBNB, PRODID_BOOKING, criarTransporte, cenario, mongoose };
