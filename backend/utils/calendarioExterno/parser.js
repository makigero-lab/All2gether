/**
 * Leitura e classificação de calendários iCal (RFC 5545) — All2gether.
 *
 * Parser pequeno e sem dependências. Só extrai o que é preciso para limpezas: UID, dias de entrada e saída
 * (DTEND é EXCLUSIVO: é o dia da saída, onde fica a limpeza) e a classe do evento. RGPD: a DESCRIPTION
 * (que no Airbnb traz o código da reserva e 4 dígitos do telefone) NUNCA é guardada; do código só sai um
 * HMAC (pseudónimo) e o SUMMARY (que noutros canais pode ter nomes) é trocado por um rótulo fixo.
 */
const crypto = require('crypto');
const H = require('../horario');
const { ErroFeed } = require('./buscar');

const MAX_EVENTOS = 3000;
const MAX_NOITES = 365;
const MAX_MESES_FUTURO = 24;

const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** Desdobra linhas (continuação com espaço/tab) e separa em { nome, params, valor }. */
function lerLinhas(texto) {
  const brutas = String(texto).replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const linhas = [];
  for (const l of brutas) {
    if ((l.startsWith(' ') || l.startsWith('\t')) && linhas.length) linhas[linhas.length - 1] += l.slice(1);
    else linhas.push(l);
  }
  const out = [];
  for (const l of linhas) {
    if (!l.trim()) continue;
    const i = l.indexOf(':');
    if (i < 1) continue;
    const esq = l.slice(0, i);
    const [nome, ...pr] = esq.split(';');
    const params = {};
    for (const p of pr) {
      const j = p.indexOf('=');
      if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, '');
    }
    out.push({ nome: nome.toUpperCase(), params, valor: l.slice(i + 1) });
  }
  return out;
}

const desescapar = (v) => String(v).replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

/**
 * Converte um valor de data iCal para o DIA civil 'aaaa-mm-dd'.
 *  - VALUE=DATE (20261215): o dia tal como está, sem passar por UTC.
 *  - DATE-TIME com Z: o dia em Europe/Lisbon.
 *  - DATE-TIME com TZID ou flutuante: a data tal como escrita (é a data local do canal).
 */
function diaDe(valor, params = {}) {
  const v = String(valor).trim();
  let m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return valido(m[1], m[2], m[3]);
  m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!m) return null;
  if (m[7] === 'Z') {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    return Number.isNaN(d.getTime()) ? null : H.hojeLisboa(d);
  }
  return valido(m[1], m[2], m[3]);
}

function valido(a, m, d) {
  const dt = new Date(Date.UTC(+a, +m - 1, +d));
  if (dt.getUTCFullYear() !== +a || dt.getUTCMonth() !== +m - 1 || dt.getUTCDate() !== +d) return null;
  return `${a}-${m}-${d}`;
}

