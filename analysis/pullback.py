"""눌림 매매를 매일 다시 재고, 모델이 못 본 축을 찾게 합니다.

사용자 요청(2026-10-08): "데이터 수집하고 학습 부탁해 매일매일."

**이 트랙은 매매 신호를 내지 않습니다.** 눌림은 319개 장 147,256건에서 D+5 초과분
중앙 -1.57%p·상회 41%로 반증돼 있습니다. 그런데 2026-07-07 이후 52개 장만 보면
같은 대조군이 **플러스**로 보입니다. 그래서 하는 일은 둘입니다.

  1. 창이 길어질수록 숫자가 어디로 가는지 매일 적는다 (사다리)
  2. 모델에게 **내가 안 재본 축이 있는지**만 묻는다 (중요도)

모델 예측을 진입 근거로 쓰지 않는 이유는 pair-persistence-track에서 배운 그것과
같습니다 -- 라벨이 베타에 끌려 있으면 모델은 베타를 신호라고 배웁니다. 그래서
**교차검증을 날짜 블록으로 자르고**(같은 날이 train/test에 갈리면 점수가 부풀고),
성적은 평균이 아니라 **중앙값과 장 단위 플러스율**로 봅니다. 2026-10-08에 평균만
보고 "전부 플러스"라고 읽었다가 중앙값을 내서 뒤집힌 적이 있습니다.
"""

import datetime
import pathlib

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.inspection import permutation_importance
from sklearn.model_selection import GroupKFold

from db import read

DAILY = pathlib.Path(__file__).resolve().parent / "daily"
TRACK = DAILY / "pullback-track.csv"

# 거래대금 10억 미만은 며칠 뒤 수익률이 호가 몇 칸에 좌우됩니다.
MIN_TURNOVER = 1_000_000_000
# 앞선 급등이 있어야 눌림입니다. 25% 못 오른 종목의 하락은 그냥 하락입니다.
MIN_RUNUP = 0.25
# 재료로 치는 공시 태그. 정기·안내·주의·해명은 재료가 아닙니다.
REASON_TAGS = ("실적", "계약·수주", "설비투자", "인수합병", "경영권", "증자·지분", "자금거래", "주주환원")

