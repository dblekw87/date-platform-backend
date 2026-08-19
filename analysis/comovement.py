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


def day_pairs(session_date: str, market: str = "KR") -> pd.DataFrame:
    frame = load_day(session_date, market)

    if frame.empty:
        return pd.DataFrame()

    liquid = liquid_symbols(frame)
    returns = tick_returns(frame)
    shared = [symbol for symbol in returns.columns if symbol in liquid.index]

    if len(shared) < 2:
        return pd.DataFrame()

    correlations = returns[shared].corr(min_periods=MINIMUM_TICKS)
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
            "same_theme": bool(liquid.loc[leader, "theme"] == liquid.loc[follower, "theme"]),
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
                .groupby(["leader", "leader_name", "follower", "follower_name", "same_theme"])
                .agg(days=("session_date", "nunique"),
                     mean_correlation=("correlation", "mean"))
                .reset_index()
                .sort_values(["days", "mean_correlation"], ascending=False))

    return every, repeated
