# Worklog — Autocell

Worklog interno do projeto Autocell. Regista a evolução técnica do trabalho
efetuado (análises, melhorias, correções). Complementa o histórico do git
(`git log`) e a documentação técnica (`docs/BACKEND.md`, `docs/FRONTEND.md`).

> **Convenções do projeto** (definidas pelo utilizador):
> - Branch ativa: **`dev`**.
> - Linguagem: **pt-pt** (código, comentários, documentação, commits).
> - Sempre que o código é alterado, atualizar: `README.md`, `docs/BACKEND.md`,
>   `docs/FRONTEND.md` e este `WORKLOG.md`.
> - Commits no formato: `feat|fix|chore(escopo): descrição (Prompt N)`.

---

Task ID: A0
Agent: Z.ai Code
Task: Clonar o repositório Autocell (branch dev), guardar credenciais e analisar código + documentação + worklog para entender regras de processo e lógica.

Work Log:
- Clonado `https://github.com/makigero-lab/Autocell.git` na branch `dev` para `/home/z/Autocell` (127 commits, até "Prompt 91").
- Configurado `git config user.name "Makigero Lab"` + `user.email makigerorr@gmail.com`; remote `origin` já tem o token embutido (URL-encoded) → push/pull funcionam sem re-pedir credenciais.
- Credenciais guardadas em `/home/z/.autocell-config` (FORA do repo, para evitar commit de segredos).
- Lido `README.md`, `docs/BACKEND.md`, `docs/FRONTEND.md`, `agent-ctx/56-z-ai-code.md` (registo da Task 56).
- Analisada estrutura real de rotas (`frontend/src/app/`) e `frontend/src/middleware.ts`.
- Lidos `backend/.env.example`, `backend/package.json`, `frontend/.env.example`.

Stage Summary (regras de processo e lógica identificadas):
- **Stack:** Backend Node.js+Express+MongoDB (Mongoose) no Render · Frontend Next.js 14+TS+Tailwind+shadcn/ui na Vercel.
- **Multi-tenant SaaS** para Alojamento Local. Entidades: Empresa → (Propriedades, Utilizadores, Tarefas, Ausências, WebhookLog, Auditoria).
- **Roles:** `admin` (super admin, cross-tenant, painel `/admin`), `gestor` (gestor operacional, painel `/gestor/*`), `staff` (executante, painel `/staff/*` mobile-first).
- **Lógica central — Webhook Smoobu (`POST /webhooks/smoobu`):** responde 200 imediato e processa assíncrono. Fluxo: extrair dados da reserva → encontrar empresa via propriedade (`smoobu_id`) → listar staff+gestores ativos → filtrar ausências aprovadas + folgas fixas (`dias_folga`) → load balancing (carga do dia + tempo de viagem Haversine + SLA 420min) → atribuir ao menor carregado → se nenhum disponível, tarefa criada `por_atribuir`. Reage a `newReservation`/`cancellation`/`updateReservation`. Idempotente por `smoobu_reserva_id`. Propriedades inativas são ignoradas.
- **Ausências:** intervalos `data_inicio`/`data_fim` com `estado` (pendente/aprovada/rejeitada). Staff cria pedidos (sempre pendente); gestor aprova (→ redistribui tarefas via load balancer) ou rejeita. Só ausências `aprovada` bloqueiam atribuição. Falta súbita/baixa criam ausência aprovada + redistribuem.
- **Segurança:** JWT em cookie httpOnly (SameSite=Strict+Secure); proxy routes (`/api/gestor/[...path]`, `/api/staff/[...path]`) injetam `Authorization`; sem localStorage; rate limiting no login (5/15min) + global (100/15min); RBAC por role; CORS trancado a `FRONTEND_URL`.
- **Proteção de rotas:** middleware Edge (lê cookie, descodifica JWT sem verificar assinatura, valida role por área) + `RouteGuard` client-side. Login redireciona por role.
- **Push notifications:** Web Push API (VAPID); dispara em atribuição de tarefa, avarias reportadas, falta de emergência, daily briefing.
- **Avarias:** staff reporta avaria no detalhe da tarefa → cria tarefa de manutenção `por_atribuir` (SLA 480min) + notifica gestores.
- **Testes:** Jest+Supertest+mongodb-memory-server (103 testes na Task 56). CI GitHub Actions (frontend lint+tsc+build, backend test) nas branches main/dev.
- **Gaps de documentação identificados (a corrigir quando houver alterações):**
  1. `docs/FRONTEND.md` secções 3 e 11 ainda usam rotas `/admin/*` para a área do gestor — desatualizado desde a v1.30/v1.31 (rename `/admin`→`/gestor` + novo `/admin` super admin). As rotas reais são `/gestor/*` (gestor) e `/admin` (super admin).
  2. `docs/FRONTEND.md` ainda referencia role `manager` em alguns pontos; o role real é `gestor`.
  3. Tabelas de histórico param atrás: `BACKEND.md` em v1.24.0, `FRONTEND.md` em v1.13.0 — o git já vai até Prompt 91. Prompts 73-91 (FullCalendar, radar de risco, auto-atribuição, push, menu Ausências, etc.) não estão nas tabelas de histórico.
- **Pronto para receber prompts de melhoria/correção.** Próximo passo aguardar instruções do utilizador.

---

Task ID: A1 (Prompt 92)
Agent: Z.ai Code
Task: Upgrade dos modelos de dados (Propriedade + Tarefa) e forçar a atualização do Smoobu na Fase 1.5.

