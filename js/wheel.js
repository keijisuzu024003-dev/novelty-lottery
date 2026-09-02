// js/wheel.js
// ルーレット円盤の描画と回転演出。SPEC.md の NV.Wheel 契約のみを外部に見せる。
// ------------------------------------------------------------
window.NV = window.NV || {};

(function () {
  "use strict";

  var TAU = Math.PI * 2;
  var PEG_COUNT = 32;           // リング上の電球＝カチカチ音のもと。扇の枚数とは切り離す
  var MIN_LABEL_DEG = 12;       // これより細い扇には等級名を出さない（潰れて読めないため）
  var IDLE_SPEED = 0.06;        // 待機中の自転速度 [rad/s]
  var GOLD = "#FFD97A";
  // 見出し用の明朝（app.css で @font-face 済み）。canvas は CSS を継承しないので
  // ここでも同じスタックを書く。読み込み完了後に再描画する必要がある（app.js を参照）
  var DISPLAY_FONT = '"Shippori Mincho B1","Yu Mincho","YuMincho","Hiragino Mincho ProN",serif';

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  // ---- 色ユーティリティ（在庫0の等級を彩度15%まで落とすためだけに使う。外部ライブラリ禁止のため自前実装） ----

  function hexToRgb(hex) {
    var h = String(hex || "").replace("#", "");
    if (h.length === 3) {
      h = h.split("").map(function (c) { return c + c; }).join("");
    }
    var num = parseInt(h, 16);
    if (isNaN(num)) return { r: 136, g: 136, b: 136 }; // 壊れた色指定はグレーで継続
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function rgbToHex(r, g, b) {
    function h2(v) {
      var s = clamp(Math.round(v), 0, 255).toString(16);
      return s.length === 1 ? "0" + s : s;
    }
    return "#" + h2(r) + h2(g) + h2(b);
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var h, s, l = (max + min) / 2;
    if (max === min) {
      h = s = 0;
    } else {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
  }

  function hueToRgb(p, q, t) {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function hslToRgb(h, s, l) {
    h = (((h % 360) + 360) % 360) / 360; s /= 100; l /= 100;
    var r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      var p = 2 * l - q;
      r = hueToRgb(p, q, h + 1 / 3);
      g = hueToRgb(p, q, h);
      b = hueToRgb(p, q, h - 1 / 3);
    }
    return { r: r * 255, g: g * 255, b: b * 255 };
  }

  // 在庫0の等級を「もう無い」と一目で分かる彩度まで落とす
  function desaturate(hex, satPercent, lightFactor) {
    try {
      var rgb = hexToRgb(hex);
      var hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
      hsl.s = satPercent;
      hsl.l = clamp(hsl.l * (lightFactor == null ? 0.85 : lightFactor), 0, 100);
      var out = hslToRgb(hsl.h, hsl.s, hsl.l);
      return rgbToHex(out.r, out.g, out.b);
    } catch (e) {
      return hex; // 変換に失敗しても止めない
    }
  }

  // 角度を [-PI, PI) に正規化（ラベルの上下反転判定に使う）
  function normalizeSigned(a) {
    var v = a % TAU;
    if (v > Math.PI) v -= TAU;
    if (v < -Math.PI) v += TAU;
    return v;
  }

  // ---- セグメント生成 ----
  // 等級ごとに扇を1枚だけ置き、幅（面積）＝出現確率にする。
  // 以前は1等級を複数枚に割って交互配置していたが、扇ごとに文字の向きが
  // 上下バラバラに見えるという指摘があったため1枚にまとめた。文字は回転させず
  // 常に水平に描くので、向きは常に揃う（_drawLabel を参照）。
  //
  // 在庫0の等級は円盤から外して残りで正規化する。外さないと
  // 「絶対に止まらない大きな扇」が残り、見ている人に不自然に映るため。
  // 例外を投げない：ranks が空 / weight が全部0以下でも必ず何か返す。
  function buildSegments(ranks) {
    var list = [];
    try {
      list = (ranks || []).filter(function (r) { return r && typeof r === "object"; });
    } catch (e) {
      list = [];
    }
    if (list.length === 0) {
      return [{ rankId: null, rank: null, soldOut: false, start: 0, end: TAU }];
    }

    function stockOf(r) {
      var n = 0;
      try {
        var items = r.items || [];
        for (var i = 0; i < items.length; i++) {
          var v = Number(items[i] && items[i].stock);
          if (isFinite(v) && v > 0) n += v;
        }
      } catch (e) { /* 壊れたデータでも落とさない */ }
      return n;
    }

    // 在庫のある等級だけを円盤に載せる。全滅していたら見た目維持のため全部載せる
    var live = list.filter(function (r) { return stockOf(r) > 0; });
    var soldOutAll = live.length === 0;
    if (soldOutAll) live = list;

    var weights = live.map(function (r) {
      var w = Number(r.weight);
      return (isFinite(w) && w > 0) ? w : 0;
    });
    var totalW = weights.reduce(function (x, y) { return x + y; }, 0);
    if (totalW <= 0) {
      weights = live.map(function () { return 1; });
      totalW = live.length;
    }

    var segments = [];
    var cursor = 0;
    for (var k = 0; k < live.length; k++) {
      var rad = (weights[k] / totalW) * TAU;
      // 端数の積み残しで最後に隙間が出ないよう、最後の1枚は残り全部にする
      if (k === live.length - 1) rad = TAU - cursor;
      segments.push({
        rankId: live[k].id,
        rank: live[k],
        soldOut: soldOutAll,
        start: cursor,
        end: cursor + rad
      });
      cursor += rad;
    }
    return segments;
  }

  // ---- Wheel 本体 ----

  function Wheel(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.cssW = 0;
    this.cssH = 0;
    this.segments = buildSegments([]);
    this.rotation = 0;        // ラジアン。累積で持ち、mod計算は都度行う
    this.isSpinning = false;
    this._idle = false;
    this._raf = null;
    this._lastTs = null;
    this._spin = null;
    this._blinkOn = false;
    this._blinkAcc = 0;
    this._reducedMotion = false;
    try {
      this._reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) {
      this._reducedMotion = false;
    }
  }

  Wheel.prototype.setRanks = function (ranks) {
    try {
      this.segments = buildSegments(ranks);
    } catch (e) {
      console.warn("NV.Wheel.setRanks: セグメント生成に失敗。空盤にフォールバック", e);
      this.segments = buildSegments([]);
    }
    try { this.render(); } catch (e) { console.warn("NV.Wheel.render 失敗", e); }
  };

  Wheel.prototype.resize = function () {
    try {
      var canvas = this.canvas;
      var rect = canvas.getBoundingClientRect();
      var w = rect.width || canvas.clientWidth || 300;
      var h = rect.height || canvas.clientHeight || 300;
      // DPR3のタブレットで描画が重くならないよう上限2で切る
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      this.cssW = w;
      this.cssH = h;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.render();
    } catch (e) {
      console.warn("NV.Wheel.resize 失敗", e);
    }
  };

  Wheel.prototype._pointerAngle = function () {
    return ((-this.rotation % TAU) + TAU) % TAU;
  };

  // rankId のセグメントの中から1つ選び、そこに止まるための回転計画を作る（純粋計算・状態は変えない）
  Wheel.prototype._planSpin = function (rankId) {
    if (!this.segments || this.segments.length === 0) return null;
    var matches = this.segments.filter(function (s) { return s.rankId === rankId; });
    if (matches.length === 0) {
      matches = [this.segments[Math.floor(Math.random() * this.segments.length)]];
    }
    var seg = matches[Math.floor(Math.random() * matches.length)];
    var width = seg.end - seg.start;
    var center = (seg.start + seg.end) / 2;
    var target = center + (Math.random() * 2 - 1) * 0.35 * width;

    var curMod = ((this.rotation % TAU) + TAU) % TAU;
    var targetMod = (((TAU - target) % TAU) + TAU) % TAU;
    var deltaForward = ((targetMod - curMod) % TAU + TAU) % TAU;
    var extraTurns = 6 + Math.floor(Math.random() * 3); // 6〜8周
    var totalDelta = extraTurns * TAU + deltaForward;

    return {
      segment: seg,
      startRotation: this.rotation,
      endRotation: this.rotation + totalDelta
    };
  };

  // prev→curr の回転区間でカチカチを何回鳴らすか。
  // 扇の境界で数えると扇が3枚しかないため1周3回しか鳴らず、回転が安っぽく聞こえる。
  // リング上の電球（等間隔）を通過した回数で数えることで、扇の枚数と音の密度を切り離す。
  Wheel.prototype._countCrossings = function (prevRotation, currRotation) {
    var step = TAU / PEG_COUNT;
    return Math.floor(currRotation / step) - Math.floor(prevRotation / step);
  };

  Wheel.prototype.spinTo = function (rankId, opts) {
    opts = opts || {};
    var duration = opts.duration || 4500;
    var onTick = typeof opts.onTick === "function" ? opts.onTick : function () {};
    var self = this;

    return new Promise(function (resolve) {
      try {
        var plan = self._planSpin(rankId);
        if (!plan) { resolve(); return; } // 空盤：演出せず終了

        self._idle = false; // spinTo中はidleを無効化
        self.isSpinning = true;
        self._spin = {
          startTs: null,
          duration: duration,
          startRotation: plan.startRotation,
          endRotation: plan.endRotation,
          onTick: onTick,
          resolve: resolve
        };
        self._ensureLoop();
      } catch (e) {
        console.warn("NV.Wheel.spinTo 失敗", e);
        self.isSpinning = false;
        self._spin = null;
        resolve();
      }
    });
  };

  Wheel.prototype.idle = function (on) {
    if (this.isSpinning && on) return; // 回転中は受け付けない。終了後の再開は呼び出し側の責務
    this._idle = !!on;
    if (this._idle) this._ensureLoop();
  };

  Wheel.prototype._ensureLoop = function () {
    if (this._raf) return;
    var self = this;
    this._lastTs = null;
    this._raf = requestAnimationFrame(function (ts) { self._loop(ts); });
  };

  Wheel.prototype._loop = function (ts) {
    var self = this;
    if (this._lastTs == null) this._lastTs = ts;
    var dt = Math.min(0.1, (ts - this._lastTs) / 1000);
    this._lastTs = ts;

    if (!this._reducedMotion) {
      this._blinkAcc += dt;
      if (this._blinkAcc > 0.18) { this._blinkAcc = 0; this._blinkOn = !this._blinkOn; }
    }

    if (this.isSpinning) {
      this._stepSpin(ts);
    } else if (this._idle) {
      this.rotation += IDLE_SPEED * dt;
      try { this.render(); } catch (e) { /* 描画失敗は無視して継続 */ }
    }

    // 静止中はrAFを止めてCPU/バッテリーを食わないようにする
    if (this.isSpinning || this._idle) {
      this._raf = requestAnimationFrame(function (t) { self._loop(t); });
    } else {
      this._raf = null;
      this._lastTs = null;
    }
  };

  // 回転を即座に終端まで飛ばして Promise を解決する。
  // requestAnimationFrame は端末やブラウザの都合（バックグラウンド化・画面消灯・
  // レンダラの停止）で止まることがあり、そうなると spinTo の Promise が永久に解決されず
  // 「回転中」のままボタンが無効になって復帰できない。app.js の見張りタイマーから呼ぶ非常口。
  Wheel.prototype.finishNow = function () {
    var sp = this._spin;
    if (!sp) { this.isSpinning = false; return false; }
    this.rotation = sp.endRotation;
    this.isSpinning = false;
    this._spin = null;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this._lastTs = null;
    try { this.render(); } catch (e) {}
    try { sp.resolve(); } catch (e) {}
    return true;
  };

  Wheel.prototype._stepSpin = function (ts) {
    var sp = this._spin;
    if (!sp) { this.isSpinning = false; return; }
    if (sp.startTs == null) sp.startTs = ts;
    var t = (ts - sp.startTs) / sp.duration;
    var done = t >= 1;
    if (done) t = 1;
    var eased = 1 - Math.pow(1 - t, 3); // easeOutCubic：単調増加でオーバーシュートしない

    var prevRotation = this.rotation;
    this.rotation = sp.startRotation + (sp.endRotation - sp.startRotation) * eased;

    var speed01 = Math.pow(1 - t, 2); // easeOutCubicの速度成分。開始1→終了0
    var crossings = this._countCrossings(prevRotation, this.rotation);
    if (crossings > 0) {
      var calls = Math.min(crossings, 5); // 高速時に音が割れないよう1フレーム最大5回
      for (var i = 0; i < calls; i++) {
        try { sp.onTick(speed01); } catch (e) { /* onTick側の例外で抽選演出を止めない */ }
      }
    }

    try { this.render(); } catch (e) { /* 描画失敗は無視して継続 */ }

    if (done) {
      this.rotation = sp.endRotation; // 誤差を消して確実にターゲットへ止める
      this.isSpinning = false;
      this._spin = null;
      try { this.render(); } catch (e) {}
      sp.resolve();
    }
  };

  // ---- 描画 ----

  Wheel.prototype.render = function () {
    var ctx = this.ctx;
    var w = this.cssW, h = this.cssH;
    if (!w || !h) return;
    ctx.clearRect(0, 0, w, h);
    var cx = w / 2, cy = h / 2;
    var radius = Math.min(w, h) / 2 * 0.92; // 外周リング分の余白
    var segments = this.segments;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(this.rotation);

    for (var i = 0; i < segments.length; i++) {
      this._drawSegment(ctx, segments[i], radius);
    }

    // 扇の区切り線（金）
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = Math.max(1, radius * 0.006);
    for (var j = 0; j < segments.length; j++) {
      var s = segments[j];
      var a0 = s.start - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a0) * radius, Math.sin(a0) * radius);
      ctx.stroke();
    }

    this._drawRing(ctx, radius);
    this._drawBulbs(ctx, radius);

    ctx.restore();

    // 等級名は円盤と一緒に回さない。回すと扇ごとに上下がバラバラに見えるため、
    // 位置だけ扇に追従させて文字は常に水平に描く。
    ctx.save();
    ctx.translate(cx, cy);
    for (var l = 0; l < segments.length; l++) {
      this._drawLabel(ctx, segments[l], radius, this.rotation);
    }
    ctx.restore();

    // ハブは回転させない（中心の「抽選」文字を常に読めるように）
    this._drawHub(ctx, cx, cy, radius);
  };

  Wheel.prototype._drawSegment = function (ctx, seg, radius) {
    var a0 = seg.start - Math.PI / 2;
    var a1 = seg.end - Math.PI / 2;
    var color = "#8892B0", colorDark = "#5A6484"; // ranks未設定時の既定グレー
    if (seg.rank) {
      color = seg.rank.color || color;
      colorDark = seg.rank.colorDark || colorDark;
    }
    if (seg.soldOut) {
      color = desaturate(color, 15, 0.75);
      colorDark = desaturate(colorDark, 15, 0.65);
    }
    var grad = ctx.createRadialGradient(0, 0, radius * 0.15, 0, 0, radius);
    grad.addColorStop(0, color);
    grad.addColorStop(1, colorDark);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, a0, a1, false);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  };

  // 等級名。扇の重心あたりに、常に水平で描く。
  // ctx には translate(cx,cy) だけが掛かっている前提（回転は掛けない）。
  Wheel.prototype._drawLabel = function (ctx, seg, radius, rotation) {
    if (!seg.rank || !seg.rank.label) return;
    var widthRad = seg.end - seg.start;
    if ((widthRad / TAU) * 360 < MIN_LABEL_DEG) return;

    var label = String(seg.rank.label);
    var mid = (seg.start + seg.end) / 2 + rotation - Math.PI / 2;
    var labelR = radius * 0.63;

    // 扇の幅に収まる大きさに抑える。細い扇では小さく、広い扇では上限まで
    var arcSpace = widthRad * labelR * 0.82;
    var size = clamp(radius * 0.15, 13, 64);
    size = Math.min(size, arcSpace / Math.max(1, label.length) * 1.35);
    if (size < 13) return;

    ctx.save();
    ctx.translate(Math.cos(mid) * labelR, Math.sin(mid) * labelR);
    ctx.font = "700 " + size.toFixed(1) + "px " + DISPLAY_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // 明朝は横画が細いので、濃い縁取りを付けないと扇の上で溶ける
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(2, size * 0.13);
    ctx.strokeStyle = "rgba(20,18,10,0.42)";
    ctx.strokeText(label, 0, 0);
    ctx.fillStyle = seg.soldOut ? "rgba(255,255,255,0.5)" : "#FFFFFF";
    ctx.fillText(label, 0, 0);
    ctx.restore();
  };

  Wheel.prototype._drawRing = function (ctx, radius) {
    var ringW = radius * 0.05;
    ctx.beginPath();
    ctx.arc(0, 0, radius + ringW / 2, 0, TAU);
    ctx.lineWidth = ringW;
    ctx.strokeStyle = GOLD;
    ctx.stroke();
  };

  Wheel.prototype._drawBulbs = function (ctx, radius) {
    var count = 32;
    var bulbR = radius * 0.02;
    var ringCenterR = radius + radius * 0.05;
    // 回転中（spin/idle）だけ交互点滅。reduced-motionでは点滅を止める
    var blinkActive = !this._reducedMotion && (this.isSpinning || this._idle);
    for (var i = 0; i < count; i++) {
      var a = (i / count) * TAU;
      var evenSlot = (i % 2 === 0);
      var lit = blinkActive ? (evenSlot === this._blinkOn) : evenSlot;
      var x = Math.cos(a) * ringCenterR;
      var y = Math.sin(a) * ringCenterR;
      ctx.beginPath();
      ctx.arc(x, y, bulbR, 0, TAU);
      ctx.fillStyle = lit ? "#FFF6D8" : "#B8862E";
      ctx.fill();
    }
  };

  Wheel.prototype._drawHub = function (ctx, cx, cy, radius) {
    var hubR = radius * 0.17;
    ctx.save();
    ctx.translate(cx, cy);
    var grad = ctx.createRadialGradient(0, 0, hubR * 0.1, 0, 0, hubR);
    grad.addColorStop(0, "#2A1A6C");
    grad.addColorStop(1, "#0B1437");
    ctx.beginPath();
    ctx.arc(0, 0, hubR, 0, TAU);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.lineWidth = Math.max(1, hubR * 0.08);
    ctx.strokeStyle = GOLD;
    ctx.stroke();

    ctx.fillStyle = "#FFFFFF";
    ctx.font = "700 " + clamp(hubR * 0.42, 12, 28) + "px " + DISPLAY_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("抽選", 0, 0);
    ctx.restore();
  };

  window.NV.Wheel = Wheel;

  // 検証用の内部関数の限定公開（ブラウザ実行には影響しない。Node等でのテスト専用）
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { buildSegments: buildSegments, desaturate: desaturate };
  }
})();
