window.NV = window.NV || {};

// 状態機械本体。DOM の書き換えは data-state の切り替えだけに寄せ、
// 実際の見た目の出し分けは app.css 側の属性セレクタに任せる。
(function(){
  'use strict';

  var state = null;
  var wheel = null;

  // 二重発火ガード。spinning〜result の間、別の操作経路（キー/タップ/ボタン）から
  // startSpin が呼ばれても無視するための保険（data-state のチェックだけでも大半は防げるが、
  // 展示会当日の連打事故を最優先で避けるため二重にしておく）。
  var isBusy = false;

  var autoAdvanceTimer = null;
  var resizeDebounceTimer = null;
  var longPressTimer = null;
  var wakeLockSentinel = null;

  var LONG_PRESS_MS = 1500;
  var SPIN_DURATION_MS = 4500;
  // ボーナス盤（1個 / 2個 / 3個）。本編より短く回す。
  // 同じ長さで回すと «おまけ» が本編と同じ重さになり、全体が間延びする
  var BONUS_DURATION_MS = 2600;
  var BONUS_REVEAL_MS = 700;
  // 炸裂の直後は来場者の指がまだ動いている。選択画面を出してすぐは触らせない
  var CHOOSE_ARM_MS = 450;
  // 止まってから結果の幕を降ろすまでの «間»。
  // 0 にすると炸裂も衝撃波も幕の裏に隠れて、演出が丸ごと無駄になる
  var RESULT_DELAY_MS = 520;
  // 1等は «一撃 → 二撃 → 幕» の三段にする。二撃目のぶん幕を遅らせる。
  // 全部を同じフレームで撃つと «一瞬で終わった» になり、盛り上がりが立ち上がる前に幕が来る
  var SECOND_WAVE_MS = 300;
  var RESULT_DELAY_TOP = 880;
  var secondWaveTimer = null;
  var resultRevealTimer = null;
  // 1等だけ、止まってから «何も起こらない» 時間を挟む。
  // 音も画も完全に止め、上昇音だけを鳴らしてから炸裂させる。
  // これが «えっ……» の一拍になる。0 にすると当たりがただ «起きる» だけになる
  var FREEZE_MS = 340;
  // 特賞はさらに長く止める。1%の一撃なので、ここだけは間延びを恐れなくていい
  var FREEZE_TOP_MS = 480;
  var freezeTimer = null;

  var el = {};

  // 1回ぶんの抽選。等級が決まってから、品目を選び終えるまでを持つ。
  //   { rankId, rankLabel, rank0, jackpot, need, picked: [item...] }
  // 【重要】品目が決まるまで在庫は減らさない。減らすのは commitItem を呼ぶ瞬間だけ
  var round = null;

  // ボーナス盤。1個 / 2個 / 3個 を 120° ずつ。3個だけ特賞と同じ金にして «上がり» を示す
  var BONUS_RANKS = [
    { id: 'b1', label: '1個', weight: 1, noStock: true, items: [],
      color: '#2A5375', colorDark: '#101F2D' },
    { id: 'b2', label: '2個', weight: 1, noStock: true, items: [],
      color: '#9E3129', colorDark: '#4A1310' },
    { id: 'b3', label: '3個', weight: 1, noStock: true, items: [],
      color: '#F2C230', colorDark: '#8A6A12' }
  ];

  var prefersReducedMotion = false;
  try {
    prefersReducedMotion = !!(window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {}

  function cacheEls(){
    el.body = document.body;
    el.stage = document.getElementById('stage');
    el.panel = document.getElementById('panel');
    el.btnStart = document.getElementById('btn-start');
    el.btnNext = document.getElementById('btn-next');
    el.overlayBoot = document.getElementById('overlay-boot');
    el.overlayResult = document.getElementById('overlay-result');
    el.resultRank = document.getElementById('result-rank');
    el.resultItem = document.getElementById('result-item');
    el.resultNote = document.getElementById('result-note');
    el.btnClose = document.getElementById('btn-close');
    el.overlayJackpot = document.getElementById('overlay-jackpot');
    el.btnBonus = document.getElementById('btn-bonus');
    el.overlayChoose = document.getElementById('overlay-choose');
    el.chooseHead = document.getElementById('choose-head');
    el.chooseSub = document.getElementById('choose-sub');
    el.chooseGrid = document.getElementById('choose-grid');
    el.chooseBar = document.getElementById('choose-bar');
    el.resultList = document.getElementById('result-list');
    el.rays = document.getElementById('rays');
    el.dust = document.getElementById('dust');
    el.edge = document.getElementById('edge');
    el.ticker = document.getElementById('ticker');
    el.tickerTrack = document.getElementById('ticker-track');
    el.resultPlate = document.getElementById('result-plate');
    el.resultImg = document.getElementById('result-img');
    el.btnReopen = document.getElementById('btn-reopen');
    el.pointer = document.getElementById('pointer');
    el.cornerHotspot = document.getElementById('corner-hotspot');
    el.wheelCanvas = document.getElementById('wheel-canvas');
    el.confettiCanvas = document.getElementById('confetti-canvas');
    el.flash = document.getElementById('flash');
  }

  // data-state の切り替えをここに一本化する。btn-start の disabled も
  // ここで一括管理しておけば、遷移経路が増えても付け忘れが起きない。
  function setState(name){
    el.body.dataset.state = name;
    if (el.btnStart) {
      el.btnStart.disabled = (name === 'spinning');
    }
    // 在庫が尽きた品目を帯から外す。作り直すと流れが頭に戻るので、
    // 並びが変わったときだけ組み直す（buildTicker の中で判定している）
    if (name === 'idle') { buildTicker(); }
    if (name !== 'choosing') { clearChooseTimer(); }
    syncRays();
  }

  function clearAutoAdvance(){
    if (autoAdvanceTimer) {
      clearTimeout(autoAdvanceTimer);
      autoAdvanceTimer = null;
    }
  }

  // ---------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------

  function start(){
    cacheEls();

    try {
      state = NV.storage.load();
    } catch (e) {
      console.warn('[NV.app] state load に失敗。既定値で継続します', e);
      state = NV.defaults.makeState();
    }
    if (!state) {
      state = NV.defaults.makeState();
    }

    try {
      wheel = new NV.Wheel(el.wheelCanvas);
      wheel.setRanks(state.ranks);
      wheel.resize();
      // canvas は CSS の @font-face を待ってくれない。明朝が届く前に描くと
      // 円盤の等級名だけ端末標準フォントのまま残るので、読み込み完了で描き直す
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(function(){
          try { wheel.render(); } catch (e) {}
        })['catch'](function(){});
      }
      wheel.idle(true);
    } catch (e) {
      // 円盤が描けなくても抽選ロジック自体は進められるようにしておく（当日落ちない優先）
      console.warn('[NV.app] wheel 初期化に失敗', e);
    }

    try {
      NV.confetti.attach(el.confettiCanvas);
    } catch (e) {
      console.warn('[NV.app] confetti 初期化に失敗', e);
    }

    try {
      if (state.settings) {
        // 音量を先に入れてから ON/OFF（どちらも同じゲインに落ちる）
        NV.sound.setVolume(state.settings.volume == null ? 1 : state.settings.volume);
        NV.sound.setEnabled(!!state.settings.soundOn);
      }
    } catch (e) {}
    applyBrightMode();
    buildDust();
    updateRayScale();

    bindEvents();
    requestWakeLock();
    registerServiceWorker();

    setState('boot');
  }

  // 起動画面のタップ。Android の自動再生ポリシー対策で、
  // AudioContext の生成・resume はここで同期的に呼ぶ（非同期処理を挟むとユーザー操作扱いされない）。
  function handleBootTap(){
    try { NV.sound.init(); } catch (e) {}
    try {
      var p = NV.sound.resume();
      if (p && typeof p.then === 'function') {
        p.catch(function(){});
      }
    } catch (e) {}

    goIdleOrFinished();
  }

  function goIdleOrFinished(){
    isBusy = false;
    round = null;
    clearResultReveal();
    clearFreeze();
    clearSecondWave();
    clearChooseTimer();
    if (el.body) { el.body.classList.remove('multi'); }
    el.body.classList.remove('tensing', 'freeze');
    resetTension();  // CSS のトランジションでゆっくり引く
    // 在庫0になった等級を円盤から外す。停止直後にやると setRanks が
    // 当たりの扇の参照を捨ててしまい、光も炸裂も途中で消える
    try { wheel.setRanks(state.ranks); } catch (e) {}
    var finished = false;
    try { finished = NV.lottery.isFinished(state); } catch (e) {}
    setState(finished ? 'finished' : 'idle');
  }

  // ---------------------------------------------------------------
  // スタート〜結果表示
  // ---------------------------------------------------------------

  function startSpin(){
    if (isBusy) { return; }
    if (el.body.dataset.state !== 'idle') { return; }

    var drawn = null;
    try {
      drawn = NV.lottery.draw(state);
    } catch (e) {
      console.warn('[NV.app] draw に失敗', e);
    }
    var result = drawn;

    if (!result) {
      // 在庫切れ（あるいは何らかの異常）は抽選を止めて終了画面へ
      setState('finished');
      return;
    }

    isBusy = true;
    clearAutoAdvance();
    clearFreeze();
    setState('spinning');
    // 回転中は毎フレーム JS が値を書くので、CSS のトランジションを切っておく
    el.body.classList.add('tensing');
    resetTension();

    try { NV.sound.whoosh(); } catch (e) {}
    try { NV.sound.rollStart(); } catch (e) {}

    // 1回ぶんの記録をここで作る。品目はまだ決まっていない
    var rank0 = findRankIndex(result.rankId);
    round = {
      rankId: result.rankId,
      rankLabel: result.rankLabel,
      rank0: rank0,
      jackpot: !!result.jackpot,
      need: 1,
      picked: []
    };

    var spinPromise;
    // 特賞と1等は回転を長く取り、終盤を寝かせる。止まる寸前の「間」を作る
    var isTop = rank0 <= 1;
    try {
      spinPromise = wheel.spinTo(result.rankId, {
        suspense: isTop,
        duration: isTop ? Math.round(SPIN_DURATION_MS * 1.55) : SPIN_DURATION_MS,
        // 特賞・1等は止まっても炸裂させない。FREEZE_MS 置いてから burst() で起こす
        holdFlare: isTop,
        onTick: function(speed01, step){
          if (step) {
            // ラチェットの1歩。ドラムロールは止まっているので、この音だけが鳴る
            try { NV.sound.ratchetTick(step.i, step.n); } catch (e) {}
            bumpPointer(true);
          } else {
            try { NV.sound.tick(speed01); } catch (e) {}
            bumpPointer(false);
          }
        },
        // ラチェットに入ったらドラムロールを切る。
        // 最後の数クリックが «無音の中» に落ちることで、続く一撃の落差が最大になる
        onRatchet: function(){
          try { NV.sound.rollStop(); } catch (e) {}
        },
        // ニアミス（«惜しい»）。指針が1等の扇に入った歩だけ、高く澄んだ音を足す。
        // 6割が3等で終わるので、ここが «外れた人» の体験を支える唯一の仕掛けになる
        onNear: function(){
          try { NV.sound.nearTick(); } catch (e) {}
        },
        onFrame: feedTension
      });
    } catch (e) {
      console.warn('[NV.app] spinTo に失敗。演出なしで結果へ進みます', e);
      spinPromise = null;
    }

    // 見張りタイマー。requestAnimationFrame は端末側の事情（アプリの切り替え・画面消灯・
    // レンダラの停止）で止まることがあり、そうなると spinTo の Promise が解決されないまま
    // 「回転中」で固まってスタートボタンが押せなくなる。展示会で列ができている最中に
    // アプリ再起動は許容できないので、規定時間を過ぎたら強制的に終端へ飛ばして結果を出す。
    var settled = false;
    var watchdog = setTimeout(function(){
      if (settled) return;
      console.warn('[NV.app] 回転が時間内に終わりませんでした。強制的に結果へ進みます');
      var resolved = false;
      try {
        resolved = !!(wheel && wheel.finishNow && wheel.finishNow());
      } catch (e) { /* 下の直接呼び出しで拾う */ }
      if (!resolved && !settled) { settled = true; onSpinDone(result); }
    }, SPIN_DURATION_MS + 8000);

    Promise.resolve(spinPromise).then(function(){
      if (settled) return;
      settled = true; clearTimeout(watchdog);
      onSpinDone(result);
    }, function(e){
      if (settled) return;
      settled = true; clearTimeout(watchdog);
      console.warn('[NV.app] spin の Promise が reject されました', e);
      onSpinDone(result);
    });
  }

  function onSpinDone(result){
    // ラチェットで既に止めているが、見張りタイマー経由で来たときのための保険
    try { NV.sound.rollStop(); } catch (e) {}
    var rank0 = (round && round.rank0 != null) ? round.rank0 : findRankIndex(result.rankId);

    // 【在庫はここでは減らさない】品目を選ぶのは来場者。
    // 減るのは commitItem を呼ぶ瞬間だけ（選択画面 or 自動選択）。
    // 途中で «次の人へ» に進まれても、選ばれていない品目は減らないままになる。

    if (rank0 <= 1) {
      // --- 特賞と1等だけ：ここで «時間を止める» ---
      // 盤は止まったまま、当たりの扇も光らせない。上昇音だけが鳴り、盤へゆっくり寄る。
      // 何も起きない一拍があるから、次の一撃が «爆発» になる
      var ms = (rank0 === 0) ? FREEZE_TOP_MS : FREEZE_MS;
      el.body.classList.remove('tensing');
      el.body.classList.add('freeze');
      setZoom(zoom + 0.05);
      try { NV.sound.riser(ms); } catch (e) {}
      clearFreeze();
      freezeTimer = setTimeout(function(){
        freezeTimer = null;
        fireBurst(result, rank0);
      }, ms);
      return;
    }
    fireBurst(result, rank0);
  }

  // 炸裂。1等はこの手前に FREEZE_MS の «無» が入る
  function fireBurst(result, rank0){
    el.body.classList.remove('freeze', 'tensing');
    // 炸裂で «引く»。寄り続けたカメラが弾かれる感じを作る（700ms かけて戻る）
    setZoom(1.055);
    // 一撃は画より先に。ここで数ミリ遅れると «ズレた» と感じる
    try { NV.sound.impact(IMPACT[rank0] != null ? IMPACT[rank0] : 0.62); } catch (e) {}
    impactShake();
    try { wheel.burst(); } catch (e) {}                 // 保留していた炸裂（特賞・1等）
    flashOnce(rank0);                                   // 閃光は3等にも。差は強さで付ける
    try { NV.confetti.burst(rank0); } catch (e) {}
    // ファンファーレは3段しかない。特賞は1等と同じ «いちばん長いやつ» を使う
    try { NV.sound.fanfare(Math.max(0, rank0 - 1)); } catch (e) {}
    if (rank0 <= 1) { try { NV.sound.applause(rank0 === 0 ? 2.6 : 2); } catch (e) {} }
    try { wheel.keepGlowing(); } catch (e) {}           // 当たりの扇を脈打たせ続ける
    edgeBurn(rank0);                                    // 画面の縁が燃える
    raysHit(rank0 === 0);                               // 背景の光条が外へ抜ける

    // --- 二撃目（特賞のみ）---
    // «まだ終わらない» が盛り上がりの正体。ここで音を重ね直すと団子になるので、
    // 帯域の空いている高音（shimmer）と、落下の遅い金テープだけを足す
    clearSecondWave();
    if (rank0 === 0) {
      secondWaveTimer = setTimeout(function(){
        secondWaveTimer = null;
        try { NV.sound.impact(0.72); } catch (e) {}
        try { NV.sound.shimmer(); } catch (e) {}
        impactShake();
        try { NV.confetti.streamers(30); } catch (e) {}
        edgeBurn(0, '0.9', '1700ms');
        setZoom(1.03);
      }, SECOND_WAVE_MS);
    }

    // 一拍おいてから幕を降ろす。
    // ここを 0 にすると «止まった瞬間に答えが出る» だけになり、間が消える。
    // 特賞は «品目» ではなく «もう一度回す» の画面へ行く
    clearResultReveal();
    resultRevealTimer = setTimeout(function(){
      resultRevealTimer = null;
      if (round && round.jackpot) { showJackpot(); }
      else { showChoose(); }
    }, rank0 === 0 ? RESULT_DELAY_TOP : RESULT_DELAY_MS);
  }

  // 等級ごとの一撃の強さ。特賞 / 1等 / 2等 / 3等
  var IMPACT = [1, 0.9, 0.8, 0.62];

  function clearSecondWave(){
    if (secondWaveTimer) { clearTimeout(secondWaveTimer); secondWaveTimer = null; }
  }

  // ---- ②-5 画面の縁が燃える ----
  // 画面上でいちばん大きい要素なので、いちばん遠くから見える。
  // 等級の差は «光の量と長さ» だけで付ける（形は変えない）
  var EDGE = [
    { peak: '1',    dur: '1600ms' },   // 特賞
    { peak: '1',    dur: '1300ms' },   // 1等
    { peak: '0.52', dur: '900ms'  },   // 2等
    { peak: '0.30', dur: '620ms'  }    // 3等
  ];
  function edgeBurn(rankIndex, peak, dur){
    if (!el.edge) { return; }
    var e = EDGE[rankIndex] || EDGE[2];
    el.edge.style.setProperty('--edge-peak', peak || e.peak);
    el.edge.style.setProperty('--edge-dur', dur || e.dur);
    el.edge.classList.remove('on');
    void el.edge.offsetWidth;
    el.edge.classList.add('on');
  }

  function clearFreeze(){
    if (freezeTimer) { clearTimeout(freezeTimer); freezeTimer = null; }
  }

  // ---- ⑤ 減速に合わせて盤へ寄り、周囲を沈める ----
  // t=0（回り始め）→ t=1（止まる寸前）。回転中は毎フレーム、それ以外は CSS が補間する
  var zoom = 1;
  var tension = 0;
  var tensionArmed = false;

  function setZoom(v){
    zoom = v;
    if (el.stage) { el.stage.style.setProperty('--zoom', v.toFixed(4)); }
  }
  function setTension(t){
    var v = t < 0 ? 0 : (t > 1 ? 1 : t);
    if (el.body) { el.body.style.setProperty('--vig', v.toFixed(3)); }
    setZoom(1.02 + 0.08 * v);
  }
  function resetTension(){
    tension = 0;
    tensionArmed = false;
    setTension(0);
  }
  // 円盤から毎フレーム呼ばれる。速度が落ちるほど寄る。
  //  ・回り始めの1〜2フレームはまだ速度が計算されておらず 0 になる。
  //    そのまま 1-speed を使うと «いきなり最大まで寄って、すぐ引く» という揺り戻しが出る。
  //    速度が一度上がりきるまでは 0 に張り付かせ、その後は単調増加にする
  function feedTension(speed01){
    rays.speed = speed01;   // 背景の光条は盤の «いまの速さ» にそのまま追従させる
    if (!tensionArmed) {
      if (speed01 > 0.5) { tensionArmed = true; }
      setTension(0);
      return;
    }
    var t = 1 - speed01;
    if (t > tension) { tension = t; }
    setTension(tension);
  }

  // ---- 特賞：もう一度回す ----
  function showJackpot(){
    setPeek(false);
    setState('jackpot');
    if (el.btnBonus) {
      el.btnBonus.disabled = true;
      setTimeout(function(){ if (el.btnBonus) { el.btnBonus.disabled = false; } }, CHOOSE_ARM_MS);
    }
  }

  // ボーナス盤（1個 / 2個 / 3個）。盤を作り替えて短く回す。
  // 個数は均等（各120°）。細くすると2回目まで «どうせ1個» になり、せっかくの2回目が死ぬ
  function startBonusSpin(){
    if (!round || !round.jackpot) { return; }
    if (el.body.dataset.state !== 'jackpot') { return; }

    var n = 1 + Math.floor(Math.random() * 3);
    setState('spinning');
    el.body.classList.add('tensing');
    resetTension();
    try { NV.sound.whoosh(); } catch (e) {}
    try { NV.sound.rollStart(); } catch (e) {}
    // near-miss は切る。120°の扇で «惜しい» は成立しない
    try { wheel.setRanks(BONUS_RANKS, { nearTarget: null }); } catch (e) {}

    var settled = false;
    var finish = function(){
      if (settled) { return; }
      settled = true;
      try { NV.sound.rollStop(); } catch (e) {}
      round.need = n;
      // 3個ほど大きく炸裂させる。1個でも «おまけが出た» ぶんの熱は要る
      var lvl = 3 - n;   // 3個→0（特賞級） / 2個→1 / 1個→2
      el.body.classList.remove('freeze', 'tensing');
      setZoom(1.055);
      try { NV.sound.impact(IMPACT[lvl]); } catch (e) {}
      impactShake();
      flashOnce(lvl);
      try { NV.confetti.burst(lvl); } catch (e) {}
      try { NV.sound.fanfare(Math.max(0, lvl - 1)); } catch (e) {}
      try { wheel.keepGlowing(); } catch (e) {}
      edgeBurn(lvl);
      raysHit(n === 3);
      clearResultReveal();
      resultRevealTimer = setTimeout(function(){
        resultRevealTimer = null;
        showChoose();
      }, BONUS_REVEAL_MS);
    };

    var pr = null;
    try {
      pr = wheel.spinTo('b' + n, {
        duration: BONUS_DURATION_MS,
        onTick: function(speed01, step){
          if (step) {
            try { NV.sound.ratchetTick(step.i, step.n); } catch (e) {}
            bumpPointer(true);
          } else {
            try { NV.sound.tick(speed01); } catch (e) {}
            bumpPointer(false);
          }
        },
        onRatchet: function(){ try { NV.sound.rollStop(); } catch (e) {} },
        onFrame: feedTension
      });
    } catch (e) {
      console.warn('[NV.app] ボーナス盤の回転に失敗', e);
    }
    // 本編と同じ理由の見張りタイマー。rAF が止まっても必ず先へ進める
    var watch = setTimeout(function(){
      try { if (wheel && wheel.finishNow) { wheel.finishNow(); } } catch (e) {}
      finish();
    }, BONUS_DURATION_MS + 6000);
    Promise.resolve(pr).then(function(){ clearTimeout(watch); finish(); },
                             function(){ clearTimeout(watch); finish(); });
  }

  // ---- 品目の選択 ----
  //
  // 選ぶのは来場者。在庫が減るのはここで commitItem を呼ぶ瞬間だけ。
  // 在庫0の品目は並べない（残数そのものは来場者向け画面に一切出さない）。
  var chooseTimer = null;
  var chooseTick = null;

  function clearChooseTimer(){
    if (chooseTimer) { clearTimeout(chooseTimer); chooseTimer = null; }
    if (chooseTick) { clearInterval(chooseTick); chooseTick = null; }
    if (el.chooseBar) { el.chooseBar.style.width = '0%'; }
  }

  function totalStock(){
    var n = 0;
    var ranks = (state && state.ranks) || [];
    for (var i = 0; i < ranks.length; i++) {
      var items = ranks[i].items || [];
      for (var j = 0; j < items.length; j++) { n += Math.max(0, Number(items[j].stock) || 0); }
    }
    return n;
  }

  // いま選べる品目の種類数
  function chooseCount(){
    if (!round) { return 0; }
    try { return (NV.lottery.selectableItems(state, round.rankId) || []).length; }
    catch (e) { return 0; }
  }

  function showChoose(){
    if (!round) { goIdleOrFinished(); return; }
    setPeek(false);

    // 在庫より多くは選べない。特賞で3個でも在庫が2個なら「2個」に落とす
    var left = totalStock();
    if (round.need > left) { round.need = Math.max(0, left); }
    if (round.need <= 0) { goIdleOrFinished(); return; }

    // 混雑時の逃げ道：スタッフが «自動で選ぶ» にしていたらアプリが決める
    var auto = !!(state.settings && state.settings.itemPick === 'auto');
    if (auto) { autoPickRest(); return; }

    // 選ぶものが1種類しかないなら、選ばせない。
    // 3等は品目が1つ＝来場者の6割がここに来る。そのまま出すと «選択» の形だけが残り、
    // 選びようのない画面を1タップ挟むことになる。品切れが進むと1等・2等も同じ形になる
    if (chooseCount() <= 1) { autoPickRest(); return; }

    renderChoose();
    setState('choosing');

    // 炸裂直後は指がまだ動いている。少しのあいだ触らせない
    if (el.chooseGrid) {
      el.chooseGrid.classList.add('arming');
      setTimeout(function(){
        if (el.chooseGrid) { el.chooseGrid.classList.remove('arming'); }
      }, CHOOSE_ARM_MS);
    }
    startChooseTimer();
  }

  function renderChoose(){
    if (!el.chooseGrid || !round) { return; }
    var items = [];
    try { items = NV.lottery.selectableItems(state, round.rankId) || []; } catch (e) {}

    if (el.chooseHead) { el.chooseHead.textContent = round.rankLabel; }
    if (el.chooseSub) {
      var rest = round.need - round.picked.length;
      el.chooseSub.textContent = (round.need > 1)
        ? ('お好きなものを ' + rest + '個 お選びください')
        : 'お好きなものをお選びください';
    }

    // 4枚以上並ぶ（＝特賞で全等級から選ぶ）ときは一言を落とす。
    // 1枚あたりが詰まって、いちばん大事な «絵と品名» まで読めなくなる
    el.chooseGrid.classList.toggle('dense', items.length >= 4);

    // 枚数を CSS へ渡す。«横に何枚並ぶか» が決まらないと
    // 1枚の幅を決められず、絵も字も控えめな固定値にしか置けない
    var n = Math.max(1, Math.min(6, items.length));
    for (var k = 1; k <= 6; k++) { el.chooseGrid.classList.remove('n' + k); }
    el.chooseGrid.classList.add('n' + n);

    el.chooseGrid.innerHTML = '';
    for (var i = 0; i < items.length; i++) {
      el.chooseGrid.appendChild(makeChooseCard(items[i]));
    }
  }

  function makeChooseCard(item){
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cc';
    b.setAttribute('data-item', item.id);

    var plate = document.createElement('span');
    plate.className = 'cc-plate';
    if (item.image) {
      var img = document.createElement('img');
      img.src = item.image;
      img.alt = '';
      plate.appendChild(img);
    }
    b.appendChild(plate);

    var name = document.createElement('b');
    name.textContent = item.name;
    b.appendChild(name);

    if (item.note) {
      var note = document.createElement('i');
      note.textContent = item.note;
      b.appendChild(note);
    }
    return b;
  }

  // 制限時間。既定はオフ。時間切れは在庫が最も多い品目を自動で選ぶ
  function startChooseTimer(){
    clearChooseTimer();
    var sec = 0;
    try { sec = Number(state.settings.chooseSec) || 0; } catch (e) {}
    if (!(sec > 0)) { return; }
    var start = Date.now();
    if (el.chooseBar) { el.chooseBar.style.width = '100%'; }
    chooseTick = setInterval(function(){
      var t = 1 - (Date.now() - start) / (sec * 1000);
      if (t < 0) { t = 0; }
      if (el.chooseBar) { el.chooseBar.style.width = (t * 100).toFixed(1) + '%'; }
    }, 100);
    chooseTimer = setTimeout(function(){
      chooseTimer = null;
      clearChooseTimer();
      autoPickRest();
    }, sec * 1000);
  }

  // 残りぶんをアプリが選ぶ（«自動で選ぶ» 設定・制限時間切れ・在庫都合）
  function autoPickRest(){
    if (!round) { return; }
    var guard = 0;
    while (round.picked.length < round.need && guard++ < 20) {
      var it = null;
      try { it = NV.lottery.pickItem(state, round.rankId); } catch (e) {}
      if (!it) { break; }
      if (!takeItem(it.id)) { break; }
    }
    finishRound();
  }

  // 品目を1つ確定する。在庫が0なら false（配りすぎはここで止まる）
  function takeItem(itemId){
    if (!round) { return false; }
    var found = null;
    try { found = NV.lottery.findItem(state, itemId); } catch (e) {}
    if (!found) { return false; }

    var note = round.jackpot
      ? ('特賞 ' + (round.picked.length + 1) + '/' + round.need)
      : '';
    var ok = false;
    try { ok = NV.lottery.commitItem(state, itemId, note); } catch (e) {
      console.warn('[NV.app] commitItem で例外', e);
    }
    if (!ok) { return false; }

    round.picked.push({
      id: found.item.id, name: found.item.name,
      image: found.item.image, note: found.item.note,
      rankLabel: found.rank.label
    });
    try { NV.storage.save(state); } catch (e) {}
    return true;
  }

  function onChoosePick(itemId){
    if (!round || el.body.dataset.state !== 'choosing') { return; }
    if (!takeItem(itemId)) {
      // 在庫が尽きていた。並べ直して選び直してもらう
      renderChoose();
      return;
    }
    try { NV.sound.ui(); } catch (e) {}
    if (round.picked.length >= round.need || totalStock() <= 0) {
      clearChooseTimer();
      finishRound();
      return;
    }
    // 残り1種類になったら、もう選びようがない。残りは自動で取る
    if (chooseCount() <= 1) { clearChooseTimer(); autoPickRest(); return; }

    renderChoose();
    startChooseTimer();
  }

  function finishRound(){
    clearChooseTimer();
    if (!round || round.picked.length === 0) { goIdleOrFinished(); return; }
    showResult();
  }

  // 結果の幕。品目が決まってから呼ばれる
  function showResult(){
    setPeek(false);
    var picked = (round && round.picked) || [];
    if (picked.length === 0) { goIdleOrFinished(); return; }

    // 特賞で2個以上のときは «1品を大きく» が成立しない。小さく並べる方へ切り替える
    var multi = picked.length > 1;
    el.body.classList.toggle('multi', multi);

    if (multi) {
      if (el.resultRank) { el.resultRank.textContent = round.rankLabel; }
      if (el.resultItem) {
        el.resultItem.textContent = picked.length + '個';
        el.resultItem.className = '';
      }
      if (el.resultNote) { el.resultNote.textContent = 'お渡しください'; }
      renderResultList(picked);
    } else {
      var it = picked[0];
      // 特賞から1個だけ選ばれた場合は «特賞 → 2等» のように両方見せる。
      // 等級だけだと «特賞なのに2等？» に見え、スタッフが説明に困る
      if (el.resultRank) {
        el.resultRank.textContent = round.jackpot
          ? (round.rankLabel + ' → ' + it.rankLabel) : it.rankLabel;
      }
      // B. 何が当たったのかを絵で見せる。文字だけだと現物が想像できない
      if (el.resultPlate && el.resultImg) {
        if (it.image) {
          el.resultImg.src = it.image;
          el.resultPlate.classList.remove('hidden');
        } else {
          el.resultImg.removeAttribute('src');
          el.resultPlate.classList.add('hidden');
        }
      }
      if (el.resultItem) {
        el.resultItem.textContent = it.name;
        // 品目名は20文字前後になることがある。
        // 文字数で段階的に縮めて、2行に収まる大きさにする（遠目に読めることが最優先なので
        // 縮めすぎない。折り返しの見た目は CSS の text-wrap:balance に任せる）
        var n = (it.name || '').length;
        el.resultItem.className = n > 22 ? 'len-l' : (n > 12 ? 'len-m' : '');
      }
      // 品目の一言。無い品目（デモデータや手入力）では行ごと消える
      if (el.resultNote) { el.resultNote.textContent = it.note || ''; }
      if (el.resultList) { el.resultList.innerHTML = ''; }
    }

    armNext();
    setState('result');
    slamResult();
    scheduleAutoAdvance();
  }

  // 特賞で複数個のときの一覧。絵と品名だけの行を並べる
  function renderResultList(picked){
    if (!el.resultList) { return; }

    // 同じ品目を複数選ぶことは «制限なし» なので普通に起きる。
    // 同じ行を3本並べるより «×3» のほうが、渡すときに数え違えない
    var groups = [];
    for (var i = 0; i < picked.length; i++) {
      var hit = null;
      for (var g = 0; g < groups.length; g++) {
        if (groups[g].item.id === picked[i].id) { hit = groups[g]; break; }
      }
      if (hit) { hit.n++; } else { groups.push({ item: picked[i], n: 1 }); }
    }

    el.resultList.innerHTML = '';
    for (var k = 0; k < groups.length; k++) {
      var row = document.createElement('div');
      row.className = 'rl';
      var plate = document.createElement('span');
      plate.className = 'rl-plate';
      if (groups[k].item.image) {
        var img = document.createElement('img');
        img.src = groups[k].item.image;
        img.alt = '';
        plate.appendChild(img);
      }
      row.appendChild(plate);
      var name = document.createElement('b');
      name.textContent = groups[k].item.name;
      row.appendChild(name);
      if (groups[k].n > 1) {
        var mult = document.createElement('em');
        mult.textContent = '×' + groups[k].n;
        row.appendChild(mult);
      }
      el.resultList.appendChild(row);
    }
  }

  function clearResultReveal(){
    if (resultRevealTimer) { clearTimeout(resultRevealTimer); resultRevealTimer = null; }
  }

  function findRankIndex(rankId){
    try {
      for (var i = 0; i < state.ranks.length; i++) {
        if (state.ranks[i].id === rankId) { return i; }
      }
    } catch (e) {}
    return 3; // 見つからない場合は最も控えめな演出（3等相当）に倒す
  }

  function bumpPointer(hard){
    if (!el.pointer) { return; }
    // 連続する tick でも毎回アニメーションが再生されるよう、一旦クラスを外して reflow を挟む
    el.pointer.classList.remove('bump', 'bump-hard');
    void el.pointer.offsetWidth;
    el.pointer.classList.add(hard ? 'bump-hard' : 'bump');
  }

  // 等級ごとの閃光。--peak / --fade を書き換えてから再生する
  var FLASH = [
    { peak: '0.72', fade: '380ms' },  // 特賞
    { peak: '0.60', fade: '320ms' },  // 1等
    { peak: '0.38', fade: '250ms' },  // 2等
    { peak: '0.22', fade: '190ms' }   // 3等
  ];
  function flashOnce(rankIndex){
    if (!el.flash) { return; }
    var f = FLASH[rankIndex] || FLASH[2];
    el.flash.style.setProperty('--peak', f.peak);
    el.flash.style.setProperty('--fade', f.fade);
    el.flash.classList.remove('on');
    void el.flash.offsetWidth;
    el.flash.classList.add('on');
  }

  // 画面ごと揺らす。円盤の中だけで完結させると «画面の中の出来事» に留まる
  var shakeTimer = null;
  function impactShake(){
    if (!el.body) { return; }
    if (shakeTimer) { clearTimeout(shakeTimer); }
    el.body.classList.remove('impact');
    void el.body.offsetWidth;
    el.body.classList.add('impact');
    if (el.pointer) {
      el.pointer.classList.remove('bump', 'bump-hard', 'kick');
      void el.pointer.offsetWidth;
      el.pointer.classList.add('kick');
    }
    shakeTimer = setTimeout(function(){
      shakeTimer = null;
      el.body.classList.remove('impact');
      if (el.pointer) { el.pointer.classList.remove('kick'); }
    }, 520);
  }

  // 品名を奥から叩きつける。display:none からの復帰でも確実に頭から流す。
  // 叩きつけるのは «主役» ＝ 品名であって等級ではない（等級は添え物に降格した）
  function slamResult(){
    if (!el.resultItem) { return; }
    el.resultItem.classList.remove('slam');
    void el.resultItem.offsetWidth;
    el.resultItem.classList.add('slam');
  }

  function scheduleAutoAdvance(){
    clearAutoAdvance();
    var sec = 0;
    try { sec = state.settings.autoAdvanceSec || 0; } catch (e) {}
    if (sec > 0) {
      autoAdvanceTimer = setTimeout(function(){
        autoAdvanceTimer = null;
        nextPerson();
      }, sec * 1000);
    }
  }

  // ---------------------------------------------------------------
  // 次の人へ
  // ---------------------------------------------------------------

  // 結果表示を一時的にどけているかどうか。円盤の停止位置を見せるためだけの状態で、
  // 抽選の進行（data-state）には影響させない。
  // ---- ④ 本日のノベルティ（画面下端を流れる帯） ----
  //
  // もとは «抽選する» の真上に、等級付きの札を4.2秒ごとに差し替えて出していた。
  // タップの瞬間に «1等» が表示されていると «次は1等が当たる» と読まれる。
  // 途切れず流れ続ける帯にすると «看板» と読めるようになり、その誤読が消える。
  //
  // 【禁止】ここに等級を出さないこと。等級を言うのは結果画面だけ。
  // 在庫が切れた品目は出さない（残数そのものは来場者向け画面には一切出さない）。

  var tickerSig = '';
  var tickerMeasureTries = 0;
  var TICKER_PX_PER_SEC = 58;   // 流れる速さ。品目が増えても速くならないよう実寸から時間を出す

  function noveltyList(){
    var out = [];
    var ranks = (state && state.ranks) || [];
    for (var i = 0; i < ranks.length; i++) {
      var items = ranks[i].items || [];
      for (var j = 0; j < items.length; j++) {
        if (Number(items[j].stock) > 0) {
          out.push({ name: items[j].name, image: items[j].image, note: items[j].note });
        }
      }
    }
    return out;
  }

  function makeTickerItem(p){
    var wrap = document.createElement('div');
    wrap.className = 'tk';
    if (p.image) {
      var plate = document.createElement('span');
      plate.className = 'tk-plate';
      var img = document.createElement('img');
      img.src = p.image;
      img.alt = '';
      plate.appendChild(img);
      wrap.appendChild(plate);
    }
    var txt = document.createElement('span');
    txt.className = 'tk-txt';
    var b = document.createElement('b');
    b.textContent = p.name;
    txt.appendChild(b);
    if (p.note) {
      var note = document.createElement('i');
      note.textContent = p.note;
      txt.appendChild(note);
    }
    wrap.appendChild(txt);
    return wrap;
  }

  function buildTicker(){
    if (!el.tickerTrack) { return; }
    var list = noveltyList();
    var sig = list.map(function(x){ return x.name; }).join('|');
    // 並びが同じなら作り直さない。作り直すとアニメーションが頭に戻り、帯が «飛ぶ»
    if (sig === tickerSig) { return; }
    tickerSig = sig;

    el.tickerTrack.innerHTML = '';
    if (!list.length) {
      if (el.ticker) { el.ticker.style.visibility = 'hidden'; }
      return;
    }
    if (el.ticker) { el.ticker.style.visibility = ''; }

    // 同じ並びを2回入れる。-50% まで動かせば継ぎ目なく巻き戻る
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < list.length; i++) {
        el.tickerTrack.appendChild(makeTickerItem(list[i]));
      }
    }
    tickerMeasureTries = 0;
    measureTicker();
  }

  function measureTicker(){
    if (!el.tickerTrack || !el.tickerTrack.firstChild) { return; }
    var half = el.tickerTrack.scrollWidth / 2;
    if (!(half > 40)) {
      // 帯が display:none のあいだは実寸が取れない。数フレーム待って測り直す。
      // 待機画面に一度も入らないまま回り続けないよう、回数で打ち切る
      if (tickerMeasureTries++ < 120) { requestAnimationFrame(measureTicker); }
      return;
    }
    el.tickerTrack.style.setProperty('--tk-dur',
      (half / TICKER_PX_PER_SEC).toFixed(1) + 's');
  }

  // ---- ③ 背景の金の粒 ----
  // 待機中にゆっくり昇る。位置と速さは端末ごとにばらけさせる。
  // 負の delay を入れて、起動直後から «途中の状態» で散らばらせる
  var DUST_COUNT = 22;
  function buildDust(){
    if (!el.dust || prefersReducedMotion) { return; }
    var frag = document.createDocumentFragment();
    for (var i = 0; i < DUST_COUNT; i++) {
      var d = document.createElement('i');
      d.style.setProperty('--x', (Math.random() * 100).toFixed(2) + '%');
      d.style.setProperty('--sz', (3 + Math.random() * 6).toFixed(1) + 'px');
      d.style.setProperty('--dur', (16 + Math.random() * 20).toFixed(1) + 's');
      d.style.setProperty('--delay', (-Math.random() * 30).toFixed(1) + 's');
      d.style.setProperty('--drift', ((Math.random() * 2 - 1) * 90).toFixed(0) + 'px');
      d.style.setProperty('--op', (0.28 + Math.random() * 0.5).toFixed(2));
      frag.appendChild(d);
    }
    el.dust.appendChild(frag);
  }

  // ---- ③ 背景の光条 ----
  //
  // 円盤と «逆向き» に回る。速いほど速く、止まると止まる。
  // CSS アニメーションでは速度を追従させられない（duration を書き換えると進行が跳ぶ）ので、
  // 毎フレーム transform を書く。書くのは transform と opacity だけなのでGPU合成で済む。
  // 要素は 600px 固定で、画面いっぱいへの拡大は scale に任せている（app.css の #rays 参照）。
  //
  // 【禁止】等級に応じて色や速度を変えないこと。止まる «前» に答えが漏れる。
  //         金に変えてよいのは、結果が確定して炸裂したあとだけ。
  var rays = {
    angle: 0, op: 0, target: 0, scale: 1,
    boost: 0,    // 炸裂時の追加角速度[deg/s]
    grow: 1,     // 炸裂時に外へ広がる倍率
    speed: 0,    // 円盤の体感速度 0〜1（feedTension が書く）
    last: 0, raf: null
  };
  var RAY_OP = { boot: 0, idle: 0.30, spinning: 0.62, result: 0.16, finished: 0 };

  function updateRayScale(){
    var w = window.innerWidth || 1024;
    var h = window.innerHeight || 640;
    // 画面の対角を覆えば、どの角度に回してもすき間が出ない
    rays.scale = Math.sqrt(w * w + h * h) / 600 * 1.04;
  }

  function syncRays(){
    if (!el.rays) { return; }
    if (prefersReducedMotion) { el.rays.style.display = 'none'; return; }
    var name = (el.body && el.body.dataset.state) || 'boot';
    var v = RAY_OP[name] == null ? 0 : RAY_OP[name];
    // 明るい会場では光り物は飛ぶだけ。半分に落として文字と盤を守る
    if (el.body && el.body.classList.contains('bright')) { v *= 0.45; }
    rays.target = v;
    if (name !== 'spinning') { rays.speed = 0; }
    ensureRays();
  }

  function ensureRays(){
    if (rays.raf || prefersReducedMotion || !el.rays) { return; }
    rays.last = 0;
    rays.raf = requestAnimationFrame(rayStep);
  }

  function rayStep(ts){
    var dt = rays.last ? Math.min(0.05, (ts - rays.last) / 1000) : 0.016;
    rays.last = ts;

    var dps = 2.2 + 150 * rays.speed + rays.boost;
    rays.angle = (rays.angle - dps * dt) % 360;

    if (rays.boost > 0.5) { rays.boost -= rays.boost * 3.0 * dt; } else { rays.boost = 0; }
    if (rays.grow > 1.002) { rays.grow -= (rays.grow - 1) * 1.7 * dt; } else { rays.grow = 1; }
    rays.op += (rays.target - rays.op) * Math.min(1, 2.4 * dt);

    el.rays.style.transform = 'rotate(' + rays.angle.toFixed(2) + 'deg) scale('
      + (rays.scale * rays.grow).toFixed(3) + ')';
    el.rays.style.opacity = rays.op.toFixed(3);

    if (rays.target > 0.004 || rays.op > 0.004 || rays.boost > 0 || rays.grow > 1) {
      rays.raf = requestAnimationFrame(rayStep);
    } else {
      rays.raf = null;
      rays.last = 0;
      el.rays.style.opacity = '0';
    }
  }

  // 停止の瞬間。光条を一気に加速させ、外へ広げて抜く
  function raysHit(isTop){
    if (!el.rays || prefersReducedMotion) { return; }
    rays.boost = isTop ? 900 : 300;
    rays.grow = isTop ? 1.75 : 1.20;
    rays.op = isTop ? 1 : 0.85;
    rays.target = isTop ? 0.95 : 0.70;
    if (isTop) {
      el.rays.classList.add('gold');
      setTimeout(function(){
        if (el.rays) { el.rays.classList.remove('gold'); }
      }, 2400);
    }
    setTimeout(syncRays, isTop ? 1500 : 600);
    ensureRays();
  }

  // 品目IDから品目そのものを引く（結果表示の絵と一言に使う）
  function itemById(itemId){
    var ranks = (state && state.ranks) || [];
    for (var i = 0; i < ranks.length; i++) {
      var items = ranks[i].items || [];
      for (var j = 0; j < items.length; j++) {
        if (items[j].id === itemId) { return items[j]; }
      }
    }
    return null;
  }

  // AudioContext はタブの復帰やブラウザの都合で suspended に落ちることがある。
  // 何か触られるたびに resume を投げておけば、次の抽選までに勝手に直る。
  function nudgeAudio(){
    try { NV.sound.init(); NV.sound.resume(); } catch (e) {}
  }

  function setPeek(on){
    if (!el.body) { return; }
    if (el.body.dataset.state !== 'result') { on = false; }
    el.body.classList.toggle('result-peek', !!on);
    try { NV.sound.ui(); } catch (e) {}
  }

  // E. 景品を渡す前に来場者が画面を触って結果を消してしまう事故を防ぐ。
  // 表示から armMs の間はタップも「次の人へ」も効かせない。
  var ARM_MS = 1500;
  var armedAt = 0;
  function armNext(){
    armedAt = Date.now() + ARM_MS;
    if (!el.btnNext) { return; }
    el.btnNext.disabled = true;
    el.btnNext.classList.remove('arming');
    void el.btnNext.offsetWidth;   // アニメーションを毎回頭から流すため
    el.btnNext.classList.add('arming');
    setTimeout(function(){
      if (el.btnNext) { el.btnNext.disabled = false; el.btnNext.classList.remove('arming'); }
    }, ARM_MS);
  }
  function nextArmed(){ return Date.now() >= armedAt; }

  function nextPerson(){
    if (resultRevealTimer || freezeTimer) { return; }  // 炸裂の最中。まだ結果すら出ていない
    if (!nextArmed()) { return; }
    setPeek(false);
    if (el.body.dataset.state !== 'result') { return; }
    clearAutoAdvance();
    try { NV.confetti.stop(); } catch (e) {}
    goIdleOrFinished();
  }

  // ---------------------------------------------------------------
  // 設定（スタッフ専用）
  // ---------------------------------------------------------------

  function openSettings(){
    try {
      NV.settings.requestOpen(state, onSettingsSaved);
    } catch (e) {
      console.warn('[NV.app] settings を開けませんでした', e);
    }
  }

  // 会場モード。明るいホールで «沈んで見える» ときにスタッフが入れる
  function applyBrightMode(){
    try {
      el.body.classList.toggle('bright', !!(state.settings && state.settings.brightMode));
    } catch (e) {}
    syncRays();
  }

  function onSettingsSaved(nextState){
    if (nextState) { state = nextState; }
    applyBrightMode();
    try { NV.storage.save(state); } catch (e) {}
    try {
      NV.sound.setVolume(state.settings && state.settings.volume == null
        ? 1 : state.settings.volume);
      NV.sound.setEnabled(!!(state.settings && state.settings.soundOn));
    } catch (e) {}
    goIdleOrFinished();  // 円盤の作り直しはこの中でやる
  }

  function bindCornerHotspot(){
    if (!el.cornerHotspot) { return; }

    function startPress(){
      clearLongPress();
      longPressTimer = setTimeout(function(){
        longPressTimer = null;
        openSettings();
      }, LONG_PRESS_MS);
    }
    function cancelPress(){
      clearLongPress();
    }

    el.cornerHotspot.addEventListener('pointerdown', startPress);
    el.cornerHotspot.addEventListener('pointerup', cancelPress);
    el.cornerHotspot.addEventListener('pointercancel', cancelPress);
    el.cornerHotspot.addEventListener('pointerleave', cancelPress);
  }

  function clearLongPress(){
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  // ---------------------------------------------------------------
  // Screen Wake Lock（失敗しても致命傷にしない）
  // ---------------------------------------------------------------

  function requestWakeLock(){
    try {
      if (!('wakeLock' in navigator)) { return; }
      navigator.wakeLock.request('screen').then(function(sentinel){
        wakeLockSentinel = sentinel;
      }, function(){
        // 会場の省電力設定などで取得できないことがある。抽選自体は続行する
      });
    } catch (e) {}
  }

  document.addEventListener('visibilitychange', function(){
    if (document.visibilityState === 'visible') {
      requestWakeLock();
    }
  });

  // ---------------------------------------------------------------
  // リサイズ・向き変更
  // ---------------------------------------------------------------

  function handleResize(){
    if (resizeDebounceTimer) { clearTimeout(resizeDebounceTimer); }
    resizeDebounceTimer = setTimeout(function(){
      resizeDebounceTimer = null;
      try { wheel.resize(); } catch (e) {}
      updateRayScale();
      // 帯の余白は clamp で画面幅に連動する。実寸が変われば所要時間も測り直す
      tickerMeasureTries = 0;
      measureTicker();
    }, 100);
  }

  // ---------------------------------------------------------------
  // Service Worker（sw.js は別担当。無くても/失敗しても無視する）
  // ---------------------------------------------------------------

  function registerServiceWorker(){
    try {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(function(){});
      }
    } catch (e) {}
  }

  // ---------------------------------------------------------------
  // イベント登録
  // ---------------------------------------------------------------

  function bindEvents(){
    if (el.overlayBoot) {
      el.overlayBoot.addEventListener('click', handleBootTap);
    }

    if (el.btnStart) {
      el.btnStart.addEventListener('click', startSpin);
    }
    if (el.stage) {
      el.stage.addEventListener('click', function(){
        if (el.body.dataset.state === 'idle') { startSpin(); }
      });
    }

    if (el.btnNext) {
      el.btnNext.addEventListener('click', function(ev){
        ev.stopPropagation();
        nextPerson();
      });
    }
    // 特賞：もう一度回す
    if (el.btnBonus) {
      el.btnBonus.addEventListener('click', function(ev){
        ev.stopPropagation();
        startBonusSpin();
      });
    }
    // 品目の選択。カードは選ぶたびに作り直すので、親でクリックを拾う
    if (el.chooseGrid) {
      el.chooseGrid.addEventListener('click', function(ev){
        var t = ev.target;
        while (t && t !== el.chooseGrid && !t.getAttribute('data-item')) { t = t.parentNode; }
        if (!t || t === el.chooseGrid) { return; }
        ev.stopPropagation();
        onChoosePick(t.getAttribute('data-item'));
      });
    }
    // 「円盤を見る」= 結果の文字を一旦どけて、ポインタがどの扇で止まったかを見せる。
    // 抽選は終わっているので data-state は 'result' のまま動かさない。
    if (el.btnClose) {
      el.btnClose.addEventListener('click', function(ev){
        ev.stopPropagation();
        setPeek(true);
      });
    }
    if (el.btnReopen) {
      el.btnReopen.addEventListener('click', function(ev){
        ev.stopPropagation();
        setPeek(false);
      });
    }
    if (el.overlayResult) {
      // オーバーレイの余白タップでも次の人へ進める（ボタンのタップは上で止めている）
      el.overlayResult.addEventListener('click', nextPerson);
    }

    // ユーザー操作のたびに音を起こし直す（capture で確実に拾う）
    document.addEventListener('pointerdown', nudgeAudio, true);

    document.addEventListener('keydown', function(ev){
      if (ev.code !== 'Space' && ev.code !== 'Enter') { return; }
      var current = el.body.dataset.state;
      if (current === 'idle') {
        ev.preventDefault();
        startSpin();
      } else if (current === 'jackpot') {
        ev.preventDefault();
        startBonusSpin();
      } else if (current === 'result') {
        ev.preventDefault();
        if (el.body.classList.contains('result-peek')) { setPeek(false); }
        else { nextPerson(); }
      }
    });

    bindCornerHotspot();

    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);

    if (typeof ResizeObserver === 'function' && el.stage) {
      try {
        new ResizeObserver(handleResize).observe(el.stage);
      } catch (e) {}
    }
  }

  // ---------------------------------------------------------------
  // 公開API
  // ---------------------------------------------------------------

  NV.app = NV.app || {};
  NV.app.start = start;

  // モンテカルロ検証などでコンソールから現在の state を読めるようにしておく。
  // state 変数そのものへの参照を返すゲッターにして、差し替え（設定保存など）後も追従させる。
  Object.defineProperty(NV.app, 'state', {
    get: function(){ return state; },
    configurable: true
  });

  document.addEventListener('DOMContentLoaded', NV.app.start);
})();
