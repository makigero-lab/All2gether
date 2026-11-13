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
