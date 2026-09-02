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

    try { NV.sound.rollStart(); } catch (e) {}

    var spinPromise;
    try {
      spinPromise = wheel.spinTo(result.rankId, {
        duration: SPIN_DURATION_MS,
        onTick: function(speed01){
          try { NV.sound.tick(speed01); } catch (e) {}
          bumpPointer();
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

    if (el.resultRank) { el.resultRank.textContent = result.rankLabel; }
    if (el.resultItem) {
      el.resultItem.textContent = result.itemName;
      // 品目名は20文字前後になることがある。
      // 文字数で段階的に縮めて、2行に収まる大きさにする（遠目に読めることが最優先なので
      // 縮めすぎない。折り返しの見た目は CSS の text-wrap:balance に任せる）
      var n = (result.itemName || '').length;
      el.resultItem.className = n > 22 ? 'len-l' : (n > 12 ? 'len-m' : '');
    }
    setState('result');

    var rankIndex = findRankIndex(result.rankId);

    try { NV.sound.fanfare(rankIndex); } catch (e) {}
    try { NV.confetti.burst(rankIndex + 1); } catch (e) {}

    if (rankIndex === 0) {
      flashOnce();
      try { NV.sound.applause(2); } catch (e) {}
    }

    // 在庫0になった等級があれば円盤の見た目（彩度落とし）を更新する
    try { wheel.setRanks(state.ranks); } catch (e) {}

    scheduleAutoAdvance();
  }

  function findRankIndex(rankId){
    try {
      for (var i = 0; i < state.ranks.length; i++) {
        if (state.ranks[i].id === rankId) { return i; }
      }
    } catch (e) {}
    return 2; // 見つからない場合は最も控えめな演出（3等相当）に倒す
  }

  function bumpPointer(){
    if (!el.pointer) { return; }
    // 連続する tick でも毎回アニメーションが再生されるよう、一旦クラスを外して reflow を挟む
    el.pointer.classList.remove('bump');
    void el.pointer.offsetWidth;
    el.pointer.classList.add('bump');
  }

  function flashOnce(){
    if (!el.flash) { return; }
    el.flash.classList.remove('on');
    void el.flash.offsetWidth;
    el.flash.classList.add('on');
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

  function nextPerson(){
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
    try { wheel.setRanks(state.ranks); } catch (e) {}
    try { NV.sound.setEnabled(!!(state.settings && state.settings.soundOn)); } catch (e) {}
    goIdleOrFinished();
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
      el.btnNext.addEventListener('click', nextPerson);
    }
    if (el.overlayResult) {
      el.overlayResult.addEventListener('click', nextPerson);
    }

    document.addEventListener('keydown', function(ev){
      if (ev.code !== 'Space' && ev.code !== 'Enter') { return; }
      var current = el.body.dataset.state;
      if (current === 'idle') {
        ev.preventDefault();
        startSpin();
      } else if (current === 'result') {
        ev.preventDefault();
        nextPerson();
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
