/**
 * Excel Controller — Importação e Exportação de Reservas/Tarefas via Excel.
 *
 * FIX (import/export excel) — Permite ao gestor exportar todas as tarefas
 * (com dados de reserva) para um ficheiro .xlsx, e importar reservas em
 * massa a partir de um Excel (fazendo match do nome da propriedade).
 *
 * Rotas (montadas em /api/gestor/reservas):
 *   GET  /exportar-excel    — download direto de .xlsx
 *   POST /importar-excel    — upload de .xlsx → cria ReservaManual + Tarefa
 */

const mongoose = require('mongoose');
const XLSX = require('xlsx');
const Tarefa = require('../models/Tarefa');
const Propriedade = require('../models/Propriedade');
const ReservaManual = require('../models/ReservaManual');

/* ------------------------------------------------------------------ */
/* GET /api/gestor/reservas/exportar-excel                              */
/* ------------------------------------------------------------------ */
exports.exportarExcel = async (req, res) => {
  try {
    const empresaId = req.user && req.user.empresa_id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }

    // Busca as tarefas (com populate de propriedade) — todas as não canceladas.
    const tarefas = await Tarefa.find({
      empresa_id: empresaId,
      estado: { $ne: 'cancelada' },
    })
      .populate({ path: 'propriedade_id', select: 'nome morada capacidade_hospedes' })
      .populate({ path: 'utilizador_id', select: 'nome' })
      .sort({ data: 1 })
      .lean();

    // Mapeia para linhas do Excel.
    const linhas = tarefas.map((t) => ({
      'Data': t.data ? new Date(t.data).toLocaleDateString('pt-PT') : '',
      'Propriedade': t.propriedade_id?.nome ?? '',
      'Hóspedes': t.hospedes ?? t.detalhes_reserva?.pax ?? t.propriedade_id?.capacidade_hospedes ?? '',
      'Origem': t.origem ?? '',
      'Parceiro': t.origem_parceiro ? 'Sim' : 'Não',
      'Tipo': t.tipo ?? '',
      'Estado': t.estado ?? '',
      'Funcionário': t.utilizador_id?.nome ?? '',
      'Check-in': t.detalhes_reserva?.checkin ?? '',
      'Check-out': t.detalhes_reserva?.checkout ?? '',
      'Nome Hóspede': t.detalhes_reserva?.nome_hospede ?? '',
      'Observações': t.observacoes ?? '',
    }));

    // Cria a worksheet e workbook.
    const ws = XLSX.utils.json_to_sheet(linhas);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Reservas');

    // Gera o buffer .xlsx.
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    // Devolve como download direto.
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="reservas_all2gether.xlsx"');
    return res.send(buffer);
  } catch (err) {
    console.error('❌ excel.exportarExcel:', err.message);
    return res.status(500).json({ erro: 'Erro ao gerar Excel.', detalhe: err.message });
  }
};

