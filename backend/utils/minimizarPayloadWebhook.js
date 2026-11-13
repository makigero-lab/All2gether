/**
 * Minimização do payload dos webhooks do Smoobu (RGPD) — All2gether.
 *
 * O WebhookLog serve para diagnóstico, idempotência e reconciliação de cancelamentos, e para isso basta
 * saber: o tipo do evento, os ids, as datas, o estado e o resultado. Nomes, emails, telefones, moradas,
 * notas, preços e restante conteúdo do hóspede NÃO se guardam.
 *
 * Lista EXPLÍCITA de campos permitidos (tudo o que não está aqui é descartado, mesmo que o Smoobu passe a
 * enviar campos novos). Os campos escalares só passam se forem texto curto, número ou booleano, para que
 * ninguém consiga guardar dados pessoais dentro de um campo permitido (ex.: um objeto no lugar do id).
 */

// Nível de topo do payload.
const PERMITIDOS_TOPO = ['action', 'type'];

// Dentro de `data`. Ids, datas, tipo/estado da reserva e contagens (sem identificar ninguém).
const PERMITIDOS_DATA = [
  'id', 'type', 'status', 'is-blocked-booking',
  'arrival', 'departure', 'created-at', 'modified-at',
  'adults', 'children',
];

// Dentro de `data.apartment` e `data.channel`: só o id (o nome da casa/canal não é necessário).
const PERMITIDOS_SUB = { apartment: ['id'], channel: ['id'] };

const MAX_TEXTO = 40;

function escalar(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.slice(0, MAX_TEXTO);
  return undefined;
}

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function copiar(origem, permitidos) {
  const out = {};
  if (!ehObjeto(origem)) return out;
  for (const k of permitidos) {
    if (!Object.prototype.hasOwnProperty.call(origem, k)) continue;
    const v = escalar(origem[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Devolve uma cópia do payload só com os campos permitidos. Nunca lança. */
function minimizarPayload(payload) {
  if (!ehObjeto(payload)) return {};
  const out = copiar(payload, PERMITIDOS_TOPO);
  if (ehObjeto(payload.data)) {
    const data = copiar(payload.data, PERMITIDOS_DATA);
    for (const [sub, campos] of Object.entries(PERMITIDOS_SUB)) {
      const s = copiar(payload.data[sub], campos);
      if (Object.keys(s).length) data[sub] = s;
    }
    out.data = data;
  }
  return out;
}

/** true se minimizarPayload não muda nada (o payload já é mínimo). */
function jaMinimo(payload) {
  return JSON.stringify(minimizarPayload(payload)) === JSON.stringify(payload);
}

module.exports = { minimizarPayload, jaMinimo, PERMITIDOS_TOPO, PERMITIDOS_DATA, PERMITIDOS_SUB };
