/**
 * Calendários externos (iCal): leitura e classificação dos feeds, segurança do pedido (anti-SSRF, limites) e cifra do link.
 * Sem base de dados e sem rede.
 */
const zlib = require('zlib');
const { Readable } = require('stream');
const { configurarChaves, calendario, vevento, dia, comp, PRODID_AIRBNB, PRODID_BOOKING, criarTransporte, URL_AIRBNB, URL_BOOKING } = require('./helpersIcal');
const { analisarIcal, amostraRedigida, hashNormalizado } = require('../utils/calendarioExterno/parser');
const S = require('../utils/calendarioExterno/seguranca');
const { buscarFeed, lerCorpo, descomprimir, ErroFeed } = require('../utils/calendarioExterno/buscar');
const C = require('../utils/calendarioExterno/cifra');

const HOJE = dia(0);
const hmacFalso = (t) => require('../utils/calendarioExterno/cifra').hmac(t);
const ler = (texto, canal = 'airbnb') => analisarIcal(texto, { canal, hoje: HOJE, hmac: hmacFalso });

beforeAll(() => configurarChaves());

describe('parser: formato e datas', () => {
  test('1) linhas dobradas, CRLF e LF, BOM e escapes', () => {
    const dobrado = `BEGIN:VCALENDAR\nPRODID:${PRODID_AIRBNB}\nBEGIN:VEVENT\nUID:abc\n -def@airbnb.com\nDTSTART;VALUE=DATE:${comp(5)}\nDTEND;VALUE=DATE:${comp(7)}\nSUMMARY:Reserved\nEND:VEVENT\nEND:VCALENDAR\n`;
    const r = ler(`﻿${dobrado}`);
    expect(r.eventos).toHaveLength(1);
    expect(r.eventos[0].uid).toBe('abc-def@airbnb.com'); // a linha dobrada junta-se sem o espaço
    const crlf = ler(dobrado.replace(/\n/g, '\r\n'));
    expect(crlf.eventos[0].uid).toBe('abc-def@airbnb.com');
    const esc = ler(`BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:x1\nDTSTART;VALUE=DATE:${comp(5)}\nDTEND;VALUE=DATE:${comp(7)}\nSUMMARY:Not available\\, bloqueado\nEND:VEVENT\nEND:VCALENDAR`);
    expect(esc.eventos[0].classe).toBe('bloqueio');
  });

  test('2) VALUE=DATE, DATE-TIME com Z perto da meia-noite (Lisboa), TZID e DTEND em falta (DURATION e +1 dia)', () => {
    const mk = (linhas) => `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u\n${linhas}\nSUMMARY:Reserved\nEND:VEVENT\nEND:VCALENDAR`;
    const ano = new Date().getUTCFullYear() + 1;
    // 23:30Z de 31/03 no verão (WEST) já é 1/04 em Lisboa. Em 2027, 31/03 está em horário de verão.
    const z = analisarIcal(mk(`DTSTART:${ano}0331T233000Z\nDTEND:${ano}0403T100000Z`), { canal: 'airbnb', hoje: HOJE });
    expect(z.eventos[0].ci).toBe(`${ano}-04-01`);
    const tz = analisarIcal(mk(`DTSTART;TZID=Europe/Lisbon:${ano}0601T150000\nDTEND;TZID=Europe/Lisbon:${ano}0604T110000`), { canal: 'airbnb', hoje: HOJE });
    expect([tz.eventos[0].ci, tz.eventos[0].co]).toEqual([`${ano}-06-01`, `${ano}-06-04`]);
    const dur = analisarIcal(mk(`DTSTART;VALUE=DATE:${ano}0701\nDURATION:P3D`), { canal: 'airbnb', hoje: HOJE });
    expect(dur.eventos[0].co).toBe(`${ano}-07-04`);
    const sem = analisarIcal(mk(`DTSTART;VALUE=DATE:${ano}0801`), { canal: 'airbnb', hoje: HOJE });
    expect(sem.eventos[0].co).toBe(`${ano}-08-02`);
  });

  test('3) DTEND é exclusivo: o dia da saída é o DTEND, e uma estadia de 1 noite é válida', () => {
    const r = ler(calendario(PRODID_AIRBNB, [{ uid: 'a', ci: 10, co: 11 }, { uid: 'b', ci: 20, co: 23 }]));
    expect(r.eventos.map((e) => [e.ci, e.co, e.noites])).toEqual([[dia(10), dia(11), 1], [dia(20), dia(23), 3]]);
  });

  test('4) classes: Airbnb Reserved / Not available / texto desconhecido; Booking CLOSED', () => {
    const a = ler(calendario(PRODID_AIRBNB, [
      { uid: 'r', ci: 10, co: 12, summary: 'Reserved' }, { uid: 'n', ci: 15, co: 17, summary: 'Airbnb (Not available)' }, { uid: 'x', ci: 20, co: 22, summary: 'Qualquer coisa' },
    ]));
    expect(a.eventos.map((e) => e.classe)).toEqual(['reserva', 'bloqueio', 'incerto']);
    const b = ler(calendario(PRODID_BOOKING, [{ uid: 'b1', ci: 10, co: 12, summary: 'CLOSED - Not available' }]), 'booking');
    expect(b.eventos[0]).toMatchObject({ classe: 'incerto', resumo_tipo: 'booking_closed' });
  });

  test('5) descartes: passado, > 24 meses, > 365 noites, RRULE, UID em falta/repetido, código Airbnb repetido', () => {
    const lixo = [
      { uid: 'p', ci: -10, co: -5 }, // passado
      { uid: 'longe', ci: 900, co: 903 }, // > 24 meses
      { uid: 'grande', ci: 10, co: 500 }, // > 365 noites
      { uid: 'rr', ci: 10, co: 12, extra: 'RRULE:FREQ=WEEKLY' },
    ];
    const bons = [
      { uid: 'ok1', ci: 30, co: 32 },
      { uid: 'rep', ci: 40, co: 42 }, { uid: 'rep', ci: 40, co: 42 }, // UID repetido
      { uid: 'c1', ci: 50, co: 52, desc: 'Reservation URL: https://www.airbnb.com/reservation/itinerary?code=HMABC123\\nPhone Number (Last 4 Digits): 1234' },
      { uid: 'c2', ci: 50, co: 52, desc: 'Reservation URL: https://www.airbnb.com/reservation/itinerary?code=HMABC123' }, // mesmo código e datas
    ];
    const texto = calendario(PRODID_AIRBNB, [...lixo, ...bons]).replace('BEGIN:VEVENT\r\nDTEND;VALUE=DATE:' + comp(52) + '\r\nDTSTART;VALUE=DATE:' + comp(50) + '\r\nUID:c2', 'BEGIN:VEVENT\r\nDTEND;VALUE=DATE:' + comp(52) + '\r\nDTSTART;VALUE=DATE:' + comp(50) + '\r\nUID:c2');
    // um evento sem UID
    const semUid = texto.replace('END:VCALENDAR', `BEGIN:VEVENT\r\nDTEND;VALUE=DATE:${comp(60)}\r\nDTSTART;VALUE=DATE:${comp(58)}\r\nSUMMARY:Reserved\r\nEND:VEVENT\r\nEND:VCALENDAR`);
    const r = ler(semUid);
    const uids = r.eventos.map((e) => e.uid);
    expect(uids).toEqual(expect.arrayContaining(['ok1', 'rep', 'c1']));
    expect(uids).not.toContain('c2');
    expect(uids.some((u) => u.startsWith('semuid:'))).toBe(true);
    expect(r.contadores.passado).toBe(1);
    expect(r.contadores.invalidos).toBe(3); // longe, grande, RRULE
    expect(r.contadores.uid_repetido).toBe(2); // 'rep' e c2
    expect(r.eventos.filter((e) => e.uid === 'rep')).toHaveLength(1);
  });

  test('5b) formato inválido: vazio, não é calendário, cortado', () => {
    expect(() => ler('')).toThrow(ErroFeed);
    expect(() => ler('<html>erro</html>')).toThrow(/não é um calendário/);
    expect(() => ler(calendario(PRODID_AIRBNB, [{ uid: 'a', ci: 5, co: 7 }]).replace('END:VCALENDAR', ''))).toThrow(/cortado/);
  });

  test('6) a DESCRIPTION nunca sai do parser; a amostra redigida não leva DESCRIPTION, URL nem o SUMMARY original', () => {
    const texto = calendario(PRODID_AIRBNB, [{ uid: 'a', ci: 10, co: 12, summary: 'Joao Silva (Reserved)', desc: 'Reservation URL: https://www.airbnb.com/reservation/itinerary?code=SEGREDO99\\nPhone Number (Last 4 Digits): 4321' }]);
    const r = ler(texto);
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/SEGREDO99|4321|airbnb\.com\/reservation|Joao/);
    expect(r.eventos[0].codigo_ref_hash).toBeTruthy(); // só o pseudónimo
    const am = amostraRedigida(r.prodid, r.eventos);
    expect(am).not.toMatch(/DESCRIPTION|https?:|Joao|SEGREDO99|4321/);
    expect(am).toMatch(/SUMMARY:desconhecido/);
    expect(hashNormalizado(r.eventos)).toBe(hashNormalizado([...r.eventos]));
  });
});

