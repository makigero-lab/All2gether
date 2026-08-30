# Documentação Técnica — Backend (All2gether)

> **Nota de rebranding.** O projeto foi consolidado como **All2gether** — sistema de gestão de tarefas para **Alojamento Local e Airbnb**. A integração Smoobu (conversão de reservas em tarefas) foi removida em F0, **re-introduzida como recetor/logger em HF3**, e **completamente reativada em HF4** (recuperação da lógica de conversão via arqueologia Git + adaptação ao schema atual). Os modelos `Tarefa` (limpeza/manutenção) e `Propriedade` (alojamento) são o núcleo do domínio.

API REST do sistema All2gether de gestão de Alojamento Local e Tarefas, construída com **Node.js**, **Express** e **MongoDB** (via **Mongoose**).

---

## 1. Stack tecnológica

| Camada            | Tecnologia      | Função                                                         |
|-------------------|-----------------|----------------------------------------------------------------|
| Runtime           | Node.js ≥ 18    | Execução do servidor JavaScript                                |
| Framework Web     | Express 4       | Definição de rotas e middlewares HTTP                          |
| ODM de Base Dados | Mongoose 8      | Modelação e ligação ao MongoDB                                 |
| Variáveis de env. | dotenv          | Carregamento de configuração a partir de `.env`                |
| CORS              | cors            | Permissão de pedidos cross-origin (Vercel → Render)            |
| Dev tooling       | nodemon         | Reinício automático do servidor durante o desenvolvimento      |

---

## 2. Estrutura de ficheiros

```
backend/
├── package.json              # Dependências e scripts (npm start → node server.js)
├── server.js                 # Ponto de entrada: middlewares, rotas, ligação à BD
├── .env.example              # Modelo das variáveis de ambiente (a copiar para .env)
├── .gitignore                # Ignora node_modules, .env, logs, etc.
├── controllers/
│   ├── adminController.js    # Painel de Administração + setup Cliente Zero
│   └── authController.js     # Autenticação: login (JWT) + /me
├── middleware/
│   └── auth.js               # Verifica JWT (strito), injeta req.user — sem fallback legacy
├── models/                   # Modelos Mongoose (ODM do MongoDB)
│   ├── Empresa.js            #   Entidade principal (multi-tenant)
│   ├── Propriedade.js        #   Alojamento (apartamento/unidade)
│   ├── Utilizador.js         #   Admin / Gestor / Staff de uma empresa (email + password_hash)
│   ├── Ausencia.js           #   Indisponibilidade de Staff num dia
│   └── Tarefa.js             #   Tarefa (limpeza/manutenção)
└── routes/
    ├── adminRoutes.js        # GET/POST /api/admin/propriedades, GET /api/admin/setup
    └── authRoutes.js         # POST /api/auth/login, GET /api/auth/me
```

---

## 3. Arquitetura e lógica de arranque (`server.js`)

O fluxo de arranque segue uma sequência segura:

1. **Carregamento de configuração** — `require('dotenv').config()` lê o `.env` e expõe as variáveis em `process.env`.
2. **Instanciação da app Express** — cria a aplicação e define a porta (`process.env.PORT || 5000`).
3. **Middlewares:**
   - `cors()` — habilita respostas a pedidos vindos de outras origens (essencial para o frontend na Vercel comunicar com a API no Render).
   - `express.json()` — faz parse do corpo dos pedidos em JSON, disponibilizando-os em `req.body`.
4. **Rotas** — `GET /` (healthcheck), montagem de `/webhooks` e `/api/admin` (ver secção 6).
5. **Ligação ao MongoDB** — `mongoose.connect(process.env.MONGODB_URI)`.
   - Em **caso de sucesso**: regista mensagem e **só depois** arranca o servidor HTTP com `app.listen(PORT)`. Isto garante que a API só recebe tráfego quando a base de dados está acessível.
   - Em **caso de erro**: regista o erro e termina o processo (`process.exit(1)`), evitando arrancar um servidor sem acesso à BD.

### Regra de processo importante
> O servidor HTTP **só arranca depois de a ligação ao MongoDB ser estabelecida**. Se a BD estiver indisponível, a aplicação termina imediatamente em vez de arrancar num estado inconsistente.

---

## 3.1. Modelos de dados (Mongoose)

O sistema gira em torno de 5 coleções. Todas usam `timestamps: true` (createdAt/updatedAt).

### `Empresa`
Entidade principal do SaaS (multi-tenant). Cada empresa agrupa Propriedades e Utilizadores.

| Campo  | Tipo    | Notas                                              |
|--------|---------|----------------------------------------------------|
| `nome` | String  | Obrigatório, trim, indexado.                       |
| `nif`  | String  | Opcional, trim.                                    |

> DCE-B: o campo `plano_ativo` (booleano informativo SaaS sem enforcement) foi removido — a gestão de Planos SaaS passou para a Nave-Mãe. O controlo operacional efetivo é o campo `ativa`.

### `Propriedade`
Representa um apartamento ou unidade de alojamento gerida pela empresa.

| Campo                        | Tipo     | Notas                                                              |
|------------------------------|----------|--------------------------------------------------------------------|
| `nome`                       | String   | Obrigatório, trim.                                                 |
| `morada`                     | String   | `required: false` (default `''`), trim. Morada em string única (legado). Geocoding automático ao criar/editar. Retrocompatível com `morada_estruturada`. |
| `morada_estruturada`         | Object   | **HF23 (NOVO)** — sub-documento `{ rua: String, codigo_postal: String, cidade: String }` (todos com default `''`, trim). Morada decomposta para UX e geocoding mais preciso. O virtual `moradaCompleta` concatena os 3 campos OU faz fallback para `morada` (legado) se `rua` estiver vazia. |
| `coordenadas`                | Object   | `{ lat: Number, lng: Number }`. Preenchidas via geocoding (default null). Prioridade: Google Maps API (se `GOOGLE_MAPS_API_KEY`) → Nominatim (fallback). |
| `empresa_id`                 | ObjectId | `ref: 'Empresa'`. Obrigatório, indexado.                           |
| `tempo_limpeza_minutos`      | Number   | Default `45`, `min: 0`. Duração estimada da tarefa de limpeza.     |
| `ativo`                      | Boolean  | Default `true`.                                                    |
| `checklist`                  | [String] | Default `[]`. Itens de verificação definidos pelo gestor (v1.34.0).|
| `modelo_checklist_id`        | ObjectId | `ref: 'ModeloChecklist'`, default `null`, indexado (Prompt 133). Template dinâmico cujas secções/items são copiados para `checklist_dinamica` da Tarefa (snapshot). |
| `capacidade_hospedes`        | Number   | Default `null`, `min: 0`. Capacidade máxima de hóspedes (v1.61.0 / Prompt 84).|
| `funcionario_preferencial_id`| ObjectId | `ref: 'Utilizador'`, default `null`, indexado. **Prompt 92 (Fase 1.5)** — funcionário preferencial da propriedade; HF11 (sistema híbrido Many-to-One + Load Balancer): o webhook tenta atribuir ao preferencial primeiro; se estiver de folga ou a propriedade não tiver preferencial, faz fallback para o load balancer. |
| `origem`                     | String   | `enum: ['smoobu','manual']`, default `'manual'`, indexado. **HF17** — origem da propriedade (Smoobu via webhook/importação vs manual criada pelo gestor/parceiro). |
| `smoobu_id`                  | String   | Default `null`, trim, sparse index. **HF4** — ID do apartamento Smoobu (match no webhook). Opcional (propriedades manuais ficam `null`). |
| `parceiro_id`                | ObjectId | `ref: 'Utilizador'`, default `null`, indexado. **HF17 / HF25 (relacional)** — associa a propriedade a um parceiro B2B. Populado pelo `getPropriedades` com `nome`/`email`/`role` (substitui a lógica legacy de extrair "Parceiro Associado: [nome]" das `observacoes`). |
| `observacoes`                | String   | Default `''`, trim. **Prompt 125** — notas livres internas do gestor. A lógica legacy de "Parceiro Associado: [nome]" foi substituída pelo campo relacional `parceiro_id`. Editável via `PUT /api/gestor/propriedades/:id`. |
| `staff_necessario`           | Number   | Default `1`, `min: 1`. **HF21** — nº de staff necessário para limpar a propriedade. Se > 1, o load balancer atribui uma equipa (Top N) em vez de 1 pessoa. |
| `dias_fixos_limpeza`         | [Number] | Default `[]`. **HF22** — dias fixos de limpeza semanal (0=Dom, 1=Seg, …, 6=Sáb — standard JS `getDay()`); validação de inteiros 0–6. O cron job `geradorRotinas` cria tarefa automática quando o dia de amanhã está neste array. |
| `nome_responsavel`           | String   | Default `''`, trim. **HF23** — nome do responsável pela propriedade (contacto operacional). |
| `contacto`                   | String   | Default `''`, trim. **HF23** — telefone/email do responsável. |
| `frequencia_limpeza`         | String   | `enum: ['semanal','quinzenal','mensal']`, default `'semanal'`. **HF23**. |
| `horario_limpeza`            | String   | Default `''`, trim. **HF23** — janela horária preferencial para limpeza. |

> **Virtual `moradaCompleta` (HF23):** devolve a morada completa como string — concatena `morada_estruturada.rua` (+ `codigo_postal` + `cidade` se preenchidos) OU faz fallback para `morada` (legado) se `rua` estiver vazia. Serializado em `toJSON`/`toObject` (`virtuals: true`). Usado pelo frontend para display e pelo geocoder para obter coordenadas.

### `Utilizador`
Admin, Gestor, Staff ou Parceiro de uma empresa. Credenciais de login (email + password_hash).

**Roles (hierarquia):**
- `admin` — dono da conta (gestão total: empresas, planos, utilizadores).
- `gestor` — responsável de limpezas (gere equipa de staff, vê dashboard alargado, pode executar limpezas).
- `staff` — executante de limpezas (vê apenas as suas tarefas no mobile).
- `parceiro` — **HF17** — utilizador externo B2B (parceiro de canal). As propriedades associadas usam o campo `Propriedade.parceiro_id`. A gestão de parceiros faz-se na rota dedicada `GET /api/gestor/parceiros`.

| Campo            | Tipo     | Notas                                                              |
|------------------|----------|--------------------------------------------------------------------|
| `nome`           | String   | Obrigatório, trim.                                                 |
| `email`          | String   | Obrigatório, lowercase, trim, **único** (indexado). Credencial de login. |
| `telefone`       | String   | Trim, default `''`. Formato internacional (ex.: `+351912345678`). Para Daily Briefing via WhatsApp. |
| `nif`            | String   | Default `''`, trim. **HF23 (NOVO)** — NIF do utilizador (particularmente para parceiros B2B / faturação). |
| `observacoes`    | String   | Default `''`, trim. **HF23 (NOVO)** — observações livres sobre o utilizador (notas internas do gestor — ex.: "Parceiro desde 2024", "Desconto 10%"). |
| `password_hash`  | String   | Hash bcrypt da password (nunca a password em claro). Opcional (utilizador migrado sem password → login recusa). |
| `empresa_id`     | ObjectId | `ref: 'Empresa'`. Obrigatório, indexado.                           |
| `role`           | String   | `enum: ['admin','gestor','staff','parceiro']` (HF17), default `'staff'`, obrigatório. |
| `responsavel_id` | ObjectId | `ref: 'Utilizador'`, default `null`. Superior hierárquico (admin/gestor). O admin não tem responsavel_id (topo da hierarquia). Indexado. |
| `ativo`          | Boolean  | Default `true`. Utilizador inativo é ignorado pelo webhook e pelo login. |
| `dias_folga`     | [Number] | Default `[]`. **v1.14.0** — folgas fixas semanais (0=Dom, …, 6=Sáb). O load balancer exclui staff cujo dia da semana da tarefa está neste array. |
| `folgas_rotativas` | [{ data, motivo }] | Default `[]`. **HF9** — datas específicas de folga além das fixas semanais. Verificado pelo `criarTarefaPorReserva` no dia do check-out. |
| `eliminado_em`   | Date     | Default `null`, indexado. **v1.13.0 (Soft delete)** — em vez de remover o utilizador (deixaria Tarefas órfãs), marca-se a data. Utilizadores eliminados são excluídos das queries normais. |
| `pushSubscription` | Mixed  | Default `null`. **v1.27.0** — subscrição Web Push API (endpoint + keys) gerada pelo browser via `PushManager.subscribe()`. |

> **Regras de segurança (v1.7.0):** não é possível criar/editar utilizadores com role `admin` via `/api/admin/equipa` (403). Não é possível editar/eliminar/desativar utilizadores que já sejam `admin` (403 "Não é possível modificar um administrador"). O `responsavel_id` tem de ser um admin/gestor da mesma empresa (validado no backend).
>
> **HF23 / HF25 (soft-delete com desatribuição):** ao inativar um `staff`/`gestor` via `PATCH /api/gestor/equipa/:id/estado`, o sistema chama `desatribuirTarefasPeriodo(utilizadorId, hoje, +1ano)` para desatribuir TODAS as tarefas futuras atribuídas (não as concluídas/canceladas). A resposta JSON inclui `tarefas_desatribuidas`. Parceiros não têm tarefas atribuídas, por isso não são afetados.

### `Ausencia`
Indisponibilidade (férias/folga) de um Staff num intervalo de datas. Todas as datas são **normalizadas para meia-noite UTC**.

| Campo           | Tipo     | Notas                                                              |
|-----------------|----------|--------------------------------------------------------------------|
| `utilizador_id` | ObjectId | `ref: 'Utilizador'`. Obrigatório, indexado.                        |
| `empresa_id`    | ObjectId | `ref: 'Empresa'`. Obrigatório, indexado.                           |
| `data_inicio`   | Date     | Obrigatório, indexado. Início do intervalo (inclusive, meia-noite UTC). |
| `data_fim`      | Date     | Obrigatório, indexado. Fim do intervalo (inclusive, meia-noite UTC). |
| `tipo`          | String   | `enum: ['ferias','folga']`, default `'folga'`. Obrigatório.        |
| `notas`         | String   | Opcional. Observações livres.                                      |
| `data`          | Date     | **Retrocompatibilidade** (v1.1.0). Preenchido automaticamente com `data_inicio` no `pre('save')`. Usado pelo webhook legacy. |
| `motivo`        | String   | **Legacy** (v1.1.0). Mantido para não partir registos antigos.    |

Índice único composto `{ utilizador_id, data_inicio }` → evita duplicar o mesmo início para o mesmo utilizador. A validação de **sobreposição de intervalos** é feita no controller (mensagem clara de 409).

> **v1.8.0:** o modelo passou de dia único (`data`) para intervalos (`data_inicio`/`data_fim`) com `tipo` e `notas`. O webhook foi atualizado para verificar sobreposição de intervalos (mantém a query `data` legacy para retrocompatibilidade).

### `Tarefa`
Tarefa (consulta/agendamento).

| Campo                   | Tipo     | Notas                                                              |
|-------------------------|----------|--------------------------------------------------------------------|
| `empresa_id`            | ObjectId | Obrigatório, indexado.                                             |
| `propriedade_id`        | ObjectId | `ref: 'Propriedade'`. Obrigatório, indexado.                       |
| `utilizador_id`         | ObjectId | `ref: 'Utilizador'`, **default `null`** → tarefa por atribuir.     |
| `data`                  | Date     | Dia da tarefa (meia-noite UTC). Obrigatório, indexado.             |
| `tempo_limpeza_minutos` | Number   | Obrigatório, default `45`, `min: 0`. Unidade de carga.             |
| `tipo`                  | String   | `enum: ['limpeza','check_in','check_out','manutencao','outro']`.   |
| `estado`                | String   | `enum: ['por_atribuir','atribuida','em_curso','concluida','cancelada']`. |
| `observacoes`           | String   | Observações gerais (gestor/admin). Default `''`.                   |
| `observacoes_staff`     | String   | Observações do staff ao concluir (v1.34.0). Default `''`.          |
| `concluida_em`          | Date     | Data de conclusão (relatórios). Default `null`.                    |
| `hora_conclusao`        | Date     | Timestamp preciso de conclusão (v1.34.0, auditoria). Default `null`. |
| `avarias`               | [String] | Avarias reportadas pelo staff (v1.38.0). Default `[]`.             |
| `checklist`             | [String] | Snapshot da checklist da propriedade na criação (v1.55.0 / Prompt 77). Default `[]`. |
| `detalhes_reserva`      | Object   | **Prompt 92 (Fase 1.5)** — snapshot dos detalhes da tarefa. Sub-campos: `checkin` (String), `checkout` (String), `pax` (Number), `nome_hospede` (String). |

> Nota: `empresa_id` é uma referência a `Empresa` (modelo criado na v1.2.0).

---

## 3.2. Lógica central — Atribuição de tarefas

> **F0 — A integração Smoobu foi removida.** O motor de atribuição (load balancer) foi extraído para `utils/loadBalancer.js`. A lógica de atribuição (Algoritmo VIP + Haversine + SLA 8h/dia) continua disponível para criação manual de tarefas e reatribuições.
>
> **HF3 — Recetor de webhooks Smoobu re-introduzido (apenas receção + log).** Endpoint `POST /api/smoobu/webhook` com auth `SMOOBU_API_KEY` + `WebhookLog` best-effort.
>
> **HF4 — Conversão de reservas em tarefas reativada (lógica completa).** A função `criarTarefaPorReserva` e lógica conexa (`processarReservaSmoobu`, `atualizarTarefaPorReserva`, `cancelarTarefaPorReserva`, `enriquecerReservaSmoobu`, `extrairDadosReserva`) foram **recuperadas do histórico Git** (commit pré-F0 `681f807`) e **adaptadas ao schema atual** no novo `backend/controllers/smoobuController.js`. Reutiliza `utils/loadBalancer.js` (em vez de lógica inline duplicada). Recria os campos `Propriedade.smoobu_id` e `Tarefa.smoobu_reserva_id` (removidos em F0, essenciais para match e idempotência). Padrão anti-timeout: resposta 200 imediata + processamento via `setImmediate`. Regras preservadas: tarefa no dia do **check-out** (departure); 1 tarefa por reserva (`tipo: 'limpeza'`); idempotência por `smoobu_reserva_id`; cancelamento soft delete; atualização revalida disponibilidade; 3 estados iniciais (`atribuida`/`nao_atribuida`/`por_atribuir`); snapshot de `checklist_dinamica`; notificação fire-and-forget.
>
> **FIX (folgas/férias) — Filtros de indisponibilidade do Load Balancer reforçados.** O `determinarUtilizadorAtribuido` (e a versão de equipas `determinarEquipaAtribuida`) agora filtram com mais rigor o staff indisponível:
> - **Folgas fixas semanais (`Utilizador.dias_folga`):** o dia da semana da tarefa (calculado a partir de `range.start`) é comparado contra o array `[0=Dom ... 6=Sáb]` de cada staff. Se o dia da tarefa estiver no array, o staff é excluído do pool.
> - **Ausências (`Ausencia`):** a query agora usa **interseção de intervalos** (`data_inicio < range.end AND data_fim >= range.start`) em vez da comparação pontual anterior (`data_inicio <= range.start AND data_fim >= range.start`), que falhava em casos edge (ex.: ausência a terminar no dia da tarefa com horário inferior a `range.start`). São consideradas ausências ATIVAS os estados `aprovada` (férias/doença confirmadas) e `pendente_emergencia` (falta súbita do próprio funcionário para o dia atual). Excluem-se `pendente` (pedido normal não confirmado), `rejeitada` e `cancelada`.
> - **Versão de equipas:** `determinarEquipaAtribuida` foi refactorizada para passar um `Set<string>` de IDs já escolhidos (`excluirStaffIds`) a cada iteração de `determinarUtilizadorAtribuido`, em vez do hack anterior de `break` quando o LB devolvia o mesmo staff. Isto garante que a versão de equipas herda automaticamente o mesmo rigor de filtragem (folgas + férias + exclusão explícita) e nunca repete o mesmo staff.
>
> **HF24 — Reatribuição automática inteligente (commit f18545d).** Nova função `reatribuirTarefasPeriodo(empresaId, utilizadorId, inicio, fim)` em `ausenciaController.js` que, **após** desatribuir as tarefas do funcionário ausente (`desatribuirTarefasPeriodo`), executa o load balancer para cada tarefa `por_atribuir` do período, tentando alocá-la a outro staff **ATIVO**, **DISPONÍVEL** (sem folga fixa nem ausência aprovada/pendente_emergencia) e com **menor carga**.
> - **Exclusão do utilizador ausente:** o pool do LB recebe `excluirStaffIds = new Set([String(utilizadorId)])`, garantindo que o funcionário ausente nunca é re-escolhido.
> - **Se encontrar staff elegível** → reatribui (`utilizador_id` + `estado: 'atribuida'`) e recalcula a hora de início via scheduler sequencial (`calcularInicioTarefaUtilizador`); atualiza também `tempo_viagem_minutos`.
> - **Se não encontrar staff** → mantém `estado: 'por_atribuir'` (órfã) para ser reaproveitada pelo Fail-Safe do Cão de Guarda às 18h.
> - **Best-effort:** try/catch por tarefa (uma tarefa com erro não aborta as restantes) e try/catch global (a aprovação da ausência nunca falha por causa de um erro na reatribuição). Devolve `{ total, reatribuidas, orfas }`.
> - **Callers:** `aprovarRejeitarAusencia` (quando uma ausência é aprovada) e `reaplicarAusencia` (forçar re-execução da desatribuição + reatribuição numa ausência já aprovada). Em ambos, a resposta JSON inclui `redistribuicao = { total, desatribuidas }` e `reatribuicao = { total, reatribuidas, orfas }`.

