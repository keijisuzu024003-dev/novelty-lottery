// js/records.js
// 記録ビュー（写真用）。設定画面からだけ開く。
//
// 背景：実機のサイネージにはファイル管理アプリが無く、書き出した CSV を USB へ移せない。
// そこで «配布の記録は画面に出してスマホで撮る» 運用にした。
// 写真で読めることが最優先なので、白地・黒文字・大きな字・装飾なし・アニメなし。
//
// 構成：
//   NV.records.summarize(state, venue)  … 純粋関数。DOM も localStorage も触らない（tools/test_records.js で検証）
//   NV.records.open(state) / close()     … 全画面の記録ビュー（1ページ＝1画面。スクロールさせない）
// ------------------------------------------------------------
window.NV = window.NV || {};

(function () {
  "use strict";

  // 時間帯の区切り。9時台〜18時台を1時間ずつ、その外は «まとめ» にする
  var HOUR_FIRST = 9;
  var HOUR_LAST = 18;
  var HOUR_LABELS = ["〜8時台"];
  (function () {
    for (var h = HOUR_FIRST; h <= HOUR_LAST; h++) HOUR_LABELS.push(h + "時台");
    HOUR_LABELS.push((HOUR_LAST + 1) + "時〜");
  })();
  var HOUR_BUCKETS = HOUR_LABELS.length; // 12

  var ROWS_PER_PAGE = 25;                // 明細1ページの行数（1080×1920 で字を大きく保てる数）
  var WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  function dateKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate());
  }

  function hourBucket(ts) {
    var h = new Date(ts).getHours();
    if (h < HOUR_FIRST) return 0;
    if (h > HOUR_LAST) return HOUR_BUCKETS - 1;
    return h - HOUR_FIRST + 1;
  }

  function fmtDateTime(ts, withSec) {
    var d = new Date(ts);
    return d.getFullYear() + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + (withSec ? ":" + pad(d.getSeconds()) : "");
  }

  // 備考「特賞 k/N」の解釈。1行＝1個なので、特賞で複数個のときは k=1〜N の N 行が並ぶ。
  // «1人» と数えるのは、備考が空の行と k=1 の行（k>=2 は同じ人の2個目以降）
  var JP_RE = /^特賞\s*(\d+)\s*\/\s*(\d+)\s*$/;
  function jackpotIndex(note) {
    var m = JP_RE.exec(typeof note === "string" ? note : "");
    return m ? Number(m[1]) : 0;   // 0 = 特賞ではない
  }
  function isPerson(note) { return jackpotIndex(note) <= 1; }
  function isJackpotFirst(note) { return jackpotIndex(note) === 1; }

  function zeros(n) { var a = []; for (var i = 0; i < n; i++) a.push(0); return a; }

  // ---- 集計（純粋関数） -----------------------------------------------
  //
  // 戻り値
  //   venue, isCurrent  … isCurrent が false（= state.venue 以外の会場）のときは
  //                        初期在庫・残数が «その会場のもの» ではないので null にする
  //   total             … その会場の履歴件数（= 配った個数）
  //   dates             … [{ key:"2026/10/02", label:"10/2", wd:"金" }]（昇順）
  //   groups            … 等級ごと [{ rankId, rankLabel, items:[{ id, name, initial, stock, byDate, total, removed }],
  //                                  byDate, total, initial, stock }]
  //   grand             … { byDate, total, initial, stock }
  //   people / jackpot  … { byDate, total }  抽選した人数 / 特賞に当たった回数
  //   hourly            … { labels, cells[hour][dateIdx], byHour[], byDate[], total }（人数ベース）
  //   details           … 時刻順 [{ ts, text, rankLabel, itemName, note }]
  //   otherVenues       … [{ venue, count }]  history にある «他の会場» の件数
  function summarize(state, venue) {
    var st = state || {};
    var history = Array.isArray(st.history) ? st.history : [];
    var ranks = Array.isArray(st.ranks) ? st.ranks : [];
    var v = (typeof venue === "string") ? venue : (st.venue || "");
    var isCurrent = (v === st.venue);

    // 対象行（壊れた行は読み飛ばす）
    var rows = [];
    var others = {};
    var otherOrder = [];
    for (var i = 0; i < history.length; i++) {
      var h = history[i];
      if (!h || !isFinite(Number(h.ts))) continue;
      var hv = (typeof h.venue === "string") ? h.venue : "";
      if (hv !== v) {
        if (!others.hasOwnProperty(hv)) { others[hv] = 0; otherOrder.push(hv); }
        others[hv]++;
        continue;
      }
      rows.push(h);
    }
    rows.sort(function (a, b) { return Number(a.ts) - Number(b.ts); });

    // 日付の列
    var dates = [];
    var dateIdx = {};
    for (var r = 0; r < rows.length; r++) {
      var k = dateKey(rows[r].ts);
      if (!dateIdx.hasOwnProperty(k)) {
        dateIdx[k] = -1;
        dates.push(k);
      }
    }
    dates.sort();
    for (var di = 0; di < dates.length; di++) dateIdx[dates[di]] = di;
    var nd = dates.length;
    var dateInfo = dates.map(function (k2) {
      var p = k2.split("/");
      var wd = WEEKDAYS[new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getDay()];
      return { key: k2, label: Number(p[1]) + "/" + Number(p[2]), wd: wd };
    });

    // 等級→品目の入れ物（現在の ranks の並び＝等級順）
    var groups = [];
    var groupByRank = {};
    var itemByKey = {};

    function addGroup(rankId, rankLabel) {
      var g = { rankId: rankId, rankLabel: rankLabel, items: [], byDate: zeros(nd), total: 0,
                initial: isCurrent ? 0 : null, stock: isCurrent ? 0 : null };
      groups.push(g);
      groupByRank[rankId] = g;
      return g;
    }
    function addItem(g, id, name, initial, stock, removed) {
      var it = { id: id, name: name, initial: isCurrent ? initial : null,
                 stock: isCurrent ? stock : null, byDate: zeros(nd), total: 0, removed: !!removed };
      g.items.push(it);
      itemByKey[g.rankId + "\u0001" + id] = it;
      return it;
    }

    for (var a = 0; a < ranks.length; a++) {
      var rk = ranks[a];
      if (!rk) continue;
      var rItems = Array.isArray(rk.items) ? rk.items : [];
      // 特賞は自前の品目を持たない。品目が無い等級は表に出さない
      if (rk.jackpot && rItems.length === 0) continue;
      if (rItems.length === 0) continue;
      var g = addGroup(rk.id, rk.label);
      for (var b = 0; b < rItems.length; b++) {
        var ri = rItems[b];
        var ini = Number(ri.initial); if (!isFinite(ini)) ini = 0;
        var stk = Number(ri.stock); if (!isFinite(stk)) stk = 0;
        addItem(g, ri.id, ri.name, ini, stk, false);
        if (isCurrent) { g.initial += ini; g.stock += stk; }
      }
    }

    var people = { byDate: zeros(nd), total: 0 };
    var jackpot = { byDate: zeros(nd), total: 0 };
    var cells = [];
    for (var hb = 0; hb < HOUR_BUCKETS; hb++) cells.push(zeros(nd));
    var details = [];

    for (var n = 0; n < rows.length; n++) {
      var row = rows[n];
      var di2 = dateIdx[dateKey(row.ts)];
      var gg = groupByRank[row.rankId];
      if (!gg) gg = addGroup(row.rankId, row.rankLabel || row.rankId);
      // 等級の byDate は後から groups が増える可能性があるので長さを揃える
      var it2 = itemByKey[gg.rankId + "\u0001" + row.itemId];
      if (!it2) it2 = addItem(gg, row.itemId, row.itemName || row.itemId, null, null, true);
      it2.byDate[di2]++; it2.total++;
      gg.byDate[di2]++; gg.total++;

      if (isPerson(row.note)) {
        people.byDate[di2]++; people.total++;
        cells[hourBucket(row.ts)][di2]++;
      }
      if (isJackpotFirst(row.note)) { jackpot.byDate[di2]++; jackpot.total++; }

      details.push({ ts: Number(row.ts), text: fmtDateTime(row.ts, true),
                     rankLabel: row.rankLabel || "", itemName: row.itemName || "",
                     note: (typeof row.note === "string") ? row.note : "" });
    }

    var grand = { byDate: zeros(nd), total: 0, initial: isCurrent ? 0 : null, stock: isCurrent ? 0 : null };
    for (var q = 0; q < groups.length; q++) {
      var gq = groups[q];
      for (var z = 0; z < nd; z++) grand.byDate[z] += gq.byDate[z];
      grand.total += gq.total;
      if (isCurrent) { grand.initial += gq.initial; grand.stock += gq.stock; }
    }

    var byHour = zeros(HOUR_BUCKETS);
    var byDateHour = zeros(nd);
    for (var c = 0; c < HOUR_BUCKETS; c++) {
      for (var e = 0; e < nd; e++) { byHour[c] += cells[c][e]; byDateHour[e] += cells[c][e]; }
    }

    var otherVenues = otherOrder.map(function (ov) { return { venue: ov, count: others[ov] }; });

    return {
      venue: v,
      isCurrent: isCurrent,
      total: rows.length,
      dates: dateInfo,
      groups: groups,
      grand: grand,
      people: people,
      jackpot: jackpot,
      hourly: { labels: HOUR_LABELS.slice(), cells: cells, byHour: byHour, byDate: byDateHour, total: people.total },
      details: details,
      otherVenues: otherVenues
    };
  }

  // ページ構成。履歴0件なら集計ページ1枚（«記録はまだありません»）だけ
  function buildPages(sum) {
    if (!sum || sum.total === 0) return [{ type: "summary" }];
    var pages = [{ type: "summary" }, { type: "hourly" }];
    for (var i = 0; i < sum.details.length; i += ROWS_PER_PAGE) {
      pages.push({ type: "detail", from: i, to: Math.min(sum.details.length, i + ROWS_PER_PAGE) });
    }
    return pages;
  }

  // ---- 全画面ビュー（DOM） -------------------------------------------------
  // 品名などデータ由来の文字列は必ず textContent で入れる（innerHTML は使わない）

  var rootEl = null;
  var view = null; // { state, venue, sum, pages, page }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function ensureStyle() {
    if (document.getElementById("nv-records-style")) return;
    var s = document.createElement("style");
    s.id = "nv-records-style";
    // 寸法は --u（= 画面幅の1% か、縦の 0.5625% の小さい方）。1080×1920 で 1u=10.8px、2160×3840 で 21.6px。
    // 縦長の 9:16 のシートを中央に置くので、横向きや小さい画面でも崩れない。
    // min() / calc() は Chrome 98 で使える。:has・dvh・ネストは使わない
    s.textContent =
      "#records-root{position:fixed;left:0;top:0;right:0;bottom:0;z-index:9300;background:#fff;" +
        "display:flex;align-items:center;justify-content:center;overflow:hidden;" +
        "--u:min(1vw,0.5625vh);}" +
      "#records-root, #records-root *{box-sizing:border-box;}" +
      ".nvr-sheet{width:calc(var(--u)*100);height:calc(var(--u)*177.7778);background:#fff;color:#000;" +
        "display:flex;flex-direction:column;overflow:hidden;" +
        "font-family:'Noto Sans JP','Hiragino Sans',system-ui,sans-serif;font-size:calc(var(--u)*2.7);" +
        "line-height:1.25;font-variant-numeric:tabular-nums;}" +
      ".nvr-head{flex:none;padding:calc(var(--u)*1.6) calc(var(--u)*4) calc(var(--u)*1.4);" +
        "border-bottom:calc(var(--u)*.5) solid #000;}" +
      ".nvr-head-1{display:flex;justify-content:space-between;align-items:baseline;" +
        "font-size:calc(var(--u)*4.6);font-weight:700;}" +
      ".nvr-head-2{display:flex;justify-content:space-between;align-items:baseline;margin-top:calc(var(--u)*.6);" +
        "font-size:calc(var(--u)*2.7);}" +
      ".nvr-body{flex:1 1 auto;min-height:0;overflow:hidden;padding:calc(var(--u)*1.6) calc(var(--u)*4) 0;}" +
      ".nvr-foot{flex:none;display:flex;gap:calc(var(--u)*2);padding:calc(var(--u)*1.8) calc(var(--u)*4);" +
        "border-top:calc(var(--u)*.5) solid #000;}" +
      ".nvr-btn{flex:1 1 0;height:calc(var(--u)*10);border:calc(var(--u)*.5) solid #000;background:#fff;color:#000;" +
        "font-family:inherit;font-size:calc(var(--u)*4.2);font-weight:700;padding:0;border-radius:0;cursor:pointer;}" +
      ".nvr-btn.close{background:#000;color:#fff;}" +
      ".nvr-btn[disabled]{color:#888;border-color:#888;cursor:default;}" +
      ".nvr-tbl{width:100%;border-collapse:collapse;table-layout:fixed;}" +
      ".nvr-tbl th,.nvr-tbl td{border:calc(var(--u)*.2) solid #000;padding:0 calc(var(--u)*.8);height:calc(var(--u)*4.5);" +
        "text-align:right;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}" +
      ".nvr-tbl th{background:#e6e6e6;font-weight:700;text-align:center;}" +
      ".nvr-tbl td.l,.nvr-tbl th.l{text-align:left;}" +
      ".nvr-tbl td.name{white-space:normal;line-height:1.1;font-size:calc(var(--u)*2.7);}" +
      ".nvr-tbl tr.grp td{background:#d4d4d4;font-weight:700;}" +
      ".nvr-tbl tr.sum td{background:#bdbdbd;font-weight:700;}" +
      ".nvr-tbl tr.gap td{border:none;height:calc(var(--u)*1.6);}" +
      ".nvr-tbl th .wd{display:block;font-size:calc(var(--u)*2.2);font-weight:400;line-height:1;}" +
      ".nvr-tbl th .dl{display:block;line-height:1.05;}" +
      ".nvr-tbl.detail td{height:calc(var(--u)*5.4);}" +
      ".nvr-tbl.detail th{height:calc(var(--u)*5.4);}" +
      ".nvr-tbl.detail td{text-align:left;}" +
      // 長い品名は2行まで（行の高さは固定。1行目で切れると何の品か分からなくなる）
      ".nvr-tbl.detail td.it{white-space:normal;line-height:1.05;font-size:calc(var(--u)*2.35);" +
        "display:table-cell;overflow:hidden;text-overflow:clip;}" +
      ".nvr-tbl.hourly td,.nvr-tbl.hourly th{height:calc(var(--u)*6.8);}" +
      ".nvr-tbl.hourly td.l{font-weight:700;}" +
      ".nvr-note{margin:calc(var(--u)*1.2) 0 0;font-size:calc(var(--u)*2.7);}" +
      ".nvr-empty{margin:calc(var(--u)*30) 0;text-align:center;font-size:calc(var(--u)*6);font-weight:700;}" +
      ".nvr-venues{display:flex;gap:calc(var(--u)*1.6);flex-wrap:wrap;margin-top:calc(var(--u)*1.2);}" +
      ".nvr-vbtn{min-height:calc(var(--u)*7);padding:0 calc(var(--u)*2.4);border:calc(var(--u)*.4) solid #000;background:#fff;" +
        "color:#000;font-family:inherit;font-size:calc(var(--u)*2.9);font-weight:700;border-radius:0;cursor:pointer;}" +
      ".nvr-vbtn.on{background:#000;color:#fff;}";
    document.head.appendChild(s);
  }

  function num(v) { return (v === null || v === undefined) ? "—" : String(v); }

  function addCell(tr, text, cls) {
    var td = el("td", cls || "", text);
    tr.appendChild(td);
    return td;
  }

  function headCell(tr, text, cls) {
    var th = el("th", cls || "", text);
    tr.appendChild(th);
    return th;
  }

  function dateHead(tr, d) {
    var th = el("th", "");
    th.appendChild(el("span", "dl", d.label));
    th.appendChild(el("span", "wd", "(" + d.wd + ")"));
    tr.appendChild(th);
  }

  // ページ1：集計
  function renderSummary(body, sum) {
    if (sum.total === 0) {
      body.appendChild(el("div", "nvr-empty", "記録はまだありません"));
    } else {
      var showStock = sum.isCurrent;
      var nd = sum.dates.length;
      var tbl = el("table", "nvr-tbl");
      // 列幅：品目 = 残り、日付 = 各 11u、計 = 11u、初期/残 = 各 10u
      var colg = document.createElement("colgroup");
      var c0 = document.createElement("col"); colg.appendChild(c0);
      var i;
      for (i = 0; i < nd + 1; i++) {
        var cd = document.createElement("col");
        cd.style.width = "calc(var(--u)*" + (nd > 3 ? 9.5 : 11) + ")";
        colg.appendChild(cd);
      }
      if (showStock) {
        for (i = 0; i < 2; i++) {
          var cs = document.createElement("col");
          cs.style.width = "calc(var(--u)*" + (nd > 3 ? 9 : 10.5) + ")";
          colg.appendChild(cs);
        }
      }
      tbl.appendChild(colg);

      var thead = document.createElement("thead");
      var hr = document.createElement("tr");
      headCell(hr, "品目", "l");
      for (i = 0; i < nd; i++) dateHead(hr, sum.dates[i]);
      headCell(hr, "計");
      if (showStock) { headCell(hr, "初期"); headCell(hr, "残"); }
      thead.appendChild(hr);
      tbl.appendChild(thead);

      var tb = document.createElement("tbody");
      var g, k, tr;
      for (g = 0; g < sum.groups.length; g++) {
        var grp = sum.groups[g];
        tr = el("tr", "grp");
        addCell(tr, grp.rankLabel + " 小計", "l");
        for (i = 0; i < nd; i++) addCell(tr, grp.byDate[i]);
        addCell(tr, grp.total);
        if (showStock) { addCell(tr, num(grp.initial)); addCell(tr, num(grp.stock)); }
        tb.appendChild(tr);
        for (k = 0; k < grp.items.length; k++) {
          var it = grp.items[k];
          tr = el("tr", "");
          addCell(tr, it.name + (it.removed ? "（削除済み）" : ""), "l name");
          for (i = 0; i < nd; i++) addCell(tr, it.byDate[i]);
          addCell(tr, it.total);
          if (showStock) { addCell(tr, num(it.initial)); addCell(tr, num(it.stock)); }
          tb.appendChild(tr);
        }
      }
      tr = el("tr", "sum");
      addCell(tr, "総計（個）", "l");
      for (i = 0; i < nd; i++) addCell(tr, sum.grand.byDate[i]);
      addCell(tr, sum.grand.total);
      if (showStock) { addCell(tr, num(sum.grand.initial)); addCell(tr, num(sum.grand.stock)); }
      tb.appendChild(tr);

      tr = el("tr", "gap");
      var gt = el("td", ""); gt.colSpan = 1 + nd + 1 + (showStock ? 2 : 0);
      tr.appendChild(gt); tb.appendChild(tr);

      tr = el("tr", "sum");
      addCell(tr, "抽選した人数", "l");
      for (i = 0; i < nd; i++) addCell(tr, sum.people.byDate[i]);
      addCell(tr, sum.people.total);
      if (showStock) { addCell(tr, ""); addCell(tr, ""); }
      tb.appendChild(tr);

      tr = el("tr", "");
      addCell(tr, "うち特賞の回数", "l");
      for (i = 0; i < nd; i++) addCell(tr, sum.jackpot.byDate[i]);
      addCell(tr, sum.jackpot.total);
      if (showStock) { addCell(tr, ""); addCell(tr, ""); }
      tb.appendChild(tr);

      tbl.appendChild(tb);
      body.appendChild(tbl);
      if (!showStock) {
        body.appendChild(el("p", "nvr-note", "※初期在庫・残数は現在の会場の設定にだけ入っているため、この会場では出していません"));
      }
    }
  }

  // ページ2：時間帯別（人数）
  function renderHourly(body, sum) {
    var nd = sum.dates.length;
    var tbl = el("table", "nvr-tbl hourly");
    var thead = document.createElement("thead");
    var hr = document.createElement("tr");
    headCell(hr, "時間帯（人数）", "l");
    var i, h, tr;
    for (i = 0; i < nd; i++) dateHead(hr, sum.dates[i]);
    headCell(hr, "計");
    thead.appendChild(hr);
    tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    for (h = 0; h < sum.hourly.labels.length; h++) {
      tr = el("tr", "");
      addCell(tr, sum.hourly.labels[h], "l");
      for (i = 0; i < nd; i++) addCell(tr, sum.hourly.cells[h][i]);
      addCell(tr, sum.hourly.byHour[h]);
      tb.appendChild(tr);
    }
    tr = el("tr", "sum");
    addCell(tr, "計", "l");
    for (i = 0; i < nd; i++) addCell(tr, sum.hourly.byDate[i]);
    addCell(tr, sum.hourly.total);
    tb.appendChild(tr);
    tbl.appendChild(tb);
    body.appendChild(tbl);
    body.appendChild(el("p", "nvr-note", "※1人＝1回の抽選（特賞で複数個選んだ場合も1人）"));
  }

  // ページ3〜：明細
  function renderDetail(body, sum, page) {
    var tbl = el("table", "nvr-tbl detail");
    var colg = document.createElement("colgroup");
    var widths = ["calc(var(--u)*24.5)", "calc(var(--u)*9)", "", "calc(var(--u)*16)"];
    for (var w = 0; w < widths.length; w++) {
      var c = document.createElement("col");
      if (widths[w]) c.style.width = widths[w];
      colg.appendChild(c);
    }
    tbl.appendChild(colg);
    var thead = document.createElement("thead");
    var hr = document.createElement("tr");
    headCell(hr, "日時", "l"); headCell(hr, "等級", "l"); headCell(hr, "品目", "l"); headCell(hr, "備考", "l");
    thead.appendChild(hr);
    tbl.appendChild(thead);
    var tb = document.createElement("tbody");
    for (var i = page.from; i < page.to; i++) {
      var d = sum.details[i];
      var tr = document.createElement("tr");
      // 日時は「月/日 時:分:秒」（年は各ページの上部に出ている表示日時で足りる）
      var p = d.text.split(" ");
      addCell(tr, p[0].slice(5) + " " + p[1]);
      addCell(tr, d.rankLabel);
      addCell(tr, d.itemName, "it");
      addCell(tr, d.note);
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    body.appendChild(tbl);
  }

  function render() {
    if (!rootEl || !view) return;
    var sum = view.sum;
    var pages = view.pages;
    if (view.page < 0) view.page = 0;
    if (view.page > pages.length - 1) view.page = pages.length - 1;
    var page = pages[view.page];

    while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
    var sheet = el("div", "nvr-sheet");

    var title = page.type === "summary" ? "集計" : (page.type === "hourly" ? "時間帯別" : "明細");
    var head = el("div", "nvr-head");
    var h1 = el("div", "nvr-head-1");
    h1.appendChild(el("span", "", sum.venue + "　" + title));
    h1.appendChild(el("span", "", (view.page + 1) + "/" + pages.length));
    var h2 = el("div", "nvr-head-2");
    h2.appendChild(el("span", "", "表示 " + fmtDateTime(Date.now(), false)));
    var ver = "";
    try { ver = (NV.defaults && NV.defaults.APP_VERSION) || ""; } catch (e) {}
    h2.appendChild(el("span", "", "ノベルティ抽選 " + ver));
    head.appendChild(h1);
    head.appendChild(h2);
    sheet.appendChild(head);

    var body = el("div", "nvr-body");
    if (page.type === "summary") {
      renderSummary(body, sum);
      // 他の会場の記録があるときは、切り替えて見られるようにする
      if (sum.otherVenues.length > 0 || !sum.isCurrent) {
        var cur = view.state && view.state.venue;
        var info = [];
        var j;
        for (j = 0; j < sum.otherVenues.length; j++) {
          info.push((sum.otherVenues[j].venue || "（会場不明）") + " " + sum.otherVenues[j].count + "件");
        }
        if (info.length) body.appendChild(el("p", "nvr-note", "他の会場の記録あり：" + info.join("、")));
        var box = el("div", "nvr-venues");
        var list = [cur];
        for (j = 0; j < sum.otherVenues.length; j++) {
          if (list.indexOf(sum.otherVenues[j].venue) === -1) list.push(sum.otherVenues[j].venue);
        }
        if (list.indexOf(sum.venue) === -1) list.push(sum.venue);
        for (j = 0; j < list.length; j++) {
          (function (name) {
            var b = el("button", "nvr-vbtn" + (name === sum.venue ? " on" : ""),
                       (name || "（会場不明）") + (name === cur ? "（いま）" : ""));
            b.type = "button";
            b.addEventListener("click", function () { switchVenue(name); });
            box.appendChild(b);
          })(list[j]);
        }
        body.appendChild(box);
      }
    } else if (page.type === "hourly") {
      renderHourly(body, sum);
    } else {
      renderDetail(body, sum, page);
    }
    sheet.appendChild(body);

    var foot = el("div", "nvr-foot");
    var prev = el("button", "nvr-btn", "前へ"); prev.type = "button";
    var next = el("button", "nvr-btn", "次へ"); next.type = "button";
    var close = el("button", "nvr-btn close", "閉じる"); close.type = "button";
    if (view.page <= 0) prev.disabled = true;
    if (view.page >= pages.length - 1) next.disabled = true;
    prev.addEventListener("click", function () { go(-1); });
    next.addEventListener("click", function () { go(1); });
    close.addEventListener("click", closeView);
    foot.appendChild(prev); foot.appendChild(next); foot.appendChild(close);
    sheet.appendChild(foot);

    rootEl.appendChild(sheet);
  }

  function go(d) {
    if (!view) return;
    view.page += d;
    render();
  }

  function switchVenue(name) {
    if (!view) return;
    view.venue = name;
    view.sum = summarize(view.state, name);
    view.pages = buildPages(view.sum);
    view.page = 0;
    render();
  }

  function open(state) {
    try {
      ensureStyle();
      if (!rootEl) {
        rootEl = document.createElement("div");
        rootEl.id = "records-root";
        document.body.appendChild(rootEl);
      }
      var sum = summarize(state, state && state.venue);
      view = { state: state, venue: sum.venue, sum: sum, pages: buildPages(sum), page: 0 };
      rootEl.style.display = "flex";
      render();
    } catch (e) {
      console.warn("[NV.records] open failed:", e);
    }
  }

  function closeView() {
    view = null;
    if (rootEl) {
      while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
      rootEl.style.display = "none";
    }
  }

  window.NV.records = {
    summarize: summarize,
    buildPages: buildPages,
    isPerson: isPerson,
    open: open,
    close: closeView,
    ROWS_PER_PAGE: ROWS_PER_PAGE
  };
})();
