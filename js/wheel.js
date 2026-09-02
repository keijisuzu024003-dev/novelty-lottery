// js/wheel.js
// ルーレット円盤の描画と回転演出。SPEC.md の NV.Wheel 契約のみを外部に見せる。
// ------------------------------------------------------------
window.NV = window.NV || {};

(function () {
  "use strict";

  var TAU = Math.PI * 2;
  var MIN_SEG_DEG = 8;          // 1セグメントが下回ってはいけない角度
  var TARGET_MIN_SEGS = 12;     // 総セグメント数の目安（下限）。少ないと円盤が円グラフに見える
  var TARGET_MAX_SEGS = 24;     // 総セグメント数の目安（上限。遠目に潰れないよう）
  var IDLE_SPEED = 0.06;        // 待機中の自転速度 [rad/s]
  var GOLD = "#FFD97A";

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

  // 円環として見たときに同じ等級が隣り合っている箇所を、可能な範囲で解消する。
  // 隣接している側の1枚を「前後とも別等級」の位置へ移すだけなので、
  // 各等級の枚数は変わらない＝面積の合計（＝確率）は一切動かさない。
  // 多数派が過半数を超えている場合は数学的に隣接を消せないので、そのときは減らせるだけ減らす。
  function repairAdjacency(order) {
    var n = order.length;
    if (n < 4) return order;

    for (var pass = 0; pass < n; pass++) {
      // 継ぎ目を優先して見たいので、末尾→先頭の並びから調べる
      var bad = -1;
      for (var i = 0; i < n; i++) {
        var cur = order[(n - 1 + i) % n];
        var nxt = order[(n + i) % n];
        if (cur.rankId === nxt.rankId) { bad = (n + i) % n; break; }
      }
      if (bad === -1) return order;                 // 隣接なし

      var moving = order[bad];
      var rest = order.slice(0, bad).concat(order.slice(bad + 1));
      var m = rest.length;

      // rest を円環と見て「前後とも moving と別等級」の隙間を探す
      var slot = -1;
      for (var j = 0; j < m; j++) {
        if (rest[j].rankId !== moving.rankId &&
            rest[(j + 1) % m].rankId !== moving.rankId) { slot = j + 1; break; }
      }
      if (slot === -1) return order;                // 置ける隙間が無い＝これ以上は減らせない

      rest.splice(slot, 0, moving);
      for (var k2 = 0; k2 < n; k2++) order[k2] = rest[k2];
    }
    return order;
  }

  // ---- セグメント生成（設計の肝） ----
  // weight 通りの面積を保ったまま、各等級を複数セグメントに分割して交互配置する。
  // 例外を投げない：ranks が空 / weight が全部0以下でも必ず何か返す。
  function buildSegments(ranks) {
    var list = [];
    try {
      list = (ranks || []).filter(function (r) { return r && typeof r === "object"; });
    } catch (e) {
      list = [];
    }

    if (list.length === 0) {
      // 空盤：グレー1枚
      return [{ rankId: null, rank: null, soldOut: false, start: 0, end: TAU }];
    }

    // weight 正規化。全部0以下なら等分（0除算を避ける）
    var weights = list.map(function (r) {
      var w = Number(r.weight);
      return (isFinite(w) && w > 0) ? w : 0;
    });
    var totalW = weights.reduce(function (a, b) { return a + b; }, 0);
    if (totalW <= 0) {
      weights = list.map(function () { return 1; });
      totalW = list.length;
    }
    var shareDeg = weights.map(function (w) { return (w / totalW) * 360; });

    // 分割数決定：1セグメント8度以上を保ったまま、8〜24本程度を目安に
    // 「今いちばん大きい断片を持つ等級」を貪欲に分割し続ける
    var n = list.length;
    var maxSegs = shareDeg.map(function (d) { return Math.max(1, Math.floor(d / MIN_SEG_DEG)); });
    var k = list.map(function () { return 1; });
    var targetTotal = clamp(n * 5, TARGET_MIN_SEGS, TARGET_MAX_SEGS);
    var total = n;
    while (total < targetTotal) {
      var bestIdx = -1, bestSize = -1;
      for (var i = 0; i < n; i++) {
        if (k[i] < maxSegs[i]) {
          var size = shareDeg[i] / k[i];
          if (size > bestSize) { bestSize = size; bestIdx = i; }
        }
      }
      if (bestIdx === -1) break; // これ以上細分化できない
      k[bestIdx]++;
      total++;
    }

    // 等級ごとに、分割済みセグメント（角度と在庫状態）の束を作る
    var buckets = list.map(function (rank, i) {
      var segDeg = shareDeg[i] / k[i];
      var stock = 0;
      try {
        stock = (rank.items || []).reduce(function (s, it) { return s + (Number(it && it.stock) || 0); }, 0);
      } catch (e) { stock = 0; }
      var arr = [];
      for (var j = 0; j < k[i]; j++) {
        arr.push({ rankId: rank.id, rank: rank, angleDeg: segDeg, soldOut: stock <= 0 });
      }
      return arr;
    });

    // 隣接回避の貪欲配置：残数が最も多い等級から置く（直前と同じ等級はスキップ）
    var remaining = buckets.map(function (b) { return b.slice(); });
    var order = [];
    var prevIdx = -1;
    for (var placed = 0; placed < total; placed++) {
      var pick = -1, pickCount = -1;
      for (var bi = 0; bi < remaining.length; bi++) {
        if (remaining[bi].length === 0) continue;
        if (bi === prevIdx) continue; // 直前と同じ等級は避ける
        if (remaining[bi].length > pickCount) { pickCount = remaining[bi].length; pick = bi; }
      }
      if (pick === -1) {
        // 直前と同じ等級しか残っていない＝隣接不可避（端の1箇所として許容）
        for (var bj = 0; bj < remaining.length; bj++) {
          if (remaining[bj].length > 0) { pick = bj; break; }
        }
      }
      if (pick === -1) break; // もう何も残っていない
      order.push(remaining[pick].shift());
      prevIdx = pick;
    }

    // 貪欲配置は直線としては最適だが、円環の継ぎ目（末尾→先頭）の隣接だけは残ることがある。
    // しかも継ぎ目は角度0＝ポインタの真下に来るので、同色2枚が並ぶといちばん目立つ。
    repairAdjacency(order);

    // 真上=0として時計回りに角度を割り当てる
    var segments = [];
    var cursor = 0;
    for (var s = 0; s < order.length; s++) {
      var item = order[s];
      var rad = (item.angleDeg / 360) * TAU;
      segments.push({
        rankId: item.rankId,
        rank: item.rank,
        soldOut: item.soldOut,
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

  // prev→curr の回転区間でセグメント境界を何回跨いだか（漏れなく数える）
  Wheel.prototype._countCrossings = function (prevRotation, currRotation) {
    var segments = this.segments;
    if (!segments || segments.length === 0) return 0;
    var total = 0;
    for (var i = 0; i < segments.length; i++) {
      var b = segments[i].start;
      var n1 = Math.floor((prevRotation + b) / TAU);
      var n2 = Math.floor((currRotation + b) / TAU);
      total += (n2 - n1);
    }
    return total;
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

    for (var l = 0; l < segments.length; l++) {
      this._drawLabel(ctx, segments[l], radius);
    }

    this._drawRing(ctx, radius);
    this._drawBulbs(ctx, radius);

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

  Wheel.prototype._drawLabel = function (ctx, seg, radius) {
    if (!seg.rank || !seg.rank.label) return;
    var widthRad = seg.end - seg.start;
    var widthDeg = (widthRad / TAU) * 360;
    if (widthDeg < 14) return; // 潰れる文字は出さない

    var mid = (seg.start + seg.end) / 2 - Math.PI / 2;
    var labelR = radius * 0.62;
    var fontSize = clamp(radius * 0.11, 14, 40);

    ctx.save();
    ctx.font = "700 " + fontSize + "px \"Noto Sans JP\",\"Hiragino Sans\",system-ui,sans-serif";
    var textW = ctx.measureText(seg.rank.label).width;
    var arcSpace = widthRad * labelR * 0.9;
    if (textW > arcSpace) {
      fontSize = clamp(fontSize * (arcSpace / Math.max(1, textW)), 10, fontSize);
      ctx.font = "700 " + fontSize + "px \"Noto Sans JP\",\"Hiragino Sans\",system-ui,sans-serif";
      textW = ctx.measureText(seg.rank.label).width;
      if (textW > arcSpace) { ctx.restore(); return; } // それでも入らないなら諦める
    }

    ctx.translate(Math.cos(mid) * labelR, Math.sin(mid) * labelR);
    var m = normalizeSigned(mid);
    var rot = m;
    if (m > Math.PI / 2 || m < -Math.PI / 2) rot += Math.PI; // 下半分で文字が逆さにならないよう反転
    ctx.rotate(rot);

    ctx.fillStyle = "#FFFFFF";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = fontSize * 0.15;
    ctx.fillText(seg.rank.label, 0, 0);
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
    ctx.font = "700 " + clamp(hubR * 0.42, 12, 28) + "px \"Noto Sans JP\",\"Hiragino Sans\",system-ui,sans-serif";
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
