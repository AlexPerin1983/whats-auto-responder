# Bot.js Update - Consultive Approach (System Prompt v3.0)

## Overview
Updated the WhatsApp chatbot for "Películas Brasil" to use a **consultive approach** instead of asking technical questions. The bot now:
1. Understands the client's PRIMARY PROBLEM (heat, privacy, light, aesthetics)
2. Recommends the right film type based on the problem
3. Collects data in a simpler, more natural flow

## Key Changes

### 1. New Templates Added
- `pedir_tipo_imovel` - Asks for property type (casa/apartamento/comercial)
- `pedir_problema` - Lists the 4 main problems
- `recomendacao_calor` - Recommends Nano Cerâmica for heat
- `recomendacao_privacidade` - Recommends Espelhada for privacy
- `recomendacao_claridade` - Recommends Fumê for excess light
- `recomendacao_estetica` - Recommends Espelhado/Fosco for aesthetics
- Updated `flow_complete` - More conversational tone

### 2. Templates Removed (No longer needed in tech-only mode)
- ❌ `pedir_fixacao` - Not asked upfront
- ❌ `pedir_modelo_vidro` - Not asked upfront
- ❌ `pedir_tipo_vidro` - Not asked upfront

(These can be collected later if needed via LLM during conversation)

### 3. New Information Fields
**Added to `informacoes_coletadas`:**
- `tipo_imovel` (string): "casa", "apartamento", or "comercial"
- `problema_principal` (string): "calor", "privacidade", "claridade", or "estetica"
- `pelicula_indicada` (string): Auto-populated based on problem detected

**Removed from required flow:**
- `fixacao`, `modelo_vidro`, `tipo_vidro` - These are no longer auto-asked

### 4. Consultive Flow Order (New Sequential Path)
1. **Boas-vindas** → Client confirms they want to install film
2. **Problem Selection** → Select from 4 options (heat/privacy/light/aesthetics) ← NEW STEP
3. **Recommendation** → Bot shows recommendation based on problem ← NEW
4. **Property Type** → Ask if casa/apto/comercial
5. **Quantity** → How many surfaces?
6. **Measurements** → Dimensions for each surface
7. **Photos** → Client sends photos
8. **Complete** → Flow finished, lead sent to Alex

### 5. Updated Extraction Logic (`_extractLocally`)
- New regex patterns for `tipo_imovel` detection
- New patterns for `problema_principal` detection
- Auto-maps problem to recommended film type:
  - calor → nano cerâmica
  - privacidade → espelhada
  - claridade → fumê
  - estetica → fosca

### 6. Updated LLM Extraction (`_extractWithLLM`)
Updated `faltando` array to request:
- `tipo_imovel`
- `problema_principal`

Removed from LLM requests:
- `fixacao`, `modelo_vidro`, `tipo_vidro`

### 7. New Problem Selection State Machine
Added two new conversation states:
- `_aguardando_problema` (boolean) - Waiting for problem selection
- `_problema_selecionado` (boolean) - Problem has been selected

#### Flow in `processFlow()`:
```
If user confirms "sim" at boas-vindas:
  → Show problem selection buttons
  → Map response to one of 4 problems
  → Auto-set pelicula_indicada
  → Send recommendation message
  → Continue with remaining questions
```

### 8. New Function: `_sendProblemaComBotoes()`
Sends problem selection with:
- **List format** (preferred): Interactive menu with 4 buttons
- **Fallback**: Interactive buttons if list fails
- **Final fallback**: Text with numbered options (1-4)

### 9. Updated `buildOwnerSummary()` Format
Changed to **🔔 NOVO LEAD** format showing:
```
👤 Cliente: [name]
📍 Bairro: [bairro]
🏠 Imóvel: [tipo_imovel uppercase]

🌡️ Problema: [problem label] ← NEW
🎬 Película indicada: [film type] ← NEW
```

### 10. Updated `isFlowComplete()`
New requirements (simplified - no technical fields):
- ✅ nome
- ✅ bairro
- ✅ tipo_imovel (NEW)
- ✅ problema_principal (NEW)
- ✅ quantidade_janelas
- ✅ janelas with medidas
- ✅ fotos_recebidas

### 11. Reset States Updated
Both in reiniciar command and 30-min timeout:
```js
informacoes_coletadas: {
  nome: null,
  bairro: null,
  tipo_imovel: null,           // ← NEW
  problema_principal: null,     // ← NEW
  pelicula_indicada: null,      // ← NEW
  quantidade_janelas: null,
  janelas: [],
  pelicula_desejada: null,
  fotos_recebidas: false
}
_aguardando_problema: false     // ← NEW
_problema_selecionado: false    // ← NEW
```

### 12. Unchanged Infrastructure (All Preserved)
✅ Groq integration & LLM calls
✅ Baileys WhatsApp socket
✅ Audio transcription (Whisper)
✅ Image/video/document handling
✅ Deduplication & rate limiting
✅ Working hours verification
✅ Owner takeover (#bot command)
✅ Timeout/reset logic
✅ Log system
✅ Message history tracking

## Benefits of This Approach

1. **Client-Centric**: Starts with what they care about (their problem), not technical specs
2. **Simpler Conversation**: Only 4 choice buttons instead of confusing technical questions
3. **Smart Recommendations**: Bot recommends the best film type automatically
4. **Better UX**: Natural progression from problem → solution → details
5. **More Conversions**: Clients feel understood, not interrogated

## Testing Checklist

- [ ] Bot sends boas-vindas with Sim/Não buttons
- [ ] Clicking "Sim" shows problem selection with 4 buttons
- [ ] Selecting problem shows recommendation message
- [ ] Recommendation matches the problem (calor→nano, etc)
- [ ] Flow continues to tipo_imovel question
- [ ] Alex receives NOVO LEAD with problem + recommendation
- [ ] All existing features (audio, images, etc) still work
- [ ] Timeout resets conversation properly
- [ ] #bot reiniciar command works

## File Location
`/sessions/jolly-ecstatic-archimedes/mnt/WHATS AUTO RESPONDER/bot.js`

## Version
**System Prompt v3.0 - Consultive Approach**
Owner: Alex
Company: Películas Brasil 🪟
Location: João Pessoa, Brazil
