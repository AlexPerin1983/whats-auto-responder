# Bot.js Code Reference - Key Functions

## File Location
`/sessions/jolly-ecstatic-archimedes/mnt/WHATS AUTO RESPONDER/bot.js`
**Total lines:** 1172
**Syntax:** ✅ Valid (passed Node.js syntax check)

## Key Functions by Purpose

### 1. Data Extraction Functions

#### `_extractLocally(texto, existingInfo)` - Lines 244-370
**Purpose:** Extract client data using regex patterns
**Key features:**
- Detects nome + bairro in natural language
- Recognizes João Pessoa neighborhoods
- Detects property type (casa/apto/comercial)
- Detects problem (calor/privacidade/claridade/estetica)
- Auto-maps problem to recommended film type
- Extracts quantity and measurements
- Extracts desired film type

**Returns:** `{ info, extraiu }` object with updated fields

**Example:**
```javascript
const { info } = _extractLocally("Oi, sou João e moro em Tambaú");
// info.nome = 'João'
// info.bairro = 'tambaú'
```

#### `_extractWithLLM(texto, existingInfo)` - Lines 372-433
**Purpose:** Use Groq AI to extract missing data
**Key features:**
- Called when regex doesn't find data
- Only works during working hours
- Requests: nome, bairro, tipo_imovel, problema_principal, quantidade_janelas
- Returns JSON parsed from LLM response
- Error handling built-in

**Returns:** `{ extracted, faltando }` where extracted contains found fields

#### `_applyLLMExtraction(extracted, info)` - Lines 435-463
**Purpose:** Merge LLM-extracted data with existing info
**Key features:**
- Only adds data if field is empty
- Auto-maps problem to recommended film
- Tracks if data changed

**Returns:** `{ info, changed }`

### 2. Flow Control Functions

#### `isFlowComplete(conv)` - Lines 465-482
**Purpose:** Check if all required data is collected
**Required fields:**
```javascript
✅ nome
✅ bairro
✅ tipo_imovel         // NEW in v3.0
✅ problema_principal  // NEW in v3.0
✅ quantidade_janelas
✅ janelas (with medidas)
✅ fotos_recebidas
```
**Returns:** Boolean

#### `_getNextStep(jid)` - Lines 484-515
**Purpose:** Determine what question to ask next
**Checks in order:**
1. Special situations (automotivo, surface, preço, cancelamento)
2. Missing name/neighborhood → ask for them
3. Missing property type → ask (NEW in v3.0)
4. Missing quantity → ask
5. Missing measurements → ask
6. Missing photos → ask
7. Flow complete → return 'completo'

**Returns:** `{ step, text, terminal? }`

### 3. Message Handling Functions

#### `processFlow(jid, userMessage, messageType)` - Lines 687-797
**Purpose:** State machine for conversation flow
**Key states:**
- Awaiting initial Sim/Não (boas-vindas)
- Awaiting problem selection (NEW in v3.0)
- Others via `_getNextStep()`

**State transitions:**
```
boas_vindas_sim 
  → _aguardando_problema = true
  → Show 4 problem buttons
  → User selects problem
  → _problema_selecionado = true
  → Show recommendation
  → Continue to next question
```

#### `processMessage(jid, userMessage, messageType)` - Lines 799-839
**Purpose:** Extract and process message data
**Does:**
1. Local regex extraction
2. Special situation detection (automotivo, preço, etc)
3. LLM extraction if needed (working hours only)
4. Updates conversation state

#### `_processMessage(jid, userMessage, messageType)` - Lines 883-967
**Purpose:** Main message processor (entry point)
**Does:**
1. Adds message to history
2. Checks working hours
3. Calls processFlow() for state machine
4. Calls processMessage() for extraction
5. Checks if flow is complete
6. Gets next step question
7. Sends response

### 4. Template Functions

#### `pickTemplate(key, vars)` - Lines 228-241
**Purpose:** Select random template and fill placeholders
**Available templates:**
```javascript
// New in v3.0
pedir_tipo_imovel
pedir_problema
recomendacao_calor
recomendacao_privacidade
recomendacao_claridade
recomendacao_estetica

// Existing
pedir_nome_bairro
pedir_quantidade
pedir_medidas_*
pedir_fotos
pedir_pelicula
resposta_automotivo
resposta_preco
resposta_cancelamento
flow_complete
erro_tecnico
```

**Usage:**
```javascript
pickTemplate('pedir_tipo_imovel', { nome: 'João' })
// Returns: "João, é para uma casa, apartamento ou comercial?"
```

### 5. Button/UI Functions

#### `_sendBoasVindasComBotoes(jid)` - Lines 552-595
**Purpose:** Send initial greeting with Sim/Não buttons
**Sends:**
```
Olá! 👋 Bem-vindo à Películas Brasil 🪟
Você está buscando colocar insulfilm? Deixa que eu ajudo! 😊
```
**With 3 fallback methods:**
1. Interactive list (preferred)
2. Interactive buttons
3. Text with manual input

#### `_sendProblemaComBotoes(jid)` - Lines 621-680 **NEW in v3.0**
**Purpose:** Send 4 problem option buttons
**Sends:**
```
Qual o principal problema que você quer resolver? 🎯
[🌡️ Calor] [👁️ Privacidade] [☀️ Claridade] [🎨 Estética]
```
**With 3 fallback methods** (same as boas-vindas)

