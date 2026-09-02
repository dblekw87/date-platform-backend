r"""How often a co-moving pair comes back.

    .\analysis\.venv\Scripts\python.exe analysis\run_persistence.py
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

# Windows gives a piped stdout cp949, which cannot encode the em-dash in the
# closing line. So the run died on its very last print every day since
# 2026-08-19: the pair list reached the log, and the one number this exercise
# exists to produce - how many repeated pairs the dictionary split apart -
# never did. Reconfigured here rather than in the .ps1 so it holds however the
# script is started.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

import comovement  # noqa: E402


def main() -> None:
    every, repeated = comovement.persistence()

    if every.empty:
        print("아직 상관을 잴 만한 날이 없습니다.")
        return

    days = every["session_date"].nunique()
    returning = repeated[repeated["days"] >= 2]

    print(f"\n동반 상승 쌍 · {days}일 · 상관 {comovement.CORRELATION_FLOOR} 이상\n")
    # 공통요인 몫을 같이 적습니다. 큰 날은 테마가 아니라 시장이 움직인 날이고,
    # 그런 날 쌍이 적게 나오는 것은 측정이 조용한 것이지 고장난 것이 아닙니다.
    daily = every.groupby("session_date").agg(pairs=("leader", "size"),
                                              factor=("factor_share", "max"))

    for day, row in daily.iterrows():
        print(f"  {day}  {int(row['pairs']):>5}쌍   시장몫 {100 * row['factor']:>4.0f}%")
    print(f"\n  전체 {len(every)}쌍 · 고유 방향쌍 {len(repeated)} · 2일 이상 반복 {len(returning)}")
    # 두 줄인 이유는 둘이 다른 질문이기 때문입니다. 라벨이 같은가는 화면이 무엇을
    # 찍는가이고, 사전이 둘을 함께 두는가는 분류가 실제로 놓쳤는가입니다.
    print(f"  화면 라벨이 같던 비율 {100 * every['same_theme'].mean():.1f}%")
    print(f"  사전이 한 테마에 함께 두던 비율 {100 * every['shared_theme'].mean():.1f}%")

    if returning.empty:
        print("\n  반복된 쌍이 아직 없습니다. 하루로는 우연과 구분되지 않습니다.\n")
        return

    print("\n반복된 쌍 (큰 쪽 → 따라가는 쪽)\n")

    for _, row in returning.head(20).iterrows():
        mark = "같은 테마" if row["shared_theme"] else "테마 다름"

        if row["shared_theme"] and not row["same_theme"]:
            mark = "같은 테마(라벨만 다름)"

        print(f"  {str(row['leader_name'])[:16]:<17} -> {str(row['follower_name'])[:16]:<17}"
              f" {row['days']}일  corr {row['mean_correlation']:.3f}  {mark}")

    # 분류가 놓친 것은 **공유 테마가 하나도 없는** 쌍뿐입니다. 라벨만 다른 쌍은
    # 사전이 이미 잡고 있고, 화면이 대표 라벨 하나만 고르는 문제입니다 -- 고칠 곳이
    # 서로 달라 같이 세면 안 됩니다. 로봇 아홉 종목이 그 예입니다: 라벨은 넷으로
    # 갈리지만 kr_theme_members에서는 전부 로봇(산업용/협동로봇 등)에 함께 있습니다.
    missed = returning[~returning["shared_theme"]]
    relabelled = returning[returning["shared_theme"] & ~returning["same_theme"]]

    print(f"\n  이 중 {len(missed)}쌍은 공유 테마가 하나도 없습니다 — 분류가 놓친 곳입니다.")
    print(f"  {len(relabelled)}쌍은 사전에는 함께 있는데 화면 라벨만 갈립니다 — 대표 라벨 문제입니다.\n")


if __name__ == "__main__":
    main()
