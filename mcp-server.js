#!/usr/bin/env node

/**
 * Skvil-Piertotum MCP Server
 *
 * Servidor MCP (stdio) que cada instância do Claude Code roda.
 * Conecta ao Broker HTTP central e expõe ferramentas de comunicação.
 *
 * Variáveis de ambiente:
 *   BROKER_URL        — URL do broker (ex: http://192.168.1.10:4800)
 *   AGENT_ID          — ID único deste agente (ex: "api", "front", "mobile")
 *   AGENT_NAME        — Nome legível (ex: "Projeto API")
 *   PROJECT_NAME      — Nome do projeto (ex: "meu-saas")
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import os from 'os';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version; }
  catch { return '0.0.0'; }
})();

// ══════════════════════════════════════════════
// Validação de configuração na inicialização
// ══════════════════════════════════════════════

function validateBrokerUrl(raw) {
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      process.stderr.write(`[ERRO] BROKER_URL com protocolo inválido: "${parsed.protocol}". Use http:// ou https://\n`);
      process.exit(1);
    }
    return raw;
  } catch {
    process.stderr.write(`[ERRO] BROKER_URL inválida: "${raw}". Exemplo: http://localhost:4800\n`);
    process.exit(1);
  }
}

const BROKER_URL   = validateBrokerUrl(process.env.BROKER_URL || 'http://localhost:4800').replace(/\/+$/, '');
const AGENT_ID     = (process.env.AGENT_ID || os.hostname()).toLowerCase().replace(/[^a-z0-9-]/g, '-');
const AGENT_NAME   = process.env.AGENT_NAME || `SP-${AGENT_ID}`;
const PROJECT_NAME = process.env.PROJECT_NAME || 'unknown';

const FETCH_TIMEOUT_MS = 5000;

// ══════════════════════════════════════════════
// Helpers de formatação
// ══════════════════════════════════════════════

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatLastSeen(lastSeenIso) {
  if (!lastSeenIso) return 'desconhecido';
  const diffMs = Date.now() - new Date(lastSeenIso).getTime();
  const diffS  = Math.max(0, Math.floor(diffMs / 1000));
  if (diffS < 60) return `há ${diffS}s`;
  const diffM  = Math.floor(diffS / 60);
  if (diffM < 60) return `há ${diffM}min`;
  return `há ${Math.floor(diffM / 60)}h`;
}

// ══════════════════════════════════════════════
// Helper: chamadas HTTP ao broker
// ══════════════════════════════════════════════

async function brokerFetch(path, options = {}) {
  const url = `${BROKER_URL}${path}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    if (!res.ok) {
      // Tenta extrair mensagem de erro do body JSON, sem falhar se não for JSON
      let body;
      try { body = await res.json(); } catch { body = {}; }
      return { error: body.error || `HTTP ${res.status} ${res.statusText}` };
    }
    try {
      return await res.json();
    } catch {
      return { error: `Resposta inválida do broker (não é JSON) em ${path}` };
    }
  } catch (err) {
    if (err.name === 'TimeoutError') {
      return { error: `Broker não respondeu em ${FETCH_TIMEOUT_MS / 1000}s` };
    }
    return { error: `Falha ao conectar ao broker: ${err.message}` };
  }
}

async function brokerPost(path, body) {
  return brokerFetch(path, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

// ══════════════════════════════════════════════
// Helper: atualiza status deste agente no broker
// ══════════════════════════════════════════════

async function setStatus(value) {
  const result = await brokerPost('/context', {
    key: `${AGENT_ID}-status`,
    value,
    setBy: AGENT_ID
  });
  if (result.error) {
    process.stderr.write(`⚠️  setStatus falhou: ${result.error}\n`);
  }
}

// ══════════════════════════════════════════════
// Helper: registro no broker (reutilizado no heartbeat)
// ══════════════════════════════════════════════

async function register() {
  return brokerPost('/agents/register', {
    agentId: AGENT_ID,
    name: AGENT_NAME,
    project: PROJECT_NAME,
    path: process.cwd()
  });
}

// ══════════════════════════════════════════════
// Inicializar MCP Server
// ══════════════════════════════════════════════

const server = new McpServer({
  name: 'skvil-piertotum',
  version: PKG_VERSION,
  description: 'Comunicação entre instâncias do Claude Code via broker central'
});

// ══════════════════════════════════════════════
// Tool: registrar este agente no broker
// ══════════════════════════════════════════════

server.tool(
  'sp_register',
  'Re-registra este terminal no broker caso a conexão tenha sido perdida. O registro automático já ocorre ao iniciar.',
  {},
  async () => {
    const result = await register();
    return {
      content: [{
        type: 'text',
        text: result.error
          ? `❌ Erro ao registrar: ${result.error}`
          : `✅ Registrado como "${AGENT_NAME}" (ID: ${AGENT_ID}). Total de agentes: ${result.totalAgents}`
      }]
    };
  }
);

// ══════════════════════════════════════════════
// Tool: listar agentes conectados
// ══════════════════════════════════════════════

server.tool(
  'sp_list_agents',
  'Lista todos os agentes/terminais conectados ao broker',
  {},
  async () => {
    const result = await brokerFetch('/agents');
    if (result.error) {
      return { content: [{ type: 'text', text: `❌ ${result.error}` }] };
    }

    if (!result.agents) {
      return { content: [{ type: 'text', text: '⚠️  Resposta inesperada do broker' }] };
    }
    if (result.agents.length === 0) {
      return { content: [{ type: 'text', text: '📭 Nenhum agente registrado.' }] };
    }

    const lines = result.agents.map(a => {
      const lastSeen = formatLastSeen(a.lastSeen);
      const diffMs   = a.lastSeen ? Date.now() - new Date(a.lastSeen).getTime() : 0;
      const stale    = diffMs > 60_000 ? ' ⚠️ sem sinal' : '';
      return `• ${a.name} (${a.agentId}) — projeto: ${a.project} — último sinal: ${lastSeen}${stale}`;
    });

    return {
      content: [{
        type: 'text',
        text: `🤖 Agentes conectados (${result.agents.length}):\n\n${lines.join('\n')}`
      }]
    };
  }
);

// ══════════════════════════════════════════════
// Tool: enviar mensagem para outro agente
// ══════════════════════════════════════════════

server.tool(
  'sp_send',
  'Envia uma mensagem para outro agente/terminal do Claude Code. Use o agentId exato (ex: "api", "front") — use sp_list_agents se não souber o ID. O campo type orienta o receptor: "text" para conversas, "code" para trechos de código, "schema" para estruturas de dados, "endpoint" para contratos de API, "config" para configurações.',
  {
    to: z.string().describe('ID exato do agente destino — use sp_list_agents para ver os IDs disponíveis'),
    content: z.string().describe('Conteúdo da mensagem'),
    type: z.enum(['text', 'code', 'schema', 'endpoint', 'config']).optional().describe('Tipo da mensagem (padrão: "text")')
  },
  async ({ to, content, type }) => {
    const result = await brokerPost('/messages/send', {
      from: AGENT_ID,
      to,
      content,
      type: type || 'text'
    });

    return {
      content: [{
        type: 'text',
        text: result.error
          ? `❌ Erro: ${result.error}${result.error.includes('404') || result.error.includes('não encontrado') ? ' — use sp_list_agents para ver os IDs disponíveis' : ''}`
          : `✅ Mensagem enviada para "${to}" (ID: ${result.messageId})`
      }]
    };
  }
);

// ══════════════════════════════════════════════
// Tool: broadcast para todos os agentes
// ══════════════════════════════════════════════

server.tool(
  'sp_broadcast',
  'Envia mensagem para TODOS os agentes conectados (exceto este). Se sentTo=0, nenhum outro agente está registrado — use sp_list_agents para confirmar.',
  {
    content: z.string().describe('Conteúdo da mensagem para todos'),
    type: z.enum(['text', 'code', 'schema', 'endpoint', 'config']).optional().describe('Tipo da mensagem')
  },
  async ({ content, type }) => {
    const result = await brokerPost('/messages/broadcast', {
      from: AGENT_ID,
      content,
      type: type || 'text'
    });

    return {
      content: [{
        type: 'text',
        text: result.error
          ? `❌ Erro: ${result.error}`
          : result.sentTo === 0
            ? `⚠️  Broadcast enviado mas nenhum outro agente está registrado (sentTo=0)`
            : `📢 Broadcast enviado para ${result.sentTo} agente(s)`
      }]
    };
  }
);

// ══════════════════════════════════════════════
// Tool: ler mensagens recebidas
// ══════════════════════════════════════════════

server.tool(
  'sp_read',
  'Lê mensagens recebidas de outros agentes e marca as exibidas como lidas (ACK). Use limit para controlar quantas mensagens buscar de uma vez (padrão: 20, máx: 50). Se hasMore=true, chame novamente para ver mais.',
  {
    unreadOnly: z.boolean().optional().describe('Se true, mostra apenas mensagens não lidas (padrão: true)'),
    limit: z.number().int().min(1).max(50).optional().describe('Máximo de mensagens a retornar (padrão: 20, máx: 50)')
  },
  async ({ unreadOnly, limit }) => {
    const showUnreadOnly = unreadOnly !== false; // padrão true
    const effectiveLimit = Math.min(limit || 20, 50);
    const query = `?unread=${showUnreadOnly}&limit=${effectiveLimit}`;
    const result = await brokerFetch(`/messages/${AGENT_ID}${query}`);

    if (result.error) {
      return { content: [{ type: 'text', text: `❌ ${result.error}` }] };
    }

    if (result.messages.length === 0) {
      return { content: [{ type: 'text', text: '📭 Nenhuma mensagem.' }] };
    }

    // Marca as mensagens lidas explicitamente (ACK)
    const ids = result.messages.map(m => m.id).filter(Boolean);
    if (ids.length > 0) {
      const ackResult = await brokerPost(`/messages/${AGENT_ID}/ack`, { ids });
      if (ackResult.error) {
        process.stderr.write(`⚠️  ACK falhou: ${ackResult.error}\n`);
      }
    }

    const lines = result.messages.map(m =>
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📨 De: ${m.fromName} (${m.from})\n🕐 ${m.timestamp}\n📎 Tipo: ${m.type}\n🔑 ID: ${m.id}\n\n${m.content}`
    );

    const hasMoreNote = result.hasMore ? '\n\n⚠️  Há mais mensagens — chame sp_read novamente para ver.' : '';

    return {
      content: [{
        type: 'text',
        text: `📬 ${result.messages.length} mensagem(ns)${result.hasMore ? ' — há mais' : ''}:\n\n${lines.join('\n\n')}${hasMoreNote}`
      }]
    };
  }
);

// ══════════════════════════════════════════════
// Tool: salvar contexto compartilhado
// ══════════════════════════════════════════════

server.tool(
  'sp_set_context',
  'Salva um dado compartilhado no broker (ex: schema, endpoints, config) para que outros agentes possam ler via sp_get_context. O valor é sempre string — para objetos, use JSON.stringify() antes de salvar e JSON.parse() ao ler.',
  {
    key: z.string().describe('Chave identificadora (ex: "api-endpoints", "db-schema", "env-vars")'),
    value: z.string().describe('Conteúdo a ser compartilhado (string; para objetos use JSON.stringify)')
  },
  async ({ key, value }) => {
    const result = await brokerPost('/context', {
      key,
      value,
      setBy: AGENT_ID
    });

    return {
      content: [{
        type: 'text',
        text: result.error
          ? `❌ Erro: ${result.error}`
          : `📦 Contexto "${key}" salvo com sucesso`
      }]
    };
  }
);

// ══════════════════════════════════════════════
// Tool: ler contexto compartilhado
// ══════════════════════════════════════════════

server.tool(
  'sp_get_context',
  'Lê um dado compartilhado salvo por qualquer agente',
  {
    key: z.string().describe('Chave do contexto a ler (ex: "api-endpoints")')
  },
  async ({ key }) => {
    const result = await brokerFetch(`/context/${encodeURIComponent(key)}`);

    if (result.error) {
      return { content: [{ type: 'text', text: `❌ ${result.error}` }] };
    }

    return {
      content: [{
        type: 'text',
        text: `📦 Contexto: ${key}\nSalvo por: ${result.setByName || result.setBy}\nAtualizado: ${result.timestamp}\n\n${result.value}`
      }]
    };
  }
);

// ══════════════════════════════════════════════
// Tool: listar todos os contextos
// ══════════════════════════════════════════════

server.tool(
  'sp_list_contexts',
  'Lista todas as chaves de contexto compartilhado disponíveis',
  {},
  async () => {
    const result = await brokerFetch('/context');

    if (result.error) {
      return { content: [{ type: 'text', text: `❌ ${result.error}` }] };
    }

    if (!result.contexts) {
      return { content: [{ type: 'text', text: '⚠️  Resposta inesperada do broker' }] };
    }
    if (result.contexts.length === 0) {
      return { content: [{ type: 'text', text: '📭 Nenhum contexto compartilhado.' }] };
    }

    const lines = result.contexts.map(c =>
      `• "${c.key}" — por ${c.setBy} em ${c.timestamp}`
    );

    return {
      content: [{
        type: 'text',
        text: `📦 Contextos compartilhados (${result.contexts.length}):\n\n${lines.join('\n')}`
      }]
    };
  }
);

// ══════════════════════════════════════════════
// Tool: limpar mensagens recebidas
// ══════════════════════════════════════════════

server.tool(
  'sp_clear',
  'Limpa todas as mensagens recebidas (lidas e não lidas)',
  {},
  async () => {
    const result = await brokerFetch(`/messages/${AGENT_ID}`, { method: 'DELETE' });
    return {
      content: [{
        type: 'text',
        text: result.error
          ? `❌ Erro: ${result.error}`
          : `🗑️ ${result.cleared} mensagem(ns) removida(s)`
      }]
    };
  }
);

// ══════════════════════════════════════════════
// Tool: status geral do broker
// ══════════════════════════════════════════════

server.tool(
  'sp_status',
  'Mostra o status geral do broker: agentes conectados, mensagens pendentes, etc.',
  {},
  async () => {
    const result = await brokerFetch('/status');

    if (result.error) {
      return { content: [{ type: 'text', text: `❌ ${result.error}` }] };
    }

    const agentLines = (result.agents || []).map(a =>
      `  • ${a.name} (${a.agentId}) — ${a.project} — ${a.unreadMessages} msgs não lidas`
    );

    return {
      content: [{
        type: 'text',
        text: [
          `🏠 Skvil-Piertotum Broker`,
          `Uptime: ${formatUptime(result.uptime)}`,
          `Agentes: ${result.totalAgents}`,
          `Contextos compartilhados: ${result.totalContextKeys}`,
          '',
          agentLines.length > 0 ? agentLines.join('\n') : '  Nenhum agente conectado'
        ].join('\n')
      }]
    };
  }
);

// ══════════════════════════════════════════════
// Deregistro gracioso ao encerrar
// ══════════════════════════════════════════════

async function deregister() {
  try {
    await fetch(`${BROKER_URL}/agents/${AGENT_ID}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3000)
    });
  } catch {
    // Ignorar — broker pode já estar offline
  }
}

// ══════════════════════════════════════════════
// Auto-registrar ao iniciar e conectar
// ══════════════════════════════════════════════

async function main() {
  // Registra automaticamente ao iniciar
  const regResult = await register();

  if (regResult.error) {
    process.stderr.write(`⚠️  Aviso: não foi possível registrar no broker — ${regResult.error}\n`);
    process.stderr.write(`   As ferramentas sp_* vão falhar até o broker estar acessível.\n`);
  }

  // Heartbeat a cada 30s — re-registra automaticamente se o broker reiniciar
  const heartbeatTimer = setInterval(async () => {
    const hb = await brokerFetch(`/agents/${AGENT_ID}/heartbeat`, { method: 'POST' });
    if (hb.error) {
      const notRegistered = hb.error.includes('HTTP 404');
      if (notRegistered) {
        // Broker reiniciou e perdeu o estado — re-registrar automaticamente
        process.stderr.write(`⚠️  Heartbeat: agente não reconhecido pelo broker, re-registrando...\n`);
        const reg = await register();
        if (!reg.error) {
          process.stderr.write(`✅ Re-registro bem-sucedido.\n`);
        } else {
          process.stderr.write(`⚠️  Re-registro falhou: ${reg.error}\n`);
        }
      } else {
        process.stderr.write(`⚠️  Heartbeat falhou: ${hb.error}\n`);
      }
    }
  }, 30000);

  // Shutdown gracioso
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeatTimer);

    await setStatus('offline');
    await deregister();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Inicia o transporte stdio para MCP
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`Erro fatal: ${err.message}\n`);
  process.exit(1);
});
