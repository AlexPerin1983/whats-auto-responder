'use strict';

const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default;
const {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent  // necessário para botões interativos modernos
} = baileys;

const { Boom } = require('@hapi/boom');
const Groq = require('groq-sdk');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');

const {
  state,
  addToLog,
  updateConversation,
  incrementMessageCount,
  loadExemplosSucesso
} = require('./server');

// ─── GROQ CLIENT ──────────────────────────────────────────────────────────────
let groq;

// ─── LOGGER SILENCIOSO (evita poluir o terminal) ──────────────────────────────
const logger = pino({ level: 'silent' });

// ─── REFERÊNCIA DO SOCKET ────────────────────────────────────────────────────
let sock;

// ─── DEDUPLICAÇÃO: impede processar a mesma mensagem duas vezes ───────────────
const processedMsgIds = new Map();
const processedMsgContent = new Map();
const DEDUP_TTL_MS = 60000;
const DEDUP_CONTENT_TTL_MS = 10000;

function isDuplicate(msgId, jid, content) {
  const now = Date.now();
  for (const [id, ts] of processedMsgIds) {
    if (now - ts > DEDUP_TTL_MS) processedMsgIds.delete(id);
  }
  for (const [key, ts] of processedMsgContent) {
    if (now - ts > DEDUP_CONTENT_TTL_MS) processedMsgContent.delete(key);
  }
  if (processedMsgIds.has(msgId)) return true;
  const contentKey = `${jid}|${(content || '').substring(0, 80)}`;
  if (processedMsgContent.has(contentKey)) return true;
  processedMsgIds.set(msgId, now);
  if (content && content.trim().length > 0) {
    processedMsgContent.set(contentKey, now);
  }
  return false;
}

// ─── LOCK POR JID ────────────────────────────────────────────────────────────
const jidLocks = new Map();
async function withJidLock(jid, fn) {
  const prev = jidLocks.get(jid) || Promise.resolve();
  const next = prev.then(fn).catch(() => { });
  jidLocks.set(jid, next);
  await next;
  if (jidLocks.get(jid) === next) jidLocks.delete(jid);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function getMessageType(msg) {
  if (!msg.message) return 'unknown';
  const types = Object.keys(msg.message);
  const relevant = types.filter(t => !['messageContextInfo', 'senderKeyDistributionMessage'].includes(t));
  return relevant[0] || 'unknown';
}

function getMessageText(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  );
}

// ─── VERIFICAÇÃO DE HORÁRIO ───────────────────────────────────────────────────
function isWithinWorkingHours() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hour = now.getHours();
  const minute = now.getMinutes();
  const currentTime = hour * 60 + minute;
  const [startH, startM] = (state.settings.horario_inicio || '07:00').split(':').map(Number);
  const [endH, endM] = (state.settings.horario_fim || '21:00').split(':').map(Number);
  const startTime = startH * 60 + startM;
  const endTime = (endH === 0 && endM === 0) ? 1440 : endH * 60 + endM; // 00:00 = meia-noite = fim do dia
  return currentTime >= startTime && currentTime < endTime;
}

// ─── RATE LIMITER ────────────────────────────────────────────────────────────
const rateLimiter = new Map();
function checkRateLimit(jid, limit = 5, windowMs = 60000) {
  const now = Date.now();
  const key = jid;
  if (!rateLimiter.has(key)) {
    rateLimiter.set(key, []);
  }
  const times = rateLimiter.get(key);
  const filtered = times.filter(t => now - t < windowMs);
  if (filtered.length >= limit) {
    return false;
  }
  filtered.push(now);
  rateLimiter.set(key, filtered);
  return true;
}

// ─── HELPER: Enviar com delay ────────────────────────────────────────────────
async function sendWithDelay(jid, msgObj) {
  const min = state.settings.delay_min || 2000;
  const max = state.settings.delay_max || 5000;
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
  await sock.sendPresenceUpdate('composing', jid);
  await new Promise(resolve => setTimeout(resolve, 800));
  await sock.sendPresenceUpdate('paused', jid);
  await sock.sendMessage(jid, msgObj);
  incrementMessageCount();
  addToLog({ type: 'outgoing', jid, text: msgObj.text || '[media]', cliente: state.conversations[jid]?.cliente, from: 'bot' });
}

// ═════════════════════════════════════════════════════════════════════════════════
//  ARQUITETURA
// ═════════════════════════════════════════════════════════════════════════════════
//
// 1. TEMPLATES: Respostas pré-definidas com placeholders ({nome}, {bairro}, etc.)
//
// 2. _extractLocally: Extrai dados com regex (nome, bairro, problema, tipo_imovel)
//
// 3. _extractWithLLM: Para campos não extraídos, chama Groq para interpretação
//
// 4. _applyLLMExtraction: Aplica resultados da LLM ao info
//
// 5. isFlowComplete: Verifica se todos os campos necessários foram coletados
//
// 6. _getNextStep: Retorna qual pergunta fazer agora (baseado no flow consultivo)
//
// 7. buildOwnerSummary: Cria o resumo formatado para o Alex
//
// 8. processFlow: Estado-máquina: boas-vindas → problema → dados → fotos → conclusão
//
// 9. processMessage: Processa texto e LLM, aplica lógica de estado
//
// ═════════════════════════════════════════════════════════════════════════════════

const TEMPLATES = {
  pedir_nome_bairro: [
    'Para que eu te ajude melhor, qual é o seu *nome* e em qual *bairro* de João Pessoa você mora? 📍',
    'Qual é o seu *nome* e em qual *bairro* você está? 😊',
    'Me passa seu *nome* e *bairro* para eu registrar o atendimento? 📋',
  ],
  pedir_tipo_imovel: [
    '{nome}, é para uma *casa*, *apartamento* ou *estabelecimento comercial*?',
    '{nome}, o imóvel é *residencial* (casa ou apartamento) ou *comercial*?',
  ],
  pedir_quantidade: [
    '{nome}, quantas *janelas, portas ou superfícies* você quer colocar película?',
    '{nome}, quantas *superfícies* vão receber a película? (janelas, portas, vidraças, etc.)',
  ],
  pedir_medidas_unica: [
    '{nome}, você sabe a *medida* da superfície? (largura × altura, ex: 1,20 × 1,50m)\n\nSe não souber, tudo bem — o Alex mede na visita! 😊',
    '{nome}, tem a *medida* dessa janela? (ex: 1,20 × 1,50m) — se não tiver, pode seguir! 😊',
  ],
  pedir_medidas_varias: [
    '{nome}, você sabe as *medidas* das {total} superfícies? (ex: 1,20 × 1,50m)\n\nSe não souber, sem problema — o Alex mede quando for lá! 😊',
    '{nome}, tem as medidas? Se tiver, manda aqui. Se não, pode ignorar — o Alex mede na visita! 😊',
  ],
  pedir_medida_faltante: [
    '{nome}, e a medida da *{tipo}*? Se não souber, tudo bem! 😊',
  ],
  pedir_fotos: [
    '{nome}, pode me mandar uma *foto* do local onde vai colocar a película? Isso ajuda a dar um orçamento mais preciso! 📸',
  ],
  pedir_pelicula: [
    '{nome}, qual tipo de película você prefere? (*fumê*, *espelhada*, *nano cerâmica*, *fosca*, ou *não sabe*?)',
  ],
  pedir_problema: [
    '{nome}, qual o principal motivo para colocar insulfilm? Isso me ajuda a indicar a película certa!\n\n• *Calor* — o sol esquenta demais o ambiente\n• *Privacidade* — pessoas de fora conseguem ver o interior\n• *Claridade* — muito sol ou ofuscamento\n• *Estética* — modernizar ou decorar',
  ],
  recomendacao_calor: [
    '{nome}, para *reduzir o calor* a melhor opção é a *Nano Cerâmica* 🌡️ — bloqueia até 80% do calor sem escurecer muito. Uma opção mais econômica é o *Fumê*.\n\nVamos ver o que você precisa!',
  ],
  recomendacao_privacidade: [
    '{nome}, para *privacidade* recomendo o *Espelhado* 🪞 — de dia fica como espelho por fora, ninguém vê o interior. Se preferir privacidade total, temos o *Fosco*.\n\nVamos ver o que você precisa!',
  ],
  recomendacao_claridade: [
    '{nome}, para *reduzir claridade e ofuscamento* recomendo o *Fumê G20 ou G35* ☀️ — reduz a luminosidade sem escurecer demais.\n\nVamos ver o que você precisa!',
  ],
  recomendacao_estetica: [
    '{nome}, para dar um visual moderno recomendo o *Espelhado* ou *Fosco* 🎨 — elegante e funcional ao mesmo tempo.\n\nVamos ver o que você precisa!',
  ],
  resposta_automotivo: [
    '{nome}, para insulfilm automotivo é melhor você procurar um especialista em vidros de carro. A gente trabalha com películas para janelas residenciais e comerciais. Boa sorte! 🚗',
  ],
  resposta_superficie: [
    '{nome}, obrigado pela informação! Se você tiver dúvidas sobre qual película é melhor para essa superfície, me avisa que a gente conversa! 😊',
  ],
  resposta_preco: [
    'Ótimo pergunta! 💰 O preço depende do tamanho das janelas, tipo de película e complexidade da instalação.\n\nMe passa as medidas e fotos que eu faço um orçamento certinho pra você! 📐📸',
  ],
  resposta_cancelamento: [
    'Tudo bem, {nome}! 👋 Se mudar de ideia, é só me mandar uma mensagem. A gente fica feliz em ajudar! 😊',
  ],
  confirmacao_dados: [
    'Anotei tudo, {nome}! 📋 Já tenho as informações que preciso para o orçamento.',
    'Ótimo, {nome}! 👍 Com esses dados consigo te passar um orçamento certinho.',
    'Perfeito, {nome}! 😊 Já tenho o que preciso para preparar o orçamento.',
  ],
  flow_complete: [
    'Perfeito, recebi tudo! 😊\n\nO Alex vai analisar e te manda o orçamento em breve. Obrigado pela confiança na Películas Brasil! 🪟',
    'Ótimo, tenho todas as informações! 😊\n\nEm breve o Alex te contata com o orçamento. Muito obrigado! 🪟',
  ],
  erro_tecnico: [
    'Desculpa, houve um erro técnico aqui. 😞 Pode tentar de novo ou me chamar no WhatsApp que o Alex te ajuda!',
  ],
};

