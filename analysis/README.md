# analysis

학습·측정용 파이썬입니다. **PostgreSQL만 공유하고 읽기만 합니다** — 쓰기는 전부
Node 쪽이 합니다. 학습 실행이 자기가 배울 기록을 바꿀 수 있으면 아무도 그 실행을
재현할 수 없기 때문입니다.

```powershell
python -m venv analysis\.venv
.\analysis\.venv\Scripts\python.exe -m pip install -r analysis\requirements.txt
.\analysis\.venv\Scripts\python.exe analysis\run_persistence.py
```

`DATABASE_URL`은 백엔드 `.env`에서 그대로 읽습니다.

| 파일 | 하는 일 |
|---|---|
| `db.py` | 읽기 전용 커넥션과 세션 일자 목록 |
| `comovement.py` | 하루치 틱 차분 상관 → 방향 있는 쌍, 그리고 며칠에 걸친 반복 |
| `run_persistence.py` | 위를 돌려서 결과를 출력 |
| `pullback.py` | 눌림 숫자를 창 길이별로 다시 재고, 모델에게 축을 묻습니다 |

`pullback.py`는 **신호를 내지 않습니다.** 눌림은 319개 장 147,256건에서 D+5 초과분
중앙 -1.57%p·상회 41%로 반증돼 있는데, 2026-07-07 이후 짧은 창만 보면 플러스로
보입니다. 그래서 창을 40·60·120·240·전체로 잘라 같은 칸을 매일 다시 찍습니다 --
부호가 창 길이로 뒤집히면 그 칸은 신호가 아니라 그 구간입니다. 결과는
`daily/pullback-track.csv`에 하루 한 줄씩 쌓여서 숫자가 어디로 가는지 파일 하나로
읽힙니다.

모델(`HistGradientBoostingRegressor`)의 쓸모는 예측이 아니라 **축 발굴**입니다.
교차검증을 `GroupKFold`로 **날짜 단위**로 자릅니다 -- 무작위로 자르면 같은 날 다른
종목이 train과 test에 갈려 들어가 시장 요인을 통해 답이 새고 점수가 부풀어 오릅니다.
성적은 평균이 아니라 **중앙값과 장 단위 플러스율**로 읽습니다.

## 왜 파이썬인가

JS 쪽 `npm run theme:candidates`는 **하루**를 묶습니다. 여기가 맡는 것은 하루로는
알 수 없는 것 — **같은 쌍이 다시 오는가**입니다. 한 번 같이 움직인 쌍은 우연이고
매주 같이 움직이는 쌍이 테마입니다.
