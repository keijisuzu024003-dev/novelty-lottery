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

  // 特賞かどうか。特賞は自前の在庫を持たず、全等級の品目から選ばせる。
  function isJackpot(rank) {
    return !!(rank && rank.jackpot);
  }

  // 在庫が残っている等級だけを返す（抽選候補）。
  // 特賞は自前の在庫が 0 でも、全体に在庫がある限り候補に残す（noStock）。
  function availableRanks(state) {
    var ranks = state ? asArray(state.ranks) : [];
    var total = totalStock(state);
    var out = [];
    for (var i = 0; i < ranks.length; i++) {
      var r = ranks[i];
      if (!r) continue;
      if (r.noStock || isJackpot(r)) {
        if (total > 0) out.push(r);
      } else if (rankStock(r) > 0) {
        out.push(r);
      }
    }
    return out;
  }

  // 在庫のある品目を全等級から集める（特賞の選択肢）。
  function allItemsInStock(state) {
    var ranks = state ? asArray(state.ranks) : [];
    var out = [];
    for (var i = 0; i < ranks.length; i++) {
      var items = asArray(ranks[i] && ranks[i].items);
      for (var j = 0; j < items.length; j++) {
        if (items[j] && toNum(items[j].stock) > 0) out.push(items[j]);
      }
    }
    return out;
  }

  // rankId で選べる品目。特賞なら全等級から、通常の等級ならその等級から。
  // 在庫0の品目は返さない（＝選択画面に出ない。残数そのものは出さない）。
  function selectableItems(state, rankId) {
    var ranks = state ? asArray(state.ranks) : [];
    var rank = null;
    for (var i = 0; i < ranks.length; i++) {
      if (ranks[i] && ranks[i].id === rankId) { rank = ranks[i]; break; }
    }
    if (!rank) return [];
    if (isJackpot(rank)) return allItemsInStock(state);
    return asArray(rank.items).filter(function (it) {
      return it && toNum(it.stock) > 0;
    });
  }

  // 品目IDから品目とその等級を引く（等級をまたいで探す。特賞のため）。
  function findItem(state, itemId) {
    var ranks = state ? asArray(state.ranks) : [];
    for (var i = 0; i < ranks.length; i++) {
      var items = asArray(ranks[i] && ranks[i].items);
      for (var j = 0; j < items.length; j++) {
        if (items[j] && items[j].id === itemId) {
          return { rank: ranks[i], item: items[j] };
        }
      }
    }
    return null;
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

    // 品目はここでは決めない。選ぶのは来場者（設定で «自動で選ぶ» にしたときは pickItem）。
    // 選択肢が1つも無い等級は返さない（通常は availableRanks で弾かれている）
    if (selectableItems(state, chosenRank.id).length === 0) return null;

    return {
      rankId: chosenRank.id,
      rankLabel: chosenRank.label,
      jackpot: isJackpot(chosenRank)
    };
  }

  // 「自動で選ぶ」設定のときに、アプリが代わりに品目を決める。
  // 在庫に比例させると在庫の多い品目から捌けて、結果的に均等に減る。
  function pickItem(state, rankId, rng) {
    var random = typeof rng === "function" ? rng : Math.random;
    var items = selectableItems(state, rankId);
    if (items.length === 0) return null;
    return pickByWeight(items, function (it) { return toNum(it.stock); }, random);
  }

  // 選ばれた品目を1つ確定する。在庫を1減らし history に1行追記する。
  //
  // 【この関数が配りすぎを止めている】在庫が 0 以下なら何もせず false を返す。
  // 特賞で複数個取れるようになっても、1個ずつここを通す限り総配布数は総在庫を超えない。
  //
  // note は履歴の備考（CSV の5列目）。特賞のときだけ「特賞 2/3」のように入る。
  // 等級は «実際に渡した品目が属する等級» で記録する。
  // 特賞で1等の品を選んだ場合、等級欄は「1等」・備考が「特賞 1/3」になる。
  function commitItem(state, itemId, note) {
    if (!state || !itemId) return false;
    var found = findItem(state, itemId);
    if (!found) return false;

    var stock = toNum(found.item.stock);
    if (stock <= 0) return false; // 在庫を1未満にしない

    found.item.stock = stock - 1;

    if (!Array.isArray(state.history)) state.history = [];
    state.history.push({
      ts: Date.now(),
      venue: state.venue,
      rankId: found.rank.id,
      rankLabel: found.rank.label,
      itemId: found.item.id,
      itemName: found.item.name,
      note: (typeof note === "string") ? note : ""
    });
    return true;
  }

  // 旧シグネチャ。{ itemId, note } を渡せば動く（rankId は見ない）。
  function commit(state, result) {
    if (!state || !result) return false;
    return commitItem(state, result.itemId, result.note);
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
    isJackpot: isJackpot,
    selectableItems: selectableItems,
    findItem: findItem,
    draw: draw,
    pickItem: pickItem,
    commitItem: commitItem,
    commit: commit,
    isFinished: isFinished
  };
})();
