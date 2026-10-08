/* ---------------------------------------------------------
   Caderno de Turma - servidor
   Guarda tudo (cadastros de professores e alunos, turmas,
   redações/ENEM, simulados, presenças, chat...) no MongoDB.

   - Se existir MONGODB_URI (arquivo .env), usa o MongoDB.
   - Se NÃO existir, guarda em dados/armazenamento.json
     (modo de emergência, sem MongoDB).
--------------------------------------------------------- */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------- lê o arquivo .env (se existir) ----------
const arquivoEnv = path.join(__dirname, ".env");
if (fs.existsSync(arquivoEnv)) {
  for (const linha of fs.readFileSync(arquivoEnv, "utf-8").split(/\r?\n/)) {
    if (linha.trim().startsWith("#")) continue;
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "caderno_de_turma";
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
async function testarChaveGemini() {
  if (!GEMINI_API_KEY) return { temChave: false };
  const info = { temChave: true, inicio: GEMINI_API_KEY.slice(0, 4), tamanho: GEMINI_API_KEY.length };
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": GEMINI_API_KEY } });
    const d = await r.json().catch(() => ({}));
    info.status = r.status;
    info.ok = r.ok;
    if (!r.ok) info.mensagem = (d.error && d.error.message) || ("Erro " + r.status);
  } catch (e) {
    info.ok = false;
    info.mensagem = "Sem conexão com o Google: " + e.message;
  }
  return info;
}
const PASTA_DADOS = path.join(__dirname, "dados");
const ARQUIVO = path.join(PASTA_DADOS, "armazenamento.json");
const PASTA_PUBLICA = path.join(__dirname, "public");
const LIMITE_BYTES = 60 * 1024 * 1024;

// ---------- armazenamento em arquivo (modo sem MongoDB) ----------
function criarArmazenamentoArquivo() {
  fs.mkdirSync(PASTA_DADOS, { recursive: true });
  let dados = {};
  if (fs.existsSync(ARQUIVO)) {
    try { dados = JSON.parse(fs.readFileSync(ARQUIVO, "utf-8")); }
    catch (e) {
      const copia = ARQUIVO.replace(".json", `-corrompido-${Date.now()}.json`);
      fs.copyFileSync(ARQUIVO, copia);
      console.error("O arquivo de dados estava corrompido. Cópia salva em:", copia);
    }
  }
  let fila = Promise.resolve();
  return {
    descricao: `arquivo ${ARQUIVO}`,
    dados,
    async ler(chave) { return Object.prototype.hasOwnProperty.call(dados, chave) ? dados[chave] : null; },
    async gravar(chave, valor) {
      dados[chave] = valor;
      fila = fila.then(async () => {
        const temp = ARQUIVO + ".tmp";
        await fs.promises.writeFile(temp, JSON.stringify(dados), "utf-8");
        await fs.promises.rename(temp, ARQUIVO);
        const backup = path.join(PASTA_DADOS, `backup-${new Date().toISOString().slice(0, 10)}.json`);
        if (!fs.existsSync(backup)) await fs.promises.copyFile(ARQUIVO, backup);
      });
      return fila;
    }
  };
}

// ---------- armazenamento no MongoDB ----------
async function criarArmazenamentoMongo() {
  let MongoClient;
  try { ({ MongoClient } = require("mongodb")); }
  catch (e) {
    console.error('\nFalta instalar o driver do MongoDB. Rode uma vez:  npm install\n');
    process.exit(1);
  }
  const cliente = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try { await cliente.connect(); }
  catch (e) {
    console.error("\nNão consegui conectar ao MongoDB:", e.message);
    console.error("Confira o MONGODB_URI no arquivo .env e se o MongoDB está ligado.\n");
    process.exit(1);
  }
  const colecao = cliente.db(MONGODB_DB).collection("armazenamento");
  await colecao.createIndex({ chave: 1 }, { unique: true });

  // Se já existiam dados no arquivo (versão anterior), importa o que ainda não está no MongoDB
  if (fs.existsSync(ARQUIVO)) {
    try {
      const antigos = JSON.parse(fs.readFileSync(ARQUIVO, "utf-8"));
      let importados = 0;
      for (const [chave, valor] of Object.entries(antigos)) {
        const r = await colecao.updateOne({ chave }, { $setOnInsert: { valor, atualizadoEm: new Date() } }, { upsert: true });
        if (r.upsertedCount) importados++;
      }
      if (importados) console.log(`  Importei ${importados} item(ns) do arquivo antigo para o MongoDB.`);
    } catch (e) { console.error("Aviso: não consegui importar o arquivo antigo:", e.message); }
  }
  return {
    descricao: `MongoDB (banco "${MONGODB_DB}", coleção "armazenamento")`,
    async ler(chave) { const d = await colecao.findOne({ chave }); return d ? d.valor : null; },
    async gravar(chave, valor) { await colecao.updateOne({ chave }, { $set: { valor, atualizadoEm: new Date() } }, { upsert: true }); }
  };
}

// ---------- servidor web ----------
const TIPOS = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp"
};
function responder(res, status, corpo, tipo) {
  res.writeHead(status, { "Content-Type": tipo || "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(typeof corpo === "string" || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo));
}
function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = []; let total = 0;
    req.on("data", (p) => {
      total += p.length;
      if (total > LIMITE_BYTES) { reject(new Error("grande demais")); req.destroy(); return; }
      partes.push(p);
    });
    req.on("end", () => resolve(Buffer.concat(partes).toString("utf-8")));
    req.on("error", reject);
  });
}