function pickTemplate(key, vars = {}) {
  if (!TEMPLATES[key]) {
    console.warn(`⚠️ Template não encontrado: ${key}`);
    return 'Desculpa, houve um erro. Pode tentar de novo?';
  }
  const templates = TEMPLATES[key];
  const chosen = templates[Math.floor(Math.random() * templates.length)];
  let result = chosen;
  for (const [k, v] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return result;
}

// ─── EXTRAÇÃO LOCAL (REGEX) ──────────────────────────────────────────────────
function _extractLocally(texto, existingInfo = {}, ultimoStep = '') {
  const info = { ...existingInfo };
  const textoLower = (texto || '').toLowerCase().trim();
  let extraiu = false;

  // Palavras que NÃO são nomes de pessoas
  const NAO_NOMES = new Set([
    'oi', 'olá', 'ola', 'bom', 'boa', 'hey', 'eae', 'oie', 'sim', 'não', 'nao',
    'quero', 'preciso', 'tenho', 'uma', 'duas', 'minha', 'meu', 'para', 'janela',
    'porta', 'insulfilm', 'pelicula', 'película', 'quanto', 'qual', 'obrigado',
    'obrigada', 'gostaria', 'orçamento', 'orcamento', 'colocar', 'instalar',
    'calor', 'claridade', 'privacidade', 'estética', 'estetica', 'casa', 'apartamento',
    'dois', 'tres', 'quatro', 'cinco', 'bairro', 'moro', 'fico', 'estou', 'sou',
    'são', 'tenho', 'desde', 'urgente', 'pode', 'claro', 'ok', 'tudo',
    'de', 'da', 'do', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas',
    'por', 'com', 'um', 'uns', 'umas', 'ao', 'aos', 'se', 'me'
  ]);

  // ── Nome ──────────────────────────────────────────────────────────────────
  if (!info.nome) {
    // Padrão 1: "meu nome é X", "me chamo X", "sou X", "é X"
    const p1 = texto.match(/(?:meu nome[é\s]+|me chamo\s+|sou (?:a |o )?|nome[:\s]+)([A-Za-zÀ-ú]{2,})/i);
    if (p1 && !NAO_NOMES.has(p1[1].toLowerCase())) {
      info.nome = p1[1].trim();
      extraiu = true;
      console.log(`🔍 Nome p1 (local): ${info.nome}`);
    }

    // Padrão 2: "Ana do bairro do Bessa" / "Carlos de Manaíra" / "Ana, Bancários"
    if (!info.nome) {
      const p2 = texto.match(/^([A-ZÀ-Ú][a-zà-ú]+(?:\s+[A-ZÀ-Ú][a-zà-ú]+)?)\s*(?:,|\s+(?:do|da|de|no|na|em|bairro)\s)/i);
      if (p2 && !NAO_NOMES.has(p2[1].toLowerCase().trim())) {
        info.nome = p2[1].trim().split(' ')[0]; // só primeiro nome
        extraiu = true;
        console.log(`🔍 Nome p2 (local): ${info.nome}`);
      }
    }

    // Padrão 3: mensagem curta com só um nome capitulado ("Ana", "Carlos")
    if (!info.nome) {
      const p3 = texto.trim().match(/^([A-ZÀ-Ú][a-zà-ú]{1,15})$/);
      if (p3 && !NAO_NOMES.has(p3[1].toLowerCase())) {
        info.nome = p3[1];
        extraiu = true;
        console.log(`🔍 Nome p3 (local): ${info.nome}`);
      }
    }

    // Padrão 4: "minha amiga Ana" / "pode chamar de Ana"
    if (!info.nome) {
      const p4 = texto.match(/(?:pode chamar de|chama[- ]me de|me chama[r]?\s+de|é\s+)([A-Za-zÀ-ú]{2,15})/i);
      if (p4 && !NAO_NOMES.has(p4[1].toLowerCase())) {
        info.nome = p4[1];
        extraiu = true;
        console.log(`🔍 Nome p4 (local): ${info.nome}`);
      }
    }
  }

  // ── Bairro ─────────────────────────────────────────────────────────────────
  const BAIRROS_JP = [
    'tambaú', 'tambau', 'manaíra', 'manaira', 'bessa', 'cabo branco', 'altiplano',
    'bancários', 'bancarios', 'torre', 'aeroclube', 'glória', 'gloria',
    'mangabeira', 'tambauzinho', 'ponta verde', 'expedicionários', 'expedicionarios',
    'centro', 'varadouro', 'jaguaribe', 'joão paulo', 'joao paulo', 'penha',
    'geisel', 'ernesto geisel', 'cristo redentor', 'tibiriçá', 'tibiriça',
    'água fria', 'agua fria', 'castelo branco', 'distrito industrial',
    'jardim oceania', 'portal do sol', 'valentina', 'intermares',
    'costa e silva', 'josé américo', 'jose americo', 'roger', 'mandacaru',
    'estados', 'miramar', 'brisamar', 'muçumagro', 'mucumagro',
    'jardim luna', 'anatólia', 'anatolia', 'cuiá', 'cuia',
    'cidade universitária', 'cidade universitaria', 'ilha do bispo',
    'funcionários', 'funcionarios', 'paratibe', 'gramame', 'mumbaba',
    'ouro preto', 'jardim são paulo', 'jardim sao paulo', 'rangel',
    'são josé', 'sao jose', 'padre zé', 'padre ze', 'grotão', 'grotao',
    'alto do mateus', 'ernani sátiro', 'ernani satiro', 'varjão', 'varjao',
    'cabedelo', 'santa rita', 'bayeux', 'conde', 'lucena', 'pitimbu'
  ];

  if (!info.bairro) {
    // Padrao por texto: "moro no/em X", "bairro X", "fico em X"
    // NOTA: removido "sou de/do/da" pois eh ambiguo (pode se referir a cidade, nao a bairro)
    const bairroMatch = texto.match(
      /(?:moro\s+(?:no|na|em)\s+|bairro[:\s]+|fico\s+(?:no|na|em)\s+|sou\s+do\s+bairro\s+)([A-Za-z\u00c0-\u00fa][A-Za-z\u00c0-\u00fa\s]{1,25}?)(?:\s|$|,|\.)/i
    );

    for (const b of BAIRROS_JP) {
      if (new RegExp(`\\b${b}\\b`, 'i').test(textoLower)) {
        info.bairro = b.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        extraiu = true;
        console.log(`\ud83d\udd0d Bairro lista (local): ${info.bairro}`);
        break;
      }
    }

    if (!info.bairro && bairroMatch) {
      const bairroCapturado = bairroMatch[1].trim();
      if (!/^jo[a\u00e3]o\s*pessoa$/i.test(bairroCapturado)) {
        info.bairro = bairroCapturado;
        extraiu = true;
        console.log(`\ud83d\udd0d Bairro regex (local): ${info.bairro}`);
      }
    }
  }

  // ── Tipo de imóvel ───────────────────────────────────────────────────────
  if (!info.tipo_imovel) {
    if (/\bapartamento\b|\bapto\b/.test(textoLower)) {
      info.tipo_imovel = 'apartamento'; extraiu = true;
      console.log('🔍 Tipo imóvel (local): apartamento');
    } else if (/\bcomercio\b|\bcomércio\b|\bloja\b|\bescritório\b|\bescritorio\b|\bempr[eê]sa\b|\bcomercial\b/.test(textoLower)) {
      info.tipo_imovel = 'comercial'; extraiu = true;
      console.log('🔍 Tipo imóvel (local): comercial');
    } else if (/\bcasa\b|\bresidência\b|\bresidencia\b|\bresidencial\b/.test(textoLower)) {
      info.tipo_imovel = 'casa'; extraiu = true;
      console.log('🔍 Tipo imóvel (local): casa');
    }
  }

  // ── Problema principal ──────────────────────────────────────────────────
  if (!info.problema_principal) {
    // From button IDs
    if (textoLower === 'prob_calor') { info.problema_principal = 'calor'; extraiu = true; }
    else if (textoLower === 'prob_privacidade') { info.problema_principal = 'privacidade'; extraiu = true; }
    else if (textoLower === 'prob_claridade') { info.problema_principal = 'claridade'; extraiu = true; }
    else if (textoLower === 'prob_estetica') { info.problema_principal = 'estetica'; extraiu = true; }
    // From text
    else if (/calor|quent[eo]|t[eé]rmico|esquenta/.test(textoLower)) { info.problema_principal = 'calor'; extraiu = true; }
    else if (
      /privacidade|privado|ver[aà] dentro|veem|olhando|bisbilhot|n[aã]o v[eê]|devassa/.test(textoLower) ||
      /ningu[eé]m\s*(?:me\s*)?v(?:eja|er|ê)|não\s+me\s+veja|quem\s+t[aá]\s+fora/.test(textoLower) ||
      /fora\s+n[aã]o\s+(?:me\s+)?v|espelhad|ver\s+l[aá]\s+fora.*n[aã]o\s+me\s+v|n[aã]o\s+me\s+v.*ver\s+l[aá]\s+fora/.test(textoLower)
    ) { info.problema_principal = 'privacidade'; extraiu = true; }
    else if (/clarid|claridade|sol demais|muito sol|ofuscam|deslumbr|luminosidade/.test(textoLower)) { info.problema_principal = 'claridade'; extraiu = true; }
    else if (/est[eé]tica|bonit[ao]|moderno|decorar|visual|aparência|aparencia/.test(textoLower)) { info.problema_principal = 'estetica'; extraiu = true; }
    if (info.problema_principal) {
      // Auto-set pelicula_indicada based on problem
      const mapa = { calor: 'nano cerâmica', privacidade: 'espelhada', claridade: 'fumê', estetica: 'fosca' };
      if (!info.pelicula_indicada) { info.pelicula_indicada = mapa[info.problema_principal]; }
      console.log(`🔍 Problema (local): ${info.problema_principal} → película: ${info.pelicula_indicada}`);
    }
  }

  // ── Quantidade de janelas ──────────────────────────────────────────────
  if (!info.quantidade_janelas) {
    const qtyMatch = /(\d+)\s*(?:janela|porta|superfície|superficie|vidro|vidros|pano)/i.exec(texto);
    if (qtyMatch) {
      info.quantidade_janelas = parseInt(qtyMatch[1], 10);
      extraiu = true;
      console.log(`🔍 Quantidade (local): ${info.quantidade_janelas}`);
    }
  }

  // ── Medidas ────────────────────────────────────────────────────────────
  if (!Array.isArray(info.janelas)) info.janelas = [];

  // Detectar quando cliente não tem medidas → preencher como "a confirmar" e NÃO pedir de novo
  // Inclui 'medida_janela' para continuar entendendo respostas durante coleta janela-a-janela
  const pedindoMedidasCtx = ultimoStep === 'medidas' || ultimoStep === 'medida_faltante' || ultimoStep === 'medida_janela';
  // Respostas negativas simples — aceitas SOMENTE quando o bot já havia perguntado as medidas
  const naoSeiSimples = /^(eu\s+)?n[aã]o\s+(sei|tenho)\.?$|^n[aã]o\.?$|^não\.?$|^nao\.?$|^n[aã]o\s+sei\s+a\s+medida\.?$/i.test(texto.trim());
  // Respostas negativas explícitas (com a palavra "medida") — válidas em qualquer contexto
  // GUARD: se o cliente disser "vou tirar as medidas", ele TEM as medidas — não marcar como sem medidas
  const temIntencaoMedir = /vou\s+(?:tirar|pegar|medir|buscar)\s+(?:as?\s+)?medidas?|vou\s+medir/i.test(texto);
  const naoTemMedidaExplicita = !temIntencaoMedir && (
    /n[aã]o\s+(?:sei|tenho|lembro|possuo|consigo)\s+(?:as?\s+)?medidas?/i.test(texto) ||
    /sem\s+medidas?/i.test(textoLower) ||
    /medidas?\s+n[aã]o\s+(?:sei|tenho)/i.test(textoLower) ||
    /n[aã]o\s+tenho\s+as[.\s]+medidas?/i.test(texto) ||
    /j[aá]\s+disse\s+que\s+n[aã]o\s+(?:sei|tenho)\s+(?:as?\s+)?medidas?/i.test(textoLower)
  );
  const naoTemMedida = naoTemMedidaExplicita || (pedindoMedidasCtx && naoSeiSimples);

  if (naoTemMedida && info.quantidade_janelas && info.janelas.length < info.quantidade_janelas) {
    const qtd = info.quantidade_janelas;
    while (info.janelas.length < qtd) {
      info.janelas.push({ medida: 'a confirmar', numero: info.janelas.length + 1, folhas: '?' });
    }
    // Marcar que medidas já foram tratadas para não perguntar de novo
    info._medidas_dispensadas = true;
    extraiu = true;
    console.log(`🔍 Medidas: cliente não tem → ${qtd} janela(s) como "a confirmar" (_medidas_dispensadas=true)`);
  } else {
    // Normaliza texto antes de aplicar regex:
    // - "1.por" -> "1 por" (ponto acidental antes de "por")
    // - palavras numericas: "um"->"1", "dois"->"2", "tres"->"3"
    const textoNorm = texto
      .replace(/(\d+)\s*\.\s*(por|x)/gi, '$1 $2')
      .replace(/\bum\b/gi, '1').replace(/\bdois\b/gi, '2').replace(/\btr[e\u00ea]s\b/gi, '3');

    // Aceita: 1x1, 1.5x2, 1,2x0,8, "1 por 1", "1.5 por 2"
    const medidaMatches = textoNorm.match(
      /(\d+[.,]\d+|\d+)\s*(?:[xX\u00d7]|\s+por\s+)\s*(\d+[.,]\d+|\d+)\s*(cm|m|metros?|metro|cent\u00edmetros?)?/gi
    );
    if (medidaMatches && medidaMatches.length > 0) {
      for (const m of medidaMatches) {
        const normalized = m
          .replace(/\s+por\s+/gi, 'x').replace(/,/g, '.')
          .replace(/\s*(cm|m|metros?|metro|cent\u00edmetros?)$/gi, '').trim();
        if (!info.janelas.find(j => j.medida === normalized)) {
          info.janelas.push({ medida: normalized, numero: info.janelas.length + 1 });
          extraiu = true;
          if (info._confirmou_ter_medidas) delete info._confirmou_ter_medidas;
          console.log(`\ud83d\udd0d Medida (local): ${normalized}`);
        }
      }
    }

    // Detectar "cada uma / as duas / iguais" -> replicar ultima medida para janelas restantes
    const indicaIguais = /cada\s+uma|cada\s+janela|as\s+(?:duas|tr[e\u00ea]s|quatro|cinco)|iguais?|mesma\s+medida|mesmas\s+medidas/i.test(texto);
    if (indicaIguais && info.janelas.length > 0 && info.quantidade_janelas > info.janelas.length) {
      const ultimaMedida = info.janelas[info.janelas.length - 1].medida;
      if (ultimaMedida && /\d/.test(ultimaMedida)) {
        while (info.janelas.length < info.quantidade_janelas) {
          info.janelas.push({ medida: ultimaMedida, numero: info.janelas.length + 1 });
        }
        extraiu = true;
        if (info._confirmou_ter_medidas) delete info._confirmou_ter_medidas;
        console.log(`\ud83d\udd0d Medidas: "cada uma" -> replicado ${ultimaMedida} para todas as janelas`);
      }
    }
  }

  // ── Detectar resposta AFIRMATIVA quando bot perguntou medidas ("tenho sim", "sim", etc.) ────
  // Nesse caso o cliente confirmou que TEM as medidas mas ainda não forneceu os números
  if (pedindoMedidasCtx && !naoTemMedida && !info._confirmou_ter_medidas && !info._medidas_dispensadas) {
    const temNumeros = /(\d+[.,]\d+|\d+)\s*(?:[xX×]|\s+por\s+)/.test(texto);
    if (!temNumeros) {
      const respostaAfirmativa = /^(?:temos?(?:\s+sim)?\.?|tenho(?:\s+sim)?\.?|sim(?:\s+(?:tenho|temos))?\.?|claro\.?|ok\.?|tenho\s+as\s+medidas?\.?|temos\s+as\s+medidas?\.?|sim\s+tenho\s+as\s+medidas?\.?)$/i.test(texto.trim());
      if (respostaAfirmativa && !info.janelas.some(j => j.medida && /\d/.test(j.medida))) {
        info._confirmou_ter_medidas = true;
        extraiu = true;
        console.log('🔍 Cliente confirmou ter medidas → aguardando valores janela por janela');
      }
    }
  }

  // ── Película desejada ──────────────────────────────────────────────────
  if (!info.pelicula_desejada) {
    if (/\bfum[eê]\b/.test(textoLower)) {
      info.pelicula_desejada = 'fumê'; extraiu = true;
      console.log('🔍 Película (local): fumê');
    } else if (/\bespelhad[ao]\b|\bespecular\b/.test(textoLower)) {
      info.pelicula_desejada = 'espelhada'; extraiu = true;
      console.log('🔍 Película (local): espelhada');
    } else if (/\bnano\s*cerâmica\b|\bnano\s*ceramica\b|\bceramica\b|\bcerâmica\b/.test(textoLower)) {
      info.pelicula_desejada = 'nano cerâmica'; extraiu = true;
      console.log('🔍 Película (local): nano cerâmica');
    } else if (/\bfosca?\b/.test(textoLower)) {
      info.pelicula_desejada = 'fosca'; extraiu = true;
      console.log('🔍 Película (local): fosca');
    } else if (/\bsegurança\b/.test(textoLower)) {
      info.pelicula_desejada = 'segurança'; extraiu = true;
      console.log('🔍 Película (local): segurança');
    } else if (/\bn[aã]o\s+sei\b|\bnão\s+faço\s+ideia\b/.test(textoLower) &&
      !/medid[ao]|tamanho|dimens[aã]o|altura|largura|metros?|cm\b/i.test(textoLower) &&
      !pedindoMedidasCtx) {
      // Só marca "não sei" película se: sem palavras de medida E não estava perguntando medidas
      info.pelicula_desejada = 'não sei'; extraiu = true;
      console.log('🔍 Película (local): não sei');
    }
  }

  // ── Fotos ──────────────────────────────────────────────────────────────────
  // (recebida: marcado em handleImage/Video)
  // Cliente disse que NAO tem foto ou nao vai tirar: marcar como 'sem_foto' para parar de perguntar
  if (!info.fotos_recebidas) {
    const naoTemFoto =
      /n[aã]o\s+(?:tenho|vou\s+(?:tirar|mandar|enviar))\s+(?:a\s+)?foto/i.test(texto) ||
      /sem\s+foto/i.test(textoLower) ||
      /foto\s+n[aã]o\s+(?:tenho|vou)|n[aã]o\s+(?:tenho|terei)\s+foto/i.test(textoLower) ||
      /j[aá]\s+disse\s+que\s+n[aã]o\s+(?:tenho|vou).{0,15}foto/i.test(textoLower);
    if (naoTemFoto) {
      info.fotos_recebidas = 'sem_foto';
      extraiu = true;
      console.log('🔍 Fotos: cliente disse que não tem foto → fotos_recebidas = "sem_foto"');
    }
  }

  return { info, extraiu };
}

// ─── EXTRAÇÃO COM LLM ──────────────────────────────────────────────────────
async function _extractWithLLM(texto, existingInfo = {}) {
  if (!groq) return { extracted: {}, faltando: [] };

  const faltando = [];
  if (!existingInfo.nome) faltando.push('nome');
  if (!existingInfo.bairro) faltando.push('bairro');
  if (!existingInfo.tipo_imovel) faltando.push('tipo_imovel(casa/apartamento/comercial)');
  if (!existingInfo.problema_principal) faltando.push('problema_principal(calor/privacidade/claridade/estetica)');
  if (!existingInfo.quantidade_janelas) faltando.push('quantidade_janelas(número)');
  if (!existingInfo.pelicula_desejada) faltando.push('pelicula_desejada');

  if (faltando.length === 0) return { extracted: {}, faltando: [] };

  const systemPrompt = `Você é um extrator de dados estruturados para uma empresa de insulfilm chamada "Películas Brasil" em João Pessoa, PB.

Sua ÚNICA função é analisar a mensagem do cliente e retornar um JSON com os campos encontrados.

REGRAS RÍGIDAS:
- Retorne SOMENTE JSON válido, sem texto, sem explicação, sem markdown
- NÃO invente dados que não estejam claramente na mensagem
- NÃO preencha campos que não foram mencionados pelo cliente
- NÃO use informações de mensagens anteriores, apenas o texto atual
- Se um campo não está na mensagem, simplesmente não inclua no JSON
- nome: apenas se o cliente disse o nome dele explícita e claramente
- bairro: apenas bairros reais de João Pessoa/PB (ex: Tambaú, Manaíra, Bessa, Torre, Aeroclube, Bancários, etc.). ATENÇÃO: "João Pessoa" é o nome da CIDADE, não é um bairro. Nunca use "joão pessoa" ou "joao pessoa" como bairro. Só inclua bairro se o cliente citou explicitamente um bairro.
- tipo_imovel: APENAS uma das 3 opções exatas: "casa", "apartamento" ou "comercial"
- problema_principal: APENAS uma das 4 opções exatas:
  * "calor" → cliente reclama de calor/sol esquentar demais
  * "privacidade" → cliente quer que pessoas de fora não vejam o interior. Ex: "quem tá fora não me veja", "não quero que vejam dentro", "película espelhada"
  * "claridade" → cliente reclama de excesso de luz/claridade/ofuscamento
  * "estetica" → cliente quer modernizar/decorar
- quantidade_janelas: apenas se o cliente citou um número de janelas/portas/superfícies (número inteiro)
- pelicula_desejada: APENAS uma das opções: "fumê", "espelhada", "nano cerâmica", "fosca", "segurança" ou "não sei"

Mensagem do cliente para analisar:
"${texto}"

Dados já conhecidos (NÃO repita estes no JSON, apenas extraia os NOVOS campos faltando):
${JSON.stringify(existingInfo, null, 2)}

Campos que ainda faltam e devem ser extraídos SE presentes na mensagem:
${faltando.join(', ')}

JSON (apenas os campos novos encontrados na mensagem):`;

  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: systemPrompt
      }]
    });

    const respText = response.choices[0]?.message?.content || '{}';
    const jsonMatch = respText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { extracted: {}, faltando };

    const extracted = JSON.parse(jsonMatch[0]);
    console.log('✅ LLM extraction:', JSON.stringify(extracted, null, 2));
    return { extracted, faltando };
  } catch (err) {
    console.warn('⚠️ LLM extraction error:', err.message?.substring(0, 100));
    return { extracted: {}, faltando };
  }
}

