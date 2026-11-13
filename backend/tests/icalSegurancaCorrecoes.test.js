/**
 * Calendários externos (iCal): correções de segurança dos achados do @Tester (2026-11-13).
 * B2 domínios do Airbnb/Booking (listas fechadas) · B7 IPv6 com IPv4 embutido · B9 NODE_ENV sem distinguir
 * maiúsculas · M3 prazo TOTAL do pedido (conta-gotas nos cabeçalhos). Sem rede real: só um servidor local.
 */
const net = require('net');
const SEG = require('../utils/calendarioExterno/seguranca');
const BUS = require('../utils/calendarioExterno/buscar');

describe('B2: domínios do Airbnb e do Booking são listas fechadas', () => {
  const env = { NODE_ENV: 'production' };
  const airbnb = (host) => SEG.analisarUrl(`https://${host}/calendar/ical/123456.ics?s=segredo`, { env });

  test.each([
    'www.airbnb.com', 'airbnb.com', 'www.airbnb.pt', 'airbnb.pt', 'www.airbnb.es', 'www.airbnb.fr', 'www.airbnb.de', 'www.airbnb.it',
    'www.airbnb.co.uk', 'www.airbnb.com.br', 'www.airbnb.com.au', 'www.airbnb.ca', 'www.airbnb.nl', 'www.airbnb.co.nz',
  ])('%s é aceite', (host) => {
    const r = airbnb(host);
    expect(r.ok).toBe(true);
    expect(r.canal).toBe('airbnb');
  });

  test.each([
    'www.airbnb.xyz', 'airbnb.xyz', 'www.airbnb.top', 'www.airbnb.zz', 'www.airbnb.co.zz', 'airbnb.com.evil', 'www.airbnb.pt.evil.com', 'evil-airbnb.com',
    'xairbnb.pt', 'pt.airbnb.com', 'www.airbnb.com.br.attacker.net', 'airbnb.tk', 'www.airbnb.ru.com',
  ])('%s é recusado', (host) => {
    const r = airbnb(host);
    expect(r.ok).toBe(false);
  });

  test('um domínio regional que falte pode ser acrescentado por variável de ambiente (só airbnb.*)', () => {
    expect(SEG.analisarUrl('https://www.airbnb.com.sa/calendar/ical/1.ics?s=x', { env }).ok).toBe(false);
    const comExtra = { ...env, ICAL_DOMINIOS_AIRBNB_EXTRA: 'airbnb.com.sa, evil.com, airbnb.com.sa.evil.com' };
    expect(SEG.analisarUrl('https://www.airbnb.com.sa/calendar/ical/1.ics?s=x', { env: comExtra }).ok).toBe(true);
    expect(SEG.analisarUrl('https://evil.com/calendar/ical/1.ics?s=x', { env: comExtra }).ok).toBe(false);
  });

  test('o caminho continua a ter de ser /calendar/ical/<n>.ics', () => {
    expect(SEG.analisarUrl('https://www.airbnb.pt/outra/coisa?s=x', { env }).ok).toBe(false);
  });

  test.each([
    ['ical.booking.com', true], ['admin.booking.com', true], ['www.booking.com', false], ['booking.com', false], ['ical.booking.com.evil.com', false],
    ['xical.booking.com', false], ['evil.booking.com', false], ['ical.booking.co', false], ['admin.booking.pt', false],
  ])('Booking %s → %s', (host, esperado) => {
    expect(SEG.analisarUrl(`https://${host}/v1/export?t=segredo`, { env }).ok).toBe(esperado);
  });

  test('redirecionar de um domínio do Airbnb para um domínio fora da lista é recusado', () => {
    const dest = new URL('https://www.airbnb.xyz/calendar/ical/1.ics?s=x');
    expect(SEG.destinoPermitido(dest, 'airbnb', { env })).toBe(false);
    expect(SEG.destinoPermitido(new URL('https://www.airbnb.com/calendar/ical/1.ics?s=x'), 'airbnb', { env })).toBe(true);
  });
});