Work Log:
- Lido o worklog (Task A0) e os 3 ficheiros-alvo: `backend/models/Propriedade.js`, `backend/models/Tarefa.js`, `backend/controllers/smoobuController.js`.
- Lidos os testes existentes de `sincronizarPropriedades` em `backend/tests/integration.test.js` (secção 11b) e o `utils/geocoding.js` para perceber o impacto da alteração.
- **Alteração 1 — `models/Propriedade.js`:** adicionado `funcionario_preferencial_id` (ObjectId `ref: 'Utilizador'`, default `null`, indexado) com comentário a explicar que a lógica de prioridade no load balancer será ativada num prompt seguinte (preparação Fase 1.5).
- **Alteração 2 — `models/Tarefa.js`:** adicionado o objeto `detalhes_reserva` com sub-campos `checkin` (String), `checkout` (String), `pax` (Number, min 0), `nome_hospede` (String, trim). Comentário a explicar que o preenchimento via webhook/sincronização será feito num prompt seguinte.
- **Alteração 3 — `controllers/smoobuController.js` (`sincronizarPropriedades`):** no ramo "já existe", removida a guarda que só atualizava a morada quando estava `'A definir'`. Agora, para propriedades existentes, atualiza **SEMPRE** a `morada` (quando o Smoobu traz uma morada real, i.e. `moradaTexto !== 'A definir'`) e a `capacidade_hospedes` (quando o Smoobu traz um valor), refazendo o geocoding da morada nova e guardando com `await existente.save()`. Os restantes campos (nome, tempo_limpeza_minutos, ativo, checklist, funcionario_preferencial_id) continuam preservados. JSDoc da função reescrito para refletir o novo comportamento.
- **Testes:** o teste "preserva edições manuais" foi renomeado para "preserva nome/tempo/ativo quando o Smoobu não traz morada/capacidade no payload" (continua a passar — o mock não traz location/rooms) e adicionada a asserção `atualizadas === 0`. Adicionado novo teste "Prompt 92 — força update de morada + capacidade em propriedade existente" que cria uma propriedade com morada/capacidade antigas + edits manuais, sincroniza com um payload que traz morada nova + capacidade nova, e verifica que morada/capacidade foram sobrescritas mas nome/tempo/ativo foram preservados.
- **Documentação atualizada:** `docs/BACKEND.md` (tabelas dos modelos Propriedade e Tarefa repostas com todos os campos atuais + novos; secção 6.9 `sincronizar-propriedades` reescrita com o novo comportamento + nota a distinguir do `importarPropriedades`; entrada "Prompt 92" adicionada à tabela de histórico da secção 9), `README.md` (linha do endpoint `sincronizar-propriedades` atualizada).
- **Validação:** `npm test` no backend → **104/104 ✓** (15.0s), incluindo o novo teste e todos os anteriores. (O `sincronizarPropriedades` mocka `global.fetch`, pelo que o geocoding é tratado graciosamente — `obterCoordenadas` recebe um JSON não-array e devolve `null` sem afetar o teste.)

Stage Summary:
- 3 alterações de código entregues conforme o pedido do Prompt 92 (Fase 1.5).
- Campos novos (`funcionario_preferencial_id`, `detalhes_reserva`) ficam no schema mas **ainda não são populados/usados** pela lógica de negócio — ficam preparados para prompts seguintes (prioridade no load balancer + preenchimento de detalhes da reserva a partir do webhook/sincronização).
- `sincronizarPropriedades` passou de "preservar tudo" para "fonte de verdade = Smoobu para morada + capacidade_hospedes". Isto é mais agressivo que o `importarPropriedades` (que mantém o comportamento conservador de só preencher moradas `'A definir'`) — diferença documentada no BACKEND.md.
- Documentação (`README.md` + `docs/BACKEND.md` + `WORKLOG.md`) atualizada. Próximo passo: commit + push para a branch `dev`.

---

Task ID: A2 (Prompt 93)
Agent: Z.ai Code
Task: Injetar detalhes_reserva no webhook + Algoritmo VIP (funcionário preferencial) no motor de atribuição.

