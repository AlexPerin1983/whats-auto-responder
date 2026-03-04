# Películas Brasil Bot - Consultive Conversation Flow

## Visual Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLIENT INITIATES CONTACT                    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  BOAS-VINDAS    │
                    │ (Sim/Não buttons)│
                    └────┬───────┬────┘
                         │       │
                    SIM  │       │  NÃO
                         ▼       ▼
            ┌──────────────────┐ ┌──────────────────┐
            │ PROBLEM SELECTION│ │    CANCELAMENTO  │
            │   (4 options)    │ │    (Encerrada)   │
            └────────┬─────────┘ └──────────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼            ▼
    ┌──────┐   ┌──────────┐  ┌──────────┐  ┌────────┐
    │Calor │   │Privacidade│ │Claridade │ │Estética│
    └──┬───┘   └────┬─────┘  └────┬─────┘  └───┬────┘
       │             │             │            │
       ▼             ▼             ▼            ▼
    ┌──────────────────────────────────────────────┐
    │  AUTO-RECOMMEND FILM TYPE                    │
    │  Calor      → Nano Cerâmica 🌡️            │
    │  Privacidade→ Espelhada 🪞                  │
    │  Claridade  → Fumê ☀️                       │
    │  Estética   → Fosco/Espelhado 🎨           │
    └────────────────┬─────────────────────────────┘
                     │
              ┌──────▼──────┐
              │PROPERTY TYPE │ (Casa/Apto/Comercial)
              └──────┬───────┘
                     │
              ┌──────▼────────┐
              │    QUANTITY   │ (How many surfaces?)
              └──────┬────────┘
                     │
              ┌──────▼────────────────┐
              │  REQUEST MEASUREMENTS │
              │  (Repeat for each)    │
              └──────┬────────────────┘
                     │
              ┌──────▼──────────┐
              │ REQUEST PHOTOS  │
              └──────┬──────────┘
                     │
         ┌───────────▼───────────┐
         │   FLOW COMPLETE       │
         │ (Send to owner/Alex)  │
         └───────────────────────┘
```

## State Variables

### Core Information (`informacoes_coletadas`)
```javascript
{
  nome: 'João Silva',                    // Client name
  bairro: 'tambaú',                      // Neighborhood
  tipo_imovel: 'apartamento',            // Property type
  problema_principal: 'calor',           // Main problem
  pelicula_indicada: 'nano cerâmica',    // Auto-recommended film
  quantidade_janelas: 3,                 // Number of surfaces
  janelas: [                             // Details for each
    { numero: 1, medida: '1.5 x 1.2', ... },
    { numero: 2, medida: '2.0 x 1.5', ... },
    { numero: 3, medida: '1.5 x 1.2', ... }
  ],
  pelicula_desejada: null,               // (Optional) client preference
  fotos_recebidas: true                  // Photos submitted?
}
```

### Flow Control States
```javascript
{
  _aguardando_boas_vindas: false,        // Waiting for initial Sim/Não
  _boas_vindas_confirmada: true,         // Confirmed they want film
  _aguardando_problema: true,            // Waiting for problem selection
  _problema_selecionado: false,          // Problem has been selected
  _fluxo_completado: false               // Flow finished?
}
```

## Message Examples by Stage

### 1. BOAS-VINDAS
**Bot sends:**
```
Olá! 👋 Bem-vindo à Películas Brasil 🪟

Você está buscando colocar insulfilm? Deixa que eu ajudo! 😊

[✅ Sim]  [❌ Não]
```

### 2. PROBLEM SELECTION (After "Sim")
**Bot sends:**
```
Qual o principal problema que você quer resolver com a película? 🎯

[🌡️ Calor excessivo]
[👁️ Privacidade]
[☀️ Excesso de claridade]
[🎨 Estética / decoração]
```

### 3. AUTO-RECOMMENDATION (After selecting problem)
**Example for "Calor":**
```
Para reduzir o calor a melhor opção é a Nano Cerâmica 🌡️ — 
bloqueia até 80% do calor sem escurecer muito. Uma opção mais 
econômica é o Fumê.

Vamos ver o que você precisa!
```

**Example for "Privacidade":**
```
Para privacidade recomendo o Espelhado 🪞 — de dia fica como 
espelho por fora, ninguém vê o interior. Se preferir privacidade 
total, temos o Fosco.

