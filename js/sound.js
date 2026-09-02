// js/sound.js
// 展示会の騒がしいブースで「振り向かせる」効果音を、音源ファイル無しで Web Audio API のみで合成する。
// 最重要方針: AudioContext が使えない・resume が拒否される等どんな失敗でも、
//            全関数は例外を投げずに黙って no-op で返る（音が出ないことより、落ちることの方が問題）。
// ------------------------------------------------------------
window.NV = window.NV || {};

(function () {
  "use strict";

  var ctx = null;          // AudioContext 本体
  var master = null;       // マスターゲイン（setEnabled で 0 にする）
  var compressor = null;   // 最終段のリミッタ代わり
  var enabled = true;      // setEnabled の現在値（init 前に呼ばれても状態は覚えておく）
  var initTried = false;   // init() の多重呼び出し対策

  // ロール（ドラムロール）の状態。rollStart/rollStop の多重呼び出しに耐えるため外に持つ。
  var roll = null; // { src, filter, lfoGain, lfo, gain } | null

  // 生成した使い捨てノードを確実に切り離すための共通ヘルパー。
  // stop 後も参照が残っているとブラウザによっては解放が遅れるため、onended で明示的に disconnect する。
  function cleanupOnEnded(node, extraNodes) {
    node.onended = function () {
      try { node.disconnect(); } catch (e) {}
      if (extraNodes) {
        for (var i = 0; i < extraNodes.length; i++) {
          try { extraNodes[i].disconnect(); } catch (e) {}
        }
      }
    };
  }

  function now() {
    return ctx.currentTime;
  }

  // ---- 初期化 ----------------------------------------------------

  function init() {
    if (initTried) return; // 多重呼び出しに耐える
    initTried = true;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return; // 対応ブラウザが無い環境。以降の全関数は ctx===null で no-op になる
      ctx = new AC();

      compressor = ctx.createDynamicsCompressor();
      compressor.connect(ctx.destination);

      master = ctx.createGain();
      master.gain.value = enabled ? 1 : 0;
      master.connect(compressor);
    } catch (e) {
      // 生成失敗時は ctx を確実に null に戻し、以降の全関数を no-op 化する
      ctx = null;
      master = null;
      compressor = null;
    }
  }

  function resume() {
    // Promise 自体が無い極端な環境でも例外を外に出さないよう、
    // catch 節の中では Promise を新たに生成しない（自己参照で失敗する余地を消す）。
    try {
      if (!ctx || !ctx.resume) return Promise.resolve();
      return Promise.resolve(ctx.resume()).catch(function () {});
    } catch (e) {
      try { return Promise.resolve(); } catch (e2) { return undefined; }
    }
  }

  function setEnabled(on) {
    enabled = !!on;
    try {
      if (!ctx || !master) return;
      // クリック防止に少しだけ時間をかけて変化させる
      var t = now();
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(enabled ? 1 : 0, t + 0.05);
    } catch (e) {}
  }

  // 呼び出し前に毎回チェックする共通ガード。ctx が無い/enabled=false なら true を返して早期リターンさせる。
  function unusable() {
    return !ctx || !master;
  }

  // ---- tick: 円盤のカチッ -----------------------------------------

  function tick(speed01) {
    try {
      if (unusable()) return;
      var s = typeof speed01 === "number" && isFinite(speed01) ? Math.max(0, Math.min(1, speed01)) : 0.5;
      var t = now();

      // ノード数最小化: 矩形波1つ＋ゲイン1つの極短エンベロープ。連打に耐える。
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = "square";
      // 速いほど高いピッチ・小さい音量（高速連打時に耳障りにならないように）
      var freq = 900 + s * 900; // 900Hz〜1800Hz
      osc.frequency.setValueAtTime(freq, t);
      var peak = 0.22 - s * 0.10; // 0.22 -> 0.12
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.01, peak), t + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);

      osc.connect(g);
      g.connect(master);

      osc.start(t);
      osc.stop(t + 0.04);
      cleanupOnEnded(osc, [g]);
    } catch (e) {}
  }

  // ---- rollStart / rollStop: ドラムロール -----------------------------

  function rollStart() {
    try {
      if (unusable()) return;
      if (roll) return; // 多重呼び出しに耐える: 既に鳴っていたら何もしない

      var t = now();

      // ホワイトノイズバッファ（2秒をループ再生）
      var bufSec = 2;
      var buffer = ctx.createBuffer(1, ctx.sampleRate * bufSec, ctx.sampleRate);
      var data = buffer.getChannelData(0);
      for (var i = 0; i < data.length; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      var src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;

      var filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 800;

      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.08); // 立ち上がり

      // 低周波 LFO で振幅を揺らしてドラムロール感を出す
      var lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 14; // 連打っぽい速さ
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.28; // 揺れ幅
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain); // gain.gain の基準値に加算変調される

      src.connect(filter);
      filter.connect(gain);
      gain.connect(master);

      src.start(t);
      lfo.start(t);

      roll = { src: src, filter: filter, lfo: lfo, lfoGain: lfoGain, gain: gain };
    } catch (e) {
      roll = null;
    }
  }

  function rollStop() {
    try {
      if (!roll) return; // 多重呼び出しに耐える
      if (unusable()) { roll = null; return; }

      var r = roll;
      roll = null; // 先に参照を外し、rollStop の再入を無効化する

      var t = now();
      r.gain.gain.cancelScheduledValues(t);
      r.gain.gain.setValueAtTime(r.gain.gain.value, t);
      r.gain.gain.linearRampToValueAtTime(0.0001, t + 0.12); // 120ms フェードアウト

      var stopAt = t + 0.13;
      try { r.src.stop(stopAt); } catch (e) {}
      try { r.lfo.stop(stopAt); } catch (e) {}

      cleanupOnEnded(r.src, [r.filter, r.gain, r.lfo, r.lfoGain]);
    } catch (e) {}
  }

  // ---- fanfare ------------------------------------------------------

  // 単音を鳴らすヘルパー。type違いを重ねられるよう複数オシレータ対応。
  // detunes: 各オシレータのデチューン量(cent)配列。省略時は単一オシレータ。
  function playNote(freq, startT, dur, opts) {
    opts = opts || {};
    var types = opts.types || ["square"];
    var gainPeak = opts.gain != null ? opts.gain : 0.2;
    var attack = opts.attack != null ? opts.attack : 0.01;
    var release = opts.release != null ? opts.release : 0.08;
    var detunes = opts.detunes || [0];

    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, startT);
    g.gain.exponentialRampToValueAtTime(Math.max(0.01, gainPeak), startT + attack);
    var sustainEnd = startT + Math.max(dur - release, attack + 0.01);
    g.gain.setValueAtTime(Math.max(0.01, gainPeak), sustainEnd);
    g.gain.exponentialRampToValueAtTime(0.0001, startT + dur);
    g.connect(master);

    var oscs = [];
    for (var ti = 0; ti < types.length; ti++) {
      for (var di = 0; di < detunes.length; di++) {
        var osc = ctx.createOscillator();
        osc.type = types[ti];
        osc.frequency.setValueAtTime(freq, startT);
        osc.detune.setValueAtTime(detunes[di], startT);
        osc.connect(g);
        osc.start(startT);
        osc.stop(startT + dur + 0.05);
        oscs.push(osc);
      }
    }
    // 最後に開始したオシレータの onended で全体を disconnect する
    if (oscs.length) {
      cleanupOnEnded(oscs[oscs.length - 1], oscs.slice(0, -1).concat([g]));
    }
  }

  // 音階(A4=440基準の平均律)からHzを計算
  function noteHz(semitoneFromA4) {
    return 440 * Math.pow(2, semitoneFromA4 / 12);
  }
  // C,E,G の相対半音（A4基準）。C5=+3, E5=+7, G5=+10, C6=+15 ...
  var N = { C5: 3, E5: 7, G5: 10, C6: 15, E6: 19, G6: 22, C7: 27 };

  function fanfare(rankIndex) {
    try {
      if (unusable()) return;
      var t = now();

      if (rankIndex === 0) {
        // 1等: 長い上昇アルペジオ(8分)＋長い主和音＋オクターブ上の装飾。約2.5秒。矩形+鋸波を重ねてディチューン。
        var seq = [N.C5, N.E5, N.G5, N.C6, N.E6, N.G6, N.C6, N.E6];
        var step = 0.13;
        for (var i = 0; i < seq.length; i++) {
          playNote(noteHz(seq[i]), t + i * step, step * 1.15, {
            types: ["square", "sawtooth"],
            detunes: [-6, 6],
            gain: 0.16,
            attack: 0.008,
            release: 0.05
          });
        }
        var chordStart = t + seq.length * step + 0.02;
        var chordDur = 1.5;
        [N.C5, N.E5, N.G5, N.C6].forEach(function (semi) {
          playNote(noteHz(semi), chordStart, chordDur, {
            types: ["square", "sawtooth"],
            detunes: [-8, 0, 8],
            gain: 0.13,
            attack: 0.015,
            release: 0.5
          });
        });
        // オクターブ上の装飾（きらめき）
        playNote(noteHz(N.C7), chordStart + 0.05, chordDur - 0.1, {
          types: ["triangle"],
          gain: 0.09,
          attack: 0.02,
          release: 0.4
        });
      } else if (rankIndex === 1) {
        // 2等: 中尺(約1.4秒)の3音ファンファーレ
        var notes2 = [N.C5, N.G5, N.C6];
        var durs2 = [0.28, 0.28, 0.85];
        var tt = t;
        for (var j = 0; j < notes2.length; j++) {
          playNote(noteHz(notes2[j]), tt, durs2[j], {
            types: ["square", "sawtooth"],
            detunes: [-5, 5],
            gain: 0.18,
            attack: 0.01,
            release: j === notes2.length - 1 ? 0.35 : 0.05
          });
          tt += durs2[j] * 0.85;
        }
      } else {
        // 3等: 短い上昇2音(約0.6秒)。明るいが控えめ
        playNote(noteHz(N.C5), t, 0.28, { types: ["triangle"], gain: 0.16, attack: 0.008, release: 0.12 });
        playNote(noteHz(N.G5), t + 0.2, 0.4, { types: ["triangle"], gain: 0.16, attack: 0.008, release: 0.2 });
      }
    } catch (e) {}
  }

  // ---- applause -------------------------------------------------------

  function applause(sec) {
    try {
      if (unusable()) return;
      var dur = typeof sec === "number" && isFinite(sec) && sec > 0 ? sec : 3;
      var t = now();

      // 全体の音量エンベロープ（立ち上がり→減衰）
      var envGain = ctx.createGain();
      envGain.gain.setValueAtTime(0.0001, t);
      envGain.gain.exponentialRampToValueAtTime(0.5, t + Math.min(0.3, dur * 0.2));
      envGain.gain.setValueAtTime(0.5, t + dur * 0.6);
      envGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      envGain.connect(master);

      // 短いノイズバースト用の共有バッファ（毎回生成するとGC負荷が増えるため1つを使い回す）
      var burstLen = Math.max(1, Math.floor(ctx.sampleRate * 0.06));
      var burstBuf = ctx.createBuffer(1, burstLen, ctx.sampleRate);
      var bd = burstBuf.getChannelData(0);
      for (var i = 0; i < burstLen; i++) bd[i] = Math.random() * 2 - 1;

      // 同時ノード数を抑えるため、バーストの発生回数の上限を設ける(非力なAndroidタブレット対策)
      var maxBursts = 30;
      var avgInterval = dur / maxBursts;
      var when = t;
      var count = 0;
      var sources = [];
      while (when < t + dur && count < maxBursts) {
        (function (startAt) {
          var src = ctx.createBufferSource();
          src.buffer = burstBuf;
          var g = ctx.createGain();
          g.gain.value = 0.4 + Math.random() * 0.6; // ランダムな振幅
          var filter = ctx.createBiquadFilter();
          filter.type = "bandpass";
          filter.frequency.value = 1500 + Math.random() * 3000; // パチパチ感のランダムな帯域
          filter.Q.value = 0.7;

          src.connect(filter);
          filter.connect(g);
          g.connect(envGain);

          src.start(startAt);
          src.stop(startAt + 0.07);
          cleanupOnEnded(src, [filter, g]);
          sources.push(src);
        })(when);
        when += avgInterval * (0.5 + Math.random()); // ランダムな間隔
        count++;
      }

      // envGain は誰も参照しなくなった時点でGC対象になるため、明示的な後始末は不要。
      // タイマーで envGain.disconnect() を張る方式は取らない（バックグラウンドタブで
      // setTimeout が遅延・停止しても支障が出ないよう、各バーストのonendedのみに依存させる）。
    } catch (e) {}
  }

  // ---- ui ---------------------------------------------------------------

  function ui() {
    try {
      if (unusable()) return;
      var t = now();
      var osc = ctx.createOscillator();
      var g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(1200, t);
      osc.frequency.exponentialRampToValueAtTime(700, t + 0.05);
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
      osc.connect(g);
      g.connect(master);
      osc.start(t);
      osc.stop(t + 0.07);
      cleanupOnEnded(osc, [g]);
    } catch (e) {}
  }

  // 「音が出ない」を現場で切り分けるための状態。
   // running 以外なら端末やブラウザ側で止められている（タブのミュート、
   // 音量ミキサー、自動再生の制限など）。アプリ側の音量は master で持っている。
  function status() {
    try {
      if (!ctx) return { ok: false, state: "なし", reason: "音の仕組みが起動していません" };
      return {
        ok: ctx.state === "running" && enabled,
        state: ctx.state,
        enabled: enabled,
        volume: master ? +master.gain.value.toFixed(2) : 0
      };
    } catch (e) {
      return { ok: false, state: "不明", reason: String(e && e.message) };
    }
  }

  window.NV.sound = {
    status: status,
    init: init,
    resume: resume,
    setEnabled: setEnabled,
    tick: tick,
    rollStart: rollStart,
    rollStop: rollStop,
    fanfare: fanfare,
    applause: applause,
    ui: ui
  };
})();
