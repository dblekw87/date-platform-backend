"""미국 섹터 지도 -- 핀비즈 S&P500 지도 모양.

섹터 칸은 시가총액 합, 그 안의 종목 칸은 각 종목 시가총액 크기입니다. 색은 국내 관행대로
상승 빨강 · 하락 파랑이고 +-3%에서 가장 진합니다. 섹터 이름 옆 숫자는 시가총액 가중 등락입니다
(지수처럼 읽히게. 08:20 섹터 순위의 중앙값과는 다른 자입니다).

데이터는 src/providers/us-sector-map.mjs가 JSON으로 넘깁니다. 백엔드 의존성을 늘리지 않으려고
그림만 파이썬에 맡깁니다 -- 이 PC에 matplotlib이 이미 있습니다.

    python scripts/render-us-sector-map.py <data.json> <out.png>
"""
import json
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import Rectangle

FONT = "C:/Windows/Fonts/malgunbd.ttf"
WIDTH, HEIGHT = 16.0, 10.0
TITLE_HEIGHT = 0.6
HEADER = 0.22
SATURATE = 3.0
BACKGROUND = "#111114"
# 지도 전체의 0.3%가 안 되는 섹터는 읽을 수 없는 실선이 되므로 "기타" 한 칸으로 모읍니다.
# 0.7%였을 때 10-16의 1등 섹터 방산(RTX·LMT·NOC)이 기타에 묻혔습니다.
SMALL_SECTOR = 0.003


def worst_ratio(row, side):
    total = sum(row)

    return max(max(side * side * r / (total * total), (total * total) / (side * side * r)) for r in row)


def squarify(values, x, y, w, h):
    """Squarified treemap (Bruls, Huizing, van Wijk). values are sorted descending and sum to w * h."""
    rects = []
    values = list(values)

    while values:
        side = min(w, h)
        row = [values.pop(0)]

        while values and worst_ratio(row + [values[0]], side) <= worst_ratio(row, side):
            row.append(values.pop(0))

        total = sum(row)

        if w >= h:
            column = total / h
            cy = y
            for r in row:
                rects.append((x, cy, column, r / column))
                cy += r / column
            x, w = x + column, w - column
        else:
            band = total / w
            cx = x
            for r in row:
                rects.append((cx, y, r / band, band))
                cx += r / band
            y, h = y + band, h - band

    return rects


def layout(items, x, y, w, h):
    total = sum(item["size"] for item in items)

    return squarify([item["size"] * w * h / total for item in items], x, y, w, h)


def color(rate):
    t = max(-1.0, min(1.0, rate / SATURATE))
    gray = (0.25, 0.25, 0.27)
    target = (0.86, 0.12, 0.15) if t > 0 else (0.12, 0.35, 0.86)

    return tuple(g + (c - g) * abs(t) for g, c in zip(gray, target))


def group_sectors(stocks):
    total = sum(s["size"] for s in stocks)
    sectors = {}

    for s in stocks:
        sectors.setdefault(s["sector"], []).append(s)

    small = [k for k, v in sectors.items() if sum(s["size"] for s in v) < total * SMALL_SECTOR]

    if len(small) > 1:
        rest = sectors.setdefault("기타", [])
        for k in small:
            if k != "기타":
                rest.extend(sectors.pop(k))

    groups = []

    for name, members in sectors.items():
        size = sum(s["size"] for s in members)
        members.sort(key=lambda s: -s["size"])
        groups.append({
            "members": members,
            "name": name,
            "rate": sum(s["size"] * s["rate"] for s in members) / size,
            "size": size,
        })

    return sorted(groups, key=lambda g: -g["size"])


def main(source, out):
    font_manager.fontManager.addfont(FONT)
    plt.rcParams["font.family"] = font_manager.FontProperties(fname=FONT).get_name()

    with open(source, encoding="utf-8") as handle:
        data = json.load(handle)

    stocks = [dict(s, size=s["cap"]) for s in data["stocks"] if s.get("cap") and s["cap"] > 0]
    groups = group_sectors(stocks)

    fig = plt.figure(figsize=(WIDTH, HEIGHT + TITLE_HEIGHT), dpi=110, facecolor=BACKGROUND)
    ax = fig.add_axes([0, 0, 1, HEIGHT / (HEIGHT + TITLE_HEIGHT)])
    ax.set_xlim(0, WIDTH)
    ax.set_ylim(HEIGHT, 0)
    ax.axis("off")

    for group, (gx, gy, gw, gh) in zip(groups, layout(groups, 0, 0, WIDTH, HEIGHT)):
        ax.add_patch(Rectangle((gx, gy), gw, gh, facecolor=BACKGROUND, edgecolor=BACKGROUND, linewidth=2))
        header = HEADER if gh > HEADER * 2.5 and gw > 0.5 else 0

        if header:
            ax.text(gx + 0.05, gy + header / 2, f"{group['name']} {group['rate']:+.1f}%", color="white",
                    fontsize=9 if gw > 1.4 else 7, va="center", ha="left", clip_on=True)

        for stock, (sx, sy, sw, sh) in zip(group["members"], layout(group["members"], gx, gy + header, gw, gh - header)):
            ax.add_patch(Rectangle((sx, sy), sw, sh, facecolor=color(stock["rate"]), edgecolor=BACKGROUND, linewidth=0.6))

            if sw < 0.32 or sh < 0.2 or sw * sh < 0.09:
                continue

            size = max(6.0, min(22.0, ((sw * sh) ** 0.5) * 11))
            ax.text(sx + sw / 2, sy + sh / 2 - sh * 0.08, stock["symbol"], color="white", fontsize=size,
                    ha="center", va="center", clip_on=True)

            if sh > 0.34:
                ax.text(sx + sw / 2, sy + sh / 2 + size / 72 * 0.9, f"{stock['rate']:+.2f}%", color="white",
                        fontsize=size * 0.62, ha="center", va="center", clip_on=True)

    title = (f"미국 시총 상위 {len(stocks)}종목 · 섹터별  |  {data['sessionDate']} 정규장  |  "
             f"빨강 상승 · 파랑 하락 (±{SATURATE:.0f}%에서 가장 진함)")
    fig.text(0.01, 1 - (TITLE_HEIGHT / 2) / (HEIGHT + TITLE_HEIGHT), title, color="white", fontsize=13, va="center")
    fig.savefig(out, facecolor=fig.get_facecolor())


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
