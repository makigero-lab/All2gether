/**
 * Segurança do pedido ao calendário externo (anti-SSRF) — All2gether.
 *
 *  - Só https, porta 443, sem user:pass@, sem IP literal, e só domínios permitidos por canal.
 *  - O IP a que a ligação se faz é validado no próprio pedido (lookupSeguro): cobre o DNS rebinding.
 *  - Endereços privados/reservados são sempre recusados.
 *
 * MODO DE TESTE (só desenvolvimento): ICAL_MODO_TESTE=1 aceita http, localhost e qualquer porta, para
 * apontar a um servidor iCal falso local. Está desligado por defeito e é IMPOSSÍVEL ligá-lo em produção:
 * com NODE_ENV=production (ou no Render) fica sempre desligado e o arranque do servidor recusa-se a continuar.
 */
const dns = require('dns');
const net = require('net');

/** O modo de teste está ligado? Nunca em produção. */
const emProducao = (env) => String(env.NODE_ENV || '').trim().toLowerCase() === 'production' || !!env.RENDER;

function modoTesteAtivo(env = process.env) {
  if (env.ICAL_MODO_TESTE !== '1') return false;
  if (emProducao(env)) return false;
  return true;
}

/** Chamada no arranque: com o modo de teste pedido em produção, recusa continuar. */
function garantirSemModoTesteEmProducao(env = process.env) {
  if (env.ICAL_MODO_TESTE === '1' && emProducao(env)) {
    throw new Error('ICAL_MODO_TESTE não pode estar ligado em produção.');
  }
}

/* ---------------- IPs privados ---------------- */

function ipv4Bloqueado(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / metadados cloud
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true; // multicast e reservado
  return false;
}