/* ------------------------------------------------------------------ */
/* POST /api/gestor/reservas/importar-excel                             */
/* ------------------------------------------------------------------ */
exports.importarExcel = async (req, res) => {
  try {
    const empresaId = req.user && req.user.empresa_id;
    const gestorId = req.user && req.user.id;
    if (!empresaId) {
      return res.status(400).json({ erro: 'empresa_id em falta no token.' });
    }

    // O ficheiro vem em req.body (raw) ou req.file (se multer).
    // Como não usamos multer, vamos ler o body raw.
    if (!req.body || typeof req.body !== 'string' && !Buffer.isBuffer(req.body)) {
      return res.status(400).json({
        erro: 'Ficheiro Excel em falta. Envie o .xlsx no body do pedido.',
      });
    }

    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'binary');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) {
      return res.status(400).json({ erro: 'Sheet vazio ou inválido.' });
    }

    const linhas = XLSX.utils.sheet_to_json(ws);
    if (linhas.length === 0) {
      return res.status(400).json({ erro: 'O ficheiro Excel não tem linhas de dados.' });
    }

    // Busca todas as propriedades da empresa para fazer match por nome.
    const propriedades = await Propriedade.find({
      empresa_id: empresaId,
      ativo: true,
    }).lean();
    const mapaProps = new Map();
    for (const p of propriedades) {
      mapaProps.set(p.nome.toLowerCase().trim(), p);
    }

    let criadas = 0;
    let ignoradas = 0;
    let erros = 0;
    const detalheErros = [];

    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];
      try {
        // Aceita várias capitalizações de nomes de coluna.
        const nomeProp = String(
          linha['Propriedade'] ?? linha['propriedade'] ?? linha['Nome'] ?? linha['nome'] ?? ''
        ).trim();
        const dataStr = String(
          linha['Data'] ?? linha['data'] ?? linha['Check-out'] ?? linha['check_out'] ?? linha['checkout'] ?? ''
        ).trim();
        const hospedes = linha['Hóspedes'] ?? linha['hospedes'] ?? linha['Hospedes'] ?? null;
        const checkIn = String(
          linha['Check-in'] ?? linha['check_in'] ?? linha['checkin'] ?? ''
        ).trim();
        const checkOut = String(
          linha['Check-out'] ?? linha['check_out'] ?? linha['checkout'] ?? dataStr
        ).trim();
        const nomeHospede = String(
          linha['Nome Hóspede'] ?? linha['nome_hospede'] ?? linha['hospede'] ?? ''
        ).trim();
        const observacoes = String(
          linha['Observações'] ?? linha['observacoes'] ?? ''
        ).trim();

        if (!nomeProp) {
          detalheErros.push(`Linha ${i + 2}: Propriedade em falta.`);
          erros++;
          continue;
        }

        // Match do nome da propriedade.
        const prop = mapaProps.get(nomeProp.toLowerCase());
        if (!prop) {
          detalheErros.push(`Linha ${i + 2}: Propriedade "${nomeProp}" não encontrada.`);
          erros++;
          continue;
        }

        // Parse da data (aceita DD/MM/YYYY ou YYYY-MM-DD ou ISO).
        let dataTarefa;
        const dataCheckOut = checkOut || dataStr;
        if (dataCheckOut) {
          // Tenta parse pt-PT (DD/MM/YYYY) primeiro, depois ISO.
          const partes = dataCheckOut.split('/');
          if (partes.length === 3) {
            const [dia, mes, ano] = partes.map(Number);
            dataTarefa = new Date(Date.UTC(ano, mes - 1, dia));
          } else {
            dataTarefa = new Date(dataCheckOut);
          }
        }
        if (!dataTarefa || isNaN(dataTarefa.getTime())) {
          detalheErros.push(`Linha ${i + 2}: Data inválida "${dataCheckOut}".`);
          erros++;
          continue;
        }
        dataTarefa.setUTCHours(10, 0, 0, 0); // 10:00 UTC default

        // Fallback de hóspedes — se vazio/zero, usa capacidade da propriedade.
        let numHospedes = hospedes != null && hospedes !== '' ? Number(hospedes) : null;
        if (numHospedes === null || numHospedes === 0 || Number.isNaN(numHospedes)) {
          numHospedes = prop.capacidade_hospedes ?? null;
        }

        // Idempotência: verifica se já existe uma tarefa para a mesma
        // propriedade + data (evita duplicados ao re-importar).
        const existente = await Tarefa.findOne({
          propriedade_id: prop._id,
          data: dataTarefa,
          estado: { $ne: 'cancelada' },
        }).lean();

        if (existente) {
          ignoradas++;
          continue;
        }

        // Cria a ReservaManual.
        const dataCheckIn = checkIn ? (
          checkIn.split('/').length === 3
            ? new Date(Date.UTC(Number(checkIn.split('/')[2]), Number(checkIn.split('/')[1]) - 1, Number(checkIn.split('/')[0])))
            : new Date(checkIn)
        ) : dataTarefa;

        const novaReserva = await ReservaManual.create({
          propriedade_id: prop._id,
          parceiro_id: gestorId, // O gestor que importou fica como "parceiro".
          empresa_id: empresaId,
          check_in: dataCheckIn,
          check_out: dataTarefa,
          hospedes: numHospedes,
          observacoes,
        });

        // Cria a Tarefa de limpeza para o check-out.
        const novaTarefa = await Tarefa.create({
          empresa_id: empresaId,
          propriedade_id: prop._id,
          smoobu_reserva_id: null,
          origem: 'manual',
          utilizador_id: null,
          equipa_atribuida: [],
          data: dataTarefa,
          tempo_limpeza_minutos: prop.tempo_limpeza_minutos || 45,
          tipo: 'limpeza',
          estado: 'por_atribuir',
          observacoes,
          hospedes: numHospedes,
          origem_parceiro: false, // Importação via gestor, não via parceiro B2B.
          checklist: prop.checklist || [],
          detalhes_reserva: {
            checkin: checkIn || null,
            checkout: checkOut || null,
            pax: numHospedes,
            nome_hospede: nomeHospede || null,
          },
        });

        // Associa a tarefa à reserva.
        novaReserva.tarefa_gerada_id = novaTarefa._id;
        await novaReserva.save();

        criadas++;
      } catch (errLinha) {
        detalheErros.push(`Linha ${i + 2}: ${errLinha.message}`);
        erros++;
      }
    }

    let message = `${criadas} reserva(s) criada(s)`;
    if (ignoradas > 0) message += `, ${ignoradas} já existiam (ignoradas)`;
    if (erros > 0) message += `, ${erros} com erro`;
    message += ` (de ${linhas.length} linhas).`;

    return res.status(200).json({
      criadas,
      ignoradas,
      erros,
      detalheErros: detalheErros.slice(0, 20), // primeiros 20 erros
      totalLinhas: linhas.length,
      message,
    });
  } catch (err) {
    console.error('❌ excel.importarExcel:', err.message);
    return res.status(500).json({ erro: 'Erro ao importar Excel.', detalhe: err.message });
  }
};