---

## 3.3. Cron Jobs (node-cron)

O backend tem três cron jobs diários, todos iniciados no arranque (`server.js`, dentro de `if (require.main === module)` — não correm nos testes):

| Job | Ficheiro | Agenda (cron) | Timezone | Descrição |
|-----|----------|---------------|----------|-----------|
| **Daily Briefing** | `jobs/dailyBriefing.js` | `0 8 * * *` | servidor (configurar `TZ=Europe/Lisbon` no Render) | 08:00 — envia via WhatsApp (mock) + push o plano de limpezas de **hoje** a cada staff. |
| **Cão de Guarda** (Prompt 96 + 98) | `jobs/caoGuarda.js` | `0 18 * * *` | `Europe/Lisbon` (opção nativa do node-cron) | 18:00 — **Fase A:** auto-atribui (load balancer) as tarefas órfãs de **amanhã** (Fail-Safe); **Fase B:** envia push por cada tarefa de limpeza de **hoje** ainda não concluída. |
| **Agenda de Amanhã** (Prompt 94) | `jobs/agendaAmanha.js` | `0 19 * * *` | `Europe/Lisbon` (opção nativa do node-cron) | 19:00 — envia push a cada staff com trabalho **amanhã**: `📅 Agenda de Amanhã: Tens X tarefa(s) agendada(s). Entra na app para ver o itinerário`. |

### Cão de Guarda (`jobs/caoGuarda.js`) — Prompt 96 + Prompt 98
Executa **duas fases** todos os dias às 18:00 (Europe/Lisbon):

**FASE A — Auto-Atribuição de Emergência (Fail-Safe, Prompt 98):** corre **antes** dos alertas.
1. Calcula o intervalo do dia **seguinte** (meia-noite UTC).
2. Procura todas as `Tarefa` com `data` nesse intervalo, `estado: 'por_atribuir'` e `utilizador_id: null` (órfãs), com populate de `propriedade_id` (nome + coordenadas).
3. Para cada tarefa órfã, invoca `determinarUtilizadorAtribuido` (load balancer: Algoritmo VIP + Haversine + SLA 8h) — o mesmo usado no webhook e na auto-atribuição manual.
4. Se encontrar staff: recalcula a hora de início via scheduler sequencial (Haversine + almoço 13h-14h), atualiza a tarefa (`utilizador_id`, `estado: 'atribuida'`, nova `data`) e envia push `🧹 Nova Limpeza Atribuída` (fire-and-forget).
5. Se não houver staff disponível: mantém `por_atribuir` (órfã).
6. Devolve `{ encontradas, atribuidas, orfas }`.

> **Objetivo (Prompt 98):** garantir que o dia seguinte está sempre coberto **antes** do relógio das 19:00 (Agenda de Amanhã) correr. Assim, quando os funcionários recebem a notificação das 19:00, as escalas já estão 100% preenchidas. Complementa o Prompt 97 (desligar a histeria automática): as tarefas desatribuídas por ausências/falta súbita/baixa/desativação de propriedade são reatribuídas aqui de forma centralizada e controlada.

**FASE B — Alertas de Tarefas Incompletas (Prompt 96):** os alertas.
1. Calcula o intervalo do dia **atual** (meia-noite UTC).
2. Procura todas as `Tarefa` com `data` nesse intervalo, `tipo: 'limpeza'`, `utilizador_id` ≠ null e `estado` ∈ `{ atribuida, em_curso }` (atribuídas mas não concluídas), com populate de `propriedade_id` (nome) e `utilizador_id` (ativo, eliminado_em).
3. Para cada tarefa "esquecida", chama `notificarUtilizador(staffId, '⚠️ Tarefa Incompleta', 'Ainda não marcaste a limpeza da [nome da propriedade] como concluída. Por favor, atualiza a app!', '/staff')` (fire-and-forget; skip silencioso se não houver `pushSubscription` ou Web Push não configurado).
4. Ignora tarefas cujo staff foi entretanto desativado/eliminado.
5. Devolve `{ encontradas, notificadas }`.

> **Nota sobre estados:** o modelo `Tarefa` tem os estados `['por_atribuir','atribuida','em_curso','concluida','cancelada']`. Não existe `'pendente'` — o equivalente (atribuída mas ainda não iniciada) é `'atribuida'`. O prompt pede 'pendente' ou 'em_curso', pelo que o job usa `{ atribuida, em_curso }` (= atribuídas + não concluídas).
>
> **Uma push por tarefa (Fase B):** ao contrário do `Agenda de Amanhã` (que agrupa por staff), os alertas do Cão de Guarda enviam **uma push por tarefa esquecida** (a mensagem inclui o nome da propriedade, pelo que cada push é específica). Se um staff tiver 3 limpezas por concluir, recebe 3 pushes.

### Agenda de Amanhã (`jobs/agendaAmanha.js`) — Prompt 94
1. Calcula o intervalo do dia **seguinte** (meia-noite UTC).
2. Procura todas as `Tarefa` com `data` nesse intervalo e `estado` ∈ `{ atribuida, por_atribuir }`, com populate de `utilizador_id` (nome, ativo, eliminado_em).
3. Agrupa por `utilizador_id` — só interessam as atribuídas a staff **ativos** e não eliminados. Tarefas `por_atribuir` (sem utilizador) não têm destinatário → não geram push.
4. Para cada staff, chama `notificarUtilizador(staffId, '📅 Agenda de Amanhã', 'Tens X tarefa(s) agendada(s). Entra na app para ver o itinerário', '/staff')` (fire-and-forget; skip silencioso se não houver `pushSubscription` ou Web Push não configurado).
5. Devolve `{ processados, notificados, tarefas }` (estatísticas para testes/logs).

> **Timezone:** o `Cão de Guarda` e o `Agenda de Amanhã` usam a opção `timezone: 'Europe/Lisbon'` do node-cron, pelo que os horários são estáveis mesmo que o servidor esteja em UTC (caso do Render) — acompanham automaticamente as mudanças legais de horário de Verão/Inverno de Portugal. O `Daily Briefing` usa o fuso do servidor (definir `TZ=Europe/Lisbon` no ambiente para alinhar).

---

## 3.4. Sistema de Emissão de Webhooks (Outbound) — integração com o Autocell

O All2gether notifica o portal central de orquestração **Autocell** quando ocorrem eventos críticos, via webhooks outbound (POST assíncrono M2M). A comunicação usa payloads leves ("esparso") e assinatura HMAC-SHA256 para verificação de autenticidade.

**Ficheiro:** `backend/utils/outboundWebhook.js` → exporta `enviarEventoParaAutocell(tipoEvento, dadosPayload)`.

### Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `AUTOCELL_WEBHOOK_URL` | URL de destino no Autocell (ex.: `http://url-do-autocell/api/webhooks/all2gether`). |
| `AUTOCELL_WEBHOOK_SECRET` | Segredo partilhado usado para gerar a assinatura HMAC-SHA256. Tem de ser **idêntico** no Autocell (que o usa para verificar a autenticidade). |

**Modo degradado:** se ambas as variáveis não estiverem definidas, `enviarEventoParaAutocell()` faz apenas `console.log` do evento (útil em dev) e **não** tenta o pedido de rede — os eventos são silenciosamente ignorados.

### Estrutura do payload

O payload é "esparso" — contém apenas a estrutura base e IDs críticos, nunca dados sensíveis nem conteúdo completo:

```json
{
  "eventId": "550e8400-e29b-41d4-a716-446655440000",
  "eventType": "relatorio.submetido",
  "timestamp": "2025-01-31T18:00:00.000Z",
  "data": {
    "relatorio_id": "uuid-efémero",
    "empresa_id": "ObjectId"
  }
}
```

- `eventId` — UUID v4 novo por evento (permite idempotência no receptor).
- `eventType` — tipo do evento (ver catálogo abaixo).
- `timestamp` — ISO 8601 string (UTC).
- `data` — objeto com apenas os IDs críticos relevantes ao evento.

### Assinatura HMAC-SHA256

Cada webhook inclui o cabeçalho `X-All2gether-Signature` com a assinatura HMAC-SHA256 do corpo JSON (em hexadecimal), gerada com `AUTOCELL_WEBHOOK_SECRET`:

```
X-All2gether-Signature: 352a86109cd8ab0322adfdd614a78ef7...
Content-Type: application/json
```

**Verificação no Autocell:** o receptor recalcula o HMAC do corpo recebido com o mesmo segredo e compara com o cabeçalho. Se bater → webhook autêntico; se não → rejeitado. Isto garante que o webhook veio do All2gether (que conhece o segredo) e que o corpo não foi alterado em trânsito.

### Cabeçalhos do pedido

| Cabeçalho | Valor |
|---|---|
| `Content-Type` | `application/json` |
| `X-All2gether-Signature` | `<hmac_sha256_em_hex>` |

### Catálogo de eventos

Atualmente suporta dois eventos (o catálogo é extensível — adicionar novos eventos implica só uma nova chamada `enviarEventoParaAutocell` no ponto de integração correspondente):

#### `relatorio.submetido`

Disparado quando um gestor submete o payload do relatório para geração do Resumo Executivo com IA (`POST /api/gestor/relatorios/ai-summary`), após o resumo ser gerado com sucesso.

```json
{
  "eventId": "...",
  "eventType": "relatorio.submetido",
  "timestamp": "...",
  "data": {
    "relatorio_id": "uuid-efémero-desta-submissão",
    "empresa_id": "ObjectId-da-empresa",
    "periodo": { "inicio": "2025-01-01", "fim": "2025-01-31" }
  }
}
```

**Integração:** `backend/controllers/relatorioController.js` → `getResumoIA` (fire-and-forget, sem `await`). O `relatorio_id` é um UUID efémero gerado para esta submissão (os relatórios não são persistidos — são gerados on-the-fly); o `empresa_id` vem do JWT do gestor autenticado.

#### `alerta.tarefas_pendentes`

Disparado no final da Fase B do Cão de Guarda (`jobs/caoGuarda.js`), quando existem tarefas de limpeza do dia atual atribuídas mas não concluídas que dispararam alertas push ao staff. Os IDs das tarefas são agrupados num único webhook agregado (não um por tarefa).

```json
{
  "eventId": "...",
  "eventType": "alerta.tarefas_pendentes",
  "timestamp": "...",
  "data": {
    "tarefas_ids": ["ObjectId-1", "ObjectId-2", "..."],
    "data_alvo": "2025-01-31T00:00:00.000Z"
  }
}
```

**Integração:** `backend/jobs/caoGuarda.js` → `alertasTarefasIncompletas` (no final do loop de notificações, se `tarefasIdsNotificadas.length > 0`; fire-and-forget). `data_alvo` é o início do dia atual em UTC (meia-noite).

### Padrão fire-and-forget

A função `enviarEventoParaAutocell()` é `async` mas os callers **não devem aguardar** (`await`) — o evento é disparado em background e não bloqueia o fluxo principal. Erros de rede (Autocell indisponível, timeout, etc.) são apanhados e loggados como warning, nunca lançados. Isto garante que uma falha no Autocell nunca prejudique a operação do All2gether.

---

## 3.5. Geocoding e Distâncias (Google Maps)

O All2gether converte moradas em coordenadas (`lat`, `lng`) para suportar a otimização de rotas do load balancer (Haversine) e o tempo de viagem real entre propriedades. O módulo responsável é `backend/utils/geocoding.js`.

### Geocoding — `obterCoordenadas(morada)`

Converte uma morada completa (ex.: "Rua das Flores 12, Lisboa") em coordenadas. **Prioridade (HF24 / commit `97c6832`):**

1. **Google Maps Geocoding API** (se `GOOGLE_MAPS_API_KEY` estiver definida) — chamada a `https://maps.googleapis.com/maps/api/geocode/json` com `language=pt-PT` e `region=pt`, timeout 5s.
2. **Nominatim** (OpenStreetMap, fallback silencioso) — `https://nominatim.openstreetmap.org/search` com `User-Agent: All2gether/1.0 (all2gether.app)`, timeout 5s, rate limit 1 req/s.

**Fallback gracioso:** o Google Maps é tentado primeiro, mas se a env var não existir, a API devolver erro HTTP, quota (`OVER_QUERY_LIMIT`), resposta inválida ou timeout, o sistema cai silenciosamente para Nominatim — a criação/edição da propriedade nunca falha por causa do geocoder (mantém `coordenadas` anteriores ou `null`).

> **Vantagens do Google Maps:** maior precisão em moradas portuguesas (rua, número, código postal), sem rate limit agressivo (Nominatim limita a 1 req/s), melhor cobertura de códigos postais e locais, Place ID (para futuras integrações com Places API).

### `googleMapsAtivo()`

Função exportada por `utils/geocoding.js` que devolve `true` se `GOOGLE_MAPS_API_KEY` estiver definida (não vazia). É exposta ao frontend via `GET /api/gestor/configuracoes/integracoes` (campo `google_maps_ativo`), permitindo à UI mostrar/ocultar botões "Abrir no Google Maps" e links de navegação.

### Distâncias — `utils/distancia.js`

**HF16:** o módulo `utils/distancia.js` JÁ usava `GOOGLE_MAPS_API_KEY` para a **Distance Matrix API** (`calcularTempoViagemReal(origem, destino)`) com cache em memória (TTL 5min) e fallback silencioso para Haversine (`tempoViagemHaversine`) se: (a) env var não existir; (b) API falhar; (c) resposta inválida. Usado pelo load balancer no fator "tempo de viagem" do score final (ver §3.2 — HF16).

> **Variável de ambiente:** `GOOGLE_MAPS_API_KEY` (opcional). Se ausente, todo o sistema funciona com Nominatim (geocoding) + Haversine (distâncias) — sem perda de funcionalidade, apenas com menor precisão em moradas portuguesas.

---

## 4. Scripts disponíveis

| Script               | Comando                            | Descrição                                                          |
|----------------------|------------------------------------|--------------------------------------------------------------------|
| `npm start`          | `node seed-admin.js && node server.js` | Corre o seed do Super Admin e **depois** arranca a API (fail-fast) |
| `npm run dev`        | `nodemon server.js`                | Arranca em modo desenvolvimento (auto-restart)                     |
| `npm test`           | `jest`                             | Corre os testes unitários/integração (Jest + Supertest)            |
| `npm run seed:admin` | `node seed-admin.js`               | Cria/atualiza o Super Admin (`admin@makigero.com`) para SSO (§6.2) |
| `npm run seed:checklists` | `node scripts/seedChecklists.js` | Cria 2 modelos de checklist base e associa-os às propriedades |

> **Nota sobre o `npm start`:** o script `start` corre o `seed-admin.js` **antes** de `server.js` (via `&&`). Isto garante que o Super Admin existe em cada arranque do Render (plano gratuito, sem acesso à shell) — fundamental para o SSO funcionar. O seed é **idempotente** e **conciso**: se o admin já estiver correto, não escreve na BD e emite só uma linha de log. Se o seed falhar persistentemente, o `&&` impede o servidor de arrancar (fail-fast — torna o problema visível nos logs em vez de arrancar sem admin).

### Seed do Super Admin (`npm run seed:admin` ou automático no `npm start`)

Script `seed-admin.js` (raiz do backend) que faz **upsert** do Super Admin da plataforma — a conta utilizada pelo **Single Sign-On (SSO)** com o portal Autocell para iniciar sessão no painel `/admin` em produção.

- **Utilizador criado/atualizado:**
  - `email`: `admin@makigero.com`
  - `nome`: `Super Admin`
  - `role`: `admin` (Super Admin da PLATAFORMA — cross-tenant; ver `docs/ARQUITETURA.md` §3)
  - `ativo`: `true`
  - `password_hash`: hash **bcrypt** (custo 10). Embora o SSO **não** use a password (autentica-se via JWT externo do Autocell), é sempre definida para permitir login normal (`POST /api/auth/login`) como **fallback de emergência**.
- **Empresa âncora:** o modelo `Utilizador` exige `empresa_id`. Como o admin é cross-tenant ("não tem empresa_id de operações"), o script faz **find-or-create** de uma empresa-sistema dedicada `All2gether (Sistema)` (NIF `SISTEMA`) para o ancorar, sem o associar a um tenant de cliente real. Override via `EMPRESA_ID`.
- **Idempotente e conciso (para arranque automático no Render free):**
  - Se o admin não existe → cria.
  - Se existe mas tem campos desatualizados (nome/role/empresa_id/ativo/`eliminado_em`) → atualiza.
  - Se existe e **já está correto** → não escreve na BD, emite só `ℹ️ Super Admin já existe e está correto — sem alterações` (reduz ruído nos logs de arranque do Render, que reinicia periodicamente).
  - Mantém a password existente se o admin já tiver hash (não regenera a cada arranque). Só reescreve a hash se `ADMIN_PASSWORD` estiver definida OU o admin não tiver password.
- **Robustez para cold starts do MongoDB (Render free + Atlas):** a ligação ao MongoDB tem **retry com backoff exponencial** (3 tentativas por defeito: 1s, 2s, 4s) para tolerar flutuações transitórias sem desativar o fail-fast para falhas persistentes. Configurável via `SEED_ADMIN_RETRIES`.
- **Fecho garantido da ligação à BD:** o wrapper `run()` usa `finally` para garantir `mongoose.disconnect()` em **todos** os caminhos (sucesso, erro de validação, erro de conexão, erro de runtime). Crítico porque o `&&` do `npm start` só passa para `node server.js` quando o processo do seed termina — se a ligação não fechar, o processo fica pendurado e o servidor nunca arranca.
- **Variáveis de ambiente:**
  - `MONGODB_URI` (obrigatória) — URI de ligação ao MongoDB.
  - `ADMIN_PASSWORD` (opcional) — password em claro do admin. Se não definida, é gerada uma password aleatória segura e **impressa uma única vez** na consola.
  - `EMPRESA_ID` (opcional) — ID da empresa âncora (override). Se não definida, usa/find-or-cria a empresa-sistema.
  - `SEED_ADMIN_RETRIES` (opcional) — nº de tentativas de ligação ao MongoDB em caso de falha transitória (default: `3`).

> **Fluxo de produção (Render free, sem shell):** definir `MONGODB_URI`, `AUTOCELL_SSO_SECRET` (idêntico ao do Autocell) e opcionalmente `ADMIN_PASSWORD` nas variáveis de ambiente do Render → o `npm start` corre o seed automaticamente em cada arranque (idempotente) e depois arranca o servidor → o SSO do Autocell passa a conseguir iniciar sessão do admin no All2gether. Não é preciso aceder à shell.

### Testes (v1.9.0)

Os testes usam **Jest** + **Supertest** e estão em `backend/tests/`.

- `tests/server.test.js` — testa o healthcheck `GET /` (status 200, mensagem, Content-Type) e rota inexistente (404).
- A instância `app` é exportada por `server.js` (`module.exports = app`) e o `app.listen` + `mongoose.connect` estão isolados dentro de `if (require.main === module)`. Isto permite que os testes importem a app **sem** iniciar o servidor HTTP nem ligar ao MongoDB (sem conflitos de portas nem dependência de BD).
- Configuração do Jest no `package.json` (`jest.testEnvironment: node`, `testMatch: **/tests/**/*.test.js`).
- Para correr: `cd backend && npm test`.

### Integração Contínua (CI) — GitHub Actions

O workflow `.github/workflows/ci.yml` corre em todos os `push` e `pull_request` nas branches `main` e `dev`, com 2 jobs paralelos em `ubuntu-latest` + Node.js 18:

1. **Frontend** — `npm ci` → `npm run lint` → `npx tsc --noEmit` → `npm run build` (na diretoria `frontend/`).
2. **Backend** — `npm ci` → `npm test` (na diretoria `backend/`).

---

## 5. Variáveis de ambiente

Definidas no ficheiro `.env` (a criar a partir de `.env.example`). **Nunca** fazer commit do `.env`.

| Variável        | Obrigatória | Descrição                                                        |
|-----------------|-------------|------------------------------------------------------------------|
| `MONGODB_URI`   | ✅ Sim       | URI de ligação ao MongoDB (local, Atlas ou add-on do Render)     |
| `PORT`          | ❌ Não        | Porta de escuta. Por defeito `5000`. No Render é injetada.       |
| `JWT_SECRET`    | ✅ Sim (prod)| Segredo para assinar/verificar JWT. Em dev tem fallback. **Gerar valor aleatório longo em produção.** |
| `JWT_EXPIRACAO` | ❌ Não        | Tempo de expiração do JWT (formato jsonwebtoken: `7d`, `12h`). Default `7d`. |
| `FRONTEND_URL`  | ❌ Não        | Origem permitida para CORS (URL do frontend Vercel). Default `http://localhost:3000`. |
| `AUTOCELL_SSO_SECRET` | ❌ Não | Segredo partilhado com o Autocell para SSO (ver §6.2). Se vazio, SSO desativado. |
| `AUTOCELL_WEBHOOK_URL` | ❌ Não | URL de destino no Autocell para webhooks outbound (ver §3.4). Se vazio (com `AUTOCELL_WEBHOOK_SECRET`), webhooks em modo dev (console.log). |
| `AUTOCELL_WEBHOOK_SECRET` | ❌ Não | Segredo partilhado para assinatura HMAC-SHA256 dos webhooks outbound (ver §3.4). Tem de ser idêntico no Autocell. |
| `GEMINI_API_KEY` | ❌ Não       | Chave do Google Gemini para o Resumo Executivo com IA (ver §6.4). Best-effort: se ausente, usa placeholder. |
| `OPENAI_API_KEY` | ❌ Não       | Alternativa ao Gemini para o Resumo Executivo (fallback). |
| `GOOGLE_MAPS_API_KEY` | ❌ Não | **HF24 (§3.5)** — Chave do Google Maps para Geocoding API (`utils/geocoding.js`) e Distance Matrix API (`utils/distancia.js`, HF16). Se ausente, fallback silencioso para Nominatim (geocoding) e Haversine (distâncias). |
| `SMOOBU_API_KEY` | ❌ Não | Chave da API Smoobu (env var fallback). Se definida + sem chave na BD, o webhook Smoobu é aceite e `smoobu_ativo` devolve `true`. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | ❌ Não | Chaves VAPID para notificações push (Web Push API). Se ausentes, push é ignorado silenciosamente. |

