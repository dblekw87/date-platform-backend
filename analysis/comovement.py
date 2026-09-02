"""Which stocks are bought in the same minute, and which of them leads.

The JS side already groups a single day (`npm run theme:candidates`). This is
the part that needs more than a day: whether the same pair comes back. A pair
that co-moved once is a coincidence and a pair that co-moves every week is a
theme, and only the second one is worth trading off.

Two things the JS version learned the hard way are kept here:

  * change_rate is cumulative against yesterday's close, so correlating the
    level makes every rising stock look correlated with every other. The tick
    difference is what separates two names bought in the same minute.
  * single linkage chains. One 0.6 pair welds two unrelated groups together, so
    pairs are kept as pairs here and never grown into clusters by transitivity.

The pair is directed. 삼성전기 moving pulls 삼화콘덴서 and not the reverse, and
an undirected correlation treats them as interchangeable when only one side of
the trade exists. Direction is taken from size: the larger of the two leads.
"""

import numpy as np
import pandas as pd

import db

MINIMUM_TICKS = 12
MINIMUM_TURNOVER = 1_000_000_000
CORRELATION_FLOOR = 0.6
# 공통요인을 뽑으려면 뽑을 만한 모집단이 있어야 합니다. 지금 데이터의 가장 얇은
# 날이 146종목이라 이 문턱은 걸리지 않습니다 -- 반나절 장이나 수집 사고처럼
# 모집단이 무너진 날에 첫 주성분이 한두 종목 자신이 되는 것을 막는 안전장치입니다.
MINIMUM_SYMBOLS = 30
# 걷어낼 공통 방향의 수. 1개로는 부족했습니다 -- remove_common_factor 주석의 사다리
# 참고. 손으로 고른 상수이고, 지금 데이터로는 이보다 잘 고를 방법이 없습니다.
COMMON_FACTORS = 3


def load_day(session_date: str, market: str = "KR") -> pd.DataFrame:
    """One row per symbol per tick, regular session only.

    The evening book is a different session with different liquidity, so mixing
    it in would correlate two names on the strength of both being thin at 18:00.
    """
    return db.read(
        """
        SELECT symbol, name, theme, observed_at, change_rate, turnover, market_cap
        FROM market_price_samples
        WHERE market = %s AND session_date = %s
          AND source LIKE 'kis:krx%%'
          AND (observed_at AT TIME ZONE 'Asia/Seoul')::time BETWEEN '09:00' AND '15:30'
          AND change_rate IS NOT NULL
        ORDER BY observed_at
        """,
        (market, session_date),
    )


def tick_returns(frame: pd.DataFrame) -> pd.DataFrame:
    """Symbols as columns, tick-over-tick change in percentage points as values."""
    wide = (frame
            .pivot_table(index="observed_at", columns="symbol", values="change_rate", aggfunc="last")
            .astype(float)
            .sort_index())
    # Forward fill only inside a symbol's own span: a symbol that had not been
    # seen yet must stay missing rather than inherit a zero return.
    wide = wide.ffill()
    returns = wide.diff()

    return returns.loc[:, returns.count() >= MINIMUM_TICKS]


def liquid_symbols(frame: pd.DataFrame) -> pd.DataFrame:
    """Last seen turnover, size and label per symbol."""
    last = frame.sort_values("observed_at").groupby("symbol").last()

    return last[last["turnover"].astype(float) >= MINIMUM_TURNOVER]