describe('B3: normalização do link para a unicidade', () => {
  const env = { NODE_ENV: 'production' };
  const norm = (url) => { const a = SEG.analisarUrl(url, { env }); return SEG.normalizarUrl(a.url, a.canal); };
  test('Airbnb: só conta o caminho e o parâmetro s (qualquer ordem, qualquer domínio regional, host em minúsculas)', () => {
    const base = norm('https://www.airbnb.pt/calendar/ical/9.ics?s=abc');
    expect(norm('https://www.airbnb.pt/calendar/ical/9.ics?x=1&s=abc')).toBe(base);
    expect(norm('https://www.airbnb.pt/calendar/ical/9.ics?s=abc&x=1&y=2')).toBe(base);
    expect(norm('https://AIRBNB.com/calendar/ical/9.ics?s=abc')).toBe(base);
    expect(norm('https://www.airbnb.pt/calendar/ical/9.ics?s=outro')).not.toBe(base);
    expect(norm('https://www.airbnb.pt/calendar/ical/10.ics?s=abc')).not.toBe(base);
  });
  test('Booking: só conta o parâmetro t', () => {
    const base = norm('https://ical.booking.com/v1/export?t=tok');
    expect(norm('https://ical.booking.com/v1/export?z=1&t=tok')).toBe(base);
    expect(norm('https://admin.booking.com/v1/export?t=tok&a=b')).toBe(base);
    expect(norm('https://ical.booking.com/v1/export?t=outro')).not.toBe(base);
  });
});

describe('B7: IPv6 que embutem um IPv4 são bloqueados', () => {
  test.each([
    '2002:7f00:1::', '2002:0a00:1::', '2002:c0a8:0101::1', '2002:0808:0808::', // 6to4
    '2001:0:7f00:1::', '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '64:ff9b::7f00:1', '64:ff9b::8.8.8.8', '64:ff9b:1::7f00:1', '64:ff9b:1:ffff::1', // NAT64
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:8.8.8.8', '::ffff:0:0', '::7f00:1', '::10.0.0.1', // mapeado e compatível
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', 'fec0::1',
  ])('%s é bloqueado', (ip) => {
    expect(SEG.ipBloqueado(ip)).toBe(true);
  });
  test.each(['2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '2001:4860:4860::8888', '93.184.216.34', '8.8.8.8'])('%s (público) passa', (ip) => {
    expect(SEG.ipBloqueado(ip)).toBe(false);
  });
});

describe('B9: NODE_ENV sem distinguir maiúsculas', () => {
  test.each(['production', 'Production', 'PRODUCTION', ' production ', 'pRoDuCtIoN'])('NODE_ENV=%j desliga o modo de teste e o arranque recusa', (v) => {
    expect(SEG.modoTesteAtivo({ ICAL_MODO_TESTE: '1', NODE_ENV: v })).toBe(false);
    expect(() => SEG.garantirSemModoTesteEmProducao({ ICAL_MODO_TESTE: '1', NODE_ENV: v })).toThrow();
  });
  test('desenvolvimento continua a poder usar o modo de teste', () => {
    expect(SEG.modoTesteAtivo({ ICAL_MODO_TESTE: '1', NODE_ENV: 'development' })).toBe(true);
    expect(SEG.modoTesteAtivo({ ICAL_MODO_TESTE: '1' })).toBe(true);
    expect(() => SEG.garantirSemModoTesteEmProducao({ ICAL_MODO_TESTE: '1', NODE_ENV: 'development' })).not.toThrow();
  });
});

describe('M3: prazo TOTAL do pedido', () => {
  const env = { ICAL_MODO_TESTE: '1', NODE_ENV: 'development' };
  let servidor; let porta; const sockets = new Set(); let timers = [];

  beforeAll(async () => {
    servidor = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
      socket.once('data', () => {
        // Conta-gotas nos CABEÇALHOS: 1 byte de cada vez, nunca acaba os cabeçalhos.
        const texto = 'HTTP/1.1 200 OK\r\nX-Preenchimento: ' + 'a'.repeat(5000);
        let i = 0;
        const t = setInterval(() => { if (i < texto.length && !socket.destroyed) socket.write(texto[i++]); }, 40);
        timers.push(t);
      });
    });
    await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
    porta = servidor.address().port;
  });
  afterAll(async () => {
    timers.forEach(clearInterval);
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => servidor.close(r));
  });

  test('servidor que goteja os cabeçalhos é cortado pelo prazo total (não ao fim de dezenas de segundos)', async () => {
    const t0 = Date.now();
    await expect(BUS.buscarFeed(`http://127.0.0.1:${porta}/airbnb/gota.ics`, { env, timeoutMs: 1500 })).rejects.toMatchObject({ codigo: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(3500);
  }, 15000);

  test('o prazo vale para o pedido inteiro, mesmo com um transporte que nunca responde', async () => {
    const t0 = Date.now();
    const pendurado = () => new Promise(() => {});
    await expect(BUS.buscarFeed('https://www.airbnb.pt/calendar/ical/1.ics?s=x', { env: { NODE_ENV: 'production' }, transporte: pendurado, timeoutMs: 400 })).rejects.toMatchObject({ codigo: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
