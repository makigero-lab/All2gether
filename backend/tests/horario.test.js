/**
 * Regras de horário (utils/horario.js), sem base de dados:
 * 09:00-17:30, fim até às 18:00, almoço de 1 h (início entre 12:00 e 14:00),
 * viagens, hora de verão/inverno, equipas e durações que nunca cabem.
 */
const H = require('../utils/horario');

const m = (h, min = 0) => h * 60 + min;
const sem = () => 0; // sem viagens
const com = (v) => () => v;
const it = (ini, fim) => ({ ini, fim });

describe('constantes num só sítio', () => {
  test('janela do dia, almoço e capacidade derivada', () => {
    expect(H.HORARIO.INICIO_DIA).toBe(m(9));
    expect(H.HORARIO.FIM_DIA).toBe(m(17, 30));
    expect(H.HORARIO.FIM_MAXIMO_LIMPEZA).toBe(m(18));
    expect(H.HORARIO.ALMOCO_DURACAO).toBe(60);
    expect(H.HORARIO.ALMOCO_JANELA_INICIO).toBe(m(12));
    expect(H.HORARIO.ALMOCO_INICIO_MAXIMO).toBe(m(14));
    expect(H.JANELA_DIA_MINUTOS).toBe(540);
    expect(H.CAPACIDADE_MAXIMA_MINUTOS).toBe(480);
  });
});

describe('almoço', () => {
  test('acabou às 12:00: almoça logo (a seguinte só começa às 13:00)', () => {
    const ag = [it(m(9), m(12))];
    expect(H.primeiroInicio(ag, { duracao: 60 }, sem)).toBe(m(13));
    expect(H.verificarAlmoco(ag, sem)).toEqual({ ok: true, necessario: true, inicio: m(12) });
  });

  test('acabou às 11:30: faz a seguinte (acaba às 13:30) e almoça depois dela', () => {
    const ag = [it(m(9), m(11, 30))];
    const ini = H.primeiroInicio(ag, { duracao: 120 }, sem);
    expect(ini).toBe(m(11, 30));
    expect(H.verificarAlmoco([...ag, it(ini, ini + 120)], sem).inicio).toBe(m(13, 30));
  });

  test('a limpeza antes do almoço pode acabar às 14:00 (limite do início do almoço)', () => {
    const ag = [it(m(9), m(11, 30))];
    // 11:30 + 150 = 14:00: o almoço começa às 14:00 (limite) e acaba às 15:00.
    expect(H.primeiroInicio(ag, { duracao: 150 }, sem)).toBe(m(11, 30));
    expect(H.verificarAlmoco([it(m(9), m(11, 30)), it(m(11, 30), m(14))], sem)).toEqual({ ok: true, necessario: true, inicio: m(14) });
  });

  test('nenhuma limpeza empurra o almoço para depois das 14:00: passa para depois do almoço das 12:00', () => {
    const ag = [it(m(9), m(11, 30))];
    // 11:30 + 151 = 14:01 -> a seguir ao almoço (12:00-13:00 parada), começa às 13:00
    expect(H.primeiroInicio(ag, { duracao: 151 }, sem)).toBe(m(13));
    expect(H.verificarAlmoco([it(m(11, 30), m(14, 1))], sem).ok).toBe(false);
  });

  test('sem nenhuma limpeza a acabar a partir das 12:00 não há almoço', () => {
    expect(H.verificarAlmoco([it(m(9), m(11, 59))], sem)).toEqual({ ok: true, necessario: false, inicio: null });
  });

  test('pessoa parada: o almoço às 12:00 cabe antes de uma limpeza que só começa às 13:00', () => {
    expect(H.verificarAlmoco([it(m(13), m(15))], sem)).toEqual({ ok: true, necessario: true, inicio: m(12) });
  });

  test('a viagem depois do almoço conta para a limpeza seguinte', () => {
    const ag = [it(m(9), m(12))];
    expect(H.primeiroInicio(ag, { duracao: 60 }, com(30))).toBe(m(13, 30));
  });
});

describe('janela 09:00-17:30 / 18:00', () => {
  test('a primeira limpeza do dia começa às 09:00, nunca antes', () => {
    expect(H.primeiroInicio([], { duracao: 60 }, sem)).toBe(m(9));
  });

  test('pode acabar exatamente às 18:00', () => {
    const ag = [it(m(9), m(11)), it(m(11), m(13))]; // almoço 13:00-14:00
    expect(H.primeiroInicio(ag, { duracao: 240 }, sem)).toBe(m(14));
    expect(H.cabeNoDia(ag, { ini: m(14), fim: m(18), nova: true }, sem)).toBe(true);
  });

  test('acabar às 18:01 não cabe', () => {
    const ag = [it(m(9), m(11)), it(m(11), m(13))];
    expect(H.primeiroInicio(ag, { duracao: 241 }, sem)).toBeNull();
  });

  test('começar às 17:30 ou depois não cabe (o dia de trabalho acaba às 17:30)', () => {
    expect(H.dentroDaJanela(m(17, 29), 30)).toBe(true);
    expect(H.dentroDaJanela(m(17, 30), 30)).toBe(false);
    expect(H.dentroDaJanela(m(8, 59), 30)).toBe(false);
  });

  test('uma limpeza de 480 min não encrava: nunca cabe (devolve null)', () => {
    expect(H.duracaoCabeNoHorario(480)).toBe(false);
    expect(H.primeiroInicio([], { duracao: 480 }, sem)).toBeNull();
    expect(H.primeiroInicio([it(m(9), m(10))], { duracao: 480 }, sem)).toBeNull();
  });

  test('uma limpeza de 300 min cabe (09:00-14:00 e almoço às 14:00)', () => {
    expect(H.duracaoCabeNoHorario(300)).toBe(true);
    expect(H.primeiroInicio([], { duracao: 300 }, sem)).toBe(m(9));
  });
});

