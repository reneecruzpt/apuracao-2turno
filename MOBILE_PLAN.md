# Plano de otimização para telemóvel

Este documento define a próxima etapa de evolução do Painel TSE 2026: uma experiência mobile-first, mantendo a mesma fonte oficial do TSE, a mesma lógica de atualização e a mesma precisão dos dados da versão desktop.

## Estado de implementação

- **Fase 1 — estrutura: implementada**
  - cabeçalho mobile compactado;
  - navegação mobile convertida em abas: Presidente, Lula × Flávio, Governadores e Senado;
  - Lula × Flávio convertido em cartões por UF no mobile;
  - cartões de Governadores e Senado reorganizados para leitura em linhas de candidatos.
- **Fase 2 — interação: implementada**
  - filtros mobile com alvos de toque maiores e regiões em faixa horizontal rolável;
  - seletor compacto de ordenação para Lula × Flávio, com direção crescente/decrescente;
  - Pausar/Retomar, Verificar agora, abas e filtros com alvos mínimos de aproximadamente 44 px;
  - posição de leitura preservada durante atualizações automáticas e ao retomar a apuração.
- **Fase 3 — acabamento: implementada**
  - tipografia e espaçamentos refinados em 760/480/360 px;
  - cores de eleito e 2º turno revisadas para temas claro e escuro;
  - nomes longos, partidos e múltiplos badges passam a quebrar linha sem alargar o layout;
  - Presidente ganha layout compacto em cartões abaixo de 480 px;
  - proteção contra overflow horizontal não intencional nas seções mobile.
- **Fase 4 — performance e acessibilidade: implementada (validação manual em dispositivo recomendada)**
  - no mobile, somente a aba visível é renderizada a cada atualização; as demais são renderizadas quando abertas;
  - animações de células são agrupadas em `requestAnimationFrame`, removendo reflows síncronos por célula;
  - polling automático é suspenso enquanto a aba está em segundo plano e uma verificação imediata ocorre ao retornar quando os dados podem estar desatualizados;
  - `aria-busy`, semântica de `tabpanel`, foco por teclado e respeito a `prefers-reduced-motion` foram reforçados;
  - estilos adicionais para alto contraste/`forced-colors` e zoom estreito foram adicionados;
  - VoiceOver/TalkBack continuam recomendados como validação manual final em dispositivos reais.

## Objetivo

Criar uma versão confortável para uso em telemóveis, especialmente em telas entre 320 px e 480 px, sem transformar o painel numa aplicação diferente. A prioridade é permitir leitura rápida durante a apuração, com pouca rolagem horizontal, controles acessíveis com o polegar e informação crítica visível logo no primeiro ecrã.

## Princípios

- preservar exatamente os mesmos dados e regras da versão desktop;
- priorizar leitura vertical e reduzir tabelas largas;
- evitar esconder informação importante atrás de interações desnecessárias;
- manter Lula/Flávio identificáveis por texto além das cores;
- manter estados de atualização, pausa, conclusão e erro sempre visíveis;
- minimizar layout shift durante atualizações;
- manter baixo consumo de rede e CPU;
- garantir suporte a tema claro/escuro e acessibilidade.

## Estrutura mobile proposta

### 1. Cabeçalho compacto

No telemóvel, o cabeçalho deve ocupar menos altura.

Proposta:

- título curto: `Painel TSE 2026`;
- progresso nacional imediatamente abaixo;
- linha compacta com última consulta e próxima atualização;
- controles `Pausar/Retomar`, `Verificar agora` e tema em uma barra própria;
- o cabeçalho deixa de ser sticky em telas pequenas para não consumir área útil permanentemente.

Meta: toda a área de status deve caber em aproximadamente 160–190 px de altura em um aparelho comum.

### 2. Navegação por abas no mobile

A barra mobile funciona como um conjunto de abas:

- Presidente
- Lula × Flávio
- Governadores
- Senado

Somente a seção ativa fica visível em telas de até 760 px. O desktop continua exibindo todas as seções em sequência. A aba ativa é refletida no hash da URL (`#presidente`, `#estados`, `#governadores`, `#senado`), de modo que recarregar ou compartilhar a URL preserva a seção escolhida.

### 3. Presidente

A tabela presidencial é estreita e pode continuar como tabela.

Ajustes:

- candidato e partido na mesma célula quando a largura for muito pequena;
- votos em uma linha secundária;
- percentual com maior destaque;
- barra percentual mantida, porém mais curta;
- reduzir padding horizontal.

### 4. Lula × Flávio por estado

Esta é a seção prioritária para mobile.

Em vez da tabela horizontal completa, cada UF deve virar um cartão compacto:

```text
AC                         98,06%
Lula       28,66%
Flávio     64,61%
▲ Flávio +35,95 p.p.
Dif. votos +XXX.XXX
```

Requisitos:

- manter o destaque vermelho/verde atual;
- mostrar sempre o nome de quem lidera;
- manter diferença percentual e diferença absoluta;
- manter seções totalizadas;
- filtros por região continuam disponíveis;
- ordenação deve continuar disponível por meio de um seletor compacto;
- evitar scroll horizontal nesta seção.

### 5. Governadores

A visualização mobile já usa estrutura semelhante a cartões, mas deve ser reorganizada para deixar a disputa mais fácil de interpretar.

Proposta por UF:

```text
AC                    Em apuração
1º Mailza Assis       PP      49,68%
2º Alan Rick          REP     32,31%
3º Tião Bocalom       PSDB    10,25%
Dist. p/ 2º                  22,06 p.p.
Seções                        98,06%
```

Para status final:

- `✓ Eleito TSE`
- `↪ 2º turno TSE`
- `🔒 1º turno definido`

Os badges devem ocupar uma única linha sempre que possível e não provocar alargamento horizontal.

### 6. Senado

Usar o mesmo padrão de cartão de Governadores.

Prioridades:

- 1º e 2º como faixa das duas vagas;
- 3º visualmente separado como candidato fora da faixa;
- mostrar `Dist. p/ 2º`;
- manter `🔒 Vaga garantida` e `✓ Eleito TSE`;
- evitar tabela horizontal no mobile.

### 7. Filtros e ordenação

Hoje os filtros foram concebidos principalmente para desktop.

Para mobile:

- chips de região em uma linha horizontal rolável;
- `Margem < 5 p.p.` e `Apuração ≥ 50%` em segunda linha;
- ordenação em `select` ou menu compacto:
  - UF
  - Lula %
  - Flávio %
  - Diferença %
  - Diferença de votos
  - Seções totalizadas
- botão `Limpar` sempre visível.

## Performance

### Rede

Não alterar a estratégia atual de dados:

- EA14 continua sendo detector de mudanças;
- EA20 só é solicitado quando necessário;
- polling continua em 15 s durante a apuração;
- polling encerra após totalização final oficial e estabilidade;
- uma aba em background não deve ganhar lógica de polling adicional.

Quando `document.visibilityState === "hidden"`, o painel suspende o polling automático para reduzir rede e CPU. Ao retornar à aba, faz uma verificação imediata se ela ficou oculta por pelo menos um ciclo normal de 15 segundos.

### Renderização

- continuar atualizando células/cartões em lugar de recriar toda a página;
- evitar animações pesadas;
- limitar transições a propriedades simples;
- não usar bibliotecas externas para layout mobile;
- manter CSS e JavaScript nativos.

## Acessibilidade

Critérios mínimos:

- alvos de toque com aproximadamente 44 × 44 px para controles principais;
- foco visível;
- contraste suficiente em tema claro e escuro;
- não depender exclusivamente de vermelho/verde;
- manter `aria-live` para atualização/status;
- títulos de seção e ordem semântica coerentes;
- testes com zoom do navegador em 200%.

## Breakpoints propostos

Evitar muitos breakpoints. Trabalhar com três faixas:

- **Desktop:** acima de 900 px;
- **Tablet / mobile grande:** 481–900 px;
- **Mobile:** até 480 px.

A maior parte das mudanças estruturais deve ocorrer em `max-width: 760px`, aproveitando a regra já existente. Ajustes extras de densidade ficam em `max-width: 480px`.

## Ordem de implementação

### Fase 1 — estrutura

1. reduzir o cabeçalho mobile;
2. adicionar navegação por abas;
3. transformar Lula × Flávio em cartões mobile;
4. revisar cartões de Governadores e Senado.

### Fase 2 — interação

1. adaptar filtros para toque;
2. criar seletor compacto de ordenação;
3. revisar Pausar/Retomar e Verificar agora em largura pequena;
4. preservar scroll/posição durante atualizações.

### Fase 3 — acabamento

1. ajustar tipografia e espaçamentos;
2. revisar tema escuro;
3. testar textos longos de candidatos/partidos;
4. testar badges simultâneos;
5. remover qualquer overflow horizontal não intencional.

### Fase 4 — performance e acessibilidade

1. testar CPU/re-render durante apuração;
2. testar aba em background;
3. testar VoiceOver/TalkBack quando possível;
4. testar teclado e zoom;
5. revisar CLS/layout shift nas atualizações.

## Matriz mínima de testes

Validar pelo menos estas larguras:

| Largura | Cenário |
|---:|---|
| 320 px | telemóvel pequeno |
| 360 px | Android comum |
| 390 px | iPhone atual |
| 430 px | telemóvel grande |
| 768 px | tablet vertical |
| 1024 px | tablet/desktop pequeno |
| 1440 px | desktop |

Testar também:

- tema claro e escuro;
- página durante carga inicial;
- consulta com falha parcial;
- atualização de uma UF;
- pausa durante requisição;
- apuração 100%;
- eleição finalizada;
- nomes de candidatos muito longos;
- badges de eleito/2º turno/vaga garantida.

## Critérios de aceite

A versão mobile será considerada pronta quando:

- nenhuma seção principal exigir scroll horizontal em 360–430 px;
- Lula × Flávio for legível sem ampliar a tela;
- Governadores e Senado mostrarem os três candidatos sem perda de informação;
- filtros e controles puderem ser operados confortavelmente por toque;
- a atualização dos dados não reposicionar a página de forma perceptível;
- não houver regressão na versão desktop;
- os estados oficiais do TSE continuarem semanticamente iguais aos da versão desktop;
- Lighthouse mobile não apontar problemas graves de acessibilidade ou layout.

## Fora de escopo desta etapa

Não fazem parte desta otimização:

- aplicativo Android/iOS nativo;
- PWA/offline completo;
- notificações push;
- mudança da fonte oficial de dados;
- backend próprio;
- reformulação da identidade visual do desktop.

A primeira implementação deve continuar sendo um único site responsivo em GitHub Pages.
