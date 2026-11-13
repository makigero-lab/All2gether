<!-- PROP-DPA-1.0. Texto do @Legal ainda em MODELO: os campos [entre colchetes] e as notas [CONFIRMAR]/[ADVOGADO] têm de ser resolvidos antes de ligar ACORDO_RGPD_OBRIGATORIO=true. Alterar este ficheiro muda o hash: criar uma versão nova (PROP-DPA-1.1) em vez de editar. -->
# Acordo de Tratamento de Dados por Conta do Proprietário

(artigo 28.º, n.º 3, do RGPD) — versão PROP-DPA-1.0

**Partes.** **[Denominação da empresa de limpeza]**, NIPC [ ], com sede em [ ], que explora a plataforma All2gether ("**Empresa**"), e o utilizador do portal identificado na conta que aceita este acordo, por si ou em representação da entidade titular das casas ("**Proprietário**"). Contacto de privacidade da Empresa: [email].

### 1. Objeto e papéis
1.1. Este acordo regula o tratamento, pela Empresa, de dados pessoais dos **hóspedes** das casas do Proprietário que a Empresa limpa. Quanto a esses dados, o Proprietário é **responsável pelo tratamento** e a Empresa é **subcontratante**.
1.2. Os dados do próprio Proprietário (conta, contactos, casas, links e chaves que liga) são tratados pela Empresa como responsável, nos termos da Política de Privacidade do portal.
1.3. Se o Proprietário gerir casas de outra pessoa, declara que está autorizado pelo titular do alojamento a recorrer à Empresa e aos subcontratantes do Anexo B, e passa-lhe as obrigações deste acordo.

### 2. Natureza, finalidade e duração
2.1. **Finalidade única:** saber quando e como limpar e preparar as casas (criar, mudar e cancelar limpezas).
2.2. **Natureza:** receber reservas (escritas no portal, marcadas pelo gestor a pedido do Proprietário, lidas do calendário iCal ou da API do channel manager do Proprietário), guardar o mínimo necessário, organizar as limpezas, apagar.
2.3. **Duração:** enquanto o Proprietário usar o portal ou tiver casas ligadas, e depois disso o tempo de apagamento previsto na cláusula 10.

### 3. Dados e titulares
3.1. Titulares: hóspedes das casas do Proprietário.
3.2. Os dados que a Empresa **recebe** e os que **guarda** constam do **Anexo A**. Tudo o que não consta da coluna "guardado" é **descartado no momento da receção**, sem ficar em base de dados, registos ou cópias.
3.3. O Proprietário não deve escrever nas notas da reserva dados desnecessários, em especial dados de saúde, documentos ou contactos dos hóspedes.

### 4. Instruções
4.1. A Empresa só trata os dados segundo as instruções documentadas do Proprietário. São instruções: este acordo; as ações do Proprietário no portal (criar, mudar ou apagar reservas, ligar ou desligar um calendário ou uma chave); e, nas reservas marcadas pelo gestor, o pedido do Proprietário, que fica documentado pelo registo de quem marcou, pelo aviso enviado ao Proprietário no portal e, quando exista, pela mensagem escrita do pedido.
4.2. **Chaves de API:** a Empresa usa a chave apenas para **ler** apartamentos e reservas das casas que limpa. Não cria, altera nem cancela reservas, não lê nem envia mensagens a hóspedes, não altera preços nem definições, e não usa os dados para fins próprios.
4.3. A Empresa avisa o Proprietário se considerar que uma instrução viola a lei de proteção de dados. Se a lei a obrigar a tratar os dados de outra forma, informa-o antes, salvo proibição legal.

### 5. Confidencialidade
5.1. Só têm acesso as pessoas da Empresa que precisam (gestores e administradores da plataforma), vinculadas a confidencialidade que se mantém após o fim da relação. A equipa de limpeza vê só o que precisa para limpar (casa, dia, hora, notas operacionais).
5.2. O link do calendário e a chave de API nunca são mostrados por inteiro a ninguém, incluindo aos gestores: só uma máscara com os últimos caracteres.

### 6. Segurança
A Empresa aplica as medidas do **Anexo C**, entre elas: cifra AES-256-GCM dos links e das chaves, com a chave de cifra guardada fora da base de dados; minimização e descarte à entrada; pseudonimização do código da reserva (HMAC); ligações HTTPS; validação dos endereços contra pedidos indevidos; acesso por perfis; apagamento automático; cópias de segurança cifradas.

