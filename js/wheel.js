// js/wheel.js
// ルーレット円盤の描画と回転演出。SPEC.md の NV.Wheel 契約のみを外部に見せる。
// ------------------------------------------------------------
window.NV = window.NV || {};

(function () {
  "use strict";

  var TAU = Math.PI * 2;
  var PEG_COUNT = 72;           // 縁の目盛り（5度ごと）＝カチカチ音のもと。扇の枚数とは切り離す
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

  // 扇の中心側を明るくして立体感を出すために使う
  function lighten(hex, amount) {
    var c = hexToRgb(hex);
    var hsl = rgbToHsl(c.r, c.g, c.b);
    var rgb = hslToRgb(hsl.h, Math.min(100, hsl.s + 4), Math.min(96, hsl.l + amount * 100));
    return rgbToHex(rgb.r, rgb.g, rgb.b);
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
    this._winSeg = null;   // 停止後に光らせる扇
    this._reducedMotion = false;
    try {
      this._reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) {
      this._reducedMotion = false;
    }
  }

  Wheel.prototype.setRanks = function (ranks) {
    this._winSeg = null; // 扇を作り直すので前回の当たりの参照は捨てる
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
    // suspense: 最後の失速を長く取り、止まる寸前に間を作る。1等のときだけ使う
    var suspense = !!opts.suspense;
    var onTick = typeof opts.onTick === "function" ? opts.onTick : function () {};
    var self = this;

    return new Promise(function (resolve) {
      try {
        var plan = self._planSpin(rankId);
        if (!plan) { resolve(); return; } // 空盤：演出せず終了

        self._idle = false; // spinTo中はidleを無効化
        self._winSeg = null; // 前回の当たりの光を消す
        self.isSpinning = true;
        self._spin = {
          startTs: null,
          duration: duration,
          suspense: suspense,
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

  // 停止後の「当たりの光」を animate するためにループを起こす
  Wheel.prototype.keepGlowing = function () {
    if (this._winSeg && !this._reducedMotion) this._ensureLoop();
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

    // 当たった扇の光を脈打たせている間も描き続ける必要がある
    var glowing = !!this._winSeg && !this.isSpinning && !this._reducedMotion;

    if (this.isSpinning) {
      this._stepSpin(ts);
    } else if (this._idle) {
      this.rotation += IDLE_SPEED * dt;
      try { this.render(); } catch (e) { /* 描画失敗は無視して継続 */ }
    } else if (glowing) {
      try { this.render(); } catch (e) {}
    }

    // 静止中はrAFを止めてCPU/バッテリーを食わないようにする
    if (this.isSpinning || this._idle || glowing) {
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
    this._winSeg = sp.segment;
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
    // 通常は easeOutCubic。1等は終盤をさらに寝かせて「あと少し」の間を作る。
    // どちらも単調増加なのでオーバーシュート（行き過ぎて戻る）は起こらない。
    var eased = sp.suspense ? (1 - Math.pow(1 - t, 5.2)) : (1 - Math.pow(1 - t, 3));

    var prevRotation = this.rotation;
    this.rotation = sp.startRotation + (sp.endRotation - sp.startRotation) * eased;

    var speed01 = sp.suspense ? Math.pow(1 - t, 4.2) : Math.pow(1 - t, 2); // 速度成分。開始1→終了0
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
      this._winSeg = sp.segment;      // 停止後に光らせる扇
      this._spin = null;
      try { this.render(); } catch (e) {}
      sp.resolve();
    }
  };

  // ---- 描画 ----
  //
  // 「カジノの福引盤」に見えないことを最優先にしている。
  // やめたもの：電球、強い光沢、彩度の高い原色、太い金の枠。
  // 代わりに入れたもの：機械加工の目盛り、旋盤跡のハブ、面取りの稜線。
  // 精度の高い計器に見えれば、装飾を足さなくても安っぽくならない。

  var BEZEL = 0.085;      // 縁の幅（半径比）
  var TICK_DEG = 5;       // 細かい目盛りの間隔
  var TICK_MAJOR = 30;    // 長い目盛りの間隔

  Wheel.prototype._cache = function (radius) {
    if (this._gc && this._gc.r === radius) return this._gc;
    var ctx = this.ctx;
    var c = { r: radius };

    // 真鍮の縁。円周方向に明暗を振ることで、平面ではなく金属の環に見せる。
    // ハイライトは4か所ではなく2か所に絞る（多いと安いメッキに見える）。
    c.rim = null;
    try {
      if (ctx.createConicGradient) c.rim = ctx.createConicGradient(-Math.PI * 0.75, 0, 0);
    } catch (e) { c.rim = null; }
    if (!c.rim || !c.rim.addColorStop) {
      try { c.rim = ctx.createLinearGradient(-radius, -radius, radius, radius); }
      catch (e2) { c.rim = null; }
    }
    if (c.rim && c.rim.addColorStop) {
      var stops = [
        [0.00, "#3C2D0C"], [0.10, "#8A6B24"], [0.20, "#E4CE8E"], [0.26, "#F6E9C4"],
        [0.34, "#B08F3A"], [0.46, "#4A380F"], [0.58, "#8A6B24"], [0.70, "#DFC684"],
        [0.76, "#F0DFB0"], [0.84, "#9C7A2E"], [0.94, "#42320D"], [1.00, "#3C2D0C"]
      ];
      for (var i = 0; i < stops.length; i++) c.rim.addColorStop(stops[i][0], stops[i][1]);
    } else {
      c.rim = "#9C7A2E";
    }

    // 盤面の陰り。上から柔らかく当たる程度に留める（強い光沢はプラスチックに見える）
    c.shade = ctx.createRadialGradient(0, -radius * 0.34, radius * 0.06, 0, 0, radius);
    c.shade.addColorStop(0.00, "rgba(255,248,232,0.10)");
    c.shade.addColorStop(0.42, "rgba(255,248,232,0.02)");
    c.shade.addColorStop(0.78, "rgba(0,0,0,0.16)");
    c.shade.addColorStop(1.00, "rgba(0,0,0,0.42)");

    c.hubR = radius * 0.155;
    this._gc = c;
    return c;
  };

  Wheel.prototype.render = function () {
    var ctx = this.ctx;
    var w = this.cssW, h = this.cssH;
    if (!ctx || !w || !h) return;
    ctx.clearRect(0, 0, w, h);

    var cx = w / 2, cy = h / 2;
    var outer = Math.min(w, h) / 2 * 0.97;
    var radius = outer * (1 - BEZEL);      // 色の付いた盤面の半径
    var cache = this._cache(radius);
    var segments = this.segments;

    ctx.save();
    ctx.translate(cx, cy);

    // 盤の落ち影。漆の面に置かれているように
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.75)";
    ctx.shadowBlur = radius * 0.16;
    ctx.shadowOffsetY = radius * 0.055;
    ctx.beginPath();
    ctx.arc(0, 0, outer, 0, TAU);
    ctx.fillStyle = "#0E0C0A";
    ctx.fill();
    ctx.restore();

    // ---- 回転する層 ----
    ctx.save();
    ctx.rotate(this.rotation);
    for (var i = 0; i < segments.length; i++) this._drawSegment(ctx, segments[i], radius);
    this._drawDividers(ctx, segments, radius);
    ctx.restore();

    // ---- 回転しない層 ----
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.clip();
    ctx.fillStyle = cache.shade;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    ctx.restore();

    if (this._winSeg && !this.isSpinning) this._drawWinGlow(ctx, radius);

    this._drawBezel(ctx, radius, outer, cache);

    for (var l = 0; l < segments.length; l++) {
      this._drawLabel(ctx, segments[l], radius, this.rotation);
    }

    this._drawHub(ctx, cache);
    ctx.restore();
  };

  Wheel.prototype._drawSegment = function (ctx, seg, radius) {
    var a0 = seg.start - Math.PI / 2;
    var a1 = seg.end - Math.PI / 2;
    var color = "#3A342B", colorDark = "#221E19";
    if (seg.rank) {
      color = seg.rank.color || color;
      colorDark = seg.rank.colorDark || colorDark;
    }
    if (seg.soldOut) {
      color = desaturate(color, 12, 0.6);
      colorDark = desaturate(colorDark, 10, 0.5);
    }
    // 艶消しの塗り。中心から外へ静かに落とすだけにする
    var grad = ctx.createRadialGradient(0, 0, radius * 0.12, 0, 0, radius);
    grad.addColorStop(0.00, color);
    grad.addColorStop(0.72, color);
    grad.addColorStop(1.00, colorDark);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, a0, a1, false);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  };

  // 扇の境目は真鍮のヘアライン1本だけ。太い線を引くと途端に玩具になる
  Wheel.prototype._drawDividers = function (ctx, segments, radius) {
    if (segments.length < 2) return;
    ctx.lineWidth = Math.max(1, radius * 0.004);
    for (var j = 0; j < segments.length; j++) {
      var a = segments[j].start - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * radius * 0.10, Math.sin(a) * radius * 0.10);
      ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
      ctx.strokeStyle = "rgba(201,162,75,0.55)";
      ctx.stroke();
    }
  };

  // 当たった扇に灯りを入れる。色を足すのではなく明度だけを上げる
  Wheel.prototype._drawWinGlow = function (ctx, radius) {
    var seg = this._winSeg;
    if (!seg) return;
    var a0 = seg.start + this.rotation - Math.PI / 2;
    var a1 = seg.end + this.rotation - Math.PI / 2;
    var pulse = this._reducedMotion
      ? 0.20
      : 0.12 + 0.13 * (0.5 + 0.5 * Math.sin(Date.now() / 420));

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, a0, a1, false);
    ctx.closePath();
    ctx.globalCompositeOperation = "lighter";
    var g = ctx.createRadialGradient(0, 0, radius * 0.1, 0, 0, radius);
    g.addColorStop(0, "rgba(255,244,214," + (pulse * 0.5).toFixed(3) + ")");
    g.addColorStop(1, "rgba(242,223,173," + pulse.toFixed(3) + ")");
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  };

  Wheel.prototype._drawLabel = function (ctx, seg, radius, rotation) {
    if (!seg.rank || !seg.rank.label) return;
    var widthRad = seg.end - seg.start;
    if ((widthRad / TAU) * 360 < MIN_LABEL_DEG) return;

    var label = String(seg.rank.label);
    var mid = (seg.start + seg.end) / 2 + rotation - Math.PI / 2;
    var labelR = radius * 0.66;

    var arcSpace = widthRad * labelR * 0.8;
    var size = clamp(radius * 0.155, 13, 72);
    size = Math.min(size, arcSpace / Math.max(1, label.length) * 1.3);
    if (size < 13) return;

    var x = Math.cos(mid) * labelR, y = Math.sin(mid) * labelR;
    ctx.save();
    ctx.translate(x, y);
    ctx.font = "700 " + size.toFixed(1) + "px " + DISPLAY_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // 落とし込みの彫り。下に淡い縁、上に文字を置くと版に押したように見える
    ctx.fillStyle = "rgba(0,0,0,0.42)";
    ctx.fillText(label, 0, size * 0.045);
    ctx.fillStyle = seg.soldOut ? "rgba(240,235,222,0.42)" : "#F7F2E6";
    ctx.fillText(label, 0, 0);
    ctx.restore();
  };

  // 縁。面取りの稜線と機械加工の目盛りで「計器」に見せる
  Wheel.prototype._drawBezel = function (ctx, radius, outer, cache) {
    var band = outer - radius;
    var mid = radius + band / 2;

    ctx.beginPath();
    ctx.arc(0, 0, mid, 0, TAU);
    ctx.strokeStyle = cache.rim;
    ctx.lineWidth = band;
    ctx.stroke();

    // 内外の稜線。細い暗線と明線を隣り合わせると角が立って見える
    var hair = Math.max(1, radius * 0.0045);
    ctx.lineWidth = hair;
    ctx.beginPath(); ctx.arc(0, 0, radius + hair, 0, TAU);
    ctx.strokeStyle = "rgba(0,0,0,0.62)"; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, radius + hair * 2.4, 0, TAU);
    ctx.strokeStyle = "rgba(255,240,205,0.28)"; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, outer - hair, 0, TAU);
    ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, outer - hair * 2.6, 0, TAU);
    ctx.strokeStyle = "rgba(255,240,205,0.22)"; ctx.stroke();

    // 目盛り。5度ごとに細く、30度ごとに長く。カチカチ音の根拠でもある
    ctx.lineCap = "butt";
    for (var deg = 0; deg < 360; deg += TICK_DEG) {
      var major = (deg % TICK_MAJOR === 0);
      var a = (deg / 180) * Math.PI - Math.PI / 2;
      var len = band * (major ? 0.62 : 0.3);
      var r0 = outer - hair * 3 - len;
      var r1 = outer - hair * 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
      ctx.strokeStyle = major ? "rgba(38,27,4,0.75)" : "rgba(48,35,8,0.45)";
      ctx.lineWidth = major ? hair * 1.8 : hair;
      ctx.stroke();
    }
  };

  // 中心。旋盤で挽いた真鍮の面を同心円で表す
  Wheel.prototype._drawHub = function (ctx, cache) {
    var R = cache.hubR;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.6)";
    ctx.shadowBlur = R * 0.6;
    ctx.shadowOffsetY = R * 0.14;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    var base = ctx.createLinearGradient(-R * 0.6, -R, R * 0.5, R);
    base.addColorStop(0.00, "#F0DCA8");
    base.addColorStop(0.30, "#C9A24B");
    base.addColorStop(0.62, "#8A6B24");
    base.addColorStop(1.00, "#4A380F");
    ctx.fillStyle = base;
    ctx.fill();
    ctx.restore();

    // 旋盤跡
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.94, 0, TAU);
    ctx.clip();
    ctx.lineWidth = Math.max(0.6, R * 0.018);
    for (var k = 1; k < 14; k++) {
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.94 * (k / 14), 0, TAU);
      ctx.strokeStyle = (k % 2 === 0) ? "rgba(255,246,222,0.16)" : "rgba(60,44,10,0.20)";
      ctx.stroke();
    }
    ctx.restore();

    // 中央の落とし込み
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.62, 0, TAU);
    var pit = ctx.createRadialGradient(0, -R * 0.25, R * 0.05, 0, 0, R * 0.62);
    pit.addColorStop(0, "#191512");
    pit.addColorStop(1, "#0A0908");
    ctx.fillStyle = pit;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = Math.max(1, R * 0.045);
    ctx.stroke();

    var f = clamp(R * 0.42, 10, 30);
    ctx.font = "700 " + f.toFixed(1) + "px " + DISPLAY_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#C9A24B";
    ctx.fillText("抽選", 0, f * 0.03);
  };

  window.NV.Wheel = Wheel;

  // 検証用の内部関数の限定公開（ブラウザ実行には影響しない。Node等でのテスト専用）
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { buildSegments: buildSegments, desaturate: desaturate };
  }
})();
