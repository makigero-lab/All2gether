# Documentação Técnica — Backend (Autocell)

API REST do SaaS de gestão para Alojamento Local, construída com **Node.js**, **Express** e **MongoDB** (via **Mongoose**).

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
│   ├── webhookController.js  # Webhook do Smoobu: atribuição de tarefas (lógica central)
│   ├── adminController.js    # Painel de Administração + setup Cliente Zero
│   └── authController.js     # Autenticação: login (JWT) + /me
├── middleware/
│   └── auth.js               # Verifica JWT (strito), injeta req.user — sem fallback legacy
├── models/                   # Modelos Mongoose (ODM do MongoDB)
│   ├── Empresa.js            #   Entidade principal (multi-tenant)
│   ├── Propriedade.js        #   Alojamento sincronizado com o Smoobu
│   ├── Utilizador.js         #   Admin / Staff de uma empresa (email + password_hash)
│   ├── Ausencia.js           #   Indisponibilidade de Staff num dia
│   └── Tarefa.js             #   Tarefa de limpeza gerada por reserva
└── routes/
    ├── webhookRoutes.js      # POST /webhooks/smoobu
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

| Campo         | Tipo    | Notas                                              |
|---------------|---------|----------------------------------------------------|
| `nome`        | String  | Obrigatório, trim, indexado.                       |
| `nif`         | String  | Opcional, trim.                                    |
| `plano_ativo` | Boolean | Default `true`.                                    |

### `Propriedade`
Representa um alojamento sincronizado com o Smoobu.

| Campo                   | Tipo     | Notas                                                        |
|-------------------------|----------|--------------------------------------------------------------|
| `smoobu_id`             | String   | Único, indexado. ID do apartment no Smoobu (cruzamento webhook). |
| `nome`                  | String   | Obrigatório.                                                 |
| `empresa_id`            | ObjectId | `ref: 'Empresa'`. Obrigatório, indexado.                     |
| `tempo_limpeza_minutos` | Number   | Default `60`. Usado se o payload do Smoobu não trouxer valor. |
| `ativo`                 | Boolean  | Default `true`.                                              |

### `Utilizador`
Admin, Manager ou Staff de uma empresa. Credenciais de login (email + password_hash).

**Roles (hierarquia):**
- `admin` — dono da conta (gestão total: empresas, planos, utilizadores).
- `manager` — responsável de limpezas (gere equipa de staff, vê dashboard alargado, pode executar limpezas).
- `staff` — executante de limpezas (vê apenas as suas tarefas no mobile).

| Campo            | Tipo     | Notas                                                              |
|------------------|----------|--------------------------------------------------------------------|
| `nome`           | String   | Obrigatório.                                                       |
| `email`          | String   | Obrigatório, lowercase, trim, **único** (indexado). Credencial de login. |
| `password_hash`  | String   | Hash bcrypt da password (nunca a password em claro). Opcional (utilizador migrado sem password → login recusa). |
| `empresa_id`     | ObjectId | `ref: 'Empresa'`. Obrigatório, indexado.                           |
| `role`           | String   | `enum: ['admin','manager','staff']`, default `'staff'`.           |
| `responsavel_id` | ObjectId | `ref: 'Utilizador'`, default `null`. Superior hierárquico (admin/manager). O admin não tem responsavel_id (topo da hierarquia). Indexado. |
| `ativo`          | Boolean  | Default `true`. Utilizador inativo é ignorado pelo webhook e pelo login. |

> **Regras de segurança (v1.7.0):** não é possível criar/editar utilizadores com role `admin` via `/api/admin/equipa` (403). Não é possível editar/eliminar/desativar utilizadores que já sejam `admin` (403 "Não é possível modificar um administrador"). O `responsavel_id` tem de ser um admin/manager da mesma empresa (validado no backend).

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
Tarefa de limpeza gerada a partir de uma reserva do Smoobu.

| Campo                   | Tipo     | Notas                                                              |
|-------------------------|----------|--------------------------------------------------------------------|
| `empresa_id`            | ObjectId | Obrigatório, indexado.                                             |
| `propriedade_id`        | ObjectId | `ref: 'Propriedade'`. Obrigatório, indexado.                       |
| `smoobu_reserva_id`     | String   | ID da reserva no Smoobu (auditoria / idempotência). Indexado.      |
| `utilizador_id`         | ObjectId | `ref: 'Utilizador'`, **default `null`** → tarefa por atribuir.     |
| `data`                  | Date     | Dia do check-in (meia-noite UTC). Obrigatório, indexado.           |
| `tempo_limpeza_minutos` | Number   | Obrigatório, default `60`, `min: 0`. Unidade de carga.             |
| `tipo`                  | String   | `enum: ['limpeza','check_in','check_out','manutencao','outro']`.   |
| `estado`                | String   | `enum: ['por_atribuir','atribuida','em_curso','concluida','cancelada']`. |

> Nota: `empresa_id` é uma referência a `Empresa` (modelo criado na v1.2.0).

---

## 3.2. Lógica central — Atribuição de tarefas (Webhook Smoobu)

Quando o Smoobu notifica uma **nova reserva** (`POST /webhooks/smoobu`), a API executa o seguinte fluxo **estrito**:

1. **Receber o payload** — extrai o ID da propriedade, a data de check-in e o ID da reserva do payload do Smoobu. **Mapeamento primário (estrutura oficial):** `payload.data.apartment.id`, `payload.data.arrival`, `payload.data.id`. Fallbacks com `??` para variantes (`content.*`, campos achatados).
2. **Encontrar a empresa** — procura a `Propriedade` por `smoobu_id` e obtém o respetivo `empresa_id`. Se não existir → erro (a tarefa não pode ser criada sem saber a empresa).
3. **Procurar Staff/Managers** — lista todos os `Utilizador` com `role: { $in: ['staff','manager'] }`, `ativo: true` dessa empresa. (O manager também pode executar limpezas, pelo que entra no load balancing.)
4. **Filtro de Ausências** — exclui os Staff que tenham uma `Ausencia` que cubra o dia do check-in. **v1.8.0:** verifica sobreposição de intervalos (`data_inicio <= dia AND data_fim >= dia`), mantendo também a query `data` legacy para retrocompatibilidade. Férias/folgas registadas via `/api/admin/ausencias` excluem automaticamente o staff da atribuição nesse período.
5. **Cálculo de Carga (Load Balancing)** — para cada Staff disponível, soma `tempo_limpeza_minutos` de todas as `Tarefa` já atribuídas a esse Staff para o mesmo dia (excluindo `cancelada`/`concluida`). Staff sem tarefas conta como carga `0`.
6. **Atribuição** — a nova Tarefa é atribuída ao Staff com **menor carga acumulada** (empate → primeiro encontrado).
7. **Sem disponíveis** — se não houver Staff disponível (ou a lógica de atribuição falhar), a Tarefa é **mesmo assim criada** com `utilizador_id: null` e `estado: 'por_atribuir'`, para o Admin atribuir manualmente.

### Regra de resposta (anti-timeout)
> O handler devolve **`200 OK` imediato** (`{ status: 'recebido' }`) **antes** de qualquer acesso à BD. O processamento das regras decorre de forma **assíncrona** (`setImmediate`), porque o Smoobu cancela pedidos demorados. Erros do processamento assíncrono são capturados em `try/catch` e registados (não propagam para o cliente).

### Regra de robustez
> A criação da Tarefa (passo 7) **nunca** é impedida por falhas na lógica de atribuição (passos 3–6): se algo falhar ao determinar o utilizador, a tarefa é criada com `utilizador_id: null` e o erro é registado. Apenas a falha nos passos 1–2 (payload inválido / propriedade inexistente) impede a criação, por serem pré-requisitos.

---

## 4. Scripts disponíveis

| Script       | Comando            | Descrição                                          |
|--------------|--------------------|----------------------------------------------------|
| `npm start`  | `node server.js`   | Arranca a API em modo produção                     |
| `npm run dev`| `nodemon server.js`| Arranca em modo desenvolvimento (auto-restart)     |
| `npm test`   | `jest`             | Corre os testes unitários/integração (Jest + Supertest) |

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

---

## 6. API — Endpoints

### `GET /`
Rota de verificação de estado (healthcheck).

**Resposta (200 OK):**
```json
{
  "status": "API do Alojamento Local online e ligada à BD!"
}
```

### `POST /webhooks/smoobu`
Recebe o webhook do Smoobu (nova reserva) e cria a respetiva Tarefa de limpeza, aplicando a lógica de atribuição descrita na secção 3.2.

- **Resposta imediata (200 OK):** `{ "status": "recebido" }` — o processamento decorre em segundo plano.
- **Payload esperado (estrutura OFICIAL do Smoobu — `data` + sub-objeto `apartment`):**

  | Campo lido (prioritário) | Fallbacks | Uso |
  |---|---|---|
  | `payload.data.apartment.id` | `data.apartmentId` / `data.apartment_id` / `data.propertyId` / `data.property_id` / `content.apartmentId` / `content.property_id` / `content.propriedade_id` | Identifica a propriedade no Smoobu |
  | `payload.data.arrival` | `data.check_in` / `data.checkIn` / `data.data_check_in` / `data.startDate` / `content.arrival` / `content.startDate` | Data de check-in (dia da tarefa) |
  | `payload.data.id` | `data.reservationId` / `data.reservation_id` / `content.id` / `content.reservation_id` | ID da reserva (auditoria) |
  | — | `content.tempo_limpeza_minutos` / `content.cleaning_minutes` | (Opcional) sobrepõe-se ao default da propriedade |