// Permite que a página aberta direto do arquivo (index.html) converse com este servidor
function origemPermitida(o) {
  return o === "null" || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o || "");
}
function enderecosDaRede() {
  const lista = [];
  for (const itens of Object.values(os.networkInterfaces()))
    for (const i of itens || [])
      if (i.family === "IPv4" && !i.internal) lista.push(`http://${i.address}:${PORT}`);
  return lista;
}

function criarServidor(arm) {
  return http.createServer(async (req, res) => {
    try {
      const origem = req.headers.origin;
      if (origemPermitida(origem)) {
        res.setHeader("Access-Control-Allow-Origin", origem);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        if (req.headers["access-control-request-private-network"]) res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
      const url = new URL(req.url, "http://localhost");
      const m = url.pathname.match(/^\/api\/armazenamento\/(.+)$/);
      if (m) {
        const chave = decodeURIComponent(m[1]);
        if (req.method === "GET") {
          const valor = await arm.ler(chave);
          if (valor === null) return responder(res, 404, { erro: "não encontrado" });
          return responder(res, 200, { chave, valor });
        }
        if (req.method === "PUT") {
          let corpo;
          try { corpo = JSON.parse(await lerCorpo(req)); } catch (e) { return responder(res, 400, { erro: "pedido inválido" }); }
          if (!corpo || typeof corpo.valor !== "string") return responder(res, 400, { erro: "campo 'valor' deve ser texto" });
          await arm.gravar(chave, corpo.valor);
          return responder(res, 200, { ok: true });
        }
        return responder(res, 405, { erro: "método não permitido" });
      }
      if (url.pathname === "/api/ia/diagnostico") return responder(res, 200, await testarChaveGemini());
      // ---------- IA (Gemini): a chave fica aqui no servidor, nunca na página ----------
      if (url.pathname === "/api/ia") {
        if (req.method !== "POST") return responder(res, 405, { erro: "método não permitido" });
        if (!GEMINI_API_KEY) return responder(res, 503, { erro: "sem_chave" });
        let pedido;
        try { pedido = JSON.parse(await lerCorpo(req)); } catch (e) { return responder(res, 400, { erro: "pedido inválido" }); }
        const caminho = String((pedido && pedido.caminho) || "");
        if (!/^models(\/[A-Za-z0-9._-]+:generateContent)?$/.test(caminho)) return responder(res, 400, { erro: "caminho inválido" });
        try {
          const ehLista = caminho === "models";
          const alvo = "https://generativelanguage.googleapis.com/v1beta/" + caminho + (ehLista ? "?pageSize=200" : "");
          const r = await fetch(alvo, {
            method: ehLista ? "GET" : "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
            body: ehLista ? undefined : JSON.stringify(pedido.corpo || {})
          });
          const dados = await r.json().catch(() => ({}));
          return responder(res, 200, { status: r.status, dados });
        } catch (e) {
          console.error("Erro ao falar com o Google (IA):", e.message);
          return responder(res, 502, { erro: "Este computador não conseguiu falar com o Google: " + e.message });
        }
      }
      if (url.pathname === "/api/saude") return responder(res, 200, { ok: true });
      if (url.pathname === "/api/rede") return responder(res, 200, { enderecos: enderecosDaRede() });

      let caminho = decodeURIComponent(url.pathname);
      if (caminho === "/") caminho = "/index.html";
      const completo = path.normalize(path.join(PASTA_PUBLICA, caminho));
      if (!completo.startsWith(PASTA_PUBLICA)) return responder(res, 403, "Acesso negado", "text/plain; charset=utf-8");
      fs.readFile(completo, (erro, conteudo) => {
        if (erro) return responder(res, 404, "Página não encontrada", "text/plain; charset=utf-8");
        responder(res, 200, conteudo, TIPOS[path.extname(completo).toLowerCase()] || "application/octet-stream");
      });
    } catch (e) {
      console.error("Erro:", e);
      responder(res, 500, { erro: "falha ao acessar o banco de dados" });
    }
  });
}

(async () => {
  console.log("Iniciando o Caderno de Turma...");
  const arm = MONGODB_URI ? await criarArmazenamentoMongo() : criarArmazenamentoArquivo();
  if (!MONGODB_URI) console.log("  AVISO: MONGODB_URI não definido. Usando arquivo (sem MongoDB).");
  if (!GEMINI_API_KEY) console.log("  AVISO: GEMINI_API_KEY não definido no .env. A IA (redação e questões) só funciona com a chave configurada.");
  testarChaveGemini().then((r) => {
    if (!r.temChave) return;
    if (r.ok) console.log("  Chave do Gemini: OK (aceita pelo Google).");
    else {
      console.log("  Chave do Gemini: PROBLEMA -> " + r.mensagem);
      console.log(`  (a chave lida do .env começa com "${r.inicio}" e tem ${r.tamanho} caracteres; chaves do AI Studio começam com "AIza" ou "AQ." — confira se copiou a chave inteira)`);
    }
  });
  criarServidor(arm).listen(PORT, "0.0.0.0", () => {
    console.log("==============================================");
    console.log("  Caderno de Turma está funcionando!");
    console.log("==============================================");
    console.log(`  Neste computador:  http://localhost:${PORT}`);
    for (const lista of Object.values(os.networkInterfaces()))
      for (const i of lista || [])
        if (i.family === "IPv4" && !i.internal) console.log(`  Outros aparelhos na mesma rede/Wi-Fi:  http://${i.address}:${PORT}`);
    console.log(`\n  Dados guardados em: ${arm.descricao}`);
    console.log("  Deixe esta janela aberta enquanto o sistema estiver em uso.\n");
  });
})();