describe('segurança do pedido', () => {
  test('7) recusa http, IP literal, porta diferente, user:pass@ e domínio fora da lista num canal conhecido', () => {
    const cas = [
      'http://www.airbnb.pt/calendar/ical/1.ics', 'https://127.0.0.1/calendar/ical/1.ics', 'https://[::1]/x.ics', 'https://www.airbnb.pt:8443/calendar/ical/1.ics',
      'https://user:pass@www.airbnb.pt/calendar/ical/1.ics', 'https://airbnb.evil.com/calendar/ical/1.ics', 'https://www.airbnb.pt.evil.com/calendar/ical/1.ics',
      'https://evil.com/calendar/ical/1.ics', 'https://ical.booking.com.evil.com/v1/export?t=1', 'https://www.airbnb.pt/outro/caminho.ics', 'ftp://www.airbnb.pt/calendar/ical/1.ics',
    ];
    for (const u of cas) expect(S.analisarUrl(u).ok).toBe(false);
    expect(S.analisarUrl(URL_AIRBNB)).toMatchObject({ ok: true, canal: 'airbnb' });
    expect(S.analisarUrl(URL_BOOKING)).toMatchObject({ ok: true, canal: 'booking' });
    expect(S.analisarUrl('https://www.vrbo.com/icalendar/abc.ics')).toMatchObject({ ok: true, canal: 'vrbo' });
    expect(S.analisarUrl(null).ok).toBe(false);
    expect(S.analisarUrl({ toString: () => URL_AIRBNB }).ok).toBe(false);
    // domínios extra pelo admin (variável)
    expect(S.analisarUrl('https://cal.exemplo-pms.pt/x.ics').ok).toBe(false);
    expect(S.analisarUrl('https://cal.exemplo-pms.pt/x.ics', { env: { ICAL_DOMINIOS_EXTRA: 'exemplo-pms.pt' } })).toMatchObject({ ok: true, canal: 'outro' });
  });

  test('8) DNS para IP privado/reservado recusado (10.x, 127.x, 169.254.x, ::1, ::ffff:10.x), incluindo no redirecionamento', async () => {
    for (const ip of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fc00::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::1']) {
      expect(S.ipBloqueado(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '203.0.113.10', '2a00:1450:4001::1']) expect(S.ipBloqueado(ip)).toBe(false);
    const lookup = S.criarLookupSeguro({ resolver: (h, o, cb) => cb(null, [{ address: h === 'mau.exemplo.pt' ? '10.1.2.3' : '93.184.216.34', family: 4 }]) });
    await expect(new Promise((res, rej) => lookup('mau.exemplo.pt', { all: true }, (e, a) => (e ? rej(e) : res(a))))).rejects.toMatchObject({ codigoIcal: 'ip_bloqueado' });
    await expect(new Promise((res, rej) => lookup('bom.exemplo.pt', { all: true }, (e, a) => (e ? rej(e) : res(a))))).resolves.toHaveLength(1);
    // um nome com VÁRIOS endereços em que um é privado também é recusado (rebinding)
    const misto = S.criarLookupSeguro({ resolver: (h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]) });
    await expect(new Promise((res, rej) => misto('x.pt', { all: true }, (e, a) => (e ? rej(e) : res(a))))).rejects.toBeTruthy();
    // erro de IP privado vindo do transporte (DNS) → código ip_bloqueado, também a seguir a um redirect
    const t = criarTransporte((u) => (u.hostname === 'www.airbnb.pt' ? { status: 302, headers: { location: 'https://www.airbnb.com/calendar/ical/1.ics' } } : { erro: Object.assign(new Error('x'), { codigoIcal: 'ip_bloqueado' }) }));
    await expect(buscarFeed(URL_AIRBNB, { transporte: t })).rejects.toMatchObject({ codigo: 'ip_bloqueado' });
  });

  test('9) redirecionamento para outro domínio recusado; mais de 3 redirecionamentos recusado; airbnb.pt → www.airbnb.com permitido', async () => {
    const outro = criarTransporte(() => ({ status: 301, headers: { location: 'https://evil.example.com/x.ics' } }));
    await expect(buscarFeed(URL_AIRBNB, { transporte: outro })).rejects.toMatchObject({ codigo: 'redirect_invalido' });
    const muitos = criarTransporte(() => ({ status: 302, headers: { location: 'https://www.airbnb.com/calendar/ical/9.ics' } }));
    await expect(buscarFeed(URL_AIRBNB, { transporte: muitos })).rejects.toMatchObject({ codigo: 'redirect_invalido' });
    const bom = criarTransporte((u) => (u.hostname === 'www.airbnb.pt'
      ? { status: 302, headers: { location: 'https://www.airbnb.com/calendar/ical/123456789.ics' } }
      : { status: 200, corpo: calendario(PRODID_AIRBNB, [{ uid: 'a', ci: 5, co: 7 }]) }));
    const r = await buscarFeed(URL_AIRBNB, { transporte: bom });
    expect(r.redirecionamentos).toBe(1);
    expect(r.texto).toMatch(/BEGIN:VCALENDAR/);
    // um redirecionamento do Booking para o Airbnb também é recusado
    const cruzado = criarTransporte(() => ({ status: 302, headers: { location: URL_AIRBNB } }));
    await expect(buscarFeed(URL_BOOKING, { transporte: cruzado })).rejects.toMatchObject({ codigo: 'redirect_invalido' });
  });

  test('10) corpo > 2 MB cortado, gzip que descomprime para > 4 MB recusado, timeout', async () => {
    const grande = Readable.from([Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024), Buffer.alloc(1024)]);
    await expect(lerCorpo(grande, { maxBytes: 2 * 1024 * 1024 })).rejects.toMatchObject({ codigo: 'tamanho' });
    const bomba = zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024, 'a'));
    expect(bomba.length).toBeLessThan(100 * 1024);
    expect(() => descomprimir(bomba, 'gzip')).toThrow(/demasiado grande/);
    expect(descomprimir(zlib.gzipSync('olá'), 'gzip').toString()).toBe('olá');
    const parado = new Readable({ read() {} });
    await expect(lerCorpo(parado, { timeoutMs: 40 })).rejects.toMatchObject({ codigo: 'timeout' });
    // pelo buscarFeed: HTTP 5xx, 404 e 429 viram códigos nossos
    const t = (st, h = {}) => criarTransporte(() => ({ status: st, headers: h, corpo: '' }));
    await expect(buscarFeed(URL_AIRBNB, { transporte: t(500) })).rejects.toMatchObject({ codigo: 'http_5xx' });
    await expect(buscarFeed(URL_AIRBNB, { transporte: t(404) })).rejects.toMatchObject({ codigo: 'http_404_410' });
    await expect(buscarFeed(URL_AIRBNB, { transporte: t(429, { 'retry-after': '120' }) })).rejects.toMatchObject({ codigo: 'http_429', retryAfter: 120 });
  });

  test('modo de teste: só fora de produção; em produção nunca liga e o arranque recusa', () => {
    expect(S.modoTesteAtivo({ ICAL_MODO_TESTE: '1', NODE_ENV: 'development' })).toBe(true);
    expect(S.modoTesteAtivo({ ICAL_MODO_TESTE: '1', NODE_ENV: 'test' })).toBe(true);
    expect(S.modoTesteAtivo({ NODE_ENV: 'development' })).toBe(false); // desligado por defeito
    expect(S.modoTesteAtivo({ ICAL_MODO_TESTE: '1', NODE_ENV: 'production' })).toBe(false);
    expect(S.modoTesteAtivo({ ICAL_MODO_TESTE: '1', NODE_ENV: 'development', RENDER: 'true' })).toBe(false);
    expect(() => S.garantirSemModoTesteEmProducao({ ICAL_MODO_TESTE: '1', NODE_ENV: 'production' })).toThrow();
    expect(() => S.garantirSemModoTesteEmProducao({ ICAL_MODO_TESTE: '1', RENDER: 'x' })).toThrow();
    expect(() => S.garantirSemModoTesteEmProducao({ NODE_ENV: 'production' })).not.toThrow();
    // com o modo ligado aceita localhost; sem ele, não
    expect(S.analisarUrl('http://localhost:5870/airbnb/a.ics', { env: { ICAL_MODO_TESTE: '1', NODE_ENV: 'development' } })).toMatchObject({ ok: true, canal: 'airbnb' });
    expect(S.analisarUrl('http://localhost:5870/airbnb/a.ics', { env: { NODE_ENV: 'development' } }).ok).toBe(false);
    expect(S.analisarUrl('http://localhost:5870/airbnb/a.ics', { env: { ICAL_MODO_TESTE: '1', NODE_ENV: 'production' } }).ok).toBe(false);
  });
});