/** Duração iCal simples (P1D, P2W, PT24H) em dias; null se não for reconhecida. */
function diasDeDuracao(v) {
  const m = String(v).trim().match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const dias = (+m[1] || 0) * 7 + (+m[2] || 0) + Math.floor(((+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) / 86400);
  return dias;
}

/** Classe do evento a partir do canal e do SUMMARY. */
function classificar(canal, summary) {
  const s = String(summary || '').trim().toLowerCase();
  if (canal === 'airbnb') {
    if (s === 'reserved') return { classe: 'reserva', resumo_tipo: 'airbnb_reserved' };
    if (s.includes('not available')) return { classe: 'bloqueio', resumo_tipo: 'airbnb_not_available' };
    return { classe: 'incerto', resumo_tipo: 'desconhecido' };
  }
  if (canal === 'booking') return { classe: 'incerto', resumo_tipo: s.includes('closed') ? 'booking_closed' : 'desconhecido' };
  return { classe: 'incerto', resumo_tipo: 'desconhecido' };
}

/** Código de reserva do Airbnb dentro da DESCRIPTION (nunca guardado em claro). */
function codigoDaDescricao(desc) {
  const m = String(desc || '').match(/[?&]code=([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/**
 * Analisa o texto do calendário.
 * @param {string} texto
 * @param {{ canal: string, hoje?: string, hmac?: (t:string)=>string }} opcoes
 * @returns {{ prodid: string|null, eventos: object[], contadores: object }}
 * @throws ErroFeed('formato') se não for um calendário completo e válido.
 */
function analisarIcal(texto, { canal, hoje = H.hojeLisboa(), hmac = null } = {}) {
  const t = String(texto || '').replace(/^﻿/, '').trim();
  if (!t) throw new ErroFeed('formato', 'O calendário veio vazio.');
  if (!/^BEGIN:VCALENDAR/i.test(t)) throw new ErroFeed('formato', 'O conteúdo não é um calendário (iCal).');
  if (!/END:VCALENDAR\s*$/i.test(t)) throw new ErroFeed('formato', 'O calendário veio cortado.');
  const linhas = lerLinhas(t);
  let prodid = null;
  const eventosBrutos = [];
  let atual = null;
  let nivel = 0; // VALARM e afins dentro do evento
  for (const l of linhas) {
    if (l.nome === 'BEGIN') {
      if (l.valor.toUpperCase() === 'VEVENT' && !atual) {
        atual = {};
        if (eventosBrutos.length >= MAX_EVENTOS) throw new ErroFeed('formato', 'O calendário tem eventos a mais.');
      } else if (atual) nivel += 1;
      continue;
    }
    if (l.nome === 'END') {
      if (l.valor.toUpperCase() === 'VEVENT' && atual && nivel === 0) { eventosBrutos.push(atual); atual = null; } else if (atual && nivel > 0) nivel -= 1;
      continue;
    }
    if (!atual) { if (l.nome === 'PRODID') prodid = l.valor.slice(0, 200); continue; }
    if (nivel > 0) continue;
    if (['UID', 'DTSTART', 'DTEND', 'DURATION', 'SUMMARY', 'STATUS', 'RRULE', 'DESCRIPTION', 'DTSTAMP'].includes(l.nome)) atual[l.nome] = l;
  }
  if (atual) throw new ErroFeed('formato', 'O calendário veio cortado.');

  const limite = H.somarDiasISO(hoje, MAX_MESES_FUTURO * 31);
  const c = { reserva: 0, bloqueio: 0, incerto: 0, passado: 0, invalidos: 0, uid_repetido: 0, status_cancelado: 0 };
  const porUid = new Map();
  for (const e of eventosBrutos) {
    if (e.RRULE) { c.invalidos += 1; continue; }
    const ci = e.DTSTART ? diaDe(e.DTSTART.valor, e.DTSTART.params) : null;
    if (!ci) { c.invalidos += 1; continue; }
    let co = e.DTEND ? diaDe(e.DTEND.valor, e.DTEND.params) : null;
    if (!co && e.DURATION) { const n = diasDeDuracao(e.DURATION.valor); if (n !== null) co = H.somarDiasISO(ci, n); }
    if (!co) co = H.somarDiasISO(ci, 1);
    const noites = Math.round((Date.parse(`${co}T00:00:00Z`) - Date.parse(`${ci}T00:00:00Z`)) / 86400000);
    if (noites < 1 || noites > MAX_NOITES) { c.invalidos += 1; continue; }
    if (co < hoje) { c.passado += 1; continue; }
    if (ci > limite) { c.invalidos += 1; continue; }
    const summary = e.SUMMARY ? desescapar(e.SUMMARY.valor) : '';
    const { classe, resumo_tipo } = classificar(canal, summary);
    const status = e.STATUS ? e.STATUS.valor.trim().toUpperCase() : '';
    const cancelado = status === 'CANCELLED';
    let uid = e.UID ? desescapar(e.UID.valor).trim() : '';
    if (!uid || uid.length > 255) uid = `${uid ? 'hash' : 'semuid'}:${sha(`${uid}|${ci}|${co}|${summary.toLowerCase()}`)}`;
    const codigo = canal === 'airbnb' && e.DESCRIPTION && hmac ? codigoDaDescricao(desescapar(e.DESCRIPTION.valor)) : null;
    const ev = {
      uid, ci, co, noites, classe, resumo_tipo, cancelado,
      dtstamp: e.DTSTAMP ? e.DTSTAMP.valor : '',
      codigo_ref_hash: codigo ? hmac(`ref:${codigo}`).slice(0, 32) : null,
    };
    // O mesmo UID repetido conta uma vez (fica o de DTSTAMP mais recente).
    const anterior = porUid.get(uid);
    if (anterior) {
      c.uid_repetido += 1;
      if (ev.dtstamp > anterior.dtstamp) porUid.set(uid, ev);
      continue;
    }
    porUid.set(uid, ev);
  }
  // No Airbnb, dois UID com o mesmo código e as mesmas datas contam um só.
  const vistos = new Set();
  const eventos = [];
  for (const ev of porUid.values()) {
    if (ev.codigo_ref_hash) {
      const k = `${ev.codigo_ref_hash}|${ev.ci}|${ev.co}`;
      if (vistos.has(k)) { c.uid_repetido += 1; continue; }
      vistos.add(k);
    }
    if (ev.cancelado) { c.status_cancelado += 1; continue; } // STATUS:CANCELLED conta como ausente
    c[ev.classe] += 1;
    eventos.push(ev);
  }
  eventos.sort((a, b) => (a.ci < b.ci ? -1 : a.ci > b.ci ? 1 : a.uid < b.uid ? -1 : 1));
  return { prodid, eventos, contadores: c };
}

/** Hash da lista normalizada (ignora DTSTAMP, que muda a cada pedido). */
function hashNormalizado(eventos) {
  const linhas = eventos.map((e) => `${e.uid}|${e.ci}|${e.co}|${e.classe}`).sort();
  return sha(linhas.join('\n'));
}

/** Amostra redigida do calendário: sem DESCRIPTION, URL, nomes; SUMMARY substituído pelo rótulo. Limitada. */
function amostraRedigida(prodid, eventos, maxBytes = 8 * 1024) {
  const partes = ['BEGIN:VCALENDAR', `PRODID:${String(prodid || '').slice(0, 120)}`];
  for (const e of eventos) {
    partes.push('BEGIN:VEVENT', `UID:${e.uid.slice(0, 80)}`, `DTSTART:${e.ci.replace(/-/g, '')}`, `DTEND:${e.co.replace(/-/g, '')}`, `SUMMARY:${e.resumo_tipo}`, 'END:VEVENT');
    if (partes.join('\n').length > maxBytes) break;
  }
  partes.push('END:VCALENDAR');
  return partes.join('\n').slice(0, maxBytes);
}

module.exports = { analisarIcal, hashNormalizado, amostraRedigida, classificar, diaDe, lerLinhas, MAX_EVENTOS };
