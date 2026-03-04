'use strict';

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs-extra');

const app = express();
const httpServer = createServer(app);
let io;

// ─── ESTADO GLOBAL COMPARTILHADO ─────────────────────────────────────────────
const state = {
  connected: false,
  connectedNumber: null,
  globalBotActive: true,
  conversations: {},
  messageLog: [],
  messageCount24h: 0,
  messageCountResetTime: Date.now() + 86400000,
  settings: {
    horario_inicio: process.env.HORARIO_INICIO || '07:00',
    horario_fim: process.env.HORARIO_FIM || '21:00',
    delay_min: parseInt(process.env.DELAY_MIN) || 2000,
    delay_max: parseInt(process.env.DELAY_MAX) || 5000,
  }
};

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── ROTAS DA API ─────────────────────────────────────────────────────────────

// Status geral
app.get('/api/status', (req, res) => {
  res.json({
    connected: state.connected,
    connectedNumber: state.connectedNumber,
    globalBotActive: state.globalBotActive,
    conversations: Object.values(state.conversations),
    messageLog: state.messageLog.slice(0, 100),
    messageCount24h: state.messageCount24h,
    settings: state.settings
  });
});

// Ativar/Pausar bot globalmente
app.post('/api/bot/toggle', (req, res) => {
  state.globalBotActive = !state.globalBotActive;
  if (io) io.emit('bot_status_update', { active: state.globalBotActive });
  console.log(`🤖 Bot ${state.globalBotActive ? 'ATIVADO' : 'PAUSADO'} globalmente`);
  res.json({ active: state.globalBotActive });
});

// Humano assume conversa
app.post('/api/conversation/:id/assume', (req, res) => {
  const { id } = req.params;
  if (state.conversations[id]) {
    state.conversations[id].status = 'humano';
    state.conversations[id].atendimento_humano = true;
    if (io) io.emit('conversation_updated', state.conversations[id]);
    console.log(`👤 Humano assumiu: ${state.conversations[id].cliente || id}`);
  }
  res.json({ success: true });
});

// Devolver conversa ao bot
app.post('/api/conversation/:id/return-to-bot', (req, res) => {
  const { id } = req.params;
  if (state.conversations[id]) {
    state.conversations[id].status = 'bot_ativo';
    if (io) io.emit('conversation_updated', state.conversations[id]);
    console.log(`🤖 Bot retomou: ${state.conversations[id].cliente || id}`);
  }
  res.json({ success: true });
});

// Encerrar conversa
app.post('/api/conversation/:id/close', (req, res) => {
  const { id } = req.params;
  if (state.conversations[id]) {
    state.conversations[id].status = 'encerrada';
    state.conversations[id].data_fim = new Date().toISOString();
    if (io) io.emit('conversation_updated', state.conversations[id]);
    _saveConversation(id);
  }
  res.json({ success: true });
});

// Reiniciar conversa (apaga histórico e estado, próxima mensagem = boas-vindas)
app.post('/api/conversation/:id/restart', (req, res) => {
  const { id } = req.params;
  const numero = id; // mantém o número/id para continuar rastreando
  const nome = state.conversations[id]?.cliente || null; // log amigável

  state.conversations[id] = {
    id,
    numero,
    cliente: null,
    bairro: null,
    data_inicio: new Date().toISOString(),
    data_fim: null,
    status: 'bot_ativo',
    lastActivity: Date.now(),
    mensagens: [],
    informacoes_coletadas: {
      nome: null, bairro: null, tipo_imovel: null,
      problema_principal: null, pelicula_indicada: null,
      quantidade_janelas: null, janelas: [],
      pelicula_desejada: null, fotos_recebidas: false
    },
    _boas_vindas_enviado: false,
    video_enviado: false,
    resumo_enviado: false,
    fora_horario_notificado: false,
    atendimento_humano: false,
    converteu: null,
    resultado: null
  };

  if (io) io.emit('conversation_updated', state.conversations[id]);
  console.log(`🔄 Conversa reiniciada pelo painel: ${nome || id}`);
  res.json({ success: true });
});

// Marcar resultado (converteu ou não)
app.post('/api/conversation/:id/result', (req, res) => {
  const { id } = req.params;
  const { converteu } = req.body;
  if (state.conversations[id]) {
    state.conversations[id].converteu = converteu;
    state.conversations[id].resultado = converteu ? 'virou_cliente' : 'nao_fechou';
    state.conversations[id].data_fim = state.conversations[id].data_fim || new Date().toISOString();
    if (io) io.emit('conversation_updated', state.conversations[id]);
    _saveConversation(id);
    console.log(`📊 ${state.conversations[id].cliente || id}: ${converteu ? '✅ Virou cliente' : '❌ Não fechou'}`);

    // Se converteu: salvar como exemplo de sucesso para few-shot learning
    if (converteu) {
      _saveExemploSucesso(state.conversations[id]);
    }
  }
  res.json({ success: true });
});