QUERY = """
WITH base AS (
  SELECT symbol, session_date, open, high, low, close, volume,
         avg(close) OVER w5 AS ma5,
         avg(close) OVER w20 AS ma20,
         avg(close) OVER w60 AS ma60,
         max(close) OVER wpeak AS peak,
         min(close) OVER wtrough AS trough,
         max(close) OVER wprior AS prior_high,
         max(volume) OVER wpeak AS peak_volume,
         avg(volume) OVER w20 AS vol20,
         count(*) OVER wcnt AS history,
         lead(close, 1) OVER ws AS c1,
         lead(close, 5) OVER ws AS c5,
         lead(close, 10) OVER ws AS c10
    FROM kr_daily_bars
  WINDOW ws AS (PARTITION BY symbol ORDER BY session_date),
         w5 AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 4 PRECEDING AND CURRENT ROW),
         w20 AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 19 PRECEDING AND CURRENT ROW),
         w60 AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 59 PRECEDING AND CURRENT ROW),
         wpeak AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 15 PRECEDING AND 1 PRECEDING),
         wtrough AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 40 PRECEDING AND 1 PRECEDING),
         wprior AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 100 PRECEDING AND 41 PRECEDING),
         wcnt AS (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 100 PRECEDING AND CURRENT ROW)
),
/* 시장. open > 0이 없으면 1590865행 중 4283행이 -100퍼센트로 세어져 시장 평균을
   1.3포인트 밀고, 모든 초과분이 부풀어 오릅니다(measurement-pitfalls).
   퍼센트 기호는 psycopg가 자리표로 읽으므로 이 쿼리 안에서는 쓰지 않습니다. */
market AS (
  SELECT session_date,
         avg((c1 / close - 1) * 100) AS m1,
         avg((c5 / close - 1) * 100) AS m5,
         avg((c10 / close - 1) * 100) AS m10,
         avg(CASE WHEN close > ma20 THEN 1.0 ELSE 0 END) AS breadth
    FROM base
   WHERE close > 0 AND open > 0 AND ma20 > 0 AND c10 IS NOT NULL
   GROUP BY session_date HAVING count(*) >= 100
),
reason AS (
  SELECT DISTINCT symbol, session_date
    FROM market_disclosures, unnest(tags) AS tag
   WHERE market = 'KR' AND symbol IS NOT NULL AND session_date IS NOT NULL
     AND tag = ANY(%s)
),
/* 외국인 수급은 2026-07-07부터만 있습니다. KIS가 종목당 30세션씩만 주므로 과거로
   늘릴 수 없고 하루에 하루씩만 쌓입니다. 그래서 LEFT JOIN입니다 -- 없는 구간을
   버리면 긴 창을 잃습니다. */
flow AS (
  SELECT symbol, session_date, foreign_qty AS f,
         sum(CASE WHEN foreign_qty < 0 THEN 1 ELSE 0 END)
           OVER (PARTITION BY symbol ORDER BY session_date ROWS BETWEEN 5 PRECEDING AND 1 PRECEDING) AS selldays5
    FROM kr_investor_flow
)
SELECT s.session_date::text AS d, s.symbol,
       s.volume::float8 / s.peak_volume AS vol_ratio,
       s.volume::float8 / nullif(s.vol20, 0) AS vol_vs20,
       (s.peak / s.trough - 1) * 100 AS runup,
       (s.peak - s.close) / nullif(s.peak - s.trough, 0) * 100 AS retrace,
       (s.close / nullif(s.ma5, 0) - 1) * 100 AS vs_ma5,
       (s.close / nullif(s.ma20, 0) - 1) * 100 AS vs_ma20,
       (s.close / nullif(s.ma60, 0) - 1) * 100 AS vs_ma60,
       (s.close / nullif(s.prior_high, 0) - 1) * 100 AS vs_prior,
       (s.high - s.close) / nullif(s.high - s.low, 0) * 100 AS upper_tail,
       (s.close / nullif(s.open, 0) - 1) * 100 AS body,
       ln(s.close * s.volume) AS log_turnover,
       m.breadth * 100 AS breadth,
       (s.low <= s.ma5 * 1.01 AND s.close >= s.ma5 * 0.99)::int AS at_ma5,
       (s.low <= s.ma20 * 1.01 AND s.close >= s.ma20 * 0.99)::int AS at_ma20,
       (s.prior_high > 0 AND s.low <= s.prior_high * 1.03 AND s.close >= s.prior_high)::int AS at_prior,
       (EXISTS (SELECT 1 FROM reason r WHERE r.symbol = s.symbol
                 AND r.session_date BETWEEN s.session_date - 21 AND s.session_date - 1))::int AS wave_reason,
       (EXISTS (SELECT 1 FROM reason r WHERE r.symbol = s.symbol
                 AND r.session_date = s.session_date))::int AS entry_reason,
       fl.f::float8 AS foreign_qty,
       fl.selldays5::float8 AS foreign_selldays,
       (s.c1 / s.close - 1) * 100 - m.m1 AS e1,
       (s.c5 / s.close - 1) * 100 - m.m5 AS e5,
       (s.c10 / s.close - 1) * 100 - m.m10 AS e10
  FROM base s
  JOIN market m ON m.session_date = s.session_date
  LEFT JOIN flow fl ON fl.symbol = s.symbol AND fl.session_date = s.session_date
 WHERE s.history >= 101 AND s.close > 0 AND s.open > 0 AND s.trough > 0 AND s.peak > 0
   AND s.peak_volume > 0 AND s.c10 IS NOT NULL
   AND s.close * s.volume >= %s
   AND s.peak / s.trough - 1 >= %s
   AND s.close < s.peak * 0.97
"""

FEATURES = [
    "vol_ratio", "vol_vs20", "runup", "retrace", "vs_ma5", "vs_ma20", "vs_ma60",
    "vs_prior", "upper_tail", "body", "log_turnover", "breadth",
    "at_ma5", "at_ma20", "at_prior", "wave_reason", "entry_reason",
]


