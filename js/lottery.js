// js/lottery.js
// 抽選ロジック。純粋関数のみ。DOM も localStorage も一切触らない。
// ここのバグは「ノベルティの配りすぎ」という実害に直結するため、
// 想定外の入力（在庫マイナス・weight 全部0・items 空 等）でも
// 例外を投げず、必ず安全な値（null / false / 0）を返す。
// ------------------------------------------------------------
window.NV = window.NV || {};

(function () {
  "use strict";

  // 数値として使えない値は 0 として扱う。壊れた state に対しても計算を止めないため。
  function toNum(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }

  // 等級1つ分の在庫合計（items の stock 合計）。
  function rankStock(rank) {
    if (!rank) return 0;
    var items = asArray(rank.items);
    var sum = 0;
    for (var i = 0; i < items.length; i++) {
      sum += Math.max(0, toNum(items[i] && items[i].stock));
    }
    return sum;
  }

  // state 全体の在庫合計。
  function totalStock(state) {
    var ranks = state ? asArray(state.ranks) : [];
    var sum = 0;
    for (var i = 0; i < ranks.length; i++) {
      sum += rankStock(ranks[i]);
    }
    return sum;
  }

  // 在庫が残っている等級だけを返す（抽選候補）。
  function availableRanks(state) {
    var ranks = state ? asArray(state.ranks) : [];
    var out = [];
    for (var i = 0; i < ranks.length; i++) {
      if (rankStock(ranks[i]) > 0) out.push(ranks[i]);
    }
    return out;
  }

  // 在庫0の等級を除外し、残った等級の weight を候補内合計で正規化した実効確率。
  // weight が負値の場合は 0 として扱う（マイナス確率は存在しないため）。
  // 候補全ての weight が 0 の場合は、在庫がある等級の中で等確率にする（0除算回避）。
  function effectiveWeights(state) {
    var ranks = availableRanks(state);
    var n = ranks.length;
    if (n === 0) return [];

    var weights = [];
    var sumWeight = 0;
    for (var i = 0; i < n; i++) {
      var w = Math.max(0, toNum(ranks[i].weight));
      weights.push(w);
      sumWeight += w;
    }

    var result = [];
    if (sumWeight > 0) {
      for (var j = 0; j < n; j++) {
        result.push({ rankId: ranks[j].id, prob: weights[j] / sumWeight });
      }
    } else {
      // 全候補 weight 0 → 等確率にフォールバック
      for (var k = 0; k < n; k++) {
        result.push({ rankId: ranks[k].id, prob: 1 / n });
      }
    }
    return result;
  }

  // 累積和方式で1件選ぶ共通ヘルパー。
  // items: 候補配列。getWeight(item) -> 0以上の重み。
  // 浮動小数の誤差でどれにも当たらなかった場合は必ず最後の候補を返す（undefined を返して落ちることを防ぐ）。
  function pickByWeight(items, getWeight, rng) {
    var n = items.length;
    if (n === 0) return null;
    if (n === 1) return items[0];

    var weights = [];
    var sum = 0;
    for (var i = 0; i < n; i++) {
      var w = Math.max(0, toNum(getWeight(items[i])));
      weights.push(w);
      sum += w;
    }

    var r;
    if (sum > 0) {
      r = rng() * sum;
      var acc = 0;
      for (var j = 0; j < n; j++) {
        acc += weights[j];
        if (r < acc) return items[j];
      }
    } else {
      // 重みが全部0 → 等確率
      r = rng() * n;
      var idx = Math.floor(r);
      if (idx >= 0 && idx < n) return items[idx];
    }
    // フォールバック（浮動小数誤差・想定外の rng 実装対策）
    return items[n - 1];
  }

  // 等級を1つ抽選する。在庫0の等級は候補から除外し、weight を正規化して重み付き抽選する。
  function draw(state, rng) {
    var random = typeof rng === "function" ? rng : Math.random;
    var ranks = availableRanks(state);
    if (ranks.length === 0) return null;

    var chosenRank = pickByWeight(ranks, function (rank) {
      return Math.max(0, toNum(rank.weight));
    }, random);
    if (!chosenRank) return null;

    var items = asArray(chosenRank.items).filter(function (it) {
      return it && toNum(it.stock) > 0;
    });
    if (items.length === 0) {
      // rankStock > 0 のはずなので通常来ないが、念のためのガード。
      return null;
    }

    var itemPick = state && state.settings && state.settings.itemPick === "even" ? "even" : "stock-weighted";
    var chosenItem;
    if (itemPick === "even") {
      chosenItem = pickByWeight(items, function () { return 1; }, random);
    } else {
      chosenItem = pickByWeight(items, function (it) { return toNum(it.stock); }, random);
    }
    if (!chosenItem) return null;

    return {
      rankId: chosenRank.id,
      rankLabel: chosenRank.label,
      itemId: chosenItem.id,
      itemName: chosenItem.name
    };
  }

  // draw() の結果を確定させる。在庫を1減らし history に追記する。
  // 在庫が既に無い（0以下）場合は何もせず false を返す。
  function commit(state, result) {
    if (!state || !result) return false;
    var ranks = asArray(state.ranks);
    var rank = null;
    for (var i = 0; i < ranks.length; i++) {
      if (ranks[i] && ranks[i].id === result.rankId) { rank = ranks[i]; break; }
    }
    if (!rank) return false;

    var items = asArray(rank.items);
    var item = null;
    for (var j = 0; j < items.length; j++) {
      if (items[j] && items[j].id === result.itemId) { item = items[j]; break; }
    }
    if (!item) return false;

    var stock = toNum(item.stock);
    if (stock <= 0) return false; // 在庫を1未満にしない

    item.stock = stock - 1;

    if (!Array.isArray(state.history)) state.history = [];
    state.history.push({
      ts: Date.now(),
      venue: state.venue,
      rankId: rank.id,
      rankLabel: rank.label,
      itemId: item.id,
      itemName: item.name
    });
    return true;
  }

  // 総在庫が0かどうか。
  function isFinished(state) {
    return totalStock(state) === 0;
  }

  window.NV.lottery = {
    rankStock: rankStock,
    totalStock: totalStock,
    availableRanks: availableRanks,
    effectiveWeights: effectiveWeights,
    draw: draw,
    commit: commit,
    isFinished: isFinished
  };
})();
