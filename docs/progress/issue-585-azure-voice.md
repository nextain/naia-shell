# #585 Azure omni live + Neural HD TTS

- GitHub: https://github.com/nextain/naia-shell/issues/585
- Gateway: https://github.com/nextain/naia-anyllm/issues/74
- Date: 2026-09-10

## Product

- Live/omni (`azure-realtime`, Gemini Live): lock external STT and TTS. Voice = native sunhi/hyunsu or Kore.
- Pipeline: free Edge → local GPU → Naia Azure HD ($22/1M × 1.1 credits) → BYO Google/OpenAI/ElevenLabs.
- Do not use Live as a reader for another LLM. Do not offer `gpt-4o-mini` live.

## Price sheet (public → Naia credit × 1.1)

Source: Azure Speech list price + Azure Retail Prices API, southeastasia, 2026-09-10.

| SKU | Public | Naia credit | Meter |
|---|---|---|---|
| TTS Neural | $16 / 1M chars | $17.6 | Azure Speech Neural |
| TTS Neural HD (SunHi/Hyunsu) | $22 / 1M chars | $24.2 | Azure Speech Neural HD |
| Live `azure-realtime` / `gpt-realtime-mini` | $11 / $22 per 1M audio tokens | $12.1 / $24.2 | Voice Live Std LLM Audio in/out |
| Live `gpt-realtime` | $32 / $64 per 1M audio tokens | $35.2 / $70.4 | Voice Live Pro LLM Audio in/out |

1 min Live (30s in + 30s out, 10/20 tokens per second): Std ≈ $0.017 public / $0.019 credit.

## QC

Case IDs only. `#582` reserved sidecar numbers from QC-206, so these are not assigned yet.

- `VOICE-AZURE-OMNI-LOCK-001`
- `VOICE-AZURE-TTS-HD-001`
- `VOICE-AZURE-LIVE-ROUTE-001`
