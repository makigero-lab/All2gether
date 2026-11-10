/**
 * Com vários workers do jest em paralelo, o mongod em memória demora a arrancar e o
 * limite por omissão (10 s) falha por vezes («Instance failed to start within 10000ms»).
 * Sobe-se o limite de arranque para todos os testes.
 */
const { MongoMemoryServer } = require('mongodb-memory-server');

const criarOriginal = MongoMemoryServer.create.bind(MongoMemoryServer);
MongoMemoryServer.create = (opts = {}) =>
  criarOriginal({
    ...opts,
    instance: { launchTimeout: 60000, ...(opts.instance || {}) },
  });

// Os testes antigos de reservas usam datas fora da janela de B4 (-2/+3 anos); o teste
// dedicado (parceiroDatasHospedes.test.js) desliga isto para verificar o limite a sério.
process.env.DATAS_SEM_LIMITES = '1';