/* ------------------------------------------------------------------ */
/* GET /api/parceiro/reservas/exportar-excel — Exportar (Parceiro)     */
/*                                                                     */
/* FIX (excel parceiro) — Filtra estritamente por parceiro_id.         */
/* ------------------------------------------------------------------ */
exports.exportarExcelParceiro = async (req, res) => {
  try {
    const parceiroId = req.user && req.user.id;
    const empresaId = req.user && req.user.empresa_id;
    if (!parceiroId || !empresaId) {
      return res.status(400).json({ erro: 'Autenticação em falta.' });
    }

    // Busca as propriedades do parceiro (para filtrar as reservas).
    const propriedades = await Propriedade.find({
      parceiro_id: parceiroId,
      ativo: true,
    }).select('_id').lean();
    const propIds = propriedades.map((p) => p._id);

    if (propIds.length === 0) {
      // Sem propriedades → devolve um Excel vazio.
      const ws = XLSX.utils.json_to_sheet([{ 'Propriedade': '', 'Check-in': '', 'Check-out': '', 'Hóspedes': '', 'Estado': '' }]);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Reservas');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="minhas_reservas.xlsx"');
      return res.send(buffer);
    }

    // Busca as tarefas das propriedades do parceiro.
    const tarefas = await Tarefa.find({
      empresa_id: empresaId,
      propriedade_id: { $in: propIds },
      estado: { $ne: 'cancelada' },
    })
      .populate({ path: 'propriedade_id', select: 'nome' })
      .sort({ data: 1 })
      .lean();

    const linhas = tarefas.map((t) => ({
      'Propriedade': t.propriedade_id?.nome ?? '',
      'Check-in': t.detalhes_reserva?.checkin ?? '',
      'Check-out': t.detalhes_reserva?.checkout ?? '',
      'Hóspedes': t.hospedes ?? t.detalhes_reserva?.pax ?? '',
      'Estado': t.estado ?? '',
    }));

    const ws = XLSX.utils.json_to_sheet(linhas);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Reservas');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="minhas_reservas.xlsx"');
    return res.send(buffer);
  } catch (err) {
    console.error('❌ excel.exportarExcelParceiro:', err.message);
    return res.status(500).json({ erro: 'Erro ao gerar Excel.', detalhe: err.message });
  }
};

