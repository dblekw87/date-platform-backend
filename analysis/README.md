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

## 왜 파이썬인가

JS 쪽 `npm run theme:candidates`는 **하루**를 묶습니다. 여기가 맡는 것은 하루로는
알 수 없는 것 — **같은 쌍이 다시 오는가**입니다. 한 번 같이 움직인 쌍은 우연이고
매주 같이 움직이는 쌍이 테마입니다.
