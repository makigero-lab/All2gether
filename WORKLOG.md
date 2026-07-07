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




