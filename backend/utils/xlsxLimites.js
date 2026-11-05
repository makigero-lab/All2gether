/**
 * Verifica o tamanho DESCOMPRIMIDO de um .xlsx (que é um zip) ANTES de o
 * entregar ao ExcelJS. Um ficheiro de 2,5 MB pode descomprimir para dezenas de
 * MB (300 000 linhas) e bloquear o servidor segundos / consumir centenas de MB
 * só a ser lido. Lê apenas o diretório central do zip (rápido, sem descomprimir).
 *
 * Nota: os tamanhos vêm do próprio ficheiro; um zip malicioso pode mentir, mas
 * o limite de 5 MB no body (e o limite de linhas depois) mantêm o dano contido.
 */

// 2000 linhas ocupam ~0,3 a 1 MB de XML; estes limites dão folga larga.
const MAX_DESCOMPRIMIDO_TOTAL = 12 * 1024 * 1024;
const MAX_DESCOMPRIMIDO_ENTRADA = 8 * 1024 * 1024;
const MAX_ENTRADAS = 200;

/** Devolve { ok: true } ou { ok: false, motivo }. */
function verificarTamanhoXlsx(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return { ok: false, motivo: 'invalido' };
  // Fim do diretório central (EOCD): procura a assinatura nos últimos 64 KB + 22.
  const minPos = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, motivo: 'invalido' };
  const total = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || pos === 0xffffffff) return { ok: false, motivo: 'grande' }; // zip64
  if (total > MAX_ENTRADAS) return { ok: false, motivo: 'grande' };
  let soma = 0;
  for (let n = 0; n < total; n++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) return { ok: false, motivo: 'invalido' };
    const descomprimido = buf.readUInt32LE(pos + 24);
    if (descomprimido === 0xffffffff || descomprimido > MAX_DESCOMPRIMIDO_ENTRADA) return { ok: false, motivo: 'grande' };
    soma += descomprimido;
    if (soma > MAX_DESCOMPRIMIDO_TOTAL) return { ok: false, motivo: 'grande' };
    pos += 46 + buf.readUInt16LE(pos + 28) + buf.readUInt16LE(pos + 30) + buf.readUInt16LE(pos + 32);
  }
  return { ok: true, descomprimido: soma };
}

module.exports = { verificarTamanhoXlsx, MAX_DESCOMPRIMIDO_TOTAL, MAX_DESCOMPRIMIDO_ENTRADA };
