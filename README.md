# Painel Trade (simulação)

Terminal de agentes de crypto **paper-trading** — dinheiro de mentira, sem carteira, sem chaves, sem trades reais.

## Aviso

Isto é só uma simulação. Tokens novos são muito arriscados e a maioria das pessoas perde dinheiro com eles.

## Agentes

- **SCANNER** — observa pares/boosts via DexScreener (volume, liquidez, idade)
- **RUG CHECK** — bloqueia liquidez baixa, par muito novo/antigo, concentração extrema, volume fraco
- **SIZER** — tamanho da posição como % do equity atual
- **EXECUTOR** — abre/fecha posições simuladas com slippage ~2% + taxa 0,3%
- **LOGGER** — registra cada decisão (incl. skips) em horário BRT
- **EQUITY** — saldo + curva atualizada a cada fechamento

## Estratégia (resumo)

1. Entrada: spike de volume + liquidez mínima + momentum h1 positivo (não extremo)
2. Saída: take-profit, stop-loss ou time-stop
3. Fills honestos: preço vivo ± slippage + fee
4. Persistência em `localStorage`; pausar / resetar / config editável

## Dados

[DexScreener public API](https://api.dexscreener.com) (CORS `*`, sem chave). Poll ~20s.

## Deploy

GitHub Pages a partir da branch `main` (raiz).

## Local

Abra `index.html` via qualquer static server, ou use Pages.
