# Task 56 — Autocell: 5 Melhorias (push notifications, avarias, relatórios, gestor push, testes)

**Agent**: Z.ai Code (Full Stack Developer)
**Task ID**: 56
**Projeto**: Autocell (`/home/z/Autocell`)
**Stack**: Next.js 16 + TypeScript (frontend) · Node.js + Express + Mongoose (backend)

## Resumo

Foram implementadas 5 melhorias no projeto Autocell cobrindo notificações push em novos momentos do fluxo, visibilidade de avarias no painel do gestor, métricas de tempo real de limpeza nos relatórios, notificações push para o gestor e novos testes de integração.

## Melhorias entregues

### Melhoria 2 — Push notifications em mais momentos
- **`backend/controllers/tarefaController.js`** (`atribuirTarefa`): após (re)atribuir uma tarefa manualmente, carrega o nome da propriedade e envia push ao novo utilizador com o helper `notificarUtilizador`:
  `notificarUtilizador(String(tarefa.utilizador_id), '🔄 Tarefa reatribuída', \`${propriedade?.nome ?? 'Propriedade'} — ${dataFmt}\`, '/staff')`.
  Fire-and-forget; só dispara quando `utilizador_id` vem no body (não quando se remove atribuição).
- **`backend/jobs/dailyBriefing.js`** (`executarBriefing`): para cada staff com tarefas no dia, para além do WhatsApp (mock), chama `notificarUtilizador(staffId, '📋 Daily Briefing', \`Tens ${count} tarefa(s) hoje.\`, '/staff')`. O `notificarUtilizador` valida internamente se há `pushSubscription` ativa (skip silencioso caso contrário). Log final inclui contador `pushesEnviados`.

### Melhoria 3 — Mostrar avarias no painel do gestor
- **`frontend/src/app/gestor/tarefas/page.tsx`**:
  - `interface TarefaAdmin` recebeu `avarias?: string[]`.
  - Adicionado botão toggle **"Só avarias"** (`Wrench` icon) no cabeçalho que filtra client-side as tarefas com `avarias.length > 0`. Quando ativo, fica `variant="destructive"` e mostra um indicador de filtro ativo com botão "Limpar filtro".
  - Na coluna Propriedade, quando a tarefa tem avarias, mostra um `Badge variant="destructive"` pequeno com o ícone `Wrench` + texto "Avaria" ao lado do nome. `title` indica o número de avarias.
  - Estados de vazio diferenciados: "Sem tarefas com avarias reportadas." vs "Sem tarefas.".
  - Paginação e contagem passaram a usar `tarefasFiltradas` em vez de `tarefas`.

### Melhoria 4 — Tempo real de limpeza nos relatórios
- **`backend/controllers/relatorioController.js`** (`getRelatorioProdutividade`):
  - Adicionada uma 7ª agregação em paralelo: média de `(hora_conclusao - data) / 60000` (minutos) das tarefas concluídas com `hora_conclusao` do tipo Date. Filtro `$type: 'date'` garante que valores null/inválidos são ignorados.
  - `resumo` passou a incluir `tempoEstimadoMedioMinutos` (alias de `tempoMedioMinutos`) e `tempoRealMedioMinutos`. `tempoMedioMinutos` mantido para retrocompatibilidade.
- **`frontend/src/app/gestor/relatorios/page.tsx`**:
  - `RelatorioData.resumo` estendido com os 2 campos novos (opcionais).
  - Cartões de resumo expandidos de 5 para 7 (`xl:grid-cols-7`):
    1. Total tarefas · 2. Concluídas · 3. Em atraso · 4. Carga total · 5. **Tempo médio estimado** · 6. **Tempo real médio** · 7. **Diferença (real − estimado)**.
  - O cartão da diferença usa cor **verde** (`CORES.verde`) e ícone `CheckCircle2` se `real ≤ estimado` (mais rápido) e **vermelho** (`CORES.vermelho`) com `AlertTriangle` se `real > estimado` (mais lento). Quando não há dados reais, mostra "—" em muted com "Sem dados".
  - Label dinâmico do sub-texto: "Xh mais rápido" / "Xh mais lento" / "Sem dados".