// ─── APLICAR EXTRAÇÃO DA LLM ────────────────────────────────────────────────
function _applyLLMExtraction(extracted, info) {
  let changed = false;

  if (extracted.nome && !info.nome) { info.nome = extracted.nome; changed = true; }
  if (extracted.bairro && !info.bairro) {
    // Bloquear alucinacao da LLM: 'joao pessoa'/'jp' é a cidade, não um bairro
    const bairroNormalizado = (extracted.bairro || '').toLowerCase().trim();
    const ehCidade = /^jo[aã]o\s*pessoa$|^\bj\.?p\.?$/.test(bairroNormalizado);
    if (!ehCidade && bairroNormalizado.length > 1) {
      info.bairro = extracted.bairro; changed = true;
    } else {
      console.warn(`⚠️ LLM retornou bairro inválido (nome da cidade): "${extracted.bairro}" — ignorado.`);
    }
  }
  if (extracted.tipo_imovel && !info.tipo_imovel) { info.tipo_imovel = extracted.tipo_imovel; changed = true; }
  if (extracted.problema_principal && !info.problema_principal) {
    info.problema_principal = extracted.problema_principal; changed = true;
    const mapa = { calor: 'nano cerâmica', privacidade: 'espelhada', claridade: 'fumê', estetica: 'fosca' };
    if (!info.pelicula_indicada && mapa[extracted.problema_principal]) {
      info.pelicula_indicada = mapa[extracted.problema_principal];
    }
  }
  if (extracted.quantidade_janelas && !info.quantidade_janelas) { info.quantidade_janelas = extracted.quantidade_janelas; changed = true; }
  if (extracted.pelicula_desejada && !info.pelicula_desejada) { info.pelicula_desejada = extracted.pelicula_desejada; changed = true; }

  return { info, changed };
}