### 7. Subcontratantes ulteriores
7.1. O Proprietário dá **autorização geral** para a Empresa recorrer aos subcontratantes do **Anexo B**.
7.2. A Empresa avisa no portal (e por email, se houver), com **[30] dias** de antecedência, antes de acrescentar ou substituir um subcontratante. O Proprietário pode opor-se nesse prazo; se não houver acordo, pode desligar as integrações ou cessar o serviço sem penalização **[ADVOGADO: articular com o contrato de limpeza]**.
7.3. A Empresa impõe a cada subcontratante obrigações de proteção de dados equivalentes (aceitando os termos de tratamento de dados de cada fornecedor) e responde perante o Proprietário pelo seu cumprimento.
7.4. O Airbnb, a Booking.com, o Smoobu, a Lodgify, a Hostaway e outros canais ou channel managers **não são subcontratantes da Empresa**: são fornecedores do Proprietário, que escolhe ligá-los.

### 8. Transferências para fora do EEE
Só ocorrem quando um subcontratante do Anexo B o indica, com decisão de adequação (incluindo o Quadro de Privacidade de Dados UE-EUA, para entidades certificadas) ou cláusulas contratuais-tipo da Comissão (Decisão 2021/914).

### 9. Direitos dos titulares e outras obrigações
9.1. A Empresa ajuda o Proprietário a responder a pedidos dos hóspedes (acesso, apagamento, etc.). Como guarda muito pouco, a ajuda consiste normalmente em confirmar que dados existem e apagá-los. Se um hóspede contactar a Empresa diretamente, a Empresa reencaminha o pedido ao Proprietário em **[3] dias úteis** e não responde por ele.
9.2. **Violações de dados:** a Empresa avisa o Proprietário **sem demora injustificada e, se possível, até 48 horas** depois de ter conhecimento de uma violação que afete dados dos seus hóspedes, do seu link de calendário ou da sua chave de API, com o que se sabe e as medidas tomadas. A decisão de notificar a CNPD (até 72 horas) e os hóspedes cabe ao Proprietário. Se a chave de API puder ter sido exposta, a Empresa pede logo ao Proprietário que a revogue no channel manager.
9.3. A Empresa dá ao Proprietário a informação razoável de que ele precise para as suas avaliações de segurança ou de impacto.

### 10. Fim: apagamento
10.1. Ao **desligar** um calendário ou uma chave, o link ou a chave são apagados de imediato. Os restantes dados seguem os prazos do Anexo A.
10.2. No fim da relação, a Empresa apaga os dados de hóspedes que ainda existam no prazo de **[30] dias**, salvo obrigação legal. Pode devolver antes, a pedido, uma exportação das reservas. As cópias de segurança cifradas expiram em até **14 dias**.
10.3. A Empresa confirma o apagamento por escrito, se o Proprietário o pedir.

### 11. Informação e auditoria
A Empresa disponibiliza a informação necessária para demonstrar o cumprimento deste acordo (este texto, os anexos atualizados e a lista de subcontratantes) e responde por escrito às perguntas do Proprietário em **[15] dias úteis**. Aceita auditorias, por auditor sujeito a confidencialidade, com **[30] dias** de aviso, no máximo **[uma vez por ano]** salvo violação de dados ou pedido de autoridade, a custas de quem a pede **[ADVOGADO]**. As auditorias aos fornecedores de nuvem fazem-se pelos relatórios e certificações que estes publicam.

### 12. Obrigações do Proprietário
O Proprietário: (a) tem fundamento legal para partilhar os dados com a Empresa e informa os hóspedes dessa partilha na sua política de privacidade; (b) só liga calendários e chaves das suas casas, ou de casas que está autorizado a gerir; (c) cria, sempre que o channel manager o permita, uma **chave própria para a All2gether** e revoga-a quando deixar de a usar; (d) continua a ser o único responsável pelo SIBA e pelas outras obrigações legais do alojamento; (e) avisa a Empresa se suspeitar que o link ou a chave foram expostos.

### 13. Alterações, prevalência e lei aplicável
13.1. Novas versões são mostradas no portal com as diferenças assinaladas. Alterações que alarguem os dados tratados ou as finalidades só valem depois de nova aceitação; as restantes valem 30 dias depois do aviso, com o direito de oposição da cláusula 7.2.
13.2. Em matéria de proteção de dados, este acordo prevalece sobre o contrato de limpeza.
13.3. Lei portuguesa. Responsabilidade nos termos do art. 82.º do RGPD **[ADVOGADO: limites e foro; DL 446/85]**.

---

