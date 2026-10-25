import http from "node:http";
import cluster from "node:cluster";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const PORT = Number(process.env.PORT || 8766);
const HOST = process.env.HOST || "127.0.0.1";
const ELECTION = "6258";
const FILE_ELECTION = ELECTION.padStart(6, "0");
const TURN = "2";
const CARGO = "1";
const TSE_BASE = "https://resultados.tse.jus.br/oficial/ele2026/" + ELECTION;
const TSE_DATA = TSE_BASE + "/dados";
const MUNICIPALITY_CONFIG_URL = TSE_BASE + "/config/mun-e" + FILE_ELECTION + "-cm.jws";
const TSE_KEY_ID = "sNbt9Q_fLS65zE1_ZLNV-XRRwPY";
const TSE_PUBLIC_KEY = "kWlpNHjuws1csyQZwzn3Fhzbi3RD435RbpThtSr4hMc";
const TSE_KEY = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(TSE_PUBLIC_KEY, "base64url")]),
  format: "der",
  type: "spki"
});

// Limite global: no máximo 1 requisição ao TSE a cada 5 segundos (12 req/min = 0,2% do teto técnico de 100 req/s)
const MIN_UPSTREAM_GAP_MS = 5000;
const UPSTREAM_TIMEOUT_MS = 12000;
const COLLECTOR_TICK_MS = 5000;
const TRACKER_MIN_AGE_MS = 10000;
const MUNICIPALITY_CACHE_MS = 6 * 60 * 60 * 1000;
const VIEW_SCOPE_TTL_MS = 60 * 1000;

// Políticas de espera por tipo de falha HTTP
const RATE_LIMIT_PAUSE_MS = 10 * 60 * 1000; // 429: pausa mínima obrigatória de 10 minutos
const FAILURE_BACKOFF_MAX_MS = 10 * 60 * 1000;
const NOT_FOUND_INITIAL_WAIT_MS = 60 * 1000; // 404: período de espera para evitar tentativas repetidas
const SERVICE_UNAVAILABLE_INITIAL_WAIT_MS = 15 * 1000; // 503: espera progressiva

// Tentativas espaçadas e limitadas para o EA20 acompanhar o sinal do EA14/EA15 na CDN
const EA20_SYNC_RETRY_DELAYS_MS = [10000, 15000, 25000, 45000];
const MAP_OPPORTUNISTIC_MAX_ATTEMPTS = 2;
const MAP_OPPORTUNISTIC_RETRY_MS = 30000;

const UFS = new Set(["br","ac","al","ap","am","ba","ce","df","es","go","ma","mt","ms","mg","pa","pb","pr","pe","pi","rj","rn","rs","ro","rr","sc","sp","se","to"]);
const MIME = new Map([
  [".html","text/html; charset=utf-8"],[".css","text/css; charset=utf-8"],[".js","text/javascript; charset=utf-8"],
  [".svg","image/svg+xml"],[".json","application/json; charset=utf-8"],[".txt","text/plain; charset=utf-8"],
  [".png","image/png"],[".jpg","image/jpeg"],[".jpeg","image/jpeg"],[".webp","image/webp"],[".woff2","font/woff2"]
]);
const UF_NAMES = new Map([
  ["ac","Acre"],["al","Alagoas"],["ap","Amapá"],["am","Amazonas"],["ba","Bahia"],["ce","Ceará"],
  ["df","Distrito Federal"],["es","Espírito Santo"],["go","Goiás"],["ma","Maranhão"],["mt","Mato Grosso"],
  ["ms","Mato Grosso do Sul"],["mg","Minas Gerais"],["pa","Pará"],["pb","Paraíba"],["pr","Paraná"],
  ["pe","Pernambuco"],["pi","Piauí"],["rj","Rio de Janeiro"],["rn","Rio Grande do Norte"],["rs","Rio Grande do Sul"],
  ["ro","Rondônia"],["rr","Roraima"],["sc","Santa Catarina"],["sp","São Paulo"],["se","Sergipe"],["to","Tocantins"]
]);

mkdirSync(DATA_DIR, { recursive: true });
let history = readHistory();

// Cache em memória de respostas EA20, EA14 e EA15
const cache = new Map();
const failures = new Map();
const scopeDiagnostics = new Map();
const inFlightByUrl = new Map();

let municipalityConfig = null;
let municipalityConfigExpiresAt = 0;
let municipalityConfigFlight = null;

// Controle da fila global única ao TSE (1 chamada por vez, mínimo 5s entre chamadas)
let upstreamQueue = Promise.resolve();
let nextUpstreamAt = 0;
let upstreamInFlightCount = 0;
let globalRateLimitUntil = 0;
let lastUpstreamEvent = null;

// Estado dos arquivos de acompanhamento EA14 (Brasil/UFs) e EA15 (Municípios por UF)
let ea14Record = {
  etag: "",
  lastModified: "",
  checkedAt: 0,
  idg: "",
  generated: null,
  entries: new Map() // chave: 'br' ou sigla da UF ('ac'..'to')
};
const ea15Records = new Map(); // chave: uf -> { etag, lastModified, checkedAt, idg, generated, entries: Map(munCode -> entry) }

// Controle de sincronização pendente do EA20 após sinal de mudança no EA14/EA15
const pendingEa20Sync = new Map(); // chave: historyKey -> { targetSignature, attempts, nextAttemptAt, reason }
const mapOpportunisticState = new Map(); // chave: uf -> { targetSignature, attempts, nextAttemptAt }

// Clientes registram apenas os recortes que estão visualizando. O coletor escolhe
// quando consultá-los, sempre pela fila do servidor e nunca por um pedido manual.
const viewerScopes = new Map();
const scopeLastServedAt = new Map();
let lastRequestedScopeKey = "br";
let collectorScopeKey = "br";
let collectorRunning = false;
let collectorInterval = null;

if (cluster.isWorker) {
  throw new Error("O painel deve executar como uma única instância Node, sem workers de cluster.");
}

// Pré-hidrata o cache em memória e a série temporal a partir do history.json persistido
for (const [key, entry] of Object.entries(history)) {
  if (entry?.current && typeof entry.current === "object") {
    if (!Array.isArray(entry.timeline)) {
      const pts = [];
      if (entry.previous && typeof entry.previous === "object") {
        const prevPt = extractTimelinePoint(entry.previous, entry.checkedAt);
        if (prevPt) pts.push(prevPt);
      }
      const currPt = extractTimelinePoint(entry.current, entry.checkedAt);
      if (currPt) pts.push(currPt);
      entry.timeline = pts;
    }
    cache.set(key, {
      raw: entry.current,
      etag: "",
      lastModified: "",
      checkedAt: entry.checkedAt || null,
      signature: computeEa20Signature(entry.current)
    });
  }
}

