(() => {
  "use strict";

  const CONFIG = Object.freeze({
    election: "6258",
    turn: "2",
    cargo: "1",
    api: "/api/results",
    statesApi: "/api/states",
    municipalitiesApi: "/api/municipalities",
    mapAsset: "assets/brazil-map.json",
    pollMs: 5000,
    requestTimeoutMs: 12000,
    candidates: Object.freeze({
      "13": Object.freeze({ name: "Lula", party: "PT" }),
      "22": Object.freeze({ name: "Flávio Bolsonaro", party: "PL" })
    })
  });

  const UF_NAMES = Object.freeze({
    ac:"Acre", al:"Alagoas", ap:"Amapá", am:"Amazonas", ba:"Bahia", ce:"Ceará",
    df:"Distrito Federal", es:"Espírito Santo", go:"Goiás", ma:"Maranhão", mt:"Mato Grosso",
    ms:"Mato Grosso do Sul", mg:"Minas Gerais", pa:"Pará", pb:"Paraíba", pr:"Paraná",
    pe:"Pernambuco", pi:"Piauí", rj:"Rio de Janeiro", rn:"Rio Grande do Norte",
    rs:"Rio Grande do Sul", ro:"Rondônia", rr:"Roraima", sc:"Santa Catarina",
    sp:"São Paulo", se:"Sergipe", to:"Tocantins"
  });

  const $ = id => document.getElementById(id);
  const integer = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
  const percent = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const view = {
    stateSelect: $("state-select"),
    municipalitySelect: $("municipality-select"),
    municipalityClear: $("municipality-clear"),
    municipalityNote: $("municipality-note"),
    sourceLink: $("source-link"),
    scopeLabel: $("scope-label"),
    scopeFile: $("scope-file"),
    scopeTrail: $("scope-Trail"),
    stageScopeBadge: $("stage-scope-badge"),
    chartScopePath: $("chart-scope-path"),
    statusStrip: document.querySelector(".live-strip"),
    statusLabel: $("status-label"),
    updatedLabel: $("updated-label"),
    countdownLabel: $("countdown-label"),
    bulletinReceivedLabel: $("bulletin-received-label"),
    pauseButton: $("pause-button"),
    resultState: $("result-state"),
    stateTitle: $("state-title"),
    stateMessage: $("state-message"),
    generationLabel: $("generation-label"),
    countingTitle: $("counting-title"),
    scoreboard: $("scoreboard"),
    comparisonKey: $("comparison-key"),
    tallyGrid: $("tally-grid"),
    voteBreakdown: $("vote-breakdown"),
    mathBanner: $("math-banner"),
    mathCopy: $("math-copy"),
    mathDetail: $("math-detail"),
    previousStrip: $("previous-strip"),
    brazilMap: $("brazil-map"),
    mapResetBtn: $("map-reset-btn"),
    mapCount13: $("map-count-13"),
    mapCount22: $("map-count-22"),
    mapCountNeutral: $("map-count-neutral"),
    mapInfoTitle: $("map-info-title"),
    mapInfoStatus: $("map-info-status"),
    mapInfoBadge: $("map-info-badge"),
    timelineCard: $("timeline-card"),
    timelineSvgMini: $("timeline-svg-mini"),
    tlMiniShare13: $("tl-mini-share-13"),
    tlMiniShare22: $("tl-mini-share-22"),
    tlMiniDiff: $("tl-mini-diff"),
    timelineMiniStatus: $("timeline-mini-status"),
    timelineModal: $("timeline-modal"),
    timelineModalScope: $("timeline-modal-scope"),
    timelineModeBadge: $("timeline-mode-badge"),
    timelineDemoToggle: $("timeline-demo-toggle"),
    timelineCloseBtn: $("timeline-close-btn"),
    timelineSvgExpanded: $("timeline-svg-expanded"),
    timelineHoverReadout: $("timeline-hover-readout"),
    timelineEndTag: $("timeline-end-tag"),
    tlExpShare13: $("tl-exp-share-13"),
    tlExpVotes13: $("tl-exp-votes-13"),
    tlExpShare22: $("tl-exp-share-22"),
    tlExpVotes22: $("tl-exp-votes-22"),
    tlRcp13: $("tl-rcp-13"),
    tlRcp22: $("tl-rcp-22"),
    tlRcpDiff13: $("tl-rcp-diff-13"),
    tlRcpDiff22: $("tl-rcp-diff-22"),
    timelineMilestonesList: $("timeline-milestones-list")
  };

  let scope = { uf: "br", municipalityCode: "", cityName: "" };
  let municipalityController = null;
  let municipalitySequence = 0;
  const stateMunicipalitiesCache = new Map();
  const stateStatusMap = new Map();
  const scopeTimelines = new Map();
  let timelineMarkerMins = 15; // Padrão recomendado: marcadores a cada 15 min
  let timelineYScale = "zoom"; // "zoom" (estilo g1/RCP) ou "full" (0-100%)
  let isTimelineDemo = false;
  let lastRenderedSnapshot = null;
  let hoveredUf = null;
  let timer = null;
  let countdownTimer = null;
  let countdown = 0;
  let isPaused = false;
  let isLoading = false;
  let requestEpoch = 0;
  let activeController = null;
  const inMemoryHistory = new Map();
  const HISTORY_PREFIX = "apuração-2026-6258-";
  const TALLY_START_BRT_ISO = "2026-10-25T17:00:00-03:00";
  const TALLY_START_MS = Date.parse(TALLY_START_BRT_ISO);
  const TALLY_MIN_WINDOW_MS = 4 * 60 * 60 * 1000; // Janela mínima 17h00 -> 21h00 BRT

  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } }
  };

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    let text = String(value).trim().replace(/%$/, "");
    if (!text) return null;
    if (text.includes(",") && text.includes(".")) text = text.replaceAll(".", "").replace(",", ".");
    else if (text.includes(",")) text = text.replace(",", ".");
    const result = Number(text);
    return Number.isFinite(result) ? result : null;
  }

  function scopeKey(target = scope) {
    return HISTORY_PREFIX + target.uf + (target.municipalityCode ? ":" + target.municipalityCode : "");
  }

  function officialUrl(target = scope) {
    const uf = target.uf === "br" ? "br" : target.uf;
    const locality = target.municipalityCode ? "mu/" + target.municipalityCode + "/" : "";
    return "https://resultados.tse.jus.br/oficial/app/index.html#/eleicao/" +
      CONFIG.election + "/uf/" + uf + "/" + locality + "cargo/" + CONFIG.cargo + "/vis/nominal/resultados";
  }

  function titleCaseCity(name) {
    return String(name || "")
      .toLocaleLowerCase("pt-BR")
      .replace(/(^|[\s'-])([\p{L}])/gu, (_, prefix, letter) => prefix + letter.toLocaleUpperCase("pt-BR"))
      .replace(/(?<=\s)(De|Da|Do|Das|Dos|E)(?=\s)/g, word => word.toLowerCase())
      .replace(/(^|\s)D(?=\x27)/g, (_, prefix) => prefix + "d");
  }

  function currentScopeLabel(target = scope) {
    if (target.municipalityCode && target.cityName) return target.cityName + ", " + target.uf.toUpperCase();
    if (target.uf === "br") return "Brasil";
    const name = UF_NAMES[target.uf];
    return name ? name + ", " + target.uf.toUpperCase() : target.uf.toUpperCase();
  }

  function currentScopeHierarchy(target = scope) {
    if (target.uf === "br") return "Brasil (País inteiro)";
    const stateName = UF_NAMES[target.uf] || target.uf.toUpperCase();
    if (target.municipalityCode && target.cityName) {
      return "Brasil → " + stateName + " → " + target.cityName;
    }
    return "Brasil → " + stateName;
  }

  function setCountingTitle(label) {
    const textNode = Array.from(view.countingTitle.childNodes).find(node => node.nodeType === Node.TEXT_NODE);
    if (textNode) textNode.nodeValue = label + " ";
  }

  function parseGeneration(day, time) {
    const rawDay = String(day || "").trim();
    const clock = String(time || "").trim();
    let year, month, date;
    let match = rawDay.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (match) [, date, month, year] = match;
    else {
      const compact = rawDay.replace(/\D/g, "");
      if (compact.length === 8) {
        if (Number(compact.slice(0, 4)) > 1900) [, year, month, date] = compact.match(/^(\d{4})(\d{2})(\d{2})$/) || [];
        else [, date, month, year] = compact.match(/^(\d{2})(\d{2})(\d{4})$/) || [];
      }
    }
    if (!year || !month || !date) return null;
    const timeMatch = clock.match(/^(\d{2}):?(\d{2}):?(\d{2})$/);
    const timePart = timeMatch ? timeMatch.slice(1).join(":") : "00:00:00";
    const parsed = new Date(year + "-" + month + "-" + date + "T" + timePart + "-03:00");
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  function flattenCandidates(data) {
    const result = [];
    for (const cargo of Array.isArray(data.carg) ? data.carg : []) {
      if (String(cargo.cd) !== CONFIG.cargo) continue;
      for (const group of Array.isArray(cargo.agr) ? cargo.agr : []) {
        for (const party of Array.isArray(group.par) ? group.par : []) {
          for (const candidate of Array.isArray(party.cand) ? party.cand : []) {
            const number = String(candidate.n ?? "").trim();
            if (!CONFIG.candidates[number]) continue;
            const votes = finiteNumber(candidate.vap);
            if (votes === null || votes < 0 || !Number.isInteger(votes)) {
              throw new Error("O arquivo do TSE trouxe uma quantidade de votos inválida.");
            }
            result.push({
              number,
              name: candidate.nmu || candidate.nm || CONFIG.candidates[number].name,
              party: party.sg || CONFIG.candidates[number].party,
              votes
            });
          }
        }
      }
    }
    return result;
  }

  function optionalCount(value, label) {
    const result = finiteNumber(value);
    if (result !== null && (result < 0 || !Number.isInteger(result))) {
      throw new Error("O campo " + label + " do arquivo oficial está inválido.");
    }
    return result;
  }

  function validateData(data, target = scope) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("O TSE respondeu com um arquivo vazio ou inválido.");
    if (String(data.ele ?? "") !== CONFIG.election) throw new Error("O arquivo pertence a outra eleição.");
    if (String(data.t ?? "") !== CONFIG.turn) throw new Error("O arquivo não pertence ao segundo turno.");
    if (String(data.f ?? "") !== "o") throw new Error("O arquivo não pertence à eleição presidencial federal.");
    const expectedType = target.municipalityCode ? "mu" : (target.uf === "br" ? "br" : "uf");
    const expectedRegion = target.municipalityCode || (target.uf === "br" ? "br" : target.uf);
    if (String(data.tpabr ?? "").toLowerCase() !== expectedType || String(data.cdabr ?? "").toLowerCase() !== expectedRegion) {
      throw new Error("A abrangência do arquivo não corresponde à localidade selecionada.");
    }
    if (data.idg === null || data.idg === undefined || String(data.idg).trim() === "") {
      throw new Error("O arquivo do TSE não trouxe o identificador de versão (IDG).");
    }

    const candidates = flattenCandidates(data);
    const lula = candidates.find(candidate => candidate.number === "13");
    const flavio = candidates.find(candidate => candidate.number === "22");
    if (!lula || !flavio) throw new Error("O arquivo não contém as duas candidaturas esperadas para o segundo turno.");

    const validVotes = optionalCount(data.v?.vv, "votos válidos");
    const sectionsDone = optionalCount(data.s?.st, "seções totalizadas");
    const sectionsTotal = optionalCount(data.s?.ts, "seções totais");
    const electorateTotal = optionalCount(data.e?.te, "eleitorado apto");
    const remainingElectors = optionalCount(data.e?.esnt, "eleitorado não apurado");
    if (validVotes === null || sectionsDone === null || sectionsTotal === null) {
      throw new Error("O arquivo do TSE está sem os totais necessários para validar o placar.");
    }
    if (sectionsDone > sectionsTotal) throw new Error("As seções totalizadas excedem o total previsto.");
    if (lula.votes + flavio.votes > validVotes) throw new Error("Os votos das candidaturas excedem o total de votos válidos.");
    if (electorateTotal !== null && remainingElectors !== null && remainingElectors > electorateTotal) {
      throw new Error("O eleitorado não apurado excede o total de eleitores aptos.");
    }

    return {
      idg: String(data.idg),
      generated: parseGeneration(data.dg, data.hg),
      checkedAt: new Date().toISOString(),
      votes: { "13": lula.votes, "22": flavio.votes },
      shares: {
        "13": validVotes > 0 ? 100 * lula.votes / validVotes : 0,
        "22": validVotes > 0 ? 100 * flavio.votes / validVotes : 0
      },
      validVotes,
      sectionsDone,
      sectionsTotal,
      electorateTotal,
      remainingElectors,
      blankVotes: optionalCount(data.v?.vb, "votos em branco"),
      nullVotes: optionalCount(data.v?.vn, "votos nulos"),
      annulledVotes: optionalCount(data.v?.van, "votos anulados"),
      turnout: optionalCount(data.e?.c, "comparecimento"),
      abstention: optionalCount(data.e?.a, "abstenção"),
      final: String(data.and || "n").toLowerCase() === "f",
      candidates: { "13": lula, "22": flavio }
    };
  }

  function safeSnapshot(value) {
    if (!value || typeof value !== "object" || typeof value.idg !== "string" || !value.votes || !value.shares || !value.candidates) return null;
    for (const number of ["13", "22"]) {
      if (!Number.isFinite(value.votes[number]) || !Number.isFinite(value.shares[number]) || !value.candidates[number]) return null;
    }
    if (!Number.isFinite(value.validVotes) || !Number.isFinite(value.sectionsDone) || !Number.isFinite(value.sectionsTotal)) return null;
    return value;
  }

  function readHistory() {
    const key = scopeKey();
    const memory = inMemoryHistory.get(key);
    if (memory) return memory;
    const saved = storage.get(key);
    if (!saved) return { current: null, previous: null };
    try {
      const parsed = JSON.parse(saved);
      return {
        current: safeSnapshot(parsed?.current),
        previous: safeSnapshot(parsed?.previous)
      };
    } catch {
      return { current: null, previous: null };
    }
  }

  function recordSnapshot(snapshot, sharedPrevious = null) {
    const old = readHistory();
    if (old.current?.idg === snapshot.idg) {
      const preserved = { current: snapshot, previous: sharedPrevious || old.previous };
      inMemoryHistory.set(scopeKey(), preserved);
      return preserved;
    }
    const previous = sharedPrevious || old.current || old.previous || null;
    const next = { current: snapshot, previous };
    inMemoryHistory.set(scopeKey(), next);
    storage.set(scopeKey(), JSON.stringify(next));
    return next;
  }

  function formatTime(iso) {
    if (!iso) return "horário não informado pelo TSE";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "horário não informado pelo TSE";
    return new Intl.DateTimeFormat("pt-BR", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
      timeZone: "America/Sao_Paulo"
    }).format(date).replace(".", "");
  }

  function formatBulletinTime(iso) {
    if (!iso) return "—";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23", timeZone: "America/Sao_Paulo"
    }).format(date) + " BRT";
  }

  function setResultState(title, message, kind = "wait") {
    view.resultState.hidden = false;
    view.resultState.dataset.kind = kind;
    view.stateTitle.textContent = title;
    view.stateMessage.textContent = message;
  }

  function status(mode, label) {
    view.statusStrip.dataset.state = mode;
    view.statusLabel.textContent = label;
  }

  function setMetric(id, value) {
    $(id).textContent = value === null || value === undefined ? "—" : integer.format(value);
  }

  function showUnavailable(message, title = "Arquivo oficial indisponível") {
    const history = readHistory();
    if (history.current) {
      renderSnapshot(history.current, history.previous, { stale: true, message });
      status("error", "Última leitura válida");
    } else {
      view.scoreboard.hidden = true;
      view.comparisonKey.hidden = true;
      view.tallyGrid.hidden = true;
      view.voteBreakdown.hidden = true;
      view.mathBanner.hidden = true;
      view.previousStrip.hidden = true;
      setResultState(title, message, "error");
      status("error", "Sem leitura oficial");
      view.updatedLabel.textContent = "Nenhuma leitura oficial carregada";
      view.generationLabel.textContent = "Aguardando um arquivo válido para " + currentScopeLabel() + ".";
    }
  }

  function getLeader(snapshot) {
    if (snapshot.votes["13"] > snapshot.votes["22"]) return "13";
    if (snapshot.votes["22"] > snapshot.votes["13"]) return "22";
    return "tie";
  }

  function getMathWinner(snapshot) {
    const remaining = snapshot.remainingElectors;
    if (remaining === null || snapshot.final) return null;
    const a = snapshot.votes["13"], b = snapshot.votes["22"];
    if (a > b + remaining) return "13";
    if (b > a + remaining) return "22";
    return null;
  }

  function describeMovement(current, previous) {
    const oldLeader = getLeader(previous);
    const newLeader = getLeader(current);
    const leadChange = previous.validVotes > 0 && current.validVotes > 0 && oldLeader !== newLeader
      ? (oldLeader === "tie" ? "O empate foi desfeito" : "A liderança mudou de " + CONFIG.candidates[oldLeader].name + " para " + CONFIG.candidates[newLeader].name) + ". "
      : "";
    const changes = ["13", "22"].map(number => ({
      number,
      name: CONFIG.candidates[number].name,
      delta: current.shares[number] - previous.shares[number],
      votes: current.votes[number] - previous.votes[number]
    }));
    const visible = changes.filter(item => Math.abs(item.delta) >= 0.005 || item.votes !== 0);
    if (!visible.length) return leadChange + "A votação não mudou desde a parcial anterior.";
    return leadChange + visible.map(item => {
      const direction = item.delta > 0.004 ? "subiu" : item.delta < -0.004 ? "recuou" : "manteve";
      const signed = item.delta > 0.004 ? "+" : "";
      return item.name + " " + direction + " " + signed + percent.format(item.delta) +
        " p.p. (" + (item.votes >= 0 ? "+" : "") + integer.format(item.votes) + " votos)";
    }).join("; ") + " desde a versão anterior.";
  }

  /* ==========================================================================
     MAPA INTERATIVO DO BRASIL POR ESTADO (27 UFs)
     ========================================================================== */
  function updateMapInfoBar(uf = hoveredUf || (scope.uf !== "br" ? scope.uf : null)) {
    if (!view.mapInfoTitle || !view.mapInfoStatus || !view.mapInfoBadge) return;
    if (!uf || uf === "br") {
      view.mapInfoTitle.textContent = "Brasil · 27 Unidades da Federação";
      view.mapInfoStatus.textContent = "Clique em qualquer estado no mapa para filtrar o resultado e listar suas cidades.";
      view.mapInfoBadge.textContent = "PAÍS";
      delete view.mapInfoBadge.dataset.leader;
      return;
    }
    const name = UF_NAMES[uf] || uf.toUpperCase();
    const info = stateStatusMap.get(uf);
    view.mapInfoTitle.textContent = name + " (" + uf.toUpperCase() + ")";
    if (!info || info.leader === "neutral" || info.validVotes === 0) {
      const secText = info?.sectionsTotal
        ? " · 0 de " + integer.format(info.sectionsTotal) + " seções"
        : "";
      view.mapInfoStatus.textContent = "Aguardando abertura das urnas neste estado" + secText + ".";
      view.mapInfoBadge.textContent = "NEUTRO";
      delete view.mapInfoBadge.dataset.leader;
    } else {
      const share13 = info.validVotes > 0 ? 100 * info.votes13 / info.validVotes : 0;
      const share22 = info.validVotes > 0 ? 100 * info.votes22 / info.validVotes : 0;
      const secPct = info.sectionsTotal > 0 ? 100 * info.sectionsDone / info.sectionsTotal : 0;
      view.mapInfoStatus.textContent =
        "Lula " + percent.format(share13) + "% × Flávio " + percent.format(share22) + "% · " +
        percent.format(secPct) + "% das seções";
      if (info.leader === "13") {
        view.mapInfoBadge.textContent = "LULA NA FRENTE";
        view.mapInfoBadge.dataset.leader = "13";
      } else if (info.leader === "22") {
        view.mapInfoBadge.textContent = "FLÁVIO NA FRENTE";
        view.mapInfoBadge.dataset.leader = "22";
      } else {
        view.mapInfoBadge.textContent = "EMPATE";
        delete view.mapInfoBadge.dataset.leader;
      }
    }
  }

  function applyMapVisualState() {
    if (!view.brazilMap) return;
    let count13 = 0, count22 = 0, countNeutral = 0;
    for (const uf of Object.keys(UF_NAMES)) {
      const info = stateStatusMap.get(uf);
      const leader = info?.leader || "neutral";
      if (leader === "13") count13 += 1;
      else if (leader === "22") count22 += 1;
      else countNeutral += 1;
    }
    if (view.mapCount13) view.mapCount13.textContent = String(count13);
    if (view.mapCount22) view.mapCount22.textContent = String(count22);
    if (view.mapCountNeutral) view.mapCountNeutral.textContent = String(countNeutral);

    const paths = view.brazilMap.querySelectorAll(".map-state");
    paths.forEach(path => {
      const uf = path.dataset.uf;
      const info = stateStatusMap.get(uf);
      const leader = info?.leader || "neutral";
      path.dataset.leader = leader;
      const isSelected = scope.uf === uf;
      path.classList.toggle("is-selected", isSelected);
      path.setAttribute("aria-pressed", String(isSelected));
    });

    if (view.mapResetBtn) {
      view.mapResetBtn.hidden = scope.uf === "br";
    }
    updateMapInfoBar();
  }

  async function refreshStatesSummary() {
    try {
      const response = await fetch(CONFIG.statesApi, {
        method: "GET",
        cache: "no-store",
        headers: { "Accept": "application/json" }
      });
      if (!response.ok) return;
      const payload = await response.json().catch(() => null);
      if (isPaused || !Array.isArray(payload?.items)) return;
      for (const item of payload.items) {
        if (item && item.uf) {
          stateStatusMap.set(item.uf, item);
        }
      }
      applyMapVisualState();
    } catch {
      // Silencioso; o mapa preserva o estado atual.
    }
  }

  function handleMapStateClick(uf) {
    if (!UF_NAMES[uf]) return;
    if (scope.uf === uf && !scope.municipalityCode) {
      // Clicar novamente no mesmo estado volta para o Brasil inteiro
      view.stateSelect.value = "br";
      applyState();
      return;
    }
    view.stateSelect.value = uf;
    applyState();
  }

  async function initBrazilMap() {
    if (!view.brazilMap) return;
    try {
      const response = await fetch(CONFIG.mapAsset, { cache: "force-cache" });
      if (!response.ok) return;
      const mapData = await response.json();
      if (!Array.isArray(mapData?.locations)) return;

      const svgNs = "http://www.w3.org/2000/svg";
      view.brazilMap.replaceChildren();
      const pathsGroup = document.createElementNS(svgNs, "g");
      const labelsGroup = document.createElementNS(svgNs, "g");

      for (const loc of mapData.locations) {
        const uf = String(loc.id || "").toLowerCase();
        if (!UF_NAMES[uf]) continue;
        const path = document.createElementNS(svgNs, "path");
        path.setAttribute("d", loc.path);
        path.setAttribute("class", "map-state");
        path.dataset.uf = uf;
        path.dataset.leader = "neutral";
        path.setAttribute("tabindex", "0");
        path.setAttribute("role", "button");
        path.setAttribute("aria-label", UF_NAMES[uf] + " (" + uf.toUpperCase() + ")");
        path.setAttribute("aria-pressed", "false");

        path.addEventListener("click", () => handleMapStateClick(uf));
        path.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            handleMapStateClick(uf);
          }
        });
        path.addEventListener("mouseenter", () => {
          hoveredUf = uf;
          updateMapInfoBar(uf);
        });
        path.addEventListener("focus", () => {
          hoveredUf = uf;
          updateMapInfoBar(uf);
        });
        path.addEventListener("mouseleave", () => {
          hoveredUf = null;
          updateMapInfoBar();
        });
        path.addEventListener("blur", () => {
          hoveredUf = null;
          updateMapInfoBar();
        });

        pathsGroup.append(path);
      }

      view.brazilMap.append(pathsGroup, labelsGroup);

      // Posiciona as siglas das UFs no centro geométrico de cada estado
      requestAnimationFrame(() => {
        const labelOffsets = {
          df: { dx: 0, dy: -2 },
          rn: { dx: 8, dy: -4 },
          pb: { dx: 10, dy: 1 },
          pe: { dx: 10, dy: 4 },
          al: { dx: 10, dy: 5 },
          se: { dx: 9, dy: 6 },
          es: { dx: 7, dy: 2 },
          rj: { dx: 6, dy: 5 },
          ac: { dx: 0, dy: 2 }
        };
        pathsGroup.querySelectorAll(".map-state").forEach(path => {
          try {
            const uf = path.dataset.uf;
            const bbox = path.getBBox();
            if (!bbox || bbox.width === 0) return;
            const text = document.createElementNS(svgNs, "text");
            const offset = labelOffsets[uf] || { dx: 0, dy: 0 };
            text.setAttribute("x", String(Math.round(bbox.x + bbox.width / 2 + offset.dx)));
            text.setAttribute("y", String(Math.round(bbox.y + bbox.height / 2 + offset.dy)));
            text.setAttribute("class", "map-state-label");
            text.textContent = uf.toUpperCase();
            labelsGroup.append(text);
          } catch {
            // Ignora caso o SVG esteja oculto no momento
          }
        });
      });

      applyMapVisualState();
      refreshStatesSummary();
    } catch {
      // Falha silenciosa caso o asset do mapa não carregue
    }
  }

  function renderSnapshot(snapshot, previous, options = {}) {
    view.resultState.hidden = true;
    if (view.bulletinReceivedLabel) {
      view.bulletinReceivedLabel.textContent = formatBulletinTime(snapshot.bulletinReceivedAt);
    }
    if (options.message) setResultState(
      options.stale ? "Última leitura válida preservada" : "Dados oficiais validados",
      options.message,
      options.stale ? "error" : "ok"
    );

    const waitingForPolls = snapshot.sectionsDone === 0 && snapshot.validVotes === 0 && !snapshot.final;
    view.scoreboard.hidden = false;
    view.comparisonKey.hidden = false;
    view.tallyGrid.hidden = false;
    view.voteBreakdown.hidden = false;
    view.scoreboard.setAttribute("data-leader", getLeader(snapshot));
    updateScopeLabel();

    // Se estivermos visualizando um Estado específico, sincroniza imediatamente a cor dele no mapa
    if (scope.uf !== "br" && !scope.municipalityCode) {
      const stLeader = (snapshot.validVotes === 0 || (snapshot.votes["13"] === 0 && snapshot.votes["22"] === 0))
        ? "neutral"
        : getLeader(snapshot);
      stateStatusMap.set(scope.uf, {
        uf: scope.uf,
        name: UF_NAMES[scope.uf] || scope.uf.toUpperCase(),
        leader: stLeader,
        votes13: snapshot.votes["13"],
        votes22: snapshot.votes["22"],
        validVotes: snapshot.validVotes,
        sectionsDone: snapshot.sectionsDone,
        sectionsTotal: snapshot.sectionsTotal
      });
      applyMapVisualState();
    }

    const leader = waitingForPolls ? "tie" : getLeader(snapshot);
    for (const number of ["13", "22"]) {
      const card = $("candidate-" + number);
      const candidate = snapshot.candidates[number];
      const candidateName = titleCaseCity(candidate.name || CONFIG.candidates[number].name) === "Flavio Bolsonaro"
        ? "Flávio Bolsonaro"
        : titleCaseCity(candidate.name || CONFIG.candidates[number].name);
      card.classList.toggle("is-leader", leader === number);
      card.dataset.empty = waitingForPolls ? "true" : "false";
      $("name-" + number).textContent = candidateName;
      $("party-" + number).textContent = candidate.party || CONFIG.candidates[number].party;
      const posEl = $("position-" + number);
      if (waitingForPolls || leader !== number) {
        posEl.textContent = "";
        posEl.hidden = true;
      } else {
        posEl.hidden = false;
        posEl.textContent = "✓";
      }
      $("votes-" + number).textContent = integer.format(snapshot.votes[number]);
      $("share-" + number).textContent = percent.format(snapshot.shares[number]) + "%";
      card.setAttribute("aria-label", candidateName + ", candidatura " +
        number + ", " + integer.format(snapshot.votes[number]) + " votos, " +
        percent.format(snapshot.shares[number]) + " por cento dos votos válidos" +
        (leader === number ? ", na frente" : ""));

      const deltaElement = $("delta-" + number);
      if (!previous || waitingForPolls) {
        deltaElement.textContent = "";
        deltaElement.dataset.direction = "flat";
      } else {
        const delta = snapshot.shares[number] - previous.shares[number];
        const deltaVotes = snapshot.votes[number] - previous.votes[number];
        const direction = delta > 0.004 ? "up" : delta < -0.004 ? "down" : "flat";
        const prefix = direction === "up" ? "↑ " : direction === "down" ? "↓ " : "— ";
        deltaElement.textContent = prefix + percent.format(delta) + " p.p. (" +
          (deltaVotes >= 0 ? "+" : "") + integer.format(deltaVotes) + ")";
        deltaElement.dataset.direction = direction;
      }
    }

    // Atualização da Barra Compartilhada em Tempo Real (Lula x Flávio)
    const sumVotes = snapshot.votes["13"] + snapshot.votes["22"];
    const share13 = sumVotes ? 100 * snapshot.votes["13"] / sumVotes : 50;
    const share22 = sumVotes ? 100 - share13 : 50;
    $("comparison-bar-13").style.width = share13 + "%";
    $("comparison-bar-22").style.width = share22 + "%";
    if ($("comparison-caption")) {
      $("comparison-caption").textContent =
        percent.format(snapshot.shares["13"]) + "% Lula · " + percent.format(snapshot.shares["22"]) + "% Flávio";
    }

    if ($("chart-valid-votes")) $("chart-valid-votes").textContent = integer.format(snapshot.validVotes);
    if ($("chart-share-13")) $("chart-share-13").textContent = percent.format(snapshot.shares["13"]) + "%";
    if ($("chart-votes-13")) $("chart-votes-13").textContent = integer.format(snapshot.votes["13"]) + " votos";
    if ($("chart-share-22")) $("chart-share-22").textContent = percent.format(snapshot.shares["22"]) + "%";
    if ($("chart-votes-22")) $("chart-votes-22").textContent = integer.format(snapshot.votes["22"]) + " votos";

    const diffVotes = Math.abs(snapshot.votes["13"] - snapshot.votes["22"]);
    if ($("chart-vote-diff")) {
      if (sumVotes === 0) {
        $("chart-vote-diff").textContent = "Aguardando abertura das urnas neste recorte";
      } else if (diffVotes === 0) {
        $("chart-vote-diff").textContent = "Empate exato em votos";
      } else {
        const frontName = snapshot.votes["13"] > snapshot.votes["22"] ? "Lula" : "Flávio Bolsonaro";
        $("chart-vote-diff").textContent = "Vantagem de " + frontName + ": +" + integer.format(diffVotes) + " votos";
      }
    }

    const sectionsPctNum = snapshot.sectionsTotal ? 100 * snapshot.sectionsDone / snapshot.sectionsTotal : 0;
    const sectionsPctFormatted = percent.format(sectionsPctNum) + "%";
    const sectionsWidth = (snapshot.sectionsTotal ? Math.min(100, sectionsPctNum) : 0) + "%";

    if ($("chart-sections-summary")) {
      $("chart-sections-summary").textContent = sectionsPctFormatted + " apurado (" +
        integer.format(snapshot.sectionsDone) + " de " + integer.format(snapshot.sectionsTotal) + " seções)";
    }
    if ($("chart-sections-meter")) {
      $("chart-sections-meter").style.width = sectionsWidth;
    }

    $("sections-count").innerHTML = integer.format(snapshot.sectionsDone) + " <small>de " + integer.format(snapshot.sectionsTotal) + "</small>";
    $("sections-percent").textContent = sectionsPctFormatted + " das seções";
    $("sections-meter").style.width = sectionsWidth;
    setMetric("valid-votes", snapshot.validVotes);
    setMetric("electorate-total", snapshot.electorateTotal);
    setMetric("turnout-count", snapshot.turnout);
    setMetric("abstention-count", snapshot.abstention);
    setMetric("blank-votes", snapshot.blankVotes);
    setMetric("null-votes", snapshot.nullVotes);
    setMetric("annulled-votes", snapshot.annulledVotes);
    setMetric("remaining-voters", snapshot.remainingElectors);

    view.updatedLabel.textContent = snapshot.generated
      ? "Arquivo do TSE gerado em " + formatTime(snapshot.generated)
      : "Leitura consultada às " + formatTime(options.checkedAt || snapshot.checkedAt);
    view.generationLabel.textContent = snapshot.final
      ? "Totalização final informada pelo TSE"
      : waitingForPolls ? "Aguardando a primeira parcial oficial" : "Parcial oficial · apuração em andamento";

    const winner = getMathWinner(snapshot);
    if (snapshot.final && scope.uf === "br" && leader !== "tie") {
      view.mathBanner.hidden = false;
      view.mathBanner.classList.add("is-final");
      view.mathCopy.textContent = CONFIG.candidates[leader].name + " confirmado na totalização final nacional";
      view.mathDetail.textContent = "A abrangência Brasil informa a conclusão da totalização.";
    } else if (winner) {
      view.mathBanner.hidden = false;
      view.mathBanner.classList.remove("is-final");
      view.mathCopy.textContent = "Vitória matematicamente garantida para " + CONFIG.candidates[winner].name;
      view.mathDetail.textContent = (scope.uf === "br" ? "No Brasil: " : "Em " + currentScopeLabel() + ": ") +
        integer.format(snapshot.votes[winner]) + " votos contra " +
        integer.format(snapshot.votes[winner === "13" ? "22" : "13"]) +
        "; restam " + integer.format(snapshot.remainingElectors) + " eleitores.";
    } else {
      view.mathBanner.hidden = true;
      view.mathBanner.classList.remove("is-final");
    }

    if (previous && !waitingForPolls) {
      view.previousStrip.hidden = false;
      $("previous-time").textContent = formatTime(previous.generated || previous.checkedAt);
      $("previous-summary").textContent = describeMovement(snapshot, previous);
    } else {
      view.previousStrip.hidden = true;
    }

    if (view.timelineCard) view.timelineCard.hidden = false;
    lastRenderedSnapshot = snapshot;
    recordLocalTimelinePoint(snapshot);
    renderTimelineCharts(snapshot);

    if (snapshot.final) status("live", "Totalização final do Brasil");
    else if (options.stale) status("error", "Leitura preservada · dados antigos");
    else if (isPaused) status("paused", "Atualização pausada");
    else if (waitingForPolls) status("wait", "Aguardando parcial oficial");
    else status("live", "Acompanhamento oficial ativo");
  }

  /* ==========================================================================
     MAPA GRÁFICO TEMPORAL (17H00 BRASÍLIA -> FIM DA VOTAÇÃO)
     ========================================================================== */

  function timelineStorageKey(target = scope) {
    return scopeKey(target) + ":timeline";
  }

  function formatBrtClock(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "17:00";
    return new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Sao_Paulo"
    }).format(d);
  }

  function formatBrtClockSeconds(ms) {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "17:00:00";
    return new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZone: "America/Sao_Paulo"
    }).format(d);
  }

  function getScopeTimeline(target = scope) {
    const k = timelineStorageKey(target);
    if (scopeTimelines.has(k)) return scopeTimelines.get(k);
    const raw = storage.get(k);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          scopeTimelines.set(k, parsed);
          return parsed;
        }
      } catch {
        // Ignora falha de leitura local
      }
    }
    const empty = [];
    scopeTimelines.set(k, empty);
    return empty;
  }

  function mergeServerTimeline(target, serverList) {
    if (!Array.isArray(serverList) || !serverList.length) return;
    const k = timelineStorageKey(target);
    const current = getScopeTimeline(target);
    const byKey = new Map();
    for (const pt of [...current, ...serverList]) {
      if (!pt || typeof pt !== "object") continue;
      const sig = String(pt.idg || "") + "|" + String(pt.sectionsDone ?? 0) + "|" + String(pt.votes13 ?? 0) + "|" + String(pt.votes22 ?? 0);
      byKey.set(sig, pt);
    }
    const merged = Array.from(byKey.values()).sort((a, b) => {
      const ta = Date.parse(a.at || a.checkedAt || "") || 0;
      const tb = Date.parse(b.at || b.checkedAt || "") || 0;
      return ta - tb;
    }).slice(-720);
    scopeTimelines.set(k, merged);
    storage.set(k, JSON.stringify(merged));
  }

  function recordLocalTimelinePoint(snapshot, target = scope) {
    if (!snapshot) return;
    const k = timelineStorageKey(target);
    const list = getScopeTimeline(target);
    const pt = {
      idg: String(snapshot.idg || ""),
      at: snapshot.generated || snapshot.checkedAt || new Date().toISOString(),
      checkedAt: snapshot.checkedAt || new Date().toISOString(),
      votes13: snapshot.votes["13"] || 0,
      votes22: snapshot.votes["22"] || 0,
      validVotes: snapshot.validVotes || 0,
      share13: snapshot.shares["13"] || 0,
      share22: snapshot.shares["22"] || 0,
      sectionsDone: snapshot.sectionsDone || 0,
      sectionsTotal: snapshot.sectionsTotal || 0,
      sectionsPct: snapshot.sectionsTotal ? (100 * snapshot.sectionsDone / snapshot.sectionsTotal) : 0,
      final: Boolean(snapshot.final)
    };
    const last = list[list.length - 1];
    if (last && last.idg === pt.idg && last.votes13 === pt.votes13 &&
        last.votes22 === pt.votes22 && last.sectionsDone === pt.sectionsDone) {
      return;
    }
    list.push(pt);
    const trimmed = list.slice(-720);
    scopeTimelines.set(k, trimmed);
    storage.set(k, JSON.stringify(trimmed));
  }

  // Gera curva demonstrativa realista (17h00 -> 20h45 BRT) apenas quando o botão "Prévia visual" está ativo
  function buildDemoTimelineSeries(totalSections = 499248) {
    const rawCurve = [
      { min: 0,   s13: 46.2, s22: 53.8, pctSec: 1.4 },
      { min: 15,  s13: 46.8, s22: 53.2, pctSec: 6.2 },
      { min: 30,  s13: 47.5, s22: 52.5, pctSec: 14.8 },
      { min: 45,  s13: 48.1, s22: 51.9, pctSec: 25.4 },
      { min: 60,  s13: 48.7, s22: 51.3, pctSec: 38.0 },
      { min: 75,  s13: 49.2, s22: 50.8, pctSec: 51.2 },
      { min: 90,  s13: 49.7, s22: 50.3, pctSec: 63.5 },
      { min: 105, s13: 50.1, s22: 49.9, pctSec: 74.1 }, // Virada às 18h45 BRT
      { min: 120, s13: 50.4, s22: 49.6, pctSec: 82.8 },
      { min: 135, s13: 50.6, s22: 49.4, pctSec: 89.4 },
      { min: 150, s13: 50.7, s22: 49.3, pctSec: 94.2 },
      { min: 165, s13: 50.8, s22: 49.2, pctSec: 97.1 },
      { min: 180, s13: 50.85, s22: 49.15, pctSec: 98.8 },
      { min: 195, s13: 50.88, s22: 49.12, pctSec: 99.5 },
      { min: 210, s13: 50.90, s22: 49.10, pctSec: 99.9 },
      { min: 225, s13: 50.90, s22: 49.10, pctSec: 100.0 }
    ];
    return rawCurve.map((item, idx) => {
      const ms = TALLY_START_MS + item.min * 60 * 1000;
      const validVotes = Math.round((item.pctSec / 100) * 118500000);
      const votes13 = Math.round(validVotes * (item.s13 / 100));
      const votes22 = validVotes - votes13;
      const sectionsDone = Math.round((item.pctSec / 100) * totalSections);
      return {
        idg: "DEMO-" + (idx + 1),
        ms,
        at: new Date(ms).toISOString(),
        votes13,
        votes22,
        validVotes,
        share13: item.s13,
        share22: item.s22,
        sectionsDone,
        sectionsTotal: totalSections,
        sectionsPct: item.pctSec,
        final: item.pctSec >= 100
      };
    });
  }

  function prepareNormalizedSeries(snapshot) {
    if (isTimelineDemo) {
      return {
        points: buildDemoTimelineSeries(snapshot?.sectionsTotal || 499248),
        waiting: false,
        startMs: TALLY_START_MS,
        endMs: TALLY_START_MS + TALLY_MIN_WINDOW_MS
      };
    }

    const rawList = getScopeTimeline(scope);
    const withVotes = rawList
      .filter(pt => (pt.validVotes > 0) || (pt.votes13 + pt.votes22 > 0))
      .map(pt => {
        const parsedMs = Date.parse(pt.checkedAt || pt.at || "") || TALLY_START_MS;
        const ms = Math.max(TALLY_START_MS, parsedMs);
        return { ...pt, ms };
      })
      .sort((a, b) => a.ms - b.ms);

    if (!withVotes.length) {
      return {
        points: [],
        waiting: true,
        startMs: TALLY_START_MS,
        endMs: TALLY_START_MS + TALLY_MIN_WINDOW_MS
      };
    }

    // Se houver apenas 1 leitura com votos, ancora o início em 17h00 BRT para traçar o segmento horizontal inicial
    let points = withVotes;
    if (points.length === 1) {
      const first = points[0];
      const anchorMs = Math.min(first.ms, TALLY_START_MS);
      const secondMs = Math.max(first.ms, anchorMs + 5 * 60 * 1000);
      points = [
        { ...first, ms: anchorMs },
        { ...first, ms: secondMs }
      ];
    }

    const lastMs = points[points.length - 1].ms;
    const endMs = Math.max(TALLY_START_MS + TALLY_MIN_WINDOW_MS, lastMs + 15 * 60 * 1000);
    return {
      points,
      waiting: false,
      startMs: TALLY_START_MS,
      endMs
    };
  }

  function computeYBounds(points, mode) {
    if (mode === "full" || !points.length) {
      return { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] };
    }
    let minVal = 50;
    let maxVal = 50;
    for (const p of points) {
      minVal = Math.min(minVal, p.share13, p.share22);
      maxVal = Math.max(maxVal, p.share13, p.share22);
    }
    const maxDeviation = Math.max(4, Math.ceil(Math.max(50 - minVal, maxVal - 50) + 1.5));
    const halfSpan = Math.min(50, Math.ceil(maxDeviation / 2) * 2);
    const yMin = Math.max(0, 50 - halfSpan);
    const yMax = Math.min(100, 50 + halfSpan);
    const step = halfSpan / 2;
    return {
      min: yMin,
      max: yMax,
      ticks: [yMin, 50 - step, 50, 50 + step, yMax]
    };
  }

  function renderTimelineSvg(svgEl, series, options = {}) {
    if (!svgEl) return;
    const isExpanded = Boolean(options.expanded);
    const width = isExpanded ? 920 : 560;
    const height = isExpanded ? 360 : 128;
    const padLeft = isExpanded ? 46 : 30;
    const padRight = isExpanded ? 118 : 14;
    const padTop = isExpanded ? 20 : 12;
    const padBottom = isExpanded ? 34 : 22;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const { points, waiting, startMs, endMs } = series;
    const spanMs = Math.max(60 * 1000, endMs - startMs);
    const yBounds = computeYBounds(points, isExpanded ? timelineYScale : "zoom");

    const xOf = ms => padLeft + Math.max(0, Math.min(1, (ms - startMs) / spanMs)) * plotW;
    const yOf = val => padTop + (1 - (val - yBounds.min) / Math.max(1, yBounds.max - yBounds.min)) * plotH;

    const parts = [];

    // Definições de gradiente para as duas curvas (Lula Vermelho x Flávio Verde)
    parts.push(
      `<defs>
        <linearGradient id="tlGradLula-${isExpanded ? "exp" : "mini"}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#e03e3e" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#e03e3e" stop-opacity="0.0"/>
        </linearGradient>
        <linearGradient id="tlGradFlavio-${isExpanded ? "exp" : "mini"}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#22a858" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#22a858" stop-opacity="0.0"/>
        </linearGradient>
      </defs>`
    );

    // Linhas horizontais de grade + linha central de 50%
    const yTicks = isExpanded ? yBounds.ticks : [yBounds.min, 50, yBounds.max];
    for (const tickVal of yTicks) {
      const y = yOf(tickVal).toFixed(1);
      const isMid = Math.abs(tickVal - 50) < 0.01;
      parts.push(
        `<line x1="${padLeft}" y1="${y}" x2="${padLeft + plotW}" y2="${y}" stroke="${isMid ? "rgba(255,255,255,0.28)" : "rgba(255,255,255,0.07)"}" stroke-width="${isMid ? "1.3" : "1"}" ${isMid ? 'stroke-dasharray="4 4"' : ""}/>`
      );
      parts.push(
        `<text x="${padLeft - 6}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end" fill="${isMid ? "#e8b84b" : "#6c7486"}" font-family="DM Sans, sans-serif" font-size="${isExpanded ? "10" : "8.5"}" font-weight="${isMid ? "700" : "600"}">${Math.round(tickVal)}%</text>`
      );
    }

    // Marcadores verticais de tempo no eixo X (iniciando às 17h00 Horário de Brasília)
    const tickIntervalMins = isExpanded ? (timelineMarkerMins > 0 ? Math.max(15, timelineMarkerMins) : 15) : 30;
    const tickStepMs = tickIntervalMins * 60 * 1000;
    for (let t = startMs; t <= endMs + 1000; t += tickStepMs) {
      const x = xOf(t).toFixed(1);
      const isStart = t === startMs;
      const isEnd = Math.abs(t - endMs) <= 60 * 1000;
      parts.push(
        `<line x1="${x}" y1="${padTop}" x2="${x}" y2="${padTop + plotH}" stroke="${isStart ? "rgba(232,184,75,0.35)" : "rgba(255,255,255,0.05)"}" stroke-width="1"/>`
      );
      const minsFromStart = Math.round((t - startMs) / 60000);
      const showLabel = isExpanded ? (minsFromStart % 30 === 0 || tickIntervalMins >= 30 || isEnd) : (minsFromStart % 60 === 0 || isStart || isEnd);
      if (showLabel) {
        const anchor = isStart ? "start" : isEnd ? "end" : "middle";
        const labelText = isEnd && isExpanded ? `${formatBrtClock(t)} · Fim` : formatBrtClock(t);
        parts.push(
          `<text x="${x}" y="${height - (isExpanded ? 10 : 5)}" text-anchor="${anchor}" fill="${isStart ? "#e8b84b" : "#6c7486"}" font-family="DM Sans, sans-serif" font-size="${isExpanded ? "10" : "8.5"}" font-weight="${isStart || isEnd ? "700" : "600"}">${labelText}</text>`
        );
      }
    }

    if (waiting || !points.length) {
      // Estado inicial antes das primeiras urnas: ponto de partida às 17h00 em 50%
      const yMid = yOf(50).toFixed(1);
      const waitMsg = isExpanded
        ? "Aguardando abertura das urnas às 17h00 (Brasília) · a curva avança na horizontal a cada parcial"
        : "Aguardando abertura das urnas às 17h00 (Horário de Brasília)";
      parts.push(
        `<circle cx="${padLeft}" cy="${yMid}" r="${isExpanded ? "5" : "4"}" fill="#e8b84b" stroke="#0b0e14" stroke-width="2"/>`,
        `<text x="${padLeft + plotW / 2}" y="${(Number(yMid) - (isExpanded ? 14 : 8)).toFixed(1)}" text-anchor="middle" fill="#9ea6b8" font-family="DM Sans, sans-serif" font-size="${isExpanded ? "12" : "9.5"}" font-weight="600">${waitMsg}</text>`
      );
      svgEl.innerHTML = parts.join("");
      return;
    }

    // Constrói polilinhas horizontais crescentes para Lula (13) e Flávio (22)
    const coords13 = points.map(p => ({ x: xOf(p.ms), y: yOf(p.share13), p }));
    const coords22 = points.map(p => ({ x: xOf(p.ms), y: yOf(p.share22), p }));
    const path13 = coords13.map((c, i) => (i === 0 ? "M" : "L") + c.x.toFixed(1) + "," + c.y.toFixed(1)).join(" ");
    const path22 = coords22.map((c, i) => (i === 0 ? "M" : "L") + c.x.toFixed(1) + "," + c.y.toFixed(1)).join(" ");

    const y50 = yOf(50).toFixed(1);
    const firstX = coords13[0].x.toFixed(1);
    const lastX = coords13[coords13.length - 1].x.toFixed(1);

    // Áreas suaves sob as curvas até a linha de 50%
    parts.push(
      `<path d="${path13} L${lastX},${y50} L${firstX},${y50} Z" fill="url(#tlGradLula-${isExpanded ? "exp" : "mini"})"/>`,
      `<path d="${path22} L${lastX},${y50} L${firstX},${y50} Z" fill="url(#tlGradFlavio-${isExpanded ? "exp" : "mini"})"/>`
    );

    // Linhas principais (Vermelho x Verde)
    parts.push(
      `<path d="${path22}" fill="none" stroke="#22a858" stroke-width="${isExpanded ? "3" : "2.2"}" stroke-linecap="round" stroke-linejoin="round"/>`,
      `<path d="${path13}" fill="none" stroke="#e03e3e" stroke-width="${isExpanded ? "3" : "2.2"}" stroke-linecap="round" stroke-linejoin="round"/>`
    );

    // Filtra quais pontos recebem marcador visual conforme o intervalo selecionado (5m, 15m, 30m ou cada IDG)
    const markerStepMs = (timelineMarkerMins || 0) * 60 * 1000;
    let lastMarkedMs = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const isEdge = i === 0 || i === points.length - 1;
      const prevPt = i > 0 ? points[i - 1] : null;
      const isCrossover = prevPt && ((prevPt.share13 - prevPt.share22) * (pt.share13 - pt.share22) < 0);

      if (isEdge || isCrossover || markerStepMs === 0 || (pt.ms - lastMarkedMs >= markerStepMs - 1000)) {
        lastMarkedMs = pt.ms;
        const cx = xOf(pt.ms).toFixed(1);
        const cy13 = yOf(pt.share13).toFixed(1);
        const cy22 = yOf(pt.share22).toFixed(1);
        const r = isEdge ? (isExpanded ? "4.5" : "3.2") : (isExpanded ? "3.2" : "2.2");
        parts.push(
          `<circle cx="${cx}" cy="${cy22}" r="${r}" fill="#22a858" stroke="#0b0e14" stroke-width="1.4"/>`,
          `<circle cx="${cx}" cy="${cy13}" r="${r}" fill="#e03e3e" stroke="#0b0e14" stroke-width="1.4"/>`
        );
        if (isCrossover && isExpanded) {
          const midY = ((Number(cy13) + Number(cy22)) / 2).toFixed(1);
          parts.push(
            `<circle cx="${cx}" cy="${midY}" r="5.5" fill="#e8b84b" stroke="#0b0e14" stroke-width="2"/>`,
            `<text x="${cx}" y="${(Number(midY) - 10).toFixed(1)}" text-anchor="middle" fill="#e8b84b" font-family="DM Sans, sans-serif" font-size="10" font-weight="800">Virada (${formatBrtClock(pt.ms)})</text>`
          );
        }
      }
    }

    // Emblemas flutuantes na ponta direita das curvas no modo expandido (Estilo g1 / RealClearPolitics)
    if (isExpanded) {
      const last13 = coords13[coords13.length - 1];
      const last22 = coords22[coords22.length - 1];
      const badgeX = padLeft + plotW + 8;
      let yBadge13 = Math.max(padTop + 12, Math.min(padTop + plotH - 12, last13.y));
      let yBadge22 = Math.max(padTop + 12, Math.min(padTop + plotH - 12, last22.y));
      if (Math.abs(yBadge13 - yBadge22) < 26) {
        if (last13.p.share13 >= last22.p.share22) {
          yBadge13 -= 13;
          yBadge22 += 13;
        } else {
          yBadge22 -= 13;
          yBadge13 += 13;
        }
      }
      parts.push(
        `<line x1="${last13.x.toFixed(1)}" y1="${last13.y.toFixed(1)}" x2="${badgeX}" y2="${yBadge13.toFixed(1)}" stroke="rgba(224,62,62,0.55)" stroke-width="1.2" stroke-dasharray="2 2"/>`,
        `<rect x="${badgeX}" y="${(yBadge13 - 11).toFixed(1)}" width="102" height="22" rx="5" fill="#d63031"/>`,
        `<text x="${badgeX + 51}" y="${(yBadge13 + 4).toFixed(1)}" text-anchor="middle" fill="#ffffff" font-family="DM Sans, sans-serif" font-size="11" font-weight="800">Lula ${percent.format(last13.p.share13)}%</text>`,
        `<line x1="${last22.x.toFixed(1)}" y1="${last22.y.toFixed(1)}" x2="${badgeX}" y2="${yBadge22.toFixed(1)}" stroke="rgba(34,168,88,0.55)" stroke-width="1.2" stroke-dasharray="2 2"/>`,
        `<rect x="${badgeX}" y="${(yBadge22 - 11).toFixed(1)}" width="102" height="22" rx="5" fill="#1e9e50"/>`,
        `<text x="${badgeX + 51}" y="${(yBadge22 + 4).toFixed(1)}" text-anchor="middle" fill="#ffffff" font-family="DM Sans, sans-serif" font-size="11" font-weight="800">Flávio ${percent.format(last22.p.share22)}%</text>`
      );
      // Cursor vertical interativo oculto por padrão
      parts.push(
        `<line id="tl-hover-cursor" x1="0" y1="${padTop}" x2="0" y2="${padTop + plotH}" stroke="rgba(232,184,75,0.75)" stroke-width="1.5" stroke-dasharray="3 3" visibility="hidden"/>`
      );
    }

    svgEl.innerHTML = parts.join("");
  }

  function renderTimelineCharts(snapshot = lastRenderedSnapshot) {
    if (!snapshot) return;
    const series = prepareNormalizedSeries(snapshot);
    const { points, waiting } = series;
    const latest = points.length ? points[points.length - 1] : {
      share13: snapshot.shares["13"] || 0,
      share22: snapshot.shares["22"] || 0,
      votes13: snapshot.votes["13"] || 0,
      votes22: snapshot.votes["22"] || 0,
      sectionsPct: snapshot.sectionsTotal ? (100 * snapshot.sectionsDone / snapshot.sectionsTotal) : 0
    };

    // Atualiza pílulas do card minimizado
    if (view.tlMiniShare13) view.tlMiniShare13.textContent = percent.format(latest.share13) + "%";
    if (view.tlMiniShare22) view.tlMiniShare22.textContent = percent.format(latest.share22) + "%";
    if (view.tlMiniDiff) {
      if (waiting) {
        view.tlMiniDiff.textContent = "Início às 17h00 BRT";
      } else {
        const diffPp = Math.abs(latest.share13 - latest.share22);
        const leaderName = latest.share13 >= latest.share22 ? "Lula" : "Flávio";
        view.tlMiniDiff.textContent = leaderName + " +" + percent.format(diffPp) + " p.p.";
      }
    }
    if (view.timelineMiniStatus) {
      const markerLabel = timelineMarkerMins === 0 ? "cada parcial TSE" : ("a cada " + timelineMarkerMins + " min");
      view.timelineMiniStatus.textContent = waiting
        ? "Linha do tempo: abertura às 17h00 (Horário de Brasília) · marcadores " + markerLabel
        : (isTimelineDemo ? "Prévia visual ativa (17h00 → 20h45 BRT) · " : "Apuração em curso · ") +
          points.length + " leituras no gráfico · marcadores " + markerLabel;
    }

    // Atualiza painel lateral da janela modal expandida
    if (view.timelineModalScope) view.timelineModalScope.textContent = currentScopeHierarchy(scope);
    if (view.tlExpShare13) view.tlExpShare13.textContent = percent.format(latest.share13) + "%";
    if (view.tlExpVotes13) view.tlExpVotes13.textContent = integer.format(latest.votes13) + " votos";
    if (view.tlExpShare22) view.tlExpShare22.textContent = percent.format(latest.share22) + "%";
    if (view.tlExpVotes22) view.tlExpVotes22.textContent = integer.format(latest.votes22) + " votos";
    if (view.tlRcp13) view.tlRcp13.textContent = percent.format(latest.share13);
    if (view.tlRcp22) view.tlRcp22.textContent = percent.format(latest.share22);

    const diffPp = latest.share13 - latest.share22;
    if (view.tlRcpDiff13 && view.tlRcpDiff22) {
      if (waiting) {
        view.tlRcpDiff13.textContent = "—";
        view.tlRcpDiff22.textContent = "—";
      } else if (diffPp > 0.001) {
        view.tlRcpDiff13.textContent = "+" + percent.format(diffPp) + " p.p.";
        view.tlRcpDiff22.textContent = "—";
      } else if (diffPp < -0.001) {
        view.tlRcpDiff13.textContent = "—";
        view.tlRcpDiff22.textContent = "+" + percent.format(Math.abs(diffPp)) + " p.p.";
      } else {
        view.tlRcpDiff13.textContent = "Empate";
        view.tlRcpDiff22.textContent = "Empate";
      }
    }

    if (view.timelineMilestonesList) {
      const items = [`<li><span>17h00</span> <strong>Abertura da linha do tempo (BRT)</strong></li>`];
      if (!waiting && points.length) {
        const first = points[0];
        items.push(`<li><span>${formatBrtClock(first.ms)}</span> <strong>1ª parcial (${percent.format(first.sectionsPct)}% seções)</strong></li>`);
        for (let i = 1; i < points.length; i++) {
          const prev = points[i - 1];
          const curr = points[i];
          if ((prev.share13 - prev.share22) * (curr.share13 - curr.share22) < 0) {
            const front = curr.share13 > curr.share22 ? "Lula" : "Flávio";
            items.push(`<li><span>${formatBrtClock(curr.ms)}</span> <strong>Virada: ${front} assume a liderança</strong></li>`);
          }
        }
        const last = points[points.length - 1];
        items.push(`<li><span>${formatBrtClock(last.ms)}</span> <strong>Última leitura (${percent.format(last.sectionsPct)}% apurado)</strong></li>`);
      } else {
        items.push(`<li><span>Aguardando</span> <strong>Primeira parcial com votos válidos</strong></li>`);
      }
      view.timelineMilestonesList.innerHTML = items.join("");
    }

    renderTimelineSvg(view.timelineSvgMini, series, { expanded: false });
    renderTimelineSvg(view.timelineSvgExpanded, series, { expanded: true });
  }

  function openTimelineModal() {
    if (!view.timelineModal) return;
    view.timelineModal.hidden = false;
    document.body.style.overflow = "hidden";
    renderTimelineCharts();
    view.timelineCloseBtn?.focus();
  }

  function closeTimelineModal() {
    if (!view.timelineModal) return;
    view.timelineModal.hidden = true;
    document.body.style.overflow = "";
    if (isTimelineDemo) {
      isTimelineDemo = false;
      syncTimelineDemoBadge();
      renderTimelineCharts();
    }
    view.timelineCard?.focus();
  }

  function syncTimelineDemoBadge() {
    if (!view.timelineDemoToggle || !view.timelineModeBadge) return;
    view.timelineDemoToggle.setAttribute("aria-pressed", String(isTimelineDemo));
    view.timelineDemoToggle.textContent = isTimelineDemo
      ? "Voltar aos dados oficiais do TSE"
      : "Prévia visual (17h → Fim)";
    view.timelineModeBadge.textContent = isTimelineDemo
      ? "MODO DEMONSTRAÇÃO VISUAL (SIMULAÇÃO)"
      : "DADOS OFICIAIS DO TSE";
    view.timelineModeBadge.classList.toggle("is-demo", isTimelineDemo);
  }

  function initTimelineInteractions() {
    if (view.timelineCard) {
      view.timelineCard.addEventListener("click", openTimelineModal);
      view.timelineCard.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openTimelineModal();
        }
      });
    }
    if (view.timelineCloseBtn) {
      view.timelineCloseBtn.addEventListener("click", closeTimelineModal);
    }
    if (view.timelineModal) {
      view.timelineModal.addEventListener("click", e => {
        if (e.target === view.timelineModal) closeTimelineModal();
      });
    }
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && view.timelineModal && !view.timelineModal.hidden) {
        closeTimelineModal();
      }
    });

    if (view.timelineDemoToggle) {
      view.timelineDemoToggle.addEventListener("click", () => {
        isTimelineDemo = !isTimelineDemo;
        syncTimelineDemoBadge();
        renderTimelineCharts();
      });
    }

    document.querySelectorAll("[data-marker-mins]").forEach(btn => {
      btn.addEventListener("click", () => {
        timelineMarkerMins = Number(btn.dataset.markerMins) || 0;
        document.querySelectorAll("[data-marker-mins]").forEach(b => b.classList.toggle("is-active", b === btn));
        renderTimelineCharts();
      });
    });

    document.querySelectorAll("[data-y-scale]").forEach(btn => {
      btn.addEventListener("click", () => {
        timelineYScale = btn.dataset.yScale === "full" ? "full" : "zoom";
        document.querySelectorAll("[data-y-scale]").forEach(b => b.classList.toggle("is-active", b === btn));
        renderTimelineCharts();
      });
    });

    if (view.timelineSvgExpanded) {
      view.timelineSvgExpanded.addEventListener("mousemove", e => {
        const series = prepareNormalizedSeries(lastRenderedSnapshot);
        if (series.waiting || !series.points.length) return;
        const rect = view.timelineSvgExpanded.getBoundingClientRect();
        if (!rect.width) return;
        const svgX = ((e.clientX - rect.left) / rect.width) * 920;
        const padLeft = 46;
        const plotW = 920 - 46 - 118;
        const ratio = Math.max(0, Math.min(1, (svgX - padLeft) / plotW));
        const targetMs = series.startMs + ratio * (series.endMs - series.startMs);

        let closest = series.points[0];
        let minDiff = Math.abs(closest.ms - targetMs);
        for (const pt of series.points) {
          const d = Math.abs(pt.ms - targetMs);
          if (d < minDiff) {
            minDiff = d;
            closest = pt;
          }
        }

        const cursorLine = document.getElementById("tl-hover-cursor");
        if (cursorLine) {
          const cx = padLeft + Math.max(0, Math.min(1, (closest.ms - series.startMs) / Math.max(60000, series.endMs - series.startMs))) * plotW;
          cursorLine.setAttribute("x1", cx.toFixed(1));
          cursorLine.setAttribute("x2", cx.toFixed(1));
          cursorLine.setAttribute("visibility", "visible");
        }
        if (view.timelineHoverReadout) {
          view.timelineHoverReadout.textContent =
            formatBrtClockSeconds(closest.ms) + " BRT · Lula " + percent.format(closest.share13) +
            "% × Flávio " + percent.format(closest.share22) + "% (" + percent.format(closest.sectionsPct) + "% das seções)";
        }
      });

      view.timelineSvgExpanded.addEventListener("mouseleave", () => {
        const cursorLine = document.getElementById("tl-hover-cursor");
        if (cursorLine) cursorLine.setAttribute("visibility", "hidden");
        if (view.timelineHoverReadout) {
          view.timelineHoverReadout.textContent = "Passe o cursor sobre o gráfico para inspecionar cada horário";
        }
      });
    }
  }

  async function readOfficial(target, epoch) {
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
    try {
      let url = CONFIG.api + "?uf=" + encodeURIComponent(target.uf);
      if (target.municipalityCode) url += "&mun=" + encodeURIComponent(target.municipalityCode);
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: { "Accept": "application/json" }
      });
      const payload = await response.json().catch(() => null);
      if (epoch !== requestEpoch) return { staleRequest: true };
      if (!response.ok || !payload?.snapshot) {
        const err = new Error(payload?.error || ("O serviço de consulta retornou HTTP " + response.status + "."));
        err.upstreamStatus = payload?.upstreamStatus || response.status;
        err.retryAfter = Number(payload?.retryAfter) || 0;
        throw err;
      }
      const expectedType = target.municipalityCode ? "municipality" : (target.uf === "br" ? "country" : "state");
      if (payload.location?.type !== expectedType || payload.location?.uf !== target.uf ||
          (target.municipalityCode && payload.location?.code !== target.municipalityCode)) {
        throw new Error("O serviço respondeu com outra localidade. O placar foi mantido sem misturar os recortes.");
      }
      if (Array.isArray(payload.timeline)) {
        mergeServerTimeline(target, payload.timeline);
      }
      const snapshot = validateData(payload.snapshot, target);
      const bulletinReceivedAt = payload.lastBulletinReceivedAt;
      snapshot.bulletinReceivedAt = typeof bulletinReceivedAt === "string" && Number.isFinite(Date.parse(bulletinReceivedAt))
        ? bulletinReceivedAt
        : null;
      const previous = payload.previous ? validateData(payload.previous, target) : null;
      return {
        snapshot,
        previous,
        stale: payload.stale === true,
        error: payload.error || "",
        upstreamStatus: payload.upstreamStatus || 200,
        retryAfter: Number(payload.retryAfter) || 0,
        checkedAt: payload.checkedAt || null
      };
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) activeController = null;
    }
  }

  function schedule(delay = CONFIG.pollMs) {
    clearTimeout(timer);
    clearInterval(countdownTimer);
    const saved = readHistory();
    if (saved.current?.final && scope.uf === "br") {
      countdown = 0;
      view.countdownLabel.textContent = "concluída";
      return;
    }
    if (document.hidden) {
      countdown = 0;
      view.countdownLabel.textContent = "em segundo plano";
      return;
    }
    const deadline = Date.now() + delay;
    const updateCountdown = () => {
      countdown = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      view.countdownLabel.textContent = countdown + "s";
    };
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 1000);
    timer = setTimeout(() => {
      clearInterval(countdownTimer);
      refresh();
    }, delay);
  }

  async function refresh() {
    if (isLoading || document.hidden) return;
    clearTimeout(timer);
    clearInterval(countdownTimer);
    const epoch = ++requestEpoch;
    isLoading = true;
    if (!isPaused) {
      if (!readHistory().current) setResultState("Aguardando dados do servidor", "O placar muda quando o coletor central valida uma nova parcial oficial.", "wait");
      status("live", "Lendo o cache do servidor");
      void refreshStatesSummary();
    }

    try {
      const result = await readOfficial({ ...scope }, epoch);
      if (result.staleRequest || epoch !== requestEpoch) return;
      const history = recordSnapshot(result.snapshot, result.previous);
      if (!isPaused) {
        const statusPrefix = result.upstreamStatus && result.upstreamStatus !== 200 && result.upstreamStatus !== 304
          ? "[Origem HTTP " + result.upstreamStatus + "] "
          : "";
        renderSnapshot(history.current, result.previous || history.previous, {
          stale: result.stale,
          message: result.stale
            ? (statusPrefix + (result.error || "O serviço manteve a última versão oficial válida."))
            : "",
          checkedAt: result.checkedAt
        });
        if (result.stale) status("error", "Última leitura válida");
      }
    } catch (error) {
      if (epoch !== requestEpoch) return;
      if (!isPaused) {
        const statusTag = error?.upstreamStatus ? " [HTTP " + error.upstreamStatus + "]" : "";
        const message = error?.name === "AbortError"
          ? "A leitura do servidor excedeu o tempo limite. A última leitura válida permanece disponível."
          : String(error?.message || error) + statusTag + " A última leitura válida permanece disponível.";
        showUnavailable(message);
      }
    } finally {
      if (epoch === requestEpoch) {
        isLoading = false;
        if (!document.hidden) schedule(CONFIG.pollMs);
      }
    }
  }

  function resetMunicipalitySelectToNoState() {
    if (municipalityController) municipalityController.abort();
    view.municipalitySelect.replaceChildren();
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Escolha um estado";
    view.municipalitySelect.append(opt);
    view.municipalitySelect.disabled = true;
    view.municipalityClear.hidden = true;
    view.municipalityNote.textContent = "Escolha um estado (na lista ou clicando no mapa) para listar suas cidades.";
  }

  function populateMunicipalitySelect(uf, items, selectedCode = "") {
    const stateName = UF_NAMES[uf] || uf.toUpperCase();
    view.municipalitySelect.replaceChildren();

    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "Todas as cidades de " + stateName + " (" + items.length + " municípios)";
    view.municipalitySelect.append(defaultOpt);

    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.code;
      option.textContent = titleCaseCity(item.name);
      option.dataset.cityName = titleCaseCity(item.name);
      view.municipalitySelect.append(option);
    }

    view.municipalitySelect.disabled = false;
    view.municipalitySelect.value = selectedCode;
    view.municipalityClear.hidden = !selectedCode;
    view.municipalityNote.textContent = selectedCode
      ? "Exibindo apuração municipal. Você pode trocar de cidade ou voltar ao estado."
      : "Selecione uma das " + items.length + " cidades de " + stateName + " para ver o resultado municipal.";
  }

  async function loadMunicipalitiesForState(uf, selectedCode = "") {
    if (uf === "br") {
      resetMunicipalitySelectToNoState();
      return;
    }

    if (stateMunicipalitiesCache.has(uf)) {
      populateMunicipalitySelect(uf, stateMunicipalitiesCache.get(uf), selectedCode);
      return;
    }

    const sequence = ++municipalitySequence;
    if (municipalityController) municipalityController.abort();
    const controller = new AbortController();
    municipalityController = controller;

    const stateName = UF_NAMES[uf] || uf.toUpperCase();
    view.municipalitySelect.replaceChildren();
    const loadingOpt = document.createElement("option");
    loadingOpt.value = "";
    loadingOpt.textContent = "Carregando cidades de " + stateName + "…";
    view.municipalitySelect.append(loadingOpt);
    view.municipalitySelect.disabled = true;
    view.municipalityNote.textContent = "Consultando lista oficial de municípios de " + stateName + "…";

    try {
      const response = await fetch(CONFIG.municipalitiesApi + "?uf=" + encodeURIComponent(uf), {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
        headers: { "Accept": "application/json" }
      });
      const payload = await response.json().catch(() => null);
      if (sequence !== municipalitySequence) return;
      if (!response.ok || !Array.isArray(payload?.items)) {
        throw new Error(payload?.error || "Não foi possível carregar as cidades deste estado.");
      }
      stateMunicipalitiesCache.set(uf, payload.items);
      populateMunicipalitySelect(uf, payload.items, selectedCode);
    } catch (error) {
      if (error?.name === "AbortError" || sequence !== municipalitySequence) return;
      view.municipalitySelect.replaceChildren();
      const errOpt = document.createElement("option");
      errOpt.value = "";
      errOpt.textContent = "Lista de cidades indisponível";
      view.municipalitySelect.append(errOpt);
      view.municipalitySelect.disabled = true;
      view.municipalityNote.textContent = "Não foi possível carregar os municípios agora.";
    } finally {
      if (municipalityController === controller) municipalityController = null;
    }
  }

  function updateScopeLabel() {
    const label = currentScopeLabel();
    view.scopeLabel.textContent = label;
    setCountingTitle(label);
    view.sourceLink.href = officialUrl(scope);
    view.scopeFile.textContent = scope.municipalityCode
      ? "CIDADE · " + scope.uf.toUpperCase()
      : scope.uf === "br" ? "PAÍS" : "ESTADO · " + scope.uf.toUpperCase();

    if (view.stageScopeBadge) {
      view.stageScopeBadge.textContent = "Abrangência: " + label;
    }
    if (view.scopeTrail) {
      view.scopeTrail.textContent = scope.municipalityCode
        ? "PLACAR OFICIAL · PAÍS → " + scope.uf.toUpperCase() + " → CIDADE"
        : scope.uf === "br"
          ? "PLACAR OFICIAL · PAÍS (BRASIL)"
          : "PLACAR OFICIAL · PAÍS → ESTADO (" + scope.uf.toUpperCase() + ")";
    }
    if (view.chartScopePath) {
      view.chartScopePath.textContent = currentScopeHierarchy(scope);
    }
    applyMapVisualState();
  }

  function setScope(nextScope) {
    scope = { uf: nextScope.uf, municipalityCode: nextScope.municipalityCode || "", cityName: nextScope.cityName || "" };
    requestEpoch += 1;
    if (activeController) activeController.abort();
    isLoading = false;
    updateScopeLabel();
    view.scoreboard.hidden = true;
    view.comparisonKey.hidden = true;
    if (view.timelineCard) view.timelineCard.hidden = true;
    view.tallyGrid.hidden = true;
    view.voteBreakdown.hidden = true;
    view.mathBanner.hidden = true;
    view.previousStrip.hidden = true;
    const saved = readHistory();
    if (saved.current) {
      renderSnapshot(saved.current, saved.previous, {
        stale: true,
        message: "Última leitura válida deste recorte enquanto o serviço consulta a nova localidade."
      });
    } else {
      setResultState("Carregando " + currentScopeLabel(), "O painel troca os números depois de validar a abrangência selecionada.", "wait");
      if (!isPaused) status("live", "Lendo o cache do servidor");
      view.updatedLabel.textContent = "Aguardando a primeira leitura";
      view.generationLabel.textContent = "Nenhuma parcial guardada para este recorte.";
    }
    refresh();
  }

  function applyState() {
    const uf = view.stateSelect.value;
    loadMunicipalitiesForState(uf, "");
    setScope({ uf, municipalityCode: "", cityName: "" });
  }

  function applyMunicipality() {
    const uf = view.stateSelect.value;
    if (uf === "br") return;
    const code = view.municipalitySelect.value;
    if (!code) {
      view.municipalityClear.hidden = true;
      const stateName = UF_NAMES[uf] || uf.toUpperCase();
      view.municipalityNote.textContent = "Exibindo o resultado geral de " + stateName + ".";
      setScope({ uf, municipalityCode: "", cityName: "" });
      return;
    }
    const selectedOption = view.municipalitySelect.options[view.municipalitySelect.selectedIndex];
    const cityName = selectedOption?.dataset?.cityName || selectedOption?.textContent || "";
    view.municipalityClear.hidden = false;
    view.municipalityNote.textContent = "Exibindo dados de " + cityName + ", " + uf.toUpperCase() + ".";
    setScope({ uf, municipalityCode: code, cityName });
  }

  view.stateSelect.addEventListener("change", applyState);
  view.municipalitySelect.addEventListener("change", applyMunicipality);
  view.municipalityClear.addEventListener("click", () => {
    const uf = view.stateSelect.value;
    if (uf === "br") return;
    view.municipalitySelect.value = "";
    view.municipalityClear.hidden = true;
    const stateName = UF_NAMES[uf] || uf.toUpperCase();
    view.municipalityNote.textContent = "Recorte municipal removido. Exibindo " + stateName + ".";
    setScope({ uf, municipalityCode: "", cityName: "" });
    view.municipalitySelect.focus();
  });

  if (view.mapResetBtn) {
    view.mapResetBtn.addEventListener("click", () => {
      view.stateSelect.value = "br";
      applyState();
    });
  }

  view.pauseButton.addEventListener("click", () => {
    isPaused = !isPaused;
    view.pauseButton.setAttribute("aria-pressed", String(isPaused));
    view.pauseButton.textContent = isPaused ? "Retomar" : "Pausar";
    if (isPaused) {
      status("paused", "Exibição pausada · serviço continua ativo");
    } else {
      const saved = readHistory();
      if (saved.current) {
        renderSnapshot(saved.current, saved.previous, {
          stale: true,
          message: "Sincronizando a exibição com a versão mais recente do servidor."
        });
      }
      void refreshStatesSummary();
      refresh();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(timer);
      clearInterval(countdownTimer);
      view.countdownLabel.textContent = "em segundo plano";
    } else {
      refresh();
    }
  });

  resetMunicipalitySelectToNoState();
  initBrazilMap();
  initTimelineInteractions();
  updateScopeLabel();
  const startupHistory = readHistory();
  if (startupHistory.current) renderSnapshot(startupHistory.current, startupHistory.previous, {
    stale: true,
    message: "Última leitura deste navegador. Conferindo a versão compartilhada no serviço."
  });
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("demo") === "1") {
    isTimelineDemo = true;
    syncTimelineDemoBadge();
  }
  if (urlParams.get("modal") === "timeline") {
    openTimelineModal();
  }
  refresh();
})();
