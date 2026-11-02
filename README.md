# Radar de Voos

Rastreamento de voos em tempo real com dados abertos e comunitários (ADS-B). Uso **pessoal e não comercial**.

Em produção: **https://flight-tracking.pages.dev** (Cloudflare Pages: site + Worker). Cada push no `main` publica de novo.

## Arquitetura

```
Navegador (Vite + TS + MapLibre GL)
   │
   ├── /api/live, /api/callsign, /api/hex, /api/geo
   │      ▼
   │   Worker (Cloudflare Pages Function, functions/api/[[path]].ts)
   │      valida parâmetros · cache na edge · failover · última resposta boa se as fontes limitarem
   │      ▼
   │   adsb.lol → adsb.fi → airplanes.live      (posição dos aviões, formato readsb v2)
   │
   └── direto do navegador (estas APIs aceitam CORS), com cache local
          adsbdb.com · hexdb.io                 (rota provável, companhia, dados da aeronave)
          planespotters.net                     (fotos, com crédito)
          pics.avs.io                           (logos das companhias)
          tiles.openfreemap.org                 (mapa base)
```

**Por que nem tudo passa pelo Worker?**
As APIs de posição dos aviões recusam chamadas do navegador (CORS), por isso só funcionam através do Worker.
As de rota e aeronave aceitam o navegador, e o adsbdb responde `429` ao IP compartilhado da Cloudflare;
por isso o navegador as chama diretamente, cada visitante com o seu próprio limite.

### Rotas do Worker

| Rota | O que faz | Cache na edge |
|---|---|---|
| `GET /api/live?lat=&lon=&dist=` | Aviões num raio (NM, máx. 250) | 5 s (+ cópia de 2 min usada se todas as fontes falharem) |
| `GET /api/callsign/:cs` | Procura um voo pelo callsign, no mundo todo (para a busca) | 10 s |
| `GET /api/hex/:hex` | Procura uma aeronave pelo código ICAO 24-bit (para a busca) | 10 s |
| `GET /api/geo` | Localização aproximada do visitante, pelo IP (dado da Cloudflare) | nunca |

Só monta URLs a partir de parâmetros validados: não é um proxy aberto.

### Código

| Pasta | Conteúdo |
|---|---|
| `src/shared/providers.ts` | Catálogo de fontes e failover (usado pelo cliente **e** pelo Worker) |
| `src/normalize.ts` | readsb v2 → modelo `Aircraft` (unidades métricas, `"ground"`, rumo alternativo) |
| `src/store.ts` | Estado dos aviões + extrapolação de posição (dead reckoning) |
| `src/routes.ts` | Rotas (adsbdb, hexdb), fila de pedidos com pausa, progresso e horários estimados |
| `src/api.ts` · `src/cache.ts` | Chamadas às APIs e cache no navegador (rotas 1 dia, aeronaves 7 dias, limpeza automática) |
| `src/location.ts` · `src/map/userLocation.ts` | Localização do usuário: permissão, botão "centralizar em mim", mensagens de ajuda |
| `src/map/` | Camadas MapLibre: aviões (ícone girado, cor por altitude), rotas tracejadas |
| `src/poller.ts` | Polling sem sobreposição, backoff, pausa com aba oculta |
| `functions/api/` | Worker |
| `probe.html` | Página de diagnóstico: testa o Worker e as APIs a partir do navegador |

## Localização do usuário

O mapa abre na localização aproximada pelo IP (`/api/geo`), sem pedir nada. Depois:

| Permissão | O que acontece |
|---|---|
| Já autorizada | Usa o GPS e centraliza sozinho. |
| Ainda não decidida | Aviso "Ver os voos perto de você?" com **Usar minha localização**. O pedido do navegador só aparece nesse toque (pedidos sem toque são escondidos pelo Safari e pelo Chrome). |
| Negada | O botão ◎ fica cinza; tocando nele aparecem os passos para liberar no Safari (iPhone), no Chrome (Android) ou no computador. |

O botão ◎ (canto inferior direito) centraliza sempre que tocado e, se for preciso, pede a permissão nesse momento.
Se o GPS responder depois de o usuário já ter mexido no mapa, aparece "Localização encontrada · Centralizar" em vez de arrastar o mapa.
Falta de sinal ou demora: tenta mais uma vez com GPS de alta precisão antes de avisar.
Fechar o aviso (×) fica lembrado neste navegador.

## Comandos

```bash
npm install
npm run dev        # Vite em modo "direct" (sem Worker: a posição dos aviões não carrega por causa do CORS)
npm test           # testes unitários
npm run cf:dev     # build + Worker local via wrangler (igual à produção)
npm run cf:deploy  # publica no Cloudflare Pages a partir da máquina local
```

`/probe.html` → página de diagnóstico das APIs.

## Publicação

O Cloudflare Pages está ligado ao repositório (branch `main`):
build `npm run build`, saída `dist`, Node da versão em `.node-version`. A pasta `functions/` vira o `/api`.

O CI do GitHub (`.github/workflows/ci.yml`) roda testes e build em cada push e PR.
O GitHub Pages não é usado: sem o Worker o mapa ficaria vazio.

## Roteiro

- [x] Fase 0: diagnóstico das APIs. Posição dos aviões só via Worker (CORS); adsbdb, hexdb, Planespotters e OpenFreeMap funcionam direto
- [x] Fase 1: mapa ao vivo, polling por viewport, ícones girados, interpolação, seleção e painel de telemetria
- [x] Fase 2: rota provável e tracejada, companhia e logo, horários estimados, progresso, aeronave, operador, foto
- [x] Localização: botão "centralizar em mim", pedido de permissão no toque, ajuda quando bloqueada
- [ ] Fase 2b: trilha (caminho já percorrido pelo avião selecionado)
- [ ] Fase 3: "Perto de mim" (raio de 50 km + lista)
- [ ] Fase 4: busca por callsign/matrícula/hex (`/api/callsign` e `/api/hex` já existem)
- [ ] Fase 5: estado na URL, filtros, PWA

## Atribuição e licenças

Dados de voo: [adsb.lol](https://adsb.lol) (ODbL), [adsb.fi](https://adsb.fi), [airplanes.live](https://airplanes.live) (não comercial).
Rotas e aeronaves: [adsbdb](https://www.adsbdb.com), [hexdb](https://hexdb.io). Fotos: [Planespotters.net](https://www.planespotters.net) (crédito em cada foto).
Mapa: [OpenFreeMap](https://openfreemap.org) © OpenStreetMap contributors.