### Anexo A – Dados recebidos, guardados e prazos

| Entrada | Recebido (pode passar pela memória do servidor) | Guardado | Prazo |
|---|---|---|---|
| Reserva escrita pelo Proprietário ou pelo gestor | Datas, n.º de hóspedes, nome do hóspede (opcional), plataforma, hora de check-in, preferência de horário, tipo de limpeza, notas | O mesmo | Nome do hóspede apagado 90 dias após o check-out; notas [30] dias após o check-out **[hoje o `jobs/retencao.js` apaga o nome da reserva manual aos 90 dias, mas NÃO apaga as `observacoes` da reserva manual: acrescentar antes de publicar ou retirar o prazo das notas]** |
| Calendário iCal (Airbnb, Booking.com, Vrbo, outro) | Calendário completo. No Airbnb: ligação da reserva com código e últimos 4 dígitos do telefone. Noutros canais: pode vir o nome do hóspede ou outros dados | Identificador do evento (UID), código da reserva **só em forma pseudonimizada (HMAC)**, datas, tipo (reserva ou bloqueio). **Nunca** o telefone, o nome, a descrição ou o título originais | 90 dias após o check-out; registo técnico de leituras 30 dias |
| Chave de API (Smoobu, Lodgify, Hostaway) | Tudo o que a API devolver: nome, email, telefone, morada, idioma, preços, notas, reservas de outras casas | Datas, casa, n.º de hóspedes (adultos e crianças), id da reserva no channel manager, tipo (reserva, bloqueio, cancelamento) | 90 dias após o check-out |
| Link do calendário / chave de API (credenciais do Proprietário) | O link ou a chave | Só cifrados; máscara visível | Até desligar (apagados de imediato); fonte pausada > 90 dias é removida |
| Cópias de segurança | | Cópia cifrada da base de dados | 14 dias |

### Anexo B – Subcontratantes ulteriores

> **[CONFIRMAR]** entidade contratante, região e garantia de cada um nos painéis e DPA das contas. As indicações abaixo não foram verificadas nos contratos.

| Fornecedor | Função nestas integrações | Localização | Garantia |
|---|---|---|---|
| Render Services, Inc. (EUA) | Servidor da aplicação: faz as leituras dos calendários e das APIs; os dados passam por aqui em memória | [região] | DPA da Render; [DPF e/ou cláusulas-tipo] |
| MongoDB, Inc. – Atlas | Base de dados (só o que fica guardado; links e chaves cifrados) | [região do cluster] | DPA do Atlas; cláusulas-tipo [e DPF] |
| Vercel Inc. (EUA) | Página do portal e funções que reencaminham os pedidos (o link e a chave passam em trânsito, cifrados por HTTPS) | [região] | DPA da Vercel; [DPF/cláusulas-tipo] |
| GitHub, Inc. (Microsoft, EUA) | Cópias de segurança cifradas da base de dados (14 dias) | EUA | DPF (Microsoft) + cláusulas-tipo; cifra com chave não partilhada |
| Serviços de push dos browsers | Avisos ao Proprietário (sem dados de hóspedes, conteúdo cifrado) | Variável | Escolhidos pelo browser |

**Não recebem dados destas integrações:** Google Maps Platform (só moradas das casas, para calcular deslocações), Google Gemini (só estatísticas pseudonimizadas da equipa), cron-job.org (só verificação de disponibilidade). **[Se a plataforma for explorada por entidade distinta da Empresa, acrescentá-la aqui.]**

### Anexo C – Medidas de segurança (resumo)

- Link e chave cifrados com AES-256-GCM; chaves de cifra só em variáveis de ambiente, com rotação; sem chaves configuradas a função fica desligada e nada se guarda em claro.
- Nunca aparecem em registos, mensagens de erro nem respostas da API (só máscara); campos com `select: false`.
- Pedidos aos calendários só por HTTPS, para domínios permitidos, com validação do IP de destino, limites de tamanho e de tempo.
- Descarte à entrada dos campos não necessários; código da reserva só em HMAC com chave separada.
- Chaves de API usadas só para leitura; sem gravação do corpo bruto dos pedidos **[a garantir na fase 2]**.
- Acesso por perfis; o Proprietário vê só as suas casas; a equipa de limpeza não vê links, chaves nem dados de reservas além do necessário.
- Apagamento automático por prazos (Anexo A); cópias de segurança cifradas, 14 dias.
- Contas dos fornecedores de nuvem com acesso restrito **[e 2FA: CONFIRMAR]**.
