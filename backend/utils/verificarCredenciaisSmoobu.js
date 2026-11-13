/**
 * Verificação de arranque das credenciais Smoobu das empresas (só lê; nunca escreve nem imprime valores).
 * Avisa no log se
 *  - há chave/segredo cifrados que o servidor não consegue ler (ICAL_CHAVES em falta ou errada);
 *  - o HMAC guardado da chave não corresponde à ICAL_HMAC_CHAVE atual (foi mudada sem voltar a correr
 *    `cifrar-chave-smoobu --aplicar`: com a autenticação do webhook ativa, os webhooks passam a dar 401).
 */
const Empresa = require('../models/Empresa');
const { chavesConfiguradas } = require('./calendarioExterno/cifra');
const { estaCifrado, estadoCredenciaisSmoobu, hmacChave } = require('./segredoEmpresa');

async function verificarCredenciaisSmoobu(env = process.env) {
  const r = { empresas: 0, ilegiveis: 0, hmac_desatualizado: 0 };
  const proj = { 'integracoes.smoobu.api_key': 1, 'integracoes.smoobu.api_secret': 1, 'integracoes.smoobu.api_key_hmac': 1 };
  const empresas = await Empresa.collection.find({ 'integracoes.smoobu.api_key': { $nin: [null, ''] } }, { projection: proj }).toArray();
  const cifras = chavesConfiguradas(env);
  for (const e of empresas) {
    const s = (e.integracoes && e.integracoes.smoobu) || {};
    if (!estaCifrado(s.api_key) && !estaCifrado(s.api_secret)) continue;
    r.empresas += 1;
    const c = estadoCredenciaisSmoobu(s, e._id, env);
    if (c.ilegivel) { r.ilegiveis += 1; continue; }
    if (cifras && estaCifrado(s.api_key) && s.api_key_hmac !== hmacChave(c.chave, env)) r.hmac_desatualizado += 1;
  }
  if (r.ilegiveis) {
    console.error(`❌ [Segredos] ${r.ilegiveis} empresa(s) têm a chave/segredo do Smoobu cifrados que o servidor NÃO consegue ler: verifica ICAL_CHAVES/ICAL_CHAVE_ATUAL no ambiente (ou volta a escrever a chave e o segredo no ecrã).`);
  }
  if (r.hmac_desatualizado) {
    console.error(`❌ [Segredos] ${r.hmac_desatualizado} empresa(s) com o HMAC da chave Smoobu desatualizado: a ICAL_HMAC_CHAVE mudou? Repõe a anterior ou corre "node scripts/cifrar-chave-smoobu.js --aplicar" (com a autenticação do webhook ativa, os webhooks falham até lá).`);
  }
  return r;
}

module.exports = { verificarCredenciaisSmoobu };