---

## 6. API — Endpoints

### `GET /`
Rota de verificação de estado (healthcheck).

**Resposta (200 OK):**
```json
{
  "status": "API do All2gether online e ligada à BD!"
}
```

### 6.1. Painel de Administração (`/api/admin`)

> **Autenticação (v1.10.0 — ESTRITA):** o middleware `auth` é aplicado **dentro de `adminRoutes.js`** apenas às rotas que precisam de proteção (`/propriedades`, `/equipa`). A rota `/setup` é **PÚBLICA** de propósito (bootstrap).
> - O middleware valida o JWT do header `Authorization: Bearer <token>` e injeta `req.user = { id, role, empresa_id }`. O `empresa_id` é lido do token.
> - **Sem token (ou token inválido/expirado) → `401`** (strito, sem fallback).
> - v1.10.0: o fallback legacy `x-empresa-id` foi **REMOVIDO**. O frontend está 100% com JWT, pelo que qualquer pedido sem token válido é recusado.

#### `GET /api/admin/propriedades`
Devolve as propriedades da empresa (ordenadas por `nome`).

- **Auth:** JWT (strito, sem fallback legacy). **Protegido.**
- **Resposta (200 OK):**
```json
{
  "propriedades": [
    { "_id": "...", "nome": "Casa Teste", "empresa_id": "...", "tempo_limpeza_minutos": 60, "ativo": true, "createdAt": "...", "updatedAt": "..." }
  ]
}
```
- **Erros:** `400` empresa_id em falta/inválido; `401` não autenticado; `500` erro interno.

#### `POST /api/admin/propriedades`
Cria uma propriedade para a empresa.

- **Auth:** JWT (strito, sem fallback legacy).
- **Body:**
```json
{
  "nome": "Casa Teste",
  "tempo_limpeza_minutos": 60
}
```
  - `nome` (obrigatório).
  - `tempo_limpeza_minutos` (opcional, default `60`, tem de ser `>= 0`).
- **Resposta (201 Created):** `{ "propriedade": { ... } }`
- **Erros:** `400` campos em falta / `tempo_limpeza_minutos` inválido; `401` não autenticado; `500` erro interno.

#### `GET /api/admin/equipa` (também em `GET /api/gestor/equipa`)
Lista os utilizadores da empresa do JWT, ordenados por `nome`. **HF23/HF25:** devolve **ativos E inativos** (removido o filtro `ativo: true`) para o gestor poder ver e reativar utilizadores inativos; continua a excluir eliminados (soft delete) e parceiros (`role: { $nin: ['admin', 'parceiro'] }`). Parceiros são listados na rota dedicada `GET /api/gestor/parceiros`.

- **Auth:** JWT (strito, sem fallback legacy). **Protegido.**
- **Resposta (200 OK):**
```json
{
  "utilizadores": [
    { "_id": "...", "nome": "João Limpezas", "email": "joao.limpezas@all2gether.pt", "empresa_id": "...", "role": "staff", "ativo": true, "responsavel_id": "...", "responsavel": { "_id": "...", "nome": "...", "email": "...", "role": "gestor" }, "createdAt": "...", "updatedAt": "..." }
  ]
}
```
- **Nota:** a `password_hash` **nunca** é devolvida (`.select('-password_hash')`). `responsavel_id` é populado para o campo `responsavel`.
- **Erros:** `400` empresa_id em falta/inválido; `401` não autenticado; `500` erro interno.

#### `POST /api/admin/equipa`
Cria um novo membro de equipa (Utilizador) para a empresa.

- **Auth:** JWT (strito, sem fallback legacy). **Protegido.**
- **Body:**
```json
{
  "nome": "Maria Ferreira",
  "email": "maria.ferreira@all2gether.pt",
  "password": "segredo123",
  "role": "staff"
}
```
  - `nome` (obrigatório).
  - `email` (obrigatório, único global, normalizado para lowercase).
  - `password` (obrigatória, mín. 6 caracteres — guardada como hash bcrypt, nunca em claro).
  - `role` (opcional, default `'staff'`; enum `['admin','manager','staff']`).
- **Resposta (201 Created):** `{ "utilizador": { ... } }` (sem `password_hash`).
- **Erros:** `400` campos em falta / password < 6 / role inválido; `401` não autenticado; `409` email duplicado; `500` erro interno.

#### `PUT /api/admin/equipa/:id`
Atualiza Nome, Email e/ou Role de um utilizador, e opcionalmente a password.

- **Auth:** JWT (strito, sem fallback legacy). **Protegido.**
- **Body (todos opcionais, mas pelo menos um):**
```json
{ "nome": "Maria Ferreira", "email": "maria@x.pt", "role": "manager", "password": "novapass123" }
```
  - `password`: se vier, é guardada como **nova hash bcrypt** (mín. 6 chars). Se não vier, a atual é mantida.
- **Regras de segurança:**
  - O utilizador tem de pertencer à mesma empresa do JWT (`findOne({ _id, empresa_id })`).
  - Se o email mudar, verifica unicidade global.
  - Não desativa via este endpoint (usar `PATCH /:id/estado`).
- **Resposta (200 OK):** `{ "utilizador": { ... } }` (sem `password_hash`).
- **Erros:** `400` ID inválido / nada para atualizar / password < 6 / role inválido; `401` não autenticado; `404` não encontrado / não pertence à empresa; `409` email duplicado; `500` erro.

#### `PATCH /api/admin/equipa/:id/estado` (também em `PATCH /api/gestor/equipa/:id/estado`)
Altera o estado `ativo` do utilizador (ativa ↔ desativa). **HF23/HF25 — soft-delete com desatribuição:** ao **inativar** um `staff`/`gestor`, chama `desatribuirTarefasPeriodo(utilizadorId, hoje, +1ano)` para desatribuir TODAS as tarefas futuras atribuídas (coloca em `por_atribuir` com `utilizador_id=null`; preserva as `concluida`/`cancelada`). Parceiros não são afetados (não têm tarefas atribuídas).

- **Auth:** JWT (strito, sem fallback legacy). **Protegido.**
- **Body (opcional):** `{ "ativo": true }` — se não vier, alterna o estado atual.
- **Resposta (200 OK):**
```json
{
  "utilizador": { ... },
  "ativo": false,
  "tarefas_desatribuidas": 7
}
```
  - `tarefas_desatribuidas` (HF25) — contagem de tarefas futuras que foram desatribuídas (0 se o utilizador foi ativado, ou se a desatribuição falhou best-effort sem bloquear a inativação).
- **Comportamento:**
  - Um utilizador desativado **não consegue fazer login** (ver `authController.login` → 401 "Utilizador inativo").
  - Não é possível desativar/ativar um `admin` (403 "Não é possível modificar o estado de um administrador").
  - A desatribuição é **best-effort** (try/catch) — a inativação nunca falha por causa de um erro na desatribuição; o erro é loggado.
- **Erros:** `400` ID inválido; `401` não autenticado; `403` alvo é admin; `404` não encontrado; `500` erro.

#### `DELETE /api/admin/equipa/:id`
Remove permanentemente o utilizador da base de dados.

- **Auth:** JWT (strito, sem fallback legacy). **Protegido.**
- **Regras de segurança:**
  - O utilizador tem de pertencer à mesma empresa do JWT.
  - **Não é possível eliminar-se a si próprio** (`req.user.id === id` → 400) — evita o admin ficar sem acesso.
- **Resposta (200 OK):** `{ "mensagem": "Utilizador \"X\" eliminado com sucesso.", "utilizador_id": "..." }`.
- **Erros:** `400` ID inválido / tentativa de auto-eliminação; `401` não autenticado; `404` não encontrado; `500` erro.

#### `GET /api/admin/setup`  *(PÚBLICO — sem auth)*
**Bootstrap do “Cliente Zero”** — cria dados iniciais para testes (idempotente):

- 1 **Empresa** «All2gether Teste» (procura por `nome`).
- 3 **Utilizadores** (procura por `email` único), cada um com `password_hash` bcrypt:
  - `admin@all2gether.pt` (admin — dono da conta)
  - `gestor@all2gether.pt` (gestor — gestor de operações)
  - `joao.staff@all2gether.pt` (staff — executante de limpezas)
- 1 **Propriedade** «Apartamento Teste».

- **Resposta (200 OK):**
```json
{
  "mensagem": "Cliente Zero criado com sucesso.",
  "empresa_id": "<ObjectId>",
  "empresa":  { "id": "...", "nome": "All2gether Teste", "criada": true },
  "utilizadores": [
    { "id": "...", "nome": "Diretor All2gether", "email": "admin@all2gether.pt", "role": "admin", "criado": true, "password_definida": true, "credenciais_teste": { "email": "admin@all2gether.pt", "password": "all2gether123" } },
    { "id": "...", "nome": "Gestor de Operações", "email": "gestor@all2gether.pt", "role": "gestor", "criado": true, "password_definida": true, "credenciais_teste": { "email": "gestor@all2gether.pt", "password": "all2gether123" } },
    { "id": "...", "nome": "João Staff", "email": "joao.staff@all2gether.pt", "role": "staff", "criado": true, "password_definida": true, "credenciais_teste": { "email": "joao.staff@all2gether.pt", "password": "all2gether123" } }
  ],
  "propriedade": { "id": "...", "nome": "Apartamento Teste", "criada": true }
}
```
- Se já existir tudo, devolve `mensagem: "Cliente Zero já existia (nada foi alterado)."` com `criada/criado: false`.
- **Retrocompatibilidade:** se um utilizador já existir sem `password_hash` (criado antes do auth), o setup define-lhe a password e garante o role correto.
- **Credenciais de teste (3 contas):** `admin@all2gether.pt`, `gestor@all2gether.pt`, `joao.staff@all2gether.pt` — todas com password `all2gether123` (remover em produção).

### 6.2. Autenticação (`/api/auth`)

#### `POST /api/auth/login` (público)
Login com email + password. Valida a hash bcrypt e devolve um JWT.

- **Body:**
```json
{ "email": "joao.limpezas@all2gether.pt", "password": "all2gether123" }
```
- **Resposta (200 OK):**
```json
{
  "token": "<jwt>",
  "utilizador": {
    "id": "...",
    "nome": "João Limpezas",
    "email": "joao.limpezas@all2gether.pt",
    "role": "staff",
    "empresa_id": "..."
  }
}
```
- **JWT payload:** `{ id, role, empresa_id }` assinado com `JWT_SECRET`, expira em `JWT_EXPIRACAO` (default `7d`).
- **Erros:** `400` email/password em falta; `401` credenciais inválidas / utilizador inativo / sem password definida; `429` muitas tentativas de login (rate limit); `500` erro interno.
- **Rate limiting (v1.11.0):** a rota de login está protegida por `express-rate-limit` — máximo de **5 tentativas por IP a cada 15 minutos**. Ultrapassado o limite → `429` com `{ "erro": "Muitas tentativas de login. Tente novamente mais tarde." }`. Mitiga ataques de força bruta e credential stuffing. Headers `RateLimit-*` (standard) são enviados na resposta para o cliente saber quando pode tentar novamente.

#### `GET /api/auth/sso` (público — Single Sign-On com o Autocell)
Inicia a sessão de um administrador no All2gether a partir do portal central **Autocell**, sem re-pedir credenciais (Single Sign-On).

- **Query params:**
  - `token` — JWT externo assinado pelo Autocell com `AUTOCELL_SSO_SECRET`.
  - `json` — se `"true"` (OU header `Accept: application/json`), ativa o **modo JSON**: o endpoint devolve `{ sucesso: true, token: <jwt_interno> }` em vez de setar cookies + redirecionar. Usado pela proxy route do Next.js para definir cookies no domínio do frontend (ver abaixo).
- **Payload esperado no JWT externo:** `{ email: "admin@all2gether.pt" }` (também aceita `sub` como convenção JWT).
- **Variável de ambiente:** `AUTOCELL_SSO_SECRET` — segredo partilhado com o Autocell. Tem de ser **idêntico** nos dois sistemas. Se vazio, o SSO fica desativado (todos os pedidos falham).

##### Dois modos de funcionamento

O endpoint suporta dois modos, consoante quem chama:

**1. Modo REDIRECT (padrão, retrocompatível)** — acesso direto pelo browser:
```
GET /api/auth/sso?token=<jwt_externo>
```
Valida o token, define cookies httpOnly no backend e faz `res.redirect(302)` para `FRONTEND_URL/admin` (ou `/login?erro=sso_falhou` em caso de erro).
⚠️ **Só funciona se backend e frontend partilharem o mesmo domínio registável** — em deploys cross-domain (Render + Vercel), os cookies definidos pelo backend não são guardados pelo browser para o domínio do frontend.

**2. Modo JSON (para proxy do Next.js — recomendado para produção cross-domain):**
```
GET /api/auth/sso?token=<jwt_externo>&json=true
# ou:
GET /api/auth/sso?token=<jwt_externo>   com header: Accept: application/json
```
Valida o token e devolve JSON **sem** definir cookies nem redirecionar:
- **Sucesso (200):** `{ "sucesso": true, "token": "<jwt_interno>" }`
- **Falha (401):** `{ "sucesso": false, "erro": "sso_falhou" }`

A proxy route do Next.js (`frontend/src/app/api/auth/sso/route.ts`) usa este modo: recebe o JSON, define os cookies no **domínio do frontend** (que o browser aceita) e faz o redirect final para `/admin`.

##### Fluxo completo (modo JSON, recomendado para produção)

```
┌──────────┐  redirect browser  ┌─────────────────────────┐  fetch ?json=true   ┌──────────────┐
│ Autocell │ ─────────────────► │ Next.js proxy route     │ ──────────────────► │ Backend SSO  │
│ (portal) │                    │ /api/auth/sso           │                     │ /api/auth/sso│
└──────────┘                    │ (domínio do frontend)   │ ◄────── JSON ────── │ (Render)     │
                                └─────────────────────────┘ {sucesso, token}   └──────────────┘
                                          │
                                          │ set cookies httpOnly (domínio frontend)
                                          │ + redirect /admin
                                          ▼
                                ┌─────────────────────────┐
                                │ Browser (sessão ativa)  │
                                └─────────────────────────┘
```

1. O Autocell gera o JWT externo com `AUTOCELL_SSO_SECRET` e redireciona o browser para `https://all2gether.vercel.app/api/auth/sso?token=<jwt_externo>`.
2. A proxy route do Next.js (no domínio do frontend) faz `fetch` ao backend em modo JSON: `GET https://all2gether-backend.../api/auth/sso?token=...&json=true`.
3. O backend valida o JWT externo, procura o admin por `email` + `role: 'admin'`, gera o JWT interno e devolve `{ sucesso: true, token }`.
4. A proxy route define os cookies httpOnly `all2gether_token` + `all2gether_admin_token` no domínio do frontend (`sameSite: 'lax'`, `secure` em produção, `maxAge: 7d`) e redireciona para `/admin`.

##### Segurança

- O JWT externo é validado com um segredo **diferente** do `JWT_SECRET` interno — isola a confiança (comprometimento do segredo SSO não expõe os tokens internos).
- Apenas `role: 'admin'` é aceite via SSO (o Autocell é um portal de orquestração central).
- `sameSite: 'lax'` é obrigatório para que o cookie viaje no redirect top-level do SSO (Autocell → frontend).
- `httpOnly: true` — o JS do browser não consegue ler o token (anti-XSS).
- No modo JSON, o token interno só transita pela rede servidor-a-servidor (proxy Next.js → backend), nunca exposto ao browser.

##### Erros

- **Modo REDIRECT:** todos os erros redirecionam para `FRONTEND_URL/login?erro=sso_falhou`.
- **Modo JSON:** todos os erros devolvem `401 { sucesso: false, erro: "sso_falhou" }` (a proxy route converte isto num redirect para `/login?erro=sso_falhou`).

Casos de erro: token em falta; `AUTOCELL_SSO_SECRET` não configurado; token inválido/expirado; payload sem `email`/`sub`; admin não encontrado ou inativo.

> **Arquitetura cross-domain (Render + Vercel):** o backend (Render) e o frontend (Vercel) estão em domínios diferentes. Cookies `httpOnly` definidos pelo backend não são guardados pelo browser para o domínio do frontend. A proxy route do Next.js (`frontend/src/app/api/auth/sso/route.ts`) resolve isto: corre no MESMO domínio do frontend, pede o token ao backend em modo JSON, e define os cookies localmente. Esta é a solução recomendada para produção; o modo REDIRECT fica apenas para ambientes same-domain ou desenvolvimento local.

#### `GET /api/auth/me` (requer JWT)
Devolve os dados do utilizador autenticado (a partir do token).

- **Header:** `Authorization: Bearer <token>`
- **Resposta (200 OK):** `{ "utilizador": { id, nome, email, role, empresa_id } }`
- **Erros:** `401` não autenticado / token inválido; `404` utilizador não encontrado; `500` erro interno.

### 6.3. Ausências — Folgas e Férias (`/api/admin/ausencias`)

> **Auth:** JWT (strito, sem fallback legacy). Todas as rotas **protegidas** por `auth`.

#### `GET /api/admin/ausencias`
Lista as ausências da empresa, com o utilizador populado.

- **Query param opcional:** `?futuras=true` — só ausências com `data_fim >= hoje` (úteis para o calendário).
- **Resposta (200 OK):**
```json
{
  "ausencias": [
    {
      "_id": "...",
      "utilizador_id": "...",
      "utilizador": { "_id": "...", "nome": "João Limpezas", "email": "...", "role": "staff" },
      "empresa_id": "...",
      "data_inicio": "2024-07-15T00:00:00.000Z",
      "data_fim": "2024-07-20T00:00:00.000Z",
      "tipo": "ferias",
      "notas": "férias pagas"
    }
  ]
}
```

#### `POST /api/admin/ausencias`
Regista uma nova ausência (folga ou férias).

- **Body:**
```json
{
  "utilizador_id": "...",
  "data_inicio": "2024-07-15",
  "data_fim": "2024-07-20",
  "tipo": "ferias",
  "notas": "férias pagas"
}
```
  - `utilizador_id` (obrigatório) — tem de ser staff/manager da empresa (não admin).
  - `data_inicio` / `data_fim` (obrigatórias) — `data_fim >= data_inicio`.
  - `tipo` (opcional, default `'folga'`) — `enum: ['ferias','folga']`.
  - `notas` (opcional).
- **Validações:**
  - Utilizador existe e pertence à empresa com role staff/manager.
  - **Sem sobreposição** com outra ausência do mesmo utilizador (409 se houver).
- **Resposta (201 Created):** `{ "ausencia": { ... } }` (com utilizador populado).
- **Erros:** `400` campos em falta / datas inválidas / utilizador não encontrado; `409` sobreposição; `500` erro.

#### `DELETE /api/admin/ausencias/:id`
Elimina uma ausência.

- **Regras:** a ausência tem de pertencer à empresa do JWT.
- **Resposta (200 OK):** `{ "mensagem": "Ausência eliminada com sucesso.", "ausencia_id": "..." }`.
- **Erros:** `400` ID inválido; `404` não encontrada; `500` erro.

> **Integração com o webhook:** as ausências registadas aqui são consultadas automaticamente pelo `webhookController` (passo 4 do fluxo de atribuição) para excluir staff indisponível da atribuição automática de tarefas.

---

### 6.4. Relatórios / Analytics (`/api/admin/relatorios`)

*Protegido por JWT (middleware `auth`).*

#### `GET /api/admin/relatorios/produtividade`

Métricas de produtividade da empresa num intervalo de datas.

**Query params (opcionais):**
- `inicio` (`yyyy-mm-dd` | ISO) — início do período. Default: há 30 dias.
- `fim` (`yyyy-mm-dd` | ISO) — fim do período (inclusive). Default: hoje.

**Resposta 200:**
```json
{
  "periodo": { "inicio": "...", "fim": "..." },
  "resumo": {
    "totalTarefas": 100,
    "concluidas": 80,
    "taxaConclusao": 0.8,
    "emAtraso": 5,
    "taxaAtraso": 0.05,
    "cargaTotalMinutos": 6000,
    "tempoMedioMinutos": 75
  },
  "porStaff": [{ "utilizador_id", "nome", "total", "concluidas", "carga_minutos", "taxaConclusao" }],
  "porDia": [{ "data": "yyyy-mm-dd", "total", "concluidas", "carga_minutos" }],
  "porEstado": [{ "estado", "total" }],
  "porPropriedade": [{ "propriedade_id", "nome", "total", "carga_minutos" }]
}
```