// ─── GERAR RESPOSTA COM LLM-70b ──────────────────────────────────────────────
async function _generateResponseWithLLM(jid, userMessage, nextStep, nextText) {
  if (!groq || !nextText) return nextText;

  const conv = state.conversations[jid];
  const info = conv?.informacoes_coletadas || {};
  const janelasSummary = (info.janelas || [])
    .filter(j => j.medida && /\d/.test(j.medida))
    .map(j => `Superfície ${j.numero}: ${j.medida}`).join(', ');

  const problemaLabel = { calor: 'Calor', privacidade: 'Privacidade', claridade: 'Claridade', estetica: 'Estética' };

  const systemPrompt = `Você é o assistente de WhatsApp da Películas Brasil, em João Pessoa-PB. O dono é Alex.
Instalamos películas: Nano Cerâmica, Espelhada, Fumê, Fosca.

== STATUS ATUAL ==
Nome: ${info.nome || 'não coletado'}
Bairro: ${info.bairro || 'não coletado'}
Tipo de imóvel: ${info.tipo_imovel || 'não coletado'}
Problema principal: ${problemaLabel[info.problema_principal] || info.problema_principal || 'não coletado'}
Película: ${info.pelicula_indicada || 'não definida'}
Qtd superfícies: ${info.quantidade_janelas || 'não coletado'}
Medidas: ${janelasSummary || 'nenhuma'}
Fotos: ${info.fotos_recebidas === true ? 'recebidas' : info.fotos_recebidas === 'sem_foto' ? 'cliente não tem' : 'pendentes'}

== PRÓXIMA AÇÃO OBRIGATÓRIA ==
Encaminhe o cliente para: "${nextText}"
Reescreva isso de forma natural. Se o cliente informou algo agora, confirme brevemente (ex: Anotado!) e siga.

== REGRAS ABSOLUTAS ==
1. NUNCA mencione preços, formas de pagamento, agenda ou prazos. Essa parte é com o Alex.
2. NUNCA responda sobre película de carro/automotiva.
3. Se o cliente disser que não tem foto, aceite sem insistir.
4. Resposta curta (máx 3 linhas).
5. Máximo 2 emojis. Seja amigável e direto.`;

  try {
    const resp = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 200,
      temperature: 0.35,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ]
    });
    const llmText = resp.choices[0]?.message?.content?.trim();
    if (llmText && llmText.length > 5) {
      console.log(`🤖 LLM resposta (${nextStep}): ${llmText.substring(0, 80)}...`);
      return llmText;
    }
  } catch (err) {
    console.warn('⚠️ LLM response generation falhou:', err.message?.substring(0, 80));
  }
  return nextText;
}

// ─── VERIFICAR SE O FLOW ESTÁ COMPLETO ──────────────────────────────────────
function isFlowComplete(conv) {
  const info = conv.informacoes_coletadas || {};
  // Medidas são OPCIONAIS — o Alex mede na visita se o cliente não souber
  return !!(
    info.nome &&
    info.bairro &&
    info.tipo_imovel &&
    info.problema_principal &&
    info.quantidade_janelas &&
    info.fotos_recebidas
  );
}

// ─── PRÓXIMA PERGUNTA NO FLOW ──────────────────────────────────────────────
function _getNextStep(jid) {
  const conv = state.conversations[jid];
  if (!conv) return { step: 'erro', text: pickTemplate('erro_tecnico') };
  const info = conv.informacoes_coletadas || {};
  const nome = (info.nome || '').split(' ')[0] || '';

  // Special situations (max priority)
  if (info._situacao === 'automotivo') return { step: 'automotivo', text: pickTemplate('resposta_automotivo', { nome }), terminal: true };
  if (info._situacao === 'superficie_desconhecida') return { step: 'superficie', text: pickTemplate('resposta_superficie', { nome }) };
  if (info._situacao === 'pergunta_preco') return { step: 'preco', text: pickTemplate('resposta_preco', { nome }) };
  if (info._situacao === 'cancelamento') return { step: 'cancelamento', text: pickTemplate('resposta_cancelamento', { nome }), terminal: true };

  // Consultive flow — ask for nome and bairro separately if one is already known
  if (!info.nome && !info.bairro) return { step: 'nome_bairro', text: pickTemplate('pedir_nome_bairro') };
  if (!info.nome) return { step: 'nome', text: `Pode me dizer seu * nome *, ${info.bairro}? 😊` };
  if (!info.bairro) return { step: 'bairro', text: `${nome}, em qual * bairro * de João Pessoa você está ? 📍` };
  if (!info.tipo_imovel) return { step: 'tipo_imovel', text: pickTemplate('pedir_tipo_imovel', { nome }) };
  if (!info.quantidade_janelas) return { step: 'quantidade', text: pickTemplate('pedir_quantidade', { nome }) };

  // ── Medidas: lógica completa ────────────────────────────────────────────────
  const qtd = info.quantidade_janelas;
  const temMedidasReais = Array.isArray(info.janelas) && info.janelas.some(j => j.medida && /\d/.test(j.medida));
  const medidasDispensadas = !!info._medidas_dispensadas;
  const confirmouTerMedidas = !!info._confirmou_ter_medidas;

  if (!medidasDispensadas) {
    if (confirmouTerMedidas || temMedidasReais) {
      // Cliente disse que tem medidas ou já deu alguma: coletar janela por janela
      const janelasDadas = Array.isArray(info.janelas)
        ? info.janelas.filter(j => j.medida && /\d/.test(j.medida)).length : 0;
      if (janelasDadas < qtd) {
        const numAtual = janelasDadas + 1;
        const textoMedida = qtd === 1
          ? `${nome ? nome + ', qual' : 'Qual'} a *medida* da superfície? 📏\n(Largura × altura, ex: 1,20 × 1,50m)`
          : `${nome ? nome + ', qual' : 'Qual'} a *medida* da janela *${numAtual} de ${qtd}*? 📏\n(Ex: 1,20 × 1,50m)`;
        return { step: 'medida_janela', text: textoMedida };
      }
      // Todas as medidas coletadas → seguir
    } else if (!conv._medidas_solicitadas) {
      // Primeira vez perguntando — com aviso de que é opcional
      if (qtd === 1) return { step: 'medidas', text: pickTemplate('pedir_medidas_unica', { nome }) };
      else return { step: 'medidas', text: pickTemplate('pedir_medidas_varias', { nome, num: '1', total: String(qtd) }) };
    }
    // _medidas_solicitadas=true mas sem resposta de medida e sem negativa → avançar para fotos
  }

  if (!info.fotos_recebidas) return { step: 'fotos', text: pickTemplate('pedir_fotos', { nome }) };
  // 'sem_foto' é truthy e indica que o cliente já disse que não tem foto — não voltar a perguntar

  // All done
  return { step: 'completo', text: null };
}