Work Log:
- Lido o worklog (Tasks A0 + A1) e o `backend/controllers/webhookController.js` por completo (extrairDadosReserva, determinarUtilizadorAtribuido, criarTarefaPorReserva, atualizarTarefaPorReserva, webhookSmoobu).
- Lidos os testes do webhook em `backend/tests/integration.test.js` (secção 5) e o uso partilhado do load balancer em `tarefaController.autoAtribuirTarefas`.
- **Alteração 1 — `extrairDadosReserva`:** passa a extrair `detalhesReserva` ({ checkin, checkout, pax, nome_hospede }) do payload do Smoobu, cobrindo variantes: `arrival`/`departure` (webhook) e `start_date`/`end_date` (REST); `guests`/`numPeople`/`numberOfGuests`/`pax`/`adults+children` para pax; `guestName`/`guest_name`/`guest.name`/`firstName+lastName`/`name` para nome_hospede. `pax` normalizado a Number (null se inválido); `nome_hospede` com trim + slice(0,200).
- **Alteração 2 — `processarReservaSmoobu`:** propaga `detalhesReserva` para `criarTarefaPorReserva` e `atualizarTarefaPorReserva` (novas assinaturas).
- **Alteração 3 — `criarTarefaPorReserva`:** guarda `detalhes_reserva` no `Tarefa.create`; ao re-activar tarefa cancelada (reserva re-criada), atualiza também os detalhes.
- **Alteração 4 — `atualizarTarefaPorReserva`:** atualiza `detalhes_reserva` no update (reserva editada pode ter novos dados de hóspede/datas).
- **Alteração 5 — Algoritmo VIP em `determinarUtilizadorAtribuido`:** novo parâmetro opcional `propriedadeId`. Antes do load balancer geral, se a propriedade tiver `funcionario_preferencial_id` e esse staff estiver no conjunto de `disponiveis` (passou filtros de ausência aprovada + folga fixa), valida o SLA de 8h/dia via novo helper `calcularCargaLimpezaDia` (`cargaLimpeza + tempoNovaTarefa ≤ CAPACIDADE_MAXIMA_MINUTOS`). Se OK → atribui obrigatoriamente ao VIP (log `⭐`). Se o VIP não puder (indisponível ou excede SLA) → fallback para o load balancer geral (Haversine + menor carga), com log explicativo.
- **Alteração 6 — `criarTarefaPorReserva`:** passa `propriedade._id` ao `determinarUtilizadorAtribuido` para ativar o VIP.
- **Alteração 7 — `tarefaController.autoAtribuirTarefas`:** passa `tarefa.propriedade_id._id` ao load balancer partilhado, para o VIP também aplicar às tarefas órfãs (auto-atribuição em lote).
- **Testes:** adicionados 4 novos testes ao describe do webhook: (1) guarda detalhes_reserva (checkin/checkout/pax/nome_hospede); (2) VIP atribui ao preferencial quando disponível; (3) VIP fallback se o preferencial exceder o SLA de 8h (cria tarefa de 450 min + nova de 60 = 510 > 480); (4) VIP fallback se o preferencial tiver folga fixa no dia. As asserções de fallback verificam `not.toBe(preferencial._id)` (o load balancer geral pode escolher qualquer outro staff disponível, não necessariamente o criado no teste).
- **Validação:** `npm test` no backend → **108/108 ✓** (14.7s), incluindo os 4 novos testes.
- **Documentação atualizada:** `docs/BACKEND.md` (secção 3.2 reescrita com o fluxo atualizado de 9 passos incluindo o VIP + detalhes_reserva; entrada "Prompt 93" no histórico), `README.md` (linha do webhook atualizada).

Stage Summary:
- Detalhes da reserva (checkin, checkout, pax, nome_hospede) passam a ser extraídos do payload do Smoobu e guardados no campo `detalhes_reserva` da Tarefa, tanto na criação como no update e na re-activação.
- Algoritmo VIP ativo: o `funcionario_preferencial_id` da Propriedade (adicionado no Prompt 92) é agora respeitado pelo motor de atribuição. Se o preferencial estiver disponível e dentro do SLA de 8h/dia, a tarefa é-lhe atribuída obrigatoriamente; só há fallback para o load balancer geral se ele não puder.
- O VIP aplica-se tanto ao webhook (criação de tarefa por nova reserva) como à auto-atribuição em lote de tarefas órfãs.
- 108 testes a passar (+4). Documentação atualizada. Próximo passo: commit + push para a branch `dev`.

---

Task ID: A3 (Prompt 94)
Agent: Z.ai Code
Task: Cron job "Agenda de Amanhã" — às 19:00 envia push ao staff com trabalho no dia seguinte.

Work Log:
- Lido o worklog (Tasks A0–A2), `backend/jobs/dailyBriefing.js` (padrão de cron job existente), `backend/utils/notificar.js` (`notificarUtilizador` fire-and-forget), `backend/server.js` (registo do dailyBriefing no arranque) e o final do ficheiro de testes.
- Confirmado que `node-cron` (^4.5.0) já é dependência — não foi preciso instalar.
- **Criado `backend/jobs/agendaAmanha.js`:**
  - `executarAgendaAmanha()` — calcula o intervalo do dia seguinte (meia-noite UTC) → procura `Tarefa` com `data` nesse intervalo e `estado ∈ { atribuida, por_atribuir }` → populate de `utilizador_id` (nome, ativo, eliminado_em) → agrupa por utilizador (só staff ativos não eliminados; `por_atribuir` sem utilizador não gera push) → para cada staff chama `notificarUtilizador(staffId, '📅 Agenda de Amanhã', 'Tens X tarefa(s) agendada(s). Entra na app para ver o itinerário', '/staff')` (singular/plural conforme o count). Devolve `{ processados, notificados, tarefas }`.
  - `iniciarAgendaAmanha()` — `cron.schedule('0 19 * * *', ..., { timezone: 'Europe/Lisbon' })`. Timezone estável (acomanha horário Verão/Inverno de PT mesmo em servidor UTC como o Render).
  - `notificarUtilizador` carregado via `require` lazy dentro da função (não no topo) para permitir `jest.spyOn` nos testes.
- **`backend/server.js`:** importado `iniciarAgendaAmanha` e chamado no arranque (dentro de `if (require.main === module)`, logo após `iniciarDailyBriefing()`, para não correr nos testes).
- **Testes (4 novos, secção 17 do `integration.test.js`):** spy em `notificarUtilizador` (mockResolvedValue) para validar chamadas sem depender do Web Push configurado. (1) notifica cada staff agrupado (staff1 com 2 → "2 tarefas agendadas"; staff2 com 1 → "1 tarefa agendada"; título + URL verificados); (2) ignora `por_atribuir` (sem utilizador), `concluida` e `cancelada` (só a atribuída conta); (3) sem tarefas amanhã → não notifica; (4) ignora staff inativo mesmo com tarefa atribuída.
- **Problema encontrado e resolvido:** os primeiros 2 testes falhavam porque o `agendaAmanha` importava `notificarUtilizador` no topo (referência fechada/closed-over) → o `jest.spyOn` no módulo não era usado. Solução: require lazy dentro de `executarAgendaAmanha` — o spy passa a interceptar corretamente. Comentário explicativo adicionado no topo do ficheiro.
- **Validação:** `npm test` no backend → **112/112 ✓** (14.7s), incluindo os 4 novos testes.
- **Documentação atualizada:** `docs/BACKEND.md` (nova secção 3.3 "Cron Jobs" com tabela dos 2 jobs + descrição detalhada do Agenda de Amanhã + nota sobre timezone; entrada "Prompt 94" no histórico).

