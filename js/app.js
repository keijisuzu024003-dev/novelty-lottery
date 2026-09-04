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
  // 止まってから結果の幕を降ろすまでの «間»。
  // 0 にすると炸裂も衝撃波も幕の裏に隠れて、演出が丸ごと無駄になる
  var RESULT_DELAY_MS = 520;
  var resultRevealTimer = null;

  var el = {};

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
    el.btnClose = document.getElementById('btn-close');
    el.prizeCard = document.getElementById('prize-card');
    el.prizeImg = document.getElementById('prize-img');
    el.prizeRank = document.getElementById('prize-rank');
    el.prizeName = document.getElementById('prize-name');
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
    // 待機中だけ景品を順に見せる。回転中や結果表示中に裏で切り替わると気が散る
    if (name === 'idle') { startPrizeRotation(); }
    else { stopPrizeRotation(); }
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
        NV.sound.setEnabled(!!state.settings.soundOn);
      }
    } catch (e) {}

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
    clearResultReveal();
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

    var result = null;
    try {
      result = NV.lottery.draw(state);
    } catch (e) {
      console.warn('[NV.app] draw に失敗', e);
    }

    if (!result) {
      // 在庫切れ（あるいは何らかの異常）は抽選を止めて終了画面へ
      setState('finished');
      return;
    }

    isBusy = true;
    clearAutoAdvance();
    setState('spinning');

    try { NV.sound.whoosh(); } catch (e) {}
    try { NV.sound.rollStart(); } catch (e) {}

    var spinPromise;
    // C. 1等のときだけ、回転を長く取り終盤を寝かせる。止まる寸前の「間」を作る
    var isTop = !!(state.ranks && state.ranks[0] && state.ranks[0].id === result.rankId);
    try {
      spinPromise = wheel.spinTo(result.rankId, {
        suspense: isTop,
        duration: isTop ? Math.round(SPIN_DURATION_MS * 1.55) : SPIN_DURATION_MS,
        onTick: function(speed01){
          try { NV.sound.tick(speed01); } catch (e) {}
          // 終盤のラチェットは1歩が «越えた» と分かる強さで弾かせる
          bumpPointer(speed01 < 0.08);
        }
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
    try { NV.sound.rollStop(); } catch (e) {}
    var rank0 = findRankIndex(result.rankId);
    // 一撃は commit や DOM 更新より先に鳴らす。ここで数ミリ遅れると «ズレた» と感じる
    try { NV.sound.impact(rank0 === 0 ? 1 : (rank0 === 1 ? 0.8 : 0.62)); } catch (e) {}
    impactShake();

    var committed = false;
    try {
      committed = NV.lottery.commit(state, result);
    } catch (e) {
      console.warn('[NV.app] commit で例外', e);
    }

    if (!committed) {
      // draw から commit までの間に在庫が想定外に変わっていた場合の保険。
      // 表示は崩さず、素直に待機画面へ戻す。
      console.warn('[NV.app] 在庫不整合のため commit できませんでした。idle に戻します');
      isBusy = false;
      setState('idle');
      return;
    }

    try { NV.storage.save(state); } catch (e) {}

    // --- 第1拍：円盤の上で炸裂させる。ここで幕を降ろすと全部隠れて何も見えない ---
    flashOnce(rank0);                                   // 閃光は3等にも。差は強さで付ける
    try { NV.confetti.burst(rank0 + 1); } catch (e) {}
    try { NV.sound.fanfare(rank0); } catch (e) {}
    if (rank0 === 0) { try { NV.sound.applause(2); } catch (e) {} }
    try { wheel.keepGlowing(); } catch (e) {}           // 当たりの扇を脈打たせ続ける

    // --- 第2拍：一拍おいてから結果を叩きつける ---
    // ここを 0 にすると «止まった瞬間に答えが出る» だけになり、間が消える。
    clearResultReveal();
    resultRevealTimer = setTimeout(function(){
      resultRevealTimer = null;
      showResult(result);
    }, RESULT_DELAY_MS);
  }

  // 結果の幕。onSpinDone から RESULT_DELAY_MS 遅れて呼ばれる
  function showResult(result){
    setPeek(false);
    if (el.resultRank) { el.resultRank.textContent = result.rankLabel; }
    // B. 何が当たったのかを絵で見せる。文字だけだと現物が想像できない
    if (el.resultPlate && el.resultImg) {
      var img = imageFor(result.itemId);
      if (img) {
        el.resultImg.src = img;
        el.resultPlate.classList.remove('hidden');
      } else {
        el.resultImg.removeAttribute('src');
        el.resultPlate.classList.add('hidden');
      }
    }
    if (el.resultItem) {
      el.resultItem.textContent = result.itemName;
      // 品目名は20文字前後になることがある。
      // 文字数で段階的に縮めて、2行に収まる大きさにする（遠目に読めることが最優先なので
      // 縮めすぎない。折り返しの見た目は CSS の text-wrap:balance に任せる）
      var n = (result.itemName || '').length;
      el.resultItem.className = n > 22 ? 'len-l' : (n > 12 ? 'len-m' : '');
    }
    armNext();
    setState('result');
    slamRank();
    scheduleAutoAdvance();
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
    return 2; // 見つからない場合は最も控えめな演出（3等相当）に倒す
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

  // 等級名を奥から叩きつける。display:none からの復帰でも確実に頭から流す
  function slamRank(){
    if (!el.resultRank) { return; }
    el.resultRank.classList.remove('slam');
    void el.resultRank.offsetWidth;
    el.resultRank.classList.add('slam');
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
  // ---- A. 待機中に景品を順に見せる ----
  // 通りがかりの人に「何がもらえるか」を伝えるのが目的。在庫が切れた品目は出さない。
  var prizeTimer = null;
  var prizeIndex = 0;

  function prizeList(){
    var out = [];
    var ranks = (state && state.ranks) || [];
    for (var i = 0; i < ranks.length; i++) {
      var items = ranks[i].items || [];
      for (var j = 0; j < items.length; j++) {
        if (Number(items[j].stock) > 0) {
          out.push({ rank: ranks[i].label, name: items[j].name, image: items[j].image });
        }
      }
    }
    return out;
  }

  function showPrize(){
    if (!el.prizeCard) { return; }
    var list = prizeList();
    if (!list.length) { el.prizeCard.style.display = 'none'; return; }
    el.prizeCard.style.display = '';
    var p = list[prizeIndex % list.length];
    prizeIndex++;

    // 一旦フェードアウトしてから差し替える。パッと切り替わると散らかって見える
    el.prizeCard.classList.add('swap');
    setTimeout(function(){
      if (el.prizeRank) { el.prizeRank.textContent = p.rank; }
      if (el.prizeName) { el.prizeName.textContent = p.name; }
      if (el.prizeImg) {
        if (p.image) { el.prizeImg.src = p.image; el.prizeImg.style.display = ''; }
        else { el.prizeImg.removeAttribute('src'); el.prizeImg.style.display = 'none'; }
      }
      el.prizeCard.classList.remove('swap');
    }, 420);
  }

  function startPrizeRotation(){
    stopPrizeRotation();
    showPrize();
    prizeTimer = setInterval(showPrize, 4200);
  }
  function stopPrizeRotation(){
    if (prizeTimer) { clearInterval(prizeTimer); prizeTimer = null; }
  }

  // 品目IDから画像を引く（結果表示用）
  function imageFor(itemId){
    var ranks = (state && state.ranks) || [];
    for (var i = 0; i < ranks.length; i++) {
      var items = ranks[i].items || [];
      for (var j = 0; j < items.length; j++) {
        if (items[j].id === itemId) { return items[j].image || null; }
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
    if (resultRevealTimer) { return; }  // 炸裂を見せている最中。まだ結果すら出ていない
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

  function onSettingsSaved(nextState){
    if (nextState) { state = nextState; }
    try { NV.storage.save(state); } catch (e) {}
    try { NV.sound.setEnabled(!!(state.settings && state.settings.soundOn)); } catch (e) {}
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