/* ------------------------------------------------------------------ */
/* POST /api/parceiro/reservas/importar-excel — Importar (Parceiro)    */
/*                                                                     */
/* FIX (excel parceiro) — Valida que as propriedades pertencem ao      */
/* parceiro (parceiro_id === req.user.id). Cria reservas com           */
/* origem_parceiro: true e auto-atribuição.                            */
/* ------------------------------------------------------------------ */
exports.importarExcelParceiro = async (req, res) => {
  try {
    const parceiroId = req.user && req.user.id;
    const empresaId = req.user && req.user.empresa_id;
    if (!parceiroId || !empresaId) {
      return res.status(400).json({ erro: 'Autenticação em falta.' });
    }

    if (!req.body || (typeof req.body !== 'string' && !Buffer.isBuffer(req.body))) {
      return res.status(400).json({
        erro: 'Ficheiro Excel em falta. Envie o .xlsx no body do pedido.',
      });
    }

    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'binary');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) {
      return res.status(400).json({ erro: 'Sheet vazio ou inválido.' });
    }

    const linhas = XLSX.utils.sheet_to_json(ws);
    if (linhas.length === 0) {
      return res.status(400).json({ erro: 'O ficheiro Excel não tem linhas de dados.' });
    }

    // Busca APENAS as propriedades do parceiro (segurança).
    const propriedades = await Propriedade.find({
      parceiro_id: parceiroId,
      ativo: true,
    }).lean();
    const mapaProps = new Map();
    for (const p of propriedades) {
      mapaProps.set(p.nome.toLowerCase().trim(), p);
    }

    let criadas = 0;
    let ignoradas = 0;
    let erros = 0;
    const detalheErros = [];

    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];
      try {
        const nomeProp = String(
          linha['Propriedade'] ?? linha['propriedade'] ?? linha['Nome'] ?? ''
        ).trim();
        const dataStr = String(
          linha['Check-out'] ?? linha['check_out'] ?? linha['checkout'] ?? linha['Data'] ?? linha['data'] ?? ''
        ).trim();
        const hospedes = linha['Hóspedes'] ?? linha['hospedes'] ?? linha['Hospedes'] ?? null;
        const checkIn = String(
          linha['Check-in'] ?? linha['check_in'] ?? linha['checkin'] ?? ''
        ).trim();
        const checkOut = String(
          linha['Check-out'] ?? linha['check_out'] ?? linha['checkout'] ?? dataStr
        ).trim();
        const nomeHospede = String(
          linha['Nome Hóspede'] ?? linha['nome_hospede'] ?? ''
        ).trim();
        const observacoes = String(
          linha['Observações'] ?? linha['observacoes'] ?? ''
        ).trim();

        if (!nomeProp) {
          detalheErros.push(`Linha ${i + 2}: Propriedade em falta.`);
          erros++;
          continue;
        }

        const prop = mapaProps.get(nomeProp.toLowerCase());
        if (!prop) {
          detalheErros.push(`Linha ${i + 2}: Propriedade "${nomeProp}" não encontrada (ou não te pertence).`);
          erros++;
          continue;
        }

        // Parse da data.
        let dataTarefa;
        const dataCheckOut = checkOut || dataStr;
        if (dataCheckOut) {
          const partes = dataCheckOut.split('/');
          if (partes.length === 3) {
            const [dia, mes, ano] = partes.map(Number);
            dataTarefa = new Date(Date.UTC(ano, mes - 1, dia));
          } else {
            dataTarefa = new Date(dataCheckOut);
          }
        }
        if (!dataTarefa || isNaN(dataTarefa.getTime())) {
          detalheErros.push(`Linha ${i + 2}: Data inválida "${dataCheckOut}".`);
          erros++;
          continue;
        }
        dataTarefa.setUTCHours(10, 0, 0, 0);

        // Fallback de hóspedes.
        let numHospedes = hospedes != null && hospedes !== '' ? Number(hospedes) : null;
        if (numHospedes === null || numHospedes === 0 || Number.isNaN(numHospedes)) {
          numHospedes = prop.capacidade_hospedes ?? null;
        }

        // Idempotência.
        const existente = await Tarefa.findOne({
          propriedade_id: prop._id,
          data: dataTarefa,
          estado: { $ne: 'cancelada' },
        }).lean();

        if (existente) {
          ignoradas++;
          continue;
        }

        const dataCheckIn = checkIn ? (
          checkIn.split('/').length === 3
            ? new Date(Date.UTC(Number(checkIn.split('/')[2]), Number(checkIn.split('/')[1]) - 1, Number(checkIn.split('/')[0])))
            : new Date(checkIn)
        ) : dataTarefa;

        const novaReserva = await ReservaManual.create({
          propriedade_id: prop._id,
          parceiro_id: parceiroId,
          empresa_id: empresaId,
          check_in: dataCheckIn,
          check_out: dataTarefa,
          hospedes: numHospedes,
          observacoes,
        });

        const novaTarefa = await Tarefa.create({
          empresa_id: empresaId,
          propriedade_id: prop._id,
          smoobu_reserva_id: null,
          origem: 'manual',
          utilizador_id: null,
          equipa_atribuida: [],
          data: dataTarefa,
          tempo_limpeza_minutos: prop.tempo_limpeza_minutos || 45,
          tipo: 'limpeza',
          estado: 'por_atribuir',
          observacoes,
          hospedes: numHospedes,
          origem_parceiro: true, // Importação via parceiro.
          checklist: prop.checklist || [],
          detalhes_reserva: {
            checkin: checkIn || null,
            checkout: checkOut || null,
            pax: numHospedes,
            nome_hospede: nomeHospede || null,
          },
        });

        novaReserva.tarefa_gerada_id = novaTarefa._id;
        await novaReserva.save();

        criadas++;
      } catch (errLinha) {
        detalheErros.push(`Linha ${i + 2}: ${errLinha.message}`);
        erros++;
      }
    }

    let message = `${criadas} reserva(s) criada(s)`;
    if (ignoradas > 0) message += `, ${ignoradas} já existiam`;
    if (erros > 0) message += `, ${erros} com erro`;
    message += ` (de ${linhas.length} linhas).`;

    return res.status(200).json({
      criadas,
      ignoradas,
      erros,
      detalheErros: detalheErros.slice(0, 20),
      totalLinhas: linhas.length,
      message,
    });
  } catch (err) {
    console.error('❌ excel.importarExcelParceiro:', err.message);
    return res.status(500).json({ erro: 'Erro ao importar Excel.', detalhe: err.message });
  }
};