Stage Summary:
- Novo cron job "Agenda de Amanhã" ativo: todos os dias às **19:00 (Europe/Lisbon)**, cada staff com trabalho no dia seguinte recebe uma push `📅 Agenda de Amanhã: Tens X tarefa(s) agendada(s). Entra na app para ver o itinerário`.
- Apenas dispara para staff ativos não eliminados com tarefas `atribuidas`. Tarefas `por_atribuir` (sem utilizador), `concluidas` e `canceladas` não contam.
- `notificarUtilizador` continua fire-and-forget (skip silencioso se não houver `pushSubscription` ou Web Push não configurado) — o staff sem subscrição ativa não gera erro.
- Timezone `Europe/Lisbon` nativo do node-cron → robusto em servidores UTC (Render).
- 112 testes a passar (+4). Documentação atualizada. Próximo passo: commit + push para a branch `dev`.

---

Task ID: A4 (Prompt 95)
Agent: Z.ai Code
Task: Ecrã de Férias/Ausências definitivo + Staff Preferencial nas Propriedades + Card de Detalhes da Reserva (gestor + staff).

Work Log:
- Lido o worklog (Tasks A0–A3) e os ficheiros: `gestor/ausencias/page.tsx` (era redirect), `admin-sidebar.tsx` (menu já tinha o link), `gestor/propriedades/page.tsx` (modal de edição), `staff/detalhe-tarefa-client.tsx`, `staff/tarefas/[id]/page.tsx`, `gestor/tarefas/page.tsx`, `lib/api.ts`, `gestorController.atualizarPropriedade`, `ausenciaController.listarAusencias`, `authController.minhaTarefaDetalhe`.
- **Backend — `atualizarPropriedade` (gestorController.js):** passa a aceitar `funcionario_preferencial_id` no body. Aceita `null`/string vazia (remove) ou ObjectId; valida que é staff ativo (`role: 'staff'`, `ativo: true`, `eliminado_em: null`) da mesma empresa (400 caso contrário). Mensagem de "nenhum campo" atualizada. `npm test` → 112/112 ✓ (sem regressões).
- **Frontend `lib/api.ts`:** `PropriedadeDTO` + `funcionario_preferencial_id`; `TarefaMock` + `detalhes_reserva`; novo tipo `DetalhesReservaDTO`.
- **(1) Ecrã Ausências (`gestor/ausencias/page.tsx`):** substituído o redirect por uma **tabela definitiva** com TODAS as ausências (sem filtros): colunas Funcionário, Tipo (ícone Plane/Stethoscope/CalendarX/CircleDot), Período (formatado pt-PT), Estado (Badge: pendente/amarela, pendente_emergencia/vermelha, aprovada/verde, rejeitada/cinza), Notas (line-clamp-2), Ações (botão Trash → modal de confirmação → `DELETE /api/gestor/ausencias/:id` com otimismo). O menu lateral já apontava para `/gestor/ausencias` (mantido). Estados: loading, erro, vazio.
- **(2) Propriedades — Staff Preferencial (`gestor/propriedades/page.tsx`):** modal de Editar ganhou um **select de Funcionário Preferencial**. Lista staff ativo da empresa (carregado via `GET /api/gestor/equipa`, filtrado `role==='staff' && ativo`); opção "Nenhum (usar load balancer geral)" com value="" → null. `editForm` + `abrirEdicao` + `handleEditar` atualizados; grava via `PUT /api/gestor/propriedades/:id` com `funcionario_preferencial_id` (string vazia → null).
- **(3) Detalhes da Reserva — componente partilhado `components/detalhes-reserva-card.tsx`:** Card de destaque (border primary, bg primary/5) com 4 células: Check-in (LogIn verde), Check-out (LogOut vermelho), Hóspedes/pax (Users), Nome do Hóspede (User). Datas formatadas pt-PT. Só renderiza se `detalhes_reserva` existir e tiver pelo menos um campo (devolve `null` caso contrário).
- **(3a) Staff:** `staff/tarefas/[id]/page.tsx` passa `detalhes_reserva` da tarefa real para o `DetalheTarefaClient`; o card é renderizado no topo do `<main>` (antes da checklist).
- **(3b) Gestor:** criado `components/gestor/detalhe-tarefa-modal.tsx` — modal completo com propriedade/tipo/estado, metadados (data/hora, tempo, morada, staff), o `DetalhesReservaCard`, observações do gestor, observações do staff e avarias reportadas. Integrado na `gestor/tarefas/page.tsx`: novo botão Eye (Ver detalhe) na coluna de Ações de cada tarefa + estado `detalheTarefa`. Interface `TarefaAdmin` alargada com `observacoes_staff` e `detalhes_reserva`.
- **Erros de TypeScript corrigidos:** (a) `AusenciaAmp extends Omit<AusenciaDTO, "tipo">` (o `tipo` amplo `ferias|doenca|folga|outro` não é compatível com o `TipoAusencia` estrito do api.ts); (b) typo `a.tipo` → `aEliminar.tipo` no modal de confirmação.
- **Validação:** `npm run lint` ✓ No ESLint warnings or errors · `npx tsc --noEmit` ✓ sem erros · `npm run build` ✓ todas as rotas compilaram (`/gestor/ausencias` 4.91 kB, `/gestor/propriedades` 7 kB, `/gestor/tarefas` 8.14 kB, `/staff/tarefas/[id]` 4.7 kB).
- **Documentação atualizada:** `docs/FRONTEND.md` (entrada "Prompt 95" no histórico), `docs/BACKEND.md` (entrada "Prompt 95" no histórico — `atualizarPropriedade` aceita `funcionario_preferencial_id`).

