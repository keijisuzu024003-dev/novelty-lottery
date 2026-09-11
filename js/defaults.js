// js/defaults.js
// 既定データと state のひな形を作るモジュール。
// ★実データが届いたらここだけ差し替える（品目名と stock / initial）★
// ------------------------------------------------------------
window.NV = window.NV || {};

(function () {
  "use strict";

  // 会場一覧。設定画面のセレクトと CSV の絞り込みで使う。
  var VENUES = ["名古屋", "大阪", "東京", "福岡"];

  // 等級の色（金・赤・青）。等級を増やす場合は末尾に追加していく想定。
  // 扇の色は日本の伝統色から。RGB原色を避けることで既製品めいた配色から離す。
  // 1等を紫にしたのは、金にすると真鍮の縁と溶けて「どこが1等か」が読めなくなるため。
  // 位階で紫が最上位という慣習にも合う。
  var RANK_COLORS = [
    // 特賞は «盤でいちばん明るいもの» にする。幅が 3.6 度しかないので、
    // 明度で勝たないと縁の真鍮（#C9A24B）に溶けて «金の線» が見えなくなる
    { color: "#F2C230", colorDark: "#8A6A12" }, // 特賞 山吹（明るい金）
    // 1等だけ «明るさ» で差をつける。距離と照明で先に失われるのは色相で、明度は残る。
    // 2等 #9E3129 / 3等 #2A5375 の約2倍の輝度にしてある（下げると1等が埋もれる）
    { color: "#7A5AA6", colorDark: "#3A2A50" }, // 1等 藤紫
    { color: "#9E3129", colorDark: "#4A1310" }, // 2等 深緋
    { color: "#2A5375", colorDark: "#101F2D" }  // 3等 縹
  ];

  // 新しい state を作る。展示会開始前の初期化・「工場出荷状態に戻す」用途。
  //
  // ★品目名と在庫数はここには書かない。★
  // このファイルは GitHub Pages（公開リポジトリ）に上がるため、実際の景品と配布数量が
  // 誰でも見られる状態になってしまう。実データは会場ごとの JSON を
  // 設定画面の「バックアップを読み込む」から入れる運用にしている。
  //   → 会場データ\ノベルティ抽選_名古屋.json など（社内共有フォルダにのみ置く）
  //
  // ここに入っているのは動作確認用のデモ在庫（計42個）。0個にすると初回起動が
  // いきなり「本日は終了しました」になってスタッフが戸惑うので、少量だけ入れてある。
  //
  // weight（出現確率）だけはここに持たせてある。1等をやや絞りつつ、
  // 極端な偏りは避ける配分（詳細は README）。
  function makeState() {
    return {
      version: 1,
      venue: VENUES[0],
      ranks: [
        // 特賞。自前の在庫は持たず、当たったら «全等級から» N個選べる。
        //  jackpot : 抽選と確定の扱いが特別（lottery.js）
        //  noStock : 自前の在庫が0でも盤に出す。全体に在庫がある限り生きている
        //  top     : ニアミス（«惜しい»）の対象。盤で狙う一点はここ
        // 【重要】ranks[0] が最上位という約束は維持する。演出の強さも app.js が index で決める
        {
          id: "rj",
          label: "特賞",
          color: RANK_COLORS[0].color,
          colorDark: RANK_COLORS[0].colorDark,
          weight: 1,
          jackpot: true,
          noStock: true,
          top: true,
          items: []
        },
        {
          id: "r1",
          label: "1等",
          color: RANK_COLORS[1].color,
          colorDark: RANK_COLORS[1].colorDark,
          weight: 10,
          items: [
            { id: "i1", name: "1等 景品A（デモ）", stock: 3, initial: 3 },
            { id: "i2", name: "1等 景品B（デモ）", stock: 3, initial: 3 }
          ]
        },
        {
          id: "r2",
          label: "2等",
          color: RANK_COLORS[2].color,
          colorDark: RANK_COLORS[2].colorDark,
          weight: 28,
          items: [
            { id: "i3", name: "2等 景品A（デモ）", stock: 8, initial: 8 },
            { id: "i4", name: "2等 景品B（デモ）", stock: 8, initial: 8 }
          ]
        },
        {
          id: "r3",
          label: "3等",
          color: RANK_COLORS[3].color,
          colorDark: RANK_COLORS[3].colorDark,
          weight: 61,
          items: [
            { id: "i5", name: "3等 景品A（デモ）", stock: 20, initial: 20 }
          ]
        }
      ],
      history: [],
      settings: {
        pin: "1234",
        soundOn: true,
        autoAdvanceSec: 0,
        // "choose" = 来場者が品目を選ぶ／"auto" = アプリが在庫比例で決める（混雑時の逃げ道）
        itemPick: "choose",
        // 選択の制限時間[秒]。0 でオフ。時間切れは在庫が最も多い品目を自動で選ぶ
        chooseSec: 0,
        brightMode: false,
        volume: 1
      }
    };
  }

  window.NV.defaults = {
    VENUES: VENUES,
    RANK_COLORS: RANK_COLORS,
    makeState: makeState
  };
})();
