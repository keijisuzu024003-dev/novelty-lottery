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
  //
  // 等級1つにつき扇1枚。幅＝その等級の確率そのもの。
  //
  // 以前は等級を複数枚に割って円周へ散らしていた（3等62%を1枚223°で置くと
  // 盤の6割が同じ色になり «まあ3等だろう» が回す前に伝わるため）。
  // 特賞（幅3.6°）を入れたことで «盤で狙う一点» がそちらへ移ったので、1枚に戻した。
  // 緊張は «どの等級に入るか» ではなく «あの金の線に入るか» で作る。
  //
  // 並びは 1等 → 特賞 → 2等 → 3等。特賞を1等の隣に置くと «高い側の一角» として
  // ひとまとまりに見え、指針がそこを通り抜けるあいだ緊張が途切れない。
  //
  // 特賞は自前の在庫を持たない（noStock）。全体に在庫がある限り盤に残す。
  // 在庫0の «普通の» 等級は盤から外して残りで正規化する。外さないと
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

    var total = 0;
    for (var t = 0; t < list.length; t++) total += stockOf(list[t]);

    // 在庫のある等級だけを盤に載せる。特賞は自前の在庫を持たないので常に残す。
    //
    // 在庫切れ表示（くすませる）にするのは «在庫を持つ等級があるのに全滅した» ときだけ。
    // 「全部 noStock なら在庫0だから在庫切れ」と単純に判定すると、
    // ボーナス盤（1個/2個/3個。どれも在庫を持たない）が丸ごとくすむ
    var hasStockRank = false;
    for (var h = 0; h < list.length; h++) {
      if (!list[h].noStock) { hasStockRank = true; break; }
    }

    var live;
    var soldOutAll = false;
    if (hasStockRank && total <= 0) {
      live = list;
      soldOutAll = true;
    } else {
      live = list.filter(function (r) {
        return r.noStock || stockOf(r) > 0;
      });
      if (live.length === 0) { live = list; soldOutAll = true; }
    }

    // 特賞を «最初の普通の等級» のすぐ後ろへ移す（＝1等の隣）
    var order = live.slice();
    for (var a = 0; a < order.length; a++) {
      if (order[a].jackpot) {
        var j = order.splice(a, 1)[0];
        order.splice(Math.min(1, order.length), 0, j);
        break;
      }
    }

    var weights = order.map(function (r) {
      var w = Number(r.weight);
      return (isFinite(w) && w > 0) ? w : 0;
    });
    var totalW = weights.reduce(function (x, y) { return x + y; }, 0);
    if (totalW <= 0) {
      weights = order.map(function () { return 1; });
      totalW = order.length;
    }

    var segments = [];
    var cursor = 0;
    for (var k = 0; k < order.length; k++) {
      var rad = (weights[k] / totalW) * TAU;
      // 端数の積み残しで最後に隙間が出ないよう、最後の1枚は残り全部にする
      if (k === order.length - 1) rad = TAU - cursor;
      segments.push({
        rankId: order[k].id,
        rank: order[k],
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
    this._topRankId = null; // 最上位等級のID。ニアミス（«惜しい»）の判定に使う
    this._nearT = null;    // ニアミスの開始時刻。null なら光っていない
    this._nearSeg = null;  // かすめた最上位等級の扇
    this._speed01 = 0;     // 0〜1 の体感速度。残像・光量・ラベルの濃さを全部これで決める
    this._dRot = 0;        // 直近1フレームの回転量[rad]。モーションブラーの幅そのもの
    this._flareT = null;   // 停止時の炸裂の開始時刻。null なら炸裂していない
    this._pendingWin = null; // 炸裂を保留している当たりの扇（1等の «時間が止まる» 間）
    this._omega = 0;       // 角速度 [rad/s]。フレームレートに依存しない «速さ» の指標
    this._dt = 1 / 60;     // 直近のフレーム間隔[s]。90Hz 端末で残像が薄くならないように
    this._reducedMotion = false;
    try {
      this._reducedMotion = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    } catch (e) {
      this._reducedMotion = false;
    }
  }

  // opts.nearTarget … ニアミス（«惜しい»）で光らせる等級のID。null で無効。
  //   省略時は top を立てた等級（＝特賞）。それも無ければ ranks[0]。
  //   1個/2個/3個 のボーナス盤では null を渡して切る（120°の扇で «惜しい» は成立しない）
  Wheel.prototype.setRanks = function (ranks, opts) {
    this._winSeg = null; // 扇を作り直すので前回の当たりの参照は捨てる
    this._pendingWin = null;
    this._nearT = null;
    this._nearSeg = null;
    if (opts && Object.prototype.hasOwnProperty.call(opts, "nearTarget")) {
      this._topRankId = opts.nearTarget || null;
    } else {
      var target = null;
      for (var i = 0; i < (ranks || []).length; i++) {
        if (ranks[i] && ranks[i].top) { target = ranks[i].id; break; }
      }
      this._topRankId = target || ((ranks && ranks[0] && ranks[0].id) || null);
    }
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

  // 指定の回転量のとき、12時の指針が指している扇を返す
  Wheel.prototype._segmentAt = function (rotation) {
    var a = ((-rotation % TAU) + TAU) % TAU;
    for (var i = 0; i < this.segments.length; i++) {
      var s = this.segments[i];
      if (a >= s.start && a < s.end) return s;
    }
    return null;
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
    // 扇の中心から散らして止めるが、境界に寄せすぎない。
    // 指針には太さがあるので、余白が 4.5 度を切ると «どちらの扇に入ったのか» が
    // 見た目で判断できなくなる（扇を割って 18 度の扇ができたので効いてくる）
    var edgeRad = (4.5 / 180) * Math.PI;
    var spread = Math.min(0.35, Math.max(0, (width / 2 - edgeRad) / width));
    var target = center + (Math.random() * 2 - 1) * spread * width;

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

  // ---- 終盤のラチェット ----
  //
  // 滑らかに減速して止まると「気づいたら止まっていた」になる。
  // 最後の数目盛りを1つずつ、溜めを伸ばしながら越えることで
  // 「次の扇に入るか、入らないか」の瀬戸際を見せる。
  //
  // 手前の n-1 歩は目盛り（PEG_COUNT 等分）の上でぴたりと止め、
  // 最後の1歩だけが本当の停止位置。最後の1歩は 0〜1目盛りぶんの端数なので、
  // ほんの少し動いて止まることもあれば、丸々1目盛り動くこともある。この揺らぎが効く。
  var RATCHET_TAIL_MS = 140;   // 最後のカチから炸裂までの «無音の一拍»

  function buildRatchet(endRotation, count, suspense) {
    // 1歩は目盛り1つぶん（5度）ちょうど。目盛りの絶対位置に揃える必要は無い
    // ——目盛りは音の密度を決めるためだけの存在で、盤には描いていない。
    // 揃えようとすると最後の1歩が端数になり、動きが見えないまま終わる。
    var step = TAU / PEG_COUNT;
    var start = endRotation - count * step;
    var stops = [];
    var acc = 0;
    for (var i = 0; i < count; i++) {
      var last = (i === count - 1);
      var p = (i + 1) / count;
      // 動きは緩やかに伸ばし、溜めは二乗で伸ばす。«溜めの伸び» が緊張の正体。
      // ただし最後の溜めだけは短くする。ここを伸ばすと «最終クリック → 炸裂» が間延びする
      var moveMs = 95 + (suspense ? 95 : 85) * p;
      // 1等だけ、最後の2歩を寝かせる。«あと1コマ» を目で追える速さまで落とす。
      // 溜めを伸ばすのとは別物で、こちらは «動いている最中» が遅い
      if (suspense && i >= count - 2) moveMs *= 2.3;
      var holdMs = last
        ? RATCHET_TAIL_MS
        : (suspense ? 25 : 20) + (suspense ? 480 : 300) * p * p;
      // 最終クリックの直前だけ、はっきり «止める»。二乗の伸びに任せると 392ms で足りない
      if (suspense && i === count - 2) holdMs = 600;
      stops.push({ rot: start + (i + 1) * step, at: acc, dur: moveMs, fired: false });
      acc += moveMs + holdMs;
    }
    return { start: start, stops: stops, total: acc };
  }

  Wheel.prototype.spinTo = function (rankId, opts) {
    opts = opts || {};
    var duration = opts.duration || 4500;
    // suspense: ラチェットの歩数と溜めを増やして «あと少し» を長く取る。1等のときだけ使う
    var suspense = !!opts.suspense;
    var onTick = typeof opts.onTick === "function" ? opts.onTick : function () {};
    // ラチェットに入った瞬間（＝ドラムロールを止めるタイミング）
    var onRatchet = typeof opts.onRatchet === "function" ? opts.onRatchet : function () {};
    // 毎フレームの速度。画面の寄りとビネットに使う
    var onFrame = typeof opts.onFrame === "function" ? opts.onFrame : function () {};
    // ラチェット中に最上位等級の扇をかすめた（＝惜しい）瞬間
    var onNear = typeof opts.onNear === "function" ? opts.onNear : function () {};
    // 炸裂を保留する（1等：止まってから «間» を置いて外から burst() で起こす）
    var holdFlare = !!opts.holdFlare;
    var self = this;

    return new Promise(function (resolve) {
      try {
        var plan = self._planSpin(rankId);
        if (!plan) { resolve(); return; } // 空盤：演出せず終了

        var ratCount = suspense ? 8 : 5;
        var rat = buildRatchet(plan.endRotation, ratCount, suspense);
        // duration は «全体» の時間。ラチェットに使う分を引いた残りが滑走時間。
        // 滑走が短すぎると回った気がしないので、最低でも全体の 45% は残す
        var glideMs = Math.max(duration * 0.45, duration - rat.total);

        self._idle = false; // spinTo中はidleを無効化
        self._winSeg = null; // 前回の当たりの光を消す
        self._flareT = null; // 前回の炸裂も消す（残っていると回り始めに白く光る）
        self._pendingWin = null;
        self._nearT = null;
        self._nearSeg = null;
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
          glideMs: glideMs,
          glideDist: rat.start - plan.startRotation,
          // 滑走の終端速度をラチェット1歩目に合わせるための線形成分。
          // 0 だと滑走が完全に止まってからラチェットが動き出し、繋ぎ目が見える
          w: clamp(
                ((TAU / PEG_COUNT) / (rat.stops[0].dur / 1000)) * (glideMs / 1000)
                  / Math.max(1e-6, rat.start - plan.startRotation),
                0.01, 0.3),
          rat: rat,
          holdFlare: holdFlare,
          ratchetFired: false,
          nearArmed: false,  // ニアミス判定に入ったか（入った最初のフレームでは発火させない）
          prevFocus: null,   // 直前に指針の下にあった扇。同じ扇で連続発火させない
          onTick: onTick,
          onRatchet: onRatchet,
          onFrame: onFrame,
          onNear: onNear,
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

  // 保留していた炸裂を起こす（1等の «時間が止まる» 明け）。
  // 保留していなければ何もしない＝通常の等級で二重に呼ばれても安全。
  Wheel.prototype.burst = function () {
    if (!this._pendingWin) return false;
    this._winSeg = this._pendingWin;
    this._pendingWin = null;
    this._flareT = Date.now();
    this._ensureLoop();
    return true;
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
    // 90Hz 端末（Redmi Pad 2）では1フレームの進み幅が 60Hz の 2/3 になる。
    // 残像や速度をフレーム単位で測ると端末ごとに見え方が変わるので、秒あたりに直す
    this._dt = dt > 0 ? dt : (1 / 60);

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
      this._omega = 0;
      if (this._idle) {
        this.rotation += IDLE_SPEED * dt;
        try { this.render(); } catch (e) { /* 描画失敗は無視して継続 */ }
      } else if (glowing || this._flareT != null || this._nearT != null) {
        try { this.render(); } catch (e) {}
      }
    }

    // 静止中はrAFを止めてCPU/バッテリーを食わないようにする
    // （_flareT は render の中で炸裂が終わると null に戻る）
    if (this.isSpinning || this._idle || glowing
        || this._flareT != null || this._nearT != null) {
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
    this._nearT = null;
    this._nearSeg = null;
    this._dRot = 0;
    this._speed01 = 0;
    this._omega = 0;
    if (sp.holdFlare) {
      this._pendingWin = sp.segment;   // burst() 待ち。app.js が必ず呼ぶ
    } else {
      this._winSeg = sp.segment;
      // 非常口から抜けた場合も炸裂は出す（rAF が死んでいれば描かれないだけ）
      this._flareT = Date.now();
    }
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

    var elapsed = ts - sp.startTs;
    var prevRotation = this.rotation;
    var fired = [];
    var nearFired = false;
    var tickSpeed = 0;
    var done = false;

    // ラチェットに入った瞬間を1度だけ知らせる。ここでドラムロールを止めて無音にする
    if (!sp.ratchetFired && elapsed >= sp.glideMs) {
      sp.ratchetFired = true;
      try { sp.onRatchet(); } catch (e0) { /* 外側の例外で演出を止めない */ }
    }

    if (elapsed < sp.glideMs) {
      // ---- 第1相：滑走 ----
      // 素の easeOutCubic は t=1 で速度が 0 になる。そのまま繋ぐと
      // 「一度止まってから、また動き出す」ように見えるので、
      // 終端の速度がラチェット1歩目の速度と揃うよう、線形成分を w だけ混ぜる。
      var t = elapsed / sp.glideMs;
      var eased = (1 - Math.pow(1 - t, 3)) * (1 - sp.w) + t * sp.w;
      this.rotation = sp.startRotation + (sp.glideDist * eased);
      tickSpeed = Math.pow(1 - t, 2);
      var crossings = this._countCrossings(prevRotation, this.rotation);
      if (crossings > 0) {
        var calls = Math.min(crossings, 5); // 高速時に音が割れないよう1フレーム最大5回
        for (var i = 0; i < calls; i++) fired.push({ speed: tickSpeed, i: -1, n: 0 });
      }
    } else {
      // ---- 第2相：ラチェット ----
      // カチは «1歩を動き終えた瞬間» に1回だけ鳴らす。目盛りの通過数から数えると
      // 浮動小数の丸めで鳴り漏れ・二度鳴りが出るので、ここでは数えない。
      var e = elapsed - sp.glideMs;
      var stops = sp.rat.stops;
      var from = sp.rat.start;
      var pos = from;
      for (var j = 0; j < stops.length; j++) {
        var s = stops[j];
        if (e >= s.at + s.dur) {
          from = s.rot;
          pos = s.rot;
          if (!s.fired) { s.fired = true; fired.push({ speed: 0.02, i: j, n: stops.length }); }
          continue;
        }
        if (e >= s.at) {
          var u = (e - s.at) / s.dur;
          pos = from + (s.rot - from) * (1 - Math.pow(1 - u, 2.4));
        } else {
          pos = from;   // 溜めの最中。動かさない
        }
        break;
      }
      this.rotation = pos;
      tickSpeed = 0.02;
      done = e >= sp.rat.total;
    }

    this._dRot = this.rotation - prevRotation;
    // 角速度。フレーム数ではなく秒で測る（90Hz 端末でも同じ見え方にするため）
    this._omega = Math.abs(this._dRot) / Math.max(1e-4, this._dt);
    this._speed01 = clamp(this._omega / PEAK_OMEGA, 0, 1);

    // ---- ニアミス（«惜しい»）----
    // 十分に減速してから、指針が最上位等級の扇へ «入った» 瞬間だけ光らせる。
    // 6割が3等で終わるこのアプリでは、これが唯一 «外れた人» の体験を底上げできる手。
    //
    // ラチェットの中だけで判定してはいけない。ラチェットの移動幅は 5歩×5°＝25° しかなく、
    // 扇1枚（18〜37°）より狭い。実測で 3等で止まる回の発火は平均 0.18 回しかなかった。
    // 滑走の終盤まで広げると、止まるまでの残り 150〜190° で1〜2回かすめる。
    //
    // 停止位置そのもの（sp.segment）では出さない。当たりの白熱と混ざって読めなくなる。
    if (this._topRankId && this._speed01 < NEAR_SPEED) {
      var focus = this._segmentAt(this.rotation);
      if (!sp.nearArmed) {
        // 判定に入った最初のフレーム。すでに中にいる扇で誤発火させない
        sp.nearArmed = true;
        sp.prevFocus = focus;
      } else if (focus !== sp.prevFocus) {
        if (focus && focus !== sp.segment && focus.rankId === this._topRankId) {
          this._nearSeg = focus;
          this._nearT = Date.now();
          nearFired = true;
        }
        sp.prevFocus = focus;
      }
    }

    for (var f = 0; f < fired.length; f++) {
      try {
        sp.onTick(fired[f].speed, fired[f].i >= 0 ? fired[f] : null);
      } catch (e2) { /* onTick側の例外で抽選演出を止めない */ }
    }
    if (nearFired) { try { sp.onNear(); } catch (e6) {} }
    try { sp.onFrame(this._speed01); } catch (e5) {}

    try { this.render(); } catch (e3) { /* 描画失敗は無視して継続 */ }

    if (done) {
      this.rotation = sp.endRotation; // 誤差を消して確実にターゲットへ止める
      this.isSpinning = false;
      this._spin = null;
      this._dRot = 0;
      this._speed01 = 0;
      this._omega = 0;
      if (sp.holdFlare) {
        // 1等：ここでは何も起こさない。盤は止まったまま «固まる»。
        // 当たりの扇も光らせない（光らせると答えが先に出てしまう）
        this._pendingWin = sp.segment;
      } else {
        this._winSeg = sp.segment;    // 停止後に光らせる扇
        this._flareT = Date.now();    // ここから FLARE_MS かけて炸裂が収まる
        this._ensureLoop();           // 炸裂を描くためにループを起こし直す
      }
      try { this.render(); } catch (e4) {}
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
  // 回転のピーク角速度の目安[rad/s]。_speed01 はこれで正規化する。
  // フレーム数ではなく秒で測るので、60Hz でも 90Hz（Redmi Pad 2）でも同じ見え方になる
  var PEAK_OMEGA = 33;

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
    // 残像の幅は «60Hz 1フレームぶんに相当する角度»。実フレームレートで割り戻すことで、
    // 90Hz 端末でも 60Hz 端末でも同じだけ滲む
    var blur = this._reducedMotion ? 0 : Math.min((this._omega || 0) / 60, 0.62);
    var ghosts = blur > 0.02 ? Math.min(9, Math.round(blur * 18)) : 0;
    // 古い残像から順に半透明で重ね、最後の «現在位置» も透かして置く。
    // ここを不透明にすると盤面全体を覆ってしまい、残像が1枚も見えなくなる。
    for (var g = ghosts; g >= 1; g--) {
      ctx.save();
      ctx.globalAlpha = 0.30;
      ctx.rotate(this.rotation - blur * (g / ghosts));
      this._drawFace(ctx, segments, radius, true);   // 残像に境界線は要らない（負荷も半減する）
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = ghosts ? 0.62 : 1;
    ctx.rotate(this.rotation);
    this._drawFace(ctx, segments, radius);
    ctx.restore();

    // ---- 回転しない層 ----
    // 停止しても、炸裂を保留している間（1等のフリーズ）は灯りを保つ。
    // ここで消すと «止まった瞬間に暗転して、340ms 後に爆発» になり、故障に見える
    if (this.isSpinning || this._pendingWin) {
      this._drawPointerFocus(ctx, radius, this.isSpinning ? speed : 0);
    }
    if (this._nearT != null) this._drawNearMiss(ctx, radius, outer);
    if (this._winSeg && !this.isSpinning) this._drawWinGlow(ctx, radius);
    this._drawRing(ctx, radius, outer, speed);
    // 特賞は幅3.6°で、遠目には «線» にしか見えない。外周に小さな菱形を置いて
    // «そこに何かある» ことを伝える。文字は入らない（MIN_LABEL_DEG=12 より細い）
    this._drawJackpotMark(ctx, radius, outer, speed);

    // 等級名。高速時は消す。読めないうえ、残っていると残像を濁らせる
    var labelAlpha = 1 - Math.min(1, speed * 1.7);
    if (labelAlpha > 0.03) {
      // 大きさは «いちばん細い扇に収まる寸法» に全体を揃える。
      // 扇ごとに変えると、同じ «1等 / 2等 / 3等» が大小まちまちになって散らかる
      var size = this._labelSize(segments, radius);
      if (size > 0) {
        ctx.save();
        ctx.globalAlpha = labelAlpha;
        for (var l = 0; l < segments.length; l++) {
          this._drawLabel(ctx, segments[l], radius, this.rotation, size);
        }
        ctx.restore();
      }
    }

    this._drawHub(ctx, cache);
    if (this._flareT != null) this._drawFlare(ctx, radius, outer, maxR);

    ctx.restore();
  };

  // 盤面。ベタ塗りの扇と、境目の細い暗線だけ。
  // ghost=true のときは境界線を省く（残像では見えないうえ、線が枚数ぶん増えて重い）
  Wheel.prototype._drawFace = function (ctx, segments, radius, ghost) {
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
    if (ghost || segments.length < 2) return;
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

  // 減速してきたら、いま指針の下にある扇を光らせる。
  //
  // 「どこを通っているか」が見えると、1等の扇を通り過ぎるたびに来場者が反応する。
  // 確率はいじっていない。単に現在位置を表示しているだけ。
  // 速いうちは出さない（点滅にしか見えず、残像も濁る）。
  Wheel.prototype._drawPointerFocus = function (ctx, radius, speed) {
    if (this._reducedMotion) return;
    var t = 1 - Math.min(1, speed / 0.30);   // 0.30 を切ってから効き始める
    if (t <= 0.02) return;

    var a = ((-this.rotation % TAU) + TAU) % TAU;   // 12時の指針が指している盤上の角度
    var seg = null;
    for (var i = 0; i < this.segments.length; i++) {
      var s = this.segments[i];
      if (a >= s.start && a < s.end) { seg = s; break; }
    }
    if (!seg) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius,
      seg.start + this.rotation - Math.PI / 2,
      seg.end + this.rotation - Math.PI / 2, false);
    ctx.closePath();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "rgba(255,246,222," + (0.20 * t * t).toFixed(3) + ")";
    ctx.fill();
    ctx.restore();
  };

  // 特賞の目印。外周に小さな菱形を1つ。高速時は消す（残っても点滅にしか見えない）
  Wheel.prototype._drawJackpotMark = function (ctx, radius, outer, speed) {
    var seg = null;
    for (var i = 0; i < this.segments.length; i++) {
      if (this.segments[i].rank && this.segments[i].rank.jackpot) { seg = this.segments[i]; break; }
    }
    if (!seg) return;
    var alpha = 1 - Math.min(1, (speed || 0) * 1.6);
    if (alpha <= 0.03) return;

    var mid = (seg.start + seg.end) / 2 + this.rotation - Math.PI / 2;
    var band = outer - radius;
    var rr = radius + band / 2;
    var d = band * 1.7;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(Math.cos(mid) * rr, Math.sin(mid) * rr);
    ctx.rotate(mid + Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -d);
    ctx.lineTo(d * 0.62, 0);
    ctx.lineTo(0, d);
    ctx.lineTo(-d * 0.62, 0);
    ctx.closePath();
    ctx.fillStyle = seg.soldOut ? "rgba(150,140,118,0.55)" : "#FFF3CF";
    ctx.fill();
    ctx.restore();
  };

  // ニアミス。ラチェット中に最上位等級の扇をかすめたときだけ、その扇を金で焼く。
  // «いま1等の上を通った» が見えると、外れても «惜しかった» が残る。
  // 確率には一切触れていない。単に現在位置を強調しているだけ。
  var NEAR_MS = 380;
  // ニアミスを出し始める体感速度。0.20 ＝ およそ 380°/s。
  // これ以上速いと «金色に光った» と分かる前に扇が通り過ぎる
  var NEAR_SPEED = 0.20;

  Wheel.prototype._drawNearMiss = function (ctx, radius, outer) {
    var seg = this._nearSeg;
    if (!seg) { this._nearT = null; return; }
    var p = (Date.now() - this._nearT) / NEAR_MS;
    if (!(p >= 0)) p = 0;
    if (p >= 1) { this._nearT = null; this._nearSeg = null; return; }
    var inv = 1 - p;
    var a0 = seg.start + this.rotation - Math.PI / 2;
    var a1 = seg.end + this.rotation - Math.PI / 2;

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    // 扇そのものを金で満たす。白ではなく金にするのは、
    // 停止時の «白熱» と見分けが付かなくなるのを避けるため。
    //
    // 加算合成 (lighter) だけでは «青を引く» ことができない。
    // 1等の扇は紫（#7A5AA6）なので、金を足しても青が残ってピンクになる。
    // 先に不透明の金を薄く敷いて下地の紫を殺してから、加算で焼く。
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, a0, a1, false);
    ctx.closePath();
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgba(214,158,52," + (0.72 * inv).toFixed(3) + ")";
    ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "rgba(255,196,74," + (0.40 * inv * inv).toFixed(3) + ")";
    ctx.fill();

    // 外周の帯を太らせて外へ抜ける。遠目にはこちらの方が読める
    var band = outer - radius;
    ctx.beginPath();
    ctx.arc(0, 0, radius + band / 2, a0, a1, false);
    ctx.lineWidth = band * (1.1 + 1.8 * p);
    ctx.strokeStyle = "rgba(255,238,182," + (0.80 * inv).toFixed(3) + ")";
    ctx.stroke();

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

  // 全ての扇に共通の文字サイズ。いちばん細い扇に合わせる
  Wheel.prototype._labelSize = function (segments, radius) {
    var size = clamp(radius * 0.165, 13, 78);
    var found = false;
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (!seg.rank || !seg.rank.label) continue;
      var widthRad = seg.end - seg.start;
      if ((widthRad / TAU) * 360 < MIN_LABEL_DEG) continue;   // ここは元から描かない
      var arcSpace = widthRad * radius * 0.66 * 0.8;
      var fit = arcSpace / Math.max(1, String(seg.rank.label).length) * 1.3;
      if (fit < size) size = fit;
      found = true;
    }
    return (found && size >= 13) ? size : 0;
  };

  Wheel.prototype._drawLabel = function (ctx, seg, radius, rotation, size) {
    if (!seg.rank || !seg.rank.label) return;
    var widthRad = seg.end - seg.start;
    if ((widthRad / TAU) * 360 < MIN_LABEL_DEG) return;

    var label = String(seg.rank.label);
    var mid = (seg.start + seg.end) / 2 + rotation - Math.PI / 2;
    var labelR = radius * 0.66;
    if (!(size > 0)) return;

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
    module.exports = {
      buildSegments: buildSegments, desaturate: desaturate
    };
  }
})();