describe('viagens e sobreposições', () => {
  test('a viagem entre limpezas conta: 10:00 + 30 de viagem = 10:30', () => {
    const ag = [it(m(9), m(10))];
    expect(H.primeiroInicio(ag, { duracao: 60 }, com(30))).toBe(m(10, 30));
  });

  test('a mesma casa seguida não tem viagem (função de viagem devolve 0)', () => {
    expect(H.primeiroInicio([it(m(9), m(10))], { duracao: 60 }, sem)).toBe(m(10));
  });

  test('não se sobrepõe a uma limpeza marcada à mão e encaixa no intervalo', () => {
    const ag = [it(m(9), m(10)), it(m(11, 30), m(12))];
    // 10:00 + 30 = 10:30; 10:30 + 60 = 11:30; a seguinte precisa de 30 de viagem -> não cabe no intervalo
    expect(H.primeiroInicio(ag, { duracao: 60 }, com(30))).not.toBe(m(10, 30));
    expect(H.primeiroInicio(ag, { duracao: 30 }, com(30))).toBe(m(10, 30));
  });

  test('viagens fazem a quarta limpeza de 2 h deixar de caber (cabia sem viagens)', () => {
    const dia = (v) => {
      const ag = [];
      for (let i = 0; i < 4; i++) {
        const ini = H.primeiroInicio(ag, { duracao: 120 }, com(v));
        if (ini === null) return ag.length;
        ag.push(it(ini, ini + 120));
      }
      return ag.length;
    };
    expect(dia(0)).toBe(4); // 9-11, 11-13, (almoço) 14-16, 16-18
    expect(dia(30)).toBe(3); // 9-11, 11:30-13:30, (almoço) 15:00-17:00
  });
});

describe('equipa de 2 pessoas', () => {
  test('começa quando os dois conseguem', () => {
    const a = [it(m(9), m(10))];
    const b = [it(m(9), m(11, 30))];
    expect(H.primeiroInicioEquipa([a, b], { duracao: 60 }, sem)).toBe(m(11, 30));
  });

  test('se um deles não tem hora livre, a equipa não cabe', () => {
    const a = [];
    const b = [it(m(9), m(13)), it(m(14), m(18))];
    expect(H.primeiroInicioEquipa([a, b], { duracao: 120 }, sem)).toBeNull();
  });
});

describe('hora de verão e de inverno (Europe/Lisbon)', () => {
  test('desfasamento: 0 no inverno, 60 no verão', () => {
    expect(H.offsetLisboaMin(new Date('2031-01-15T12:00:00Z'))).toBe(0);
    expect(H.offsetLisboaMin(new Date('2031-07-15T12:00:00Z'))).toBe(60);
  });

  test('09:00 locais = 09:00 UTC no inverno e 08:00 UTC no verão', () => {
    expect(H.utcDeMinutosLocais('2031-01-15', m(9)).toISOString()).toBe('2031-01-15T09:00:00.000Z');
    expect(H.utcDeMinutosLocais('2031-07-15', m(9)).toISOString()).toBe('2031-07-15T08:00:00.000Z');
  });

  test('os dias das mudanças de hora (último domingo de março e de outubro)', () => {
    // 2031: 30 de março (WET->WEST) e 26 de outubro (WEST->WET)
    expect(H.utcDeMinutosLocais('2031-03-30', m(9)).toISOString()).toBe('2031-03-30T08:00:00.000Z');
    expect(H.utcDeMinutosLocais('2031-10-26', m(9)).toISOString()).toBe('2031-10-26T09:00:00.000Z');
  });

  test('ida e volta: minutos locais de um instante UTC', () => {
    expect(H.minutosLocais(new Date('2031-07-15T08:00:00Z'))).toBe(m(9));
    expect(H.minutosLocais(new Date('2031-01-15T09:00:00Z'))).toBe(m(9));
  });
});

describe('domingo é um dia normal', () => {
  test('o planeamento não distingue o dia da semana', () => {
    // 2031-01-12 é domingo; as regras de horário são as mesmas de uma segunda.
    expect(new Date('2031-01-12T12:00:00Z').getUTCDay()).toBe(0);
    expect(H.primeiroInicio([], { duracao: 60 }, sem)).toBe(m(9));
  });
});

describe('«sem hora real» e hora errada', () => {
  test('só a meia-noite exata é sem hora', () => {
    expect(H.temHoraReal('2031-01-15T00:00:00.000Z')).toBe(false);
    expect(H.temHoraReal('2031-01-15T02:08:00.000Z')).toBe(true);
    expect(H.temHoraReal('2031-01-15T07:12:00.000Z')).toBe(true);
    expect(H.temHoraReal('2031-01-15T09:45:00.000Z')).toBe(true);
  });

  test('aviso de fora do horário (atribuição à mão): não bloqueia, só avisa', () => {
    expect(H.avisoForaDoHorario(new Date('2031-01-15T07:12:00Z'), 60)).toMatch(/antes das 09:00/);
    expect(H.avisoForaDoHorario(new Date('2031-01-15T17:30:00Z'), 60)).toMatch(/depois das 18:00/);
    expect(H.avisoForaDoHorario(new Date('2031-01-15T10:00:00Z'), 60)).toBeNull();
    expect(H.avisoForaDoHorario(new Date('2031-01-15T00:00:00Z'), 60)).toBeNull();
  });
});
