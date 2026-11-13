/**
 * Limite do «Testar ligação» (em memória, janela deslizante de 1 hora) — All2gether.
 *
 * Só o clique explícito em «Testar ligação» chega aqui (colar o link ou trocar de canal não testa). Três travões,
 * todos configuráveis, para o uso normal do gestor não ficar bloqueado e o abuso continuar travado:
 *  - por utilizador: ICAL_TESTES_POR_HORA (60);
 *  - por empresa e site do canal (host): ICAL_TESTES_POR_HOST_HORA (150): protege o Airbnb/Booking de rajadas;
 *  - por link (fonte): ICAL_TESTES_POR_LINK_HORA (15): repetir o mesmo link não traz nada de novo.
 * Um teste só gasta quota se passar nos três; ao recusar diz a que horas volta a poder testar.
 */
const H = require('../horario');

const JANELA_MS = 3600000;
const registos = new Map();

function inteiro(v, omissao, min, max) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : omissao;
}

function configuracao(env = process.env) {
  return {
    porUtilizador: inteiro(env.ICAL_TESTES_POR_HORA, 60, 5, 1000),
    porHost: inteiro(env.ICAL_TESTES_POR_HOST_HORA, 150, 10, 5000),
    porLink: inteiro(env.ICAL_TESTES_POR_LINK_HORA, 15, 2, 200),
  };
}

const hora = (d) => {
  const min = H.minutosLocais(d);
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
};

const TEXTOS = {
  utilizador: 'Testaste muitas vezes',
  host: 'Já foram feitos muitos testes a este site',
  link: 'Já testaste este link várias vezes',
};

/**
 * @returns {{ ok: true } | { ok: false, motivo: 'utilizador'|'host'|'link', ate: Date, mensagem: string }}
 */
function tentarTeste({ utilizadorId, empresaId, host, linkHash, agora = Date.now(), env = process.env } = {}) {
  const cfg = configuracao(env);
  const travoes = [
    ['utilizador', utilizadorId ? `u:${utilizadorId}` : null, cfg.porUtilizador],
    ['host', host ? `h:${empresaId}:${host}` : null, cfg.porHost],
    ['link', linkHash ? `l:${linkHash}` : null, cfg.porLink],
  ].filter(([, chave]) => chave);
  const listas = travoes.map(([motivo, chave, max]) => ({ motivo, chave, max, lista: (registos.get(chave) || []).filter((t) => agora - t < JANELA_MS) }));
  for (const l of listas) {
    if (l.lista.length >= l.max) {
      registos.set(l.chave, l.lista);
      const ate = new Date(l.lista[0] + JANELA_MS);
      return { ok: false, motivo: l.motivo, ate, mensagem: `${TEXTOS[l.motivo]}. Podes voltar a testar às ${hora(ate)}.` };
    }
  }
  for (const l of listas) { l.lista.push(agora); registos.set(l.chave, l.lista); }
  return { ok: true };
}

const limparLimiteTestes = () => registos.clear();

module.exports = { tentarTeste, limparLimiteTestes, configuracao };
