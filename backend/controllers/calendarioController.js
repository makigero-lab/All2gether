/**
 * Calendários externos (iCal) — handlers HTTP do proprietário e do gestor — All2gether.
 *
 * A lógica vive em utils/calendarioExterno/. Aqui só se resolve o escopo (proprietário: só os dele; gestor: os
 * da empresa) e se transforma o resultado em resposta. A API nunca devolve o link do calendário.
 */
const D = require('../utils/calendarioExterno/decisoes');
const S = require('../utils/calendarioExterno/servico');
const I = require('../utils/calendarioExterno/integracoes');
const Acordo = require('../utils/acordoRgpd');
const Utilizador = require('../models/Utilizador');

const enviar = (res, r) => res.status(r.status).json(r.body);
const erroInterno = (res, nome, err) => {
  console.error(`❌ calendarioController.${nome}:`, String(err && err.message).replace(/https?:\/\/\S+/gi, '[url]'));
  return res.status(500).json({ erro: 'Erro interno.' });
};

/** Constrói os handlers para um papel. `papel`: 'parceiro' | 'gestor'. */
function criarHandlers(papel) {
  const ehGestor = papel === 'gestor';
  const escopo = (req) => ({ empresaId: req.user.empresa_id, ...(ehGestor ? {} : { parceiroId: req.user.id }) });
  const ator = (req) => ({ tipo: ehGestor ? 'gestor' : 'parceiro', id: req.user.id, nome: req.user.nome || '' });
  const corre = (nome, fn) => async (req, res) => {
    try { return await fn(req, res); } catch (err) { return erroInterno(res, nome, err); }
  };
  // Só o gestor liga, testa, corrige e remove calendários: ao proprietário a API responde 403.
  const soGestor = (fn) => (ehGestor ? fn : async (req, res) => res.status(403).json({ erro: 'Só a All2gether liga, muda ou remove os calendários. Fala com o teu gestor.', codigo: 'SO_GESTOR' }));
  const h = {
    listar: corre('listar', async (req, res) => enviar(res, await S.listarLigacoes({ escopo: escopo(req), propriedadeId: req.query.propriedade_id, estado: req.query.estado }))),
    testar: soGestor(corre('testar', async (req, res) => {
      if (!S.limiteTestar(req.user.id)) return res.status(429).json({ erro: 'Testaste muitas vezes. Tenta outra vez daqui a uma hora.' });
      const b = req.body || {};
      return enviar(res, await S.testarLigacao({ propriedadeId: b.propriedade_id, url: b.url, escopo: escopo(req) }));
    })),
    criar: soGestor(corre('criar', async (req, res) => {
      const b = req.body || {};
      return enviar(res, await S.criarLigacao({ propriedadeId: b.propriedade_id, url: b.url, rotulo: b.rotulo, escopo: escopo(req), ator: ator(req) }));
    })),
    substituir: soGestor(corre('substituir', async (req, res) => enviar(res, await S.substituirLigacao({ id: req.params.id, url: (req.body || {}).url, escopo: escopo(req), ator: ator(req) })))),
    atualizar: corre('atualizar', async (req, res) => enviar(res, await S.atualizarAgora({ id: req.params.id, escopo: escopo(req), ator: ator(req) }))),
    reativar: soGestor(corre('reativar', async (req, res) => enviar(res, await S.reativarLigacao({ id: req.params.id, escopo: escopo(req) })))),
    impacto: soGestor(corre('impacto', async (req, res) => enviar(res, await S.impactoRemocao({ id: req.params.id, escopo: escopo(req) })))),
    remover: soGestor(corre('remover', async (req, res) => enviar(res, await S.removerLigacao({ id: req.params.id, escopo: escopo(req), ator: ator(req) })))),
    leituras: corre('leituras', async (req, res) => enviar(res, await S.listarLeituras({ id: req.params.id, escopo: escopo(req), limite: req.query.limite, completo: ehGestor }))),
    estado: corre('estado', async (req, res) => enviar(res, await S.mudarEstado({ id: req.params.id, acao: (req.body || {}).acao, escopo: escopo(req) }))),
    listarExternas: corre('listarExternas', async (req, res) => enviar(res, await S.listarReservasExternas({ escopo: escopo(req), estado: req.query.estado || 'por_confirmar', parceiroId: req.query.parceiro_id }))),
    confirmar: corre('confirmar', async (req, res) => {
      const e = escopo(req);
      return enviar(res, await D.confirmarExterna({ externaId: req.params.id, empresaId: e.empresaId, parceiroId: e.parceiroId || null, ator: ator(req), dados: req.body }));
    }),
    bloqueio: corre('bloqueio', async (req, res) => {
      const e = escopo(req);
      return enviar(res, await D.marcarBloqueio({ externaId: req.params.id, empresaId: e.empresaId, parceiroId: e.parceiroId || null, ator: ator(req) }));
    }),
    reabrir: corre('reabrir', async (req, res) => {
      const e = escopo(req);
      return enviar(res, await D.reabrirBloqueio({ externaId: req.params.id, empresaId: e.empresaId, parceiroId: e.parceiroId || null, ator: ator(req) }));
    }),
    // --- só do gestor: vista geral, lote e (proprietário) acordo ---
    resumo: corre('resumo', async (req, res) => enviar(res, await I.resumoIntegracoes({ empresaId: req.user.empresa_id, incluirInativos: req.query.inativos === '1' }))),
    contagem: corre('contagem', async (req, res) => enviar(res, await I.contagemErros({ empresaId: req.user.empresa_id }))),
    lote: corre('lote', async (req, res) => {
      const b = req.body || {};
      return enviar(res, await I.decidirLote({ ids: b.ids, acao: b.acao, empresaId: req.user.empresa_id, ator: ator(req) }));
    }),
    acordo: corre('acordo', async (req, res) => res.json(await Acordo.resumoParaPortal({ id: req.user.id }))),
    aceitarAcordo: corre('aceitarAcordo', async (req, res) => {
      const u = await Utilizador.findById(req.user.id).select('nome email empresa_id').lean();
      const b = req.body || {};
      return enviar(res, await Acordo.aceitar({ user: { id: req.user.id, empresa_id: req.user.empresa_id, nome: u && u.nome, email: u && u.email }, versao: b.versao, hash: b.hash, confirmo: b.confirmo, ip: req.ip, agente: req.get('user-agent') }));
    }),
  };
  return h;
}

module.exports = { parceiro: criarHandlers('parceiro'), gestor: criarHandlers('gestor') };