// ─── RESUMO PARA O DONO (ALEX) ──────────────────────────────────────────────
function buildOwnerSummary(jid, conv) {
  const info = conv.informacoes_coletadas || {};
  const numero = jid.replace('@s.whatsapp.net', '');

  const janelasText = (info.janelas || []).map(j => {
    const tipo = j.tipo || 'janela';
    const emoji = tipo === 'box de banheiro' ? '🚿' : tipo === 'varanda' ? '🌅' : tipo === 'cortina de vidro' ? '🪟' : tipo === 'porta' ? '🚪' : '🪟';
    return `${emoji} ${tipo.charAt(0).toUpperCase() + tipo.slice(1)} ${j.numero}: ${j.medida || 'N/I'} | ${j.folhas || '?'} folha(s)`;
  }).join('\n');

  const problemaEmoji = { calor: '🌡️', privacidade: '👁️', claridade: '☀️', estetica: '🎨' };
  const problemaLabel = { calor: 'Calor excessivo', privacidade: 'Privacidade', claridade: 'Excesso de claridade', estetica: 'Estética/decoração' };
  const pelicula = info.pelicula_desejada || info.pelicula_indicada || 'N/I';

  const dataInicio = conv.data_inicio ? new Date(conv.data_inicio).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'desconhecido';

  return `🔔 * NOVO LEAD — Películas Brasil *

👤 Cliente: ${info.nome || 'N/I'}
📍 Bairro: ${info.bairro || 'N/I'}
🏠 Imóvel: ${info.tipo_imovel ? info.tipo_imovel.charAt(0).toUpperCase() + info.tipo_imovel.slice(1) : 'N/I'}
📞 WhatsApp: ${numero}

${problemaEmoji[info.problema_principal] || '🎯'} Problema: ${problemaLabel[info.problema_principal] || info.problema_principal || 'N/I'}
🎬 Película indicada: ${pelicula}
🪟 Qt.superfícies: ${info.quantidade_janelas || 'N/I'}

${janelasText || '📐 Medidas: N/I'}

📸 Fotos: ${info.fotos_recebidas === true ? 'Sim \u2705' : info.fotos_recebidas === 'sem_foto' ? 'N\u00e3o (cliente informou) \u274c' : info.fotos_recebidas === 'pendente' ? 'Pendente \u23f3' : 'N\u00e3o \u274c'}
⏱ Início: ${dataInicio} `;
}

// ─── ENVIAR SAUDAÇÃO COM BOTÕES ────────────────────────────────────────────
async function _sendBoasVindasComBotoes(jid, textoBoasVindas) {
  const min = state.settings.delay_min || 2000;
  const max = state.settings.delay_max || 5000;
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
  await sock.sendPresenceUpdate('composing', jid);
  await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 600));
  await sock.sendPresenceUpdate('paused', jid);

  let enviou = false;

  // ── CAMADA 1: listMessage (mais compatível) ───────────────────────────────
  try {
    await sock.sendMessage(jid, {
      text: textoBoasVindas,
      footer: 'Películas Brasil 🪟 — João Pessoa',
      title: '',
      buttonText: '👆 Toque aqui para escolher',
      sections: [{
        rows: [
          { title: '✅ Sim, pode tentar!', description: 'Iniciar atendimento com o assistente', rowId: 'btn_sim_bot' },
          { title: '⏳ Não, vou aguardar o Alex', description: 'Prefiro atendimento humano', rowId: 'btn_nao_aguardar' }
        ]
      }]
    });
    console.log('✅ Lista interativa enviada (listMessage)');
    enviou = true;
  } catch (err1) {
    console.warn('⚠️ listMessage falhou:', err1.message?.substring(0, 80));
  }

  // ── CAMADA 2: buttonsMessage clássico ─────────────────────────────────────
  if (!enviou) {
    try {
      await sock.sendMessage(jid, {
        text: textoBoasVindas,
        buttons: [
          { buttonId: 'btn_sim_bot', buttonText: { displayText: '✅ Sim, pode tentar!' }, type: 1 },
          { buttonId: 'btn_nao_aguardar', buttonText: { displayText: '⏳ Não, vou aguardar o Alex' }, type: 1 }
        ],
        headerType: 1,
        footer: 'Películas Brasil 🪟'
      });
      console.log('✅ Botões clássicos enviados (buttonsMessage)');
      enviou = true;
    } catch (err2) {
      console.warn('⚠️ buttonsMessage falhou:', err2.message?.substring(0, 80));
    }
  }

  // ── CAMADA 3: texto numerado (sempre funciona) ────────────────────────────
  if (!enviou) {
    try {
      await sock.sendMessage(jid, {
        text: textoBoasVindas + '\n\nDigite:\n*1* — Sim, pode tentar!\n*2* — Não, vou aguardar o Alex'
      });
      console.log('✅ Boas-vindas em texto puro (fallback final)');
    } catch (err3) {
      console.error('❌ Falha total ao enviar boas-vindas:', err3.message);
    }
  }

  incrementMessageCount();
  addToLog({ type: 'outgoing', jid, text: textoBoasVindas + ' [lista/botões]', cliente: state.conversations[jid]?.cliente, from: 'bot' });
  const conv = state.conversations[jid];
  if (conv) {
    const msgs = [...(conv.mensagens || [])];
    msgs.push({ de: 'bot', tipo: 'texto', conteudo: textoBoasVindas, hora: new Date().toISOString() });
    updateConversation(jid, { mensagens: msgs });
  }
}

// ─── ENVIAR LISTA DE PROBLEMA ──────────────────────────────────────────────
async function _sendProblemaComBotoes(jid) {
  const nome = (state.conversations[jid]?.informacoes_coletadas?.nome || '').split(' ')[0];
  const texto = nome
    ? `${nome}, qual o principal * problema * que você quer resolver com a película ? 🎯`
    : `Qual o principal * problema * que você quer resolver com a película ? 🎯`;

  const min = state.settings.delay_min || 2000;
  const max = state.settings.delay_max || 5000;
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  await new Promise(resolve => setTimeout(resolve, delay));
  await sock.sendPresenceUpdate('composing', jid);
  await new Promise(resolve => setTimeout(resolve, 800));
  await sock.sendPresenceUpdate('paused', jid);

  let enviou = false;

  try {
    await sock.sendMessage(jid, {
      text: texto,
      footer: 'Películas Brasil 🪟 — João Pessoa',
      buttonText: '👆 Toque para escolher',
      sections: [{
        rows: [
          { title: '🌡️ Calor excessivo', description: 'O sol esquenta demais o ambiente', rowId: 'prob_calor' },
          { title: '👁️ Privacidade', description: 'Pessoas de fora conseguem ver o interior', rowId: 'prob_privacidade' },
          { title: '☀️ Excesso de claridade', description: 'Muito sol ou ofuscamento', rowId: 'prob_claridade' },
          { title: '🎨 Estética / decoração', description: 'Modernizar ou decorar o espaço', rowId: 'prob_estetica' },
        ]
      }]
    });
    console.log('✅ Lista de problema enviada');
    enviou = true;
  } catch (err) {
    console.warn('⚠️ listMessage problema falhou:', err.message?.substring(0, 80));
  }

  if (!enviou) {
    try {
      await sock.sendMessage(jid, {
        text: texto,
        buttons: [
          { buttonId: 'prob_calor', buttonText: { displayText: '🌡️ Calor' }, type: 1 },
          { buttonId: 'prob_privacidade', buttonText: { displayText: '👁️ Privacidade' }, type: 1 },
          { buttonId: 'prob_claridade', buttonText: { displayText: '☀️ Claridade' }, type: 1 },
          { buttonId: 'prob_estetica', buttonText: { displayText: '🎨 Estética' }, type: 1 },
        ],
        headerType: 1,
        footer: 'Películas Brasil 🪟'
      });
      enviou = true;
    } catch (err2) {
      console.warn('⚠️ buttonsMessage problema falhou:', err2.message?.substring(0, 80));
    }
  }

  if (!enviou) {
    await sock.sendMessage(jid, {
      text: texto + '\n\nDigite:\n*1* — 🌡️ Calor excessivo\n*2* — 👁️ Privacidade\n*3* — ☀️ Excesso de claridade\n*4* — 🎨 Estética / decoração'
    });
  }

  incrementMessageCount();
  addToLog({ type: 'outgoing', jid, text: texto + ' [lista problema]', cliente: state.conversations[jid]?.cliente, from: 'bot' });
  const conv = state.conversations[jid];
  if (conv) {
    const msgs = [...(conv.mensagens || [])];
    msgs.push({ de: 'bot', tipo: 'texto', conteudo: texto, hora: new Date().toISOString() });
    updateConversation(jid, { mensagens: msgs });
  }
}

