"""How often a co-moving pair comes back.

    .\analysis\.venv\Scripts\python.exe analysis\run_persistence.py
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import comovement  # noqa: E402


def main() -> None:
    every, repeated = comovement.persistence()

    if every.empty:
        print("아직 상관을 잴 만한 날이 없습니다.")
        return

    days = every["session_date"].nunique()
    returning = repeated[repeated["days"] >= 2]

    print(f"\n동반 상승 쌍 · {days}일 · 상관 {comovement.CORRELATION_FLOOR} 이상\n")
    print(every.groupby("session_date").size().to_string())
    print(f"\n  전체 {len(every)}쌍 · 고유 방향쌍 {len(repeated)} · 2일 이상 반복 {len(returning)}")
    print(f"  이미 같은 테마로 묶여 있던 비율 {100 * every['same_theme'].mean():.1f}%")

    if returning.empty:
        print("\n  반복된 쌍이 아직 없습니다. 하루로는 우연과 구분되지 않습니다.\n")
        return

    print("\n반복된 쌍 (큰 쪽 → 따라가는 쪽)\n")

    for _, row in returning.head(20).iterrows():
        mark = "같은 테마" if row["same_theme"] else "테마 다름"
        print(f"  {str(row['leader_name'])[:16]:<17} -> {str(row['follower_name'])[:16]:<17}"
              f" {row['days']}일  corr {row['mean_correlation']:.3f}  {mark}")

    missed = returning[~returning["same_theme"]]

    print(f"\n  이 중 {len(missed)}쌍은 서로 다른 테마로 갈라져 있습니다 — 분류가 놓친 곳입니다.\n")


if __name__ == "__main__":
    main()
