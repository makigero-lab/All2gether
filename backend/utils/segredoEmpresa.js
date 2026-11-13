/**
 * Credenciais da empresa (chave e segredo do Smoobu) cifradas em repouso — All2gether.
 *
 * Usa a cifra do iCal (AES-256-GCM, chaves ICAL_CHAVES / ICAL_CHAVE_ATUAL / ICAL_HMAC_CHAVE).
 *  - GRAVAR: com chaves configuradas guarda cifrado; sem chaves guarda em claro (como antes) e avisa
 *    no log (nunca com o valor).
 *  - LER: aceita os dois formatos (claro antigo e cifrado `v1:...`). Assim nada parte antes de as chaves
 *    existirem nem durante a migração.
 *  - A chave Smoobu também autentica o webhook de entrada (comparação por igualdade). Cifrada, já não se
 *    pode procurar na BD, por isso guarda-se ao lado um HMAC dela (`api_key_hmac`) só para essa procura.
 * O AAD liga o valor à empresa e ao campo: copiado para outra empresa ou campo, não decifra.
 */
const { chavesConfiguradas, cifrar, decifrar, hmac } = require('./calendarioExterno/cifra');

const aad = (empresaId, campo) => `empresa:${String(empresaId)}:smoobu:${campo}`;

/** true se o texto tem a forma de um valor cifrado (v1:<chave>:<iv>:<tag>:<cifra>). */
const estaCifrado = (v) => typeof v === 'string' && /^v1:[A-Za-z0-9_-]{1,16}:[^:]+:[^:]+:[^:]*$/.test(v);

let avisou = false;
function avisarSemChaves() {
  if (avisou) return;
  avisou = true;
  console.warn('⚠️  [Segredos] chaves ICAL_* não configuradas: a chave do Smoobu da empresa fica guardada em claro.');
}

/** Valor pronto a gravar: cifrado se houver chaves, em claro caso contrário. '' fica ''. */
function protegerSegredo(valor, empresaId, campo, env = process.env) {
  const v = String(valor == null ? '' : valor).trim();
  if (!v) return '';
  if (!chavesConfiguradas(env)) { avisarSemChaves(); return v; }
  return cifrar(v, aad(empresaId, campo), env);
}

/** Valor em claro, venha cifrado ou não. Se não decifrar (chave em falta/adulterado) devolve '' e avisa, sem o valor. */
function lerSegredo(valor, empresaId, campo, env = process.env) {
  const v = String(valor == null ? '' : valor).trim();
  if (!v) return '';
  if (!estaCifrado(v)) return v;
  try {
    return decifrar(v, aad(empresaId, campo), env);
  } catch (err) {
    console.error(`❌ [Segredos] não foi possível decifrar ${campo} da empresa ${empresaId}: ${err.message}`);
    return '';
  }
}

/** HMAC da chave para procurar a empresa pelo webhook; '' sem chaves configuradas. */
function hmacChave(chave, env = process.env) {
  const v = String(chave == null ? '' : chave).trim();
  if (!v || !chavesConfiguradas(env)) return '';
  return hmac(`smoobu-webhook:${v}`, env);
}

/** Chave e segredo em claro de um subdocumento `integracoes.smoobu` (lean). */
function credenciaisSmoobu(smoobu, empresaId, env = process.env) {
  const s = smoobu || {};
  return {
    chave: lerSegredo(s.api_key, empresaId, 'api_key', env),
    segredo: lerSegredo(s.api_secret, empresaId, 'api_secret', env),
  };
}

/** Entradas `$set` para a chave (e o seu HMAC) a gravar. */
function setChaveSmoobu(chave, empresaId, env = process.env) {
  const v = String(chave == null ? '' : chave).trim();
  return {
    'integracoes.smoobu.api_key': protegerSegredo(v, empresaId, 'api_key', env),
    'integracoes.smoobu.api_key_hmac': hmacChave(v, env),
  };
}

module.exports = { estaCifrado, protegerSegredo, lerSegredo, hmacChave, credenciaisSmoobu, setChaveSmoobu, aad };