// ─── STATE MACHINE: PROCESSAR FLOW DO CLIENTE ──────────────────────────────
async function processFlow(jid, userMessage = '') {
  const conv = state.conversations[jid];
  if (!conv) return false;

  // ── ESTADO: Aguardando Alex (cliente escolheu esperar) ────────────────
  if (conv.status === 'aguardando_alex') return true; // silencioso

  // ── ESTADO: Aguardando escolha inicial (botões Sim/Não) ───────────────
  if (conv._aguardando_escolha_inicial && !conv._boas_vindas_confirmada) {
    const msgLower = (userMessage || '').toLowerCase().trim();

    const escolheuSim =
      msgLower === 'btn_sim_bot' ||
      msgLower === '1' ||
      msgLower === 'sim' ||
      msgLower === 'ok' ||
      msgLower === 'pode' ||
      msgLower === 'pode sim' ||
      msgLower === 'claro' ||
      msgLower.includes('sim, pode') ||
      msgLower.includes('✅') ||
      msgLower.startsWith('sim');

    const escolheuNao =
      msgLower === 'btn_nao_aguardar' ||
      msgLower === '2' ||
      msgLower === 'não' ||
      msgLower === 'nao' ||
      msgLower.includes('aguardar') ||
      msgLower.includes('aguarda') ||
      msgLower.includes('⏳') ||
      msgLower.includes('não, vou') ||
      msgLower.includes('nao, vou');

    if (escolheuSim) {
      updateConversation(jid, { _boas_vindas_confirmada: true, _aguardando_escolha_inicial: false, _aguardando_problema: true });

      const infoAtual = state.conversations[jid].informacoes_coletadas || {};
      const nomeAtual = (infoAtual.nome || '').split(' ')[0];

      // ── Pular para o primeiro campo ainda desconhecido ──────────────────
      // Se o cliente já mandou tudo na primeira mensagem, podemos pular várias etapas

      if (infoAtual.problema_principal) {
        // Problema já conhecido → marcar como selecionado e enviar recomendação
        updateConversation(jid, { _aguardando_problema: false, _problema_selecionado: true });
        const recomKey = `recomendacao_${infoAtual.problema_principal} `;
        const recomText = TEMPLATES[recomKey]
          ? pickTemplate(recomKey, { nome: nomeAtual })
          : `Ótimo${nomeAtual ? ', ' + nomeAtual : ''} ! 😊`;
        await sendWithDelay(jid, { text: recomText });

        // Verificar se o fluxo já está completo
        if (isFlowComplete(state.conversations[jid])) {
          await _handleFlowComplete(jid);
          return true;
        }

        // Ir para próxima pergunta necessária
        const next = _getNextStep(jid);
        if (next.step !== 'completo' && next.text) {
          const stepUpd = { _ultimo_step: next.step };
          if (next.step === 'medidas' || next.step === 'medida_faltante') stepUpd._medidas_solicitadas = true;
          updateConversation(jid, stepUpd);
          await sendWithDelay(jid, { text: next.text });
        } else if (next.step === 'completo') {
          await _handleFlowComplete(jid);
        }

      } else if (infoAtual.nome || infoAtual.bairro || infoAtual.tipo_imovel || infoAtual.quantidade_janelas) {
        // Já temos alguns dados mas não o problema → pedir o problema
        updateConversation(jid, { _aguardando_problema: true });
        await _sendProblemaComBotoes(jid);

      } else {
        // Nenhum dado → fluxo padrão (perguntar problema)
        await _sendProblemaComBotoes(jid);
      }
      return true;
    }

    if (escolheuNao) {
      // ⏳ Cliente prefere esperar o Alex
      updateConversation(jid, { status: 'aguardando_alex', _aguardando_escolha_inicial: false });

      addToLog({
        type: 'system', jid,
        text: '⏳ Cliente preferiu aguardar o Alex — bot em espera',
        cliente: conv.cliente, from: 'sistema'
      });

      await sendWithDelay(jid, {
        text: `Tudo bem! 😊 O Alex será notificado e entrará em contato assim que possível.\n\nObrigado pela paciência! 🙏`
      });

      // Notificar o dono via WhatsApp
      const ownerNumber = process.env.OWNER_NUMBER;
      if (ownerNumber && !ownerNumber.includes('X')) {
        const ownerJid = `${ownerNumber} @s.whatsapp.net`;
        const numero = jid.replace('@s.whatsapp.net', '');
        try {
          await new Promise(r => setTimeout(r, 1500));
          await sock.sendMessage(ownerJid, {
            text: `⏳ * Cliente aguardando atendimento humano *\n\nNúmero: ${numero} \nCliente escolheu aguardar o Alex em vez do bot.\n\nResponda diretamente para este número no WhatsApp.`
          });
        } catch (e) {
          console.warn('⚠️ Não foi possível notificar o dono:', e.message);
        }
      }
      return true;
    }

    // Resposta não reconhecida → lembrar as opções
    await sendWithDelay(jid, {
      text: `Por favor, escolha uma das opções: \n\n * 1 * — ✅ Sim, pode tentar!\n * 2 * — ⏳ Não, vou aguardar o Alex`
    });
    return true;
  }

  // ── ESTADO: Aguardando seleção do problema ─────────────────────────────
  if (conv._aguardando_problema && !conv._problema_selecionado) {
    const msgLower2 = (userMessage || '').toLowerCase().trim();

    // Map button IDs and text to problem
    let problema = null;
    if (msgLower2 === 'prob_calor' || msgLower2 === '1' || /calor|quente|esquenta|térm/.test(msgLower2)) problema = 'calor';
    else if (msgLower2 === 'prob_privacidade' || msgLower2 === '2' || /privacidade|privado|ver|veem/.test(msgLower2)) problema = 'privacidade';
    else if (msgLower2 === 'prob_claridade' || msgLower2 === '3' || /clarid|sol demais|muito sol|ofuscam/.test(msgLower2)) problema = 'claridade';
    else if (msgLower2 === 'prob_estetica' || msgLower2 === '4' || /estética|estética|bonito|moderno|decorar/.test(msgLower2)) problema = 'estetica';

    if (problema) {
      const mapa = { calor: 'nano cerâmica', privacidade: 'espelhada', claridade: 'fumê', estetica: 'fosca' };
      const infoNow = { ...state.conversations[jid].informacoes_coletadas };
      infoNow.problema_principal = problema;
      infoNow.pelicula_indicada = mapa[problema];
      updateConversation(jid, {
        informacoes_coletadas: infoNow,
        _aguardando_problema: false,
        _problema_selecionado: true
      });

      // Send recommendation
      const recomKey = `recomendacao_${problema} `;
      const nome = (infoNow.nome || '').split(' ')[0];
      const recomText = TEMPLATES[recomKey] ? pickTemplate(recomKey, { nome }) : `Ótimo! Vamos ver o que você precisa!`;
      await sendWithDelay(jid, { text: recomText });

      // Determine next question
      const next = _getNextStep(jid);
      if (next.step !== 'completo' && next.text) {
        const pergunta = infoNow.nome ? next.text.replace(/^[^,]+,\s*/, '') : next.text;
        const stepUpdates = { _ultimo_step: next.step };
        if (next.step === 'medidas' || next.step === 'medida_faltante') stepUpdates._medidas_solicitadas = true;
        updateConversation(jid, stepUpdates);
        await sendWithDelay(jid, { text: pergunta });
      }
    } else {
      // Didn't recognize → remind options
      if (userMessage && userMessage.trim()) {
        await sendWithDelay(jid, {
          text: `Por favor, escolha uma das opções: \n * 1 * — 🌡️ Calor excessivo\n * 2 * — 👁️ Privacidade\n * 3 * — ☀️ Excesso de claridade\n * 4 * — 🎨 Estética / decoração`
        });
      }
    }
    return true;
  }

  // ── Boas-vindas (primeira vez) ───────────────────────────────────────
  if (!conv._boas_vindas_enviado) {
    updateConversation(jid, {
      _boas_vindas_enviado: true,
      _aguardando_escolha_inicial: true,
      _boas_vindas_confirmada: false
    });

    // ── LEITURA DA PRIMEIRA MENSAGEM: extrair tudo que o cliente já disse ──
    const infoFirst = conv.informacoes_coletadas || {};
    const { info: infoExtracted } = _extractLocally(userMessage, infoFirst, '');
    updateConversation(jid, { informacoes_coletadas: infoExtracted });

    // ── WELCOME PERSONALIZADO: reagir ao que o cliente escreveu ──────────
    const saudacao = getSaudacao();
    const nome1 = infoExtracted.nome ? infoExtracted.nome.split(' ')[0] : '';
    const cumprimento = nome1 ? `Olá, ${nome1} !${saudacao} 😊` : `Olá! ${saudacao.charAt(0).toUpperCase() + saudacao.slice(1)} 😊`;

    // Detectar tipo de abertura
    const msgTrim = (userMessage || '').trim();
    const ehSoSaudacao = /^(oi[eê]?|ol[aá]|hey|eae|opa|e [aí]+|bom dia|boa tarde|boa noite|tudo bem)[\s!.?]*$/i.test(msgTrim);
    const ehPerguntaPreco = /quanto\s+custa|qual\s+(?:o\s+)?pre[çc]o|valor|pre[çc]o/i.test(msgTrim);
    const ehAutomotivo = /\b(?:carro|auto|veículo|veiculo|moto|caminhão|caminhao|vidro\s+do\s+carro|película\s+automotiv)\b/i.test(msgTrim);

    // Montar o que o cliente já informou (para citar no welcome)
    const jaInformou = [];
    if (infoExtracted.quantidade_janelas) jaInformou.push(`* ${infoExtracted.quantidade_janelas} superfície(s) * `);
    const probLabel = { calor: 'reduzir o calor 🌡️', privacidade: 'privacidade 👁️', claridade: 'reduzir claridade ☀️', estetica: 'estética 🎨' };
    if (infoExtracted.problema_principal) jaInformou.push(probLabel[infoExtracted.problema_principal] || infoExtracted.problema_principal);
    if (infoExtracted.tipo_imovel) jaInformou.push(`* ${infoExtracted.tipo_imovel}* `);
    if (infoExtracted.bairro && !nome1) jaInformou.push(`bairro * ${infoExtracted.bairro}* `);

    let boasVindas;

    if (ehAutomotivo) {
      // Automotivo — avisa logo que não é o foco
      boasVindas =
        `${cumprimento} \n\n` +
        `Nosso foco é película * residencial e comercial * 🏠\n\n` +
        `Mas se quiser, o Alex pode te orientar melhor.Quer que eu registre seu contato ? `;
    } else if (ehPerguntaPreco) {
      // Pergunta de preço — responde a altura e pede para continuar
      boasVindas =
        `${cumprimento} \n\n` +
        `O preço depende do tipo de película e das medidas — o Alex faz o orçamento personalizado! 💰\n\n` +
        `Posso coletar algumas informações para agilizar o atendimento.Quer que eu continue?`;
    } else if (ehSoSaudacao) {
      // Só uma saudação — welcome genérico
      boasVindas =
        `${cumprimento} Tudo bem ?\n\n` +
        `Aqui é o assistente do Alex da * Películas Brasil * 🪟\n` +
        `Ele está em atendimento agora, mas posso agilizar pra você!\n\n` +
        `Quer que eu te ajude ? `;
    } else if (jaInformou.length > 0) {
      // Cliente já passou informações — citar e agradecer
      boasVindas =
        `${cumprimento} \n\n` +
        `Ótimo! Vi que você quer película para ${jaInformou.join(', ')}. 👍\n\n` +
        `Sou o assistente do Alex da * Películas Brasil * — posso continuar coletando as informações para agilizar o orçamento!\n\n` +
        `Posso seguir ? `;
    } else {
      // Mensagem com intenção mas sem dados extraídos (pergunta genérica, etc.)
      boasVindas =
        `${cumprimento} \n\n` +
        `Aqui é o assistente do Alex da * Películas Brasil * 🪟✨\n` +
        `Posso ajudar a agilizar seu atendimento enquanto o Alex finaliza outro cliente!\n\n` +
        `Quer que eu continue?`;
    }

    await _sendBoasVindasComBotoes(jid, boasVindas);
    return true;
  }

  // ── Fallback: boas-vindas enviadas mas estado inconsistente ─────────
  return false;
}