### 6. Summary Function

#### `buildOwnerSummary(jid, conv)` - Lines 517-545
**Purpose:** Create formatted lead summary for Alex
**Format (NEW in v3.0):**
```
🔔 NOVO LEAD — Películas Brasil

👤 Cliente: [name]
📍 Bairro: [neighborhood]
🏠 Imóvel: [property type]
📞 WhatsApp: [number]

[problem emoji] Problema: [problem label]
🎬 Película indicada: [recommended film]
🪟 Qt. superfícies: [quantity]

[List of measurements]

📸 Fotos: [Yes/No/Pending]
⏱ Início: [date/time]
```

**Called when:** `isFlowComplete()` returns true

### 7. Utility Functions

#### `sendWithDelay(jid, msgObj)` - Lines 128-141
**Purpose:** Send message with typing indicator and random delay
**Does:**
1. Random delay (2-5 sec)
2. Show "composing" status
3. Send message
4. Log it

#### `isWithinWorkingHours()` - Lines 97-110
**Purpose:** Check if current time is within business hours
**Uses:** São Paulo timezone
**Default:** 07:00 - 21:00 (configurable)

#### `checkRateLimit(jid, limit, windowMs)` - Lines 112-126
**Purpose:** Prevent spam/abuse
**Default:** 5 messages per 60 seconds per user

#### `isDuplicate(msgId, jid, content)` - Lines 41-57
**Purpose:** Prevent processing same message twice
**TTL:** 60 seconds by ID, 10 seconds by content

## Data Structure

### Conversation Object
```javascript
{
  jid: 'XXXXXXXXXXXX@s.whatsapp.net',
  cliente: 'XXXXXXXXXXXX@s.whatsapp.net',
  data_inicio: '2026-03-04T14:30:00Z',
  mensagens: [
    { de: 'bot', tipo: 'texto', conteudo: '...', hora: '...' },
    { de: 'user', tipo: 'texto', conteudo: '...', hora: '...' }
  ],
  informacoes_coletadas: {
    nome: 'João',
    bairro: 'tambaú',
    tipo_imovel: 'apartamento',           // NEW
    problema_principal: 'calor',          // NEW
    pelicula_indicada: 'nano cerâmica',   // NEW
    quantidade_janelas: 3,
    janelas: [
      { numero: 1, medida: '1.5x1.2', tipo: 'janela', folhas: 2 }
    ],
    pelicula_desejada: null,
    fotos_recebidas: true
  },
  _aguardando_boas_vindas: false,
  _boas_vindas_confirmada: true,
  _aguardando_problema: false,            // NEW
  _problema_selecionado: true,            // NEW
  _fluxo_completado: false
}
```

## Problem → Film Mapping

In `_extractLocally()` and `_applyLLMExtraction()`:
```javascript
const mapa = {
  calor: 'nano cerâmica',
  privacidade: 'espelhada',
  claridade: 'fumê',
  estetica: 'fosca'
};
```

When `problema_principal` is detected:
```javascript
if (!info.pelicula_indicada) {
  info.pelicula_indicada = mapa[info.problema_principal];
}
```

## Region (João Pessoa Neighborhoods)

Detected in `_extractLocally()`:
```javascript
const bairros = [
  'tambaú', 'manaira', 'costa do sol', 'bessa', 'cabo branco',
  'altiplano', 'bancários', 'torre', 'aeroclube', 'glória',
  'mangabeira', 'ponta verde', 'ouro preto', 'rosa de segunda',
  'centro', 'varadouro', 'jaguaribe', 'joão paulo', 'penha',
  'geisel', 'ernesto pereira', 'cristo redentor', 'tibiriçá',
  'água fria', 'soft', 'castelo branco', 'distrito industrial',
  'jardim beleza', 'jamapará', 'parque amazônico'
];
```

## Owner Commands

Prefix: `#bot `

**Reiniciar** (Reset conversation):
```
#bot reiniciar
```
Effect: Handler at lines ~1040-1066

## Event Handlers

#### Socket Event: `messages.upsert`
- Line ~1089
- Triggered on new incoming message
- Handles: Text, Audio, Image, Video, Document
- Calls: `_processMessage()` for each

#### Socket Event: `connection.update`
- Line ~1069
- Handles QR code generation
- Reconnection on disconnect
- Status logging

## Environment Variables

Required:
- `GROQ_API_KEY` - For LLM calls
- (Can also be in `state.settings.groq_api_key`)

Optional (defaults):
- Working hours: 07:00 - 21:00 (São Paulo tz)
- Delay: 2000-5000ms between messages
- Rate limit: 5 messages/60 seconds per user
- Timeout: 30 minutes of inactivity

## Module Exports

```javascript
module.exports = { 
  startBot,  // Start the bot
  state,     // Global state object
  sock       // WhatsApp socket reference
};
```

## Files Generated

- `auth_info_multidevice/` - WhatsApp authentication cache
- `qr.png` - QR code (if needed for reconnection)

## Performance Notes

- Deduplication: 60-10 second TTL
- LLM calls: Only during working hours
- Timeouts: 30 minutes per conversation
- Rate limiting: 5 messages/60sec per user
- Message queue: Per-JID lock system
