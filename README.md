# Apuração presidencial 2026

Painel independente para acompanhar Lula e Flávio Bolsonaro no segundo turno, com arquivos EA20 oficiais do Tribunal Superior Eleitoral.

## O que a página faz

- Abre na apuração nacional e permite mudar para uma UF.
- Busca município pelo nome, em todo o país ou dentro da UF escolhida. A pessoa não precisa conhecer nem digitar código eleitoral.
- Ao selecionar uma cidade, troca o placar para o recorte municipal e carrega o arquivo EA20 daquela cidade. A UF e o município são validados juntos antes da exibição.
- Compara cada candidato com a parcial anterior do mesmo recorte e separa liderança, garantia matemática e totalização final nacional.
- Mantém o arquivo do primeiro turno preservado em `primeiro-turno/`.

## Iniciar localmente

Requer Node.js 20 ou superior. Não há dependências externas.

Execute `npm start` e abra http://127.0.0.1:8766. O processo serve o site, pesquisa municípios em `/api/municipalities` e disponibiliza o cache de resultados em `/api/results`.

Em produção, use um host Node com disco persistente. Configure `PORT` e `HOST` conforme o provedor. O diretório `data/` guarda o histórico compartilhado e não é servido como conteúdo público. Hospedagens apenas estáticas, como GitHub Pages, não executam a API.

## Publicação no Render

O arquivo `render.yaml` configura o serviço Node para publicação no Render: usa a porta fornecida pelo provedor, expõe a aplicação em `0.0.0.0` e valida a saúde em `/api/health`. A configuração escolhe o plano gratuito e não adiciona disco persistente nem serviço pago.

No plano gratuito, o sistema de arquivos é temporário e o serviço pode suspender após períodos sem tráfego. Após um reinício, o coletor volta a buscar o estado oficial; o histórico local de parciais pode não sobreviver. Para retenção garantida do histórico e disponibilidade contínua, será necessário um armazenamento persistente ou serviço compatível.

## Fonte e integridade

A aplicação acompanha a eleição federal 6258, segundo turno, cargo de Presidente. Os dados publicados em JWS são conferidos com a assinatura EdDSA e com a chave pública oficial do TSE antes de serem aceitos. A validação confere ainda eleição, turno, tipo, abrangência, IDG, candidaturas, votos e seções. O navegador valida novamente a resposta local antes de alterar o placar.

Arquivos oficiais consumidos pelo coletor central:

- Acompanhamento Nacional/UF (**EA14**): `br/br-e006258-ab.jws`
- Acompanhamento Municipal por UF (**EA15**): `{uf}/{uf}-e006258-ab.jws`
- Resultado Nacional (**EA20**): `br/br-c0001-e006258-u.jws`
- Resultado Estadual (**EA20**): `{uf}/{uf}-c0001-e006258-u.jws`
- Resultado Municipal (**EA20**): `{uf}/{uf}{código-interno}-c0001-e006258-u.jws`

A lista de municípios vem do cadastro oficial **EA12** assinado pelo TSE. O servidor compartilha o cadastro em memória por seis horas, agrupa leituras simultâneas e aplica o mesmo intervalo global e backoff de falhas. O código municipal é interno ao serviço; a pesquisa e as opções exibem apenas o nome e a UF. Os retratos dos cartões vêm da galeria oficial do TSE e são servidos localmente pelo painel.

A última leitura oficial válida é preservada durante falhas. Uma geração anterior não substitui uma mais recente. O resultado final só é anunciado quando o arquivo nacional marca a totalização como concluída. A garantia matemática exige uma vantagem maior que todo o eleitorado ainda não apurado.

## Atualização, coletor central e resiliência

- **Coletor central ativo ao iniciar o servidor:** Após o servidor abrir a porta com sucesso, um ciclo automático começa imediatamente e verifica o trabalho a cada 5 segundos. A fila serial do processo permite **uma única chamada externa por vez** e impõe pelo menos 5 segundos entre chamadas a `EA12`, `EA14`, `EA15` e `EA20` (12 chamadas por minuto no máximo, quando todas respondem sem demora).
- **Uma instância por IP de saída:** A fila é local ao processo Node. Execute uma única instância/replica por IP de saída do TSE; processos independentes não compartilham essa fila.
- **Desacoplamento navegador × TSE:** Os navegadores leem o cache local do servidor a cada 5 segundos; nenhum clique do visitante dispara atualização no TSE. O botão *Pausar* congela a apresentação daquele navegador, enquanto as leituras do cache e o coletor central continuam. Ao retomar, o navegador mostra a versão mais recente disponível no servidor.
- **Monitoramento inteligente por `EA14` e `EA15`:** O coletor monitora Brasil e recortes visualizados (`EA14` para Brasil/UF e `EA15` para a UF de cada município selecionado). Quando o acompanhamento indica mudança (`dt`, `ht`, `s.st`, `and`), o coletor prioriza a busca do `EA20` daquele recorte com tentativas espaçadas e limitadas até a versão na CDN acompanhar o sinal.
- **URLs canônicas e cabeçalhos condicionais:** As consultas usam a URL canônica do arquivo `.jws` (sem query string `nocache`) com `ETag` (`If-None-Match`) e `Last-Modified` (`If-Modified-Since`), contabilizando respostas `304` na fila global.
- **Tratamento específico por status HTTP original:**
  - `429`: ativa pausa global de proteção de pelo menos **10 minutos**, sem permitir contorno manual.
  - `503`: recebe espera progressiva (`15s` até `10 min`).
  - `404`: é registrado com seu status original e recebe período de espera (`60s` iniciais até `10 min`) para evitar tentativas repetidas.
  - O servidor preserva e informa o status HTTP original da origem (`upstreamStatus`) em vez de mascarar falhas distintas como `503`.
- **Mapa interativo sem prefetch cego:** `/api/states` é estritamente passivo (não dispara *prefetch* de UFs ausentes). O andamento de seções das 27 UFs vem do `EA14` e a busca oportunista do `EA20` estadual só ocorre em *slots* ociosos quando o `EA14` sinaliza avanço real (`st > 0`), sempre com prioridade para o recorte ativo.

O manual técnico do TSE descreve o teto de requisições por IP e orienta como obter os arquivos: [informações técnicas sobre divulgação de resultados](https://www.tse.jus.br/eleicoes/informacoes-tecnicas-sobre-a-divulgacao-de-resultados).

## Fontes oficiais

- [Resultados do segundo turno no TSE](https://resultados.tse.jus.br/oficial/app/index.html#/eleicao/6258/uf/br/cargo/1/vis/nominal/resultados)
- [Informações técnicas do TSE](https://www.tse.jus.br/eleicoes/informacoes-tecnicas-sobre-a-divulgacao-de-resultados)
- [Documentação EA20](https://www.tse.jus.br/eleicoes/eleicoes-2026-content/arquivos/divulgacao-de-resultados/tse-ea20-arquivo-de-resultado-unificado)
- [Configuração municipal EA12](https://www.tse.jus.br/eleicoes/eleicoes-2026-content/arquivos/divulgacao-de-resultados/tse-ea12-arquivo-de-configuracao-de-municipios)
