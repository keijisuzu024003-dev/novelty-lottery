// js/settings.js
// スタッフ専用の設定画面。派手さより「確実に操作できる」ことを優先する。
// prompt() は PWA 全画面表示で挙動が不安定になることがあるため使わない。
// PIN 入力・在庫初期化などの確認も含め、ダイアログは全て自前で #settings-root に描画する。
// ------------------------------------------------------------
window.NV = window.NV || {};

(function () {
  "use strict";

  var root = null;          // #settings-root への参照（初回アクセス時に取得）
  var state = null;         // 現在編集中の state（呼び出し元と同じオブジェクトを直接書き換える）
  var onSavedCb = null;     // 変更のたびに呼ぶコールバック
  var pinInput = "";        // PIN 入力中のバッファ
  var wrongCount = 0;       // PIN 誤入力回数

  function getRoot() {
    if (!root) root = document.getElementById("settings-root");
    return root;
  }

  // 等級名や品目名をそのまま HTML に流し込むので、記号でタグが壊れないようにする
  function esc(v) {
    return String(v == null ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function toNum(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  function notify() {
    if (typeof onSavedCb === "function") {
      try { onSavedCb(state); } catch (e) { console.warn("[NV.settings] onSaved failed:", e); }
    }
    try { refreshBoard(); } catch (e) {}
  }

  // ---- 見た目（自前でスタイルを持つ。app.css には依存しない） ----------

  function ensureStyle() {
    if (document.getElementById("nv-settings-style")) return;
    var style = document.createElement("style");
    style.id = "nv-settings-style";
    style.textContent =
      "#settings-root{display:none;}" +
      "body.settings-open #settings-root{display:block;}" +
      "#settings-root, #settings-root *{box-sizing:border-box;}" +
      ".nvs-overlay{position:fixed;inset:0;background:rgba(6,5,4,0.82);z-index:9000;" +
        "display:flex;align-items:center;justify-content:center;padding:16px;" +
        "font-family:'Noto Sans JP','Hiragino Sans',system-ui,sans-serif;}" +
      ".nvs-panel{background:#131110;color:#F4EFE4;width:min(96vw,880px);max-height:92vh;" +
        "overflow-y:auto;border-radius:3px;border:1px solid #3A342B;padding:20px;}" +
      ".nvs-pin-panel{background:#131110;color:#F4EFE4;border-radius:3px;border:1px solid #3A342B;" +
        "padding:24px;width:min(92vw,340px);text-align:center;}" +
      ".nvs-h1{font-size:20px;font-weight:700;margin:0 0 12px;display:flex;justify-content:space-between;align-items:center;}" +
      ".nvs-h2{font-size:15px;font-weight:700;margin:20px 0 8px;color:#9A9081;border-bottom:1px solid #3A342B;padding-bottom:6px;}" +
      ".nvs-row{display:flex;align-items:center;gap:8px;margin:8px 0;flex-wrap:wrap;}" +
      ".nvs-label{font-size:13px;color:#9A9081;min-width:96px;}" +
      ".nvs-btn{min-height:44px;padding:0 16px;border-radius:2px;border:none;font-size:14px;" +
        "font-weight:700;cursor:pointer;background:linear-gradient(#C9A24B,#9C7A2E);color:#0B0A09;}" +
      ".nvs-btn.secondary{background:#1C1917;color:#fff;border:1px solid #4A4335;}" +
      ".nvs-btn.danger{background:#9E3129;color:#fff;}" +
      ".nvs-input{min-height:44px;border-radius:2px;border:1px solid #4A4335;background:#0E0D0B;" +
        "color:#fff;padding:0 10px;font-size:14px;}" +
      ".nvs-input.num{width:80px;}" +
      ".nvs-input.name{flex:1;min-width:120px;}" +
      ".nvs-color{width:52px;height:44px;padding:2px;border-radius:2px;border:1px solid #4A4335;background:#0E0D0B;}" +
      ".nvs-rank-card{border:1px solid #3A342B;border-radius:3px;padding:12px;margin:10px 0;background:#181513;}" +
      ".nvs-item-row{display:flex;align-items:center;gap:8px;margin:6px 0;padding:6px;background:#0E0D0B;border-radius:2px;flex-wrap:wrap;}" +
      ".nvs-muted{color:#9A9081;font-size:12px;}" +
      // 配布状況ボード。スクロールせずに «いまどうなっているか» だけ読めるようにする
      ".nvs-board{margin:0 0 18px;padding:14px 16px 16px;background:#17140F;border:1px solid #3A342B;border-radius:4px;}" +
      ".nvs-board-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px;}" +
      ".nvs-board-venue{font-size:19px;font-weight:700;color:#FFF;letter-spacing:.06em;}" +
      ".nvs-board-sub{font-size:12px;color:#9A9081;}" +
      ".nvs-board-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;}" +
      ".nvs-board-cell{background:#0E0D0B;border:1px solid #3A342B;border-radius:3px;padding:10px 12px 12px;display:flex;flex-direction:column;gap:2px;}" +
      ".nvs-board-cell .c-label{font-size:11px;color:#9A9081;letter-spacing:.1em;}" +
      ".nvs-board-cell .c-num{font-size:30px;font-weight:700;line-height:1.1;color:#FFF;font-variant-numeric:tabular-nums;}" +
      ".nvs-board-cell .c-sub{font-size:11px;color:#8C8375;font-variant-numeric:tabular-nums;}" +
      ".nvs-board-cell .c-bar{display:block;height:3px;margin-top:8px;background:#3A342B;border-radius:99px;overflow:hidden;}" +
      ".nvs-board-cell .c-bar i{display:block;height:100%;background:#C9A24B;}" +
      ".nvs-board-cell.low{border-color:#8A6B24;}" +
      ".nvs-board-cell.low .c-bar i{background:#E8B33C;}" +
      ".nvs-board-cell.low .c-num{color:#F2DFAD;}" +
      ".nvs-board-cell.out{border-color:#6B2019;opacity:.75;}" +
      ".nvs-board-cell.out .c-bar i{background:#9E3129;}" +
      ".nvs-board-cell.out .c-num{color:#E39184;}" +
      ".nvs-board-cell.total{background:#100E0C;}" +
      ".nvs-board-cell.total .c-num{color:#F2DFAD;}" +
      ".nvs-prob{font-size:12px;color:#FFD97A;}" +
      ".nvs-keypad{display:grid;grid-template-columns:repeat(3,72px);gap:10px;justify-content:center;margin:18px 0;}" +
      ".nvs-key{min-height:56px;font-size:22px;border-radius:3px;border:1px solid #4A4335;background:#0E0D0B;color:#fff;cursor:pointer;}" +
      ".nvs-dots{font-size:28px;letter-spacing:10px;min-height:36px;margin:8px 0;}" +
      ".nvs-error{color:#FF9C9C;font-size:13px;min-height:18px;}" +
      ".nvs-msg{font-size:13px;color:#8CF5A0;min-height:18px;}" +
      ".nvs-toggle-row{display:flex;align-items:center;gap:10px;}" +
      ".nvs-confirm-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9500;" +
        "display:flex;align-items:center;justify-content:center;padding:16px;}" +
      ".nvs-confirm-box{background:#131110;border:1px solid #4A4335;border-radius:14px;padding:20px;" +
        "max-width:360px;color:#fff;text-align:center;}" +
      ".nvs-confirm-box p{font-size:14px;line-height:1.6;margin:0 0 16px;white-space:pre-wrap;}" +
      ".nvs-confirm-btns{display:flex;gap:10px;justify-content:center;}";
    document.head.appendChild(style);
  }

  // ---- 汎用の確認ダイアログ（自前実装。confirm() は使わない） -----------

  function showConfirm(message, okLabel, onOk) {
    var overlay = document.createElement("div");
    overlay.className = "nvs-confirm-overlay";
    overlay.innerHTML =
      '<div class="nvs-confirm-box">' +
        '<p></p>' +
        '<div class="nvs-confirm-btns">' +
          '<button type="button" class="nvs-btn secondary" data-c="no">キャンセル</button>' +
          '<button type="button" class="nvs-btn danger" data-c="yes"></button>' +
        '</div>' +
      '</div>';
    overlay.querySelector("p").textContent = message;
    overlay.querySelector('[data-c="yes"]').textContent = okLabel;
    overlay.addEventListener("click", function (e) {
      var t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-c") === "yes") {
        document.body.removeChild(overlay);
        onOk();
      } else if (t && t.getAttribute && t.getAttribute("data-c") === "no") {
        document.body.removeChild(overlay);
      }
    });
    document.body.appendChild(overlay);
  }

  // ---- PIN 入力ダイアログ -------------------------------------------

  function renderPinDialog(errorMsg) {
    var r = getRoot();
    if (!r) return;
    document.body.classList.add("settings-open");

    var dots = "";
    for (var i = 0; i < pinInput.length; i++) dots += "●";
    if (dots === "") dots = " "; // 高さを保つための空白

    var html =
      '<div class="nvs-overlay" data-role="pin-overlay">' +
        '<div class="nvs-pin-panel">' +
          '<div class="nvs-h1"><span>スタッフ設定</span>' +
            '<button type="button" class="nvs-btn secondary" data-action="pin-cancel" style="min-height:36px;padding:0 12px;font-size:12px;">キャンセル</button>' +
          '</div>' +
          '<div class="nvs-muted">PIN を入力してください</div>' +
          '<div class="nvs-dots">' + dots + '</div>' +
          '<div class="nvs-error">' + (errorMsg || "") + '</div>' +
          '<div class="nvs-keypad" id="nvs-keypad"></div>' +
          '<button type="button" class="nvs-btn" data-action="pin-ok" style="width:100%;">OK</button>' +
        '</div>' +
      '</div>';
    r.innerHTML = html;

    var keypad = r.querySelector("#nvs-keypad");
    var digits = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "訂正", "0", "C"];
    for (var d = 0; d < digits.length; d++) {
      (function (label) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "nvs-key";
        btn.textContent = label;
        btn.addEventListener("click", function () {
          if (label === "訂正") {
            pinInput = pinInput.slice(0, -1);
          } else if (label === "C") {
            pinInput = "";
          } else {
            if (pinInput.length < 12) pinInput += label;
          }
          renderPinDialog();
        });
        keypad.appendChild(btn);
      })(digits[d]);
    }

    r.querySelector('[data-action="pin-ok"]').addEventListener("click", function () {
      var correct = state && state.settings && typeof state.settings.pin === "string" ? state.settings.pin : "";
      if (pinInput.length > 0 && pinInput === correct) {
        wrongCount = 0;
        pinInput = "";
        renderSettingsBody();
      } else {
        wrongCount++;
        pinInput = "";
        if (wrongCount >= 3) {
          closeInternal();
        } else {
          renderPinDialog("PIN が違います（あと " + (3 - wrongCount) + " 回）");
        }
      }
    });

    r.querySelector('[data-action="pin-cancel"]').addEventListener("click", function () {
      closeInternal();
    });
  }

  // ---- 色の自動暗色化（等級カラーから colorDark を作る） -----------------

  function darken(hex, factor) {
    try {
      var h = String(hex).replace("#", "");
      if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join("");
      var r = parseInt(h.substring(0, 2), 16);
      var g = parseInt(h.substring(2, 4), 16);
      var b = parseInt(h.substring(4, 6), 16);
      if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return hex;
      r = Math.max(0, Math.min(255, Math.round(r * (1 - factor))));
      g = Math.max(0, Math.min(255, Math.round(g * (1 - factor))));
      b = Math.max(0, Math.min(255, Math.round(b * (1 - factor))));
      function h2(n) { var s = n.toString(16); return s.length < 2 ? "0" + s : s; }
      return "#" + h2(r) + h2(g) + h2(b);
    } catch (e) {
      return hex;
    }
  }

  function genId(prefix) {
    return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ---- 実効確率・残数の再表示（DOM を作り直さず数値だけ更新） -------------

  function refreshDerived() {
    var r = getRoot();
    if (!r) return;
    var probMap = {};
    var eff = window.NV.lottery ? window.NV.lottery.effectiveWeights(state) : [];
    for (var i = 0; i < eff.length; i++) probMap[eff[i].rankId] = eff[i].prob;

    var ranks = state.ranks || [];
    for (var j = 0; j < ranks.length; j++) {
      var rank = ranks[j];
      var totalEl = r.querySelector('[data-total-for="' + rank.id + '"]');
      if (totalEl) totalEl.textContent = String(window.NV.lottery ? window.NV.lottery.rankStock(rank) : 0);

      var probEl = r.querySelector('[data-prob-for="' + rank.id + '"]');
      if (probEl) {
        var setPct = toNum(rank.weight, 0);
        if (Object.prototype.hasOwnProperty.call(probMap, rank.id)) {
          var effPct = Math.round(probMap[rank.id] * 1000) / 10;
          probEl.textContent = "設定 " + setPct + "% → 実効 " + effPct + "%";
        } else {
          probEl.textContent = "設定 " + setPct + "% → 実効 0%（在庫切れ）";
        }
      }

      var items = rank.items || [];
      for (var k = 0; k < items.length; k++) {
        var it = items[k];
        var infoEl = r.querySelector('[data-rem-for="' + rank.id + '|' + it.id + '"]');
        if (infoEl) infoEl.textContent = "残 " + toNum(it.stock, 0) + " / 初期 " + toNum(it.initial, 0);
      }
    }
  }

  // ---- 等級カード（品目の追加/削除があるので個別に作り直せるようにする） -----

  function renderRankCard(rank, index) {
    var card = document.createElement("div");
    card.className = "nvs-rank-card";
    card.setAttribute("data-rank-card", rank.id);

    var head = document.createElement("div");
    head.className = "nvs-row";
    head.innerHTML =
      '<span class="nvs-label">等級名</span>' +
      '<input type="text" class="nvs-input name" data-action="rank-label" data-rank="' + rank.id + '" value="">' +
      '<span class="nvs-label" style="min-width:auto;">色</span>' +
      '<input type="color" class="nvs-color" data-action="rank-color" data-rank="' + rank.id + '" value="' + rank.color + '">' +
      '<span class="nvs-label" style="min-width:auto;">確率(%)</span>' +
      '<input type="number" inputmode="numeric" min="0" class="nvs-input num" data-action="rank-weight" data-rank="' + rank.id + '" value="' + toNum(rank.weight, 0) + '">';
    head.querySelector('[data-action="rank-label"]').value = rank.label;
    card.appendChild(head);

    var info = document.createElement("div");
    info.className = "nvs-row";
    info.innerHTML =
      '<span class="nvs-muted">在庫合計: <b data-total-for="' + rank.id + '">' + window.NV.lottery.rankStock(rank) + '</b> 個</span>' +
      '<span class="nvs-prob" data-prob-for="' + rank.id + '"></span>';
    card.appendChild(info);

    var itemsWrap = document.createElement("div");
    itemsWrap.setAttribute("data-items-for", rank.id);
    card.appendChild(itemsWrap);
    renderItemRows(itemsWrap, rank);

    var addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "nvs-btn secondary";
    addBtn.textContent = "＋ 品目を追加";
    addBtn.style.marginTop = "6px";
    addBtn.addEventListener("click", function () {
      rank.items = rank.items || [];
      rank.items.push({ id: genId("i"), name: "新しい品目", stock: 0, initial: 0 });
      renderItemRows(itemsWrap, rank);
      refreshDerived();
      notify();
    });
    card.appendChild(addBtn);

    return card;
  }

  function renderItemRows(container, rank) {
    container.innerHTML = "";
    var items = rank.items || [];
    for (var i = 0; i < items.length; i++) {
      (function (item) {
        var row = document.createElement("div");
        row.className = "nvs-item-row";
        row.innerHTML =
          '<input type="text" class="nvs-input name" data-action="item-name" data-rank="' + rank.id + '" data-item="' + item.id + '" value="">' +
          '<span class="nvs-label" style="min-width:auto;">在庫</span>' +
          '<input type="number" inputmode="numeric" min="0" class="nvs-input num" data-action="item-stock" data-rank="' + rank.id + '" data-item="' + item.id + '" value="' + toNum(item.stock, 0) + '">' +
          '<span class="nvs-muted" data-rem-for="' + rank.id + '|' + item.id + '"></span>' +
          '<button type="button" class="nvs-btn danger" data-action="item-remove" data-rank="' + rank.id + '" data-item="' + item.id + '" style="min-height:36px;padding:0 10px;font-size:12px;">削除</button>';
        row.querySelector('[data-action="item-name"]').value = item.name;
        row.querySelector('[data-rem-for]').textContent = "残 " + toNum(item.stock, 0) + " / 初期 " + toNum(item.initial, 0);
        container.appendChild(row);
      })(items[i]);
    }
  }

  // ---- 設定画面本体 ---------------------------------------------------

  // 音の状態を設定画面に出す。「鳴らない」が端末側かアプリ側かをその場で切り分けるため
  // D. 配布状況。設定画面をスクロールしないと残数が分からなかったので、
  // 先頭に「今どうなっているか」だけを大きく出す。会場での判断はここだけ見れば足りる。
  function statusBoardHtml() {
    return '' +
      '<div class="nvs-board" data-role="board">' +
        '<div class="nvs-board-head">' +
          '<span class="nvs-board-venue" data-role="b-venue"></span>' +
          '<span class="nvs-board-sub" data-role="b-sub"></span>' +
        '</div>' +
        '<div class="nvs-board-grid" data-role="b-grid"></div>' +
      '</div>';
  }

  function refreshBoard() {
    try {
      var root = document.querySelector('[data-role="board"]');
      if (!root) return;

      var hist = state.history || [];
      var venue = state.venue;
      var today = new Date(); today.setHours(0, 0, 0, 0);
      var t0 = today.getTime();

      var todayHere = 0, firstTs = 0, lastTs = 0;
      for (var i = 0; i < hist.length; i++) {
        var h = hist[i];
        if (h.venue !== venue || !(h.ts >= t0)) continue;
        todayHere++;
        if (!firstTs || h.ts < firstTs) firstTs = h.ts;
        if (h.ts > lastTs) lastTs = h.ts;
      }
      var hours = (firstTs && lastTs > firstTs) ? (lastTs - firstTs) / 3600000 : 0;
      var pace = hours > 0.08 ? Math.round(todayHere / hours) : null;

      root.querySelector('[data-role="b-venue"]').textContent = venue;
      root.querySelector('[data-role="b-sub"]').textContent =
        "本日 " + todayHere + " 回" + (pace !== null ? "（およそ " + pace + " 回/時）" : "");

      var grid = root.querySelector('[data-role="b-grid"]');
      var html = "";
      var ranks = state.ranks || [];
      var totalLeft = 0, totalInit = 0;
      for (var r = 0; r < ranks.length; r++) {
        var left = NV.lottery.rankStock(ranks[r]);
        var init = 0, items = ranks[r].items || [];
        for (var k = 0; k < items.length; k++) init += toNum(items[k].initial, 0);
        totalLeft += left; totalInit += init;
        var pct = init > 0 ? Math.round(left / init * 100) : 0;
        var low = (init > 0 && pct <= 15);
        html += '<div class="nvs-board-cell' + (left === 0 ? " out" : (low ? " low" : "")) + '">' +
                  '<span class="c-label">' + esc(ranks[r].label) + '</span>' +
                  '<span class="c-num">' + left + '</span>' +
                  '<span class="c-sub">/ ' + init + '　' + pct + '%</span>' +
                  '<span class="c-bar"><i style="width:' + pct + '%"></i></span>' +
                '</div>';
      }
      var tp = totalInit > 0 ? Math.round(totalLeft / totalInit * 100) : 0;
      html += '<div class="nvs-board-cell total">' +
                '<span class="c-label">合計</span>' +
                '<span class="c-num">' + totalLeft + '</span>' +
                '<span class="c-sub">/ ' + totalInit + '　' + tp + '%</span>' +
                '<span class="c-bar"><i style="width:' + tp + '%"></i></span>' +
              '</div>';
      grid.innerHTML = html;
    } catch (e) { /* 表示だけの機能なので失敗しても設定画面は開いたままにする */ }
  }

  function showSoundState() {
    try {
      var el = document.querySelector('[data-role="sound-state"]');
      if (!el) return;
      var st = (NV.sound && NV.sound.status) ? NV.sound.status() : null;
      if (!st) { el.textContent = ""; return; }
      if (st.ok) {
        el.textContent = "音は出せる状態です（" + st.state + " / 音量 " + st.volume + "）";
        el.style.color = "#7FE0A8";
      } else {
        el.textContent = "音が止まっています（" + st.state + "）"
          + (st.enabled === false ? " ※アプリ側でOFF" : " ※端末側の可能性");
        el.style.color = "#FFB4A2";
      }
    } catch (e) {}
  }

  function renderSettingsBody() {
    var r = getRoot();
    if (!r) return;
    document.body.classList.add("settings-open");

    var venues = (window.NV.defaults && window.NV.defaults.VENUES) || [];
    var venueOptions = "";
    for (var v = 0; v < venues.length; v++) {
      venueOptions += '<option value="' + venues[v] + '">' + venues[v] + '</option>';
    }

    var html =
      '<div class="nvs-overlay" data-role="settings-overlay">' +
        '<div class="nvs-panel">' +
          '<div class="nvs-h1"><span>スタッフ設定</span>' +
            '<button type="button" class="nvs-btn secondary" data-action="close">閉じる</button>' +
          '</div>' +
          '<div class="nvs-msg" id="nvs-msg"></div>' +

          statusBoardHtml() +
          '<div class="nvs-h2">会場</div>' +
          '<div class="nvs-row">' +
            '<select class="nvs-input" data-action="set-venue">' + venueOptions + '</select>' +
          '</div>' +

          '<div class="nvs-h2">等級・品目・実効確率</div>' +
          '<div data-role="ranks"></div>' +

          '<div class="nvs-h2">動作設定</div>' +
          '<div class="nvs-row nvs-toggle-row">' +
            '<label class="nvs-label" style="min-width:auto;">音</label>' +
            '<input type="checkbox" data-action="set-sound" style="width:22px;height:22px;">' +
            '<button type="button" class="nvs-btn" data-action="test-sound">音をテスト</button>' +
            '<span class="nvs-muted" data-role="sound-state"></span>' +
          '</div>' +
          '<div class="nvs-row">' +
            '<span class="nvs-muted" style="line-height:1.7;">' +
              '鳴らないときは端末側です。①タブがミュートになっていないか ' +
              '②端末のメディア音量 ③音の出力先（外部モニタ等になっていないか）を確認してください。' +
            '</span>' +
          '</div>' +
          '<div class="nvs-row">' +
            '<span class="nvs-label">自動で次へ(秒)</span>' +
            '<input type="number" inputmode="numeric" min="0" class="nvs-input num" data-action="set-auto">' +
            '<span class="nvs-muted">0 = 手動で「次の人へ」</span>' +
          '</div>' +
          '<div class="nvs-row">' +
            '<span class="nvs-label">品目の選び方</span>' +
            '<select class="nvs-input" data-action="set-itempick">' +
              '<option value="stock-weighted">在庫数に比例</option>' +
              '<option value="even">在庫がある中から均等</option>' +
            '</select>' +
          '</div>' +
          '<div class="nvs-row">' +
            '<span class="nvs-label">PIN 変更</span>' +
            '<input type="text" inputmode="numeric" class="nvs-input num" id="nvs-pin-new" placeholder="新しいPIN">' +
            '<button type="button" class="nvs-btn secondary" data-action="set-pin">変更</button>' +
          '</div>' +

          '<div class="nvs-h2">在庫・履歴・バックアップ</div>' +
          '<div class="nvs-row">' +
            '<button type="button" class="nvs-btn danger" data-action="reset-stock">在庫を初期値に戻す</button>' +
          '</div>' +
          '<div class="nvs-row">' +
            '<button type="button" class="nvs-btn secondary" data-action="export-csv-venue">履歴CSV（今の会場）</button>' +
            '<button type="button" class="nvs-btn secondary" data-action="export-csv-all">履歴CSV（全会場）</button>' +
          '</div>' +
          '<div class="nvs-row">' +
            '<button type="button" class="nvs-btn danger" data-action="clear-history">履歴を消す</button>' +
          '</div>' +
          '<div class="nvs-row">' +
            '<button type="button" class="nvs-btn secondary" data-action="export-backup">バックアップを書き出す</button>' +
            '<label class="nvs-btn secondary" style="display:inline-flex;align-items:center;cursor:pointer;">' +
              '読み込む<input type="file" accept=".json" data-action="import-backup-file" style="display:none;">' +
            '</label>' +
          '</div>' +
        '</div>' +
      '</div>';

    r.innerHTML = html;

    r.querySelector('[data-action="set-venue"]').value = state.venue;
    var soundBox = r.querySelector('[data-action="set-sound"]');
    soundBox.checked = !!(state.settings && state.settings.soundOn);
    r.querySelector('[data-action="set-auto"]').value = toNum(state.settings && state.settings.autoAdvanceSec, 0);
    r.querySelector('[data-action="set-itempick"]').value = (state.settings && state.settings.itemPick === "even") ? "even" : "stock-weighted";

    refreshBoard();
    showSoundState();

    var ranksWrap = r.querySelector('[data-role="ranks"]');
    var ranks = state.ranks || [];
    for (var i = 0; i < ranks.length; i++) {
      ranksWrap.appendChild(renderRankCard(ranks[i], i));
    }

    wireEvents(r);
    refreshDerived();
  }

  function showMsg(text) {
    var el = document.getElementById("nvs-msg");
    if (el) el.textContent = text || "";
  }

  // ---- イベント配線（委譲。要素を作り直しても都度貼り直さずに済むよう root 単位で1回だけ） -------

  function wireEvents(r) {
    r.addEventListener("click", onRootClick);
    r.addEventListener("input", onRootInput);
    r.addEventListener("change", onRootChange);
  }

  function onRootClick(e) {
    var t = e.target;
    var action = t.getAttribute && t.getAttribute("data-action");
    if (!action) return;

    if (action === "close") {
      closeInternal();
      return;
    }
    if (action === "item-remove") {
      var rankId = t.getAttribute("data-rank");
      var itemId = t.getAttribute("data-item");
      var rank = findRank(rankId);
      if (rank) {
        rank.items = (rank.items || []).filter(function (it) { return it.id !== itemId; });
        var wrap = getRoot().querySelector('[data-items-for="' + rankId + '"]');
        if (wrap) renderItemRows(wrap, rank);
        refreshDerived();
        notify();
      }
      return;
    }
    if (action === "reset-stock") {
      showConfirm("在庫を初期値に戻しますか？\n現在の在庫数は失われます。", "戻す", function () {
        var ranks = state.ranks || [];
        for (var i = 0; i < ranks.length; i++) {
          var items = ranks[i].items || [];
          for (var j = 0; j < items.length; j++) {
            items[j].stock = toNum(items[j].initial, 0);
          }
        }
        renderSettingsBody();
        notify();
        showMsg("在庫を初期値に戻しました");
      });
      return;
    }
    if (action === "export-csv-venue") {
      window.NV.storage.exportCSV(state, state.venue);
      showMsg("「" + state.venue + "」の履歴CSVを書き出しました");
      return;
    }
    if (action === "export-csv-all") {
      window.NV.storage.exportCSV(state, null);
      showMsg("全会場の履歴CSVを書き出しました");
      return;
    }
    if (action === "clear-history") {
      var count = (state.history || []).length;
      showConfirm("履歴を消す前に CSV は書き出しましたか？\n（対象 " + count + " 件。消すと復元できません）", "書き出し済み・続ける", function () {
        showConfirm("本当に履歴を全て削除しますか？", "削除する", function () {
          state.history = [];
          notify();
          showMsg("履歴を削除しました");
        });
      });
      return;
    }
    if (action === "export-backup") {
      window.NV.storage.exportJSON(state);
      showMsg("バックアップを書き出しました");
      return;
    }
    if (action === "set-pin") {
      var input = document.getElementById("nvs-pin-new");
      var val = input ? input.value.trim() : "";
      if (val.length === 0) {
        showMsg("新しい PIN を入力してください");
        return;
      }
      state.settings.pin = val;
      input.value = "";
      notify();
      showMsg("PIN を変更しました");
      return;
    }
  }

  function onRootInput(e) {
    var t = e.target;
    var action = t.getAttribute && t.getAttribute("data-action");
    if (!action) return;

    if (action === "rank-label") {
      var rank = findRank(t.getAttribute("data-rank"));
      if (rank) { rank.label = t.value; notify(); }
      return;
    }
    if (action === "rank-weight") {
      var rank2 = findRank(t.getAttribute("data-rank"));
      if (rank2) { rank2.weight = Math.max(0, toNum(t.value, 0)); refreshDerived(); notify(); }
      return;
    }
    if (action === "item-name") {
      var item = findItem(t.getAttribute("data-rank"), t.getAttribute("data-item"));
      if (item) { item.name = t.value; notify(); }
      return;
    }
    if (action === "item-stock") {
      var item2 = findItem(t.getAttribute("data-rank"), t.getAttribute("data-item"));
      if (item2) {
        item2.stock = Math.max(0, Math.floor(toNum(t.value, 0)));
        // ここに手入力する数は「この会場に持ってきた数」なので initial も合わせる。
        // 合わせないと「在庫を初期値に戻す」が前の会場の数に戻してしまう。
        item2.initial = item2.stock;
        refreshDerived();
        notify();
      }
      return;
    }
    if (action === "set-auto") {
      state.settings.autoAdvanceSec = Math.max(0, Math.floor(toNum(t.value, 0)));
      notify();
      return;
    }
  }

  function onRootChange(e) {
    var t = e.target;
    var action = t.getAttribute && t.getAttribute("data-action");
    if (!action) return;

    if (action === "set-venue") {
      state.venue = t.value;
      notify();
      return;
    }
    if (action === "set-sound") {
      state.settings.soundOn = !!t.checked;
      try { NV.sound.setEnabled(state.settings.soundOn); } catch (e) {}
      notify();
      return;
    }
    if (action === "test-sound") {
      // 抽選を回さずに音だけ確かめられるようにする。当日の設営で使う。
      try {
        NV.sound.init();
        NV.sound.resume();
        NV.sound.setEnabled(true);
        state.settings.soundOn = true;
        var box = document.querySelector('[data-action="set-sound"]');
        if (box) box.checked = true;
        NV.sound.fanfare(0);
        setTimeout(function () { try { NV.sound.applause(1.2); } catch (e) {} }, 700);
      } catch (e) {}
      showSoundState();
      setTimeout(showSoundState, 600);
      notify();
      return;
    }
    if (action === "set-itempick") {
      state.settings.itemPick = (t.value === "even") ? "even" : "stock-weighted";
      notify();
      return;
    }
    if (action === "rank-color") {
      var rank = findRank(t.getAttribute("data-rank"));
      if (rank) {
        rank.color = t.value;
        rank.colorDark = darken(t.value, 0.3);
        notify();
      }
      return;
    }
    if (action === "import-backup-file") {
      var file = t.files && t.files[0];
      if (!file) return;
      window.NV.storage.importJSON(file).then(function (loaded) {
        state = loaded;
        renderSettingsBody();
        notify();
        showMsg("バックアップを読み込みました");
      }).catch(function (err) {
        showMsg("読み込み失敗: " + (err && err.message ? err.message : String(err)));
      });
      return;
    }
  }

  function findRank(rankId) {
    var ranks = state.ranks || [];
    for (var i = 0; i < ranks.length; i++) {
      if (ranks[i].id === rankId) return ranks[i];
    }
    return null;
  }

  function findItem(rankId, itemId) {
    var rank = findRank(rankId);
    if (!rank) return null;
    var items = rank.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === itemId) return items[i];
    }
    return null;
  }

  // ---- 公開 API ---------------------------------------------------

  function requestOpen(s, onSaved) {
    ensureStyle();
    state = s;
    onSavedCb = onSaved;
    pinInput = "";
    wrongCount = 0;
    renderPinDialog();
  }

  function closeInternal() {
    var r = getRoot();
    if (r) r.innerHTML = "";
    document.body.classList.remove("settings-open");
    pinInput = "";
    wrongCount = 0;
  }

  window.NV.settings = {
    requestOpen: requestOpen,
    close: closeInternal
  };
})();