def remove_common_factor(frame: pd.DataFrame) -> tuple[pd.DataFrame, float]:
    """Strip the one thing every stock did together, and say how big it was.

    Without this the correlation answers "did the market move" far more often
    than "is this a theme". Measured over 2026-08-18..09-02: the raw pair count
    ranged 94..1,344 per day, and the two biggest days collapsed to a fraction
    once the factor was gone (996 -> 153, 1,344 -> 48). Those were index days,
    not theme days, and 엘에스일렉트릭 came out paired with 수소 · 로봇 · 2차전지
    · 조선 names at once - the signature of a factor, not a theme.

    **The mean is the wrong centre here.** The sampled universe is the turnover
    ranking, so it is biased to whatever is surging ([[ranking-keyhole-finding]]),
    and a mean is dragged by those few. Subtracting it injects the same -mean
    series into every quiet name and makes the quiet names correlate with each
    other: on 2026-08-18 that turned 209 pairs into 920 and the busiest symbol
    into 73 of them. The median does not do this (215 pairs, hub 17), and the
    first principal component - the direction the day actually moved in - does
    better still. Measured, all four side by side:

        raw     4,682 pairs · 28.8% already in one theme · 94..1,344/day · hub 63
        mean    2,159        · 26.3%                     · 37..920      · hub 73
        median  1,665        · 38.0%                     · 42..362      · hub 31
        pc1     1,484        · 45.8%                     · 48..243      · hub 31

    Agreement with the dictionary is the quality proxy: a measure that keeps
    finding pairs the dictionary already groups is finding themes, so what it
    finds *outside* the dictionary is worth reading as a real gap.

    Missing values are restored afterwards. Filling them with zero to run the
    decomposition and leaving them filled would quietly disable the
    MINIMUM_TICKS gate - a symbol seen three times would carry zeros everywhere
    else and correlate with anything.

    **How many directions to strip.** One was not enough - hubs survived it
    (두산 in 10 of the 53 residual pairs, against LG이노텍 · 에임드바이오 ·
    리가켐바이오 · 한화오션 at once). But more is not simply better, because the
    thing being looked for is itself a factor: strip enough directions and the
    반도체 cluster goes with them. So the ladder is read on three numbers, not
    on the share alone - how many known-theme pairs survive (recall), what
    fraction of the survivors are known themes (precision), and how that
    fraction compares to picking any liquid pair at random that day (lift):

        strip  pairs  in-dict  share   random   lift
          0    4,682   1,350   28.8%   10.2%    2.8x
          1    1,954     772   39.5%    9.9%    4.0x
          2    1,033     487   47.1%   10.2%    4.6x
          3      800     402   50.2%   10.2%    4.9x
          5      673     351   52.2%   10.3%    5.0x
          8      514     263   51.2%   10.3%    5.0x

    Lift saturates at three and the share stops improving after five, while
    recall keeps falling the whole way - 8 strips a third of the known themes
    out of the answer and buys nothing. Three is the knee.

    Marchenko-Pastur was tried for picking this per day and does not work on
    this data: with ~370 symbols against ~180 ticks the sample correlation
    matrix is rank deficient, and the count ran into its cap on 11 of 12 days.
    Narrowing to the top 60-150 names by turnover makes it behave (3-6
    directions) but the count then tracks the universe size, which is a knob in
    a different place rather than an answer. Three stays a chosen constant, and
    it should be revisited when the tick grid is finer than five minutes.
    """
    if frame.shape[1] < MINIMUM_SYMBOLS or frame.shape[0] < 2:
        return frame, 0.0

    missing = frame.isna()
    filled = frame.fillna(0.0).to_numpy(dtype=float)
    centred = filled - filled.mean(axis=0, keepdims=True)
    left, strength, right = np.linalg.svd(centred, full_matrices=False)
    total = float((strength ** 2).sum())
    share = float((strength[:COMMON_FACTORS] ** 2).sum() / total) if total > 0 else 0.0
    taken = min(COMMON_FACTORS, len(strength))
    residual = centred - (left[:, :taken] * strength[:taken]) @ right[:taken, :]
    stripped = pd.DataFrame(residual, index=frame.index, columns=frame.columns)

    return stripped.mask(missing), share


_MEMBERSHIP: dict[str, set[str]] | None = None


