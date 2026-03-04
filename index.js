require('dotenv').config();
const { startServer } = require('./server');
const { startBot } = require('./bot');

async function main() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║     🎬  Películas Brasil - Chatbot v1.0      ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'sua_chave_aqui') {
    console.error('❌ ERRO: Chave da Groq não configurada!');
    console.error('   Abra o arquivo .env e adicione sua GROQ_API_KEY');
    console.error('   Obtenha sua chave gratuitamente em: https://console.groq.com/keys\n');
    process.exit(1);
  }

  if (!process.env.OWNER_NUMBER || process.env.OWNER_NUMBER.includes('X')) {
    console.warn('⚠️  AVISO: Número do dono não configurado no .env');
    console.warn('   Resumos de orçamento não serão enviados automaticamente\n');
  }

  const { io } = await startServer();
  await startBot(io);
}

main().catch(err => {
  console.error('\n❌ Erro fatal ao iniciar:', err.message);
  console.error(err.stack);
  console.error('\nVerifique o arquivo .env e tente novamente.');
  process.exit(1);
});