Vamos ver o que você precisa!
```

### 4. PROPERTY TYPE
**Bot sends:**
```
João, é para uma casa, apartamento ou estabelecimento comercial?
```
**Client responds:** "Apartamento"

### 5. QUANTITY
**Bot sends:**
```
João, quantas janelas, portas ou superfícies você quer colocar película?
```
**Client responds:** "3 janelas"

### 6. MEASUREMENTS (Multiple)
**First measurement:**
```
João, qual a medida da janela 1? (de 3)
(largura × altura, em cm ou metros)
```
**Client:** "1.5 x 1.2 m"
**Bot:** [Auto-stores, asks for next]

### 7. PHOTOS
**Bot sends:**
```
João, pode me mandar uma foto do local onde vai colocar a película? 
Isso ajuda a dar um orçamento mais preciso! 📸
```
**Client:** [Sends photo/image]

### 8. COMPLETION
**Bot sends:**
```
Perfeito, recebi tudo! 😊

O Alex vai analisar e te manda o orçamento em breve. 
Obrigado pela confiança na Películas Brasil! 🪟
```

**Alex receives:**
```
🔔 NOVO LEAD — Películas Brasil

👤 Cliente: João Silva
📍 Bairro: Tambaú
🏠 Imóvel: Apartamento
📞 WhatsApp: +5511999999999

🌡️ Problema: Calor excessivo
🎬 Película indicada: Nano cerâmica
🪟 Qt. superfícies: 3

🪟 Janela 1: 1.5 x 1.2 | ? folha(s)
🪟 Janela 2: 2.0 x 1.5 | ? folha(s)
🪟 Janela 3: 1.5 x 1.2 | ? folha(s)

📸 Fotos: Sim ✅
⏱ Início: 04/03/2026, 14:30:25
```

## Problem → Film Mapping

| Problem | Icon | Recommended Film | Alternative |
|---------|------|------------------|-------------|
| Calor (Heat) | 🌡️ | Nano Cerâmica | Fumê |
| Privacidade (Privacy) | 👁️ | Espelhada | Fosca |
| Claridade (Light) | ☀️ | Fumê G20/G35 | - |
| Estética (Aesthetics) | 🎨 | Espelhado/Fosco | - |

## Special Commands

### Owner/Alex Commands
Prefix: `#bot`

**Reiniciar (Reset conversation):**
```
#bot reiniciar
```
Effect: Clears all collected data, sends boas-vindas again

## Error Handling

### If Client Doesn't Recognize Problem Options
**Bot response:**
```
Por favor, escolha uma das opções:
*1* — 🌡️ Calor excessivo
*2* — 👁️ Privacidade
*3* — ☀️ Excesso de claridade
*4* — 🎨 Estética / decoração
```

### If Outside Working Hours
**Bot response:**
```
Desculpa! 😴 Estamos fora do horário comercial. 
Vamos responder assim que possível! Mensagens que você mandar 
agora serão respondidas quando a gente voltar a trabalhar. 👋
```

### If Timeout (30 minutes inactive)
- Conversation is reset
- Client must start over with boas-vindas
- No data loss for completed leads (already sent to Alex)

## Integration Points

### What Triggers Lead Sending to Alex
When `isFlowComplete()` returns true:
1. All required fields are filled
2. "Perfeito, recebi tudo!" message sent to client
3. Full summary message sent to owner/Alex
4. Conversation marked as `_fluxo_completado: true`

### What the LLM Does
- Extracts data when regex patterns don't match
- Interprets client intent
- Only activated during working hours
- Handles natural language variations

## Testing User Scenarios

### Scenario 1: Direct Problem Mention
```
User: "Olá, é que faz muito calor no meu apartamento"
Bot detects: problema_principal = 'calor'
Bot skips redundant problem question
Bot shows calor recommendation immediately
```

### Scenario 2: Uses Numbered Response
```
Bot: [Shows 4 problem options]
User: "3"
Bot: Detects option #3 = claridade
Bot: Shows claridade recommendation (Fumê)
```

### Scenario 3: Uses Button
```
Bot: [Shows 4 problem buttons]
User: [Taps "👁️ Privacidade" button]
Bot: Detects button ID = prob_privacidade
Bot: Shows privacy recommendation (Espelhada)
```

### Scenario 4: Audio Message
```
User: [Sends audio: "Preciso de privacidade"]
Bot: Transcribes with Whisper
Bot: LLM detects problema_principal = 'privacidade'
Bot: Shows recommendation automatically
```

