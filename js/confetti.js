// js/confetti.js
// 結果発表を華やかに見せる紙吹雪。canvas 2D のみで実装し、外部ライブラリは使わない。
// Android タブレットでの 60fps 維持を最優先し、パーティクル数に上限を設ける。
// ------------------------------------------------------------
window.NV = window.NV || {};

(function () {
  "use strict";

  // 円盤の扇（深紫・深緋・縹）と真鍮に合わせる。原色の赤青は盤から浮く
  var GOLD = ["#F2DFAD", "#FFD97A", "#C9A24B", "#FFFFFF"];
  var RED = ["#E39184", "#9E3129", "#F2DFAD"];
  var BLUE = ["#7FA8C9", "#2A5375", "#EFE7D6"];

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

  // 1個ぶんの紙片を作る。原点(x,y)から速度(vx,vy)で発射。
  function makeParticle(x, y, vx, vy, colors) {
    return {
      kind: 0,                // 0=紙片
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

  // 金テープ1本。紙片との違いは «長い・軽い・ゆっくり落ちる・くねる» の4点。
  // 落下が遅いぶん画面に長く残り、枚数の割に «多い» と感じる。
  function makeRibbon(x, y, vx, vy, colors) {
    return {
      kind: 1,                // 1=テープ
      x: x, y: y, vx: vx, vy: vy,
      w: rand(4.5, 8),        // 帯の太さ
      h: rand(95, 195),       // 帯の長さ。短いと «小枝» になる
      wave: rand(10, 22),     // くねりの振幅[px]。実際の振幅は速度で割り引く（drawRibbon）
      color: pick(colors),
      angle: 0,               // 毎フレーム «飛んでいる向き» から作り直す
      tilt: rand(-0.3, 0.3),  // 向きに対する固定のずれ
      spin: rand(1.6, 3.2),   // くねりの速さ(rad/sec)
      spinPhase: rand(0, Math.PI * 2),
      life: 0,
      maxLife: rand(4.2, 6.2)
    };
  }

  // レベルごとの個数上限。Androidタブレットで60fpsを割らないための目安値。
  // 1等はテープを混ぜるぶん紙片を減らす。総描画量を増やさずに «濃く» する
  var LEVEL_COUNT = { 1: 320, 2: 210, 3: 120 };
  var LEVEL_RIBBONS = { 1: 34, 2: 12, 3: 0 };
  var LEVEL_COLORS = { 1: GOLD, 2: RED, 3: BLUE };
  // burst の多重呼び出しでパーティクル総数が暴走しないための絶対上限
  var HARD_CAP = 760;

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
        var speed = rand(560, 1020);
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

      // 金テープ
      var rib = LEVEL_RIBBONS[level] || 0;
      if (rib > 0) pushRibbons(Math.min(rib, HARD_CAP - particles.length), colors);

      startLoop();
    } catch (e) {}
  }

  // テープを撒く。下の両端から打ち上げるだけだと «2本の帯» になって真ん中が空くので、
  // 3本に1本は上から降らせる。打ち上げ角も広めに散らす
  function pushRibbons(n, colors) {
    for (var i = 0; i < n; i++) {
      if (i % 3 === 2) {
        // 上から降ってくる分。画面の中央付近を埋める
        particles.push(makeRibbon(
          rand(cssW * 0.08, cssW * 0.92), -rand(20, cssH * 0.45),
          rand(-90, 90), rand(40, 190), colors));
        continue;
      }
      var fromLeft = i % 2 === 0;
      var ox = fromLeft ? cssW * rand(0.00, 0.22) : cssW * rand(0.78, 1.00);
      var oy = cssH * rand(0.94, 1.02);
      var speed = rand(720, 1260);
      // 0.25〜1.15 ＝ 鉛直から 14〜49度。狭いと «レーザー» のように筋が揃う
      var vx = (fromLeft ? 1 : -1) * speed * rand(0.25, 1.15);
      particles.push(makeRibbon(ox, oy, vx, -speed, colors));
    }
  }

  // 二撃目のテープだけを撃つ（1等の三段炸裂で使う）。紙片は足さない
  function streamers(n) {
    try {
      if (!canvas || !cx) return;
      var room = HARD_CAP - particles.length;
      if (room <= 0) return;
      pushRibbons(Math.min(n || 24, room), GOLD);
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

        // 空気抵抗（速度に比例した減速）＋重力。
        // テープは面積が大きく軽いので、抵抗を強く・重力を弱くする
        // テープは面積が大きく軽い。ただし抵抗を効かせすぎると空中で止まって «貼り付く»
        var drag = p.kind === 1 ? DRAG * 1.25 : DRAG;
        var grav = p.kind === 1 ? GRAVITY * 0.55 : GRAVITY;
        p.vx -= p.vx * drag * dt;
        p.vy -= p.vy * drag * dt;
        p.vy += grav * dt;

        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.spinPhase += p.spin * dt * (p.kind === 1 ? 1 : 1.3);
        if (p.kind === 1) {
          // くねりに合わせて横へ流す。まっすぐ落ちると «棒» に見える
          p.x += Math.sin(p.spinPhase) * 34 * dt;
          // 長辺を «飛んでいる向き» に沿わせる。打ち上げ中は軌跡に沿って伸び、
          // 落下に移ると自然に垂れ下がる。これが無いと空中で向きが散らかって小枝に見える
          var sp2 = Math.abs(p.vx) + Math.abs(p.vy);
          if (sp2 > 30) { p.angle = Math.atan2(p.vy, p.vx) - Math.PI / 2 + p.tilt; }
        } else {
          p.angle += p.spin * dt;
        }

        var margin = p.kind === 1 ? 140 : 40;
        var offscreen = p.y > cssH + margin || p.x < -160 || p.x > cssW + 160
          || p.life > p.maxLife;
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

  function drawParticle(p) {
    if (p.kind === 1) { drawRibbon(p); return; }
    drawChip(p);
  }

  // 金テープ1本。sin でくねらせた折れ線を太く描く。
  // 単なる細長い矩形にすると «棒» になり、テープに見えない
  function drawRibbon(p) {
    var seg = 9;
    var half = p.h / 2;
    // 打ち上げ中は張力で真っ直ぐ伸び、落下に移るとカールする。
    // 速度で割り引かないと、落ちてもずっと «棒» のままになる
    var v = Math.abs(p.vx) + Math.abs(p.vy);
    var curl = p.wave * Math.min(1, 320 / (v + 60));
    cx.save();
    cx.translate(p.x, p.y);
    cx.rotate(p.angle + Math.sin(p.spinPhase) * 0.22);
    cx.strokeStyle = p.color;
    cx.lineWidth = p.w;
    cx.lineJoin = "round";
    cx.beginPath();
    for (var i = 0; i <= seg; i++) {
      var u = i / seg;
      var y = -half + p.h * u;
      // 帯1本ぶんで «1波弱» 曲げる。分割数を増やしてあるので折れずに S 字になる
      var x = Math.sin(p.spinPhase + u * 3.3) * curl;
      if (i === 0) cx.moveTo(x, y); else cx.lineTo(x, y);
    }
    cx.stroke();
    cx.restore();
  }

  // 紙片1枚を描く。自転で幅が潰れる表現(scale(1,cos))を入れ、ただの矩形回転に見せない。
  function drawChip(p) {
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
    streamers: streamers,
    stop: stop
  };
})();