function readHistory() {
  try {
    const raw = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function persistHistory() {
  const temp = HISTORY_FILE + ".tmp";
  try {
    writeFileSync(temp, JSON.stringify(history), "utf8");
    renameSync(temp, HISTORY_FILE);
  } catch (error) {
    process.stderr.write("Histórico mantido em memória; persistência indisponível: " + error.message + "\n");
  }
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  let text = String(value).trim().replace(/%$/, "");
  if (text.includes(",") && text.includes(".")) text = text.replaceAll(".", "").replace(",", ".");
  else if (text.includes(",")) text = text.replace(",", ".");
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function parseBrTimestamp(dateStr, timeStr) {
  const match = String(dateStr || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, day, month, year] = match;
  const clock = /^\d{2}:\d{2}:\d{2}$/.test(String(timeStr || "").trim()) ? String(timeStr).trim() : "00:00:00";
  const date = new Date(year + "-" + month + "-" + day + "T" + clock + "-03:00");
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function generatedAt(data) {
  return parseBrTimestamp(data?.dg, data?.hg) || parseBrTimestamp(data?.dt, data?.ht);
}

function computeEa20Signature(data) {
  if (!data || typeof data !== "object") return "";
  const dt = String(data.dt || data.dg || "").trim();
  const ht = String(data.ht || data.hg || "").trim();
  const st = String(data.s?.st ?? "0").trim();
  const and = String(data.and || "n").toLowerCase();
  return dt + "|" + ht + "|" + st + "|" + and;
}

function extractTimelinePoint(raw, checkedAt = null) {
  try {
    if (!raw || typeof raw !== "object") return null;
    const totals = candidateTotals(raw);
    const votes13 = totals.get("13") || 0;
    const votes22 = totals.get("22") || 0;
    const validVotes = finiteNumber(raw.v?.vv) || 0;
    const sectionsDone = finiteNumber(raw.s?.st) || 0;
    const sectionsTotal = finiteNumber(raw.s?.ts) || 0;
    const share13 = validVotes > 0 ? Number(((100 * votes13) / validVotes).toFixed(4)) : 0;
    const share22 = validVotes > 0 ? Number(((100 * votes22) / validVotes).toFixed(4)) : 0;
    const sectionsPct = sectionsTotal > 0 ? Number(((100 * sectionsDone) / sectionsTotal).toFixed(2)) : 0;
    const officialTime = parseBrTimestamp(raw.dt, raw.ht) || generatedAt(raw) || checkedAt || new Date().toISOString();
    return {
      idg: String(raw.idg || ""),
      at: officialTime,
      checkedAt: checkedAt || officialTime,
      votes13,
      votes22,
      validVotes,
      share13,
      share22,
      sectionsDone,
      sectionsTotal,
      sectionsPct,
      final: String(raw.and || "").toLowerCase() === "f"
    };
  } catch {
    return null;
  }
}

function appendTimelinePoint(existingList, point) {
  const list = Array.isArray(existingList) ? [...existingList] : [];
  const last = list[list.length - 1];
  if (last && last.idg === point.idg && last.votes13 === point.votes13 &&
      last.votes22 === point.votes22 && last.sectionsDone === point.sectionsDone) {
    return list;
  }
  list.push(point);
  return list.slice(-720);
}

function verifyJws(compact) {
  const parts = String(compact || "").trim().split(".");
  if (parts.length !== 3 || parts.some(part => !part)) throw new Error("O TSE retornou um arquivo assinado inválido.");
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("O TSE retornou um arquivo assinado ilegível.");
  }
  if (header.alg !== "EdDSA" || header.kid !== TSE_KEY_ID || header.typ !== "JOSE") {
    throw new Error("A identidade do arquivo assinado não corresponde à chave oficial esperada.");
  }
  const signedContent = Buffer.from(parts[0] + "." + parts[1], "utf8");
  const signature = Buffer.from(parts[2], "base64url");
  if (!verifySignature(null, signedContent, TSE_KEY, signature)) {
    throw new Error("A assinatura digital do arquivo do TSE não confere.");
  }
  return payload;
}

function candidateTotals(data) {
  const cargo = (Array.isArray(data?.carg) ? data.carg : []).find(item => String(item.cd) === CARGO);
  if (!cargo) throw new Error("O arquivo não contém o cargo de Presidente.");
  const found = new Map();
  for (const group of Array.isArray(cargo.agr) ? cargo.agr : []) {
    for (const party of Array.isArray(group.par) ? group.par : []) {
      for (const candidate of Array.isArray(party.cand) ? party.cand : []) {
        const number = String(candidate.n || "");
        if (number === "13" || number === "22") {
          const votes = finiteNumber(candidate.vap);
          if (votes === null || votes < 0 || !Number.isInteger(votes)) throw new Error("O arquivo contém votos inválidos.");
          found.set(number, votes);
        }
      }
    }
  }
  if (!found.has("13") || !found.has("22")) throw new Error("O arquivo não contém as duas candidaturas esperadas.");
  return found;
}

function validateResult(data, uf, municipalityCode = "") {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("O arquivo está vazio ou inválido.");
  if (String(data.ele) !== ELECTION || String(data.t) !== TURN || String(data.f) !== "o") {
    throw new Error("O arquivo não corresponde à eleição presidencial federal do segundo turno.");
  }
  const expectedType = municipalityCode ? "mu" : (uf === "br" ? "br" : "uf");
  const expectedRegion = municipalityCode || uf;
  if (String(data.tpabr || "").toLowerCase() !== expectedType || String(data.cdabr || "").toLowerCase() !== expectedRegion) {
    throw new Error("A abrangência do arquivo não corresponde à consulta solicitada.");
  }
  if (!data.idg || String(data.idg).trim() === "") throw new Error("O arquivo está sem o identificador IDG.");
  const votes = candidateTotals(data);
  const valid = finiteNumber(data.v?.vv);
  const done = finiteNumber(data.s?.st);
  const total = finiteNumber(data.s?.ts);
  if ([valid, done, total].some(value => value === null || value < 0 || !Number.isInteger(value)) || done > total) {
    throw new Error("O arquivo não contém totais válidos de votos e seções.");
  }
  if (votes.get("13") + votes.get("22") > valid) throw new Error("Os votos das candidaturas excedem os votos válidos.");
  const electorate = finiteNumber(data.e?.te);
  const remaining = finiteNumber(data.e?.esnt);
  if (electorate !== null && remaining !== null && remaining > electorate) throw new Error("O eleitorado não totalizado excede o total apto.");
  return {
    idg: String(data.idg),
    generated: generatedAt(data),
    votes: Object.fromEntries(votes),
    final: String(data.and || "").toLowerCase() === "f"
  };
}

// Valida e extrai entradas de acompanhamento dos arquivos EA14 (Brasil/UFs) e EA15 (UF/Municípios)
// Conforme especificação conferida no TSE:
// - EA14: /dados/br/br-e006258-ab.jws -> abr[] com tpabr="br"|"uf", cdabr="br"|uf, dt, ht, and, s.{ts,st,pst,pstn}
// - EA15: /dados/{uf}/{uf}-e006258-ab.jws -> abr[] com tpabr="uf"|"mun", cdabr=uf|codMun5Digitos, dt, ht, and, s.{ts,st,pst,pstn}
function validateTrackingFile(data, expectedKind, expectedUf = "br") {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Arquivo de acompanhamento (" + expectedKind + ") vazio ou inválido.");
  }
  if (String(data.ele) !== ELECTION || String(data.t) !== TURN || String(data.f) !== "o") {
    throw new Error("Arquivo de acompanhamento (" + expectedKind + ") não pertence ao 2º turno da eleição " + ELECTION + ".");
  }
  if (!Array.isArray(data.abr) || data.abr.length === 0) {
    throw new Error("Arquivo de acompanhamento (" + expectedKind + ") sem lista de abrangências (abr).");
  }
  const entries = new Map();
  for (const item of data.abr) {
    const tpabr = String(item?.tpabr || "").toLowerCase();
    const cdabr = String(item?.cdabr || "").toLowerCase();
    if (!cdabr) continue;
    const dt = String(item?.dt || "").trim();
    const ht = String(item?.ht || "").trim();
    const and = String(item?.and || "n").toLowerCase();
    const st = finiteNumber(item?.s?.st) ?? 0;
    const ts = finiteNumber(item?.s?.ts) ?? 0;
    const pst = finiteNumber(item?.s?.pstn ?? item?.s?.pst) ?? 0;
    const signature = dt + "|" + ht + "|" + st + "|" + and;
    const timestampIso = parseBrTimestamp(dt, ht);

    if (expectedKind === "EA14") {
      if ((tpabr === "br" && cdabr === "br") || (tpabr === "uf" && UFS.has(cdabr))) {
        entries.set(cdabr, { tpabr, cdabr, dt, ht, timestampIso, and, st, ts, pst, signature });
      }
    } else if (expectedKind === "EA15") {
      if (tpabr === "uf" && cdabr === expectedUf) {
        entries.set(expectedUf, { tpabr, cdabr, dt, ht, timestampIso, and, st, ts, pst, signature });
      } else if ((tpabr === "mun" || tpabr === "mu") && /^\d{5}$/.test(cdabr)) {
        entries.set(cdabr, { tpabr: "mun", cdabr, dt, ht, timestampIso, and, st, ts, pst, signature });
      }
    }
  }
  if (entries.size === 0) {
    throw new Error("Nenhuma abrangência válida encontrada no arquivo " + expectedKind + ".");
  }
  return {
    idg: String(data.idg || ""),
    generated: generatedAt(data),
    entries
  };
}

function historyKey(uf, municipalityCode = "") {
  return municipalityCode ? uf + ":" + municipalityCode : uf;
}

function registerViewerScope(uf, municipalityCode = "") {
  const key = historyKey(uf, municipalityCode);
  const now = Date.now();
  for (const [scopeKey, scope] of viewerScopes) {
    if (scopeKey !== "br" && now - scope.lastSeenAt > VIEW_SCOPE_TTL_MS) viewerScopes.delete(scopeKey);
  }
  const existing = viewerScopes.get(key);
  viewerScopes.set(key, {
    key,
    uf,
    municipalityCode,
    firstSeenAt: existing?.firstSeenAt || now,
    lastSeenAt: now
  });
  lastRequestedScopeKey = key;
  return key;
}

function getMonitoredScopes() {
  const now = Date.now();
  for (const [key, scope] of viewerScopes) {
    if (key !== "br" && now - scope.lastSeenAt > VIEW_SCOPE_TTL_MS) viewerScopes.delete(key);
  }
  const scopes = new Map([[
    "br",
    { key: "br", uf: "br", municipalityCode: "", firstSeenAt: 0, lastSeenAt: now }
  ]]);
  for (const [key, scope] of viewerScopes) scopes.set(key, scope);
  return [...scopes.values()];
}

function scopeServiceOrder(scopes) {
  return [...scopes].sort((a, b) => {
    const aServed = scopeLastServedAt.get(a.key) || 0;
    const bServed = scopeLastServedAt.get(b.key) || 0;
    if (aServed !== bServed) return aServed - bServed;
    return a.firstSeenAt - b.firstSeenAt;
  });
}

function ea14Url() {
  return TSE_DATA + "/br/br-e" + FILE_ELECTION + "-ab.jws";
}

function ea15Url(uf) {
  return TSE_DATA + "/" + uf + "/" + uf + "-e" + FILE_ELECTION + "-ab.jws";
}

function resultsUrl(uf, municipalityCode = "") {
  const filenamePrefix = uf + municipalityCode;
  return TSE_DATA + "/" + uf + "/" + filenamePrefix + "-c0001-e" + FILE_ELECTION + "-u.jws";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getEffectiveRateLimitUntil() {
  return globalRateLimitUntil;
}

function formatUpstreamError(status, defaultMsg) {
  if (status === 429) return "HTTP 429 da fonte oficial (TSE): limite de requisições atingido. Coletor em pausa de proteção de 10 minutos.";
  if (status === 404) return "HTTP 404 da fonte oficial (TSE): arquivo ainda não disponível na CDN.";
  if (status === 503) return "HTTP 503 da fonte oficial (TSE): serviço temporariamente indisponível.";
  if (status === 504) return "Timeout (" + (UPSTREAM_TIMEOUT_MS / 1000) + "s) ao aguardar resposta do TSE.";
  return defaultMsg || ("Resposta HTTP " + status + " da fonte oficial.");
}

// Fila única do processo: uma chamada em andamento e intervalo mínimo de 5 s.
function runInGlobalUpstreamQueue(url, executeFn) {
  if (inFlightByUrl.has(url)) {
    return inFlightByUrl.get(url);
  }

  const taskPromise = (async () => {
    const runSlot = upstreamQueue.then(async () => {
      const rateLimitUntil = getEffectiveRateLimitUntil();
      if (rateLimitUntil > Date.now()) {
        const waitSec = Math.ceil((rateLimitUntil - Date.now()) / 1000);
        const err = new Error("Coletor em pausa de proteção após HTTP 429 do TSE (restam " + waitSec + "s).");
        err.status = 429;
        err.retryAfter = rateLimitUntil - Date.now();
        throw err;
      }

      const waitMs = Math.max(0, nextUpstreamAt - Date.now());
      if (waitMs) await sleep(waitMs);

      const startAt = Date.now();
      upstreamInFlightCount += 1;
      nextUpstreamAt = startAt + MIN_UPSTREAM_GAP_MS;

      try {
        return await executeFn();
      } finally {
        upstreamInFlightCount = Math.max(0, upstreamInFlightCount - 1);
        const finishedAt = Date.now();
        // Garante 5 segundos completos desde o início da chamada e nunca sobrepõe chamadas
        nextUpstreamAt = Math.max(nextUpstreamAt, finishedAt + MIN_UPSTREAM_GAP_MS);
      }
    });

    // Mantém a cadeia viva mesmo após rejeições
    upstreamQueue = runSlot.catch(() => {});
    return await runSlot;
  })().finally(() => {
    inFlightByUrl.delete(url);
  });

  inFlightByUrl.set(url, taskPromise);
  return taskPromise;
}

async function requestText(url, stored = null, label = "TSE") {
  return runInGlobalUpstreamQueue(url, async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const headers = {
      "Accept": "application/jose, text/plain;q=0.9, */*;q=0.8"
    };
    if (stored?.etag) headers["If-None-Match"] = stored.etag;
    if (stored?.lastModified) headers["If-Modified-Since"] = stored.lastModified;

    const startedAt = new Date().toISOString();
    try {
      // Sem query '?nocache=' para respeitar a URL canônica da CDN do TSE e permitir 304
      const response = await fetch(url, {
        method: "GET",
        headers,
        signal: controller.signal
      });

      const status = response.status;
      lastUpstreamEvent = { label, url, status, at: startedAt };

      if (status === 304 && (stored?.raw || stored?.entries)) {
        return {
          notModified: true,
          status: 304,
          checkedAt: new Date().toISOString(),
          etag: stored.etag,
          lastModified: stored.lastModified
        };
      }

      if (!response.ok) {
        const retryHeader = Number(response.headers.get("retry-after"));
        const retryAfterHeaderMs = Number.isFinite(retryHeader) && retryHeader > 0
          ? retryHeader * 1000
          : null;

        if (status === 429) {
          const pauseMs = Math.max(retryAfterHeaderMs || 0, RATE_LIMIT_PAUSE_MS);
          globalRateLimitUntil = Date.now() + pauseMs;
        }

        const error = new Error(formatUpstreamError(status));
        error.status = status;
        error.retryAfter = status === 429
          ? Math.max(retryAfterHeaderMs || 0, RATE_LIMIT_PAUSE_MS)
          : (retryAfterHeaderMs ? Math.min(retryAfterHeaderMs, FAILURE_BACKOFF_MAX_MS) : null);

        process.stderr.write("[TSE Upstream] " + label + " -> HTTP " + status + " (" + url + ")\n");
        throw error;
      }

      return {
        status: 200,
        text: await response.text(),
        checkedAt: new Date().toISOString(),
        etag: response.headers.get("etag") || stored?.etag || "",
        lastModified: response.headers.get("last-modified") || stored?.lastModified || ""
      };
    } catch (error) {
      if (error?.name === "AbortError") {
        const timeoutError = new Error(formatUpstreamError(504));
        timeoutError.status = 504;
        lastUpstreamEvent = { label, url, status: 504, at: startedAt, error: timeoutError.message };
        process.stderr.write("[TSE Upstream] " + label + " -> TIMEOUT 504 (" + url + ")\n");
        throw timeoutError;
      }
      if (!error.status) {
        error.status = 502;
        lastUpstreamEvent = { label, url, status: 502, at: startedAt, error: error.message };
        process.stderr.write("[TSE Upstream] " + label + " -> ERRO DE REDE (" + url + "): " + error.message + "\n");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  });
}

function computeBackoffMs(status, count, retryAfterMs = null) {
  if (status === 429) {
    return Math.max(retryAfterMs || 0, RATE_LIMIT_PAUSE_MS);
  }
  if (status === 404) {
    // 404 recebe período de espera dedicado (60s iniciais, dobrando até 10 min) para evitar repetição
    const wait = NOT_FOUND_INITIAL_WAIT_MS * (2 ** Math.min(Math.max(0, count - 1), 4));
    return Math.min(Math.max(retryAfterMs || 0, wait), FAILURE_BACKOFF_MAX_MS);
  }
  if (status === 503) {
    // 503 recebe espera progressiva (15s, 30s, 60s, 120s, 240s... até 10 min)
    const wait = SERVICE_UNAVAILABLE_INITIAL_WAIT_MS * (2 ** Math.min(Math.max(0, count - 1), 5));
    return Math.min(Math.max(retryAfterMs || 0, wait), FAILURE_BACKOFF_MAX_MS);
  }
  const wait = 15000 * (2 ** Math.min(Math.max(0, count - 1), 5));
  return Math.min(Math.max(retryAfterMs || 0, wait), FAILURE_BACKOFF_MAX_MS);
}

function recordFailure(key, error) {
  const prev = failures.get(key);
  const count = (prev?.count || 0) + 1;
  const status = Number(error?.status) || 502;
  const retryMs = computeBackoffMs(status, count, error?.retryAfter);
  const retryAt = Date.now() + retryMs;
  const message = error?.message || "Falha ao consultar o TSE.";
  const entry = {
    count,
    status,
    retryAt,
    message,
    at: new Date().toISOString()
  };
  failures.set(key, entry);
  scopeDiagnostics.set(key, {
    upstreamStatus: status,
    lastError: message,
    retryAt,
    updatedAt: entry.at
  });
  return entry;
}

function recordSuccessDiagnostic(key, status) {
  failures.delete(key);
  scopeDiagnostics.set(key, {
    upstreamStatus: status,
    lastError: "",
    retryAt: 0,
    updatedAt: new Date().toISOString()
  });
}

function parseMunicipalityConfig(data) {
  if (!data || !Array.isArray(data.abr) || String(data.f) !== "o") {
    throw new Error("O cadastro municipal assinado está fora do formato esperado.");
  }
  const seen = new Set();
  const states = [];
  for (const state of data.abr) {
    const uf = String(state.cd || "").toLowerCase();
    if (!UFS.has(uf) || uf === "br" || !Array.isArray(state.mu)) continue;
    const municipalities = [];
    for (const municipality of state.mu) {
      const code = String(municipality.cd || "");
      const name = String(municipality.nm || "").trim();
      if (!/^\d{5}$/.test(code) || !name || seen.has(uf + ":" + code)) continue;
      seen.add(uf + ":" + code);
      municipalities.push({ uf, ufName: UF_NAMES.get(uf) || String(state.ds || uf.toUpperCase()), code, name });
    }
    states.push({ uf, ufName: UF_NAMES.get(uf) || String(state.ds || uf.toUpperCase()), municipalities });
  }
  if (seen.size < 5000) throw new Error("O cadastro municipal oficial veio incompleto.");
  return { idg: String(data.idg || ""), generated: generatedAt(data), states };
}

async function getMunicipalityConfig(force = false) {
  const now = Date.now();
  const failureKey = "tracker:ea12";
  const priorFailure = failures.get(failureKey);
  if (!force && municipalityConfig && municipalityConfigExpiresAt > now) return municipalityConfig;
  if (!force && priorFailure && priorFailure.retryAt > now) {
    if (municipalityConfig) return municipalityConfig;
    const error = new Error(priorFailure.message);
    error.status = priorFailure.status;
    error.retryAfter = priorFailure.retryAt - now;
    throw error;
  }
  if (municipalityConfigFlight) return municipalityConfigFlight;
  municipalityConfigFlight = (async () => {
    try {
      const response = await requestText(MUNICIPALITY_CONFIG_URL, null, "EA12:mun-config");
      const parsed = parseMunicipalityConfig(verifyJws(response.text));
      municipalityConfig = parsed;
      municipalityConfigExpiresAt = Date.now() + MUNICIPALITY_CACHE_MS;
      recordSuccessDiagnostic(failureKey, response.status);
      return parsed;
    } catch (error) {
      const failure = recordFailure(failureKey, error);
      if (municipalityConfig) return municipalityConfig;
      error.retryAfter = Math.max(error.retryAfter || 0, failure.retryAt - Date.now());
      throw error;
    } finally {
      municipalityConfigFlight = null;
    }
  })();
  return municipalityConfigFlight;
}

function normalizeSearch(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleUpperCase("pt-BR").trim().replace(/\s+/g, " ");
}

async function searchMunicipalities(uf, query) {
  const normalizedQuery = normalizeSearch(query);
  const config = await getMunicipalityConfig();
  if (!normalizedQuery && uf !== "br") {
    const state = config.states.find(item => item.uf === uf);
    const items = (state?.municipalities || [])
      .map(city => ({ uf: city.uf, ufName: city.ufName, name: city.name, code: city.code }))
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    return { items, minimumCharacters: 0, configIdg: config.idg };
  }
  if (normalizedQuery.length < 2) return { items: [], minimumCharacters: 2 };
  const states = uf === "br" ? config.states : config.states.filter(state => state.uf === uf);
  const items = [];
  for (const state of states) {
    for (const city of state.municipalities) {
      if (normalizeSearch(city.name).includes(normalizedQuery)) {
        items.push({ uf: city.uf, ufName: city.ufName, name: city.name, code: city.code });
        if (items.length === 30) return { items, minimumCharacters: 2, configIdg: config.idg };
      }
    }
  }
  return { items, minimumCharacters: 2, configIdg: config.idg };
}

async function verifyMunicipality(uf, code) {
  const config = await getMunicipalityConfig();
  const state = config.states.find(item => item.uf === uf);
  const municipality = state?.municipalities.find(item => item.code === code);
  if (!municipality) {
    const err = new Error("A cidade selecionada não pertence à UF informada no cadastro do TSE.");
    err.status = 400;
    throw err;
  }
  return municipality;
}

// ============================================================================
// CONSULTA A ARQUIVOS EA14, EA15 E EA20 (DENTRO DO COLETOR CENTRAL)
// ============================================================================

async function fetchEa14() {
  const fKey = "tracker:ea14";
  const fail = failures.get(fKey);
  if (fail && fail.retryAt > Date.now()) return false;

  try {
    const response = await requestText(
      ea14Url(),
      ea14Record.entries.size > 0 ? ea14Record : null,
      "EA14:br"
    );
    if (response.notModified) {
      ea14Record.checkedAt = Date.now();
      recordSuccessDiagnostic(fKey, 304);
      return false;
    }
    const raw = verifyJws(response.text);
    const parsed = validateTrackingFile(raw, "EA14", "br");
    ea14Record = {
      etag: response.etag,
      lastModified: response.lastModified,
      checkedAt: Date.now(),
      idg: parsed.idg,
      generated: parsed.generated,
      entries: parsed.entries
    };
    recordSuccessDiagnostic(fKey, 200);
    evaluateEa14Signals(parsed.entries);
    return true;
  } catch (error) {
    recordFailure(fKey, error);
    return false;
  }
}

async function fetchEa15(uf) {
  const fKey = "tracker:ea15:" + uf;
  const fail = failures.get(fKey);
  if (fail && fail.retryAt > Date.now()) return false;

  const existing = ea15Records.get(uf) || null;
  try {
    const response = await requestText(
      ea15Url(uf),
      existing?.entries?.size > 0 ? existing : null,
      "EA15:" + uf
    );
    if (response.notModified && existing) {
      existing.checkedAt = Date.now();
      recordSuccessDiagnostic(fKey, 304);
      return false;
    }
    const raw = verifyJws(response.text);
    const parsed = validateTrackingFile(raw, "EA15", uf);
    const record = {
      etag: response.etag,
      lastModified: response.lastModified,
      checkedAt: Date.now(),
      idg: parsed.idg,
      generated: parsed.generated,
      entries: parsed.entries
    };
    ea15Records.set(uf, record);
    recordSuccessDiagnostic(fKey, 200);
    evaluateEa15Signals(uf, parsed.entries);
    return true;
  } catch (error) {
    recordFailure(fKey, error);
    return false;
  }
}

function hasEa20CaughtUp(key, targetSignature) {
  if (!targetSignature) return true;
  const cached = cache.get(key);
  if (!cached?.raw) return false;
  const currentSig = cached.signature || computeEa20Signature(cached.raw);
  if (currentSig === targetSignature) return true;

  // Compara seções totalizadas ou timestamp para saber se o EA20 já é igual ou mais recente que o sinal
  const [, , targetStStr] = targetSignature.split("|");
  const targetSt = Number(targetStStr) || 0;
  const currentSt = finiteNumber(cached.raw?.s?.st) ?? 0;
  if (currentSt > targetSt) return true;
  return false;
}

function evaluateEa14Signals(entries) {
  // O EA14 é compartilhado: cria gatilhos para todos os recortes de país/UF que
  // algum navegador esteja acompanhando, sem deixar um visitante sobrescrever outro.
  for (const scope of getMonitoredScopes()) {
    if (scope.municipalityCode) continue;
    const entry = entries.get(scope.uf);
    if (!entry || entry.st <= 0 || hasEa20CaughtUp(scope.key, entry.signature)) continue;
    const existingSync = pendingEa20Sync.get(scope.key);
    if (!existingSync || existingSync.targetSignature !== entry.signature) {
      pendingEa20Sync.set(scope.key, {
        uf: scope.uf,
        municipalityCode: "",
        targetSignature: entry.signature,
        attempts: 0,
        nextAttemptAt: Date.now(),
        reason: "EA14"
      });
    }
  }

  // 2. Marca estados para atualização oportunista do mapa apenas quando o EA14
  // sinaliza seções apuradas (st > 0) e assinatura diferente do EA20 em cache
  for (const [uf] of UF_NAMES.entries()) {
    const stEntry = entries.get(uf);
    if (!stEntry || stEntry.st <= 0) continue;
    if (!hasEa20CaughtUp(uf, stEntry.signature)) {
      const prev = mapOpportunisticState.get(uf);
      if (!prev || prev.targetSignature !== stEntry.signature) {
        mapOpportunisticState.set(uf, {
          targetSignature: stEntry.signature,
          attempts: 0,
          nextAttemptAt: Date.now()
        });
      }
    } else {
      mapOpportunisticState.delete(uf);
    }
  }
}

function evaluateEa15Signals(uf, entries) {
  for (const scope of getMonitoredScopes()) {
    if (scope.uf !== uf || !scope.municipalityCode) continue;
    const entry = entries.get(scope.municipalityCode);
    if (!entry || entry.st <= 0 || hasEa20CaughtUp(scope.key, entry.signature)) continue;
    const existingSync = pendingEa20Sync.get(scope.key);
    if (!existingSync || existingSync.targetSignature !== entry.signature) {
      pendingEa20Sync.set(scope.key, {
        uf,
        municipalityCode: scope.municipalityCode,
        targetSignature: entry.signature,
        attempts: 0,
        nextAttemptAt: Date.now(),
        reason: "EA15"
      });
    }
  }
}

async function fetchEa20ForScope(uf, municipalityCode = "") {
  const key = historyKey(uf, municipalityCode);
  const stored = cache.get(key) || null;
  const label = "EA20:" + key;

  try {
    const response = await requestText(resultsUrl(uf, municipalityCode), stored, label);
    if (response.notModified && stored?.raw) {
      const unchanged = {
        ...stored,
        checkedAt: response.checkedAt
      };
      cache.set(key, unchanged);
      recordSuccessDiagnostic(key, 304);
      return { record: unchanged, updated: false, status: 304 };
    }

    const raw = verifyJws(response.text);
    const validated = validateResult(raw, uf, municipalityCode);
    const saved = history[key]?.current || stored?.raw || null;
    if (saved?.idg !== validated.idg && saved?.dg && generatedAt(raw) && generatedAt(saved) &&
        new Date(generatedAt(raw)) < new Date(generatedAt(saved))) {
      const error = new Error("A CDN respondeu com uma versão anterior do EA20; a última versão válida foi mantida.");
      error.status = 409;
      error.staleVersion = true;
      throw error;
    }

    const storedRaw = {
      ...raw,
      _scope: key,
      _uf: uf,
      ...(municipalityCode ? { _municipalityCode: municipalityCode } : {})
    };
    const isNewIdg = !saved || saved.idg !== validated.idg;
    const existingTimeline = Array.isArray(history[key]?.timeline) ? history[key].timeline : [];
    const point = extractTimelinePoint(storedRaw, response.checkedAt);
    const updatedTimeline = point ? appendTimelinePoint(existingTimeline, point) : existingTimeline;

    if (isNewIdg || updatedTimeline.length !== existingTimeline.length) {
      history[key] = {
        current: storedRaw,
        previous: isNewIdg ? (saved || history[key]?.previous || null) : (history[key]?.previous || null),
        checkedAt: response.checkedAt,
        timeline: updatedTimeline
      };
      persistHistory();
    }

    const record = {
      raw: history[key]?.current || storedRaw,
      etag: response.etag,
      lastModified: response.lastModified,
      checkedAt: response.checkedAt,
      signature: computeEa20Signature(storedRaw)
    };
    cache.set(key, record);
    recordSuccessDiagnostic(key, 200);
    return { record, updated: isNewIdg, status: 200 };
  } catch (error) {
    recordFailure(key, error);
    throw error;
  }
}

// ============================================================================
// COLETOR CENTRAL (EXECUTA 1 PASSO POR CICLO RESPEITANDO A FILA DE 5 SEGUNDOS)
// ============================================================================

async function runCollectorStep() {
  if (collectorRunning) return;
  if (getEffectiveRateLimitUntil() > Date.now()) return;
  if (upstreamInFlightCount > 0) return;

  collectorRunning = true;
  try {
    const now = Date.now();
    const scopes = scopeServiceOrder(getMonitoredScopes());

    // O país recebe a primeira leitura do servidor. UFs e municípios só entram
    // na fila de EA20 depois de um sinal do EA14/EA15.
    if (!cache.get("br")?.raw && !history.br?.current) {
      const failure = failures.get("br");
      if (!failure || failure.retryAt <= now) {
        collectorScopeKey = "br";
        scopeLastServedAt.set("br", now);
        await fetchEa20ForScope("br", "").catch(() => {});
        return;
      }
    }

    // Prioridade: atualizações sinalizadas para qualquer recorte que esteja
    // sendo visualizado, com rotação justa entre clientes e sem chamadas deles ao TSE.
    for (const scope of scopes) {
      const pendingSync = pendingEa20Sync.get(scope.key);
      if (!pendingSync) continue;
      if (hasEa20CaughtUp(scope.key, pendingSync.targetSignature)) {
        pendingEa20Sync.delete(scope.key);
        continue;
      }
      const failure = failures.get(scope.key);
      if ((failure && failure.retryAt > now) || now < pendingSync.nextAttemptAt) continue;

      collectorScopeKey = scope.key;
      scopeLastServedAt.set(scope.key, now);
      try {
        await fetchEa20ForScope(scope.uf, scope.municipalityCode);
      } catch {
        // O erro e o backoff por recorte já foram registrados em fetchEa20ForScope.
      }
      if (hasEa20CaughtUp(scope.key, pendingSync.targetSignature)) {
        pendingEa20Sync.delete(scope.key);
      } else {
        pendingSync.attempts += 1;
        if (pendingSync.attempts >= EA20_SYNC_RETRY_DELAYS_MS.length) {
          pendingEa20Sync.delete(scope.key);
        } else {
          pendingSync.nextAttemptAt = Date.now() + EA20_SYNC_RETRY_DELAYS_MS[pendingSync.attempts - 1];
        }
      }
      return;
    }

    // EA14 é um único arquivo nacional e também alimenta o mapa.
    const ea14Failure = failures.get("tracker:ea14");
    if (now - (ea14Record.checkedAt || 0) >= TRACKER_MIN_AGE_MS &&
        (!ea14Failure || ea14Failure.retryAt <= now)) {
      collectorScopeKey = "tracker:ea14";
      await fetchEa14();
      return;
    }

    // EA15 é compartilhado por todos os municípios acompanhados de uma UF.
    const cityUfs = [...new Set(scopes.filter(scope => scope.municipalityCode).map(scope => scope.uf))]
      .sort((a, b) => (ea15Records.get(a)?.checkedAt || 0) - (ea15Records.get(b)?.checkedAt || 0));
    for (const uf of cityUfs) {
      const record = ea15Records.get(uf);
      const failure = failures.get("tracker:ea15:" + uf);
      if (now - (record?.checkedAt || 0) < TRACKER_MIN_AGE_MS) continue;
      if (failure && failure.retryAt > now) continue;
      collectorScopeKey = "tracker:ea15:" + uf;
      await fetchEa15(uf);
      return;
    }

    // Prioridade final: colorir o mapa somente quando o EA14 sinalizou avanço.
    for (const [candidateUf, opp] of mapOpportunisticState.entries()) {
      if (hasEa20CaughtUp(candidateUf, opp.targetSignature)) {
        mapOpportunisticState.delete(candidateUf);
        continue;
      }
      const ufFail = failures.get(candidateUf);
      if (ufFail && ufFail.retryAt > now) continue;
      if (now < opp.nextAttemptAt) continue;

      collectorScopeKey = "map:" + candidateUf;
      scopeLastServedAt.set(candidateUf, now);
      try {
        await fetchEa20ForScope(candidateUf, "");
      } catch {
        // Falha registrada com backoff próprio da UF
      }

      if (hasEa20CaughtUp(candidateUf, opp.targetSignature)) {
        mapOpportunisticState.delete(candidateUf);
      } else {
        opp.attempts += 1;
        if (opp.attempts >= MAP_OPPORTUNISTIC_MAX_ATTEMPTS) {
          mapOpportunisticState.delete(candidateUf);
        } else {
          opp.nextAttemptAt = Date.now() + MAP_OPPORTUNISTIC_RETRY_MS;
        }
      }
      return;
    }
  } finally {
    collectorRunning = false;
  }
}

// ============================================================================
// LEITURA PARA OS NAVEGADORES (SERVIDA PELO ESTADO DO COLETOR CENTRAL)
// ============================================================================

function getCollectorMeta(key) {
  const diag = scopeDiagnostics.get(key) || null;
  const fail = failures.get(key) || null;
  const rateLimitUntil = getEffectiveRateLimitUntil();
  const isRateLimited = rateLimitUntil > Date.now();
  const upstreamStatus = isRateLimited
    ? 429
    : (diag?.upstreamStatus ?? 200);
  const retryAfterSec = isRateLimited
    ? Math.ceil((rateLimitUntil - Date.now()) / 1000)
    : (fail && fail.retryAt > Date.now() ? Math.ceil((fail.retryAt - Date.now()) / 1000) : 0);

  return {
    upstreamStatus,
    retryAfter: retryAfterSec,
    rateLimited: isRateLimited,
    lastError: isRateLimited
      ? formatUpstreamError(429)
      : (fail && fail.retryAt > Date.now() ? fail.message : (diag?.lastError || "")),
    nextSlotInMs: Math.max(0, nextUpstreamAt - Date.now())
  };
}

async function getResultForClient(uf, municipalityCode = "") {
  const key = registerViewerScope(uf, municipalityCode);
  const stored = cache.get(key);
  const fail = failures.get(key);
  const meta = getCollectorMeta(key);
  const snapshot = stored?.raw || history[key]?.current || null;
  const previous = history[key]?.previous || null;
  const hasActiveFailure = Boolean((fail && fail.retryAt > Date.now()) || meta.rateLimited);

  if (snapshot) {
    return {
      httpStatus: 200,
      payload: {
        snapshot,
        previous,
        timeline: Array.isArray(history[key]?.timeline) ? history[key].timeline : [],
        checkedAt: stored?.checkedAt || history[key]?.checkedAt || new Date().toISOString(),
        stale: hasActiveFailure,
        error: hasActiveFailure ? meta.lastError : "",
        upstreamStatus: meta.upstreamStatus,
        retryAfter: meta.retryAfter,
        collector: {
          cadenceSeconds: MIN_UPSTREAM_GAP_MS / 1000,
          collectorScope: collectorScopeKey,
          requestedScope: lastRequestedScopeKey,
          watchedScopes: getMonitoredScopes().length,
          rateLimited: meta.rateLimited,
          nextSlotInMs: meta.nextSlotInMs
        }
      }
    };
  }

  // Sem snapshot prévio: preserva e expõe o status HTTP original da origem (404, 429, 503, 504)
  const originStatus = [400, 404, 429, 502, 503, 504].includes(meta.upstreamStatus)
    ? meta.upstreamStatus
    : 503;
  return {
    httpStatus: originStatus,
    payload: {
      snapshot: null,
      previous: null,
      stale: true,
      error: meta.lastError || "Aguardando o coletor central consultar este recorte no próximo slot.",
      upstreamStatus: meta.upstreamStatus,
      retryAfter: meta.retryAfter || (MIN_UPSTREAM_GAP_MS / 1000),
      collector: {
        cadenceSeconds: MIN_UPSTREAM_GAP_MS / 1000,
        collectorScope: collectorScopeKey,
        requestedScope: lastRequestedScopeKey,
        watchedScopes: getMonitoredScopes().length,
        rateLimited: meta.rateLimited,
        nextSlotInMs: meta.nextSlotInMs
      }
    }
  };
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function safeStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const clean = path.normalize(decoded.replace(/^[/\\]+/, ""));
  const target = path.resolve(ROOT, clean || "index.html");
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  if (target === HISTORY_FILE || target.startsWith(DATA_DIR + path.sep)) return null;
  return target;
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url || "/", "http://" + (request.headers.host || "localhost"));
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "Allow": "GET, HEAD", "Cache-Control": "no-store" });
    return response.end();
  }
  const headOnly = request.method === "HEAD";
  if (requestUrl.pathname.startsWith("/api/") && headOnly) {
    response.writeHead(405, { "Allow": "GET", "Cache-Control": "no-store" });
    return response.end();
  }

  if (requestUrl.pathname === "/api/health") {
    const rateLimitUntil = getEffectiveRateLimitUntil();
    return sendJson(response, 200, {
      ok: true,
      service: "painel-tse-2026",
      election: ELECTION,
      collector: {
        collectorScope: collectorScopeKey,
        requestedScope: lastRequestedScopeKey,
        watchedScopeCount: getMonitoredScopes().length,
        schedulerRunning: Boolean(collectorInterval),
        tickMs: COLLECTOR_TICK_MS,
        minUpstreamGapMs: MIN_UPSTREAM_GAP_MS,
        inFlight: upstreamInFlightCount,
        nextSlotInMs: Math.max(0, nextUpstreamAt - Date.now()),
        rateLimitedUntil: rateLimitUntil > Date.now() ? new Date(rateLimitUntil).toISOString() : null,
        lastUpstreamEvent,
        ea14CheckedAt: ea14Record.checkedAt ? new Date(ea14Record.checkedAt).toISOString() : null,
        ea14Idg: ea14Record.idg || null
      }
    });
  }

  // Endpoint 100% passivo (somente leitura da memória/EA14/cache EA20; sem prefetch automático de UFs ausentes)
  if (requestUrl.pathname === "/api/states") {
    const items = [];
    for (const [uf, name] of UF_NAMES.entries()) {
      const raw = cache.get(uf)?.raw || history[uf]?.current || null;
      const ea14Entry = ea14Record.entries.get(uf) || null;
      const diag = scopeDiagnostics.get(uf) || null;

      if (!raw) {
        items.push({
          uf,
          name,
          leader: "neutral",
          votes13: 0,
          votes22: 0,
          validVotes: 0,
          sectionsDone: ea14Entry?.st ?? 0,
          sectionsTotal: ea14Entry?.ts ?? 0,
          andamento: ea14Entry?.and ?? "n",
          upstreamStatus: diag?.upstreamStatus || null
        });
        continue;
      }

      try {
        const totals = candidateTotals(raw);
        const votes13 = totals.get("13") || 0;
        const votes22 = totals.get("22") || 0;
        const validVotes = finiteNumber(raw.v?.vv) || 0;
        const rawSt = finiteNumber(raw.s?.st) || 0;
        const rawTs = finiteNumber(raw.s?.ts) || 0;
        const sectionsDone = Math.max(rawSt, ea14Entry?.st ?? 0);
        const sectionsTotal = rawTs || (ea14Entry?.ts ?? 0);
        const leader = (validVotes === 0 || (votes13 === 0 && votes22 === 0))
          ? "neutral"
          : (votes13 > votes22 ? "13" : (votes22 > votes13 ? "22" : "tie"));
        items.push({
          uf,
          name,
          leader,
          votes13,
          votes22,
          validVotes,
          sectionsDone,
          sectionsTotal,
          andamento: ea14Entry?.and || String(raw.and || "n").toLowerCase(),
          upstreamStatus: diag?.upstreamStatus || 200
        });
      } catch {
        items.push({
          uf,
          name,
          leader: "neutral",
          votes13: 0,
          votes22: 0,
          validVotes: 0,
          sectionsDone: ea14Entry?.st ?? 0,
          sectionsTotal: ea14Entry?.ts ?? 0,
          andamento: ea14Entry?.and ?? "n",
          upstreamStatus: diag?.upstreamStatus || null
        });
      }
    }
    return sendJson(response, 200, {
      items,
      ea14Idg: ea14Record.idg || null,
      ea14CheckedAt: ea14Record.checkedAt ? new Date(ea14Record.checkedAt).toISOString() : null
    });
  }

  if (requestUrl.pathname === "/api/municipalities") {
    const uf = String(requestUrl.searchParams.get("uf") || "br").toLowerCase();
    const query = String(requestUrl.searchParams.get("q") || "");
    if (!UFS.has(uf)) return sendJson(response, 400, { error: "UF inválida." });
    if (query.length > 80) return sendJson(response, 400, { error: "Busca muito longa." });
    try {
      return sendJson(response, 200, await searchMunicipalities(uf, query));
    } catch (error) {
      const status = Number(error?.status) || 503;
      return sendJson(response, status, {
        error: error.message || "Não foi possível ler o cadastro oficial de municípios.",
        upstreamStatus: status,
        retryAfter: Math.ceil((error.retryAfter || 0) / 1000)
      });
    }
  }

  if (requestUrl.pathname === "/api/results") {
    const uf = String(requestUrl.searchParams.get("uf") || "").toLowerCase();
    const municipalityCode = String(requestUrl.searchParams.get("mun") || "");

    if (!UFS.has(uf)) {
      return sendJson(response, 400, { error: "Abrangência inválida. Selecione Brasil, uma UF ou um município.", upstreamStatus: 400 });
    }
    if (municipalityCode && (!/^\d{5}$/.test(municipalityCode) || uf === "br")) {
      return sendJson(response, 400, { error: "Município inválido para a abrangência informada.", upstreamStatus: 400 });
    }

    try {
      const municipality = municipalityCode ? await verifyMunicipality(uf, municipalityCode) : null;
      const { httpStatus, payload } = await getResultForClient(uf, municipalityCode);
      return sendJson(response, httpStatus, {
        ...payload,
        location: municipality
          ? { type: "municipality", uf, code: municipality.code, name: municipality.name }
          : { type: uf === "br" ? "country" : "state", uf }
      });
    } catch (error) {
      const status = Number(error?.status) || 503;
      return sendJson(response, status, {
        error: error.message || "Não foi possível consultar o arquivo oficial.",
        upstreamStatus: status,
        retryAfter: Math.ceil((error.retryAfter || 15000) / 1000)
      });
    }
  }

  const target = safeStaticPath(requestUrl.pathname);
  if (!target) {
    response.writeHead(404, { "Cache-Control": "no-store" });
    return response.end("Not found");
  }
  let file = target;
  if (existsSync(file) && !path.extname(file) && existsSync(path.join(file, "index.html"))) {
    file = path.join(file, "index.html");
  }
  if (!existsSync(file)) {
    response.writeHead(404, { "Cache-Control": "no-store" });
    return response.end("Not found");
  }
  const ext = path.extname(file).toLowerCase();
  response.writeHead(200, {
    "Content-Type": MIME.get(ext) || "application/octet-stream",
    "Cache-Control": [".html", ".css", ".js"].includes(ext) ? "no-store" : "public, max-age=60",
    "X-Content-Type-Options": "nosniff"
  });
  if (headOnly) return response.end();
  createReadStream(file).pipe(response);
});

function startCollector() {
  if (collectorInterval) return;
  const tick = () => {
    runCollectorStep().catch(error => {
      process.stderr.write("[Coletor] Falha inesperada no ciclo: " + (error?.stack || error) + "\n");
    });
  };
  collectorInterval = setInterval(tick, COLLECTOR_TICK_MS);
  collectorInterval.unref?.();
  tick();
}

server.on("close", () => {
  if (collectorInterval) clearInterval(collectorInterval);
  collectorInterval = null;
});

server.listen(PORT, HOST, () => {
  process.stdout.write("Painel TSE disponível em http://" + HOST + ":" + PORT + " (coletor central: 1 req / 5s)\n");
  startCollector();
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