// ─── PROCESSAR MENSAGEM (EXTRAÇÃO + LLM + STATE MACHINE + TEMPLATES) ────────
async function processMessage(jid, userMessage) {
  // ═══ ETAPA 1: EXTRAÇÃO LOCAL (regex — sempre funciona) ═══
  const conv = state.conversations[jid];
  if (!conv) return;

  const ultimoStep = conv._ultimo_step || '';
  const { info: infoAposRegex } = _extractLocally(userMessage, conv.informacoes_coletadas || {}, ultimoStep);
  updateConversation(jid, { informacoes_coletadas: infoAposRegex });

  // Verificar se fluxo completo após regex
  if (isFlowComplete(state.conversations[jid]) && !state.conversations[jid].resumo_enviado) {
    await _handleFlowComplete(jid);
    return;
  }

  // ═══ ETAPA 2: EXTRAÇÃO VIA LLM (se regex não pegou tudo) ═══
  const camposFaltando = !infoAposRegex.nome || !infoAposRegex.bairro ||
    !infoAposRegex.tipo_imovel || !infoAposRegex.problema_principal ||
    !infoAposRegex.quantidade_janelas;

  if (camposFaltando && userMessage && userMessage.trim().length > 1) {
    const { extracted } = await _extractWithLLM(userMessage, infoAposRegex);
    if (extracted && Object.keys(extracted).length > 0) {
      const { info: infoAposLLM } = _applyLLMExtraction(extracted, infoAposRegex);
      updateConversation(jid, { informacoes_coletadas: infoAposLLM });

      if (isFlowComplete(state.conversations[jid]) && !state.conversations[jid].resumo_enviado) {
        await _handleFlowComplete(jid);
        return;
      }
    }
  }

  // ═══ ETAPA 3: STATE MACHINE — DECIDIR PRÓXIMA PERGUNTA ═══
  const next = _getNextStep(jid);

  if (next.step === 'completo') {
    await _handleFlowComplete(jid);
    return;
  }

  if (next.terminal) {
    if (next.step === 'cancelamento') updateConversation(jid, { status: 'encerrada' });
    await sendWithDelay(jid, { text: next.text });
    return;
  }

  // ═══ ETAPA 4: GERAR RESPOSTA VIA LLM (com fallback para template) ═══
  const updates = { _ultimo_step: next.step };
  if (next.step === 'medidas' || next.step === 'medida_faltante' || next.step === 'medida_janela') {
    updates._medidas_solicitadas = true; // Já perguntamos sobre medidas
  }
  updateConversation(jid, updates);

  const response = await _generateResponseWithLLM(jid, userMessage, next.step, next.text);
  await sendWithDelay(jid, { text: response });
}

// ─── SAUDAÇÃO DINÂMICA ───────────────────────────────────────────────────────
function getSaudacao() {
  const hora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' })).getHours();
  if (hora >= 5 && hora < 12) return 'bom dia';
  if (hora >= 12 && hora < 18) return 'boa tarde';
  return 'boa noite';
}

// ─── ENCERRAR ATENDIMENTO ────────────────────────────────────────────────────
async function _handleFlowComplete(jid) {
  const conv = state.conversations[jid];
  if (!conv || conv.resumo_enviado) return;

  updateConversation(jid, { resumo_enviado: true });
  await sendWithDelay(jid, { text: pickTemplate('flow_complete') });

  const ownerNumber = process.env.OWNER_NUMBER;
  if (ownerNumber && !ownerNumber.includes('X')) {
    const ownerJid = `${ownerNumber} @s.whatsapp.net`;
    const summary = buildOwnerSummary(jid, state.conversations[jid]);
    try {
      await new Promise(r => setTimeout(r, 2000));
      await sock.sendMessage(ownerJid, { text: summary });
    } catch (e) {
      console.error('❌ Não foi possível enviar resumo ao dono:', e.message);
    }
  }
}

// ─── HANDLER DE ÁUDIO ────────────────────────────────────────────────────
async function handleAudio(jid, msg) {
  try {
    console.log(`🎙️ Áudio recebido de ${jid} `);
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    const tmpPath = path.join(__dirname, `tmp_audio_${Date.now()}.ogg`);
    fs.writeFileSync(tmpPath, buffer);
    const stream = fs.createReadStream(tmpPath);
    stream.path = 'audio.ogg';

    const transcription = await groq.audio.transcriptions.create({
      file: stream,
      model: 'whisper-large-v3',
      language: 'pt',
      response_format: 'text'
    });
    fs.removeSync(tmpPath);

    const texto = transcription || '';
    if (texto.trim().length > 0) {
      console.log(`📝 Transcrição: "${texto}"`);
      await processFlow(jid, texto);
      if (state.conversations[jid]?._boas_vindas_confirmada) {
        await processMessage(jid, texto);
      }
    } else {
      await sendWithDelay(jid, { text: 'Não consegui entender o áudio. Pode mandar por texto? 😊' });
    }
  } catch (err) {
    console.error('❌ Erro ao processar áudio:', err.message);
    await sendWithDelay(jid, { text: 'Tive dificuldade com o áudio. Pode digitar a mensagem? 😊' });
  }
}

// ─── HANDLER DE IMAGEM ──────────────────────────────────────────────────
async function handleImage(jid, msg) {
  try {
    const numero = jid.replace('@s.whatsapp.net', '');
    const dir = path.join(__dirname, 'fotos_clientes', numero);
    fs.ensureDirSync(dir);
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    fs.writeFileSync(path.join(dir, `foto_${Date.now()}.jpg`), buffer);
    console.log(`📸 Foto salva de ${jid} `);

    const conv = state.conversations[jid];
    if (conv) {
      const info = { ...conv.informacoes_coletadas, fotos_recebidas: true };
      updateConversation(jid, { informacoes_coletadas: info });
    }

    await sendWithDelay(jid, { text: 'Foto recebida, obrigado! 📸' });

    if (isFlowComplete(state.conversations[jid])) {
      await _handleFlowComplete(jid);
    } else {
      const caption = msg.message?.imageMessage?.caption || '';
      if (caption.trim()) {
        await processMessage(jid, caption);
      } else {
        const next = _getNextStep(jid);
        if (next.step === 'completo') await _handleFlowComplete(jid);
        else if (next.text) await sendWithDelay(jid, { text: next.text });
      }
    }
  } catch (err) {
    console.error('❌ Erro ao processar imagem:', err.message);
    await sendWithDelay(jid, { text: 'Recebi sua foto! 📸' });
  }
}

// ─── HANDLER DE VÍDEO ──────────────────────────────────────────────────
async function handleVideo(jid, msg) {
  try {
    const numero = jid.replace('@s.whatsapp.net', '');
    const dir = path.join(__dirname, 'fotos_clientes', numero);
    fs.ensureDirSync(dir);
    const buffer = await downloadMediaMessage(msg, 'buffer', {});
    fs.writeFileSync(path.join(dir, `video_${Date.now()}.mp4`), buffer);

    const conv = state.conversations[jid];
    if (conv) {
      const info = { ...conv.informacoes_coletadas, fotos_recebidas: true };
      updateConversation(jid, { informacoes_coletadas: info });
    }
    await sendWithDelay(jid, { text: 'Recebi seu vídeo! Para agilizar, pode descrever por texto também? 😊' });
  } catch (err) {
    console.error('❌ Erro ao processar vídeo:', err.message);
  }
}

// ─── HANDLER DE DOCUMENTO ──────────────────────────────────────────────
async function handleDocument(jid) {
  await sendWithDelay(jid, { text: 'Recebi o arquivo! Se precisar, pode descrever por texto também. 😊' });
  console.log(`📄 Documento recebido de ${jid} `);
}