describe('cifra do link', () => {
  test('11) ida e volta; tag adulterada falha; AAD de outra fonte falha; rotação; sem chaves = desligado', () => {
    const t = C.cifrar(URL_AIRBNB, 'fonte1');
    expect(t).toMatch(/^v1:1:/);
    expect(t).not.toContain('airbnb');
    expect(C.decifrar(t, 'fonte1')).toBe(URL_AIRBNB);
    expect(() => C.decifrar(t, 'fonte2')).toThrow(); // AAD de outra fonte
    const p = t.split(':'); p[3] = Buffer.from('0123456789abcdef').toString('base64url');
    expect(() => C.decifrar(p.join(':'), 'fonte1')).toThrow(); // tag adulterada
    const p2 = t.split(':'); p2[4] = Buffer.from('xxxxxxxx').toString('base64url');
    expect(() => C.decifrar(p2.join(':'), 'fonte1')).toThrow();
    // rotação: decifra com a 1, cifra com a 2
    const k2 = require('crypto').randomBytes(32).toString('base64');
    const env2 = { ...process.env, ICAL_CHAVES: `${process.env.ICAL_CHAVES},2:${k2}`, ICAL_CHAVE_ATUAL: '2' };
    expect(C.decifrar(t, 'fonte1', env2)).toBe(URL_AIRBNB);
    const t2 = C.cifrar(URL_AIRBNB, 'fonte1', env2);
    expect(C.idChaveDe(t2)).toBe('2');
    expect(C.decifrar(t2, 'fonte1', env2)).toBe(URL_AIRBNB);
    // sem chaves: desligado, nunca cifra em claro
    expect(C.chavesConfiguradas({})).toBe(false);
    expect(() => C.cifrar('x', 'a', {})).toThrow();
    expect(C.chavesConfiguradas({ ICAL_CHAVES: '1:curta', ICAL_CHAVE_ATUAL: '1', ICAL_HMAC_CHAVE: 'x'.repeat(40) })).toBe(false);
    expect(C.semUrl(`falhou em ${URL_AIRBNB} agora`)).toBe('falhou em [url] agora');
  });
});
