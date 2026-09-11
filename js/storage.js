// js/storage.js
// 保存・読込・エクスポート/インポートを担当するモジュール。
// 展示会当日に壊れた localStorage で白画面になるのが最悪のシナリオなので、
// load() はどんな入力に対しても必ず使える state を返しきる（形の検証＝サニタイズ）。
// ------------------------------------------------------------
window.NV = window.NV || {};

(function () {
  "use strict";

  var KEY = "novelty-lottery-v1";

  // 「品目の選び方」を一度だけ立て直した印。
  // 選択機能を入れた版で、旧値を誤って "auto"（＝選ばせない）へ寄せてしまった。
  // その版で1回でも抽選した端末には "auto" が実際に保存されており、
  // 寄せ先を直しただけでは戻らない。この印が無い保存データは既定へ戻す。
  // 【上げるのは、同じ種類の «保存値そのものが誤っている» 事故のときだけ】
  var PICK_FIX = 2;

  function pad(n, len) {
    var s = String(Math.max(0, Math.floor(n)));
    while (s.length < len) s = "0" + s;
    return s;
  }

  function toNum(v) {
    var n = Number(v);
    return isFinite(n) ? n : NaN;
  }

  function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
  }

  // ---- サニタイズ（形の検証） ----------------------------------

  function sanitizeItem(raw, idx, fallbackPrefix) {
    var def = { id: fallbackPrefix + "-" + (idx + 1), name: "品目" + (idx + 1), stock: 0, initial: 0 };
    if (!isPlainObject(raw)) return def;

    var id = (typeof raw.id === "string" && raw.id) ? raw.id : def.id;
    var name = (typeof raw.name === "string" && raw.name) ? raw.name : def.name;

    var stockNum = toNum(raw.stock);
    var stock = isFinite(stockNum) ? Math.max(0, Math.floor(stockNum)) : 0;

    // initial が無い/不正なら stock の値で補う（SPEC 3節の指示どおり）。
    var initialNum = toNum(raw.initial);
    var initial = isFinite(initialNum) ? Math.max(0, Math.floor(initialNum)) : stock;

    // 景品のイラスト。会場データJSONに data URI で入ってくる。
    // 公開リポジトリに景品を出さないため、画像はアプリ本体ではなく会場データ側に持たせている。
    var out = { id: id, name: name, stock: stock, initial: initial };
    if (typeof raw.image === "string" && raw.image) { out.image = raw.image; }
    // 品目の一言（特長）。画像と同じく会場データJSON にだけ入っている。
    // ここで落とすと結果画面から一言が消える
    if (typeof raw.note === "string" && raw.note) { out.note = raw.note; }
    return out;
  }

  function sanitizeRank(raw, idx, defRank) {
    var colors = (window.NV.defaults && window.NV.defaults.RANK_COLORS) || [];
    var colorFallback = colors[idx % (colors.length || 1)] || { color: "#FFFFFF", colorDark: "#CCCCCC" };

    if (!isPlainObject(raw)) return defRank;

    var id = (typeof raw.id === "string" && raw.id) ? raw.id : (defRank ? defRank.id : "r" + (idx + 1));
    var label = (typeof raw.label === "string" && raw.label) ? raw.label : (defRank ? defRank.label : "等級" + (idx + 1));
    var color = (typeof raw.color === "string" && raw.color) ? raw.color : colorFallback.color;
    var colorDark = (typeof raw.colorDark === "string" && raw.colorDark) ? raw.colorDark : colorFallback.colorDark;

    var weightNum = toNum(raw.weight);
    var weight = isFinite(weightNum) ? Math.max(0, weightNum) : 0;

    var items = [];
    if (Array.isArray(raw.items)) {
      for (var i = 0; i < raw.items.length; i++) {
        items.push(sanitizeItem(raw.items[i], i, id));
      }
    }

    var rank = { id: id, label: label, color: color, colorDark: colorDark,
                 weight: weight, items: items };
    // 特賞まわりの目印。ここで落とすと «全等級から選ぶ» も «盤に出す» も効かなくなる
    if (raw.jackpot === true) { rank.jackpot = true; }
    if (raw.noStock === true) { rank.noStock = true; }
    if (raw.top === true) { rank.top = true; }
    return rank;
  }

  function sanitizeHistoryEntry(raw) {
    if (!isPlainObject(raw)) return null;
    var ts = toNum(raw.ts);
    if (!isFinite(ts)) return null;
    if (typeof raw.rankId !== "string" || typeof raw.itemId !== "string") return null;
    return {
      ts: ts,
      venue: (typeof raw.venue === "string") ? raw.venue : "",
      rankId: raw.rankId,
      rankLabel: (typeof raw.rankLabel === "string") ? raw.rankLabel : "",
      itemId: raw.itemId,
      itemName: (typeof raw.itemName === "string") ? raw.itemName : "",
      // 備考。特賞のときだけ「特賞 2/3」のように入る（CSV の5列目）
      note: (typeof raw.note === "string") ? raw.note : ""
    };
  }

  function sanitizeSettings(raw, defSettings) {
    var out = {};
    var s = isPlainObject(raw) ? raw : {};

    out.pin = (typeof s.pin === "string" && s.pin) ? s.pin : defSettings.pin;
    out.soundOn = (typeof s.soundOn === "boolean") ? s.soundOn : defSettings.soundOn;

    var autoNum = toNum(s.autoAdvanceSec);
    out.autoAdvanceSec = isFinite(autoNum) ? Math.max(0, Math.floor(autoNum)) : defSettings.autoAdvanceSec;

    // 旧値（even / stock-weighted）は «来場者が選ぶ» に寄せる。
    // 選ぶのが来場者になったので、均等か在庫比例かの区別は意味を失った。
    // 【"auto" に寄せないこと】旧値はスタッフが «選ばせない» と決めた印ではなく、
    // 選択機能そのものが無かった時代の既定値でしかない。auto に寄せると、
    // 以前このアプリを開いた端末では保存データを読み直すたびに選択画面が
    // 丸ごと素通りされる（盤に特賞は出るので «更新済みなのに選べない» に見える。実際に踏んだ）。
    //
    // さらに、"auto" を «スタッフがそう決めた» と読めるのは、設定画面に
    // この項目が現れてからの話。それ以前の保存データに入っている "auto" は
    // 上の誤りが書き残したものでしかないので、印が無ければ一度だけ既定へ戻す
    if (toNum(s.pickFix) !== PICK_FIX) {
      out.itemPick = defSettings.itemPick;
    } else if (s.itemPick === "auto") {
      out.itemPick = "auto";
    } else if (s.itemPick === "choose" || s.itemPick === "even" || s.itemPick === "stock-weighted") {
      out.itemPick = "choose";
    } else {
      out.itemPick = defSettings.itemPick;
    }
    out.pickFix = PICK_FIX;

    // 選択の制限時間[秒]。0 でオフ
    var chooseNum = toNum(s.chooseSec);
    out.chooseSec = isFinite(chooseNum) ? Math.max(0, Math.floor(chooseNum))
                                        : (defSettings.chooseSec || 0);

    // 会場モード（明るいホール向けに全体を一段明るく）。
    // ここに追記し忘れると、設定してもリロードで戻る
    out.brightMode = (typeof s.brightMode === "boolean") ? s.brightMode : !!defSettings.brightMode;

    // アプリ内の音量（0〜1）。端末の音量とは別に、会場のざわつきへ合わせるためのもの
    var volNum = toNum(s.volume);
    out.volume = isFinite(volNum) ? Math.max(0, Math.min(1, volNum))
                                  : (defSettings.volume == null ? 1 : defSettings.volume);

    return out;
  }

  // 壊れた/古い/不完全な state を、必ず使える形へ補正する。
  function sanitizeState(raw) {
    var def = window.NV.defaults.makeState();
    if (!isPlainObject(raw)) return def;

    var venue = (typeof raw.venue === "string" && window.NV.defaults.VENUES.indexOf(raw.venue) !== -1)
      ? raw.venue
      : def.venue;

    var ranks;
    if (Array.isArray(raw.ranks) && raw.ranks.length > 0) {
      ranks = [];
      for (var i = 0; i < raw.ranks.length; i++) {
        ranks.push(sanitizeRank(raw.ranks[i], i, def.ranks[i]));
      }
    } else {
      ranks = def.ranks;
    }

    var history = [];
    if (Array.isArray(raw.history)) {
      for (var j = 0; j < raw.history.length; j++) {
        var h = sanitizeHistoryEntry(raw.history[j]);
        if (h) history.push(h);
      }
    }

    // 特賞を持たない古い state / 会場データを読み込んだときは、既定の特賞を足す。
    // 足さないと «金の一本» が盤から消えたまま当日を迎えることになる
    var hasJackpot = false;
    for (var k = 0; k < ranks.length; k++) {
      if (ranks[k] && ranks[k].jackpot) { hasJackpot = true; break; }
    }
    if (!hasJackpot) {
      var defJ = null;
      for (var m = 0; m < def.ranks.length; m++) {
        if (def.ranks[m].jackpot) { defJ = def.ranks[m]; break; }
      }
      if (defJ) { ranks.unshift(defJ); }
    }

    var settings = sanitizeSettings(raw.settings, def.settings);

    return {
      version: 1,
      venue: venue,
      ranks: ranks,
      history: history,
      settings: settings
    };
  }

  // ---- 保存 / 読込 ----------------------------------------------

  function load() {
    try {
      var raw = null;
      try {
        raw = window.localStorage.getItem(KEY);
      } catch (e) {
        raw = null;
      }
      if (!raw) return window.NV.defaults.makeState();

      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e2) {
        return window.NV.defaults.makeState();
      }
      var st = sanitizeState(parsed);

      // 立て直しが起きたなら、その場で書き戻す。
      // 書き戻さないと印が残らず、スタッフが «自動で選ぶ» にしても
      // 次に開いたときにまた戻されてしまう
      try {
        var mark = (parsed && parsed.settings) ? Number(parsed.settings.pickFix) : NaN;
        if (mark !== PICK_FIX) { save(st); }
      } catch (e4) {}
      return st;
    } catch (e3) {
      // 何が起きても白画面にはしない。
      return window.NV.defaults.makeState();
    }
  }

  function save(state) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      // QuotaExceeded 等。展示会中は保存が失敗しても抽選自体は続行させるため throw しない。
      console.warn("[NV.storage] save failed:", e);
    }
  }

  // ---- ダウンロード共通処理 ---------------------------------------

  function triggerDownload(blob, filename) {
    try {
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // revoke はクリック直後だとダウンロードが始まる前に URL が失効する環境があるため少し待つ。
      setTimeout(function () {
        try { URL.revokeObjectURL(url); } catch (e) { /* 無視 */ }
      }, 1000);
    } catch (e) {
      console.warn("[NV.storage] download failed:", e);
    }
  }

  function fileStamp(d) {
    return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) +
      "-" + pad(d.getHours(), 2) + pad(d.getMinutes(), 2);
  }

  // ---- JSON バックアップ -------------------------------------------

  function exportJSON(state) {
    try {
      var json = JSON.stringify(state, null, 2);
      var blob = new Blob([json], { type: "application/json" });
      var name = "ノベルティ抽選_バックアップ_" + fileStamp(new Date()) + ".json";
      triggerDownload(blob, name);
    } catch (e) {
      console.warn("[NV.storage] exportJSON failed:", e);
    }
  }

  function importJSON(file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new Error("ファイルが指定されていません"));
        return;
      }
      try {
        var reader = new FileReader();
        reader.onload = function () {
          var parsed;
          try {
            parsed = JSON.parse(String(reader.result));
          } catch (e) {
            reject(new Error("JSON として読み込めませんでした"));
            return;
          }
          // 最低限これが無いと「別ファイルの誤読込」を検知できないため、ranks 配列の存在だけは厳密にチェックする。
          if (!isPlainObject(parsed) || !Array.isArray(parsed.ranks)) {
            reject(new Error("バックアップファイルの形式が不正です"));
            return;
          }
          resolve(sanitizeState(parsed));
        };
        reader.onerror = function () {
          reject(reader.error || new Error("ファイルの読み込みに失敗しました"));
        };
        reader.readAsText(file, "utf-8");
      } catch (e2) {
        reject(e2);
      }
    });
  }

  // ---- CSV 書き出し ------------------------------------------------

  function csvField(v) {
    var s = (v === null || v === undefined) ? "" : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function formatDateTime(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "/" + pad(d.getMonth() + 1, 2) + "/" + pad(d.getDate(), 2) +
      " " + pad(d.getHours(), 2) + ":" + pad(d.getMinutes(), 2) + ":" + pad(d.getSeconds(), 2);
  }

  function exportCSV(state, venue) {
    try {
      var history = (state && Array.isArray(state.history)) ? state.history : [];
      // 5列目の「備考」は特賞のときだけ埋まる（「特賞 2/3」など）。
      // 既存の4列は動かさないので、Excel 側の集計はそのまま使える
      var rows = [["日時", "会場", "等級", "品目", "備考"]];

      for (var i = 0; i < history.length; i++) {
        var h = history[i];
        if (!h) continue;
        if (venue && h.venue !== venue) continue;
        rows.push([formatDateTime(h.ts), h.venue || "", h.rankLabel || "",
                   h.itemName || "", h.note || ""]);
      }

      var lines = [];
      for (var j = 0; j < rows.length; j++) {
        lines.push(rows[j].map(csvField).join(","));
      }
      // Excel での文字化け防止に UTF-8 BOM を先頭に付ける。
      var csv = "﻿" + lines.join("\r\n");

      var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      var venueLabel = venue ? venue : "全会場";
      var name = "ノベルティ抽選_履歴_" + venueLabel + "_" + fileStamp(new Date()) + ".csv";
      triggerDownload(blob, name);
    } catch (e) {
      console.warn("[NV.storage] exportCSV failed:", e);
    }
  }

  window.NV.storage = {
    load: load,
    save: save,
    exportJSON: exportJSON,
    importJSON: importJSON,
    exportCSV: exportCSV
  };
})();
