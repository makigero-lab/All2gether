/**
 * Lock por empresa com expiração (Mongo) — All2gether.
 *
 * Serve para serializar importações de Excel da mesma empresa: sem isto, duas
 * importações simultâneas do mesmo ficheiro passam ambas a verificação
 * "já existe?" antes de qualquer uma criar, e duplicam.
 *
 * Porquê lock e não índice único: as limpezas guardam a data-hora completa
 * (a hora muda ao atribuir) e o estado 'cancelada' tem de libertar o dia; um
 * índice parcial não aceita `$ne`, obrigaria a um campo novo mantido em todos
 * os caminhos de cancelamento e não protege dados de produção que já têm
 * duplicados. O lock é atómico (upsert sobre _id único) e expira sozinho
 * se o processo morrer a meio.
 */
const mongoose = require('mongoose');

const lockSchema = new mongoose.Schema({
  _id: { type: String }, // ex.: "import:<empresaId>"
  expira_em: { type: Date, required: true },
  dono: { type: String, required: true },
});
const LockEmpresa = mongoose.models.LockEmpresa || mongoose.model('LockEmpresa', lockSchema);

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tenta obter o lock. Espera até `esperaMs` (polling). Devolve um token (dono)
 * ou null se não conseguiu.
 */
async function obterLock(chave, { ttlMs = 120000, esperaMs = 20000, passoMs = 150 } = {}) {
  const dono = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const limite = Date.now() + esperaMs;
  for (;;) {
    const agora = new Date();
    try {
      // Cria o lock, ou toma-o se o anterior já expirou. Dois a competir: só um ganha
      // (o outro falha com E11000 no upsert, porque o _id já existe e não satisfaz o filtro).
      const r = await LockEmpresa.findOneAndUpdate(
        { _id: chave, expira_em: { $lt: agora } },
        { $set: { expira_em: new Date(agora.getTime() + ttlMs), dono } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      if (r && r.dono === dono) return dono;
    } catch (e) {
      if (!(e && e.code === 11000)) throw e;
    }
    if (Date.now() >= limite) return null;
    await dormir(passoMs);
  }
}

async function libertarLock(chave, dono) {
  try {
    await LockEmpresa.deleteOne({ _id: chave, dono });
  } catch {
    // expira sozinho
  }
}

module.exports = { obterLock, libertarLock, LockEmpresa };