def cell(frame: pd.DataFrame, horizon: int) -> dict | None:
    """한 칸의 성적. 평균만 내면 꼬리 몇 건이 전부 플러스로 보입니다."""
    if len(frame) < 20:
        return None

    excess = frame[f"e{horizon}"].astype(float)
    by_day = frame.groupby("d")[f"e{horizon}"].mean()

    return {
        "beat": (excess > 0).mean() * 100,
        "day_plus": (by_day > 0).mean() * 100,
        "days": frame["d"].nunique(),
        "mean": excess.mean(),
        "median": excess.median(),
        "n": len(frame),
    }


def show(label: str, frame: pd.DataFrame, horizon: int) -> None:
    stats = cell(frame, horizon)

    if stats is None:
        print(f"  {label:<30} {len(frame):>6}건 — 20건 미만")

        return

    print(
        f"  {label:<30} {stats['n']:>6}건/{stats['days']:>3}장"
        f" · 평균 {stats['mean']:+7.2f} · 중앙 {stats['median']:+7.2f}"
        f" · 상회 {stats['beat']:>3.0f}% · 장 플러스 {stats['day_plus']:>3.0f}%"
    )


def ladder(rows: pd.DataFrame, horizon: int = 5) -> None:
    """창을 짧게 잘라가며 같은 칸을 재면 국면에 끌린 정도가 보입니다.

    2026-10-08에 52장으로 재니 대조군이 +0.98%p였는데 319장에서는 -0.19%p였습니다.
    부호가 창 길이로 뒤집히면 그 칸은 신호가 아니라 그 구간입니다.
    """
    days = sorted(rows["d"].unique())

    print(f"\n=== 창 길이 사다리 (D+{horizon} 중앙값) ===\n")
    print(f"  {'창':<14} {'눌림 전체':>12} {'20일선+마름':>14} {'+재료':>10}")

    def median_of(frame: pd.DataFrame) -> str:
        stats = cell(frame, horizon)

        return f"{stats['median']:+.2f}" if stats else "—"

    for window in (40, 60, 120, 240, len(days)):
        if window > len(days):
            continue

        recent = rows[rows["d"].isin(days[-window:])]
        stack = recent[(recent["at_ma20"] == 1) & (recent["vol_ratio"] <= 0.3)]
        tag = f"{window}장" + (" (전체)" if window == len(days) else "")

        print(f"  {tag:<14} {median_of(recent):>12} {median_of(stack):>14}"
              f" {median_of(stack[stack['wave_reason'] == 1]):>10}")


def learn(rows: pd.DataFrame, horizon: int = 5) -> dict:
    """모델에게 묻는 것은 예측이 아니라 '내가 안 본 축이 있나'입니다.

    교차검증을 **날짜로 묶어** 자릅니다. 무작위로 자르면 같은 날 다른 종목이
    train과 test에 갈려 들어가 시장 요인을 통해 답이 새고, 점수가 부풀어 오릅니다.
    """
    frame = rows.dropna(subset=FEATURES + [f"e{horizon}"]).copy()

    if frame["d"].nunique() < 40:
        print("\n학습: 장이 40개 미만이라 건너뜁니다.")

        return {}

    features = frame[FEATURES].astype(float).to_numpy()
    target = frame[f"e{horizon}"].astype(float).to_numpy()
    folds = GroupKFold(n_splits=5)
    splits = list(folds.split(features, target, frame["d"].to_numpy()))
    predicted = np.full(len(target), np.nan)

    def fresh() -> HistGradientBoostingRegressor:
        return HistGradientBoostingRegressor(
            learning_rate=0.05, max_depth=4, max_iter=200, min_samples_leaf=200, random_state=7
        )

    for train, test in splits:
        model = fresh()
        model.fit(features[train], target[train])
        predicted[test] = model.predict(features[test])

    frame["predicted"] = predicted
    edge = frame["predicted"].quantile(0.9)
    top = frame[frame["predicted"] >= edge]

    print(f"\n=== 학습 (D+{horizon} · 날짜 블록 5겹 · {len(frame):,}건/{frame['d'].nunique()}장) ===\n")
    show("모델 상위 10%", top, horizon)
    show("나머지 90%", frame[frame["predicted"] < edge], horizon)
    print(f"\n  예측-실제 상관 {np.corrcoef(predicted, target)[0, 1]:+.3f}")

    # 중요도는 마지막 겹의 홀드아웃에서만 봅니다 -- 전체로 재면 학습에 쓴 날이 섞입니다.
    train, test = splits[-1]
    model = fresh()
    model.fit(features[train], target[train])
    gain = permutation_importance(
        model, features[test], target[test], n_repeats=5, random_state=7, scoring="r2"
    )
    order = np.argsort(gain.importances_mean)[::-1]

    print("\n  축 중요도 (상위 8 · 홀드아웃 블록)\n")

    for index in order[:8]:
        print(f"    {FEATURES[index]:<16} {gain.importances_mean[index]:+.5f}")

    stats = cell(top, horizon) or {}

    return {
        "model_corr": float(np.corrcoef(predicted, target)[0, 1]),
        "model_top_day_plus": stats.get("day_plus"),
        "model_top_median": stats.get("median"),
        "top_axis": FEATURES[order[0]],
    }


