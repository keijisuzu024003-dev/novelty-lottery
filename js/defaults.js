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
    { color: "#4A2C64", colorDark: "#22132F" }, // 1等 深紫
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
        {
          id: "r1",
          label: "1等",
          color: RANK_COLORS[0].color,
          colorDark: RANK_COLORS[0].colorDark,
          weight: 10,
          items: [
            { id: "i1", name: "1等 景品A（デモ）", stock: 3, initial: 3 },
            { id: "i2", name: "1等 景品B（デモ）", stock: 3, initial: 3 }
          ]
        },
        {
          id: "r2",
          label: "2等",
          color: RANK_COLORS[1].color,
          colorDark: RANK_COLORS[1].colorDark,
          weight: 28,
          items: [
            { id: "i3", name: "2等 景品A（デモ）", stock: 8, initial: 8 },
            { id: "i4", name: "2等 景品B（デモ）", stock: 8, initial: 8 }
          ]
        },
        {
          id: "r3",
          label: "3等",
          color: RANK_COLORS[2].color,
          colorDark: RANK_COLORS[2].colorDark,
          weight: 62,
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
        itemPick: "stock-weighted"
      }
    };
  }

  window.NV.defaults = {
    VENUES: VENUES,
    RANK_COLORS: RANK_COLORS,
    makeState: makeState
  };
})();
