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
      this._winSeg = sp.segment;      // 停止後に光らせる扇
      this._spin = null;
      try { this.render(); } catch (e) {}
      sp.resolve();
    }
  };

  // ---- 描画 ----
  //
  // 「安っぽく見える」という指摘を受けての作り直し。効いているのは主に次の4つ。
  //   1. 金属の縁：単色ではなく円周方向のグラデーションで4方向にハイライトを置く
  //   2. 固定光源のツヤ：円盤と一緒に回さない斜め上からの光沢を最後に重ねる
  //      （回してしまうと「塗り」に見えて立体感が出ない）
  //   3. 電球：発光の暈をグラデーションで描き、点灯時は加算合成で光らせる
  //   4. 当たった扇：停止後に脈打つ金色の光を載せて、どこで止まったかを一目で示す
  // グラデーションは半径が変わったときだけ作り直す（毎フレーム生成すると重い）。

  Wheel.prototype._cache = function (radius) {
    if (this._gc && this._gc.r === radius) return this._gc;
    var ctx = this.ctx;
    var c = { r: radius };

    // 金属の縁。同じ金でも明暗を細かく振ると金属に見える。
    // createConicGradient は Chrome 91 以降。古い端末では斜めの線形グラデで代用し、
    // どちらも作れない環境では単色に落として「円盤が消える」ことだけは避ける。
    c.rim = null;
    try {
      if (ctx.createConicGradient) c.rim = ctx.createConicGradient(-Math.PI / 2, 0, 0);
    } catch (e) { c.rim = null; }
    if (!c.rim || !c.rim.addColorStop) {
      try { c.rim = ctx.createLinearGradient(-radius, -radius, radius, radius); }
      catch (e2) { c.rim = null; }
    }
    if (!c.rim || !c.rim.addColorStop) { c.rim = GOLD; this._gc = c; return c; }
    var stops = [
      [0.00, "#FFF0BE"], [0.06, "#C9982F"], [0.14, "#8A6412"], [0.22, "#E7C55F"],
      [0.30, "#FFF6D6"], [0.38, "#B98D28"], [0.48, "#7C5A10"], [0.56, "#E0BA53"],
      [0.64, "#FFF0BE"], [0.72, "#A87F1E"], [0.80, "#7A580F"], [0.88, "#DCB44C"],
      [0.96, "#FFF6D6"], [1.00, "#FFF0BE"]
    ];
    for (var i = 0; i < stops.length; i++) c.rim.addColorStop(stops[i][0], stops[i][1]);
    // 線形グラデで代用したときは 0〜1 が斜め方向に割り当たるが、金属感は十分出る

    // 斜め上からの固定光。円盤を回しても光の位置は動かない
    c.gloss = ctx.createLinearGradient(-radius * 0.7, -radius, radius * 0.3, radius * 0.6);
    // 白を強くすると色が飛んで安っぽくなる。ハイライトは薄く、影は深めに。
    c.gloss.addColorStop(0.00, "rgba(255,255,255,0.15)");
    c.gloss.addColorStop(0.30, "rgba(255,255,255,0.05)");
    c.gloss.addColorStop(0.52, "rgba(255,255,255,0.00)");
    c.gloss.addColorStop(1.00, "rgba(0,0,12,0.30)");

    // 盤面のふちに落ちる内側の影（奥行き）
    c.inner = ctx.createRadialGradient(0, 0, radius * 0.62, 0, 0, radius);
    c.inner.addColorStop(0, "rgba(0,0,0,0)");
    c.inner.addColorStop(1, "rgba(0,0,0,0.38)");

    // 中心ハブの金属
    var hubR = radius * 0.19;
    c.hub = ctx.createRadialGradient(-hubR * 0.35, -hubR * 0.45, hubR * 0.05, 0, 0, hubR);
    c.hub.addColorStop(0.00, "#FFFBEA");
    c.hub.addColorStop(0.28, "#F2D479");
    c.hub.addColorStop(0.62, "#B98D28");
    c.hub.addColorStop(1.00, "#6E4F0C");
    c.hubR = hubR;

    this._gc = c;
    return c;
  };

  Wheel.prototype.render = function () {
    var ctx = this.ctx;
    var w = this.cssW, h = this.cssH;
    if (!ctx || !w || !h) return;
    ctx.clearRect(0, 0, w, h);

    var cx = w / 2, cy = h / 2;
    var radius = Math.min(w, h) / 2 * 0.88;   // 縁と電球のぶん内側に取る
    var cache = this._cache(radius);
    var segments = this.segments;

    ctx.save();
    ctx.translate(cx, cy);

    // 盤の落ち影
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.55)";
    ctx.shadowBlur = radius * 0.13;
    ctx.shadowOffsetY = radius * 0.05;
    ctx.beginPath();
    ctx.arc(0, 0, radius * 1.06, 0, TAU);
    ctx.fillStyle = "#0A1130";
    ctx.fill();
    ctx.restore();

    // ---- ここから回転する層 ----
    ctx.save();
    ctx.rotate(this.rotation);
    for (var i = 0; i < segments.length; i++) this._drawSegment(ctx, segments[i], radius);
    this._drawDividers(ctx, segments, radius);
    ctx.restore();

    // ---- 回転しない層（光と縁）----
    // ふちの内側の影
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.fillStyle = cache.inner;
    ctx.fill();

    // 固定光源のツヤ。これが無いと「塗った円グラフ」に見える
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.clip();
    ctx.fillStyle = cache.gloss;
    ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    ctx.restore();

    // 当たった扇を光らせる（停止後だけ）
    if (this._winSeg && !this.isSpinning) this._drawWinGlow(ctx, radius);

    this._drawRing(ctx, radius, cache);
    this._drawBulbs(ctx, radius);

    // 等級名は回さない（扇ごとに上下が揃うように）
    for (var l = 0; l < segments.length; l++) {
      this._drawLabel(ctx, segments[l], radius, this.rotation);
    }

    this._drawHub(ctx, radius, cache);
    ctx.restore();
  };

  Wheel.prototype._drawSegment = function (ctx, seg, radius) {
    var a0 = seg.start - Math.PI / 2;
    var a1 = seg.end - Math.PI / 2;
    var color = "#8892B0", colorDark = "#5A6484";
    if (seg.rank) {
      color = seg.rank.color || color;
      colorDark = seg.rank.colorDark || colorDark;
    }
    if (seg.soldOut) {
      color = desaturate(color, 15, 0.75);
      colorDark = desaturate(colorDark, 15, 0.65);
    }
    // 中心を明るく、外周を深く。単調な単色塗りを避ける
    var grad = ctx.createRadialGradient(0, 0, radius * 0.10, 0, 0, radius);
    grad.addColorStop(0.00, lighten(color, 0.09));
    grad.addColorStop(0.42, color);
    grad.addColorStop(1.00, colorDark);

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, a0, a1, false);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  };

  // 扇の境目。金の線の両脇に暗い線を添えると彫りが入って見える
  Wheel.prototype._drawDividers = function (ctx, segments, radius) {
    if (segments.length < 2) return;
    var wide = Math.max(1.5, radius * 0.010);
    for (var j = 0; j < segments.length; j++) {
      var a = segments[j].start - Math.PI / 2;
      var x = Math.cos(a) * radius, y = Math.sin(a) * radius;

      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(x, y);
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = wide * 2.2;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(x, y);
      ctx.strokeStyle = "#F6DE9A";
      ctx.lineWidth = wide;
      ctx.stroke();
    }
  };

  // 停止後、当たった扇だけを脈打たせる
  Wheel.prototype._drawWinGlow = function (ctx, radius) {
    var seg = this._winSeg;
    if (!seg) return;
    var a0 = seg.start + this.rotation - Math.PI / 2;
    var a1 = seg.end + this.rotation - Math.PI / 2;
    var pulse = this._reducedMotion ? 0.34 : 0.22 + 0.20 * (0.5 + 0.5 * Math.sin(Date.now() / 300));

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, a0, a1, false);
    ctx.closePath();
    ctx.globalCompositeOperation = "lighter";
    var g = ctx.createRadialGradient(0, 0, radius * 0.2, 0, 0, radius);
    g.addColorStop(0, "rgba(255,240,190," + (pulse * 0.45).toFixed(3) + ")");
    g.addColorStop(1, "rgba(255,210,110," + pulse.toFixed(3) + ")");
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
    var labelR = radius * 0.62;

    var arcSpace = widthRad * labelR * 0.82;
    var size = clamp(radius * 0.16, 13, 68);
    size = Math.min(size, arcSpace / Math.max(1, label.length) * 1.35);
    if (size < 13) return;

    ctx.save();
    ctx.translate(Math.cos(mid) * labelR, Math.sin(mid) * labelR);
    ctx.font = "700 " + size.toFixed(1) + "px " + DISPLAY_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    // 明朝は横画が細い。濃い縁取り＋わずかな影で扇の上でも溶けないようにする
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = size * 0.22;
    ctx.shadowOffsetY = size * 0.04;
    ctx.lineWidth = Math.max(2, size * 0.14);
    ctx.strokeStyle = "rgba(24,18,4,0.55)";
    ctx.strokeText(label, 0, 0);
    ctx.shadowColor = "transparent";
    var tg = ctx.createLinearGradient(0, -size * 0.6, 0, size * 0.6);
    tg.addColorStop(0, "#FFFFFF");
    tg.addColorStop(1, "#F1E4C4");
    ctx.fillStyle = seg.soldOut ? "rgba(255,255,255,0.45)" : tg;
    ctx.fillText(label, 0, 0);
    ctx.restore();
  };

  // 外周の金属リング。内外に暗い溝を入れて厚みを出す
  Wheel.prototype._drawRing = function (ctx, radius, cache) {
    var band = radius * 0.115;
    var mid = radius + band * 0.5;

    ctx.beginPath();
    ctx.arc(0, 0, mid, 0, TAU);
    ctx.strokeStyle = cache.rim;
    ctx.lineWidth = band;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, radius + band * 0.04, 0, TAU);
    ctx.strokeStyle = "rgba(40,26,0,0.55)";
    ctx.lineWidth = Math.max(1.5, radius * 0.012);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, radius + band * 0.98, 0, TAU);
    ctx.strokeStyle = "rgba(30,20,0,0.6)";
    ctx.lineWidth = Math.max(1.5, radius * 0.014);
    ctx.stroke();
  };

  // リング上の電球。点灯側は加算合成で暈を出す
  Wheel.prototype._drawBulbs = function (ctx, radius) {
    var band = radius * 0.115;
    var ringR = radius + band * 0.5;
    var bulbR = band * 0.27;
    var blink = !this._reducedMotion && (this.isSpinning || this._idle);

    for (var i = 0; i < PEG_COUNT; i++) {
      var a = (i / PEG_COUNT) * TAU - Math.PI / 2;
      var x = Math.cos(a) * ringR, y = Math.sin(a) * ringR;
      var even = (i % 2 === 0);
      var lit = blink ? (even === this._blinkOn) : even;

      if (lit) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        var halo = ctx.createRadialGradient(x, y, 0, x, y, bulbR * 3.2);
        halo.addColorStop(0, "rgba(255,244,206,0.85)");
        halo.addColorStop(0.35, "rgba(255,214,120,0.35)");
        halo.addColorStop(1, "rgba(255,190,60,0)");
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(x, y, bulbR * 3.2, 0, TAU);
        ctx.fill();
        ctx.restore();
      }

      var g = ctx.createRadialGradient(x - bulbR * 0.3, y - bulbR * 0.3, bulbR * 0.1, x, y, bulbR);
      if (lit) { g.addColorStop(0, "#FFFFFF"); g.addColorStop(0.6, "#FFF0BC"); g.addColorStop(1, "#F0C24A"); }
      else { g.addColorStop(0, "#8A6A22"); g.addColorStop(1, "#4A3608"); }
      ctx.beginPath();
      ctx.arc(x, y, bulbR, 0, TAU);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = "rgba(40,26,0,0.5)";
      ctx.lineWidth = Math.max(0.8, bulbR * 0.18);
      ctx.stroke();
    }
  };

  Wheel.prototype._drawHub = function (ctx, radius, cache) {
    var hubR = cache.hubR;

    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = hubR * 0.5;
    ctx.shadowOffsetY = hubR * 0.12;
    ctx.beginPath();
    ctx.arc(0, 0, hubR, 0, TAU);
    ctx.fillStyle = cache.hub;
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(0, 0, hubR * 0.78, 0, TAU);
    var inner = ctx.createRadialGradient(0, -hubR * 0.3, hubR * 0.05, 0, 0, hubR * 0.78);
    inner.addColorStop(0, "#22305F");
    inner.addColorStop(1, "#0A1130");
    ctx.fillStyle = inner;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = Math.max(1, hubR * 0.05);
    ctx.stroke();

    var f = clamp(hubR * 0.40, 11, 30);
    ctx.font = "700 " + f.toFixed(1) + "px " + DISPLAY_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#F3D783";
    ctx.fillText("抽選", 0, 0);
  };

  window.NV.Wheel = Wheel;

  // 検証用の内部関数の限定公開（ブラウザ実行には影響しない。Node等でのテスト専用）
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { buildSegments: buildSegments, desaturate: desaturate };
  }
})();
