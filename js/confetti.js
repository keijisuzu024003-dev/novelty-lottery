// js/confetti.js
// 結果発表を華やかに見せる紙吹雪。canvas 2D のみで実装し、外部ライブラリは使わない。
// Android タブレットでの 60fps 維持を最優先し、パーティクル数に上限を設ける。
// ------------------------------------------------------------
window.NV = window.NV || {};

(function () {
  "use strict";

  var GOLD = ["#FFD97A", "#FFC93C", "#F5A623"];
  var RED = ["#FF5C5C", "#D93A3A", "#FFD97A"]; // 赤系＋金
  var BLUE = ["#3FA9F5", "#1E7FD4", "#FFFFFF"]; // 青系＋白

  var GRAVITY = 900; // px/sec^2
  var DRAG = 0.55;   // 空気抵抗（速度に比例して減速）
  var MAX_DPR = 2;   // 高DPR端末での過剰負荷を防ぐ上限

  var canvas = null;
  var cx = null;
  var particles = [];
  var rafId = null;
  var lastT = 0;
  var dpr = 1;
  var cssW = 0, cssH = 0;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

  // ---- canvas サイズ管理 -------------------------------------------------

  function resize() {
    if (!canvas) return;
    try {
      dpr = clamp(window.devicePixelRatio || 1, 1, MAX_DPR);
      cssW = canvas.clientWidth || window.innerWidth;
      cssH = canvas.clientHeight || window.innerHeight;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      if (cx) cx.setTransform(dpr, 0, 0, dpr, 0, 0);
    } catch (e) {}
  }

  function attach(canvasElement) {
    try {
      canvas = canvasElement;
      cx = canvas.getContext("2d");
      resize();
      window.addEventListener("resize", resize);
      // 端末回転時は resize イベントが来ない場合があるため orientationchange も拾う
      window.addEventListener("orientationchange", function () {
        // レイアウト確定後にサイズを取り直す
        setTimeout(resize, 200);
      });
    } catch (e) {
      canvas = null;
      cx = null;
    }
  }

  // ---- パーティクル生成 ---------------------------------------------------

  // 1個ぶんのパーティクルを作る。原点(x,y)から速度(vx,vy)で発射。
  function makeParticle(x, y, vx, vy, colors) {
    return {
      x: x, y: y, vx: vx, vy: vy,
      w: rand(6, 11),
      h: rand(10, 16),
      color: pick(colors),
      angle: rand(0, Math.PI * 2),
      spin: rand(-8, 8),      // 自転速度(rad/sec)
      spinPhase: rand(0, Math.PI * 2),
      life: 0,
      maxLife: rand(2.6, 4.2) // これを超えたら寿命切れ扱い(画面外判定の保険)
    };
  }

  // レベルごとの個数上限。Androidタブレットで60fpsを割らないための目安値。
  var LEVEL_COUNT = { 1: 220, 2: 120, 3: 60 };
  var LEVEL_COLORS = { 1: GOLD, 2: RED, 3: BLUE };
  // burst の多重呼び出しでパーティクル総数が暴走しないための絶対上限
  var HARD_CAP = 500;

  function burst(level) {
    try {
      if (!canvas || !cx) return;
      var n = LEVEL_COUNT[level] || LEVEL_COUNT[3];
      var colors = LEVEL_COLORS[level] || LEVEL_COLORS[3];

      var room = HARD_CAP - particles.length;
      if (room <= 0) return; // 既に上限。追加しない(暴走防止)
      n = Math.min(n, room);

      var half = n / 2;
      var cannonCount = Math.round(half * 0.6); // キャノン（下から2箇所）
      var rainCount = n - cannonCount;           // 上から降らせる分

      var i;
      // キャノン: 画面下の左右2箇所から斜め上へ
      for (i = 0; i < cannonCount; i++) {
        var fromLeft = i % 2 === 0;
        var ox = fromLeft ? cssW * rand(0.02, 0.12) : cssW * rand(0.88, 0.98);
        var oy = cssH * rand(0.92, 1.0);
        var dir = fromLeft ? 1 : -1; // 左からは右上へ、右からは左上へ
        var speed = rand(420, 780);
        var ang = rand(-0.35, -0.15) + (fromLeft ? 0 : Math.PI); // 上方向基準の角度
        var vx = dir * speed * rand(0.5, 0.9);
        var vy = -speed;
        particles.push(makeParticle(ox, oy, vx, vy, colors));
      }
      // 雨: 画面上からランダムに降らせる
      for (i = 0; i < rainCount; i++) {
        var rx = rand(0, cssW);
        var ry = -rand(0, cssH * 0.3);
        var rvx = rand(-60, 60);
        var rvy = rand(20, 120);
        particles.push(makeParticle(rx, ry, rvx, rvy, colors));
      }

      startLoop();
    } catch (e) {}
  }

  function stop() {
    try {
      particles = [];
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (cx && canvas) {
        cx.clearRect(0, 0, cssW, cssH);
      }
    } catch (e) {}
  }

  // ---- アニメーションループ ------------------------------------------------

  function startLoop() {
    if (rafId != null) return; // 既に回っている
    lastT = 0;
    rafId = requestAnimationFrame(step);
  }

  function step(t) {
    try {
      if (!cx || !canvas) { rafId = null; return; }
      if (!lastT) lastT = t;
      var dt = Math.min(0.04, (t - lastT) / 1000); // タブ切替直後の巨大dtを防ぐ
      lastT = t;

      cx.clearRect(0, 0, cssW, cssH);

      var alive = [];
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.life += dt;

        // 空気抵抗（速度に比例した減速）＋重力
        p.vx -= p.vx * DRAG * dt;
        p.vy -= p.vy * DRAG * dt;
        p.vy += GRAVITY * dt;

        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.angle += p.spin * dt;
        p.spinPhase += p.spin * dt * 1.3;

        var offscreen = p.y > cssH + 40 || p.x < -60 || p.x > cssW + 60 || p.life > p.maxLife;
        if (!offscreen) {
          drawParticle(p);
          alive.push(p);
        }
      }
      particles = alive;

      if (particles.length > 0) {
        rafId = requestAnimationFrame(step);
      } else {
        // 全滅したら自動停止してCPUを空ける
        rafId = null;
        cx.clearRect(0, 0, cssW, cssH);
      }
    } catch (e) {
      // 描画中の例外でループが壊れて延々エラーを吐き続けないよう、ここで止める
      rafId = null;
    }
  }

  // 紙片1枚を描く。自転で幅が潰れる表現(scale(1,cos))を入れ、ただの矩形回転に見せない。
  function drawParticle(p) {
    var squash = Math.cos(p.spinPhase); // -1..1
    cx.save();
    cx.translate(p.x, p.y);
    cx.rotate(p.angle);
    cx.scale(1, squash === 0 ? 0.001 : squash); // 0で潰れきって消えるのを避ける
    cx.fillStyle = p.color;
    cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    cx.restore();
  }

  window.NV.confetti = {
    attach: attach,
    burst: burst,
    stop: stop
  };
})();
