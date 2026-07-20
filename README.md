# GHL Voice Note

Botão de microfone no composer do GoHighLevel. Grava voice note no browser,
converte para WAV 16kHz mono e injeta no input de anexo nativo do GHL.

Vanilla JS, sem build, sem dependência.

## Instalação

`Settings → Company → aba Whitelabel → Custom JavaScript`:

```html
<script>window.__T3A_VOICE_LOCATIONS__ = ["SUA_LOCATION_ID"];</script>
<script async src="https://t3a-enterprise.github.io/ghl-voice-note/t3a-voice-recorder.js"></script>
```

O `async` é obrigatório: sem ele, uma lentidão neste host deixaria o GHL lento
para todas as sub-accounts.

O `location_id` sai da URL: `/v2/location/<ESTE_PEDACO>/conversations/...`

## Kill switch

`config.json` controla o botão remotamente, sem tocar no GHL:

```json
{ "enabled": false, "blocked": [] }
```

- `enabled: false` → desliga em todas as sub-accounts (até 15 min, ou no reload)
- `blocked: ["id"]` → desliga só naquela sub-account
- Arquivo inacessível → o script assume **desligado** (fail-closed)

## Guards

O botão só aparece quando **todas** as condições valem:

1. O `location_id` da URL está em `__T3A_VOICE_LOCATIONS__`
2. `config.json` responde com `enabled: true`
3. O `location_id` não está em `blocked`
4. O composer e o input de anexo existem na página

Em qualquer dúvida, o botão não aparece. Nunca quebrar a tela de Conversations.

## Limites

| | |
|---|---|
| Duração máxima | 2min30 |
| Formato | WAV PCM 16-bit mono 16kHz |
| Tamanho | ≤ 4,8 MB (teto do GHL é 5 MB decimal) |
| Mínimo | 0,7s (evita clique acidental) |

WAV a 16kHz gasta 32.000 B/s — é o que faz 2min30 caber no limite de anexo.
Gravar a 48kHz limitaria a 52 segundos.

## Console

```js
window.__T3A_VOICE__.debug()    // liga os logs
window.__T3A_VOICE__.disable()  // desliga nesta aba
window.__T3A_VOICE__.enable()   // liga nesta aba (pula os guards — só para teste)
```

## Compatibilidade

Chrome, Edge e Firefox no desktop. Safari/iOS deve funcionar (o AudioContext é
criado antes do `getUserMedia`, que é a ordem que o iOS exige), mas não foi
testado. Não funciona no app mobile nativo do GHL — Custom JS é só web.
