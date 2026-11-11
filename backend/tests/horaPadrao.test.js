/**
 * Hora padrão (10:00 de Lisboa) das tarefas ainda sem pessoa e fuso em verão/inverno.
 * Nada de desfasamentos fixos em UTC: segue a hora de verão, incluindo os dias das mudanças.
 */
const H = require('../utils/horario');

const m = (h, min = 0) => h * 60 + min;

describe('hora padrão de tarefas sem pessoa (10:00 de Lisboa)', () => {
  test('inverno 10:00Z, verão 09:00Z', () => {
    expect(H.horaPadraoDoDia('2031-01-15').toISOString()).toBe('2031-01-15T10:00:00.000Z');
    expect(H.horaPadraoDoDia('2031-07-15').toISOString()).toBe('2031-07-15T09:00:00.000Z');
    expect(H.horaPadraoDoDia(new Date('2031-07-15T00:00:00Z')).toISOString()).toBe('2031-07-15T09:00:00.000Z');
  });

  test('nos dias das mudanças de hora continua a ser 10:00 locais', () => {
    for (const dia of ['2031-03-30', '2031-10-26']) {
      expect(H.minutosLocais(H.horaPadraoDoDia(dia))).toBe(m(10));
    }
  });

  test('09:00, 12:00, 17:30 e 18:00 locais valem em qualquer estação', () => {
    for (const dia of ['2031-01-15', '2031-07-15', '2031-03-30', '2031-10-26']) {
      for (const min of [m(9), m(12), m(17, 30), m(18)]) {
        expect(H.minutosLocais(H.utcDeMinutosLocais(dia, min))).toBe(min);
      }
    }
  });

  test('o início automático e o aviso fora do horário usam a hora de Lisboa', () => {
    // 17:45 locais: já não começa; 18:30 locais acaba depois das 18:00.
    expect(H.avisoForaDoHorario(H.utcDeMinutosLocais('2031-07-15', m(17, 45)), 10)).toBe('começa depois das 17:30');
    expect(H.avisoForaDoHorario(H.utcDeMinutosLocais('2031-01-15', m(17, 45)), 10)).toBe('começa depois das 17:30');
    expect(H.avisoForaDoHorario(H.utcDeMinutosLocais('2031-07-15', m(9)), 60)).toBeNull();
    expect(H.avisoForaDoHorario(H.utcDeMinutosLocais('2031-01-15', m(9)), 60)).toBeNull();
  });
});