- **Exemplo de payload Smoobu (estrutura oficial documentada):**
```json
{
  "action": "newReservation",
  "data": {
    "id": 292,
    "arrival": "2024-07-15",
    "apartment": {
      "id": 38,
      "name": "Apartment 1"
    }
  }
}
```
- **Resultado (assíncrono):** é criado um documento `Tarefa` com `utilizador_id` preenchido (Staff com menor carga) ou `null` (sem disponíveis / erro). O resultado é registado nos logs do servidor.

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
    { "_id": "...", "smoobu_id": "99999", "nome": "Casa Teste", "empresa_id": "...", "tempo_limpeza_minutos": 60, "ativo": true, "createdAt": "...", "updatedAt": "..." }
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
  "smoobu_id": "99999",
  "nome": "Casa Teste",
  "tempo_limpeza_minutos": 60
}
```
  - `smoobu_id` (obrigatório, único global) — ID do apartment no Smoobu.
  - `nome` (obrigatório).
  - `tempo_limpeza_minutos` (opcional, default `60`, tem de ser `>= 0`).
- **Resposta (201 Created):** `{ "propriedade": { ... } }`
- **Erros:** `400` campos em falta / `tempo_limpeza_minutos` inválido; `401` não autenticado; `409` se `smoobu_id` já existir; `500` erro interno.

#### `GET /api/admin/equipa`
Lista todos os utilizadores da empresa (qualquer role), ordenados por `nome`.

- **Auth:** JWT (strito, sem fallback legacy). **Protegido.**
- **Resposta (200 OK):**
```json
{
  "utilizadores": [
    { "_id": "...", "nome": "João Limpezas", "email": "joao.limpezas@autocell.pt", "empresa_id": "...", "role": "staff", "ativo": true, "createdAt": "...", "updatedAt": "..." }
  ]
}
```
- **Nota:** a `password_hash` **nunca** é devolvida (`.select('-password_hash')`).
- **Erros:** `400` empresa_id em falta/inválido; `401` não autenticado; `500` erro interno.

#### `POST /api/admin/equipa`
Cria um novo membro de equipa (Utilizador) para a empresa.

- **Auth:** JWT (strito, sem fallback legacy). **Protegido.**
- **Body:**
```json
{
  "nome": "Maria Ferreira",
  "email": "maria.ferreira@autocell.pt",
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

#### `PATCH /api/admin/equipa/:id/estado`
Alterna o estado `ativo` do utilizador (ativa ↔ desativa).

- **Auth:** JWT (strito, sem fallback legacy). **Protegido.**
- **Body (opcional):** `{ "ativo": true }` — se não vier, alterna o estado atual.
- **Resposta (200 OK):** `{ "utilizador": { ... }, "ativo": boolean }`.
- **Comportamento:** um utilizador desativado **não consegue fazer login** (ver `authController.login` → 401 "Utilizador inativo").
- **Erros:** `400` ID inválido; `401` não autenticado; `404` não encontrado; `500` erro.

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

- 1 **Empresa** «O Meu Alojamento Local» (procura por `nome`).
- 3 **Utilizadores** (procura por `email` único), cada um com `password_hash` bcrypt:
  - `admin@autocell.pt` (admin — dono da conta)
  - `manager@autocell.pt` (manager — responsável de limpezas)
  - `joao.limpezas@autocell.pt` (staff — executante de limpezas)
- 1 **Propriedade** «Casa Teste» (`smoobu_id: '99999'`).

- **Resposta (200 OK):**
```json
{
  "mensagem": "Cliente Zero criado com sucesso.",
  "empresa_id": "<ObjectId>",
  "empresa":  { "id": "...", "nome": "O Meu Alojamento Local", "plano_ativo": true, "criada": true },
  "utilizadores": [
    { "id": "...", "nome": "Gestor Autocell", "email": "admin@autocell.pt", "role": "admin", "criado": true, "password_definida": true, "credenciais_teste": { "email": "admin@autocell.pt", "password": "autocell123" } },
    { "id": "...", "nome": "Responsável Limpezas", "email": "manager@autocell.pt", "role": "manager", "criado": true, "password_definida": true, "credenciais_teste": { "email": "manager@autocell.pt", "password": "autocell123" } },
    { "id": "...", "nome": "João Limpezas", "email": "joao.limpezas@autocell.pt", "role": "staff", "criado": true, "password_definida": true, "credenciais_teste": { "email": "joao.limpezas@autocell.pt", "password": "autocell123" } }
  ],
  "propriedade": { "id": "...", "nome": "Casa Teste", "smoobu_id": "99999", "criada": true }
}
```
- Se já existir tudo, devolve `mensagem: "Cliente Zero já existia (nada foi alterado)."` com `criada/criado: false`.
- **Retrocompatibilidade:** se um utilizador já existir sem `password_hash` (criado antes do auth), o setup define-lhe a password e garante o role correto.
- **Credenciais de teste (3 contas):** `admin@autocell.pt`, `manager@autocell.pt`, `joao.limpezas@autocell.pt` — todas com password `autocell123` (remover em produção).

### 6.2. Autenticação (`/api/auth`)

#### `POST /api/auth/login` (público)
Login com email + password. Valida a hash bcrypt e devolve um JWT.

- **Body:**
```json
{ "email": "joao.limpezas@autocell.pt", "password": "autocell123" }
```
- **Resposta (200 OK):**
```json
{
  "token": "<jwt>",
  "utilizador": {
    "id": "...",
    "nome": "João Limpezas",
    "email": "joao.limpezas@autocell.pt",
    "role": "staff",
    "empresa_id": "..."
  }
}
```
- **JWT payload:** `{ id, role, empresa_id }` assinado com `JWT_SECRET`, expira em `JWT_EXPIRACAO` (default `7d`).
- **Erros:** `400` email/password em falta; `401` credenciais inválidas / utilizador inativo / sem password definida; `429` muitas tentativas de login (rate limit); `500` erro interno.
- **Rate limiting (v1.11.0):** a rota de login está protegida por `express-rate-limit` — máximo de **5 tentativas por IP a cada 15 minutos**. Ultrapassado o limite → `429` com `{ "erro": "Muitas tentativas de login. Tente novamente mais tarde." }`. Mitiga ataques de força bruta e credential stuffing. Headers `RateLimit-*` (standard) são enviados na resposta para o cliente saber quando pode tentar novamente.

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

### 6.5. Webhooks — Logs do Smoobu (`/api/admin/webhooks`)

*Protegido por JWT (middleware `auth`).*

#### `GET /api/admin/webhooks`

Lista os `WebhookLog` recebidos do Smoobu (ordenados por data desc). Útil para o Admin confirmar que os webhooks estão a chegar e ver o estado de processamento.

**Query params (opcionais):**
- `status` — filtra por estado: `recebido` | `processado` | `erro`
- `limit` — máximo de resultados (default 50, máx 200)

**Resposta 200:** `{ webhooks: [...], total }`

> NOTA: o `WebhookLog` é global (não tem `empresa_id`) porque o webhook é um endpoint público do Smoobu. A auth continua exigida para que só admins vejam os logs.

#### `POST /api/admin/webhooks/:id/reprocessar`

Reprocessa um `WebhookLog` (útil quando falhou por motivo transitório e o Admin já corrigiu a causa — ex: criou a propriedade em falta). Reutiliza a função interna `processarReservaSmoobu` com o payload original guardado no log. A idempotência (verificação de `smoobu_reserva_id`) garante que reproccessar um webhook já processado não cria tarefa duplicada.

**Resposta 200:** `{ status: 'processado' | 'erro', erro_msg: string | null }`

---

### 6.6. Webhook Smoobu — robustez de produção (v1.18.0 + v1.19.0)

O endpoint `POST /webhooks/smoobu` reage a 3 tipos de ação do Smoobu:

| Action do Smoobu | Comportamento do Autocell |
|------------------|---------------------------|
| `newReservation` (nova reserva) | **Cria** a tarefa (com load balancing). Idempotente: se já existir, não duplica. Se existir mas estiver cancelada, **re-activa**. |
| `updateReservation` (reserva editada) | **Atualiza** a tarefa existente: `data`, `propriedade_id`, `tempo_limpeza_minutos`. Se a data mudou, **reavalia a atribuição** (mantém o funcionário se ainda for disponível no novo dia; caso contrário passa a `por_atribuir`). Se a tarefa estava cancelada, **re-activa**. Se não existir tarefa, cai para o fluxo de criação (fallback). |
| `cancellation` (reserva cancelada) | **Cancela** a tarefa existente (`estado = 'cancelada'`). Respeita tarefas já **concluídas** (o trabalho já foi feito). Idempotente. |
| outras (ex: `pingTest`) | **Ignora** graciosamente (log + 200, sem erro). |

Melhorias de robustez:

1. **Idempotência** (v1.18.0): o Smoobu faz retries — sem isto, teríamos tarefas duplicadas. Verifica `smoobu_reserva_id` antes de criar.
2. **Reação a cancelamentos e edições** (v1.19.0): o sistema já não ignora `cancellation` e `updateReservation` — reage conforme a tabela acima. Uma reserva cancelada no Smoobu cancela a tarefa; uma reserva editada atualiza a data/propriedade da tarefa.
3. **Visibilidade** (v1.18.0): todos os webhooks ficam em `WebhookLog` (`status` + `erro_msg` + `payload`). O Admin consulta em `GET /api/admin/webhooks` e pode reprocessar os que falharam (`POST /:id/reprocessar`).

---

### 6.7. Sincronização em massa do Smoobu (REST API pull) — v1.20.0

*Protegido por JWT (middleware `auth`).*

#### `POST /api/admin/smoobu/sincronizar`

Vai buscar todas as reservas **futuras** (a partir de hoje) ao Smoobu via REST API e cria as tarefas correspondentes usando a mesma lógica do webhook. Casos de uso: configuração inicial (importar reservas antes do webhook), recuperação (webhook esteve em baixo), auditoria (confirmar que não há reservas sem tarefa).

**Requer:** variável de ambiente `SMOOBU_API_KEY` (obtém-na no painel do Smoobu: Settings > API > API Key). Sem ela → `400`.

**Fluxo:**
1. Calcula a data de hoje (YYYY-MM-DD, UTC) — não importa o passado.
2. `fetch('https://login.smoobu.com/api/reservations?from=YYYY-MM-DD')` com header `Api-Key`. Timeout de 30s.
3. Itera sobre o array `reservations` do JSON de resposta.
4. Para cada reserva, mapeia para o formato do webhook (`{ action: 'newReservation', data: { id, arrival, apartment: { id, name } } }`) e chama `_processarReservaSmoobu`.
5. **Idempotência**: a função `processarReservaSmoobu` já verifica `smoobu_reserva_id` antes de criar — correr várias vezes não cria duplicados.
6. Cada reserva é envolvida num try/catch — se uma falhar (ex: propriedade não existe na BD), as outras continuam.
7. Devolve contadores.

**Resposta 200:**
```json
{
  "totalRecebidas": 50,
  "importadas": 48,
  "criadas": 30,
  "existentes": 18,
  "erros": 2,
  "detalheErros": [{ "reservaId": "12345", "erro": "Propriedade Smoobu 999 não encontrada na BD." }]
}
```

**Erros:** `400` (API key em falta), `502` (erro no fetch ao Smoobu — timeout, 4xx/5xx, JSON inválido), `500` (erro interno).

---

### 6.8. Listar propriedades do Smoobu — v1.21.0

*Protegido por JWT (middleware `auth`).*

#### `GET /api/admin/smoobu/propriedades`

Vai buscar a lista de apartamentos ao Smoobu (endpoint oficial `/api/apartments`) e devolve-a de forma limpa (só `id` + `name` por apartamento). Isto facilita o mapeamento no fluxo de criação de propriedades: o frontend pode mostrar um dropdown com os apartamentos do Smoobu em vez de o Admin ter de digitar o `smoobu_id` manualmente.

**Requer:** `SMOOBU_API_KEY`.

**Resposta 200:** `{ propriedadesSmoobu: [{ id, name }, ...] }`

**Erros:** `400` (API key em falta), `502` (erro no fetch ao Smoobu).

---

### 6.9. Sincronizar propriedades do Smoobu (upsert em massa) — v1.22.0

*Protegido por JWT (middleware `auth`).*

#### `POST /api/admin/smoobu/sincronizar-propriedades`

Importa em massa os apartamentos do Smoobu para a coleção `Propriedade`. Usa upsert com `$setOnInsert`: **insere apenas as propriedades que ainda não existem** (por `smoobu_id`). As propriedades já existentes **não são alteradas** — preserva edições manuais do Admin (nome, morada, tempo de limpeza, coordenadas, ativo).

Caso de uso: configuração inicial — em vez de criar cada propriedade à mão, o Admin sincroniza todas de uma vez e depois edita só as que precisam de ajustes (morada, tempo de limpeza).

**Requer:** `SMOOBU_API_KEY`. O `empresa_id` vem do JWT.

**Resposta 200:**
```json
{
  "totalRecebidas": 20,
  "criadas": 15,
  "existentes": 5,
  "erros": 0,
  "detalheErros": []
}
```

**Erros:** `400` (API key em falta), `502` (erro no fetch ao Smoobu).

> **Nota sobre o `atualizarPropriedade`:** o endpoint `PUT /api/admin/propriedades/:id` já existe desde a v1.19.1 — permite editar `nome`, `smoobu_id`, `morada`, `tempo_limpeza_minutos` (com re-geocoding automático se a morada mudar). Não foi duplicado nesta versão.

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

#### Impacto no webhook (load balancer)

O webhook do Smoobu (e o `atualizarTarefaPorReserva`) agora só consideram ausências com `estado: 'aprovada'` para excluir staff da atribuição. Pedidos pendentes ou rejeitados **não bloqueiam** a atribuição (o staff pode ainda trabalhar).

#### Ações do admin que criam ausências

As ações diretas do admin (falta súbita, baixa prolongada, registo manual) criam ausências com `estado: 'aprovada'` (não precisam de aprovação — o admin já decidiu).

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
| v1.1.0     | 1.1.0  | Lógica central: modelos `Propriedade`, `Utilizador`, `Ausencia`, `Tarefa`; `controllers/webhookController.js` (fluxo estrito de atribuição com filtro de ausências + load balancing); `routes/webhookRoutes.js` (`POST /webhooks/smoobu`); resposta 200 imediata + processamento assíncrono; tratamento de erros robusto. |
| v1.2.0     | 1.2.0  | Painel de Administração: modelo `Empresa` (nome, nif, plano_ativo); `controllers/adminController.js` (`getPropriedades`, `criarPropriedade`, `setupClienteZero`); `routes/adminRoutes.js` (`GET/POST /api/admin/propriedades`, `GET /api/admin/setup`); montagem em `server.js`. `empresa_id` via header `x-empresa-id` (sem JWT ainda). |
| v1.3.0     | 1.3.0  | **Autenticação JWT:** dependências `jsonwebtoken` + `bcryptjs`; modelo `Utilizador` com `email` único + `password_hash`; `middleware/auth.js` (verifica JWT, injeta `req.user`, fallback legacy `x-empresa-id`); `controllers/authController.js` (`login` com bcrypt + JWT, `/me`); `routes/authRoutes.js` (`POST /api/auth/login`, `GET /api/auth/me`); `/api/admin` protegido por `auth` com `empresa_id` do token; `setupClienteZero` cria Staff com `password_hash` (`joao.limpezas@autocell.pt` / `autocell123`); `.env.example` com `JWT_SECRET` + `JWT_EXPIRACAO`. |
| v1.3.1     | 1.3.1  | **Fix bootstrap:** o `auth` deixou de ser aplicado a todo `/api/admin` e passou a ser aplicado apenas às rotas `/propriedades` (dentro de `adminRoutes.js`). A rota `/api/admin/setup` voltou a ser **PÚBLICA** (era o endpoint de bootstrap que criava o primeiro utilizador — não podia exigir token). Corrige o erro `401 Autenticação obrigatória` ao chamar `/setup`. |
| v1.4.0     | 1.4.0  | **Novo role `manager`:** modelo `Utilizador` enum `['admin','manager','staff']`; `webhookController` inclui managers na atribuição de tarefas (load balancing); `setupClienteZero` cria 3 utilizadores (admin `admin@autocell.pt` + manager `manager@autocell.pt` + staff `joao.limpezas@autocell.pt`, todos com password `autocell123`). |
| v1.4.1     | 1.4.1  | **Payload Smoobu oficial:** `extrairDadosReserva` atualizada para a estrutura documentada (`{ action, data: { id, arrival, apartment: { id, name } } }`). Mapeamento primário: `payload.data.apartment.id`, `payload.data.arrival`, `payload.data.id`. Fallbacks `??` mantidos para variantes (`content.*`, campos achatados). |
| v1.5.0     | 1.5.0  | **Gestão de Equipa:** `adminController` com `getEquipa` (lista utilizadores, `.select('-password_hash')`) e `criarMembroEquipa` (valida nome/email/password/role, hash bcrypt, email único); `adminRoutes` com `GET/POST /api/admin/equipa` (protegidos por `auth`). |
| v1.6.0     | 1.6.0  | **CRUD completo de Utilizadores:** `adminController` com `atualizarMembroEquipa` (PUT — nome/email/role/password opcional com nova hash bcrypt), `alternarEstadoMembro` (PATCH — ativa/desativa, inativos não fazem login), `eliminarMembroEquipa` (DELETE — não permite auto-eliminação); `adminRoutes` com `PUT/PATCH/DELETE /api/admin/equipa/:id` (protegidos por `auth`). Validação de pertença à empresa em todas as operações. |
| v1.7.0     | 1.7.0  | **Segurança hierárquica + `responsavel_id`:** modelo `Utilizador` com campo `responsavel_id` (ObjectId ref Utilizador, superior hierárquico); `getEquipa` faz `populate('responsavel_id')` e devolve campo `responsavel` preenchido; regras 403 em criar/editar (bloqueia role `admin`), editar/eliminar/desativar (bloqueia se alvo é `admin`); `responsavel_id` validado (admin/manager da mesma empresa, não pode ser si próprio). |
| v1.8.0     | 1.8.0  | **Sistema de Folgas e Férias:** modelo `Ausencia` expandido para intervalos (`data_inicio`/`data_fim`/`tipo`/`notas`, com `data` retrocompatível via `pre('save')`); `controllers/ausenciaController.js` (`listarAusencias` com `?futuras=true` + populate, `registarAusencia` com validação de sobreposição, `eliminarAusencia`); `routes/ausenciaRoutes.js` (`GET/POST/DELETE /api/admin/ausencias`); `webhookController` atualizado para excluir staff com ausência no intervalo (sobreposição `data_inicio <= dia AND data_fim >= dia` + query `data` legacy). |
| v1.9.0     | 1.9.0  | **Testes + CI:** dependências dev `jest` + `supertest`; script `npm test`; `tests/server.test.js` (healthcheck GET / → 200 + mensagem, rota inexistente → 404); `server.js` refactorizado para exportar `app` (`module.exports = app`) e isolar `app.listen` + `mongoose.connect` em `if (require.main === module)` (permite testes sem BD/porta); workflow GitHub Actions `.github/workflows/ci.yml` (2 jobs paralelos: frontend lint+tsc+build, backend test). |
| v1.10.0    | 1.10.0 | **Remoção do fallback legacy `x-empresa-id`:** `middleware/auth.js` agora é **ESTRITO** — só aceita JWT válido, sem token → 401 (sem fallback). `adminController` + `ausenciaController`: helper `extrairEmpresaId` (com fallback) substituído por `obterEmpresaId` (lê apenas `req.user.empresa_id` do JWT). Frontend `lib/api.ts`: removido `EMPRESA_ID` e fallback `x-empresa-id` do `adminHeaders` — se não houver token, não envia header (backend devolve 401). Proteção de rotas (middleware.ts + RouteGuard) já garante que só utilizadores autenticados chegam às páginas privadas. |
| v1.11.0    | 1.11.0 | **Rate limiting no login (anti-força bruta):** dependência `express-rate-limit`; `loginLimiter` em `authRoutes.js` aplicado apenas em `POST /api/auth/login` — máximo 5 tentativas por IP a cada 15 minutos, excedido → `429 { erro: "Muitas tentativas de login. Tente novamente mais tarde." }`. Headers `RateLimit-*` (standard) ativados. Mitiga força bruta e credential stuffing. |
| v1.12.0    | 1.12.0 | **Cookie httpOnly + proxy routes (segurança anti-XSS):** o token JWT deixou de chegar ao browser. O login (`/api/auth/login` no Next.js) define um cookie `httpOnly` + `Secure` + `SameSite=Strict`. As chamadas admin vão para same-origin (`/api/admin/...`) e o catch-all proxy (`app/api/admin/[...path]`) injeta o header `Authorization` ao encaminhar para o backend. CORS trancado a `FRONTEND_URL`. Error handler global sem stack trace vazada. |
| v1.13.0    | 1.13.0 | **WebhookLog + Soft Delete:** modelo `WebhookLog` (payload bruto + status `recebido`/`processado`/`erro`) para idempotência/auditoria do webhook Smoobu. Soft delete de utilizadores (`eliminado_em`) — em vez de `deleteOne`, marca-se a data; protege Tarefas antigas de `utilizador_id` órfão. `getEquipa` exclui `eliminado_em: null`. |
| v1.14.0    | 1.14.0 | **PWA + Folgas Fixas Semanais + WhatsApp:** frontend convertido em PWA (`next-pwa`, manifest, service worker, theme `#B8860B`). Modelo `Utilizador` com `dias_folga` (array 0–6); webhook exclui staff cujo dia da semana do check-in está no array. Campo `telefone` para Daily Briefing via WhatsApp. Cron `0 8 * * *` (`node-cron`) — mock de envio. |
| v1.15.0    | 1.15.0 | **Calendários + Geolocalização + Haversine:** `GET /api/admin/tarefas` (calendário geral de operações com filtro de datas). `GET /api/auth/me/calendario` (calendário pessoal). Geocoding de moradas via Nominatim/OpenStreetMap (`utils/geocoding.js`). Load balancer com tempo de viagem (Haversine) entre propriedades. Logout seguro em todas as áreas. |
| v1.16.0    | 1.16.0 | **Emergências + SLA + Atrasos:** `POST /api/admin/equipa/:id/falta-subita` (reatribuição de emergência das tarefas do dia). `POST /api/admin/equipa/:id/baixa` (baixa prolongada/férias — redistribui tarefas futuras). SLA de capacidade máxima no load balancer (420 min = 7h). `POST /api/admin/tarefas/:id/atraso` (reportar atraso). Remoção do campo legacy `data` do modelo `Ausencia` (queries agora só usam `data_inicio`/`data_fim`). Pausar/desativar propriedades (`ativo: false`) — webhook respeita. Gestão manual de tarefas (`POST /api/admin/tarefas`, `PATCH /:id/atribuir`, `PATCH /:id/estado`). |
| v1.16.1    | 1.16.1 | **Dashboard real + Auditoria + Health + Rate limit global + Modo escuro + CSV:** dashboard do admin com dados reais (`GET /api/admin/dashboard` com contagens em paralelo + aggregate carga por staff). Modelo `Auditoria` + `utils/auditoria.js` (fire-and-forget) + `GET /api/admin/auditoria`. `GET /api/health` (estado BD + uptime). Rate limiting global (100 req/15min em `/api/`). Modo escuro funcional (toggle no sidebar, CSS vars). Exportação CSV (`GET /api/admin/tarefas/export`). |
| v1.17.0    | 1.17.0 | **Relatórios/Analytics + Paginação + Testes de integração + Fix bug webhook:** `GET /api/admin/relatorios/produtividade` (aggregations: resumo, por staff, por dia, por estado, por propriedade) com filtro de período. Página `/admin/relatorios` com gráficos recharts (linha, barras, pie). Paginação client-side nas listagens de equipa e tarefas (componente reutilizável `PaginationBar`). Suite de testes expandida de 4 para 29 testes com `mongodb-memory-server` (auth 401, login, /me, CRUD propriedades, webhook com atribuição real, dashboard, relatórios). **Fix bug crítico:** `tempoLimpeza` era usado antes da declaração (TDZ `const`) em `processarReservaSmoobu` → `ReferenceError` silenciado pelo try/catch → tarefas ficavam sempre sem atribuição. Corrigido reordenando a computação de `tempoLimpeza` antes da chamada ao load balancer. |
| v1.18.0    | 1.18.0 | **Webhook Smoobu para produção:** (1) **Idempotência** — antes de criar tarefa, verifica se já existe `Tarefa` com o mesmo `smoobu_reserva_id`; se sim, não duplica (o Smoobu faz retries). (2) **Robustez de ações** — só `newReservation` (e variantes) cria tarefa; outras ações (`updateReservation`, `cancellation`, etc.) são ignoradas graciosamente (log + 200, sem erro). (3) **Visibilidade** — novos endpoints `GET /api/admin/webhooks` (lista logs com filtro `?status=` + `?limit=`) e `POST /api/admin/webhooks/:id/reprocessar` (reprocessa webhook que falhou, reutiliza o payload guardado). Função interna `processarReservaSmoobu` exportada como `_processarReservaSmoobu` para o reproccessamento. Página `/admin/webhooks` no frontend (cartões de filtro por estado + lista expandível com payload bruto + erro + botão reprocessar). 6 novos testes (35 no total): idempotência, ação desconhecida, listagem com/sem token, filtro status, reproccessamento. |
| v1.19.0    | 1.19.0 | **Reação a cancelamentos e edições do Smoobu:** o webhook deixa de ignorar `cancellation` e `updateReservation` — agora **reage**. `processarReservaSmoobu` refactorizada num **dispatcher** que chama 3 handlers: `criarTarefaPorReserva` (newReservation, com re-activação se a tarefa estava cancelada), `cancelarTarefaPorReserva` (cancellation → `estado='cancelada'`, respeita concluídas, idempotente) e `atualizarTarefaPorReserva` (updateReservation → atualiza `data`/`propriedade_id`/`tempo_limpeza_minutos`; se a data mudou, **reavalia a atribuição** verificando folgas fixas + ausências + ativo — mantém o funcionário se ainda for disponível, senão passa a `por_atribuir`; se a tarefa estava cancelada, re-activa; se não existir tarefa, cai para o fluxo de criação por fallback). Update sem tarefa existente agora cria (em vez de ignorar). 6 novos testes (41 no total): cancellation, cancellation idempotente, cancellation sem tarefa, update de data, update sem tarefa (fallback), re-activação após cancelamento. |
| v1.19.1    | 1.19.1 | **Edição de propriedades:** novo endpoint `PUT /api/admin/propriedades/:id` (`atualizarPropriedade`) que permite editar `nome`, `smoobu_id`, `morada` e `tempo_limpeza_minutos`. Valida pertença à empresa (404); valida unicidade global do `smoobu_id` (409 se outra propriedade já o tiver); se a `morada` mudar, **re-faz geocoding** (best-effort — se falhar, mantém coordenadas antigas, não bloqueia). Auditoria registada. No frontend, página `/admin/propriedades` tem agora botão "Editar" (ícone Pencil) que abre modal com os 4 campos. 4 novos testes (45 no total): atualizar nome+tempo, smoobu_id duplicado 409, id inexistente 404, body vazio 400. |
| v1.20.0    | 1.20.0 | **Sincronização em massa do Smoobu (REST API pull):** novo endpoint `POST /api/admin/smoobu/sincronizar` (`controllers/smoobuController.js` → `sincronizarReservas`) que vai buscar todas as reservas **futuras** (a partir de hoje) ao Smoobu via REST API (`fetch https://login.smoobu.com/api/reservations?from=YYYY-MM-DD` com header `Api-Key`) e cria as tarefas correspondentes reutilizando `_processarReservaSmoobu` (idempotente — não cria duplicados). Cada reserva é mapeada do formato REST API para o formato do webhook e processada individualmente com try/catch (se uma falhar, ex: propriedade inexistente, as outras continuam). Devolve contadores: `totalRecebidas`, `importadas` (criadas + existentes), `criadas`, `existentes`, `erros`, `detalheErros`. Requer variável de ambiente `SMOOBU_API_KEY` (documentada em `.env.example` + topo do `server.js`); sem ela → `400`. Erros de fetch/timeout/JSON → `502`. Reutiliza a função já exportada `_processarReservaSmoobu` (sem duplicar lógica). 6 novos testes (51 no total) com mock de `global.fetch`: sem token 401, sem API key 400, contadores corretos, idempotência (2x não duplica), erro 500 do Smoobu → 502, reserva com propriedade inexistente → erro isolado. |
| v1.20.1    | 1.20.1 | **Fix 500 no toggle de propriedades + PWA:** (1) Bug crítico — `PATCH /api/admin/propriedades/:id/estado` dava 500 em propriedades legacy sem `morada` porque `findOne` + `save()` re-valida o documento inteiro. Corrigido com `findOneAndUpdate` + `$set` (não re-valida). Teste de regressão: propriedade inserida sem morada → toggle 200. (2) PWA — meta `mobile-web-app-capable` adicionada (apple-* deprecated). (3) Ícones 1x1 placeholder substituídos por ícones reais 192/512/180 (gerados com image-generation + sharp, fundo dourado #B8860B). |
| v1.21.0    | 1.21.0 | **Listar propriedades do Smoobu:** novo endpoint `GET /api/admin/smoobu/propriedades` (`smoobuController` → `getPropriedadesSmoobu`) que faz `fetch https://login.smoobu.com/api/apartments` com header `Api-Key` e devolve `{ propriedadesSmoobu: [{ id, name }, ...] }` de forma limpa (só os campos úteis, não vaza dados sensíveis/volumosos do Smoobu). Facilita o mapeamento no fluxo de criação de propriedades — o frontend pode mostrar um dropdown com os apartamentos do Smoobu em vez de o Admin ter de digitar o `smoobu_id` manualmente. Mesmo padrão de robustez do `sincronizarReservas`: valida `SMOOBU_API_KEY` (400), trata erros de fetch/HTTP/JSON (502), aceita variantes da resposta (`body.apartments` ou `body.data.apartments`). 4 novos testes (56 no total): sem token 401, sem API key 400, fetch mockado devolve lista limpa (verifica que só id+name, não vaza other fields, e que o fetch foi chamado com URL+header corretos), erro 401 do Smoobu → 502. |
| v1.22.0    | 1.22.0 | **Sincronizar propriedades do Smoobu (upsert em massa):** novo endpoint `POST /api/admin/smoobu/sincronizar-propriedades` (`smoobuController` → `sincronizarPropriedades`) que faz `fetch https://login.smoobu.com/api/apartments` e faz upsert de cada apartamento com `$setOnInsert` — **insere só as que não existem**, não altera as existentes (preserva edições manuais do Admin: nome, morada, tempo, coordenadas, ativo). `empresa_id` vem do JWT. Devolve contadores: `totalRecebidas`, `criadas`, `existentes`, `erros`, `detalheErros`. Caso de uso: configuração inicial (importar todas as propriedades de uma vez). O endpoint `PUT /api/admin/propriedades/:id` (`atualizarPropriedade`) **já existia** desde a v1.19.1 (nome, smoobu_id, morada, tempo + re-geocoding) — não foi duplicado. 5 novos testes (61 no total): sem token 401, sem API key 400, cria propriedades novas, idempotente (2x não duplica), preserva edições manuais (propriedade com nome/tempo/ativo editados não é sobreposta). |
| v1.23.0    | 1.23.0 | **Calendário Visual Avançado — endpoint unificado:** novo endpoint `GET /api/admin/calendario/dados` (`adminController` → `getDadosCalendario`) que devolve tarefas da empresa num intervalo de datas com filtros opcionais (`propriedadeId`, `utilizadorId`, `estado`) + populate de propriedade (`nome`, `morada`, `coordenadas`) e utilizador (`nome`). Diferença para `getTarefas`: não exclui canceladas por defeito (calendário pode mostrá-las a tracejado), aceita `utilizadorId=null` para filtrar tarefas por atribuir, e o populate inclui `morada`+`coordenadas` (para tooltips e futuro mapa de rotas). 8 novos testes (69 no total): sem token 401, sem filtros (inclui canceladas), populate (nome+morada+utilizador), filtro por propriedade, filtro por utilizador, filtro utilizadorId=null (por atribuir), filtro por estado=concluida, combina filtros. Fix de teste existente: o teste do webhook assumia que só havia 1 staff (quebrado pelo `beforeAll` do calendário que cria 2 staff extra) — corrigido para verificar apenas que a tarefa foi atribuída a algum staff ativo (não null), que é o comportamento correto do load balancer. |
| v1.24.0    | 1.24.0 | **Fluxo de aprovação de ausências:** (1) Modelo `Ausencia` — novo campo `estado` (`pendente`\|`aprovada`\|`rejeitada`, default `pendente`); enum do `tipo` alargado para `ferias`\|`doenca`\|`outro` (as "folgas" fixas semanais continuam em `dias_folga` do Utilizador). (2) **Staff routes** — novo `controllers/staffController.js` + `routes/staffRoutes.js` montado em `/api/staff`: `GET /ausencias` (histórico próprio) + `POST /ausencias` (cria pedido sempre `pendente`; staff não pode auto-aprovar). (3) **Aprovação** — `PATCH /api/admin/ausencias/:id/estado` (`ausenciaController` → `aprovarRejeitarAusencia`): aprovar → redistribui tarefas do período via load balancer (helper `redistribuirTarefasPeriodo` extraído e reutilizável); rejeitar → só atualiza estado. (4) **Webhook** — `determinarUtilizadorAtribuido` e `atualizarTarefaPorReserva` agora só consideram ausências `aprovada` (pendentes/rejeitadas não bloqueiam atribuição). (5) Ações diretas do admin (falta súbita, baixa prolongada, registo manual) criam ausências com `estado: 'aprovada'`. 7 novos testes (76 no total): staff cria pedido (pendente), staff vê suas ausências, staff sem token 401, admin aprova (redistribui — verifica utilizador_id mudou), admin rejeita (não mexe em tarefas), estado inválido 400, ausência inexistente 404. |