// ─── HANDLER PRINCIPAL DE MENSAGENS ─────────────────────────────────────────
async function handleMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid) return;
  if (jid.endsWith('@g.us')) return;
  if (jid === 'status@broadcast') return;

  // ── Mensagens do dono (fromMe) ───────────────────────────────────────
  if (msg.key.fromMe) {
    const textoOp = getMessageText(msg);
    const textoTrimLower = (textoOp || '').trim().toLowerCase();

    // Comando #bot → reativar bot
    if (textoTrimLower === '#bot') {
      const convAtual = state.conversations[jid];
      if (convAtual) {
        const eraAguardando = convAtual.status === 'aguardando_alex';
        console.log(`🤖 Bot REATIVADO para ${jid} (comando #bot do dono)`);
        updateConversation(jid, {
          status: 'bot_ativo',
          _boas_vindas_enviado: eraAguardando ? false : convAtual._boas_vindas_enviado,
          _aguardando_escolha_inicial: false,
          _boas_vindas_confirmada: eraAguardando ? false : convAtual._boas_vindas_confirmada,
          _aguardando_problema: false
        });
        addToLog({ type: 'system', jid, text: '🤖 Bot reativado pelo dono via #bot', cliente: convAtual.cliente, from: 'sistema' });
      }
      return;
    }

    // Qualquer outra mensagem do dono → modo humano
    if (textoOp && textoOp.trim().length > 0) {
      if (!state.conversations[jid]) updateConversation(jid, {});
      const convAtual = state.conversations[jid];
      const jaEraHumano = convAtual.status === 'humano';
      if (!jaEraHumano) {
        console.log(`👨‍💼 Dono ASSUMIU conversa com ${jid} — bot PARADO`);
        updateConversation(jid, { status: 'humano' });
        addToLog({ type: 'system', jid, text: '👨‍💼 Dono assumiu a conversa — bot pausado (envie #bot para reativar)', cliente: convAtual.cliente, from: 'sistema' });
      }
      const msgsOp = [...(convAtual.mensagens || [])];
      msgsOp.push({ de: 'humano', tipo: 'texto', conteudo: textoOp, hora: new Date().toISOString() });
      updateConversation(jid, { mensagens: msgsOp });
      addToLog({ type: 'outgoing', jid, text: textoOp, cliente: convAtual.cliente, from: 'atendente' });
    }
    return;
  }

  if (!msg.message) return;

  const msgId = msg.key.id;
  const rawText = getMessageText(msg);
  if (!msgId || isDuplicate(msgId, jid, rawText)) return;

  await withJidLock(jid, () => _processMessage(msg));
}

async function _processMessage(msg) {
  const jid = msg.key.remoteJid;
  const messageType = getMessageType(msg);
  const text = getMessageText(msg);

  if (!state.conversations[jid]) {
    updateConversation(jid, {
      data_inicio: new Date().toISOString(),
      status: 'bot_ativo',
      informacoes_coletadas: {
        nome: null, bairro: null, tipo_imovel: null,
        problema_principal: null, pelicula_indicada: null,
        quantidade_janelas: null, janelas: [],
        pelicula_desejada: null, fotos_recebidas: false
      }
    });
  }

  updateConversation(jid, { lastActivity: Date.now() });

  addToLog({
    type: 'incoming', jid,
    text: text || `[${messageType}]`,
    cliente: state.conversations[jid]?.cliente,
    from: 'cliente'
  });

  const conv = state.conversations[jid];
  const msgs = [...(conv.mensagens || [])];
  msgs.push({ de: 'cliente', tipo: messageType, conteudo: text || `[${messageType}]`, hora: new Date().toISOString() });
  updateConversation(jid, { mensagens: msgs });

  if (!state.globalBotActive) return;
  if (state.conversations[jid].status === 'humano') return;
  if (state.conversations[jid].status === 'encerrada') return;
  if (state.conversations[jid].status === 'aguardando_alex') return;

  if (!isWithinWorkingHours()) {
    if (!state.conversations[jid].fora_horario_notificado) {
      await sendWithDelay(jid, {
        text: 'Olá! 😊 Recebi sua mensagem. Nosso horário de atendimento é das ' +
          `${state.settings.horario_inicio} às ${state.settings.horario_fim}. Retornaremos em breve!`
      });
      updateConversation(jid, { fora_horario_notificado: true });
    }
    return;
  }

  if (state.conversations[jid].fora_horario_notificado) {
    updateConversation(jid, { fora_horario_notificado: false });
  }

  // Reiniciar conversa
  if (text && text.trim().toLowerCase() === 'reiniciar') {
    console.log(`🔄 Reinício: ${jid} `);
    updateConversation(jid, {
      cliente: null, bairro: null,
      data_inicio: new Date().toISOString(), data_fim: null,
      status: 'bot_ativo', lastActivity: Date.now(),
      mensagens: [],
      informacoes_coletadas: {
        nome: null, bairro: null, tipo_imovel: null,
        problema_principal: null, pelicula_indicada: null,
        quantidade_janelas: null, janelas: [],
        pelicula_desejada: null, fotos_recebidas: false
      },
      _boas_vindas_enviado: false, _aguardando_escolha_inicial: false,
      _boas_vindas_confirmada: false, _aguardando_problema: false,
      _problema_selecionado: false, resumo_enviado: false,
      _ultimo_step: '', _medidas_solicitadas: false, fora_horario_notificado: false
    });
    await processFlow(jid, '');
    return;
  }

  // ── Resposta de lista interativa (listResponseMessage) ───────────────────
  const listResp = msg.message?.listResponseMessage;
  if (listResp) {
    const rowId = listResp.singleSelectReply?.selectedRowId || '';
    const titulo = listResp.title || rowId;
    console.log(`📋 Lista selecionada: rowId = "${rowId}" título = "${titulo}"`);
    await processFlow(jid, rowId || titulo);
    return;
  }

  // ── Resposta de botão clássico (buttonsResponseMessage) ──────────────────
  const buttonResponse = msg.message?.buttonsResponseMessage;
  if (buttonResponse) {
    const buttonId = buttonResponse.selectedButtonId || '';
    const buttonText = buttonResponse.selectedDisplayText || buttonId;
    console.log(`🔘 Botão clicado: id = "${buttonId}" texto = "${buttonText}"`);
    await processFlow(jid, buttonId || buttonText);
    return;
  }

  // ── Resposta de botão moderno (interactiveResponseMessage) ───────────────
  const interactiveResp = msg.message?.interactiveResponseMessage;
  if (interactiveResp) {
    try {
      const params = JSON.parse(interactiveResp.nativeFlowResponseMessage?.paramsJson || '{}');
      const buttonId = params.id || '';
      console.log(`🔘 Botão interativo clicado: id = "${buttonId}"`);
      await processFlow(jid, buttonId);
    } catch (e) {
      console.warn('⚠️ Erro ao parsear interactiveResponseMessage:', e.message);
    }
    return;
  }

  if (messageType === 'audioMessage') {
    await handleAudio(jid, msg);
  } else if (messageType === 'imageMessage') {
    await handleImage(jid, msg);
  } else if (messageType === 'videoMessage') {
    await handleVideo(jid, msg);
  } else if (messageType === 'documentMessage' || messageType === 'documentWithCaptionMessage') {
    await handleDocument(jid);
  } else {
    const handled = await processFlow(jid, text || '');
    if (!handled && state.conversations[jid]?._boas_vindas_confirmada) {
      await processMessage(jid, text || '');
    }
  }
}

// ─── TIMEOUT: REINICIAR CONVERSA APÓS 30 MIN INATIVO ─────────────────────────
setInterval(() => {
  const now = Date.now();
  Object.keys(state.conversations).forEach(jid => {
    const conv = state.conversations[jid];
    if (!conv) return;
    if (conv.status !== 'bot_ativo') return;
    if (!conv.lastActivity) return;
    if (conv.resumo_enviado) return;
    const minutesInactive = (now - conv.lastActivity) / 60000;
    if (minutesInactive >= 30) {
      console.log(`⏰ Conversa reiniciada por inatividade: ${jid} `);
      updateConversation(jid, {
        _boas_vindas_enviado: false, _aguardando_escolha_inicial: false,
        _boas_vindas_confirmada: false, _aguardando_problema: false,
        _problema_selecionado: false, resumo_enviado: false,
        _ultimo_step: '', _medidas_solicitadas: false,
        fora_horario_notificado: false, lastActivity: now,
        informacoes_coletadas: {
          nome: null, bairro: null, tipo_imovel: null,
          problema_principal: null, pelicula_indicada: null,
          quantidade_janelas: null, janelas: [],
          pelicula_desejada: null, fotos_recebidas: false
        }
      });
    }
  });
}, 60000);

// ─── INICIAR BOT ────────────────────────────────────────────────────────────
async function startBot(io) {
  groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

  const { version } = await fetchLatestBaileysVersion();
  const { state: authState, saveCreds } = await useMultiFileAuthState(
    path.join(__dirname, 'auth_info_baileys')
  );

  function connect() {
    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: authState,
      browser: ['Películas Brasil', 'Chrome', '121.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => ({ conversation: '' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log('📱 QR Code gerado — escaneie pelo painel!');
        try {
          const qrDataUrl = await QRCode.toDataURL(qr);
          io.emit('qr', qrDataUrl);
          io.emit('connection_status', { status: 'waiting_qr' });
          state.connected = false;
          state.connectedNumber = null;
        } catch (e) {
          console.error('Erro ao gerar QR:', e.message);
        }
      }

      if (connection === 'open') {
        const number = sock.user?.id?.split(':')[0] || 'desconhecido';
        console.log(`✅ WhatsApp conectado: ${number} `);
        state.connected = true;
        state.connectedNumber = number;
        io.emit('connection_status', { status: 'connected', number });
      }

      if (connection === 'close') {
        state.connected = false;
        state.connectedNumber = null;
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log(`🔌 Conexão fechada.Motivo: ${reason} `);
        io.emit('connection_status', { status: 'disconnected', reason });

        if (reason === DisconnectReason.loggedOut) {
          console.log('⚠️ Sessão encerrada. Apague a pasta auth_info_baileys e reconecte.');
          io.emit('alert', {
            type: 'danger',
            message: '⚠️ Você foi desconectado do WhatsApp. Apague a pasta auth_info_baileys e reinicie.'
          });
        } else {
          console.log('🔄 Reconectando em 5 segundos...');
          setTimeout(connect, 5000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          await handleMessage(msg);
        } catch (err) {
          console.error('❌ Erro ao processar mensagem:', err.message);
        }
      }
    });

    return sock;
  }

  connect();
  console.log('⏳ Aguardando conexão WhatsApp...\n');
}

module.exports = { startBot };