Stage Summary:
- **Ecrã de Ausências definitivo** ativo: `/gestor/ausencias` mostra TODAS as ausências da empresa em tabela, com eliminação direta (modal de confirmação + otimismo). O menu lateral já apontava para lá.
- **Staff Preferencial configurável**: o gestor pode, no modal de Editar Propriedade, escolher o funcionário preferencial (Algoritmo VIP do Prompt 93). O backend valida que é staff ativo da empresa.
- **Card de Detalhes da Reserva** visível para gestor (no novo modal de detalhe de tarefa, aberto via botão Eye na tabela de tarefas) e para staff (no topo do ecrã de detalhe da tarefa no mobile). Mostra check-in, check-out, hóspedes (pax) e nome do hóspede quando existirem.
- Lint + tsc + build ✓. 112 testes backend ✓. Documentação atualizada. Próximo passo: commit + push para a branch `dev`.

---

Task ID: A5 (Prompt 96)
Agent: Z.ai Code
Task: Cron job "Cão de Guarda" — às 18:00 lembra o staff das tarefas de limpeza de hoje ainda não concluídas.

Work Log:
- Lido o worklog (Tasks A0–A4) e `backend/jobs/agendaAmanha.js` (padrão de cron job com require lazy + timezone Europe/Lisbon).
- **Criado `backend/jobs/caoGuarda.js`:**
  - `executarCaoGuarda()` — calcula o intervalo do dia ATUAL (meia-noite UTC) → procura `Tarefa` com `tipo: 'limpeza'`, `utilizador_id ≠ null`, `estado ∈ { atribuida, em_curso }` (atribuídas mas não concluídas) → populate de `propriedade_id` (nome) + `utilizador_id` (ativo, eliminado_em) → para cada tarefa esquecida chama `notificarUtilizador(staffId, '⚠️ Tarefa Incompleta', 'Ainda não marcaste a limpeza da [nome da propriedade] como concluída. Por favor, atualiza a app!', '/staff')` (fire-and-forget). Ignora staff inativo/eliminado. Devolve `{ encontradas, notificadas }`.
  - `iniciarCaoGuarda()` — `cron.schedule('0 18 * * *', ..., { timezone: 'Europe/Lisbon' })`.
  - `notificarUtilizador` via require lazy (permite `jest.spyOn` nos testes, mesmo padrão do `agendaAmanha`).
  - **Nota sobre estados:** o modelo `Tarefa` tem `['por_atribuir','atribuida','em_curso','concluida','cancelada']` — não existe `'pendente'`. O prompt pede 'pendente' ou 'em_curso'; `'atribuida'` é o equivalente (atribuída mas ainda não iniciada). Comentário explicativo no ficheiro.
  - **Uma push por tarefa:** ao contrário do `Agenda de Amanhã` (agrupa por staff), o Cão de Guarda envia uma push POR TAREFA esquecida (a mensagem inclui o nome da propriedade, pelo que cada push é específica). Documentado.
- **`backend/server.js`:** importado `iniciarCaoGuarda` e chamado no arranque (dentro de `if (require.main === module)`, logo após `iniciarAgendaAmanha()`).
- **Testes (4 novos, secção 18 do `integration.test.js`):** spy em `notificarUtilizador`. (1) notifica por cada tarefa esquecida (staff1 com 1 atribuída + 1 em_curso → 2 pushes; staff2 com 1 → 1 push; total 3; verifica título/corpo com nome da propriedade/link); (2) ignora concluídas, canceladas, por_atribuir (sem utilizador) e manutencao (não é limpeza) — só 1 conta; (3) sem tarefas → não notifica; (4) ignora staff inativo mesmo com tarefa de limpeza atribuída (encontrada=1, notificadas=0).
- **Validação:** `npm test` no backend → **116/116 ✓** (15.6s), incluindo os 4 novos testes.
- **Documentação atualizada:** `docs/BACKEND.md` (secção 3.3 atualizada: tabela dos 3 jobs + nova subsecção "Cão de Guarda" com nota sobre estados + nota "uma push por tarefa"; entrada "Prompt 96" no histórico).

Stage Summary:
- Novo cron job "Cão de Guarda" ativo: todos os dias às **18:00 (Europe/Lisbon)**, cada tarefa de limpeza de HOJE ainda não concluída (estado `atribuida` ou `em_curso`) gera uma push `⚠️ Tarefa Incompleta — Ainda não marcaste a limpeza da [propriedade] como concluída. Por favor, atualiza a app!` à funcionária responsável.
- Filtro: `tipo: 'limpeza'` + `utilizador_id ≠ null` + `estado ∈ { atribuida, em_curso }` + data no dia atual. Ignora concluídas, canceladas, por_atribuir, outros tipos e staff inativo/eliminado.
- Uma push POR TAREFA (não agrupado por staff) — cada push menciona a propriedade específica.
- Horário do dia completo: 08h Daily Briefing → 18h Cão de Guarda → 19h Agenda de Amanhã.
- 116 testes a passar (+4). Documentação atualizada. Próximo passo: commit + push para a branch `dev`.

