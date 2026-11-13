#!/usr/bin/env node
/**
 * Gera as chaves dos calendários externos (iCal): uma chave AES-256 de 32 bytes e uma chave HMAC.
 * Escreve no ecrã as 3 variáveis para colar no Render (nunca ficam em ficheiros do projeto).
 *
 * Uso:  node scripts/gerarChavesIcal.js
 */
const { gerarChaves } = require('../utils/calendarioExterno/cifra');

const c = gerarChaves();
console.log('Cola estas 3 variáveis de ambiente no Render (e guarda uma cópia num cofre: sem a chave, os links têm de ser colados outra vez):\n');
for (const [k, v] of Object.entries(c)) console.log(`${k}=${v}`);
