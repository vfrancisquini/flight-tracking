# Radar de Voos

Rastreamento de voos em tempo real com dados abertos e comunitários (ADS-B). Uso **pessoal e não comercial**.

## Arquitetura

```
Navegador (Vite + TS + MapLibre GL)
   │  polling a cada 10 s do círculo que cobre o viewport (máx. 250 NM)
   ▼
/api/*  ← Cloudflare Pages Function (functions/api/[[path]].ts)
   │  valida parâmetros · cache na edge · failover entre fontes
   ▼
adsb.lol → adsb.fi → airplanes.live   (telemetria, formato readsb v2)
adsbdb.com                             (rota provável, dados da aeronave)
planespotters.net                      (fotos — crédito obrigatório)
```

| Pasta | Conteúdo |
|---|---|
| `src/shared/providers.ts` | Catálogo de fontes e failover (usado pelo cliente **e** pelo Worker) |
| `src/normalize.ts` | readsb v2 → modelo `Aircraft` (unidades métricas, `"ground"`, rumo alternativo) |
| `src/store.ts` | Estado dos aviões + extrapolação de posição (dead reckoning) |
| `src/map/` | Camada MapLibre: ícone SDF girado pelo rumo, cor por altitude, seleção |
| `src/poller.ts` | Polling sem sobreposição, backoff, pausa com aba oculta |
| `functions/api/` | Worker mínimo |
| `probe.html` | **Fase 0**: testa CORS e limites das APIs a partir do navegador |

## Comandos

```bash
npm install
npm run dev        # Vite em modo "direct" (o navegador chama as APIs; exige CORS)
npm test           # unitários (normalização, geo, Worker com fetch simulado)
npm run cf:dev     # build + Worker local via wrangler (modo "proxy", igual à produção)
npm run cf:deploy  # publica no Cloudflare Pages
```

`http://localhost:5173/probe.html` → página de teste das APIs.

## Publicar no Cloudflare Pages (site + Worker)

As APIs de telemetria **não aceitam chamadas diretas do navegador** (CORS, confirmado na fase 0),
por isso o site precisa do Worker em `/api`. O Cloudflare Pages serve os dois juntos, de graça:

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
2. Escolha o repositório `flight-tracking`, branch `main`.
3. Build settings: preset **None**, build command `npm run build`, output directory `dist`.
4. **Save and Deploy**. A pasta `functions/` é detectada sozinha e vira o `/api`.

Cada push no `main` publica de novo. O endereço fica `https://<projeto>.pages.dev`.
Para confirmar o Worker, abra `https://<projeto>.pages.dev/probe.html`: as linhas **Worker** devem dar `ok`.

## Roteiro

- [x] Fase 0: página de teste das APIs. Resultado: telemetria só via Worker (CORS); adsbdb, Planespotters, OurAirports e OpenFreeMap funcionam direto
- [x] Fase 1: mapa ao vivo, polling por viewport, ícones girados, interpolação, seleção e painel de telemetria
- [ ] Fase 2: rota provável (adsbdb), dados da aeronave, foto, trilha
- [ ] Fase 3: "Perto de mim" (raio de 50 km + lista)
- [ ] Fase 4: busca por callsign/matrícula/hex
- [ ] Fase 5: estado na URL, filtros, PWA, ajustes mobile

## Atribuição e licenças

Dados de voo: [adsb.lol](https://adsb.lol) (ODbL), [adsb.fi](https://adsb.fi), [airplanes.live](https://airplanes.live) (não comercial).
Mapa: [OpenFreeMap](https://openfreemap.org) © OpenStreetMap contributors.
