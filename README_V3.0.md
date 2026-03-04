# Películas Brasil WhatsApp Bot v3.0
## Consultive Approach - System Prompt v3.0

**Status:** ✅ Complete & Ready to Deploy
**Last Updated:** March 4, 2026
**Owner:** Alex (Películas Brasil)
**Location:** João Pessoa, Brazil

---

## What's New in v3.0

This is a complete redesign of the bot conversation flow from **technical-first** to **problem-first**.

### Old Approach (v2.x)
```
Bot: Hello! Tell me the window model?
Client: I don't know...
Bot: Glass type?
Client: Um, transparent?
Bot: Fixation method?
Client: I have no idea, just want to reduce heat...
```
❌ Confusing, client frustrated, high dropout rate

### New Approach (v3.0) - Consultive
```
Bot: What's your main problem with your windows?
Client: Too much heat
Bot: Perfect! Nano Cerâmica blocks 80% of heat without darkening
Bot: Now, is this for a house, apartment, or business?
Client: Apartment
Bot: Great! How many windows/surfaces?
Client: 3
[... continues naturally ...]
```
✅ Client feels understood, recommendations provided, higher conversion

---

## Key Features

### 1. Problem-Based Recommendation System
Client selects **ONE** main problem:
- 🌡️ **Calor (Heat)** → Recommend: Nano Cerâmica
- 👁️ **Privacidade (Privacy)** → Recommend: Espelhada  
- ☀️ **Claridade (Light)** → Recommend: Fumê G20/G35
- 🎨 **Estética (Aesthetics)** → Recommend: Espelhado/Fosco

Bot automatically maps problem → film type. No guessing!

### 2. Intelligent Data Collection
- **Regex extraction:** Quick pattern matching for obvious info
- **LLM extraction:** Groq AI for natural language understanding
- **Auto-mapping:** Problem → recommended film (no client confusion)
- **Natural flow:** Questions asked in logical order

### 3. Conversation States
Each conversation tracks:
- Current stage (boas-vindas, problem selection, data collection)
- All collected information (name, neighborhood, property type, etc)
- Problem selected and film type recommended
- Photos received status
- Completion status

