# Chaves de cifra e Smoobu da empresa: ordem de produção, verificação e rollback

Aplica-se a: `ICAL_CHAVES`, `ICAL_CHAVE_ATUAL`, `ICAL_HMAC_CHAVE` (Render) e à chave e ao segredo do Smoobu
guardados em `Empresa.integracoes.smoobu` (`api_key`, `api_secret`, `api_key_hmac`). Os scripts estão em
`backend/scripts/` e correm com `MONGODB_URI` (e as `ICAL_*`) no ambiente. **Todos simulam por defeito**; só
escrevem com `--aplicar`. Nunca imprimem chaves nem segredos.

## Regras que não se quebram

1. **O Smoobu em produção não pode parar.** Sem `ICAL_*` o código guarda e lê em claro, exatamente como antes.
2. **Guardar as chaves `ICAL_*` num cofre ANTES de as pôr no Render**, e uma cópia da chave e do segredo do
   Smoobu fora do sistema. Perder `ICAL_CHAVES` depois de cifrar = chave do Smoobu ilegível (ver "Se as chaves se perderem").
3. **A chave antiga nunca se retira de `ICAL_CHAVES` enquanto houver dados cifrados com ela.** O
   `rodarChaveIcal.js` diz no fim "ainda há N valores cifrados com a chave X": só quando já não diz nada, depois de
   `--aplicar`, é seguro retirar a X.
4. **`ICAL_HMAC_CHAVE` nunca se muda** sem voltar a correr `cifrar-chave-smoobu.js --aplicar` logo a seguir. O HMAC
   guardado da chave do Smoobu deixa de corresponder e, com a autenticação do webhook ativa, os webhooks passam a
   dar 401. O arranque avisa no log ("HMAC da chave Smoobu desatualizado"). Em produção hoje
   (`AUTH_DISABLED=true`) não há efeito imediato, mas não mudar na mesma.
5. **Rollback do código só depois de `decifrar-chave-smoobu.js --aplicar`** (ver mais abaixo).

## Ordem de produção

| # | Passo | Verificação |
|---|---|---|
| 1 | Deploy do código. Inofensivo: sem `ICAL_*` tudo continua em claro. | "Testar ligação" no ecrã de Configurações: ok. Webhook e sincronização como antes. |
| 2 | `node scripts/limpar-webhooklogs.js` (simulação) e depois `--aplicar`. | A simulação mostra `a_limpar`; o `--aplicar` mostra `limpos` igual; segunda vez: 0. |
| 3 | `node scripts/gerarChavesIcal.js`. Guardar as 3 variáveis no cofre. Pôr no Render e reiniciar. | O ecrã continua a mostrar a chave mascarada com os últimos 4 caracteres (a BD ainda está em claro). O log de arranque não tem avisos `[Segredos]`. |
| 4 | Testar o Smoobu com as chaves já ativas: "Testar ligação", sincronização manual, um webhook real. | Tudo ok. |
| 5 | `node scripts/cifrar-chave-smoobu.js` (simulação). | `empresas` e `a_cifrar` esperados, **`falhas: 0` e `ilegiveis: 0`**. Se der `ilegiveis`, há valores já cifrados que as chaves atuais não leem: parar e verificar `ICAL_CHAVES`. |
| 6 | `node scripts/cifrar-chave-smoobu.js --aplicar`. | `cifradas` = `a_cifrar`, `alteradas_entretanto: 0` (se não for 0, alguém gravou a chave no ecrã durante a execução: voltar a correr), `falhas: 0`. Com a chave de cifra errada o script **aborta** sem escrever. |
| 7 | Confirmar: "Testar ligação", sincronização manual, um webhook. | O ecrã mostra a chave mascarada (últimos 4 caracteres). **Se aparecer a mensagem a vermelho "A chave do Smoobu está guardada cifrada, mas o servidor não tem a chave de cifra certa (ICAL_CHAVES)...", parar:** as chaves de cifra não estão a ser lidas (Render). |
| 8 | Segunda corrida do passo 6: tudo a 0 (idempotente). | `a_cifrar: 0`. |

### Rotação futura da chave de cifra

1. Acrescentar a chave 2 **sem tirar a 1**: `ICAL_CHAVES=1:...,2:...` e `ICAL_CHAVE_ATUAL=2`. Reiniciar.
2. `node scripts/rodarChaveIcal.js` (simulação) e `--aplicar`. Roda os links dos calendários **e** a chave e o segredo do Smoobu.
3. Verificação: o resultado traz `ainda_cifrados_por_chave` e `avisos`. Só quando `avisos` vem vazio é que a chave 1 pode sair de `ICAL_CHAVES`.
4. Retirar a 1 do Render, reiniciar, "Testar ligação".

## Rollback

### Do código (voltar a um deploy anterior que não sabe ler valores cifrados)

Um deploy antigo lê o texto cifrado como se fosse a chave: o Smoobu pára (401). Por isso, **por esta ordem**:

1. Manter as `ICAL_*` no Render (precisam-se para decifrar).
2. `node scripts/decifrar-chave-smoobu.js` (simulação): `falhas` tem de ser 0.
3. `node scripts/decifrar-chave-smoobu.js --aplicar`: repõe a chave e o segredo em claro e limpa o HMAC. Idempotente.
4. Só agora, rollback do deploy no Render.
5. "Testar ligação" e um webhook.

Se `decifrar` der falhas (valor que não se decifra), esses ficam intocados: **não fazer o rollback do código** até
a empresa voltar a escrever a chave e o segredo no ecrã.

### Se as chaves se perderem ou estiverem erradas (depois de cifrar)

