// 나이아 블랙잭 5단계 실습 규칙 파일 (blackjack-rules.js)
// 각 단계의 TODO를 완성한 뒤 [코드 실행 & 자동 채점]을 눌러 보세요!

// [Step 1] 4문양(♠, ♥, ♦, ♣) × 13랭크 = 52장 카드 덱 만들기
function createDeck() {
  // TODO(Step 1): 지금은 문양이 2개뿐이라 26장만 만들어집니다. ♦와 ♣를 추가해 52장을 완성하세요!
  const suits = ["♠", "♥"];
  const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const deck = [];

  for (const suit of suits) {
    for (const rank of ranks) {
      const value =
        rank === "A"
          ? 11
          : rank === "J" || rank === "Q" || rank === "K"
            ? 10
            : Number(rank);
      deck.push({ suit, rank, value });
    }
  }
  return deck;
}

// [Step 2] 패 합계 & 에이스(A) 유연 계산 + Hit 가능 조건
function handValue(cards) {
  let total = 0;
  let aces = 0;

  for (const card of cards) {
    if (card.rank === "A") {
      aces += 1;
      total += 11;
    } else if (card.rank === "J" || card.rank === "Q" || card.rank === "K") {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }

  // TODO(Step 2): total이 21을 넘고 aces가 남아 있는 동안 total에서 10을 빼고 aces를 1 줄이세요!
  return total;
}

function canPlayerHit(cards) {
  // TODO(Step 2): 패 합계(handValue(cards))가 21 미만일 때만 true를 반환하세요!
  return cards.length >= 0;
}

// [Step 3] 딜러 17 규칙 (16 이하면 Hit, 17 이상이면 Stand)
function shouldDealerHit(dealerCards) {
  // TODO(Step 3): 딜러 합계가 17 미만이면 true, 17 이상이면 false를 반환하세요!
  return false;
}

// [Step 4] 승패 및 내추럴 블랙잭 판정 ("blackjack" | "win" | "lose" | "push" | "bust")
function judgeOutcome(playerCards, dealerCards) {
  const playerScore = handValue(playerCards);
  const dealerScore = handValue(dealerCards);

  if (playerScore > 21) {
    return "bust";
  }

  // TODO(Step 4):
  // 1) 첫 2장으로 21점인 내추럴 블랙잭 여부를 확인하세요 (플레이어·딜러 모두 내추럴이면 "push", 플레이어만 내추럴이면 "blackjack").
  // 2) 딜러가 21점을 초과하면 "win", 점수가 같으면 "push"를 반환하세요.
  if (playerScore > dealerScore) {
    return "win";
  }
  return "lose";
}

// [Step 5] 칩 베팅 배당 정산 (반환 총액 계산)
function settleChips(bet, outcome) {
  // TODO(Step 5):
  // - "blackjack": 원금 + 1.5배 보너스 = Math.floor(bet * 2.5)
  // - "win": 원금의 2배 = bet * 2
  // - "push": 원금 그대로 = bet
  // - "lose" 또는 "bust": 0
  if (outcome === "win") {
    return bet * 2;
  }
  return 0;
}

if (typeof window !== "undefined") {
  window.BlackjackRules = {
    createDeck,
    handValue,
    canPlayerHit,
    shouldDealerHit,
    judgeOutcome,
    settleChips,
  };
}