// Listar exemplos de sucesso salvos
app.get('/api/exemplos', (req, res) => {
  try {
    const arquivo = path.join(__dirname, 'exemplos_sucesso.json');
    const exemplos = fs.existsSync(arquivo) ? fs.readJsonSync(arquivo) : [];
    res.json({ total: exemplos.length, exemplos });
  } catch (e) {
    res.json({ total: 0, exemplos: [] });
  }
});

// Remover um exemplo de sucesso
app.delete('/api/exemplos/:index', (req, res) => {
  try {
    const arquivo = path.join(__dirname, 'exemplos_sucesso.json');
    const exemplos = fs.existsSync(arquivo) ? fs.readJsonSync(arquivo) : [];
    const idx = parseInt(req.params.index);
    if (idx >= 0 && idx < exemplos.length) {
      exemplos.splice(idx, 1);
      fs.writeJsonSync(arquivo, exemplos, { spaces: 2 });
      if (io) io.emit('exemplos_updated', { total: exemplos.length });
    }
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

// Salvar configurações
app.post('/api/settings', (req, res) => {
  const { horario_inicio, horario_fim, delay_min, delay_max } = req.body;

  if (horario_inicio) state.settings.horario_inicio = horario_inicio;
  if (horario_fim) state.settings.horario_fim = horario_fim;
  if (delay_min) state.settings.delay_min = parseInt(delay_min);
  if (delay_max) state.settings.delay_max = parseInt(delay_max);

  // Gravar no .env
  try {
    const envPath = path.join(__dirname, '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');
    if (horario_inicio) envContent = envContent.replace(/HORARIO_INICIO=.*/m, `HORARIO_INICIO=${horario_inicio}`);
    if (horario_fim) envContent = envContent.replace(/HORARIO_FIM=.*/m, `HORARIO_FIM=${horario_fim}`);
    if (delay_min) envContent = envContent.replace(/DELAY_MIN=.*/m, `DELAY_MIN=${delay_min}`);
    if (delay_max) envContent = envContent.replace(/DELAY_MAX=.*/m, `DELAY_MAX=${delay_max}`);
    fs.writeFileSync(envPath, envContent);
  } catch (e) {
    console.warn('Aviso: não foi possível salvar as configurações no .env:', e.message);
  }

  if (io) io.emit('settings_updated', state.settings);
  res.json({ success: true, settings: state.settings });
});

// ─── FUNÇÕES HELPER EXPORTADAS PARA O BOT ────────────────────────────────────

function addToLog(entry) {
  const logEntry = {
    ...entry,
    id: Date.now(),
    timestamp: entry.timestamp || new Date().toISOString()
  };
  state.messageLog.unshift(logEntry);
  if (state.messageLog.length > 300) state.messageLog = state.messageLog.slice(0, 300);
  if (io) io.emit('new_log_entry', logEntry);
}

function updateConversation(id, updates) {
  if (!state.conversations[id]) {
    state.conversations[id] = {
      id,
      numero: id,
      cliente: null,
      bairro: null,
      data_inicio: new Date().toISOString(),
      data_fim: null,
      status: 'bot_ativo',
      lastActivity: Date.now(),
      mensagens: [],
      informacoes_coletadas: {
        nome: null,
        bairro: null,
        tipo_imovel: null,
        problema_principal: null,
        pelicula_indicada: null,
        quantidade_janelas: null,
        janelas: [],
        pelicula_desejada: null,
        fotos_recebidas: false
      },
      video_enviado: false,
      resumo_enviado: false,
      fora_horario_notificado: false,
      atendimento_humano: false,
      converteu: null,
      resultado: null
    };
  }
  state.conversations[id] = { ...state.conversations[id], ...updates };
  if (io) io.emit('conversation_updated', state.conversations[id]);
  _saveConversation(id);
}

function incrementMessageCount() {
  const now = Date.now();
  if (now > state.messageCountResetTime) {
    state.messageCount24h = 1;
    state.messageCountResetTime = now + 86400000;
  } else {
    state.messageCount24h++;
  }
  if (io) io.emit('message_count_update', state.messageCount24h);

  if (state.messageCount24h === 150) {
    if (io) io.emit('alert', {
      type: 'warning',
      message: '⚠️ Atenção: 150 mensagens enviadas em 24h. Monitore para evitar bloqueio.'
    });
  }
  if (state.messageCount24h >= 200) {
    if (io) io.emit('alert', {
      type: 'danger',
      message: `🚨 ALERTA: ${state.messageCount24h} mensagens em 24h! Alto risco de bloqueio pelo WhatsApp.`
    });
  }
}

// ─── FUNÇÃO INTERNA: SALVAR CONVERSA EM JSON ──────────────────────────────────
function _saveConversation(id) {
  const conv = state.conversations[id];
  if (!conv) return;

  try {
    const dir = path.join(__dirname, 'conversas');
    fs.ensureDirSync(dir);

    const safeDate = (conv.data_inicio || new Date().toISOString())
      .replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
    const filename = `${id}_${safeDate}.json`;
    const filepath = path.join(dir, filename);

    const dataToSave = {
      id: conv.id,
      numero: conv.numero,
      data_inicio: conv.data_inicio,
      data_fim: conv.data_fim,
      cliente: conv.cliente,
      bairro: conv.bairro,
      mensagens: conv.mensagens || [],
      informacoes_coletadas: conv.informacoes_coletadas || {},
      tempo_total_minutos: conv.data_fim
        ? Math.round((new Date(conv.data_fim) - new Date(conv.data_inicio)) / 60000)
        : null,
      atendimento_humano: conv.atendimento_humano || false,
      resultado: conv.resultado || null,
      converteu: conv.converteu || null
    };

    fs.writeJsonSync(filepath, dataToSave, { spaces: 2 });
  } catch (e) {
    // Silently ignore - não crítico
  }
}

// ─── FUNÇÃO INTERNA: SALVAR EXEMPLO DE SUCESSO ────────────────────────────────
// Quando uma conversa é marcada como convertida, extrai os trechos mais relevantes
// (apenas mensagens de texto cliente↔bot) e salva para uso como few-shot no prompt.
function _saveExemploSucesso(conv) {
  try {
    const arquivo = path.join(__dirname, 'exemplos_sucesso.json');
    const exemplos = fs.existsSync(arquivo) ? fs.readJsonSync(arquivo) : [];

    // Filtrar apenas mensagens de texto (ignorar mídia) e limitar a 30 mensagens
    const mensagens = (conv.mensagens || [])
      .filter(m => m.tipo === 'texto' || !m.tipo)
      .slice(0, 30)
      .map(m => ({
        de: m.de,
        texto: (m.conteudo || '').substring(0, 400) // truncar textos muito longos
      }));

    if (mensagens.length < 4) return; // muito curto para ser útil

    const exemplo = {
      id: Date.now(),
      data: new Date().toISOString(),
      cliente: conv.cliente || 'Anônimo',
      bairro: conv.bairro || '',
      info_coletadas: conv.informacoes_coletadas || {},
      mensagens
    };

    // Manter no máximo 20 exemplos (os mais recentes)
    exemplos.unshift(exemplo);
    if (exemplos.length > 20) exemplos.splice(20);

    fs.writeJsonSync(arquivo, exemplos, { spaces: 2 });
    console.log(`📚 Exemplo de sucesso salvo: ${conv.cliente || conv.id} (total: ${exemplos.length})`);
    if (io) io.emit('exemplos_updated', { total: exemplos.length });
  } catch (e) {
    console.warn('⚠️ Não foi possível salvar exemplo de sucesso:', e.message);
  }
}

// ─── RESET CONTADOR 24H ───────────────────────────────────────────────────────
setInterval(() => {
  if (Date.now() > state.messageCountResetTime) {
    state.messageCount24h = 0;
    state.messageCountResetTime = Date.now() + 86400000;
    if (io) io.emit('message_count_update', 0);
  }
}, 60000);

// ─── INICIAR SERVIDOR ─────────────────────────────────────────────────────────
async function startServer() {
  io = new Server(httpServer);

  io.on('connection', (socket) => {
    // Enviar estado inicial para cliente recém-conectado
    socket.emit('initial_state', {
      connected: state.connected,
      connectedNumber: state.connectedNumber,
      globalBotActive: state.globalBotActive,
      conversations: Object.values(state.conversations),
      messageLog: state.messageLog.slice(0, 100),
      messageCount24h: state.messageCount24h,
      settings: state.settings
    });
  });

  const port = process.env.PORT || 3000;

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      console.log(`✅ Painel disponível em http://localhost:${port}`);
      resolve({ io, state });
    });
  });
}

// ─── CARREGAR EXEMPLOS DE SUCESSO (para few-shot no prompt) ──────────────────
function loadExemplosSucesso(max = 3) {
  try {
    const arquivo = path.join(__dirname, 'exemplos_sucesso.json');
    if (!fs.existsSync(arquivo)) return [];
    const todos = fs.readJsonSync(arquivo);
    // Retorna os 'max' exemplos mais recentes com mensagens suficientes
    return todos.slice(0, max);
  } catch (e) {
    return [];
  }
}

module.exports = {
  startServer,
  state,
  addToLog,
  updateConversation,
  incrementMessageCount,
  loadExemplosSucesso
};