> **"emAtraso"** = tarefas não concluídas nem canceladas cuja `data` já passou (proxy operacional de atraso — não há campo dedicado no modelo). **"tempoMedioMinutos"** = média de `tempo_limpeza_minutos` das concluídas.

---

### 6.10. Calendário Visual Avançado — v1.23.0

*Protegido por JWT (middleware `auth`).*

#### `GET /api/admin/calendario/dados`

Endpoint unificado para alimentar a página de Calendário Visual Avançado. Devolve as tarefas da empresa num intervalo de datas, com filtros opcionais e populate de propriedade (nome + morada + coordenadas) e utilizador (nome).

**Query params:**
| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `inicio` | yyyy-mm-dd \| ISO | Início do período |
| `fim` | yyyy-mm-dd \| ISO | Fim do período (inclusive) |
| `propriedadeId` | ObjectId | Filtra por propriedade (opcional) |
| `utilizadorId` | ObjectId \| `null` | Filtra por funcionário; `null` = tarefas por atribuir (opcional) |
| `estado` | string | `por_atribuir` \| `atribuida` \| `em_curso` \| `concluida` \| `cancelada` (opcional) |

**Diferença para o `GET /api/admin/tarefas`:**
- Não exclui canceladas por defeito (o calendário pode mostrá-las a tracejado). Use `?estado=atribuida` para excluir.
- Aceita filtros opcionais por `propriedadeId`, `utilizadorId` e `estado`.
- Populate inclui `morada` e `coordenadas` da propriedade (para tooltip e futuro mapa de rotas).

**Resposta 200:** `{ tarefas: [...] }` (cada tarefa tem `propriedade_id: { nome, morada, coordenadas }` e `utilizador_id: { nome } | null`)

**Erros:** `401` (sem token), `500` (erro interno).

---

### 6.11. Fluxo de aprovação de ausências — v1.24.0

#### Modelo `Ausencia` (campos novos)

| Campo | Tipo | Valores | Default |
|-------|------|---------|---------|
| `estado` | String | `pendente` \| `aprovada` \| `rejeitada` | `pendente` |
| `tipo` | String | `ferias` \| `doenca` \| `outro` | `ferias` |

> O enum do `tipo` mudou de `['ferias','folga']` para `['ferias','doenca','outro']`. As "folgas" fixas semanais continuam no campo `dias_folga` do Utilizador.

#### Endpoints do Staff (`/api/staff/ausencias`)

*Protegido por JWT. O staff só gere as SUAS ausências.*

| Método | Rota | Descrição |
|--------|------|-----------|
| `GET`  | `/api/staff/ausencias` | Histórico de ausências do próprio utilizador |
| `POST` | `/api/staff/ausencias` | Criar pedido de ausência (sempre `estado: 'pendente'`) |

**POST Body:** `{ data_inicio, data_fim, tipo?, notas? }`

O staff **não pode aprovar** os próprios pedidos — só o admin.

#### Endpoint de Aprovação (Admin)

`PATCH /api/admin/ausencias/:id/estado` — aprovar ou rejeitar um pedido do staff.

**Body:** `{ estado: 'aprovada' | 'rejeitada' }`

**Lógica crítica:**
- **Aprovar** → redistribui automaticamente as tarefas futuras do utilizador no período `[data_inicio, data_fim]` usando o load balancer (`determinarUtilizadorAtribuido`). Tarefas com staff disponível são reatribuídas; as sem staff disponível ficam `por_atribuir`.
- **Rejeitar** → apenas atualiza o estado (não mexe nas tarefas).

**Resposta 200:**
```json
{
  "mensagem": "Ausência aprovada. 2 tarefa(s) reatribuída(s), 0 órfã(s).",
  "ausencia": { ... },
  "redistribuicao": { "total": 2, "reatribuidas": 2, "orfas": 0, "detalhes": [...] }
}
```

#### Impacto no load balancer

O load balancer (e o `atualizarTarefaPorReserva`) agora só consideram ausências com `estado: 'aprovada'` para excluir staff da atribuição. Pedidos pendentes ou rejeitados **não bloqueiam** a atribuição (o staff pode ainda trabalhar).

#### Ações do admin que criam ausências

As ações diretas do admin (falta súbita, baixa prolongada, registo manual) criam ausências com `estado: 'aprovada'` (não precisam de aprovação — o admin já decidiu).

---

### 6.12. Hard-Delete de Propriedades — HF24

*Protegido por JWT (middleware `auth`) + `isGestor`. Hard-delete exige `role: 'admin'`.*

#### `DELETE /api/gestor/propriedades/:id`

Elimina uma propriedade. Comporta-se de duas formas conforme o query param `hard`:

| Modo | Query | Perfil | Ação |
|------|-------|--------|------|
| **Soft-delete (padrão)** | (sem `?hard=true`) | qualquer gestor | Marca `ativo=false` e desatribui as tarefas futuras (`atribuida`/`em_curso` → `por_atribuir`, `utilizador_id=null`). A propriedade fica oculta mas continua na BD (preserva histórico e associações). |
| **HARD DELETE** | `?hard=true` | **exclusivo `admin`** (403 caso contrário) | Apaga definitivamente a propriedade (`Propriedade.deleteOne`) **e** as tarefas futuras não concluídas dessa propriedade (`Tarefa.deleteMany` com `data >= hoje` e `estado ∉ ['concluida','cancelada']`). Evita tarefas órfãs com `propriedade_id` inexistente. |

- **Controller:** `eliminarPropriedade` em `backend/controllers/gestorController.js`.
- **Validação:** pertença à empresa (`findOne({ _id, empresa_id })`) → 404 se não encontrar.
- **Auditoria:** ambos os modos registam auditoria (`registarAuditoria`) com `acao='desativar'` (soft) ou `acao='eliminar'` (hard).
- **Resposta 200 (soft):** `{ mensagem, propriedade_id, hard_delete: false, tarefas_desatribuidas: <n> }`.
- **Resposta 200 (hard):** `{ mensagem, propriedade_id, hard_delete: true, tarefas_apagadas: <n> }`.
- **Erros:** `400` ID inválido; `403` `?hard=true` por não-admin; `404` propriedade não encontrada; `500` erro interno.

> **Casos de uso:** o soft-delete é o fluxo normal para "pausar" uma propriedade (mantém tarefas concluídas para relatórios/histórico). O hard-delete é uma operação de limpeza administrativa (apenas Super Admin) para remover propriedades de teste ou duplicadas sem deixar resíduos.

---

### 6.13. Configurações / Integrações (`/api/gestor/configuracoes/integracoes`)

*Protegido por JWT (middleware `auth`) + `isGestor` (HF6; HF25 — alterações restritas a admin).*

#### `GET /api/gestor/configuracoes/integracoes`

Devolve o estado das integrações externas da empresa do gestor.

- **Resposta 200:**
```json
{
  "smoobu": {
    "api_key_mascarada": "••••••••1234",
    "configurado": true,
    "ativo": true,
    "ultima_sincronizacao": "2025-01-31T18:00:00.000Z"
  },
  "rotinas": {
    "sincronizacao_automatica": false,
    "frequencia_horas": 24
  },
  "env_var_ativa": true,
  "smoobu_ativo": true,
  "google_maps_ativo": true
}
```

- **`smoobu_ativo` (HF25 — NOVO):** booleano que reflete o **estado real** da integração Smoobu — `true` se houver chave na BD (`integracoes.smoobu.api_key`) **OU** env var `SMOOBU_API_KEY` definida no Render. O frontend usa este campo para mostrar a bolinha verde/vermelha de estado (em vez do antigo `configurado` que só refletia a BD).
- **`google_maps_ativo` (HF24 — NOVO):** booleano que indica se `GOOGLE_MAPS_API_KEY` está definida (via `utils/geocoding.js → googleMapsAtivo()`). O frontend usa-o para mostrar/ocultar botões "Abrir no Google Maps" e links de navegação.
- A `api_key` Smoobu **nunca** é devolvida em claro — apenas mascarada (`••••••••1234`) + booleano `configurado`.

#### `PUT /api/gestor/configuracoes/integracoes`

Atualiza as configurações de integrações.

- **Body:**
```json
{
  "smoobu": { "api_key": "nova-chave", "ativo": true },
  "rotinas": { "sincronizacao_automatica": true, "frequencia_horas": 12 }
}
```
  - `smoobu.api_key` (opcional) — string; se `undefined`, mantém a atual; se string vazia, limpa.
  - `smoobu.ativo` (opcional) — boolean.
  - `rotinas.sincronizacao_automatica` (opcional) — boolean.
  - `rotinas.frequencia_horas` (opcional) — número (mínimo 1; valores comuns: 1, 6, 12, 24).
- **Resposta 200:** `{ message, smoobu: {...}, rotinas: {...} }` (configurações atualizadas, `api_key` mascarada).
- **Erros:** `400` nenhum campo para atualizar / `frequencia_horas` inválida; `404` empresa não encontrada; `500` erro interno.

> **HF25 — alterações restritas a admin:** a operação `PUT` foi tornada mais restritiva (apenas `admin` pode alterar a `api_key` do Smoobu); gestores continuam a poder consultar (`GET`) e ajustar as rotinas.

---

### 6.14. Parceiros B2B (`/api/gestor/parceiros`) — HF23

*Protegido por JWT (middleware `auth`) + `isGestor`.*

#### `GET /api/gestor/parceiros`

Lista os utilizadores com `role: 'parceiro'` da empresa do gestor.

- **Controller:** `getParceiros` em `backend/controllers/gestorController.js`.
- **Comportamento:** devolve **ativos E inativos** (para permitir reativação). Exclui eliminados (soft delete: `eliminado_em: null`). A `password_hash` nunca é devolvida (`.select('-password_hash')`).
- **Resposta 200:**
```json
{
  "utilizadores": [
    { "_id": "...", "nome": "Hotel Lisboa", "email": "ops@hotellisboa.pt", "role": "parceiro", "ativo": true, "nif": "500100200", "observacoes": "Parceiro desde 2024", "createdAt": "...", "updatedAt": "..." }
  ]
}
```
- **Erros:** `400` `empresa_id` em falta no token; `500` erro interno.

> **Diferença para `GET /api/gestor/equipa`:** `getEquipa` exclui parceiros (`role: { $nin: ['admin','parceiro'] }`), pelo que esta rota dedicada é necessária para a página `/gestor/parceiros`.

---

## 7. Deploy no Render

| Definição        | Valor                        |
|------------------|------------------------------|
| Root Directory   | `backend`                    |
| Build Command    | `npm install`                |
| Start Command    | `npm start`                  |
| Environment Vars | `MONGODB_URI`, `JWT_SECRET`, `JWT_EXPIRACAO` (e `PORT` opcional) |

> O Render injeta automaticamente a variável `PORT`. A aplicação lê essa variável, pelo que não é necessário defini-la manualmente.

---

## 8. Regras e convenções do projeto

- **Branch de desenvolvimento:** `dev` (todos os commits de funcionalidades vão para aqui).
- **Documentação:** sempre que o código do backend é alterado, este ficheiro (`docs/BACKEND.md`) e o `README.md` da raiz devem ser atualizados.
- **Segredos:** nenhum segredo (URIs com credenciais, tokens, etc.) deve ser commitado. Usar sempre `.env` localmente e as variáveis de ambiente do Render em produção.
- **Linguagem:** os comentários de código e a documentação são redigidos em **pt-pt**.

---

## 9. Histórico de alterações (backend)