---

Task ID: A6 (Prompt 97)
Agent: Z.ai Code
Task: Desligar a reatribuição automática — ausências e desativação de propriedades passam a apenas desatribuir (sem load balancer).

Work Log:
- Lido o worklog (Tasks A0–A5) e os 4 sítios que reatribuíam via load balancer: `ausenciaController.aprovarRejeitarAusencia` (+ helper `redistribuirTarefasPeriodo`), `gestorController.reportarFaltaSubita`, `gestorController.registarBaixaProlongada`. Confirmado que `gestorController.alternarEstadoPropriedade` apagava as tarefas futuras (v1.35.0/Prompt 73). Confirmado que `staffController` cria ausências como 'pendente'/'pendente_emergencia' (não disparam reatribuição).
- **`ausenciaController.js`:**
  - `registarAusencia` (POST): passou a chamar o novo helper `desatribuirTarefasPeriodo` após criar a ausência aprovada (resposta inclui `desatribuicao: { total, desatribuidas }`).
  - `aprovarRejeitarAusencia` (PATCH): aprovar deixa de chamar o load balancer — usa `desatribuirTarefasPeriodo` (resposta `redistribuicao = { total, desatribuidas }`).
  - Novo helper `desatribuirTarefasPeriodo(utilizadorId, inicio, fim)`: procura tarefas `atribuida` no período e passa a `utilizador_id = null + estado = 'por_atribuir'`. Devolve `{ total, desatribuidas }`. **NÃO chama o load balancer.** Substitui o antigo `redistribuirTarefasPeriodo` (removido).
- **`gestorController.js`:**
  - `reportarFaltaSubita`: deixou de reatribuir via `determinarUtilizadorAtribuido`; agora desatribui cada tarefa de hoje do staff (`utilizador_id = null + estado = 'por_atribuir'`). Resposta `desatribuidas` (em vez de `reatribuidas/orfas`).
  - `registarBaixaProlongada`: mesma mudança — desatribui as tarefas do período em vez de reatribuir. Resposta `desatribuidas`.
  - `alternarEstadoPropriedade`: ao DESATIVAR, deixou de APAGAR tarefas futuras e passou a DESATRIBUIR (`updateMany` com `utilizador_id: null, estado: 'por_atribuir'`). Resposta `tarefasDesatribuidas` (em vez de `tarefasApagadas`).
- **Frontend `gestor/propriedades/page.tsx`:** `handleToggleAtivo` atualizado para ler `tarefasDesatribuidas` (em vez de `tarefasApagadas`) e mostrar feedback "desatribuída(s) (por atribuir)".
- **Testes:**
  - Atualizado o teste "admin aprova ausência" (secção 12) — agora verifica `redistribuicao.desatribuidas` + `utilizador_id === null` + `estado === 'por_atribuir'`.
  - Adicionados 3 novos testes (secção 19 "Prompt 97"): (1) desativar propriedade desatribui (não apaga — a tarefa continua a existir, `por_atribuir`); (2) falta súbita desatribui (não reatribui ao outro staff disponível); (3) baixa prolongada desatribui (não reatribui ao outro staff).
- **Validação:** `npm test` backend → **119/119 ✓** (15.2s). Frontend: `npm run lint` ✓ · `npx tsc --noEmit` ✓ · `npm run build` ✓.
- **Documentação atualizada:** `docs/BACKEND.md` (entrada "Prompt 97" no histórico).

Stage Summary:
- **Fim da reatribuição automática:** ausências (criar ou aprovar), falta súbita e baixa prolongada deixam de chamar o load balancer. As tarefas afetadas passam apenas a `utilizador_id = null` + `estado = 'por_atribuir'` — o recálculo fica a cargo do Gestor (manual, via "Auto-Atribuir Pendentes" do Prompt 86) ou do Fail-Safe noturno (futuro).
- **Desativação de propriedades:** deixou de apagar tarefas futuras (v1.35.0/Prompt 73) — agora desatribui (mantém as tarefas no calendário como `por_atribuir`, prontas para reatribuição manual).
- Isto evita disparos automáticos e spam de notificações push quando há mudanças de última hora (falta súbita, férias aprovadas, propriedade suspensa).
- O load balancer (`determinarUtilizadorAtribuido` + Algoritmo VIP) mantém-se ativo **apenas** no webhook (criação de tarefa por nova reserva) e na auto-atribuição manual em lote (`tarefaController.autoAtribuirTarefas`).
- 119 testes a passar (+3). Lint + tsc + build ✓. Documentação atualizada. Próximo passo: commit + push para a branch `dev`.

---

Task ID: A7 (Prompt 98)
Agent: Z.ai Code
Task: Rede de Segurança das 18h — auto-atribuição de emergência das tarefas órfãs de amanhã no cron job do Cão de Guarda (antes dos alertas).

