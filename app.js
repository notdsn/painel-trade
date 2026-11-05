/**
 * Painel Trade — paper-trading terminal (simulação)
 * Fonte: DexScreener public API (CORS *). Sem carteira, sem chaves, sem trades reais.
 */
(function () {
  "use strict";

  const STORAGE_KEY = "painel-trade-v1";
  const POLL_MS = 20000;
  const SLIPPAGE = 0.02; // 2%
  const FEE = 0.003; // 0.3% simulado
  const MAX_LOG = 200;
  const BRT = "America/Sao_Paulo";

  const DEFAULTS = {
    startingBalance: 50,
    takeProfitPct: 25,
    stopLossPct: 12,
    maxPctPerTrade: 10,
    maxOpenPositions: 3,
    minLiquidityUsd: 25000,
    minVolumeH1: 8000,
    maxPairAgeHours: 72,
    minMomentumH1: 5,
    timeStopMinutes: 90,
  };

  /** @type {State} */
  let state = loadState();
  let pollTimer = null;
  let clockTimer = null;
  let seenPairs = new Map(); // pairAddress -> last volume h1
  let lastScan = [];

  // ---------- utils ----------
  function money(n) {
    const v = Number(n) || 0;
    return "US$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pct(n) {
    const v = Number(n) || 0;
    const s = (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
    return s;
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString("pt-BR", {
      timeZone: BRT,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  function fmtRuntime(ms) {
    const s = Math.floor(ms / 1000);
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return h + ":" + m + ":" + sec;
  }
  function ageHours(pairCreatedAt) {
    if (!pairCreatedAt) return null;
    return (Date.now() - pairCreatedAt) / 3600000;
  }
  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  // ---------- state ----------
  function blankState() {
    const bal = DEFAULTS.startingBalance;
    return {
      settings: { ...DEFAULTS },
      balance: bal,
      paused: false,
      startedAt: Date.now(),
      pausedAccumMs: 0,
      pauseStartedAt: null,
      trades: 0,
      wins: 0,
      losses: 0,
      positions: [],
      log: [],
      equityCurve: [{ t: Date.now(), equity: bal }],
      knownTokens: {},
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return blankState();
      const parsed = JSON.parse(raw);
      const base = blankState();
      return {
        ...base,
        ...parsed,
        settings: { ...DEFAULTS, ...(parsed.settings || {}) },
        positions: Array.isArray(parsed.positions) ? parsed.positions : [],
        log: Array.isArray(parsed.log) ? parsed.log : [],
        equityCurve: Array.isArray(parsed.equityCurve) && parsed.equityCurve.length
          ? parsed.equityCurve
          : base.equityCurve,
      };
    } catch (_) {
      return blankState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) { /* quota */ }
  }

  function currentEquity() {
    let eq = state.balance;
    for (const p of state.positions) {
      if (p.markPrice != null) {
        eq += positionNotional(p, p.markPrice);
      } else {
        eq += p.sizeUsd; // fallback cost basis still reserved
      }
    }
    return eq;
  }

  function positionNotional(pos, price) {
    // long only: sizeUsd spent at entry → tokens = sizeUsd/entry; value = tokens * price
    if (!pos.entryPrice || pos.entryPrice <= 0) return pos.sizeUsd;
    const tokens = pos.sizeUsd / pos.entryPrice;
    return tokens * price;
  }

  function unrealizedPnl(pos) {
    if (pos.markPrice == null) return 0;
    return positionNotional(pos, pos.markPrice) - pos.sizeUsd;
  }

  // ---------- logging ----------
  function addLog(action, token, reason, pnl) {
    const entry = {
      t: Date.now(),
      action,
      token: token || "—",
      reason: reason || "",
      pnl: pnl == null ? null : pnl,
    };
    state.log.unshift(entry);
    if (state.log.length > MAX_LOG) state.log.length = MAX_LOG;
    renderLogger();
    saveState();
  }

  // ---------- DexScreener ----------
  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status + " " + url);
    return res.json();
  }

  async function fetchCandidates() {
    // Mix of boosts + profiles → then hydrate with pair data
    const [boosts, profiles] = await Promise.all([
      fetchJson("https://api.dexscreener.com/token-boosts/latest/v1").catch(() => []),
      fetchJson("https://api.dexscreener.com/token-profiles/latest/v1").catch(() => []),
    ]);

    const items = [];
    const seenAddr = new Set();
    for (const list of [boosts, profiles]) {
      if (!Array.isArray(list)) continue;
      for (const it of list) {
        const key = (it.chainId || "") + ":" + (it.tokenAddress || "");
        if (!it.tokenAddress || seenAddr.has(key)) continue;
        seenAddr.add(key);
        items.push(it);
        if (items.length >= 24) break;
      }
      if (items.length >= 24) break;
    }

    // Hydrate in small batches to respect rate limits
    const pairs = [];
    const batchSize = 4;
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (it) => {
          try {
            const data = await fetchJson(
              "https://api.dexscreener.com/latest/dex/tokens/" + encodeURIComponent(it.tokenAddress)
            );
            const list = (data && data.pairs) || [];
            // Prefer same chain, highest liquidity
            const same = list.filter((p) => p.chainId === it.chainId);
            const pool = same.length ? same : list;
            pool.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
            return pool[0] || null;
          } catch (_) {
            return null;
          }
        })
      );
      for (const p of results) if (p && p.priceUsd) pairs.push(p);
      // tiny pause between batches
      if (i + batchSize < items.length) await sleep(250);
    }

    // Fallback: search popular query if empty
    if (pairs.length < 3) {
      try {
        const data = await fetchJson("https://api.dexscreener.com/latest/dex/search?q=SOL");
        const list = (data && data.pairs) || [];
        for (const p of list.slice(0, 12)) {
          if (p.priceUsd) pairs.push(p);
        }
      } catch (_) { /* ignore */ }
    }

    // Dedup by pairAddress
    const byPair = new Map();
    for (const p of pairs) {
      if (!p.pairAddress) continue;
      const prev = byPair.get(p.pairAddress);
      if (!prev || (p.liquidity?.usd || 0) > (prev.liquidity?.usd || 0)) {
        byPair.set(p.pairAddress, p);
      }
    }
    return Array.from(byPair.values());
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ---------- strategy agents ----------
  function rugCheck(pair) {
    const reasons = [];
    const liq = pair.liquidity?.usd || 0;
    const ageH = ageHours(pair.pairCreatedAt);
    const volH1 = pair.volume?.h1 || 0;
    const price = Number(pair.priceUsd) || 0;

    if (liq < state.settings.minLiquidityUsd) {
      reasons.push("liquidez baixa (" + money(liq) + ")");
    }
    if (ageH != null && ageH > state.settings.maxPairAgeHours) {
      reasons.push("par antigo (" + ageH.toFixed(1) + "h)");
    }
    // Very new (< 15 min) = high rug risk for this sim
    if (ageH != null && ageH < 0.25) {
      reasons.push("par muito novo (<15min)");
    }
    // Extreme concentration proxy: tiny liquidity vs huge FDV
    const fdv = pair.fdv || pair.marketCap || 0;
    if (fdv > 0 && liq > 0 && fdv / liq > 200) {
      reasons.push("concentração extrema (FDV/liq)");
    }
    if (volH1 < state.settings.minVolumeH1) {
      reasons.push("volume 1h baixo");
    }
    if (price <= 0) reasons.push("preço inválido");

    return { ok: reasons.length === 0, reasons, liq, ageH, volH1 };
  }

  function hasVolumeSpike(pair) {
    const addr = pair.pairAddress;
    const volH1 = pair.volume?.h1 || 0;
    const volM5 = pair.volume?.m5 || 0;
    const prev = seenPairs.get(addr);
    seenPairs.set(addr, volH1);

    // Spike: m5 volume is hot relative to hourly, or volume jumped vs last poll
    const m5Hot = volH1 > 0 && volM5 >= volH1 * 0.12;
    const jumped = prev != null && volH1 > prev * 1.35 && volH1 - prev > 500;
    const absHot = volH1 >= state.settings.minVolumeH1 * 1.5;
    return { spike: m5Hot || jumped || absHot, m5Hot, jumped, absHot, volH1, volM5 };
  }

  function momentumOk(pair) {
    const h1 = pair.priceChange?.h1;
    if (h1 == null) return { ok: false, h1: null, reason: "sem momentum h1" };
    if (h1 < state.settings.minMomentumH1) {
      return { ok: false, h1, reason: "momentum fraco (" + pct(h1) + ")" };
    }
    // Avoid chasing extreme pumps already > 80% in 1h
    if (h1 > 80) {
      return { ok: false, h1, reason: "já bombeou demais (" + pct(h1) + ")" };
    }
    return { ok: true, h1 };
  }

  function alreadyOpen(pair) {
    const sym = pair.baseToken?.symbol;
    const addr = pair.pairAddress;
    return state.positions.some(
      (p) => p.pairAddress === addr || (sym && p.symbol === sym && p.tokenAddress === pair.baseToken?.address)
    );
  }

  function sizePosition(equity) {
    const pctTrade = state.settings.maxPctPerTrade / 100;
    // Scale size a bit with recent win rate (simple)
    let factor = 1;
    const total = state.wins + state.losses;
    if (total >= 5) {
      const wr = state.wins / total;
      if (wr < 0.35) factor = 0.6;
      else if (wr > 0.55) factor = 1.1;
    }
    const size = equity * pctTrade * factor;
    return {
      sizeUsd: clamp(size, 1, equity * 0.5),
      pctOfEquity: (clamp(size, 1, equity * 0.5) / equity) * 100,
      factor,
    };
  }

  function simulateBuy(pair, sizeUsd) {
    const mid = Number(pair.priceUsd);
    // Adverse slippage on entry
    const fill = mid * (1 + SLIPPAGE);
    const fee = sizeUsd * FEE;
    const spent = sizeUsd + fee;
    if (spent > state.balance) return null;
    return { fill, fee, spent, mid };
  }

  function simulateSell(pos, mid) {
    const tokens = pos.sizeUsd / pos.entryPrice;
    const fill = mid * (1 - SLIPPAGE);
    const gross = tokens * fill;
    const fee = gross * FEE;
    const proceeds = gross - fee;
    const pnl = proceeds - pos.sizeUsd; // fee on entry already paid from balance separately; sizeUsd is cost basis of tokens
    return { fill, fee, proceeds, pnl, mid };
  }

  function openPosition(pair, sizeInfo) {
    const sim = simulateBuy(pair, sizeInfo.sizeUsd);
    if (!sim) {
      addLog("SKIP", pair.baseToken?.symbol, "saldo insuficiente para size " + money(sizeInfo.sizeUsd));
      return;
    }
    state.balance -= sim.spent;
    const pos = {
      id: "p_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      symbol: pair.baseToken?.symbol || "???",
      name: pair.baseToken?.name || "",
      tokenAddress: pair.baseToken?.address,
      pairAddress: pair.pairAddress,
      chainId: pair.chainId,
      url: pair.url,
      entryPrice: sim.fill,
      midAtEntry: sim.mid,
      sizeUsd: sizeInfo.sizeUsd,
      feeEntry: sim.fee,
      openedAt: Date.now(),
      markPrice: sim.mid,
      tpPct: state.settings.takeProfitPct,
      slPct: state.settings.stopLossPct,
      timeStopMinutes: state.settings.timeStopMinutes,
    };
    state.positions.push(pos);
    state.trades += 1;
    addLog(
      "BUY",
      pos.symbol,
      "entrada @" + sim.fill.toPrecision(6) + " | size " + money(sizeInfo.sizeUsd) +
        " (" + sizeInfo.pctOfEquity.toFixed(1) + "% eq) | slip " + (SLIPPAGE * 100) + "% + fee",
      null
    );
    saveState();
    renderAll();
  }

  function closePosition(pos, reason, mid) {
    const sim = simulateSell(pos, mid);
    state.balance += sim.proceeds;
    const pnl = sim.proceeds - pos.sizeUsd;
    if (pnl >= 0) state.wins += 1;
    else state.losses += 1;

    state.positions = state.positions.filter((p) => p.id !== pos.id);
    state.equityCurve.push({ t: Date.now(), equity: currentEquity() });
    if (state.equityCurve.length > 300) {
      state.equityCurve = state.equityCurve.slice(-300);
    }

    addLog(
      "SELL",
      pos.symbol,
      reason + " | saída @" + sim.fill.toPrecision(6) + " | " + (pnl >= 0 ? "lucro" : "perda") + " " + money(pnl),
      pnl
    );
    saveState();
    renderAll();
  }

  async function refreshOpenMarks() {
    if (!state.positions.length) return;
    await Promise.all(
      state.positions.map(async (pos) => {
        try {
          const data = await fetchJson(
            "https://api.dexscreener.com/latest/dex/pairs/" +
              encodeURIComponent(pos.chainId) + "/" +
              encodeURIComponent(pos.pairAddress)
          );
          const pair = data?.pair || (data?.pairs && data.pairs[0]);
          if (pair?.priceUsd) {
            pos.markPrice = Number(pair.priceUsd);
          }
        } catch (_) {
          // keep last mark
        }
      })
    );
  }

  function checkExits() {
    const now = Date.now();
    // copy to avoid mutation during iterate
    const list = [...state.positions];
    for (const pos of list) {
      if (pos.markPrice == null || !pos.entryPrice) continue;
      const changePct = ((pos.markPrice - pos.entryPrice) / pos.entryPrice) * 100;
      if (changePct >= pos.tpPct) {
        closePosition(pos, "take-profit +" + changePct.toFixed(1) + "%", pos.markPrice);
        continue;
      }
      if (changePct <= -pos.slPct) {
        closePosition(pos, "stop-loss " + changePct.toFixed(1) + "%", pos.markPrice);
        continue;
      }
      const ageMin = (now - pos.openedAt) / 60000;
      if (ageMin >= pos.timeStopMinutes) {
        closePosition(pos, "time-stop " + ageMin.toFixed(0) + "min (P/L " + pct(changePct) + ")", pos.markPrice);
      }
    }
  }

  async function runCycle() {
    if (state.paused) return;
    try {
      const pairs = await fetchCandidates();
      lastScan = pairs;
      renderScanner(pairs);

      const rugResults = [];
      const equity = currentEquity();

      for (const pair of pairs) {
        const sym = pair.baseToken?.symbol || "?";
        const rug = rugCheck(pair);
        const spike = hasVolumeSpike(pair);
        const mom = momentumOk(pair);

        rugResults.push({ pair, rug, spike, mom });

        if (!rug.ok) {
          // only log skips occasionally to avoid spam — log first time we see reject for this pair this session
          const key = "skip:" + pair.pairAddress;
          if (!state.knownTokens[key]) {
            state.knownTokens[key] = true;
            addLog("SKIP", sym, "RUG CHECK: " + rug.reasons.join("; "));
          }
          continue;
        }

        if (!spike.spike) {
          continue; // quiet — no log spam
        }

        if (!mom.ok) {
          const key = "mom:" + pair.pairAddress;
          if (!state.knownTokens[key]) {
            state.knownTokens[key] = true;
            addLog("SKIP", sym, "momentum: " + mom.reason);
          }
          continue;
        }

        if (alreadyOpen(pair)) continue;

        if (state.positions.length >= state.settings.maxOpenPositions) {
          const key = "maxpos";
          if (!state.knownTokens[key + ":" + Math.floor(Date.now() / 60000)]) {
            state.knownTokens[key + ":" + Math.floor(Date.now() / 60000)] = true;
            addLog("SKIP", sym, "máx. posições abertas (" + state.settings.maxOpenPositions + ")");
          }
          continue;
        }

        if (state.balance < 2) {
          addLog("SKIP", sym, "saldo muito baixo");
          continue;
        }

        const sizing = sizePosition(equity);
        renderSizer(pair, sizing, mom, spike);
        openPosition(pair, sizing);
      }

      renderRug(rugResults);
      await refreshOpenMarks();
      checkExits();
      renderExecutor();
      renderHeader();
      drawEquity();
      saveState();
    } catch (err) {
      addLog("ERRO", "—", "falha ao buscar dados: " + (err && err.message ? err.message : String(err)));
      renderScannerError(err);
    }
  }

  // ---------- render ----------
  function $(id) { return document.getElementById(id); }

  function renderHeader() {
    const eq = currentEquity();
    const balEl = $("stat-balance");
    const eqEl = $("stat-equity");
    balEl.textContent = money(state.balance);
    eqEl.textContent = money(eq);
    eqEl.className = "stat-value " + (eq >= state.settings.startingBalance ? "up" : "down");
    $("stat-trades").textContent = String(state.trades);
    $("stat-wl").textContent = state.wins + " / " + state.losses;

    let runMs = Date.now() - state.startedAt - state.pausedAccumMs;
    if (state.paused && state.pauseStartedAt) runMs -= Date.now() - state.pauseStartedAt;
    $("stat-runtime").textContent = fmtRuntime(Math.max(0, runMs));

    const st = $("stat-status");
    if (state.paused) {
      st.innerHTML = '<span class="pulse off"></span>PAUSADO';
    } else {
      st.innerHTML = '<span class="pulse on"></span>ATIVO';
    }
    $("btn-pause").textContent = state.paused ? "▶ Retomar" : "⏸ Pausar";
  }

  function renderScanner(pairs) {
    const el = $("scanner-body");
    if (!pairs.length) {
      el.innerHTML = '<div class="empty">Nenhum par retornado</div>';
      return;
    }
    const top = pairs
      .slice()
      .sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0))
      .slice(0, 8);
    el.innerHTML = top
      .map((p) => {
        const age = ageHours(p.pairCreatedAt);
        const ageStr = age == null ? "?" : age < 1 ? Math.round(age * 60) + "min" : age.toFixed(1) + "h";
        return (
          '<div class="row">' +
          '<div><span class="tok"><span class="sym">' +
          esc(p.baseToken?.symbol || "?") +
          "</span> / " +
          esc(p.quoteToken?.symbol || "") +
          '</span><div class="meta">' +
          esc(p.chainId || "") +
          " · liq " +
          money(p.liquidity?.usd || 0) +
          " · idade " +
          ageStr +
          "</div></div>" +
          '<div style="text-align:right"><div class="' +
          ((p.priceChange?.h1 || 0) >= 0 ? "pnl-pos" : "pnl-neg") +
          '">' +
          pct(p.priceChange?.h1 || 0) +
          ' h1</div><div class="meta">vol1h ' +
          money(p.volume?.h1 || 0) +
          "</div></div></div>"
        );
      })
      .join("");
  }

  function renderScannerError(err) {
    $("scanner-body").innerHTML =
      '<div class="empty" style="color:var(--red)">Erro API: ' +
      esc(err && err.message ? err.message : String(err)) +
      "</div>";
  }

  function renderRug(results) {
    const el = $("rug-body");
    if (!results.length) {
      el.innerHTML = '<div class="empty">Sem análise</div>';
      return;
    }
    const show = results.slice(0, 8);
    el.innerHTML = show
      .map(({ pair, rug }) => {
        const tag = rug.ok
          ? '<span class="tag tag-ok">OK</span>'
          : '<span class="tag tag-fail">BLOQ</span>';
        const detail = rug.ok
          ? "liq " + money(rug.liq) + " · vol " + money(rug.volH1)
          : rug.reasons.slice(0, 2).join(" · ");
        return (
          '<div class="row"><div><span class="tok"><span class="sym">' +
          esc(pair.baseToken?.symbol || "?") +
          "</span></span><div class=\"meta\">" +
          esc(detail) +
          "</div></div><div>" +
          tag +
          "</div></div>"
        );
      })
      .join("");
  }

  function renderSizer(pair, sizing, mom, spike) {
    const el = $("sizer-body");
    el.innerHTML =
      '<div class="pos-card">' +
      '<div class="line"><span class="name">' +
      esc(pair.baseToken?.symbol || "?") +
      '</span><span class="tag tag-buy">SIZE</span></div>' +
      '<div class="line"><span>Equity atual</span><span>' +
      money(currentEquity()) +
      "</span></div>" +
      '<div class="line"><span>% do equity</span><span>' +
      sizing.pctOfEquity.toFixed(1) +
      "%</span></div>" +
      '<div class="line"><span>Notional</span><span>' +
      money(sizing.sizeUsd) +
      "</span></div>" +
      '<div class="line"><span>Momentum h1</span><span class="pnl-pos">' +
      pct(mom.h1) +
      "</span></div>" +
      '<div class="meta">spike vol1h ' +
      money(spike.volH1) +
      " · fator " +
      sizing.factor.toFixed(2) +
      "</div></div>";
  }

  function renderExecutor() {
    const el = $("executor-body");
    if (!state.positions.length) {
      el.innerHTML = '<div class="empty">Nenhuma posição aberta</div>';
      return;
    }
    el.innerHTML = state.positions
      .map((p) => {
        const u = unrealizedPnl(p);
        const chg =
          p.markPrice && p.entryPrice
            ? ((p.markPrice - p.entryPrice) / p.entryPrice) * 100
            : 0;
        return (
          '<div class="pos-card">' +
          '<div class="line"><span class="name">' +
          esc(p.symbol) +
          " · " +
          esc(p.chainId || "") +
          '</span><span class="tag tag-open">ABERTA</span></div>' +
          '<div class="line"><span>Entrada</span><span>' +
          Number(p.entryPrice).toPrecision(6) +
          "</span></div>" +
          '<div class="line"><span>Mark</span><span>' +
          (p.markPrice != null ? Number(p.markPrice).toPrecision(6) : "—") +
          "</span></div>" +
          '<div class="line"><span>Size</span><span>' +
          money(p.sizeUsd) +
          "</span></div>" +
          '<div class="line"><span>P/L não realiz.</span><span class="' +
          (u >= 0 ? "pnl-pos" : "pnl-neg") +
          '">' +
          money(u) +
          " (" +
          pct(chg) +
          ")</span></div>" +
          '<div class="meta">TP ' +
          p.tpPct +
          "% · SL " +
          p.slPct +
          "% · time " +
          p.timeStopMinutes +
          "min · aberta " +
          fmtTime(p.openedAt) +
          "</div></div>"
        );
      })
      .join("");
  }

  function renderLogger() {
    const el = $("logger-body");
    if (!state.log.length) {
      el.innerHTML = '<div class="empty">Sem eventos ainda</div>';
      return;
    }
    el.innerHTML = state.log
      .slice(0, 60)
      .map((e) => {
        let tagClass = "tag-skip";
        if (e.action === "BUY") tagClass = "tag-buy";
        else if (e.action === "SELL") tagClass = "tag-sell";
        else if (e.action === "ERRO") tagClass = "tag-fail";
        const pnlStr =
          e.pnl == null
            ? ""
            : ' <span class="' +
              (e.pnl >= 0 ? "pnl-pos" : "pnl-neg") +
              '">' +
              money(e.pnl) +
              "</span>";
        return (
          '<div class="log-line"><div class="log-time">' +
          fmtTime(e.t) +
          '</div><div class="log-main"><span class="tag ' +
          tagClass +
          '">' +
          esc(e.action) +
          "</span> <span class=\"tok\"><span class=\"sym\">" +
          esc(e.token) +
          "</span></span>" +
          pnlStr +
          '<span class="log-reason">' +
          esc(e.reason) +
          "</span></div></div>"
        );
      })
      .join("");
  }

  function drawEquity() {
    const canvas = $("equity-chart");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 600;
    const cssH = 140;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pts = state.equityCurve.length
      ? state.equityCurve
      : [{ t: Date.now(), equity: state.settings.startingBalance }];
    // append live equity point
    const live = pts.concat([{ t: Date.now(), equity: currentEquity() }]);

    const vals = live.map((p) => p.equity);
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const pad = 8;
    const w = cssW;
    const h = cssH;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0a100a";
    ctx.fillRect(0, 0, w, h);

    // baseline starting balance
    const base = state.settings.startingBalance;
    const by = h - pad - ((base - min) / (max - min)) * (h - pad * 2);
    ctx.strokeStyle = "#2a3a2a";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad, by);
    ctx.lineTo(w - pad, by);
    ctx.stroke();
    ctx.setLineDash([]);

    const last = live[live.length - 1].equity;
    const color = last >= base ? "#39ff14" : "#ff4444";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    live.forEach((p, i) => {
      const x = pad + (i / Math.max(1, live.length - 1)) * (w - pad * 2);
      const y = h - pad - ((p.equity - min) / (max - min)) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    $("equity-meta").textContent =
      "Inicial " +
      money(base) +
      " · atual " +
      money(last) +
      " · Δ " +
      money(last - base) +
      " (" +
      pct(((last - base) / base) * 100) +
      ")";
  }

  function renderAll() {
    renderHeader();
    renderExecutor();
    renderLogger();
    drawEquity();
    if (lastScan.length) renderScanner(lastScan);
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ---------- settings UI ----------
  function openSettings() {
    const form = $("settings-form");
    const s = state.settings;
    for (const key of Object.keys(DEFAULTS)) {
      if (form.elements[key]) form.elements[key].value = s[key];
    }
    $("settings-modal").classList.remove("hidden");
  }
  function closeSettings() {
    $("settings-modal").classList.add("hidden");
  }

  // ---------- controls ----------
  function togglePause() {
    if (state.paused) {
      if (state.pauseStartedAt) {
        state.pausedAccumMs += Date.now() - state.pauseStartedAt;
      }
      state.pauseStartedAt = null;
      state.paused = false;
      addLog("INFO", "—", "simulação retomada");
      runCycle();
    } else {
      state.paused = true;
      state.pauseStartedAt = Date.now();
      addLog("INFO", "—", "simulação pausada");
    }
    saveState();
    renderHeader();
  }

  function resetAll() {
    if (!confirm("Resetar simulação? Saldo, posições e log serão apagados.")) return;
    const keepSettings = { ...state.settings };
    state = blankState();
    state.settings = keepSettings;
    state.balance = keepSettings.startingBalance;
    state.equityCurve = [{ t: Date.now(), equity: keepSettings.startingBalance }];
    seenPairs = new Map();
    lastScan = [];
    saveState();
    addLog("INFO", "—", "simulação resetada · saldo " + money(state.balance));
    renderAll();
    $("sizer-body").innerHTML = '<div class="empty">Sem posição pendente</div>';
    $("rug-body").innerHTML = '<div class="empty">Aguardando…</div>';
    $("scanner-body").innerHTML = '<div class="empty">Aguardando dados…</div>';
    if (!state.paused) runCycle();
  }

  // ---------- boot ----------
  function tickClock() {
    renderHeader();
  }

  function bind() {
    $("btn-pause").addEventListener("click", togglePause);
    $("btn-reset").addEventListener("click", resetAll);
    $("btn-settings").addEventListener("click", openSettings);
    $("btn-settings-cancel").addEventListener("click", closeSettings);
    $("settings-modal").addEventListener("click", (e) => {
      if (e.target === $("settings-modal")) closeSettings();
    });
    $("settings-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const form = e.target;
      const next = { ...state.settings };
      for (const key of Object.keys(DEFAULTS)) {
        const el = form.elements[key];
        if (!el) continue;
        const v = Number(el.value);
        if (!Number.isFinite(v)) continue;
        next[key] = v;
      }
      const balChanged = next.startingBalance !== state.settings.startingBalance;
      state.settings = next;
      if (balChanged && state.positions.length === 0 && state.trades === 0) {
        state.balance = next.startingBalance;
        state.equityCurve = [{ t: Date.now(), equity: next.startingBalance }];
      }
      saveState();
      addLog(
        "INFO",
        "—",
        "config salva · TP " +
          next.takeProfitPct +
          "% · SL " +
          next.stopLossPct +
          "% · máx " +
          next.maxPctPerTrade +
          "%/trade"
      );
      closeSettings();
      renderAll();
    });
    window.addEventListener("resize", () => drawEquity());
  }

  bind();
  renderAll();
  addLog(
    "INFO",
    "—",
    "agentes online · paper-trading · DexScreener · poll " + POLL_MS / 1000 + "s"
  );

  // Start
  runCycle();
  pollTimer = setInterval(runCycle, POLL_MS);
  clockTimer = setInterval(tickClock, 1000);

  // Expose for debug
  window.__painelTrade = {
    getState: () => state,
    runCycle,
    DEFAULTS,
  };
})();