| Data       | Versão | Alteração                                                            |
|------------|--------|---------------------------------------------------------------------|
| Inicial    | 1.0.0  | Criação da estrutura base: `package.json`, `server.js`, `.env.example`, `.gitignore`. Ligação ao MongoDB e rota de teste `GET /`. |
| v1.1.0     | 1.1.0  | Lógica central: modelos `Propriedade`, `Utilizador`, `Ausencia`, `Tarefa`; fluxo estrito de atribuição com filtro de ausências + load balancing; resposta 200 imediata + processamento assíncrono; tratamento de erros robusto. |
| v1.2.0     | 1.2.0  | Painel de Administração: modelo `Empresa` (nome, nif, plano_ativo); `controllers/adminController.js` (`getPropriedades`, `criarPropriedade`, `setupClienteZero`); `routes/adminRoutes.js` (`GET/POST /api/admin/propriedades`, `GET /api/admin/setup`); montagem em `server.js`. `empresa_id` via header `x-empresa-id` (sem JWT ainda). |
| v1.3.0     | 1.3.0  | **Autenticação JWT:** dependências `jsonwebtoken` + `bcryptjs`; modelo `Utilizador` com `email` único + `password_hash`; `middleware/auth.js` (verifica JWT, injeta `req.user`, fallback legacy `x-empresa-id`); `controllers/authController.js` (`login` com bcrypt + JWT, `/me`); `routes/authRoutes.js` (`POST /api/auth/login`, `GET /api/auth/me`); `/api/admin` protegido por `auth` com `empresa_id` do token; `setupClienteZero` cria Staff com `password_hash` (`joao.limpezas@all2gether.pt` / `all2gether123`); `.env.example` com `JWT_SECRET` + `JWT_EXPIRACAO`. |
| v1.3.1     | 1.3.1  | **Fix bootstrap:** o `auth` deixou de ser aplicado a todo `/api/admin` e passou a ser aplicado apenas às rotas `/propriedades` (dentro de `adminRoutes.js`). A rota `/api/admin/setup` voltou a ser **PÚBLICA** (era o endpoint de bootstrap que criava o primeiro utilizador — não podia exigir token). Corrige o erro `401 Autenticação obrigatória` ao chamar `/setup`. |
| v1.4.0     | 1.4.0  | **Novo role `manager`:** modelo `Utilizador` enum `['admin','manager','staff']`; `webhookController` inclui managers na atribuição de tarefas (load balancing); `setupClienteZero` cria 3 utilizadores (admin `admin@all2gether.pt` + manager `manager@all2gether.pt` + staff `joao.limpezas@all2gether.pt`, todos com password `all2gether123`). |
| v1.5.0     | 1.5.0  | **Gestão de Equipa:** `adminController` com `getEquipa` (lista utilizadores, `.select('-password_hash')`) e `criarMembroEquipa` (valida nome/email/password/role, hash bcrypt, email único); `adminRoutes` com `GET/POST /api/admin/equipa` (protegidos por `auth`). |
| v1.6.0     | 1.6.0  | **CRUD completo de Utilizadores:** `adminController` com `atualizarMembroEquipa` (PUT — nome/email/role/password opcional com nova hash bcrypt), `alternarEstadoMembro` (PATCH — ativa/desativa, inativos não fazem login), `eliminarMembroEquipa` (DELETE — não permite auto-eliminação); `adminRoutes` com `PUT/PATCH/DELETE /api/admin/equipa/:id` (protegidos por `auth`). Validação de pertença à empresa em todas as operações. |
| v1.7.0     | 1.7.0  | **Segurança hierárquica + `responsavel_id`:** modelo `Utilizador` com campo `responsavel_id` (ObjectId ref Utilizador, superior hierárquico); `getEquipa` faz `populate('responsavel_id')` e devolve campo `responsavel` preenchido; regras 403 em criar/editar (bloqueia role `admin`), editar/eliminar/desativar (bloqueia se alvo é `admin`); `responsavel_id` validado (admin/manager da mesma empresa, não pode ser si próprio). |
| v1.8.0     | 1.8.0  | **Sistema de Folgas e Férias:** modelo `Ausencia` expandido para intervalos (`data_inicio`/`data_fim`/`tipo`/`notas`, com `data` retrocompatível via `pre('save')`); `controllers/ausenciaController.js` (`listarAusencias` com `?futuras=true` + populate, `registarAusencia` com validação de sobreposição, `eliminarAusencia`); `routes/ausenciaRoutes.js` (`GET/POST/DELETE /api/admin/ausencias`); `webhookController` atualizado para excluir staff com ausência no intervalo (sobreposição `data_inicio <= dia AND data_fim >= dia` + query `data` legacy). |
| v1.9.0     | 1.9.0  | **Testes + CI:** dependências dev `jest` + `supertest`; script `npm test`; `tests/server.test.js` (healthcheck GET / → 200 + mensagem, rota inexistente → 404); `server.js` refactorizado para exportar `app` (`module.exports = app`) e isolar `app.listen` + `mongoose.connect` em `if (require.main === module)` (permite testes sem BD/porta); workflow GitHub Actions `.github/workflows/ci.yml` (2 jobs paralelos: frontend lint+tsc+build, backend test). |
| v1.10.0    | 1.10.0 | **Remoção do fallback legacy `x-empresa-id`:** `middleware/auth.js` agora é **ESTRITO** — só aceita JWT válido, sem token → 401 (sem fallback). `adminController` + `ausenciaController`: helper `extrairEmpresaId` (com fallback) substituído por `obterEmpresaId` (lê apenas `req.user.empresa_id` do JWT). Frontend `lib/api.ts`: removido `EMPRESA_ID` e fallback `x-empresa-id` do `adminHeaders` — se não houver token, não envia header (backend devolve 401). Proteção de rotas (middleware.ts + RouteGuard) já garante que só utilizadores autenticados chegam às páginas privadas. |
| v1.11.0    | 1.11.0 | **Rate limiting no login (anti-força bruta):** dependência `express-rate-limit`; `loginLimiter` em `authRoutes.js` aplicado apenas em `POST /api/auth/login` — máximo 5 tentativas por IP a cada 15 minutos, excedido → `429 { erro: "Muitas tentativas de login. Tente novamente mais tarde." }`. Headers `RateLimit-*` (standard) ativados. Mitiga força bruta e credential stuffing. |
| v1.12.0    | 1.12.0 | **Cookie httpOnly + proxy routes (segurança anti-XSS):** o token JWT deixou de chegar ao browser. O login (`/api/auth/login` no Next.js) define um cookie `httpOnly` + `Secure` + `SameSite=Strict`. As chamadas admin vão para same-origin (`/api/admin/...`) e o catch-all proxy (`app/api/admin/[...path]`) injeta o header `Authorization` ao encaminhar para o backend. CORS trancado a `FRONTEND_URL`. Error handler global sem stack trace vazada. |
| v1.13.0    | 1.13.0 | **WebhookLog + Soft Delete:** modelo `WebhookLog` (payload bruto + status `recebido`/`processado`/`erro`) para idempotência/auditoria do webhook. Soft delete de utilizadores (`eliminado_em`) — em vez de `deleteOne`, marca-se a data; protege Tarefas antigas de `utilizador_id` órfão. `getEquipa` exclui `eliminado_em: null`. |
| v1.14.0    | 1.14.0 | **PWA + Folgas Fixas Semanais + WhatsApp:** frontend convertido em PWA (`next-pwa`, manifest, service worker, theme `#B8860B`). Modelo `Utilizador` com `dias_folga` (array 0–6); webhook exclui staff cujo dia da semana do check-in está no array. Campo `telefone` para Daily Briefing via WhatsApp. Cron `0 8 * * *` (`node-cron`) — mock de envio. |
| v1.15.0    | 1.15.0 | **Calendários + Geolocalização + Haversine:** `GET /api/admin/tarefas` (calendário geral de operações com filtro de datas). `GET /api/auth/me/calendario` (calendário pessoal). Geocoding de moradas via Nominatim/OpenStreetMap (`utils/geocoding.js`). Load balancer com tempo de viagem (Haversine) entre propriedades. Logout seguro em todas as áreas. |
| v1.16.0    | 1.16.0 | **Emergências + SLA + Atrasos:** `POST /api/admin/equipa/:id/falta-subita` (reatribuição de emergência das tarefas do dia). `POST /api/admin/equipa/:id/baixa` (baixa prolongada/férias — redistribui tarefas futuras). SLA de capacidade máxima no load balancer (420 min = 7h). `POST /api/admin/tarefas/:id/atraso` (reportar atraso). Remoção do campo legacy `data` do modelo `Ausencia` (queries agora só usam `data_inicio`/`data_fim`). Pausar/desativar propriedades (`ativo: false`) — webhook respeita. Gestão manual de tarefas (`POST /api/admin/tarefas`, `PATCH /:id/atribuir`, `PATCH /:id/estado`). |
| v1.16.1    | 1.16.1 | **Dashboard real + Auditoria + Health + Rate limit global + Modo escuro + CSV:** dashboard do admin com dados reais (`GET /api/admin/dashboard` com contagens em paralelo + aggregate carga por staff). Modelo `Auditoria` + `utils/auditoria.js` (fire-and-forget) + `GET /api/admin/auditoria`. `GET /api/health` (estado BD + uptime). Rate limiting global (100 req/15min em `/api/`). Modo escuro funcional (toggle no sidebar, CSS vars). Exportação CSV (`GET /api/admin/tarefas/export`). |
| v1.17.0    | 1.17.0 | **Relatórios/Analytics + Paginação + Testes de integração + Fix bug webhook:** `GET /api/admin/relatorios/produtividade` (aggregations: resumo, por staff, por dia, por estado, por propriedade) com filtro de período. Página `/admin/relatorios` com gráficos recharts (linha, barras, pie). Paginação client-side nas listagens de equipa e tarefas (componente reutilizável `PaginationBar`). Suite de testes expandida de 4 para 29 testes com `mongodb-memory-server` (auth 401, login, /me, CRUD propriedades, atribuição real, dashboard, relatórios). **Fix bug crítico:** `tempoLimpeza` era usado antes da declaração (TDZ `const`) no processamento da reserva → `ReferenceError` silenciado pelo try/catch → tarefas ficavam sempre sem atribuição. Corrigido reordenando a computação de `tempoLimpeza` antes da chamada ao load balancer. |
| v1.19.1    | 1.19.1 | **Edição de propriedades:** novo endpoint `PUT /api/admin/propriedades/:id` (`atualizarPropriedade`) que permite editar `nome`, `morada` e `tempo_limpeza_minutos`. Valida pertença à empresa (404); se a `morada` mudar, **re-faz geocoding** (best-effort — se falhar, mantém coordenadas antigas, não bloqueia). Auditoria registada. No frontend, página `/admin/propriedades` tem agora botão "Editar" (ícone Pencil) que abre modal com os 3 campos. 4 novos testes (45 no total): atualizar nome+tempo, id inexistente 404, body vazio 400. |
| v1.20.1    | 1.20.1 | **Fix 500 no toggle de propriedades + PWA:** (1) Bug crítico — `PATCH /api/admin/propriedades/:id/estado` dava 500 em propriedades legacy sem `morada` porque `findOne` + `save()` re-valida o documento inteiro. Corrigido com `findOneAndUpdate` + `$set` (não re-valida). Teste de regressão: propriedade inserida sem morada → toggle 200. (2) PWA — meta `mobile-web-app-capable` adicionada (apple-* deprecated). (3) Ícones 1x1 placeholder substituídos por ícones reais 192/512/180 (gerados com image-generation + sharp, fundo dourado #B8860B). |
| v1.23.0    | 1.23.0 | **Calendário Visual Avançado — endpoint unificado:** novo endpoint `GET /api/admin/calendario/dados` (`adminController` → `getDadosCalendario`) que devolve tarefas da empresa num intervalo de datas com filtros opcionais (`propriedadeId`, `utilizadorId`, `estado`) + populate de propriedade (`nome`, `morada`, `coordenadas`) e utilizador (`nome`). Diferença para `getTarefas`: não exclui canceladas por defeito (calendário pode mostrá-las a tracejado), aceita `utilizadorId=null` para filtrar tarefas por atribuir, e o populate inclui `morada`+`coordenadas` (para tooltips e futuro mapa de rotas). 8 novos testes (69 no total): sem token 401, sem filtros (inclui canceladas), populate (nome+morada+utilizador), filtro por propriedade, filtro por utilizador, filtro utilizadorId=null (por atribuir), filtro por estado=concluida, combina filtros. Fix de teste existente: o teste do webhook assumia que só havia 1 staff (quebrado pelo `beforeAll` do calendário que cria 2 staff extra) — corrigido para verificar apenas que a tarefa foi atribuída a algum staff ativo (não null), que é o comportamento correto do load balancer. |
| v1.24.0    | 1.24.0 | **Fluxo de aprovação de ausências:** (1) Modelo `Ausencia` — novo campo `estado` (`pendente`\|`aprovada`\|`rejeitada`, default `pendente`); enum do `tipo` alargado para `ferias`\|`doenca`\|`outro` (as "folgas" fixas semanais continuam em `dias_folga` do Utilizador). (2) **Staff routes** — novo `controllers/staffController.js` + `routes/staffRoutes.js` montado em `/api/staff`: `GET /ausencias` (histórico próprio) + `POST /ausencias` (cria pedido sempre `pendente`; staff não pode auto-aprovar). (3) **Aprovação** — `PATCH /api/admin/ausencias/:id/estado` (`ausenciaController` → `aprovarRejeitarAusencia`): aprovar → redistribui tarefas do período via load balancer (helper `redistribuirTarefasPeriodo` extraído e reutilizável); rejeitar → só atualiza estado. (4) **Webhook** — `determinarUtilizadorAtribuido` e `atualizarTarefaPorReserva` agora só consideram ausências `aprovada` (pendentes/rejeitadas não bloqueiam atribuição). (5) Ações diretas do admin (falta súbita, baixa prolongada, registo manual) criam ausências com `estado: 'aprovada'`. 7 novos testes (76 no total): staff cria pedido (pendente), staff vê suas ausências, staff sem token 401, admin aprova (redistribui — verifica utilizador_id mudou), admin rejeita (não mexe em tarefas), estado inválido 400, ausência inexistente 404. |
| Prompt 92  | —      | **Upgrade de modelos (Fase 1.5):** (1) Modelo `Propriedade` — novo campo `funcionario_preferencial_id` (ObjectId `ref: 'Utilizador'`, default `null`, indexado) para suportar staff preferencial por propriedade (lógica de prioridade no load balancer será ativada num prompt seguinte). (2) Modelo `Tarefa` — novo objeto `detalhes_reserva` com sub-campos `checkin` (String), `checkout` (String), `pax` (Number), `nome_hospede` (String) — snapshot dos detalhes da tarefa. 1 novo teste (104 no total). |
| Prompt 93  | —      | **Algoritmo VIP + Detalhes da Reserva (Fase 1.5):** (1) Extrai `detalhesReserva` ({ checkin, checkout, pax, nome_hospede }) do payload da tarefa (variantes: arrival/departure, guests/numPeople/adults+children, guestName/firstName+lastName/guest.name). (2) `criarTarefaPorReserva` — guarda `detalhes_reserva` no `Tarefa.create`; ao re-activar tarefa cancelada, atualiza também os detalhes. (3) **Algoritmo VIP** em `determinarUtilizadorAtribuido` — novo parâmetro `propriedadeId`; antes do load balancer geral, se a propriedade tiver `funcionario_preferencial_id` e esse staff estiver disponível (passou filtros de ausência aprovada + folga fixa) e dentro do SLA de 8h/dia (`cargaLimpeza + novaTarefa ≤ 480min`), atribui obrigatoriamente a ele; só faz fallback para o load balancer geral (Haversine + menor carga) se o preferencial não puder. Novo helper `calcularCargaLimpezaDia`. 4 novos testes (108 no total). |
| Prompt 94  | —      | **Cron Job "Agenda de Amanhã" (19h):** novo ficheiro `jobs/agendaAmanha.js` — cron `0 19 * * *` com `timezone: 'Europe/Lisbon'` (estável mesmo em servidor UTC, acompanha horário de Verão/Inverno de PT). Lógica: calcula o intervalo do dia seguinte → procura `Tarefa` com `estado ∈ { atribuida, por_atribuir }` → agrupa por `utilizador_id` (só staff ativos não eliminados; `por_atribuir` sem utilizador não gera push) → para cada staff chama `notificarUtilizador(staffId, '📅 Agenda de Amanhã', 'Tens X tarefa(s) agendada(s). Entra na app para ver o itinerário', '/staff')` (fire-and-forget). `server.js` importa e inicia o job no arranque (dentro de `require.main === module`, não corre nos testes). `notificarUtilizador` carregado via `require` lazy dentro da função para permitir `jest.spyOn` nos testes. Nova secção 3.3 (Cron Jobs) no BACKEND.md. 4 novos testes (112 no total): notifica cada staff agrupado (verifica título, singular/plural, URL); ignora `por_atribuir`/concluídas/canceladas; sem tarefas → não notifica; ignora staff inativo. |
| Prompt 95  | —      | **`atualizarPropriedade` aceita `funcionario_preferencial_id`:** o `PUT /api/gestor/propriedades/:id` (`gestorController`) passa a aceitar o campo `funcionario_preferencial_id` no body. Aceita `null`/string vazia (remove o preferencial) ou um ObjectId; valida que é um staff ativo (`role: 'staff'`, `ativo: true`, `eliminado_em: null`) da mesma empresa (400 se não for). Mensagem de "Nenhum campo para atualizar" atualizada para incluir o novo campo. Sem novos testes (coberto pelos testes existentes do PUT + a validação é inline). 112 testes mantêm-se a passar. |
| Prompt 96  | —      | **Cron Job "Cão de Guarda" (18h):** novo ficheiro `jobs/caoGuarda.js` — cron `0 18 * * *` com `timezone: 'Europe/Lisbon'`. Lógica: calcula o intervalo do dia atual → procura `Tarefa` com `tipo: 'limpeza'`, `utilizador_id` ≠ null e `estado ∈ { atribuida, em_curso }` (atribuídas mas não concluídas; nota: o modelo não tem `'pendente'` — `'atribuida'` é o equivalente) → populate de `propriedade_id` (nome) + `utilizador_id` (ativo, eliminado_em) → para cada tarefa esquecida chama `notificarUtilizador(staffId, '⚠️ Tarefa Incompleta', 'Ainda não marcaste a limpeza da [nome da propriedade] como concluída. Por favor, atualiza a app!', '/staff')` (fire-and-forget; uma push por tarefa, não agrupado por staff). Ignora staff inativo/eliminado. `server.js` importa e inicia no arranque (`require.main === module`). `notificarUtilizador` via require lazy (permite `jest.spyOn` nos testes). Secção 3.3 (Cron Jobs) atualizada com a tabela dos 3 jobs + descrição detalhada do Cão de Guarda. 4 novos testes (116 no total): notifica por tarefa esquecida (verifica título/corpo com nome da propriedade/link); ignora concluídas/canceladas/por_atribuir/manutencao; sem tarefas → não notifica; ignora staff inativo. |
| Prompt 97  | —      | **"Desligar a Histeria Automática":** deixa de haver reatribuição automática via load balancer em resposta a ausências/desativação — as tarefas afetadas passam apenas a `utilizador_id = null` + `estado = 'por_atribuir'`, ficando o recálculo a cargo do Gestor (manual, via "Auto-Atribuir Pendentes") ou do Fail-Safe noturno. Alterações: (1) `ausenciaController.registarAusencia` — ao criar ausência aprovada, chama o novo helper `desatribuirTarefasPeriodo` (resposta inclui `desatribuicao`). (2) `ausenciaController.aprovarRejeitarAusencia` — aprovar deixa de chamar o load balancer; usa `desatribuirTarefasPeriodo` (resposta `redistribuicao = { total, desatribuidas }`). (3) Novo helper `desatribuirTarefasPeriodo(utilizadorId, inicio, fim)` substitui o antigo `redistribuirTarefasPeriodo` (removido). (4) `gestorController.reportarFaltaSubita` — desatribui tarefas de hoje (resposta `desatribuidas` em vez de `reatribuidas/orfas`). (5) `gestorController.registarBaixaProlongada` — desatribui tarefas do período (resposta `desatribuidas`). (6) `gestorController.alternarEstadoPropriedade` — ao DESATIVAR propriedade, deixa de APAGAR tarefas futuras (v1.35.0/Prompt 73) e passa a DESATRIBUIR (`updateMany` com `utilizador_id: null, estado: 'por_atribuir'`); resposta `tarefasDesatribuidas` em vez de `tarefasApagadas`. Frontend `gestor/propriedades/page.tsx` atualizado para o novo campo. 3 novos testes (119 no total): desativar propriedade desatribui (não apaga); falta súbita desatribui (não reatribui); baixa prolongada desatribui (não reatribui). 1 teste existente atualizado ("admin aprova ausência" passa a verificar desatribuição). |
| Prompt 98  | —      | **"Rede de Segurança das 18h" — Auto-Atribuição de Emergência (Fail-Safe):** o cron job `caoGuarda` (18:00) passa a ter **duas fases**: **Fase A (Fail-Safe, nova — ANTES dos alertas):** procura as `Tarefa` de amanhã com `estado: 'por_atribuir'` + `utilizador_id: null` e invoca `determinarUtilizadorAtribuido` (load balancer: Algoritmo VIP + Haversine + SLA 8h) para as atribuir; recalcula a hora via scheduler sequencial + envia push `🧹 Nova Limpeza Atribuída` (fire-and-forget). Se não houver staff, mantém `por_atribuir` (órfã). **Fase B (Prompt 96, os alertas):** inalterada — push por cada tarefa de limpeza de hoje não concluída. Objetivo: garantir que o dia seguinte está 100% coberto antes do relógio das 19:00 (Agenda de Amanhã) correr; complementa o Prompt 97 (as tarefas desatribuídas por ausências/falta/desativação são reatribuídas aqui de forma centralizada). `executarCaoGuarda` passa a devolver `{ failSafe: {encontradas, atribuidas, orfas}, alertas: {encontradas, notificadas} }`. Função `autoAtribuicaoEmergencia` exportada para testes. 4 novos testes (123 no total): atribui órfãs de amanhã via load balancer (verifica push + estado); sem órfãs → não faz nada; sem staff → mantém órfã; não mexe em tarefas de hoje nem em já atribuídas. 4 testes existentes do Prompt 96 atualizados para `resultado.alertas.*` (a estrutura mudou). |
| Prompt 100 | —      | **Garantir os Dados para o Excel:** confirmação e testes de que o `GET /api/gestor/calendario/dados` (`getDadosCalendario`) já devolve o objeto `detalhes_reserva` (usa `.lean()` sem `.select()`, pelo que todos os campos do modelo Tarefa são incluídos — `detalhes_reserva` foi adicionado no Prompt 92). Os `.populate('propriedade_id')` (nome + morada + coordenadas) e `.populate('utilizador_id')` (nome) já estavam presentes. 2 novos testes (125 no total): (1) tarefa com `detalhes_reserva` preenchido → endpoint devolve os 4 sub-campos (checkin, checkout, pax, nome_hospede); (2) tarefa de manutenção SEM `detalhes_reserva` → campo existe (objeto com defaults null) mas sem dados reais (não quebra o frontend/Excel). Sem alterações de código no backend — só testes de regressão. |
| Ajuste | —      | **Override do admin na impersonação (empresa sem gestor ativo):** `superAdminController.impersonarGestor` — quando a empresa não tem um gestor ativo (role 'gestor', ativo, não eliminado), deixou de devolver 404 ("Não foi encontrado um gestor ativo para a empresa X"). Agora o Super Admin (role 'admin') que faz o pedido tem **override total**: o sistema gera um token JWT com o id/nome/email do próprio admin, `empresa_id` da empresa alvo e `role: 'gestor'` (o admin impersona um gestor). Como o middleware `isGestor` permite 'gestor', o token funciona no painel `/gestor/*` (dashboard, propriedades, tarefas) baseando-se apenas no `empresa_id`. O id real do admin fica no token para auditoria (`registarAuditoria` usa `req.user.id`). Nota: o `/api/auth/me` continua a devolver o `empresa_id` real do utilizador na BD (o admin), mas os endpoints do gestor usam `req.user.empresa_id` do token (override). 1 novo teste (126 no total): empresa sem gestor ativo → admin impersona com 200 + token de override + acesso ao dashboard da empresa alvo. |
| Prompt 101 | —      | **Gestão de utilizadores de empresas terceiras (Super Admin):** 3 novos endpoints exclusivos do admin (auth + `isAdmin`) em `superAdminController` + `adminRoutes`: (1) `GET /api/admin/empresas/:empresaId/utilizadores` — lista todos os utilizadores (gestores + staff, `eliminado_em: null`) da empresa, sem `password_hash`, ordenados por role + nome. (2) `POST /api/admin/empresas/:empresaId/utilizadores` — cria gestor/staff nessa empresa; `empresa_id` vem do URL (garante associação correta); rejeita role 'admin' (403), valida email único global (409), password ≥ 6 caracteres; default role 'gestor' (caso de uso: empresa sem gestor). Auditoria registada com `empresa_id` da empresa alvo. (3) `PATCH /api/admin/empresas/:empresaId/utilizadores/:utilizadorId/estado` — alterna ativo/inativo (ou `{ ativo: boolean }` explícito); rejeita modificar admins (403); valida que o utilizador pertence à empresa do URL (404 caso contrário). Helper `carregarEmpresa(empresaId)` partilhado. 5 novos testes (131 no total): lista (401 sem token + 200 admin); cria gestor (201 + associação correta); rejeita role admin (403) + email duplicado (409); toggle alterna (3x); toggle com empresa errada (404). Frontend: botão "Gerir Utilizadores" + modal com tabela + toggle + formulário criar gestor. |
| Correção | —      | **Calendário não mostra ausências de eliminados + importarPropriedades atualiza sempre:** (1) `getDadosCalendario` (`gestorController`) — o `populate('utilizador_id')` das ausências aprovadas passou a incluir `eliminado_em` no select e as ausências cujo utilizador tem `eliminado_em` != null são filtradas (não aparecem no calendário). Antes, ausências de staff eliminado (soft delete) continuavam visíveis como férias no calendário. (2) `importarPropriedades` (`gestorController`) — alinhado com `sincronizarPropriedades` (Prompt 92): para propriedades já existentes, atualiza **SEMPRE** a `morada` e a `capacidade_hospedes`, com re-geocoding da morada nova. Antes (Prompt 90), só preenchia a morada se estivesse `'A definir'` — pelo que propriedades com morada já definida não eram atualizadas ("0 atualizadas, 36 já existiam"). Os restantes campos (nome, tempo, ativo, checklist, funcionario_preferencial_id) continuam preservados. 2 novos testes (133 no total): calendário não mostra ausência de eliminado; importarPropriedades atualiza morada + capacidade de propriedade existente (não só 'A definir'). |
| Prompt 113 | —      | **Mega Prompt de Correção (Alpha):** (1) **Fix de fuso horário (Lisboa/WEST)** — `tarefaController.criarTarefa` deixou de normalizar a data para meia-noite UTC (`Date.UTC(d.getUTC...)`); agora armazena o instante enviado pelo frontend diretamente. O frontend (`tarefas` + `calendário`) passa a enviar `new Date("YYYY-MM-DD"+"T00:00:00").toISOString()` (meia-noite LOCAL) em vez de `"YYYY-MM-DD"` (que o JS interpretava como UTC midnight → aparecia 01:00 em Lisboa e ficava invisível abaixo do slotMinTime 08:00). (2) `utils/disponibilidade.js` (`verificarDisponibilidadeUtilizador` + `mensagemIndisponivel`) — tornado robusto a offset: a comparação passa a ser feita pela **data de calendário de Lisboa** (`Intl.DateTimeFormat` com `timeZone: 'Europe/Lisbon'`, formato `YYYY-MM-DD`) em vez do instante UTC midnight. Isto garante que uma tarefa às 00:00 local (23:00Z do dia anterior em UTC) conta como "mesmo dia" para férias/ausências — funciona tanto para tarefas antigas (UTC midnight) como novas (local midnight). Janela de pesquisa ±1 dia + filtragem JS pela data de Lisboa. (3) **Novo endpoint `POST /api/gestor/propriedades/default-checklist`** — aplica o checklist padrão (`['Esvaziar lixo','Trocar roupa da cama','Trocar Toalhas','Limpar chão','Limpar vidros','Limpar pó']`) a TODAS as propriedades da empresa via `updateMany`. Substitui o existente. Devolve `{ sucesso, message, checklist, modificadas, correspondidas }`. 136 testes mantêm-se a passar (a reescrita da disponibilidade é retrocompatível — `dataLisboa` de um instante UTC midnight devolve a mesma data de calendário). |
| Prompt 114 | —      | **Notificações In-App, Bugs Alpha e Lógica de Distâncias:** (1) **Push Notifications** — confirmado que o fluxo já estava completo: `push-notification-setup.tsx` (staff+gestor) faz `pushManager.subscribe` + `POST /api/auth/me/push-subscribe` (proxy via catch-all `/api/auth/me/[...path]`); backend `authController.pushSubscribe` guarda em `Utilizador.pushSubscription` (campo Mixed, existente desde v1.27.0). `utils/notificar.js` estendido para criar também notificação in-app. (2) **Centro de Notificações In-App (O Sino)** — novo modelo `Notificacao` (`utilizador_id`, `empresa_id`, `mensagem`, `tipo` enum, `url`, `lida`, `data`, timestamps; índice composto `{ utilizador_id, lida, createdAt }`). Novo `notificacaoController.js` com 4 endpoints (montados em `/api/auth/me/notificacoes`): `GET /` (lista, query `?lidas=`), `GET /contagem` (count não-lidas), `PATCH /marcar-lidas` (todas), `PATCH /:id/lida` (uma). `utils/notificar.js` `notificarUtilizador()` agora envia push (se configurado) E cria registo `Notificacao` (fire-and-forget); `criarNotificacaoInApp` helper exportado. `tarefaController` (criarTarefa, atribuirTarefa, reatribuirTarefa) + `webhookController.criarTarefaPorReserva` passam `opts.tipo` (`tarefa_atribuida`/`tarefa_reatribuida`) e `empresa_id` — notificação gerada sempre que uma tarefa é atribuída ao staff. (3) **Fix Staff Inativo** — `getEquipa` já devolve todos; frontend (`tarefas/page.tsx` + `calendario/page.tsx`) agora filtra `u.role === "staff" && u.ativo === true` nos dropdowns de atribuição (antes só filtrava role). (4) **Capacidade no detalhe** — `authController.minhaTarefaDetalhe` + `gestorController.getTarefas`/`getDadosCalendario` passam a fazer populate de `capacidade_hospedes` (antes só `nome`/`morada`/`coordenadas`). (5) **Tolerância de Geocoding** — `gestorController.criarPropriedade` + `atualizarPropriedade` devolvem flag `warning` quando o Nominatim falha/devolve vazio (coordenadas null/mantidas); `utils/geocoding.js` já fazia catch silencioso (confirmado). (6) **Haversine** — novo `utils/distancia.js` (`distanciaHaversine(origem, destino)` em km, raio 6371km, robusto a null/NaN). `tarefaController` novo helper `verificarDistanciaTarefasDia(utilizadorId, data, propriedadeId)` que busca outras tarefas do staff no mesmo dia, popula coordenadas, calcula a distância máxima, e se > 15km (`LIMITE_DISTANCIA_KM`) devolve mensagem de warning. Integrado em `criarTarefa`, `atribuirTarefa`, `reatribuirTarefa` — resposta JSON inclui `warning` (não bloqueia). 7 novos testes (143 total): Haversine (Lisboa→Porto ≈274km, mesma=0, inválidas=0), contagem notificações, criar tarefa gera notif + contagem incrementa + marcar lidas, criar 2 tarefas distantes devolve warning, criar propriedade com morada (201 mesmo se Nominatim falhar). |
| Prompt 115 | — | **Separação ABSOLUTA de menus + fix loop 401 (sem alterações de backend):** o trabalho foi exclusivamente frontend (`GestorSidebar`/`AdminSidebar` dedicados, `route-guard.tsx` com redirect HARD via `fazerLogout()`). Backend sem alterações — o `POST /api/auth/logout` (limpeza do cookie httpOnly) já existia. |
| Prompt 116 | — | **Fundação SaaS + Lógica de negócio:** (1) Modelo `Empresa` ganhou campo `ativa` (boolean + índice) — empresas suspensas (`ativa: false`) ficam bloqueadas para o gestor/staff. (2) Novos endpoints de Super Admin em `adminRoutes`: `PATCH /api/admin/empresas/:id/toggle-status` (ativa/suspende) e `POST /api/admin/empresas/:id/hard-reset` **scoped à empresa** (apaga Propriedades + Tarefas + Ausências + Webhooks + Notificações dessa empresa, sem tocar noutras — substitui o `DELETE /api/admin/hard-reset` global). (3) `gestorController.getEquipa` passou a filtrar `ativo === true` e excluir `role === 'admin'`. (4) Sobreposição de ausências (`staffController.criarAusencia` + `faltaHoje`) passou a **excluir ausências rejeitadas** (só `aprovada`/`pendente` bloqueiam). (5) `criarTarefa` alargado para aceitar `hora`, `check_in`, `check_out`, `hospedes` (detalhes de reserva manuais). (6) Modelo `Notificacao` ganhou `tarefa_id` (referência à tarefa geradora). (7) Modelo `Propriedade` ganhou `observacoes` (texto livre). |
| Prompt 117 | — | **Endpoints de gestão de empresa (Super Admin):** novos endpoints em `adminRoutes` (auth + `isAdmin`): `GET /api/admin/empresas/:id/config` + `PUT /api/admin/empresas/:id/config` (ler/atualizar config da empresa — nome, NIF), `POST /api/admin/empresas/:id/sincronizar-propriedades` (importa propriedades da empresa), `POST /api/admin/empresas/:id/sincronizar-reservas` (sincroniza reservas da empresa), `POST /api/admin/empresas/:id/registrar-webhooks` (registar webhooks para a empresa). Reutilizam os controllers do `gestorController` com override do `empresa_id` a partir do URL. `geocoding.js` devolve flag `warning` (já existia desde Prompt 114) consumida agora inline no frontend. |
| Prompt 118 | — | **Sem alterações de backend:** trabalho exclusivamente frontend (staff dashboard agrupado por dia, `NotificationBell` com `max-h`, feedback de push, Exportar PDF via `window.print`). Os endpoints de notificações (`/api/auth/me/notificacoes/*`) e tarefas já existiam. |
| Prompt Extra | — | **Vacina Anti-Safari (sem alterações de backend):** helpers `parsearDataSegura` + `extrairHoraISO` introduzidos no **frontend** (`lib/utils.ts`). Backend sem alterações — a robustez de parsing é toda client-side. |
| Prompt 119 | — | **Resiliência PWA (sem alterações de backend):** configuração do Service Worker (`next-pwa`) é inteiramente frontend (`skipWaiting`, `clientsClaim`, runtime caching `NetworkFirst` em chunks, handler de `ChunkLoadError`). Backend sem alterações. |
| Prompt 120 | — | **Sem alterações de backend:** remoção do loop de reload (guard `sessionStorage`) e `mounted` guard na staff page — ambos frontend. |
| Prompt 121 | — | **Sem alterações de backend:** reposição de fábrica do layout + `next.config` minimalista — ambos frontend. |
| Prompt 122 | — | **Soft delete de empresas (Lixeira):** (1) Modelo `Empresa` ganhou campo `apagada` (boolean, default `false`). (2) `GET /api/admin/empresas` passou a suportar query `?inclui_apagadas=` — por defeito **exclui** empresas `apagada: true`. (3) Novo `DELETE /api/admin/empresas/:id` (soft delete — marca `apagada: true, ativa: false`, auditoria registada). (4) Novo `PATCH /api/admin/empresas/:id/restaurar` (desfaz soft delete — `apagada: false`; `ativa` mantém-se `false` — o admin deve reativar manualmente). Auditoria registada em ambos. |
| Prompt 123 | — | **Soft block de conflitos + Gemini SDK:** (1) `criarTarefa`/`atribuirTarefa`/`reatribuirTarefa` deixaram de devolver `409` em sobreposição horária do staff; agora devolvem `200` com flag `warning` (não bloqueia). O `warning` inclui o **tempo de viagem** estimado entre a tarefa anterior e a nova (Haversine + velocidade média). (2) **Gemini SDK** (`@google/generative-ai`) introduzido no `relatorioController.getResumoIA` (substitui fetch manual à API REST do Gemini). (3) Redistribuição de ausências aprovadas passou a **excluir ausências rejeitadas** (só `aprovada` contam para reatribuição). (4) `Propriedade.observacoes` exposto no detalhe de tarefa. (5) Validação de sobreposição robusta a fusos (data de calendário de Lisboa via `Intl`). |
| Prompt 124 | — | **Resumo IA exportável (PDF):** o `relatorioController.getResumoIA` (já existente desde Prompt 123) é consumido pelo frontend para gerar PDF via `html2pdf.js`. Backend sem alterações estruturais — apenas o endpoint `POST /api/gestor/relatorios/ai-summary` continua a devolver o resumo em linguagem natural. |
| Prompt 125 | — | **Gemini SDK consolidado + fuso de manutenção local:** (1) `getResumoIA` consolidado com o SDK `@google/generative-ai` + fallback gracioso se a API key estiver em falta (devolve mensagem padrão em vez de crashar). (2) Tarefas de manutenção geradas pelo sistema passam a ser criadas com instante local (não UTC midnight) para alinhar com o dia de calendário real. (3) Soft block de conflitos mantido (warning não-bloqueante). (4) `Propriedade.observacoes` passível de edição via `PUT /api/gestor/propriedades/:id`. |
| Prompt 126 | — | **Sem alterações de backend significativas:** UX logística (modais "Forçar Agendamento"/"Confirmar Morada"), PDF delay, `/gestor/notificacoes` são todos frontend. O backend continua a devolver `warning` (não-bloqueante) no `criarTarefa` para o modal de double-check. |
| Prompt 127 | — | **Sem alterações de backend:** fix de timezone (`extrairHoraISO` sem `new Date()`) é frontend. `AlertDialog` e loading do relatório também frontend. |
| Prompt 128 | — | **Blindagem backend — fuso Portugal + Gemini nunca crasha:** (1) Novo helper de offset que usa `Intl.DateTimeFormat` com `timeZone: 'Europe/Lisboa'` para calcular o offset de Lisboa (incluindo DST) — substitui a dependência do fuso do servidor (Render em UTC). Aplicado na normalização de datas de tarefas/ausências. (2) `getResumoIA` envolvido em try/catch abrangente — se a chamada ao Gemini falhar (quota, rede, JSON inválido), devolve um **placeholder hardcoded** ("Resumo temporariamente indisponível.") em vez de `500`. O relatório de produtividade principal (`getRelatorioProdutividade`) continua a funcionar mesmo com IA em baixo. |
| Prompt 129 | — | **Sem alterações de backend:** fix de timezone do calendário (strings locais sem `Z`) é frontend. A config do Service Worker (`publicExcludes /api/`) também frontend — garante que o SW não interceta pedidos à API (dados sempre frescos do backend). |
| Prompt 130 | — | **Fix definitivo de ausências (filtro de estado + remoção de índice único):** (1) `staffController.criarAusencia` passou a filtrar por `estado` ao verificar sobreposição de ausências — antes considerava TODAS (incluindo rejeitadas) e bloqueava a criação com `409`. Agora só `aprovada`/`pendente` contam para sobreposição. (2) `faltaHoje` recebeu o mesmo fix (filtro de estado na verificação de ausência existente). (3) **Root cause do 409 persistente:** identificado um **índice único MongoDB** legado (`utilizador_id_1_data_1`, sobre o campo `data`) que continuava ativo em produção e rejeitava ausências legítimas. O arranque do servidor passou a **remover o índice único** automaticamente (sem eliminar ausências existentes). Várias iterações de debug/logs (`55a7f00`, `48a985c`, `9afe73e`, `34a60c8`, `d8b395f`) até ao root cause final (`1a483f9` — índice era sobre `data`, não `data_inicio`). |
| Prompt 131 | — | **Staff notificações + nome_hospede + dias anteriores + remoção de índice único:** (1) Índice único MongoDB legado (`utilizador_id_1_data_1`) **removido definitivamente** no arranque do backend (script de migração que identifica e elimina o índice se existir). (2) `nome_hospede` (de `detalhes_reserva`) passou a ser populado/devolvido nos endpoints de tarefas do staff (`minhasTarefas`, `minhaTarefaDetalhe`). (3) Endpoints de tarefas do staff (`/api/auth/me/tarefas`) alargados para suportar navegação **até 30 dias para trás** (histórico de tarefas concluídas), além dos dias futuros. (4) Endpoints de notificações (`/api/auth/me/notificacoes/*`) consumidos pela nova página `/staff/notificacoes` (sem alteração de contrato). |

| Prompt 132 | — | **Cancelamento de ausências (soft cancel):** novo endpoint `PATCH /api/staff/ausencias/:id/cancelar` (em `ausenciaController.cancelarAusencia`) que marca `estado: 'cancelada'` e mantém o registo para auditoria (em vez de `DELETE` que apagava). A ausência cancelada deixa de contar para sobreposição mas o histórico fica visível. |
| Prompt 133 | — | **Arquitetura de checklists dinâmicas:** novo modelo `ModeloChecklist` (`empresa_id`, `nome`, `descricao`, `seccoes[{nome, items[]}]`). `Propriedade` ganhou `modelo_checklist_id`. `Tarefa` ganhou `checklist_dinamica` (snapshot). `criarTarefa` injeta o snapshot do modelo na criação. `minhaTarefaDetalhe` injeta on-the-fly se a tarefa não tem snapshot mas a propriedade tem modelo. Novo `checklistController` com CRUD (`/api/gestor/checklists`). `toggleChecklistItem` (PATCH) para marcar/desmarcar items individuais. |
| Prompt 134 | — | **Sem alterações de backend significativas:** ecrãs de configuração (`/gestor/configuracoes/checklists`) e interface do staff são frontend. O backend já tinha o CRUD de `ModeloChecklist` (Prompt 133) e o `toggleChecklistItem`. |
| Prompt 135 | — | **Seed de checklists:** novo script `scripts/seedChecklists.js` + endpoint `POST /api/admin/seed-checklists` que cria 2 modelos base (Limpeza Standard + Detalhada V2) e associa o Standard às propriedades sem modelo. Idempotente. |
| Prompt 136 | — | **Sem alterações de backend:** fix do PDF (abandono do `html2pdf.js` → `window.print()`) é inteiramente frontend. |
| Prompt 137 | — | **Sem alterações de backend:** fix do `nome_hospede` nos cartões do staff (repassar `detalhes_reserva` ao `TaskCard`) é frontend. O backend já guardava o campo corretamente. |

| Prompt 138 (136 V2) | — | **Cérebro do Scheduler e Gravação da Viagem:** (1) **Fix Matemática SLA (480 min)** — `carga_total` agora envolvida em `Number(...)` com validação `Number.isFinite()` (bugs de concatenação de strings do aggregate). Se TODOS os staff excederem 480 min, a tarefa é gravada com `estado: 'nao_atribuida'` (novo estado, distinto de `por_atribuir`). `determinarUtilizadorAtribuido` agora devolve `{ utilizadorId, tempoViagem }`. `reatribuirTarefa` e Algoritmo VIP também com `Number()`. (2) **Cap de GPS** — `calcularTempoViagem` (scheduler.js) impõe `Math.min(tempo, 60)` (teto 1h) e fallback de 30 min se coordenadas inválidas (antes devolvia 0). (3) **Campo `tempo_viagem_minutos`** — novo campo no modelo `Tarefa` (Number, default 0). Guardado pelo webhook (criarTarefaPorReserva), `reatribuirTarefa`, `autoAtribuirTarefas` e `caoGuarda.js` (Fail-Safe). (4) `atualizarEstadoTarefa` aceita `nao_atribuida` no enum. 151/151 testes ✓. |
| Hotfix | — | **Auditoria tolerante a `empresa_id` ausente (Satélite single-tenant):** o campo `empresa_id` do modelo `Auditoria` passou a `required: false` com `default: null`, deixando de falhar a validação quando não há empresa no contexto (ex.: Super Admin via SSO). O helper `utils/auditoria.js` (`registarAuditoria`) passou a `async`/`try-catch` best-effort: erros ao gravar fazem apenas `console.error` e nunca abortam o pedido principal (semântica de `next()` num middleware), eliminando os `502 Bad Gateway` em `/api/gestor/*`. Sem alterações de contrato nos endpoints. |
| Hotfix (HF3) | — | **Recetor de webhooks Smoobu re-introduzido (receção + log, sem processamento):** novo `backend/routes/smoobuRoutes.js` com `POST /api/smoobu/webhook` montado em `server.js`. O endpoint: (1) autentica via env var `SMOOBU_API_KEY` procurada em 3 headers (`X-Smoobu-Api-Key`, `Api-Key`, `Authorization: Bearer`) — se a env var não estiver definida, aceita em modo dev com warning; (2) grava o payload bruto em `WebhookLog` (`status: 'recebido'`) num bloco try/catch best-effort que **nunca crasha** o pedido (falha de BD → 200 com aviso, não 500); (3) rejeições de auth (401) também são gravadas em `WebhookLog` (`status: 'erro'`) para auditoria; (4) marca como `'processado'` e devolve 200 com `{ recebido, log_id, timestamp }`. A rota está **isenta do rate limiter global** (`skip: req.path.startsWith('/api/smoobu')`) porque webhooks M2M chegam de um IP único e podem burstar. Variável de ambiente `SMOOBU_API_KEY` adicionada ao `.env.example`. **IMPORTANTE — escopo:** a conversão reserva→tarefa (removida em F0 via `criarTarefaPorReserva`) **NÃO foi re-implementada** — o endpoint recebe e audita; o processamento de domínio é um follow-up documentado. 111/111 testes ✓. |
| Hotfix (HF4) | — | **Conversão de reservas Smoobu em tarefas reativada (lógica completa recuperada do Git):** (1) **Arqueologia Git** — identificado o commit F0 (`bd14ca8`) que removeu a integração; recuperados os 3 ficheiros originais (`webhookController.js` 1235 linhas, `smoobuController.js` 826 linhas, `webhookRoutes.js`) do commit imediatamente anterior (`681f807`); análise exaustiva via subagent de pesquisa extraiu TODAS as regras de negócio. (2) **Recriação de schema** — `Propriedade.smoobu_id` (String, sparse index, default null) e `Tarefa.smoobu_reserva_id` (String, sparse index, default null), removidos em F0 e essenciais para match de propriedade + idempotência. (3) **Novo `backend/controllers/smoobuController.js`** (~530 linhas) com: `extrairDadosReserva` (defensivo, cobre dezenas de variantes de payload Smoobu — `guestName`/`guest_name`/`guest-name`/`guest.name`/`firstName+lastName`); `enriquecerReservaSmoobu` (GET REST API Smoobu com timeout 15s + fallback gracioso); `criarTarefaPorReserva` (idempotência + match por `smoobu_id` + valida propriedade/empresa ativas + load balancer + scheduler + snapshot checklist_dinamica + 3 estados iniciais + notificação fire-and-forget); `cancelarTarefaPorReserva` (soft delete, liberta staff, idempotente); `atualizarTarefaPorReserva` (revalida disponibilidade sem shuffle); `processarReservaSmoobu` (dispatcher de ações CRIAR/ATUALIZAR/CANCELAR); `processarWebhookSmoobu` (orquestra + atualiza WebhookLog). (4) **Reutilização de `utils/loadBalancer.js`** (em vez de lógica inline duplicada do original) — mesma assinatura `determinarUtilizadorAtribuido(empresaId, range, coordenadas, tempo, propriedadeId)`, inclui Algoritmo VIP + SLA 480min + Haversine. (5) **`routes/smoobuRoutes.js` atualizado** — resposta 200 IMEDIATA (anti-timeout Smoobu) + `setImmediate` → `processarWebhookSmoobu` (fire-and-forget); resolve `empresa_id` best-effort via match de propriedade para o log. (6) **Regras preciosas preservadas:** tarefa no dia do CHECK-OUT (departure, não check-in); 1 tarefa por reserva (`tipo: 'limpeza'`); enriquecimento via REST API se faltar departure ou nome_hospede; fallback para arrival se enriquecimento falhar. `node --check` ✓ · 111/111 testes ✓. |
| Hotfix (HF5) | — | **Rota de importação/sincronização de propriedades Smoobu (`POST/GET /api/gestor/smoobu/propriedades`):** recupera a lógica `importarPropriedades` + `getPropriedadesSmoobu` do histórico Git (commit `681f807`) e adapta ao schema atual. (1) **`controllers/smoobuController.js`** estendido com: `extrairMoradaSmoobu(apt)` (helper que cobre 5 estruturas de morada do payload Smoobu: `location.{street,zip,city}`, `address` string/objeto, campos achatados, `full_address`); `buscarApartamentosSmoobu(apiKey)` (helper partilhado: GET `https://login.smoobu.com/api/apartments` com `AbortSignal.timeout(15000)`, valida JSON, extrai array `apartments` com fallbacks); `getPropriedadesSmoobu` (GET → `{ propriedadesSmoobu: [{ id, name }] }` para dropdown do frontend); `importarPropriedades` (POST → upsert em massa: cria novas com `smoobu_id`+nome+morada+coordenadas via `obterCoordenadas` (Nominatim)+`capacidade_hospedes`+`tempo_limpeza_minutos:45`; atualiza existentes — morada só se vazia/'A definir' (Prompt 104, edição manual tem prioridade), `capacidade_hospedes` sempre (Smoobu é fonte de verdade); match por `smoobu_id`+`empresa_id` multi-tenant safe). (2) **`routes/gestorRoutes.js`** — montadas `GET /smoobu/propriedades` + `POST /smoobu/propriedades` com `auth + isGestor`. (3) **Resposta POST** inclui contadores estruturados (`totalRecebidas, criadas, atualizadas, existentes, erros, detalheErros`) + `message` legível para toasts (satisfaz tanto o `propriedades/page.tsx` como o `configuracoes/page.tsx executarAcao`). (4) **Adaptação single-tenant:** `obterApiKeySmoobu()` lê `process.env.SMOOBU_API_KEY` diretamente (não recria `Empresa.smoobu_api_key` multi-tenant). (5) **Desbloqueia o HF4:** sem `Propriedade.smoobu_id` preenchido, o webhook `criarTarefaPorReserva` falhava com "Propriedade Smoobu X não encontrada"; esta rota é o passo prévio obrigatório. `node --check` ✓ · 111/111 testes ✓. |
| Hotfix (HF6) | — | **Migra gestão de integrações Smoobu e rotinas para o All2gether (descentralização arquitetural):** a configuração do Smoobu (api_key, ativo) e das rotinas de sincronização (frequência, estado) deixam de viver na Nave-Mãe (Autocell) e passam para o All2gether (separation of concerns). (1) **Schema `Empresa`** — novos sub-documentos: `integracoes.smoobu` (`api_key` String, `ativo` Boolean, `ultima_sincronizacao` Date) e `rotinas` (`sincronizacao_automatica` Boolean, `frequencia_horas` Number min 1 default 24). (2) **`obterApiKeySmoobu(empresaId)`** agora async, lê da Empresa (se `ativo: true`) com fallback a `process.env.SMOOBU_API_KEY` (retrocompatibilidade); devolve `{ chave, origem }` para diagnóstico. (3) **`routes/smoobuRoutes.js`** — webhook auth descentralizada: `validarChaveSmoobu()` procura empresa ativa com `integracoes.smoobu.api_key === chave`; fallback a env var; modo dev se ambas falharem. Resolve `empresaId` da empresa que matchou (prioridade sobre match por propriedade). (4) **Novo endpoint `GET/PUT /api/gestor/configuracoes/integracoes`** (`gestorRoutes.js`) — lê/guarda config; GET mascara a api_key (`••••••••1234`) + `configurado: boolean` (nunca expõe em claro); PUT aceita `smoobu.api_key` (undefined = mantém, "" = limpa), `smoobu.ativo`, `rotinas.sincronizacao_automatica`, `rotinas.frequencia_horas`. (5) **Novo cron job `jobs/sincronizacaoSmoobu.js`** — corre a cada hora (`15 * * * *`), itera empresas com `sincronizacao_automatica + smoobu.ativo`, verifica se `ultima_sincronizacao + frequencia_horas < agora`, dispara `importarPropriedades` (placeholder até `sincronizarReservas` ser portado), atualiza `ultima_sincronizacao`. Montado em `server.js`. (6) **`controllers/smoobuController.js`** — `enriquecerReservaSmoobu` e `processarReservaSmoobu` passam a aceitar `empresaId` para resolver a chave da BD. `node --check` ✓ · 111/111 testes ✓ · frontend `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF7) | — | **Restaura motor original de sincronização de reservas (`sincronizarReservas`) — o backfill em massa que faltava:** recuperado do commit pré-F0 `681f807` (2026-07-15) e adaptado ao HF6 (api_key via `Empresa.integracoes.smoobu`). (1) **`controllers/smoobuController.js`** — nova função `sincronizarReservas(req, res)`: puxa TODAS as reservas futuras do Smoobu (REST API `GET /api/reservations?arrivalFrom=YYYY-MM-DD&page=N` com paginação completa), mapeia cada reserva para o formato do webhook, verifica idempotência (`Tarefa.findOne({ smoobu_reserva_id })`), chama `processarReservaSmoobu(payload, empresaId)` (cria tarefas) ou `cancelarTarefaPorReserva` (se reserva cancelada no Smoobu — `status: 'cancelled'`), try/catch por reserva (uma falha não para as outras), atualiza `integracoes.smoobu.ultima_sincronizacao` no fim, devolve `{ totalRecebidas, importadas, criadas, existentes, erros, detalheErros, message }`. Cobertura exaustiva do nome do hóspede no formato REST API (`guestName`/`guest_name`/`guest-name`/`guest.name`/`firstName+lastName`/`customerName`/`bookedForName`/`name`). (2) **`routes/gestorRoutes.js`** — montada `POST /smoobu/sincronizar` com `auth + isGestor` (corrige o 404 do botão "Sincronizar Reservas" no painel de Configurações). (3) **`jobs/sincronizacaoSmoobu.js`** — o cron job passa a chamar `sincronizarReservas` (o motor real de reservas→tarefas) em vez do placeholder `importarPropriedades`. (4) **Adaptações HF6:** `obterApiKeySmoobu(empresaId)` devolve `{ chave, origem }` (lê-se `.chave`); `processarReservaSmoobu(payload, empresaId)` recebe `empresaId` para resolver a chave da BD ao enriquecer; `cancelarTarefaPorReserva` está no mesmo módulo (não em `./webhookController` como no original). `node --check` ✓ · 111/111 testes ✓ · frontend `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF8) | — | **Corrige auth do webhook + remove sincronização ativa desnecessária (sistema é 100% reativo a webhooks):** o utilizador esclareceu que o programa original NÃO fazia pedidos fetch ativos à API do Smoobu — era 100% orientado a eventos (webhooks). As funções `importarPropriedades`/`sincronizarReservas` causavam 502s porque não faziam parte do fluxo de produção real. Além disso, o `validarChaveSmoobu` (HF6) estava a rejeitar webhooks válidos do Smoobu. **(A) Correção do webhook auth (`routes/smoobuRoutes.js`):** 3 bugs corrigidos: (1) `extrairApiKey` agora cobre 7 headers em vez de 3 (`X-Smoobu-Api-Key`, `Api-Key`, `Authorization: Bearer`, `X-Smoobu-Webhook-Secret`, `Webhook-Secret`, `X-Webhook-Secret`, `Smoobu-Api-Key`) — o Smoobu pode usar qualquer um; (2) a query à BD NÃO exige mais `integracoes.smoobu.ativo: true` para AUTH (a presença da chave é suficiente; o `ativo` controla o processamento, não a validade da auth) — se `ativo: false`, devolve `origem: 'empresa_desativada'` e o webhook é aceite (200) mas o processamento é saltado (só log); (3) nova env var `SMOOBU_WEBHOOK_AUTH_DISABLED=true` desativa a auth completamente (para o caso do Smoobu não enviar headers — usar com allowlist de IP). Logs detalhados em caso de rejeição (mostra quais headers foram recebidos + causas possíveis). **(B) Remoção de sincronização ativa do frontend:** removidos os botões "Importar Propriedades" e "Sincronizar Reservas" da página `/gestor/configuracoes` (o card "Ações Smoobu" agora só tem "Registrar Webhooks" + "Logs de Webhooks Smoobu" + nota explicativa de que o sistema é reativo). Removido o import unused `Calendar` do lucide-react. **(C) Desativação do cron job:** `iniciarSincronizacaoSmoobu()` comentado em `server.js` (a função mantém-se exportada para uso manual via API direta, mas NÃO é agendada). **(D) Backend mantém `importarPropriedades`/`sincronizarReservas`** (não apagados) — podem ser úteis via API direta no futuro, mas sem UI nem cron. `node --check` ✓ · 111/111 testes ✓ · frontend `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF9) | — | **Fix de parse de data + alocação 1-para-1 + gestão de folgas rotativas:** 3 alterações críticas. **(1) Fix do bug de data:** `obterRangeDia(data)` em `utils/scheduler.js` chamava `data.getUTCFullYear()` assumindo que `data` era um objeto Date, mas recebia uma string `"YYYY-MM-DD"` do payload Smoobu (via `dataTarefaRaw` em `criarTarefaPorReserva`). Erro: `data.getUTCFullYear is not a function`. Fix: `const d = data instanceof Date ? data : new Date(data);` + validação `isNaN(d.getTime())` → devolve null se inválida. **(2) Regra 1-para-1 (Staff/Propriedade):** `Propriedade.funcionario_preferencial_id` passa a ser STRICT 1-para-1 — índice único parcial (`partialFilterExpression: { funcionario_preferencial_id: { $ne: null } }`) garante que um staff não pode ser preferencial de duas propriedades. `atualizarPropriedade` (gestorController) remove automaticamente o staff de qualquer outra propriedade onde ele fosse o preferencial (`Propriedade.updateMany` antes de atribuir). `criarTarefaPorReserva` (smoobuController) **ignora o load balancer** e atribui DIRETAMENTE ao `funcionario_preferencial_id` da propriedade. Import de `determinarUtilizadorAtribuido` removido (não usado). Estados: `atribuida` (staff disponível) ou `por_atribuir` (sem staff exclusivo / inativo). **(3) Gestão de folgas rotativas:** novo campo `folgas_rotativas: [{ data: Date, motivo: String }]` no schema `Utilizador` (datas específicas de folga além das fixas semanais `dias_folga`). Novo campo `alerta: String` no schema `Tarefa` (para avisos automáticos do webhook). Em `criarTarefaPorReserva`: se o staff exclusivo estiver de folga no dia do check-out (verifica `dias_folga` por dia da semana + `folgas_rotativas` por data exacta YYYY-MM-DD), a tarefa é criada com `estado: 'por_atribuir'` + `alerta: 'Staff exclusivo de folga (motivo)'`. Se não houver staff exclusivo: `alerta: 'Sem staff exclusivo atribuído à propriedade'`. Logs detalhados para cada cenário. `node --check` ✓ · 111/111 testes ✓ · frontend `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF11) | — | **Sistema híbrido de atribuição (Many-to-One + Load Balancer) — reverte HF9:** o cliente esclareceu que não quer 1-para-1 estrito global, mas sim um sistema híbrido: um staff pode ser exclusivo de múltiplas propriedades (X, Y, Z), e as propriedades sem staff exclusivo (ou cujo staff exclusivo está de folga) devem ser distribuídas pela restante equipa via Load Balancer. **(1) Reverter cadeado na BD (`models/Propriedade.js`):** removido o índice único `funcionario_preferencial_unique_1to1` (criado em HF9). Um staff pode agora ser o preferencial de múltiplas propriedades. Adicionado bloco no arranque do `server.js` (junto ao de Ausência) que faz drops explícito do índice legacy se existir na BD — índices MongoDB NÃO são auto-removidos quando desaparecem do schema Mongoose. **(2) Reverter desassociação automática (`gestorController.js atualizarPropriedade`):** removido o `Propriedade.updateMany` que desassociava o staff de propriedades anteriores ao atribuí-lo a uma nova. O staff acumula propriedades. **(3) Restaurar Load Balancer (`smoobuController.js criarTarefaPorReserva`):** reimportado `determinarUtilizadorAtribuido` de `utils/loadBalancer.js`. Nova lógica híbrida: (a) se a propriedade TEM `funcionario_preferencial_id` e ele NÃO está de folga → atribui diretamente a ele; (b) se a propriedade NÃO tem staff exclusivo, OU se o staff exclusivo está de folga/inativo → fallback para `determinarUtilizadorAtribuido` (LB com SLA 480min + Haversine + Algoritmo VIP + ausências); (c) se o LB também não encontrar ninguém → `estado: 'nao_atribuida'` + `alerta`. Alertas inteligentes: se o staff exclusivo está de folga MAS o LB encontrou substituto, NÃO gera alerta (tarefa atribuída); só gera alerta se o LB também falhou ("Staff exclusivo de folga (motivo) — sem substituto disponível" ou "Sem staff disponível (load balancer não encontrou ninguém)"). Estados restaurados a 3: `atribuida` / `nao_atribuida` (LB tentou, SLA excedido) / `por_atribuir` (erro no LB). `tempo_viagem_minutos` restaurado (LB + scheduler). `node --check` ✓ · 111/111 testes ✓ · frontend `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF12) | — | **Otimização do Load Balancer para paralelizar tarefas (Earliest Start Time):** o cliente identificou estrangulamento — um funcionário recebia tarefas em cascata até às 16h enquanto outros ficavam livres desde o meio-dia. Causa: o LB escolhia o staff com **menor `cargaTotal`** (carga de limpeza + viagem + nova), o que fazia o MESMO staff continuar a receber tarefas até encher o SLA (480min). **(1) `utils/loadBalancer.js` — nova métrica PRINCIPAL:** `determinarUtilizadorAtribuido` agora escolhe o staff com **Earliest Start Time** (quem consegue começar mais cedo, via `calcularInicioTarefaUtilizador` — considera última tarefa do dia + tempo de viagem + proteção de almoço). Isto paraleliza o trabalho entre a equipa. **Tie-breakers** (se empate no Earliest Start Time): 1º menos tarefas atribuídas nesse dia (nova função `contarTarefasDia` + aggregate `$sum: 1`); 2º menor tempo de viagem Haversine (mais perto geograficamente). Nova função `ehMelhorCandidato(candidato, atual)` compara por ordem: `earliestStart` → `numTarefas` → `tempoViagem`. Pré-busca agregada de cargas + contagens em 2 queries (em vez de N por staff). SLA 480min mantido (exclui quem excede). VIP mantido (respeitado se passado `propriedadeId`). Log do vencedor: `✅ [HF12] Load Balancer: staff X eleito (início=..., tarefas no dia=N, viagem=Mmin)`. **(2) `controllers/smoobuController.js` — flexibilidade VIP (HF12):** quando o staff exclusivo (VIP) só consegue começar a tarefa depois das 14h local (13:00 UTC — carga alta), faz fallback ao LB para garantir que a casa fica pronta cedo. Constante `VIP_LIMITE_HORA_UTC = 13`. Se o VIP está sobrecarregado, NÃO passa `propriedadeId` ao LB (para o LB não voltar a atribuir ao VIP — anularia o fallback). Alerta informativo: "Staff exclusivo sobrecarregado (início após 14h) — redistribuído para X" (não bloqueante). `node --check` ✓ · 111/111 testes ✓ · frontend `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF13) | — | **Corrige banner impersonação + remove menu Integrações + enriquece módulo de avarias:** 3 ajustes. **(1) Bugfix banner impersonação (`frontend/src/app/login/page.tsx`):** no `handleLogin`, após `limparCacheAuth()`, adicionado `sessionStorage.removeItem("all2gether_impersonating")` + `removeItem("all2gether_auto_impersonado")`. Sem isto, se um utilizador fez logout de uma sessão impersonada mas as flags ficaram no sessionStorage, o `<ImpersonationBanner>` aparecia indevidamente no próximo login normal. O banner só aparece se a flag for ativamente definida pelo `<AutoImpersonarEmpresa/>`. **(2) Remover menu Integrações (`gestor-sidebar.tsx`):** removido o item `{ label: "Integrações", href: "/gestor/configuracoes/integracoes", icon: Plug }` (adicionado em HF6) + import `Plug` do lucide-react. A página `/gestor/configuracoes/integracoes` mantém-se acessível via URL direta para gestão da API key, mas não é exposta na navegação principal (sistema agora usa webhooks exclusivamente). **(3) Módulo de avarias enriquecido (3 camadas):** (a) **Schema `Tarefa.avarias`** migrado de `[String]` para `[{ descricao: String, fotos: [String], resolvido: Boolean, data_registo: Date }]` — retrocompatível (strings legacy são lidas pelo frontend como objetos); (b) **`staffController.reportarAvaria`** atualizado para aceitar `fotos` (array de strings base64/URLs, máx. 5) no `req.body` + fazer `push` do objeto rico em vez de string; valida `fotos` como array; (c) **UI `detalhe-tarefa-client.tsx`** enriquecida: novo estado `avariaFotos: string[]` + funções `handleSelecionarFotos` (FileReader → base64, máx. 5 fotos, 2MB cada, só imagens) + `removerFoto(index)`; modal atualizado com secção "Fotos (opcional)" — input `type="file" accept="image/*" multiple` (escondido, label custom com ícone `Camera`), preview em thumbnails 80×80 com botão `X` para remover, contador "(N/5)"; reset do estado ao fechar o modal. Teste `integration.test.js` atualizado para o novo schema (`avarias[0].descricao` em vez de `avarias[0]`). `node --check` ✓ · 111/111 testes ✓ · frontend `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF14) | — | **Renderização das avarias no painel do Gestor (complementa HF13):** o HF13 enriqueceu o schema `Tarefa.avarias` de `[String]` para `[{ descricao, fotos, resolvido, data_registo }]` e atualizou o controller + UI do staff, mas o modal de detalhe do gestor (`detalhe-tarefa-modal.tsx`) continuava a renderizar `{a}` como string (linha 273). **(1) `detalhe-tarefa-modal.tsx`:** nova interface `AvariaDTO { descricao, fotos?, resolvido?, data_registo? }` exportada; `TarefaDetalheGestor.avarias` passa a `AvariaDTO[] \| string[]` (retrocompatível). Novo helper `normalizarAvaria(a)` converte strings legacy para `{ descricao: a, resolvido: false }`. Novo helper `formatarDataAvaria(data)` formata para pt-PT (dd/MM/yyyy HH:mm). Renderização enriquecida: cada avaria mostra descrição (font-medium) + Badge "Resolvido" (se `resolvido: true`, ícone `CheckCircle2`) + data de registo + thumbnails 64×64 das fotos (click abertas em nova aba). Imports `Camera` e `CheckCircle2` adicionados ao lucide-react. **(2) `tarefas/page.tsx`:** a interface `TarefaMock.avarias` mantém-se como `string[]` mas só usa `.length` (contagem) e `Array.isArray` — não acede ao conteúdo, pelo que a mudança de schema não afeta a listagem/filtro. `tsc` 0 erros ✓ · `next lint` limpo ✓ · backend 111/111 testes ✓ (não foi tocado). |
| Hotfix (HF15) | — | **Visibilidade do logout em mobile (staff + gestor):** o botão "Terminar Sessão" não aparecia em ecrãs mobile em várias páginas do staff e no menu mobile do gestor. **(1) Gestor (`gestor-sidebar.tsx`):** o overlay mobile (menu hamburger) só tinha `Brand` + `NavLinks` — sem logout, sem notificações, sem theme toggle. Adicionado bloco `mt-auto` no fundo do overlay com os mesmos elementos do sidebar desktop: NotificationBell + ThemeToggle + botão "Terminar Sessão" (ícone `LogOut`) + copyright. **(2) Staff — 3 páginas sem logout:** (a) `/staff/calendario` — adicionado botão logout no canto direito do header (layout `flex items-start justify-between`); (b) `/staff/ausencias` — mesmo padrão; (c) `/staff/notificacoes` — mesmo padrão. Imports `LogOut` (lucide-react) + `fazerLogout` (`@/lib/auth`) adicionados a cada página. A página principal `/staff/page.tsx` já tinha logout no header (Prompt 114) — não foi alterada. Novo componente `StaffHeader` criado em `components/staff/staff-header.tsx` para futura reutilização (não foi aplicado retroativamente para evitar refactor grande). `tsc` 0 erros ✓ · `next lint` limpo ✓ · backend 111/111 testes ✓ (não foi tocado). **Nota:** o ponto 2 (otimização do Load Balancer com Earliest Start Time) já estava implementado desde HF12 (commit `c700a8f`) — não foi necessária alteração. |
| Hotfix (HF16) | — | **Fase 2 — Reescrita total do Load Balancer com 4 fatores de scoring:** `determinarUtilizadorAtribuido` reescrito com algoritmo de escala empresarial. **(1) Agrupamento Diário (Same-Day Clustering):** se o staff já tem uma tarefa na MESMA propriedade nesse dia, recebe bónus de 120 min (2h) no score — minimiza deslocações entre quartos do mesmo edifício. Nova função `temTarefaNaMesmaPropriedade(utilizadorId, propriedadeId, range)`. **(2) Google Maps Distance Matrix API (`distancia.js`):** nova função `calcularTempoViagemReal(origem, destino)` que tenta usar a API com `GOOGLE_MAPS_API_KEY`; fallback silencioso para Haversine se: (a) env var não existir; (b) API falhar (5s timeout); (c) resposta inválida. Cache em memória (TTL 5min) para evitar chamadas repetidas. Nova função `tempoViagemHaversine` extraída do scheduler. **(3) Equidade Semanal + Rotatividade:** removida a lógica antiga de "menos tarefas no dia". Nova função `calcularCargaSemanal(empresaId, utilizadorId, dataReferencia)` soma horas da semana (seg a dom) — penalização de 10 min por hora semanal acumulada. Nova função `limpouPropriedadeOntem(utilizadorId, propriedadeId, dataReferencia)` — penalização de 30 min se o staff limpou a mesma propriedade ontem (força rotação). **(4) Paralelização (Earliest Start Time):** mantido do HF12 como métrica temporal — minutos desde meia-noite UTC do earliest start. **Score FINAL:** `minutos_início - bónus_clustering + penalização_equidade + penalização_rotação + tempo_viagem` (menor = melhor). Pesos: `PESO_CLUSTERING=120`, `PESO_ROTATIVIDADE=30`, `PESO_EQUIDADE_HORA=10`. VIP, SLA 480min, ausências, folgas fixas/rotativas e proteção de almoço todos mantidos. Logs detalhados por staff (score + fatores). `node --check` ✓ · 111/111 testes ✓ · frontend `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF17) | — | **Fase 3 — Arquitetura híbrida para propriedades manuais + novo role de parceiro (B2B):** o sistema passa a suportar propriedades manuais (não-Smoobu) e utilizadores externos (parceiros) que podem criar as suas próprias casas e agendar limpezas. **(1) Novo role 'parceiro' (`models/Utilizador.js`):** enum de role alargado de `['admin','gestor','staff']` para `['admin','gestor','staff','parceiro']`. Novo middleware `isParceiro` em `middleware/requireRole.js` (usando `requireRole('parceiro')`). **(2) Propriedades Híbridas (`models/Propriedade.js`):** novos campos `origem: { type: String, enum: ['smoobu','manual'], default: 'manual' }` e `parceiro_id: { type: ObjectId, ref: 'Utilizador', default: null }` (indexado). O campo `smoobu_id` já tinha `sparse: true` (desde HF4) — permite múltiplas propriedades manuais com `smoobu_id: null` sem violar índices. **(3) Tarefas Híbridas (`models/Tarefa.js`):** novo campo `origem: { type: String, enum: ['smoobu','manual'], default: 'manual' }`. O campo `smoobu_reserva_id` já tinha `sparse: true` (desde HF4). **(4) Novo controller `controllers/parceiroController.js`:** 4 funções — `criarPropriedade` (POST /api/parceiro/propriedades: cria casa manual com geocoding Nominatim, `origem: 'manual'`, `smoobu_id: null`, `parceiro_id: req.user.id`); `listarPropriedades` (GET: lista as do parceiro); `criarTarefa` (POST /api/parceiro/tarefas: cria limpeza manual `origem: 'manual'`, `smoobu_reserva_id: null`, `estado: 'por_atribuir'`, valida que a propriedade pertence ao parceiro); `listarTarefas` (GET: lista tarefas das propriedades do parceiro). **(5) Novo router `routes/parceiroRoutes.js`:** 4 rotas com `auth + isParceiro`. Montado em `server.js` como `app.use('/api/parceiro', parceiroRoutes)`. `node --check` ✓ em 7 ficheiros · 111/111 testes ✓ (nulls em smoobu_id/smoobu_reserva_id não quebram a BD — sparse indexes já existiam). |
| Hotfix (HF18) | — | **UI no gestor para propriedades manuais e tarefas espontâneas:** os parceiros não criam tarefas nem propriedades diretamente — quem cria é sempre o Gestor. **(1) Backend:** `criarPropriedade` (`gestorController.js`) atualizado para aceitar `parceiro_id` opcional e definir `origem: 'manual'`. Nova função `criarTarefaEspontanea` (`tarefaController.js`) — cria limpeza manual com `origem: 'manual'`, `smoobu_reserva_id: null`, aceita `observacoes` e `utilizador_id` opcional (se vier, atribui diretamente saltando o LB; se não, fica `por_atribuir`). Import `registarAuditoria` adicionado ao `tarefaController.js` (estava em falta — corrigido bug latente). Rota `POST /api/gestor/tarefas/espontanea` montada em `gestorRoutes.js`. **(2) Frontend propriedades:** botão "Adicionar Manual" (ícone `Building2`) + Dialog com formulário (Nome, Morada, Tempo de Limpeza) que faz `adminPost("/api/gestor/propriedades")`. **(3) Frontend tarefas:** botão "Limpeza Espontânea" (ícone `SprayCan`) + Dialog com select de Propriedade, input de Data, input de Hora, Textarea de Observações, select opcional de Staff — faz `adminPost("/api/gestor/tarefas/espontanea")`. Reutiliza as listas `propriedades` e `staff` já carregadas (sem pedidos extra). `tsc` 0 erros ✓ · `next lint` limpo ✓ · backend 111/111 testes ✓. |
| Hotfix (HF19) | — | **Fotos obrigatórias na conclusão + cron job de limpeza aos 7 dias:** **(1) Schema (`models/Tarefa.js`):** novos campos `fotos_conclusao: [String]` (default []) e `data_conclusao: Date` (default null). **(2) Backend (`staffController.js concluirTarefa`):** regra bloqueadora — rejeita a conclusão (400) se `fotos_conclusao` estiver vazio ou não for enviado. Aceita máximo 5 fotos (strings base64/URLs). Atualiza `estado: 'concluida'`, `concluida_em`, `hora_conclusao`, `data_conclusao` e `fotos_conclusao`. **(3) Frontend (`detalhe-tarefa-client.tsx`):** `handleConcluir` agora abre um modal (Dialog) em vez de chamar a API diretamente. Modal com: preview de fotos em thumbnails 80×80 com botão X para remover, input `type="file" accept="image/*" multiple` (máx. 5, 2MB cada, FileReader → base64), aviso "⚠️ É obrigatório anexar pelo menos 1 foto" quando vazio, botão "Confirmar Conclusão" desativado se `concluirFotos.length === 0`. Em sucesso, mostra mensagem verde + redireciona para `/staff`. Import `AlertCircle` adicionado. **(4) Cron job (`jobs/limpezaFotos.js`):** corre todos os dias às 03:00 (`0 3 * * *`). Procura tarefas `concluida` com `data_conclusao < agora - 7 dias` E que ainda têm fotos. Esvazia `fotos_conclusao = []` e itera sobre `avarias[*].fotos = []` para limpar fotos das avarias. Log: `✅ [LimpezaFotos] N tarefa(s) limpa(s), M foto(s) removida(s)`. Montado em `server.js` após `iniciarArquivista()`. Teste atualizado para enviar `fotos_conclusao` no PATCH de conclusão. `node --check` ✓ · 111/111 testes ✓ · `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF20) | — | **HR: ausências por intervalo de datas + calendário global da equipa:** **(1) Backend confirmado:** `Ausencia.js` já suporta `data_inicio` + `data_fim` (intervalos) desde v1.8.0. `ausenciaController.registarAusencia` aceita intervalos. `loadBalancer.js` já filtra por `data_inicio <= range.start AND data_fim >= range.start` (bloqueia atribuição durante todo o período de férias). Sem alterações de backend necessárias. **(2) Frontend ausências (`/gestor/ausencias/page.tsx`):** adicionado botão "Nova Ausência" + modal (Dialog) com Date Range Picker: select de Funcionário (carregado de `/api/gestor/equipa`, filtrado a `role==='staff' && ativo`), input `type="date"` para Data de Início, input `type="date"` para Data de Fim, select de Tipo (Férias/Doença/Outro), input de Notas. Validações: `data_fim >= data_inicio`. Faz `adminPost("/api/gestor/ausencias", { utilizador_id, data_inicio, data_fim, tipo, notas })`. Imports `Plus`, `Input`, `adminPost`, `UtilizadorDTO` adicionados. **(3) Frontend calendário (`/gestor/calendario/page.tsx`):** adicionada terceira vista "Equipa" ao toggle existente (Calendário/Tabela/Equipa). Novo componente `EquipaMapa` que mostra uma tabela: linhas = staff, colunas = dias do período (até 31 dias). Cada célula tem cor conforme o estado: verde (disponível), azul (tarefas atribuídas, mostra nº), vermelho (ausência/férias), âmbar (folga fixa). Deteta tarefas por `utilizador_id + data`, ausências por eventos `allDay` do FullCalendar, folgas por `dias_folga` do staff. Legenda visual + resumo. Import `Users` adicionado ao lucide-react. `tsc` 0 erros ✓ · `next lint` limpo ✓ · backend 111/111 testes ✓. |
| Hotfix (HF21) | — | **Suporte para múltiplos funcionários por tarefa + atualização do load balancer:** **(1) Schema Propriedade (`models/Propriedade.js`):** novo campo `staff_necessario: { type: Number, default: 1, min: 1 }`. Se > 1, o LB atribui uma equipa de N. **(2) Schema Tarefa (`models/Tarefa.js`):** novo campo `equipa_atribuida: [ObjectId]` (ref 'Utilizador', default []). `utilizador_id` mantém-se como o vencedor #1 (retrocompatibilidade total — zero breaking changes). Se `equipa_atribuida` estiver vazia, a tarefa tem 1 staff (`utilizador_id`). **(3) Load Balancer (`utils/loadBalancer.js`):** nova função `determinarEquipaAtribuida(empresaId, range, coordenadas, tempo, propriedadeId, numStaffNecessario)`. Se N=1, delega para `determinarUtilizadorAtribuido` (comportamento original). Se N>1, chama `determinarUtilizadorAtribuido` iterativamente e devolve Top N (com exclusão dos já escolhidos). Se houver menos disponíveis, devolve os que estiverem + flag `insuficiente: true`. `smoobuController.js` atualizado para usar `determinarEquipaAtribuida` quando `propriedade.staff_necessario > 1`. Preenche `utilizador_id` (vencedor #1) + `equipa_atribuida` (todos). Alerta "Equipa parcial: X/N staff disponíveis" se insuficiente. **(4) Frontend:** `PropriedadeDTO` em `lib/api.ts` ganhou `staff_necessario?: number`. Modal de "Adicionar Propriedade Manual" em `/gestor/propriedades` tem novo campo "Nº de Staff Necessário" (input number min=1 max=10). `gestorController.criarPropriedade` aceita `staff_necessario` no body. `node --check` ✓ · 111/111 testes ✓ · `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF22) | — | **Rotinas automáticas: dias fixos de limpeza + cron job gerador de tarefas:** **(1) Schema Propriedade (`models/Propriedade.js`):** novo campo `dias_fixos_limpeza: [Number]` (0=Dom, 1=Seg, ..., 6=Sáb — standard JS `getDay()`), com validação de inteiros 0-6. `gestorController.criarPropriedade` aceita `dias_fixos_limpeza` no body (filtra inválidos). **(2) Frontend (`/gestor/propriedades`):** `PropriedadeDTO` em `lib/api.ts` ganhou `dias_fixos_limpeza?: number[]`. Modal "Adicionar Propriedade Manual" tem novo grupo de 7 checkboxes (Seg-Dom) com toggle visual (border-primary + bg-primary/10 quando selecionado). Converte seleção em array de números ordenado. **(3) Cron job (`jobs/geradorRotinas.js`):** corre todos os dias às 02:00 (`0 2 * * *`). Lógica: descobre o dia da semana de amanhã; procura propriedades ativas (de empresas ativas) com esse dia no `dias_fixos_limpeza`; verifica idempotência (não cria se já existe tarefa para amanhã); cria tarefa (`origem: 'manual'`, `estado: 'por_atribuir'`, `data: amanhã 10:00 UTC`); submete ao LB — se `staff_necessario > 1` usa `determinarEquipaAtribuida`, senão `determinarUtilizadorAtribuido`; se o LB atribui, atualiza `utilizador_id` + `equipa_atribuida` + `estado: 'atribuida'`; se não, fica `por_atribuir` (gestor resolve). Log detalhado: `🔄 [GeradorRotinas] N tarefa(s) criada(s), M atribuída(s), E com erro.` Montado em `server.js` após `iniciarLimpezaFotos()`. `node --check` ✓ · 111/111 testes ✓ · `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF23) | — | **Morada estruturada + `parceiro_id` relacional + `nif`/`observacoes` no Utilizador + página Parceiros + soft-delete com desatribuição:** (1) **Schema `Propriedade`** — `morada` deixou de ser `required` (default `''`); novo sub-documento `morada_estruturada: { rua, codigo_postal, cidade }` (todos default `''`, trim) para morada decomposta (geocoding mais preciso); virtual `moradaCompleta` concatena os 3 ou faz fallback para `morada` legado. Novos campos HF23 de gestão: `nome_responsavel`, `contacto`, `frequencia_limpeza` (`enum: ['semanal','quinzenal','mensal']`, default `'semanal'`), `horario_limpeza`. (2) **Schema `Utilizador`** — novos campos `nif: String, default: ''` e `observacoes: String, default: ''` (notas internas do gestor). (3) **Página `/gestor/parceiros`** — nova rota `GET /api/gestor/parceiros` (`getParceiros` em `gestorController.js`) que lista utilizadores com `role: 'parceiro'` (ativos E inativos, para reativação; exclui eliminados). (4) **Soft-delete com desatribuição** — `alternarEstadoMembro` (`PATCH /api/gestor/equipa/:id/estado`) ao inativar staff/gestor chama `desatribuirTarefasPeriodo(utilizadorId, hoje, +1ano)`; resposta inclui `tarefas_desatribuidas`. `getEquipa` agora mostra ativos E inativos (removido filtro `ativo: true`) e exclui parceiros (`role: { $nin: ['admin','parceiro'] }`). Best-effort — a inativação nunca falha por causa de um erro na desatribuição. `node --check` ✓ · `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF24) | — | **Reatribuição automática inteligente + hard-delete para admin + Google Maps integration + limpeza de UI:** (1) **`reatribuirTarefasPeriodo(empresaId, utilizadorId, inicio, fim)`** em `ausenciaController.js` — após `desatribuirTarefasPeriodo`, executa o load balancer para cada tarefa `por_atribuir` do período, tentando alocá-la a outro staff ATIVO, DISPONÍVEL (sem folga/ausência) e com menor carga; exclui o utilizador ausente via `excluirStaffIds`; recalcula hora via scheduler; se não houver staff elegível, mantém `por_atribuir`; best-effort com try/catch por tarefa e global. Usada por `aprovarRejeitarAusencia` (ausência aprovada) e `reaplicarAusencia`. (2) **Hard-delete de propriedades** — `DELETE /api/gestor/propriedades/:id?hard=true` (`eliminarPropriedade`) apaga a propriedade E as tarefas futuras não concluídas; exclusivo para `role: 'admin'` (403 caso contrário). Sem `?hard=true` → soft-delete padrão (`ativo=false` + desatribui tarefas futuras). (3) **Google Maps integration (commit `97c6832`)** — `utils/geocoding.js` usa `GOOGLE_MAPS_API_KEY` (Google Maps Geocoding API) como prioridade para geocoding de moradas, com fallback silencioso para Nominatim (OpenStreetMap) se a key não existir ou falhar. Nova função `googleMapsAtivo()` exportada. `utils/distancia.js` JÁ usava `GOOGLE_MAPS_API_KEY` para Distance Matrix API (HF16, com fallback Haversine). `GET /api/gestor/configuracoes/integracoes` devolve `google_maps_ativo: boolean`. (4) **Limpeza de UI** — correções menores de UI no painel do gestor. `node --check` ✓ · `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Hotfix (HF25) | — | **Associação relacional de parceiros (populate) + status Smoobu real + configs restritas a admin + limpeza dev UI:** (1) **`getPropriedades` (`gestorController.js`)** — passou a popular `parceiro_id` com `nome`/`email`/`role`, permitindo ao frontend mostrar o Badge do parceiro diretamente sem extrair da string legacy "Parceiro Associado: [nome]" das `observacoes`. (2) **`smoobu_ativo: boolean` na resposta de `GET /api/gestor/configuracoes/integracoes`** — estado real da integração Smoobu: `true` se houver chave na BD (`integracoes.smoobu.api_key`) OU env var `SMOOBU_API_KEY`. Substitui o antigo `configurado` (que só refletia a BD). (3) **Configs restritas a admin** — `PUT /api/gestor/configuracoes/integracoes` torna-se mais restritivo: apenas `role: 'admin'` pode alterar a `api_key` do Smoobu; gestores continuam a poder consultar (`GET`) e ajustar as rotinas. (4) **Limpeza dev UI** — remover botões/links de desenvolvimento (ex.: setup temporário via browser) que estavam a poluir o painel. `node --check` ✓ · `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Fix UI | — | **6 correções de UI pedidas pelo cliente:** **(1) Filtros default** — Equipa: `filtroEstado` default `"ativos"` (antes `"todos"`); Propriedades: novo select de Estado com `"Ativos"` pré-selecionado. Multiselects de "Propriedades Alocadas" (form Staff) e "Equipa Preferencial" (form Propriedade) filtram para mostrar **estritamente** ativos (mantêm visíveis os já selecionados mesmo se inativos, para poder desmarcar). **(2) Toggle "Exclusivo"** — novo campo `exclusivo_preferenciais` (Switch) exposto no form de criação/edição de Staff (abaixo do select de propriedades alocadas); enviado em POST/PUT e carregado do DTO ao editar. Novo componente `ui/switch.tsx`. **(3) Ausências** — removidas as Tabs; view única com tabela de ausências + painel inferior de Folgas Fixas; novo filtro Estado (Todos/Pendentes/Aprovadas/Passadas/Rejeitadas/Canceladas) + filtro Mês (`input type="month"`); correção da lógica de estado: ausências com `data_fim < hoje` são exibidas como "Concluída" (se aprovada) ou "Passada" (se pendente) em vez de "Aprovada"/"Agendada". **(4) Calendário** — eventos allDay (Folgas/Férias) compactos via CSS (`globals.css`: padding 1px 4px, font 0.6875rem, min-height 15px); sincronização de Folgas Fixas corrigida no backend (`getDadosCalendario`: `getDay()` → `getUTCDay()` — as datas estão a meia-noite UTC e o offset do fuso do servidor deslocava o dia da semana); nome do staff no modal de detalhe é clicável (`Link` para `/gestor/equipa?editar=<id>`, abre auto o modal de edição). **(5) Checklists** — nova rota `/gestor/checklists` (página própria, re-exporta o componente existente); sidebar atualizada para apontar para a nova rota. **(6) Eliminar Limpezas Futuras** — botão "Eliminar Futuras" (`DELETE /api/gestor/tarefas/futuras`) no header de Tarefas e Calendário + botão "Cancelar Limpeza" no modal de detalhe do calendário. `tsc` 0 erros ✓ · `next lint` limpo ✓. |
| Fix UI 2 | — | **5 ajustes visuais + bug folgas + isolamento de ações de massa:** **(1) Badge "Exclusivo 🔒"** na tabela de Equipa (junto ao nome) sempre que `exclusivo_preferenciais` for true (ícone `Lock` + tooltip). **(2) Calendário** — `dayMaxEvents={2}` no FullCalendar (excesso de eventos allDay fica em botão "+X mais"); **bug das folgas fixas** corrigido de raiz: backend `getDadosCalendario` iteração agora usa `setUTCDate`/`getUTCDate` (antes `setDate`/`getDate` que são locais e causavam drift em servidores não-UTC); frontend folga_fixa event `start` passa a `YYYY-MM-DD` (date-only, sem Z) para o FullCalendar não aplicar conversão de fuso aos eventos allDay (isto causava falsos positivos a cair no Sábado). **(3) Links nas Folgas Fixas** — nome do staff na secção de Folgas Fixas de `/gestor/ausencias` é agora `<Link>` para `/gestor/equipa?editar=<id>` (abre modal de edição). **(4) Ações de Massa isoladas no Admin** — removido o botão "Eliminar Futuras" das páginas de Tarefas e Calendário; secção renomeada para "Ações de Manutenção" em `/gestor/configuracoes/integracoes` com botões "Eliminar Limpezas Futuras" + "Sincronizar Smoobu" + "Importar Propriedades"; a secção só é visível para `role === 'admin'` (guarda UI); backend `DELETE /tarefas/futuras` e `POST /smoobu/sincronizar` passaram de `isGestor` para `isAdmin` (defesa em profundidade — gestores já não conseguem chamar estes endpoints via API direta). **(5) Bug teimoso do status Smoobu** — backend `smoobu_ativo` agora avalia `process.env.SMOOBU_API_KEY` em primeiro lugar (com fallback à chave da BD); proxy route `/api/gestor/[...path]` ganhou `export const dynamic = "force-dynamic"` + `revalidate = 0` para nunca servir cache; frontend `integracoes/page.tsx` faz cache-busting com `?_t=${Date.now()}` e lê `smoobu_ativo` com fallback a `env_var_ativa` + `configurado`. `tsc` 0 erros ✓ · `next lint` limpo ✓ · `node --check` backend ✓. |
| Fix UI 3 | — | **Restauro de nomes no calendário + centralização de ações Smoobu nas configs principais:** **(1) Nomes desaparecidos no calendário** — o ajuste anterior para tornar as barras allDay compactas ocultou o nome do staff nas Folgas Fixas (mostrava apenas "—"). Causa raiz: `renderEventContent` não tinha um ramo dedicado para `folga_fixa`, pelo que caía no ramo genérico que usa `propriedade_id?.nome` (que é `null` para folgas → "—"). Adicionado ramo dedicado `if (isFolga)` que usa `arg.event.title` (que o backend define como `"Folga - {nome}"`) ou `t.utilizador_id?.nome`. CSS novo: `fc-evt-month--folga` e `fc-evt-block--folga` (barra cinzenta compacta com nome legível). **(2) Página principal de Configurações** — o cliente acede a `/gestor/configuracoes` (não à sub-página de integrações) pelo menu lateral. Corrigido: (a) backend `GET /api/gestor/configuracoes` agora inclui `integracoes.smoobu` no `.select()` e devolve `smoobu_api_key_mascarada`, `tem_api_key` e `smoobu_ativo` (antes não devolvia nenhum destes → o frontend lia `undefined` → mostrava sempre "Não configurada"); (b) PUT `/configuracoes` também atualizado para devolver `smoobu_ativo` após guardar; (c) frontend lê `smoobu_ativo` e se for `true` mas a chave da BD estiver vazia (configurada via env var global), mostra um placeholder verde "Configurada (Global/Env)" + Badge "Ativo" + Badge "Global/Env" em vez de "Não configurada"; cache-busting com `?_t=${Date.now()}`; (d) secção "Ações de Manutenção" movida para esta página principal (visível para `role === 'admin'`) com botões "Eliminar Limpezas Futuras" + "Sincronizar Smoobu" + dialog de confirmação; gestores não-admin vêem um aviso em vez dos botões. `tsc` 0 erros ✓ · `next lint` limpo ✓ · `node --check` backend ✓. |
| Feature | — | **Filtros em Tarefas + Qtd. Hóspedes via Smoobu + Lotação Máxima nas Propriedades:** **Decisão de design** — o cliente pediu campos novos `capacidade_maxima` (Propriedade) e `numero_hospedes` (Tarefa), mas a análise revelou que os campos `capacidade_hospedes` (Propriedade, v1.61.0) e `hospedes` (Tarefa, HF23) **já existem** e têm exatamente a mesma semântica. O `smoobuController` já extrai `pax` (adults + children) do payload Smoobu e guarda em `hospedes` com fallback a `capacidade_hospedes`. Para evitar redundância, reutilizaram-se os campos existentes em vez de criar duplicados. **(1) Backend `gestorController`** — `criarPropriedade` agora aceita `capacidade_hospedes` no body e passa-o ao `Propriedade.create`; `atualizarPropriedade` agora aceita `capacidade_hospedes` (null = limpar), com validação e bloco de update; a validação "nenhum campo" foi alargada para reconhecer `capacidade_hospedes`. `getTarefas` e `getDadosCalendario` **já populavam** `capacidade_hospedes` (confirmado, sem alteração). **(2) Frontend Propriedades** — `manualForm` e `editForm` ganham campo `capacidade_hospedes` (string); `handleSubmeterManual` e `handleEditar` enviam-no (Number ou null); `abrirEdicao` carrega-o do DTO; JSX adiciona input "Capacidade Máxima / Lotação" no separador Geral (criação + edição). **(3) Frontend Tarefas** — `TarefaAdmin` alargado com `hospedes?: number \| null` e `capacidade_hospedes` em `propriedade_id`; nova barra de filtros (Card) abaixo das Tabs de estado com: Data Início, Data Fim (inputs date), Propriedade (select, só ativas), Funcionário (select, staff ativo) + botão "Limpar filtros" + contador; filtros aplicados client-side em `tarefasFiltradas` (comparação por nome, pois o populate não inclui `_id`); nova coluna "Qtd. Hóspedes" na tabela com lógica: mostra `👥 N` (nº real de hóspedes da reserva, de `t.hospedes` ou `t.detalhes_reserva.pax`); se null/0, mostra `👥 (Máx: N)` a cinzento (lotação máxima da casa, de `propriedade_id.capacidade_hospedes`) com tooltip a explicar; se ambos vazios, mostra "—". `tsc` 0 erros ✓ · `next lint` limpo ✓ · `node --check` backend ✓. |