Work Log:
- Lido o worklog (Tasks A0–A6), o `backend/jobs/caoGuarda.js` (Prompt 96 — alertas de tarefas incompletas) e o `backend/controllers/tarefaController.autoAtribuirTarefas` (padrão de uso do load balancer + scheduler + notificação para reatribuir órfãs).
- **Refactorização do `backend/jobs/caoGuarda.js` em duas fases:**
  - **FASE A — `autoAtribuicaoEmergencia()` (nova, Prompt 98):** calcula o intervalo do dia SEGUINTE (meia-noite UTC) → procura `Tarefa` com `estado: 'por_atribuir'` + `utilizador_id: null` (órfãs) → populate de `propriedade_id` (nome + coordenadas) → para cada tarefa, invoca `determinarUtilizadorAtribuido` (load balancer: Algoritmo VIP + Haversine + SLA 8h) passando `empresa_id`, `range`, `coordenadas`, `tempoNovaTarefa`, `propriedadeId` → se encontrar staff: recalcula hora via `calcularInicioTarefaUtilizador` (scheduler sequencial, best-effort), `Tarefa.updateOne` com `utilizador_id + estado 'atribuida' + nova data`, e envia push `🧹 Nova Limpeza Atribuída` (fire-and-forget) → se não houver staff: mantém `por_atribuir` (órfã). Devolve `{ encontradas, atribuidas, orfas }`.
  - **FASE B — `alertasTarefasIncompletas()` (Prompt 96, extraída para função própria):** inalterada — push `⚠️ Tarefa Incompleta` por cada tarefa de limpeza de hoje não concluída. Devolve `{ encontradas, notificadas }`.
  - **`executarCaoGuarda()`** agora corre **Fase A antes da Fase B** (o prompt é explícito: a auto-atribuição corre ANTES dos alertas) e devolve `{ failSafe, alertas }`.
  - `determinarUtilizadorAtribuido` e `notificarUtilizador` carregados via `require` lazy dentro das funções (permite `jest.spyOn` nos testes, mesmo padrão do `agendaAmanha`).
  - `module.exports` agora inclui `autoAtribuicaoEmergencia` e `alertasTarefasIncompletas` para testes isolados.
- **Testes:**
  - 4 testes existentes do Prompt 96 atualizados para `resultado.alertas.*` (a estrutura de retorno mudou de `{ encontradas, notificadas }` para `{ failSafe, alertas }`).
  - 4 novos testes (secção 20 "Prompt 98"): (1) atribui órfãs de amanhã via load balancer (verifica `atribuidas`, `estado 'atribuida'`, push `🧹 Nova Limpeza Atribuída` com nome da propriedade); (2) sem órfãs → não faz nada; (3) sem staff disponível (desativa todos os staff da empresa) → tarefa mantém-se `por_atribuir` (órfã); (4) não mexe em tarefas de hoje nem em já atribuídas de amanhã.
  - **Problema encontrado e resolvido:** o teste "sem staff disponível" falhava inicialmente porque staff de testes anteriores (e.g. `staff.webhook@teste.pt`) ficavam na `empresaId`. Solução: `Utilizador.updateMany({ empresa_id: empresaId, role: 'staff' }, { $set: { ativo: false } })` no início do teste para garantir que não há staff ativo.
- **Validação:** `npm test` backend → **123/123 ✓** (15.6s), incluindo os 4 novos testes e os 4 atualizados.
- **Documentação atualizada:** `docs/BACKEND.md` (secção 3.3 — Cão de Guarda agora descreve as 2 fases em detalhe com nota sobre o objetivo do Fail-Safe e a complementaridade com o Prompt 97; linha da tabela atualizada; entrada "Prompt 98" no histórico).

Stage Summary:
- **Fail-Safe ativo às 18:00:** o cron job do Cão de Guarda agora começa por **auto-atribuir** as tarefas órfãs de amanhã (`por_atribuir`) via load balancer (Algoritmo VIP + Haversine + SLA 8h + scheduler sequencial + push de notificação), e só **depois** envia os alertas de tarefas de hoje incompletas (Prompt 96).
- **Objetivo cumprido:** quando o relógio das 19:00 (Agenda de Amanhã, Prompt 94) correr uma hora depois, as escalas do dia seguinte já estão 100% preenchidas — os funcionários recebem a notificação com as atribuições completas.
- **Complementa o Prompt 97:** as tarefas desatribuídas por ausências (criar/aprovar), falta súbita, baixa prolongada e desativação de propriedades (que deixaram de ser reatribuídas automaticamente) são agora reatribuídas aqui de forma **centralizada e controlada**, uma única vez por dia, evitando disparos automáticos e spam de notificações durante o dia.
- O load balancer mantém-se ativo em 3 sítios: webhook (nova reserva), auto-atribuição manual em lote (gestor) e **Fail-Safe noturno (novo)**.
- 123 testes a passar (+4). Documentação atualizada. Próximo passo: commit + push para a branch `dev`.

---

Task ID: A8 (Ajuste — ocultar indisponíveis do dropdown)
Agent: Z.ai Code
Task: No modal de atribuição de tarefas, os staff indisponíveis (férias/doença/ausência) não devem aparecer na lista de seleção.

Work Log:
- Re-clonado o repositório (o `/home/z/Autocell` tinha sido removido) na branch `dev` (commit ff78b19, Prompt 98).
- Lido o modal "Atribuir Tarefa" em `frontend/src/app/gestor/tarefas/page.tsx` (linhas 818-855): o `<select>` mostrava TODOS os staff com `staff.map()`, marcando os indisponíveis como `<option disabled>` com label "— 🌴 Indisponível (Férias/Doença/Ausência)" e um aviso amarelo abaixo.
- Confirmado o mesmo padrão no modal de reatribuição do Calendário (`frontend/src/app/gestor/calendario/page.tsx` linhas 858-881) — mesmo comportamento com `equipa.map()`.
- **Alteração 1 — `/gestor/tarefas/page.tsx`:** o `<select>` agora faz `.filter((u) => !indisponiveis.some((i) => i.utilizador_id === u._id))` antes do `.map()`, pelo que os indisponíveis **não aparecem** na lista. Removida a lógica de `disabled`/label especial. Aviso amarelo atualizado: "foram omitidos da lista" (era "não podem receber tarefas").
- **Alteração 2 — `/gestor/calendario/page.tsx`:** mesma correção aplicada ao modal de reatribuição do calendário (`.filter()` antes do `.map()`, sem `disabled`, aviso atualizado).
- **Validação:** `npm run lint` ✓ · `npx tsc --noEmit` ✓ · `npm run build` ✓ (todas as rotas compilaram).
- **Documentação atualizada:** `docs/FRONTEND.md` (entrada "Ajuste" no histórico).

