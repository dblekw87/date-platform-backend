/**
 * 오른 이유 — the catalyst behind a leader, and whether other stocks share it.
 *
 * A theme says a group moved; it never says why any one name did, and the two
 * can disagree. 삼성전자 rising on HBM 증설 pulls 하이닉스 and 한미반도체 with
 * it. 삼성전자 rising on 자사주 소각 pulls nobody. Both read as "반도체 강세"
 * on a theme list, and only one of them has a 짝꿍 behind it — so the reason is
 * named separately from the theme rather than inferred from it.
 *
 * Classification is keyword rules over the headlines the news provider already
 * tagged with this symbol. That is deliberately shallow: it labels the kind of
 * event, not its magnitude, and it is honest about finding nothing rather than
 * guessing. Learning the reason from price behaviour needs a stored history the
 * board does not have yet.
 */

// 고유 rules run first because their terms name a specific corporate action,
// while the shared terms are broad enough to appear in a headline about one.
// A 자사주 소각 story that also says 공급 is still a buyback story.
//
// Each pattern carries both languages: US headlines arrive in English, and a
// Korean-only rule set left every American leader unexplained.
//
// Words that describe the move rather than its cause — 급등, 강세, surges,
// jumps — are deliberately absent. A headline saying only that a stock rose is
// not a reason, and matching it would manufacture one.
const catalystRules = [
  [/자사주|자기주식|소각|주주환원|배당|밸류업|buyback|repurchase|dividend|shareholder return/i, { kind: "고유", label: "주주환원" }],
  [/실적|영업이익|순이익|어닝|턴어라운드|흑자|적자|가이던스|earnings|revenue|guidance|quarterly results|profit (?:beat|miss)|beats estimates/i, { kind: "고유", label: "실적" }],
  [/유상증자|무상증자|전환사채|신주인수권|메자닌|\bCB\b|\bBW\b|share offering|stock offering|dilution|convertible note/i, { adverse: true, kind: "고유", label: "증자·메자닌" }],
  [/블록딜|지분\s?매각|대주주|최대주주|보호예수|오버행|block trade|stake sale|insider sel|lock-?up/i, { adverse: true, kind: "고유", label: "지분 변동" }],
  [/인수|합병|피인수|물적분할|인적분할|M&A|acquisition|acquires?|merger|takeover|spin-?off/i, { kind: "고유", label: "인수·합병" }],
  [/소송|제재|횡령|배임|상장폐지|거래정지|리콜|lawsuit|probe|investigation|recall|sues?|fined/i, { adverse: true, kind: "고유", label: "악재·분쟁" }],
  [/목표주가|투자의견|증권가|커버리지|price target|analyst|upgrades?|downgrades?|initiated coverage/i, { kind: "고유", label: "증권가 의견" }],
  [/파업|노조|노사|strike|union|labor dispute|layoffs?/i, { adverse: true, kind: "고유", label: "노사" }],
  [/수주|계약\s?체결|납품|공급\s?계약|공급망|new order|contract win|wins? (?:a )?contract|supply deal|supplier/i, { kind: "공유", label: "수주·공급" }],
  [/증설|설비\s?투자|신규\s?투자|신공장|캐파|생산\s?능력|capacity|new plant|new fab|expansion|capex/i, { kind: "공유", label: "증설·투자" }],
  [/협력|제휴|파트너십|\bMOU\b|partnership|partners with|collaborat|joint venture/i, { kind: "공유", label: "협력·제휴" }],
  [/정책|정부|규제|법안|보조금|국책|지원책|policy|regulation|subsid|government|bill passes/i, { kind: "공유", label: "정책" }],
  [/관세|수출|수입|무역|공급\s?과잉|점유율|tariff|export control|sanction|trade (?:war|deal)|market share/i, { kind: "공유", label: "무역·수출" }],
  [/금리|환율|유가|원자재|가격\s?인상|단가|업황|수요\s?증가|interest rate|inflation|oil price|price hike|demand surge/i, { kind: "공유", label: "가격·업황" }],
  [/신제품|출시|임상|승인|허가|특허|launch|unveil|approval|\bFDA\b|patent|clinical/i, { kind: "공유", label: "제품·승인" }]
];

function classifyHeadline(headline) {
  const text = `${headline.label ?? ""} ${headline.text ?? ""} ${headline.originalText ?? ""}`;
  const rule = catalystRules.find(([pattern]) => pattern.test(text));

  return rule?.[1];
}

/**
 * The caution a leader carries once its reason is known.
 *
 * The case worth spelling out is a company-specific reason inside a theme that
 * moved: the peer list says a 짝꿍 exists and the reason says it does not, and
 * a reader acting on the peer list alone would buy a follower that has nothing
 * to follow.
 */
function cautionFor(leader, catalyst) {
  if (!catalyst) return leader.caution;

  if (catalyst.kind === "고유") {
    return leader.pairTrade === "테마 주도"
      ? `${catalyst.label}은 이 종목만의 재료입니다. 테마가 함께 올랐어도 같은 이유는 아닐 수 있으니 동반 종목의 재료를 따로 확인하세요.`
      : `${catalyst.label}은 이 종목만의 재료라 따라 오를 종목이 없습니다. 원문으로 지속성을 확인하세요.`;
  }

  return leader.pairTrade === "테마 주도"
    ? `${catalyst.label}은 같은 업종이 공유하는 재료입니다. 동반 종목의 반응 속도와 거래대금 유지를 확인하세요.`
    : `${catalyst.label}은 업종이 공유할 재료인데 아직 함께 오른 종목이 없습니다. 뒤따르는 종목이 있는지 확인하세요.`;
}

/**
 * Pairs each leader with the newest headline that named it and classified.
 * Leaders no headline explains keep their original caution and carry no
 * catalyst, which reads as "이유 미확인" rather than an invented reason.
 */
export function attachDayLeaderCatalysts(dayLeaders, headlines = []) {
  if (dayLeaders.length === 0) return dayLeaders;

  const bySymbol = new Map();

  [...headlines]
    .sort((left, right) => String(left.publishedAt).localeCompare(String(right.publishedAt)))
    .forEach((headline) => {
      const catalyst = classifyHeadline(headline);

      if (!catalyst) return;

      // Sorted oldest first, so each later match overwrites with a newer one —
      // except that an adverse story never displaces a favourable one. Only
      // rising stocks are ranked, and a strike or a lawsuit is not why one rose:
      // 현대차 was up 8% on a filing while its newest headline was about a
      // walkout, and taking the newest match named the wrong reason.
      (headline.relatedSymbols ?? []).forEach((symbol) => {
        const previous = bySymbol.get(symbol);

        if (catalyst.adverse && previous && !previous.adverse) return;

        bySymbol.set(symbol, {
          ...catalyst,
          headline: headline.text ?? headline.label ?? "",
          originalUrl: headline.originalUrl,
          publishedAt: headline.publishedAt,
          source: headline.source
        });
      });
    });

  return dayLeaders.map((leader) => {
    const catalyst = bySymbol.get(leader.symbol);

    return catalyst
      ? { ...leader, catalyst, caution: cautionFor(leader, catalyst) }
      : leader;
  });
}