Sintomas: o ecrã de Configurações mostra a mensagem de chave cifrada sem a chave de cifra certa, "Testar ligação" diz o
mesmo, o log de arranque tem `[Segredos] ... NÃO consegue ler`, e o ecrã mostra o erro do job horário.
Um webhook de reserva nova **sem data de saída** fica com erro no registo de webhooks (e o gestor é avisado) em vez de
criar a limpeza no dia de chegada; com data de saída processa normalmente.

Recuperar, por ordem de preferência:

1. Repor no Render as `ICAL_CHAVES`/`ICAL_CHAVE_ATUAL` certas (do cofre) e reiniciar.
2. Sem as chaves: no ecrã, voltar a escrever **a chave e o segredo juntos** (repor só um dá erro a pedir o outro).
3. Depois reprocessar os webhooks com erro (página de Webhooks do gestor).

## Resumo dos scripts

| Script | O que faz | Quando |
|---|---|---|
| `limpar-webhooklogs.js` | Reduz ao mínimo os registos de webhooks antigos. | Passo 2. |
| `gerarChavesIcal.js` | Gera as 3 variáveis `ICAL_*`. | Passo 3 e rotações. |
| `cifrar-chave-smoobu.js` | Cifra chave e segredo do Smoobu e preenche o HMAC. Aborta se algo já cifrado não decifra; escrita condicional. | Passo 6; também repara o HMAC. |
| `rodarChaveIcal.js` | Volta a cifrar links e credenciais Smoobu com a chave atual; avisa das chaves antigas ainda em uso. | Rotação. |
| `decifrar-chave-smoobu.js` | Reversão: chave e segredo em claro. | Antes de um rollback do código. |

## Google Maps: duas chaves, APIs, quotas e orçamento

Há **duas chaves diferentes** (nunca a mesma): uma no servidor e uma no browser. Se a chave de browser não estiver
configurada, as sugestões de morada e o mapa com pino **ficam escondidos** e o resto da aplicação funciona como antes.

| | Chave do servidor | Chave de browser |
|---|---|---|
| Variável | `GOOGLE_MAPS_API_KEY` (Render) | `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` (Vercel; pública por natureza, vai no JavaScript) |
| Usada por | `utils/geocoding.js` (geocodificar e «morada neste pino») e `utils/distancia.js` | Sugestões ao escrever a morada e mapa com pino arrastável |
| APIs ativas | Geocoding API, Distance Matrix API | Maps JavaScript API, Places API (New) |
| Restrição | Por **IP**/sem restrição de referrer (o Render não tem IP fixo no plano grátis: restringir só por API) | **HTTP referrer** `https://app.all2gether.pt/*` e restringir às duas APIs acima |

Notas:

- A chave de browser lê-se no **build** (variável `NEXT_PUBLIC_*`): depois de a criar ou mudar na Vercel é preciso um
  novo deploy. A CSP (`frontend/next.config.mjs`) só abre os domínios do Google quando a variável existe.
- O script do Google só é carregado quando é preciso (ao focar o campo Morada ou ao abrir o mapa), nunca no arranque.
- O pedido a Places (New) pede só `location`, `formattedAddress` e `addressComponents` (SKU Essentials) e usa um
  session token por pesquisa. **Nunca pedir `displayName` nem outros campos Pro** sem rever o custo.
- O mapa usa `mapId: "DEMO_MAP_ID"` (AdvancedMarker sem configurar nada na consola). Para estilos próprios seria preciso criar um mapId.
- A lista de sugestões mostra «Sugestões do Google». Se um dia as sugestões forem mostradas sem mapa com o logótipo
  em falta, rever os requisitos de atribuição do Google.
- Se a chave for recusada (referrer errado, API por ativar, sem faturação) o campo Morada continua a funcionar como
  campo normal (sem sugestões) e o mapa mostra «Não foi possível carregar o mapa». No servidor, o `status` do Google
  (REQUEST_DENIED, OVER_QUERY_LIMIT...) fica no log do Render.

### Quotas diárias e orçamento (limites que ficam definidos na consola do Google Cloud)

| API | Limite diário a definir |
|---|---|
| Geocoding API | 300 pedidos/dia |
| Places API (New) | 300 pedidos/dia |
| Distance Matrix API | 300 pedidos/dia |
| Maps JavaScript API | 100 carregamentos/dia |

Orçamento mensal do projeto: **1 €**, com alertas de orçamento a 50 %, 90 % e 100 % para o email do titular. Com as
quotas diárias acima o consumo máximo fica abaixo dos créditos gratuitos mensais do Google Maps Platform; se um limite for
atingido, as funcionalidades degradam de forma segura: geocoding passa para o Nominatim, distâncias para Haversine, e o
campo Morada fica sem sugestões. A pré-visualização «morada neste pino» tem ainda um limite próprio de 30 pedidos por minuto por utilizador.

### Configurar (resumo)

1. Google Cloud: criar o projeto com faturação; ativar Geocoding, Distance Matrix, Maps JavaScript e Places API (New).
2. Criar as duas chaves com as restrições da tabela; definir as quotas diárias e o orçamento de 1 €.
3. Render: `GOOGLE_MAPS_API_KEY` = chave do servidor. Vercel: `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` = chave de browser; novo deploy.
4. Verificar: no editar de uma casa, escrever 3 letras da morada (aparecem sugestões); escolher uma; «Ajustar o pino» abre o mapa em satélite.
5. Se algo falhar, ver a consola do browser (erros de CSP/`RefererNotAllowedMapError`) e o log do Render.