Stage Summary:
- Nos modais de atribuição/reatribuição (Tarefas e Calendário), a lista de staff só mostra quem está disponível nesse dia. Os indisponíveis (férias/doença/ausência aprovada) são omitidos do dropdown em vez de aparecem a cinzento/desativados.
- O aviso amarelo mantém-se, agora a informar quantos foram omitidos.
- Lint + tsc + build ✓. Documentação atualizada. Próximo passo: commit + push para a branch `dev`.

---

Task ID: A9 (Prompt 99)
Agent: Z.ai Code
Task: Ecrã de Relatório no Calendário — Toggle Vista Calendário/Tabela + botão Exportar Excel (xlsx).

Work Log:
- Lido o worklog (Tasks A0–A8) e a página `frontend/src/app/gestor/calendario/page.tsx` (estrutura, filtros, FullCalendar, modal de detalhe, interface `TarefaCalendario`).
- Confirmado que `xlsx` não estava instalado → `npm install xlsx` (^0.18.5) no `frontend/`.
- **Interface `TarefaCalendario`:** alargada com `detalhes_reserva?: { checkin, checkout, pax, nome_hospede } | null` (para a coluna Reserva).
- **Helpers da Vista Tabela** (junto aos helpers existentes): `ESTADO_LABEL_TAB`, `ESTADO_VARIANT_TAB` (mapeamento para variantes do Badge: por_atribuir=destructive, atribuida=default, em_curso=warning, concluida=success, cancelada=outline), `formatarDataDMY` (DD/MM/YYYY), `formatarDataHoraCurta` (DD/MM/YYYY ou DD/MM/YYYY HH:mm), `formatarReserva` (`In: [checkin] Out: [checkout] - [pax] pax`), `formatarHorario` (`HH:mm - HH:mm`).
- **Estado:** adicionado `vista: "calendario" | "tabela"` (default "calendario") + `exportando` (loading do botão).
- **`tarefasTabela`** (useMemo): filtra `tipo !== "ausencia" && tipo !== "folga_fixa"` (só tarefas reais) + ordena por data crescente.
- **`exportarExcel`** (useCallback): `await import("xlsx")` (import dinâmico para não entrar no bundle inicial) → `json_to_sheet` com colunas Data/Propriedade/Reserva/Funcionário/Horário/Estado → `!cols` com larguras estimadas → `book_new` + `book_append_sheet` ("Limpezas") → `writeFile(wb, "Relatorio_Limpezas.xlsx")`. Todos os campos como texto (datas DD/MM/YYYY). Estado `exportando` para feedback.
- **Cabeçalho:** adicionado o **Toggle de vistas** (botões "Vista Calendário" / "Vista Tabela" com `aria-pressed`, estilo segmented control) e o botão **Exportar Excel** (ícone Download, desativado se `tarefasTabela.length === 0`).
- **JSX:** FullCalendar envolvido em `{vista === "calendario" && (...)}`. Adicionada a **Vista Tabela** em `{vista === "tabela" && (...)}`: estados loading/vazio/tabela. A tabela tem 6 colunas (Data, Propriedade, Reserva, Funcionário, Horário, Estado com Badge), linhas clicáveis (abrem o modal de detalhe existente), e um rodapé com a contagem e o período.
- **Ícones:** importados `Table` e `Download` do lucide-react.
- **Removido um `</div>` extra** que ficou do wrapper original do FullCalendar após a refactorização.
- **Validação:** `npm run lint` ✓ No ESLint warnings or errors · `npx tsc --noEmit` ✓ sem erros · `npm run build` ✓ todas as rotas compilaram (`/gestor/calendario` 88.1 kB — o xlsx é importado dinamicamente, não entra no bundle inicial).
- **Documentação atualizada:** `docs/FRONTEND.md` (entrada "Prompt 99" no histórico).

Stage Summary:
- **Toggle de vistas** ativo no Calendário Operacional: o gestor alterna entre "Vista Calendário" (FullCalendar, comportamento original) e "Vista Tabela" (Data Table com as 6 colunas pedidas).
- **Vista Tabela:** Data (DD/MM/YYYY), Propriedade, Reserva (`In: [checkin] Out: [checkout] - [pax] pax` usando `detalhes_reserva`), Funcionário (nome ou "Por Atribuir" a amarelo), Horário (`HH:mm - HH:mm`), Estado (Badge colorido). Linhas clicáveis abrem o modal de detalhe. Respeita os filtros e o período do calendário.
- **Exportar Excel:** botão que gera `Relatorio_Limpezas.xlsx` com os dados visíveis na tabela, todos formatados como texto (datas DD/MM/YYYY). Usa `xlsx` (^0.18.5) importado dinamicamente.
- Lint + tsc + build ✓. Documentação atualizada. Próximo passo: commit + push para a branch `dev`.





