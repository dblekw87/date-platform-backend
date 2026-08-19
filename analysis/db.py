"""Read-only access to the collector's database.

The Node side owns every write. This side only ever reads, because a learning
run that could alter the record it learns from is a run nobody can repeat.

The connection string comes from the backend's own .env so there is one place
it is configured, not two.
"""

import os
import pathlib

import pandas as pd
import psycopg

BACKEND_ROOT = pathlib.Path(__file__).resolve().parent.parent


def database_url() -> str:
    env = BACKEND_ROOT / ".env"

    if "DATABASE_URL" in os.environ:
        return os.environ["DATABASE_URL"]

    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")

    raise RuntimeError("DATABASE_URL is not set and .env does not carry it")


def read(sql: str, params: tuple = ()) -> pd.DataFrame:
    # psycopg's own cursor rather than pandas.read_sql, which wants SQLAlchemy
    # and warns about anything else.
    with psycopg.connect(database_url()) as connection:
        with connection.cursor() as cursor:
            cursor.execute(sql, params)
            columns = [column.name for column in cursor.description]

            return pd.DataFrame(cursor.fetchall(), columns=columns)


def session_dates(market: str = "KR") -> list[str]:
    """The days that hold enough ticks to say anything about a day."""
    frame = read(
        """
        SELECT session_date::text AS session_date, count(*) AS rows,
               count(DISTINCT symbol) AS symbols,
               count(DISTINCT observed_at) AS ticks
        FROM market_price_samples
        WHERE market = %s
        GROUP BY 1
        HAVING count(DISTINCT observed_at) >= 20
        ORDER BY 1
        """,
        (market,),
    )

    return frame["session_date"].tolist()
