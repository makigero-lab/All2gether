#!/usr/bin/env node
/**
 * Reduz ao mínimo os payloads dos WebhookLog já existentes (RGPD): fica o tipo, os ids, as datas e o estado;
 * saem nomes, emails, telefones, moradas e notas (lista de campos permitidos em
 * utils/minimizarPayloadWebhook.js). Idempotente (marca `payload_minimo`).
 * Não toca nos logs 'recebido' com menos de 8 dias (a retoma de webhooks presos ainda pode precisar deles).
 * SIMULA por defeito; só escreve com --aplicar. Não imprime dados dos payloads.
 *
 * Uso:
 *   node scripts/limpar-webhooklogs.js            # simulação
 *   node scripts/limpar-webhooklogs.js --aplicar  # escreve
 */
const mongoose = require('mongoose');
const WebhookLog = require('../models/WebhookLog');
const { minimizarPayload } = require('../utils/minimizarPayloadWebhook');

const MS_DIA = 86400000;

async function limparWebhookLogs({ aplicar = false, agora = new Date() } = {}) {
  const col = WebhookLog.collection;
  const limite = new Date(agora.getTime() - 8 * MS_DIA);
  const filtro = {
    payload_minimo: { $ne: true },
    $or: [{ status: { $ne: 'recebido' } }, { createdAt: { $lt: limite } }],
  };
  const r = { aplicado: aplicar, a_limpar: 0, limpos: 0 };
  let ultimo = null;
  for (;;) {
    const f = ultimo ? { ...filtro, _id: { $gt: ultimo } } : filtro;
    const lote = await col.find(f, { projection: { payload: 1 } }).sort({ _id: 1 }).limit(500).toArray();
    if (lote.length === 0) break;
    ultimo = lote[lote.length - 1]._id;
    r.a_limpar += lote.length;
    if (aplicar) {
      for (const d of lote) {
        await col.updateOne({ _id: d._id }, { $set: { payload: minimizarPayload(d.payload), payload_minimo: true } });
        r.limpos += 1;
      }
    }
  }
  return r;
}

module.exports = { limparWebhookLogs };

if (require.main === module) {
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const r = await limparWebhookLogs({ aplicar: process.argv.includes('--aplicar') });
    console.log(r.aplicado ? 'Aplicado:' : 'Simulação (nada foi escrito):', r);
    await mongoose.disconnect();
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