/** Expande um IPv6 para 8 grupos numéricos (ou null se inválido). */
function expandirIPv6(ip) {
  let s = ip.split('%')[0].toLowerCase();
  // sufixo IPv4 (::ffff:1.2.3.4)
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const v4 = m[2].split('.').map(Number);
    if (v4.length !== 4 || v4.some((x) => x < 0 || x > 255)) return null;
    s = `${m[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const partes = s.split('::');
  if (partes.length > 2) return null;
  const esq = partes[0] ? partes[0].split(':') : [];
  const dir = partes.length === 2 && partes[1] ? partes[1].split(':') : [];
  const falta = 8 - esq.length - dir.length;
  if ((partes.length === 1 && falta !== 0) || falta < 0) return null;
  const todos = [...esq, ...Array(partes.length === 2 ? falta : 0).fill('0'), ...dir];
  if (todos.length !== 8) return null;
  const nums = todos.map((g) => parseInt(g || '0', 16));
  return nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff) ? null : nums;
}

function ipv6Bloqueado(ip) {
  const g = expandirIPv6(ip);
  if (!g) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentação
  // Prefixos que embutem (ou traduzem para) um IPv4: bloqueados por inteiro, qualquer que seja o IPv4 lá dentro.
  if (g[0] === 0x2002) return true; // 6to4 2002::/16
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo 2001::/32
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return true; // NAT64 64:ff9b::/96
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // NAT64 local 64:ff9b:1::/48
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return true; // IPv4-mapeado ::ffff:0:0/96 e IPv4-compatível ::/96
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // descartar 100::/64
  if ((g[0] & 0xffc0) === 0xfec0) return true; // site-local fec0::/10 (obsoleto)
  return false;
}

/** true se o endereço é privado, reservado ou inválido. */
function ipBloqueado(ip) {
  const v = net.isIP(String(ip));
  if (v === 4) return ipv4Bloqueado(ip);
  if (v === 6) return ipv6Bloqueado(ip);
  return true;
}

/**
 * `lookup` para https.request: resolve o nome e recusa se ALGUM endereço for privado.
 * `resolver` é injetável (testes, sem DNS real).
 */
function criarLookupSeguro({ resolver = dns.lookup, permitirLocal = false } = {}) {
  return function lookupSeguro(hostname, opcoes, cb) {
    if (typeof opcoes === 'function') { cb = opcoes; opcoes = {}; }
    resolver(hostname, { ...opcoes, all: true }, (err, enderecos) => {
      if (err) return cb(err);
      const lista = Array.isArray(enderecos) ? enderecos : [{ address: enderecos, family: net.isIP(enderecos) }];
      if (!permitirLocal && lista.some((a) => ipBloqueado(a.address))) {
        const e = new Error('Endereço não permitido.');
        e.codigoIcal = 'ip_bloqueado';
        return cb(e);
      }
      if (opcoes && opcoes.all) return cb(null, lista);
      return cb(null, lista[0].address, lista[0].family);
    });
  };
}

/* ---------------- Domínios e canais ---------------- */

/**
 * Domínios reais do Airbnb onde o link de calendário (iCal) pode estar: lista FECHADA (o `.com` e os domínios
 * regionais do Airbnb). Qualquer outro `airbnb.<tld>` é recusado, porque podia ser de terceiros.
 * Para acrescentar um domínio regional que falte: ICAL_DOMINIOS_AIRBNB_EXTRA (ex.: "airbnb.com.sa").
 */
const SUFIXOS_AIRBNB = [
  'com', 'pt', 'es', 'fr', 'de', 'it', 'nl', 'be', 'at', 'ch', 'ie', 'lu', 'se', 'no', 'dk', 'fi', 'is', 'pl', 'cz', 'gr', 'hu', 'ru', 'tr',
  'co.uk', 'ca', 'com.au', 'co.nz', 'mx', 'com.br', 'com.ar', 'cl', 'co', 'pe', 'com.ec', 'co.cr', 'com.sg', 'com.my', 'co.id', 'co.in',
  'jp', 'co.kr', 'com.hk', 'com.tw', 'com.ph', 'co.za', 'ae',
];
const HOSTS_AIRBNB = new Set(SUFIXOS_AIRBNB.flatMap((x) => [`airbnb.${x}`, `www.airbnb.${x}`]));
/** Hosts do Booking.com onde o link de calendário (iCal) existe: lista fechada. */
const HOSTS_BOOKING = new Set(['ical.booking.com', 'admin.booking.com']);

function hostsAirbnb(env = process.env) {
  const extra = String(env.ICAL_DOMINIOS_AIRBNB_EXTRA || '').split(',').map((d) => d.trim().toLowerCase().replace(/^www\./, ''))
    .filter((d) => /^airbnb\.[a-z]{2,3}(\.[a-z]{2})?$/.test(d));
  return extra.length ? new Set([...HOSTS_AIRBNB, ...extra.flatMap((d) => [d, `www.${d}`])]) : HOSTS_AIRBNB;
}
const RE_CAMINHO_AIRBNB = /^\/calendar\/ical\/\d+\.ics$/;
const DOMINIOS_GENERICOS_BASE = [
  'vrbo.com', 'homeaway.com', 'calendar.google.com', 'outlook.office365.com', 'outlook.live.com',
  'smoobu.com', 'lodgify.com', 'hostaway.com', 'guesty.com',
];

/** Lista de domínios do canal genérico: a base mais ICAL_DOMINIOS_EXTRA (separados por vírgula; o domínio e os subdomínios). */
function dominiosGenericos(env = process.env) {
  const extra = String(env.ICAL_DOMINIOS_EXTRA || '').split(',').map((d) => d.trim().toLowerCase()).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  return [...DOMINIOS_GENERICOS_BASE, ...extra];
}

const hostNoDominio = (host, dominio) => host === dominio || host.endsWith(`.${dominio}`);

const ROTULOS_CANAL = { airbnb: 'Airbnb', booking: 'Booking.com', vrbo: 'Vrbo', outro: 'Outro canal' };

/**
 * Analisa e valida o link. Devolve { ok:true, url (URL), canal, canal_chave, host, rotulo } ou { ok:false, codigo, erro }.
 * O `erro` nunca contém o link.
 */
function analisarUrl(texto, { env = process.env } = {}) {
  const falha = (codigo, erro) => ({ ok: false, codigo, erro });
  if (typeof texto !== 'string') return falha('formato', 'O link tem de ser um texto.');
  const t = texto.trim();
  if (!t) return falha('formato', 'Cola o link do calendário.');
  if (t.length > 2048) return falha('formato', 'O link é demasiado comprido.');
  let u;
  try { u = new URL(t); } catch { return falha('formato', 'O link não é válido. Copia-o de novo do canal.'); }
  const teste = modoTesteAtivo(env);

  if (teste) {
    // Só desenvolvimento: servidor falso local. O canal vem do primeiro segmento do caminho (/airbnb/..., /booking/...).
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return falha('protocolo', 'O link tem de começar por https://.');
    const seg = u.pathname.split('/')[1] || '';
    const canal = seg === 'airbnb' ? 'airbnb' : seg === 'booking' ? 'booking' : 'outro';
    return { ok: true, url: u, canal, canal_chave: canal === 'outro' ? `outro:${u.hostname}` : canal, host: u.hostname, rotulo: ROTULOS_CANAL[canal], teste: true };
  }

  if (u.protocol !== 'https:') return falha('protocolo', 'O link tem de começar por https://.');
  if (u.username || u.password) return falha('formato', 'O link não pode ter utilizador nem palavra-passe.');
  if (u.port && u.port !== '443') return falha('porta', 'O link usa uma porta não permitida.');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (net.isIP(host) || host.startsWith('[')) return falha('ip', 'O link não pode ser um endereço IP.');
  if (!host.includes('.')) return falha('dominio', 'Domínio não permitido.');

  if (hostsAirbnb(env).has(host)) {
    if (!RE_CAMINHO_AIRBNB.test(u.pathname)) return falha('caminho', 'Este não parece o link de calendário do Airbnb (deve acabar em .ics).');
    return { ok: true, url: u, canal: 'airbnb', canal_chave: 'airbnb', host, rotulo: ROTULOS_CANAL.airbnb };
  }
  if (HOSTS_BOOKING.has(host)) {
    if (!u.pathname.startsWith('/v1/export')) return falha('caminho', 'Este não parece o link de calendário da Booking.com.');
    return { ok: true, url: u, canal: 'booking', canal_chave: 'booking', host, rotulo: ROTULOS_CANAL.booking };
  }
  const geral = dominiosGenericos(env);
  if (geral.some((d) => hostNoDominio(host, d))) {
    const canal = hostNoDominio(host, 'vrbo.com') || hostNoDominio(host, 'homeaway.com') ? 'vrbo' : 'outro';
    return { ok: true, url: u, canal, canal_chave: canal === 'vrbo' ? 'vrbo' : `outro:${host}`, host, rotulo: ROTULOS_CANAL[canal] };
  }
  return falha('dominio', 'Este domínio não é suportado. Usa o link de calendário (iCal) do Airbnb ou da Booking.com.');
}

/** O redirecionamento mantém-se dentro do que o canal permite? (para canais conhecidos, o mesmo canal) */
function destinoPermitido(urlDestino, canalOriginal, opcoes) {
  const a = analisarUrl(urlDestino.href, opcoes);
  if (!a.ok) return false;
  if (canalOriginal === 'airbnb' || canalOriginal === 'booking') return a.canal === canalOriginal;
  return true;
}

/** Parâmetro que leva o segredo do link, por canal: tudo o resto na query é ignorado na unicidade. */
const PARAMETRO_TOKEN = { airbnb: 's', booking: 't' };

/**
 * Normalização para comparar links (unicidade): esquema+host em minúsculas+caminho+query ordenada, sem fragmento.
 * Nos canais conhecidos fica só o parâmetro do segredo (Airbnb `s`, Booking `t`) e o host passa a ser o do canal,
 * para `?s=X&x=1`, `?x=1&s=X` e o mesmo link noutro domínio regional contarem como o MESMO link.
 */
function normalizarUrl(u, canal = null) {
  const x = new URL(u.href);
  x.hash = '';
  x.hostname = x.hostname.toLowerCase();
  const chave = PARAMETRO_TOKEN[canal];
  if (chave) {
    const token = x.searchParams.get(chave);
    x.search = '';
    if (token !== null) x.searchParams.set(chave, token);
    if ((canal === 'airbnb' ? hostsAirbnb() : HOSTS_BOOKING).has(x.hostname)) x.hostname = canal === 'airbnb' ? 'www.airbnb.com' : 'ical.booking.com';
  }
  x.searchParams.sort();
  return x.href;
}

/** Máscara mostrada na interface: host + … + últimos 4 caracteres. */
function mascara(u) {
  const fim = (u.pathname + u.search).replace(/[^A-Za-z0-9]/g, '').slice(-4);
  const parte = u.pathname.split('/').filter(Boolean)[0] || '';
  return `${u.hostname}/${parte ? `${parte}/` : ''}…${fim}`.slice(0, 80);
}

module.exports = {
  modoTesteAtivo, garantirSemModoTesteEmProducao,
  ipBloqueado, criarLookupSeguro, analisarUrl, destinoPermitido, normalizarUrl, mascara,
  dominiosGenericos, hostsAirbnb, HOSTS_BOOKING, ROTULOS_CANAL,
};