### Melhoria 5 — Notificações push para o gestor
- **`frontend/src/components/gestor/push-notification-setup.tsx`** (novo): re-exporta o componente partilhado de `staff/` para manter imports limpos no painel do gestor sem duplicar código. O componente é genérico (usa `/api/auth/me/push-subscribe` que guarda no `req.user.id`).
- **`frontend/src/app/gestor/page.tsx`**: adicionado `<PushNotificationSetup />` no topo do dashboard, logo abaixo do cabeçalho e antes do banner de emergência. Aparece só se o browser suportar Push, a chave VAPID estiver configurada e a permissão ainda estiver em `default`.
- **`backend/controllers/staffController.js`** (`faltaHoje`): depois de criar a ausência `pendente_emergencia`, carrega o nome do staff (`Utilizador.findById(utilizadorId).select('nome')`) e procura todos os gestores/admins ativos da mesma empresa com `pushSubscription` != null. Para cada um, chama `notificarUtilizador(gestorId, '🚨 Falta de emergência', \`${nomeStaff} reportou falta para hoje.\`, '/gestor/aprovacoes')`. Fire-and-forget (try/catch à volta).

### Melhoria 6 — Mais testes (`backend/tests/integration.test.js`)
Adicionados 7 novos testes (total agora: 103, todos a passar):

1. **`GET /api/gestor/calendario/dados` com `estado=cancelada`** — novo `it()` no describe block existente (secção 5b). Verifica que só devolve tarefas canceladas.
2. **`POST /api/gestor/smoobu/sincronizar-propriedades` com erro 502** — novo `it()` no describe block existente (secção 11). Mocka `fetch` para devolver `{ ok: false, status: 502 }` e verifica resposta 502 + mensagem de erro a fazer match `/502/` + confirma que nenhuma propriedade foi criada.
3. **`POST /api/staff/tarefas/:id/avaria` — novo describe block (secção 16)** com 5 casos:
   - sem token → 401
   - sem descrição → 400
   - staff reporta avaria → 200 + cria tarefa de manutenção (`tipo='manutencao'`, `estado='por_atribuir'`, `utilizador_id=null`, mesma propriedade). Verifica também que `tarefa.avarias` ganhou a entrada e que o contador de tarefas de manutenção subiu +1 na BD.
   - staff reporta avaria em tarefa de outro utilizador → 404
   - staff reporta avaria em tarefa cancelada → 400

## Correção adicional
- **`backend/server.js`**: o rate limiter global (100 req/15min/IP) estava a fazer os últimos testes falharem com 429 (os testes fazem >100 pedidos seguidos desde o mesmo IP). Adicionado `max: process.env.NODE_ENV === 'test' ? Infinity : 100` para desativar o limite em ambiente de teste. Jest auto-seta `NODE_ENV=test`.

## Validação
- **Backend `npm test`**: 103/103 ✓ (12.15s) — incluindo os 7 novos testes.
- **Frontend `npm run lint`**: ✓ "No ESLint warnings or errors".

## Ficheiros modificados
- `backend/controllers/tarefaController.js` (+ helper `notificarUtilizador` em `atribuirTarefa`)
- `backend/controllers/staffController.js` (+ push a gestores em `faltaHoje`)
- `backend/controllers/relatorioController.js` (+ `tempoRealMedioMinutos` + `tempoEstimadoMedioMinutos` em `getRelatorioProdutividade`)
- `backend/jobs/dailyBriefing.js` (+ push em `executarBriefing`)
- `backend/server.js` (rate limiter desativado em teste)
- `backend/tests/integration.test.js` (+7 testes)
- `frontend/src/app/gestor/page.tsx` (+ `<PushNotificationSetup />`)
- `frontend/src/app/gestor/tarefas/page.tsx` (filtro avarias + badge + `avarias?: string[]`)
- `frontend/src/app/gestor/relatorios/page.tsx` (+2 cartões: tempo real + diferença)
- `frontend/src/components/gestor/push-notification-setup.tsx` (novo — re-export do partilhado)
