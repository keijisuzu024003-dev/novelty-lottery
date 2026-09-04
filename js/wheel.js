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
    this._speed01 = 0;     // 0〜1 の体感速度。残像・光量・ラベルの濃さを全部これで決める
    this._dRot = 0;        // 直近1フレームの回転量[rad]。モーションブラーの幅そのもの
    this._flareT = null;   // 停止時の炸裂の開始時刻。null なら炸裂していない
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
        self._flareT = null; // 前回の炸裂も消す（残っていると回り始めに白く光る）
        self.isSpinning = true;
        self._spin = {
          startTs: null,
          duration: duration,
          // 止まる扇。これを積み忘れると sp.segment が undefined になり、
          // 停止後の «当たりの扇» が一切光らなくなる（実際に長らくそうなっていた）
          segment: plan.segment,
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

    // 当たった扇の光を脈打たせている間も、停止時の炸裂が収まるまでも描き続ける
    var glowing = !!this._winSeg && !this.isSpinning && !this._reducedMotion;

    if (this.isSpinning) {
      this._stepSpin(ts);
    } else {
      // 回していないフレームでは速度も残像もゼロに戻す（消し忘れると滲んだまま止まる）
      this._dRot = 0;
      this._speed01 = 0;
      if (this._idle) {
        this.rotation += IDLE_SPEED * dt;
        try { this.render(); } catch (e) { /* 描画失敗は無視して継続 */ }
      } else if (glowing || this._flareT != null) {
        try { this.render(); } catch (e) {}
      }
    }

    // 静止中はrAFを止めてCPU/バッテリーを食わないようにする
    // （_flareT は render の中で炸裂が終わると null に戻る）
    if (this.isSpinning || this._idle || glowing || this._flareT != null) {
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
    this._dRot = 0;
    this._speed01 = 0;
    // 非常口から抜けた場合も炸裂は出す（rAF が死んでいれば描かれないだけ）
    this._flareT = Date.now();
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
    this._dRot = this.rotation - prevRotation;  // このフレームで進んだ角度＝残像の幅

    var speed01 = sp.suspense ? Math.pow(1 - t, 4.2) : Math.pow(1 - t, 2); // 速度成分。開始1→終了0
    this._speed01 = clamp(speed01, 0, 1);
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
      this._dRot = 0;
      this._speed01 = 0;
      this._flareT = Date.now();      // ここから FLARE_MS かけて炸裂が収まる
      this._ensureLoop();             // 炸裂を描くためにループを起こし直す
      try { this.render(); } catch (e) {}
      sp.resolve();
    }
  };

  // ---- 描画 ----
  //
  // 円盤そのものは徹底して簡素にする。
  // 電球・旋盤跡・目盛り・多段グラデーションのような «静止画の作り込み» は、
  // 遠目には潰れて情報量だけが増え、結局「ごちゃついた盤」にしか見えない。
  // 残すのは3つだけ：平らな色面、細い環、小さな軸。
  //
  // 派手さは静止画ではなく «動き» で出す。
  //   回転中 … 残像（本物のモーションブラー）／環を走る光／外へ漏れる熱
  //   停止時 … 当たりの扇の白熱／放射する光条／2重の衝撃波
  // 止まっている盤は静かで、回すと化ける。この落差が «派手» の正体。

  var BEZEL = 0.030;      // 縁の環の幅（半径比）。線1本ぶんに留める
  var FLARE_MS = 900;     // 停止時の炸裂が収まるまで。app.js の RESULT_DELAY_MS と組で効く
  // 盤は canvas いっぱいに描かない。外へ漏らす光と光条のぶんだけ余白を残す。
  // 目一杯に描くと、光が canvas の四角い縁で切れて «四角い明るい箱» になる。
  // app.css の #pointer / #shock がこの数字に依存しているので、変えるなら両方直すこと。
  var STAGE_FILL = 0.84;

  Wheel.prototype._cache = function (radius) {
    if (this._gc && this._gc.r === radius) return this._gc;
    this._gc = { r: radius, hubR: radius * 0.10 };
    return this._gc;
  };

  Wheel.prototype.render = function () {
    var ctx = this.ctx;
    var w = this.cssW, h = this.cssH;
    if (!ctx || !w || !h) return;
    ctx.clearRect(0, 0, w, h);

    var cx = w / 2, cy = h / 2;
    var maxR = Math.min(w, h) / 2;      // canvas に収まる最大半径。光はここで頭打ちにする
    var outer = maxR * STAGE_FILL;
    var radius = outer * (1 - BEZEL);
    var cache = this._cache(radius);
    var segments = this.segments;
    var speed = this._reducedMotion ? 0 : (this._speed01 || 0);

    ctx.save();
    ctx.translate(cx, cy);

    // 盤の外へ漏れる熱。速いほど強く、止まると消える
    if (speed > 0.02) this._drawHalo(ctx, outer, maxR, speed);

    // ---- 回転する層 ----
    // 1フレームぶんの回転量を後ろへ何枚か重ねる＝本物のモーションブラー。
    // 「速く回っている絵」を描くのではなく、実際に速いから滲む。
    var blur = this._reducedMotion ? 0 : Math.min(Math.abs(this._dRot || 0), 0.62);
    var ghosts = blur > 0.02 ? Math.min(11, Math.round(blur * 34)) : 0;
    // 古い残像から順に半透明で重ね、最後の «現在位置» も透かして置く。
    // ここを不透明にすると盤面全体を覆ってしまい、残像が1枚も見えなくなる。
    for (var g = ghosts; g >= 1; g--) {
      ctx.save();
      ctx.globalAlpha = 0.30;
      ctx.rotate(this.rotation - blur * (g / ghosts));
      this._drawFace(ctx, segments, radius);
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = ghosts ? 0.62 : 1;
    ctx.rotate(this.rotation);
    this._drawFace(ctx, segments, radius);
    ctx.restore();

    // ---- 回転しない層 ----
    if (this._winSeg && !this.isSpinning) this._drawWinGlow(ctx, radius);
    this._drawRing(ctx, radius, outer, speed);

    // 等級名。高速時は消す。読めないうえ、残っていると残像を濁らせる
    var labelAlpha = 1 - Math.min(1, speed * 1.7);
    if (labelAlpha > 0.03) {
      ctx.save();
      ctx.globalAlpha = labelAlpha;
      for (var l = 0; l < segments.length; l++) {
        this._drawLabel(ctx, segments[l], radius, this.rotation);
      }
      ctx.restore();
    }

    this._drawHub(ctx, cache);
    if (this._flareT != null) this._drawFlare(ctx, radius, outer, maxR);

    ctx.restore();
  };

  // 盤面。ベタ塗りの扇と、境目の細い暗線だけ
  Wheel.prototype._drawFace = function (ctx, segments, radius) {
    var i;
    for (i = 0; i < segments.length; i++) {
      var seg = segments[i];
      var color = (seg.rank && seg.rank.color) || "#3A342B";
      if (seg.soldOut) color = desaturate(color, 12, 0.55);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, seg.start - Math.PI / 2, seg.end - Math.PI / 2, false);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
    }
    if (segments.length < 2) return;
    ctx.lineWidth = Math.max(1, radius * 0.006);
    ctx.strokeStyle = "rgba(9,8,7,0.55)";
    for (i = 0; i < segments.length; i++) {
      var a = segments[i].start - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(a) * radius, Math.sin(a) * radius);
      ctx.stroke();
    }
  };

  // 縁。真鍮の細い環1本。回転中はその上を光が走る
  Wheel.prototype._drawRing = function (ctx, radius, outer, speed) {
    var band = outer - radius;
    ctx.beginPath();
    ctx.arc(0, 0, radius + band / 2, 0, TAU);
    ctx.lineWidth = band;
    ctx.strokeStyle = "#C9A24B";
    ctx.stroke();

    if (speed <= 0.02) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.rotate(this.rotation * 1.7);
    ctx.lineWidth = band * 1.4;
    ctx.lineCap = "round";
    var arc = 0.35 + speed * 1.7;
    for (var k = 0; k < 2; k++) {
      var a0 = k * Math.PI;
      ctx.beginPath();
      ctx.arc(0, 0, radius + band / 2, a0, a0 + arc);
      ctx.strokeStyle = "rgba(255,246,222," + (0.22 + 0.6 * speed).toFixed(3) + ")";
      ctx.stroke();
    }
    ctx.restore();
  };

  // 回転が速いほど盤の外へ光が漏れる。周囲を明るくして「勢い」を伝える
  Wheel.prototype._drawHalo = function (ctx, outer, maxR, speed) {
    // maxR を超えると canvas の四角い縁でグラデーションが切れて箱になる
    var r1 = Math.min(outer * (1.02 + 0.42 * speed), maxR);
    var g = ctx.createRadialGradient(0, 0, outer * 0.88, 0, 0, r1);
    g.addColorStop(0, "rgba(255,214,120," + (0.34 * speed).toFixed(3) + ")");
    g.addColorStop(1, "rgba(255,214,120,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath();
    ctx.arc(0, 0, r1, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  };

  // 停止後。当たった扇«以外»を沈めてから、当たりに灯りを入れる。
  // 光を足すだけだと元の色が濃いぶん埋もれて、遠目にどこで止まったのか分からない。
  // 明るくするより «周りを暗くする» 方が、同じ手間で何倍も読める。
  Wheel.prototype._drawWinGlow = function (ctx, radius) {
    var seg = this._winSeg;
    if (!seg) return;
    var segments = this.segments;

    // 炸裂中は 0 から立ち上げる。いきなり暗転すると «画面が壊れた» ように見える
    var ramp = 1;
    if (this._flareT != null) {
      ramp = Math.min(1, ((Date.now() - this._flareT) / FLARE_MS) * 3.2);
      if (!(ramp >= 0)) ramp = 0;
    }

    ctx.save();
    for (var i = 0; i < segments.length; i++) {
      if (segments[i] === seg) continue;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius,
        segments[i].start + this.rotation - Math.PI / 2,
        segments[i].end + this.rotation - Math.PI / 2, false);
      ctx.closePath();
      ctx.fillStyle = "rgba(6,5,4," + (0.58 * ramp).toFixed(3) + ")";
      ctx.fill();
    }
    ctx.restore();

    var pulse = this._reducedMotion
      ? 0.20
      : 0.16 + 0.16 * (0.5 + 0.5 * Math.sin(Date.now() / 380));

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius,
      seg.start + this.rotation - Math.PI / 2,
      seg.end + this.rotation - Math.PI / 2, false);
    ctx.closePath();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "rgba(255,246,222," + pulse.toFixed(3) + ")";
    ctx.fill();
    ctx.restore();
  };

  // 停止の瞬間の炸裂。静止画の装飾を削った分をここに全部寄せている
  Wheel.prototype._drawFlare = function (ctx, radius, outer, maxR) {
    var p = (Date.now() - this._flareT) / FLARE_MS;
    if (!(p >= 0)) p = 0;
    if (p >= 1) { this._flareT = null; return; }
    var inv = 1 - p;
    var seg = this._winSeg;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // 当たりの扇が白熱する
    if (seg) {
      var a0 = seg.start + this.rotation - Math.PI / 2;
      var a1 = seg.end + this.rotation - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, a0, a1, false);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,250,232," + (0.95 * Math.pow(inv, 1.4)).toFixed(3) + ")";
      ctx.fill();
    }

    // 放射する光条。長短を混ぜないと «歯車» のように機械的に見える
    var rays = 18;
    var cap = maxR * 0.99;
    var len = outer * (0.8 + 0.9 * p);
    ctx.save();
    ctx.rotate(this.rotation * 0.12 + p * 0.22);
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(255,242,212," + (0.5 * inv * inv).toFixed(3) + ")";
    ctx.lineWidth = Math.max(1, outer * 0.016 * inv);
    for (var k = 0; k < rays; k++) {
      var a = (k / rays) * TAU;
      var reach = Math.min(len * (k % 3 === 0 ? 1.35 : 0.72), cap);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * outer * 0.42, Math.sin(a) * outer * 0.42);
      ctx.lineTo(Math.cos(a) * reach, Math.sin(a) * reach);
      ctx.stroke();
    }
    ctx.restore();

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
    var size = clamp(radius * 0.165, 13, 78);
    size = Math.min(size, arcSpace / Math.max(1, label.length) * 1.3);
    if (size < 13) return;

    ctx.save();
    ctx.translate(Math.cos(mid) * labelR, Math.sin(mid) * labelR);
    ctx.font = "700 " + size.toFixed(1) + "px " + DISPLAY_FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // 色面の上に白文字を置くだけだと沈むので、下に一段だけ影を敷く
    ctx.fillStyle = "rgba(0,0,0,0.38)";
    ctx.fillText(label, 0, size * 0.05);
    ctx.fillStyle = seg.soldOut ? "rgba(240,235,222,0.42)" : "#FFFFFF";
    ctx.fillText(label, 0, 0);
    ctx.restore();
  };

  // 軸。黒い小円に真鍮の輪郭1本だけ
  Wheel.prototype._drawHub = function (ctx, cache) {
    var R = cache.hubR;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, TAU);
    ctx.fillStyle = "#0B0A09";
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, R * 0.13);
    ctx.strokeStyle = "#C9A24B";
    ctx.stroke();
  };

  window.NV.Wheel = Wheel;

  // 検証用の内部関数の限定公開（ブラウザ実行には影響しない。Node等でのテスト専用）
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { buildSegments: buildSegments, desaturate: desaturate };
  }
})();