### 4. Three-Layer Fallback for Buttons
If interactive buttons fail:
1. **Preferred:** Interactive list (WhatsApp's newer UI)
2. **Fallback 1:** Interactive buttons (legacy)
3. **Fallback 2:** Text with numbered options (always works)

### 5. Lead Summary for Alex
When flow completes, Alex receives:
```
🔔 NOVO LEAD — Películas Brasil

👤 Cliente: João Silva
📍 Bairro: Tambaú
🏠 Imóvel: Apartamento
📞 WhatsApp: +5511999999999

🌡️ Problema: Calor excessivo
🎬 Película indicada: Nano cerâmica
🪟 Qt. superfícies: 3

[Measurements listed]
📸 Fotos: Sim ✅
⏱ Início: 04/03/2026, 14:30:25
```

---

## Installation & Setup

### Prerequisites
```bash
Node.js 16+
npm or yarn
GROQ_API_KEY (for LLM features)
WhatsApp account (for bot)
```

### Files Included
```
bot.js                  # Main bot logic (1172 lines)
server.js              # Express server & state management
index.js              # Startup file
package.json          # Dependencies

# Documentation
CHANGES_SUMMARY.md     # What changed from v2.x
CONVERSATION_FLOW.md   # Visual flow & examples
CODE_REFERENCE.md      # Function reference guide
README_V3.0.md         # This file
```

### Quick Start
```bash
# 1. Set environment variable
export GROQ_API_KEY=your_groq_api_key_here

# 2. Start bot
node index.js

# 3. Scan QR code with WhatsApp
# Bot will show QR in terminal

# 4. Test with a client
# Message the bot's WhatsApp number
```

---

## Configuration

Edit `state.settings` in `server.js`:

```javascript
const state = {
  settings: {
    owner_jid: 'YOUR_WHATSAPP_NUMBER@s.whatsapp.net',  // Alex's number
    horario_inicio: '07:00',    // Work start time
    horario_fim: '21:00',       // Work end time
    delay_min: 2000,            // Min delay between messages (ms)
    delay_max: 5000,            // Max delay between messages (ms)
    groq_api_key: process.env.GROQ_API_KEY  // From environment
  },
  // ... rest of state
};
```

### Working Hours
- **Default:** 7 AM - 9 PM (São Paulo timezone)
- **Outside hours:** Bot replies "We're offline, responses pending"
- **Customizable:** Edit `horario_inicio` and `horario_fim`

### Message Delays
- **Purpose:** Look natural, avoid being blocked
- **Range:** 2-5 seconds (randomized)
- **Customizable:** Change `delay_min` and `delay_max`

---

## Conversation Flow (Complete)

### Step 1: Boas-Vindas (Welcome)
```
Bot: Olá! 👋 Bem-vindo à Películas Brasil 🪟
     Você está buscando colocar insulfilm? Deixa que eu ajudo! 😊
     
     [✅ Sim]  [❌ Não]
```
**User action:** Click Sim or type yes/okay

---

### Step 2: Problem Selection (NEW in v3.0)
```
Bot: Qual o principal problema que você quer resolver? 🎯
     
     [🌡️ Calor excessivo]
     [👁️ Privacidade]
     [☀️ Excesso de claridade]
     [🎨 Estética / decoração]
```
**User action:** Select one problem

---

### Step 3: Auto-Recommendation (NEW in v3.0)
**Example response for "Calor":**
```
Bot: Para reduzir o calor a melhor opção é a Nano Cerâmica 🌡️ —
     bloqueia até 80% do calor sem escurecer muito. Uma opção mais
     econômica é o Fumê.
     
     Vamos ver o que você precisa!
```
**No user action needed** - bot continues automatically

---

### Step 4: Property Type
```
Bot: João, é para uma casa, apartamento ou estabelecimento comercial?
```
**User action:** Reply "apartamento", "casa", or "comercial"

---

### Step 5: Quantity
```
Bot: João, quantas janelas, portas ou superfícies você quer colocar película?
```
**User action:** Reply "3" or "3 janelas"

---

### Step 6: Measurements (Multiple)
```
Bot: João, qual a medida da janela 1? (de 3)
     (largura × altura, em cm ou metros)
```
**User action:** Reply "1.5 x 1.2 m" or "150x120"
**Repeats:** For each surface until all measurements received

---

### Step 7: Photos
```
Bot: João, pode me mandar uma foto do local onde vai colocar a película?
     Isso ajuda a dar um orçamento mais preciso! 📸
```
**User action:** Send photo, video, or image

---

### Step 8: Complete
```
Bot: Perfeito, recebi tudo! 😊
     O Alex vai analisar e te manda o orçamento em breve.
     Obrigado pela confiança na Películas Brasil! 🪟
```
**Alex receives:** Complete lead summary with all details

---

## Data Fields Collected

### Required Fields (Must have all to complete flow)
- ✅ **nome** - Client's name
- ✅ **bairro** - Neighborhood in João Pessoa
- ✅ **tipo_imovel** - casa, apartamento, or comercial
- ✅ **problema_principal** - calor, privacidade, claridade, or estetica
- ✅ **quantidade_janelas** - Number of surfaces
- ✅ **janelas** - Array with measurements for each
- ✅ **fotos_recebidas** - At least one photo received

### Optional Fields
- **pelicula_desejada** - Client's preferred film type
- **pelicula_indicada** - Bot's recommendation (auto-filled)

---

## Special Situations Handled

### 1. Automotive Films
```
User: "I want film on my car windshield"
Bot: "For car windows, you should find a car window specialist. 
     We work with residential and commercial films. Good luck! 🚗"
→ Flow ends
```

### 2. Price Inquiry
```
User: "How much does it cost?"
Bot: "Great question! 💰 Price depends on window size, film type, 
     and installation complexity. Send me measurements and photos 
     and I'll give you an exact quote! 📐📸"
→ Flow continues
```

### 3. Cancellation
```
User: "No thanks" / "Cancel" / "Not interested"
Bot: "No problem! 👋 If you change your mind, just message.
     We're happy to help! 😊"
→ Flow ends, lead not sent
```

### 4. Unknown Surface Type
```
User: "What about skylights?"
Bot: "Thanks for the info! If you have questions about the best 
     film for that surface, let me know! 😊"
→ Flow continues
```

---

## Admin Commands

### Reset Conversation
Send from client chat:
```
#bot reiniciar
```
**Effect:** Clears all collected data, starts fresh with boas-vindas

**When to use:** If client made mistakes or wants to restart

---

## How Data Extraction Works

### Layer 1: Regex (Local)
Fast pattern matching for obvious data:
- Neighborhood names (tambaú, manaira, etc.)
- Numbers (measurements: "1.5x1.2")
- Problem keywords (calor, privacidade, etc)
- Film types (fumê, espelhada, nano cerâmica)

### Layer 2: LLM (Groq AI)
Only called if regex didn't find data AND it's working hours:
- Interprets natural language
- Extracts missing fields
- Returns JSON of found data
- Slower but smarter

### Example Extraction Chain
```
User: "Oi, sou João e moro em Tambaú, preciso resolver o calor"

1. Regex finds:
   - nome: "João" (pattern: "sou João")
   - bairro: "tambaú" (matches neighborhood list)
   - problema: "calor" (keyword match)
   - pelicula_indicada: "nano cerâmica" (auto-mapped)

2. LLM not needed - all essential fields found!

3. Bot asks next step: "Quantas janelas você tem?"
```

---

## Troubleshooting

### Bot Not Responding
1. Check GROQ_API_KEY is set
2. Check working hours (7 AM - 9 PM São Paulo time)
3. Check rate limit (5 messages per 60 sec per user)
4. Check deduplication (message processed already?)

### Buttons Not Showing
1. First attempt: Interactive list (preferred)
2. If fails → fallback to button format
3. If fails → fallback to text options
Always works eventually!

### LLM Extraction Slow
- LLM is intentionally only used outside working hours
- Or when regex doesn't find data
- This is normal - you can see in console: "✅ LLM extraction:"

### Client Keeps Getting Asked Same Question
- Conversation might not have registered data
- Try: Send `#bot reiniciar` to reset
- Then have client re-enter info

---

## Performance & Limits

| Metric | Value | Notes |
|--------|-------|-------|
| **Deduplication TTL** | 60 sec (msg ID), 10 sec (content) | Prevents duplicate processing |
| **Rate Limit** | 5 msgs/60 sec per user | Prevents spam/abuse |
| **Conversation Timeout** | 30 minutes | Auto-resets if inactive |
| **LLM Calls** | Only working hours | Saves API costs |
| **Message Delay** | 2-5 sec random | Looks natural |
| **Max Conversations** | Unlimited | Depends on server memory |

---

## Testing Checklist

Before deploying to production:

- [ ] Bot receives and responds to messages
- [ ] Boas-vindas shows with Sim/Não buttons
- [ ] Clicking "Sim" shows 4 problem options
- [ ] Each problem shows correct recommendation
- [ ] Problem → Film mapping is accurate
- [ ] Property type question appears after recommendation
- [ ] Quantity question appears after property type
- [ ] Measurement questions repeat correctly
- [ ] Photos trigger completion check
- [ ] Alex receives lead summary when flow completes
- [ ] Lead summary contains all fields
- [ ] Working hours check works (off-hours message appears)
- [ ] Audio transcription works (if enabled)
- [ ] Image/video marking as "fotos_recebidas"
- [ ] `#bot reiniciar` resets conversation
- [ ] 30-minute timeout resets conversation
- [ ] Rate limiting prevents spam
- [ ] Deduplication prevents double-processing
- [ ] All film types and neighborhoods recognized

---

## File Structure

```
/sessions/jolly-ecstatic-archimedes/mnt/WHATS AUTO RESPONDER/
├── bot.js                      # Main bot (NEW v3.0)
├── server.js                   # State management
├── index.js                    # Startup
├── package.json
├── package-lock.json
│
├── auth_info_multidevice/      # WhatsApp auth cache (auto-generated)
│   ├── creds.json
│   ├── pre-keys.json
│   └── ...
│
├── qr.png                      # QR code (if needed)
│
└── 📚 Documentation (NEW in v3.0)
    ├── README_V3.0.md          # This file
    ├── CHANGES_SUMMARY.md      # What changed from v2
    ├── CONVERSATION_FLOW.md    # Visual flow + examples
    └── CODE_REFERENCE.md       # Function reference
```

---

## Support & Questions

For issues or questions about:
- **Películas Brasil workflow** → Contact Alex
- **WhatsApp Bot integration** → Check Baileys docs
- **Groq LLM** → Check Groq SDK docs
- **This implementation** → See CODE_REFERENCE.md

---

## Version History

### v3.0 (Current) - March 4, 2026
- ✨ NEW: Problem-based recommendation system
- ✨ NEW: Property type detection (casa/apto/comercial)
- ✨ NEW: Four problem options with auto-mapping
- ✨ NEW: `_sendProblemaComBotoes()` function
- ✨ NEW: Updated `buildOwnerSummary()` format
- ✨ NEW: Consultive conversation flow
- 🔧 REMOVED: Technical questions (fixacao, modelo_vidro, tipo_vidro)
- 🔧 CHANGED: Extraction logic for new fields
- 📚 NEW: Complete documentation suite

### v2.x - Previous
- Basic flow: name → technical questions → photos → lead
- No problem detection
- No recommendations

---

## License & Attribution
Built for Películas Brasil by Claude Code
System Prompt v3.0 - Consultive Approach
March 4, 2026