def theme_membership() -> dict[str, set[str]]:
    """Every theme a symbol belongs to, not just the one label the board prints.

    market_price_samples.theme carries a single representative label per symbol
    (classifyTheme takes the lowest theme_no), so comparing labels asks a
    narrower question than the one this module is for. 로보티즈 prints
    피지컬 AI/휴머노이드 로봇 and 클로봇 prints 지능형로봇/인공지능(AI), and the
    two look like a hole in the dictionary - but both sit in
    로봇(산업용/협동로봇 등) in kr_theme_members, along with seven other robot
    names. The dictionary already holds that pair; only the printed label
    differs.

    So the label question and the membership question are answered separately.
    Counting a pair as "the dictionary missed this" requires that the two share
    no theme at all. The JS side learned the same thing about 짝꿍 pairs, where
    using the representative label alone lost 한전산업 → 우리기술.
    """
    global _MEMBERSHIP

    if _MEMBERSHIP is None:
        frame = db.read("SELECT symbol, theme_name FROM kr_theme_membership")
        membership: dict[str, set[str]] = {}

        for symbol, theme_name in zip(frame["symbol"], frame["theme_name"]):
            membership.setdefault(symbol, set()).add(theme_name)

        _MEMBERSHIP = membership

    return _MEMBERSHIP


def day_pairs(session_date: str, market: str = "KR") -> pd.DataFrame:
    frame = load_day(session_date, market)

    if frame.empty:
        return pd.DataFrame()

    liquid = liquid_symbols(frame)
    members = theme_membership()
    returns = tick_returns(frame)
    shared = [symbol for symbol in returns.columns if symbol in liquid.index]

    if len(shared) < 2:
        return pd.DataFrame()

    # 시장이 함께 움직인 몫을 먼저 걷어냅니다. 걷지 않으면 상관은 "테마인가"보다
    # "그날 지수가 움직였는가"에 더 자주 답합니다.
    residual, factor_share = remove_common_factor(returns[shared])
    correlations = residual.corr(min_periods=MINIMUM_TICKS)
    # A limit-up stock has zero variance, so its correlation is undefined rather
    # than zero. Dropped rather than filled, which is what "측정불가" means.
    matrix = correlations.to_numpy()
    upper = np.triu_indices_from(matrix, k=1)
    rows = []

    for left_index, right_index in zip(*upper):
        score = matrix[left_index, right_index]

        if not np.isfinite(score) or score < CORRELATION_FLOOR:
            continue

        left, right = shared[left_index], shared[right_index]
        left_size = float(liquid.loc[left, "market_cap"] or 0)
        right_size = float(liquid.loc[right, "market_cap"] or 0)
        leader, follower = (left, right) if left_size >= right_size else (right, left)

        rows.append({
            "correlation": round(float(score), 3),
            "follower": follower,
            "follower_name": liquid.loc[follower, "name"],
            "follower_theme": liquid.loc[follower, "theme"],
            "leader": leader,
            "leader_name": liquid.loc[leader, "name"],
            "leader_theme": liquid.loc[leader, "theme"],
            # 그날 걷어낸 공통 방향들이 설명한 분산 비율. 크면 테마가 아니라
            # 시장이 움직인 날이고, 남은 쌍을 그만큼 조심해서 읽어야 합니다.
            "factor_share": round(factor_share, 3),
            "same_theme": bool(liquid.loc[leader, "theme"] == liquid.loc[follower, "theme"]),
            # 같은 라벨인가가 아니라, 사전이 둘을 어디서든 함께 두는가입니다.
            "shared_theme": bool(members.get(leader, set()) & members.get(follower, set())),
            "session_date": session_date,
        })

    return pd.DataFrame(rows)


def persistence(market: str = "KR") -> tuple[pd.DataFrame, pd.DataFrame]:
    """Every day's pairs, and how many days each directed pair survived."""
    days = db.session_dates(market)
    frames = [day_pairs(day, market) for day in days]
    frames = [frame for frame in frames if not frame.empty]

    if not frames:
        return pd.DataFrame(), pd.DataFrame()

    every = pd.concat(frames, ignore_index=True)
    repeated = (every
                .groupby(["leader", "leader_name", "follower", "follower_name", "same_theme", "shared_theme"])
                .agg(days=("session_date", "nunique"),
                     mean_correlation=("correlation", "mean"))
                .reset_index()
                .sort_values(["days", "mean_correlation"], ascending=False))

    return every, repeated