def main() -> None:
    rows = read(QUERY, (list(REASON_TAGS), MIN_TURNOVER, MIN_RUNUP))

    for column in FEATURES + ["e1", "e5", "e10", "foreign_qty", "foreign_selldays"]:
        rows[column] = pd.to_numeric(rows[column], errors="coerce")

    days = rows["d"].nunique()

    print(f"\n눌림 {len(rows):,} 종목-일 · {days}개 장 · {rows['d'].min()} ~ {rows['d'].max()}")
    print(f"재료는 공시 기준({len(REASON_TAGS)}개 태그) · 외국인 수급이 있는 행 "
          f"{rows['foreign_qty'].notna().sum():,}개\n")

    for horizon in (1, 5, 10):
        print(f"=== D+{horizon} 초과분(%p) ===\n")
        show("눌림 전체", rows, horizon)
        show("급등에 재료 있었음", rows[rows["wave_reason"] == 1], horizon)
        show("급등에 재료 없었음", rows[rows["wave_reason"] == 0], horizon)
        show("20일선+마름(30%)", rows[(rows["at_ma20"] == 1) & (rows["vol_ratio"] <= 0.3)], horizon)
        print("")

    flow = rows[rows["foreign_qty"].notna()]

    if len(flow):
        stopped = flow[(flow["foreign_selldays"] >= 4) & (flow["foreign_qty"] >= 0)]
        stack = stopped[(stopped["at_ma20"] == 1) & (stopped["vol_ratio"] <= 0.3)]

        print(f"=== 외국인 수급 구간만 ({flow['d'].nunique()}장) · D+5 ===\n")
        show("수급 구간 눌림 전체", flow, 5)
        show("외인 매도 멈춤", stopped, 5)
        show("3단 (20일선·마름·멈춤)", stack, 5)
        print("")

    ladder(rows)
    learned = learn(rows)

    # 한 줄씩 쌓아 두면 숫자가 창과 함께 어디로 가는지 파일 하나로 읽힙니다.
    whole = cell(rows, 5) or {}
    stack = cell(rows[(rows["at_ma20"] == 1) & (rows["vol_ratio"] <= 0.3)], 5) or {}

    DAILY.mkdir(parents=True, exist_ok=True)

    record = {
        "all_day_plus": whole.get("day_plus"),
        "all_median": whole.get("median"),
        "days": days,
        "flow_days": int(flow["d"].nunique()) if len(flow) else 0,
        "ran_on": datetime.date.today().isoformat(),
        "rows": len(rows),
        "stack_day_plus": stack.get("day_plus"),
        "stack_median": stack.get("median"),
        "stack_n": stack.get("n"),
        **learned,
    }

    pd.DataFrame([record]).to_csv(
        TRACK, mode="a", header=not TRACK.exists(), index=False, encoding="utf-8"
    )
    print(f"\n한 줄 적음 -> {TRACK}")


if __name__ == "__main__":
    main()
