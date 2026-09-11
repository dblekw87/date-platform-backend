import { query } from "../db/client.mjs";

/**
 * 오늘 이미 나간 알림의 기록. 알림 모듈이 전부 이것으로 중복을 막습니다.
 *
 * 프로세스 메모리(Map·Set)에 두던 시절, 2026-09-11 11:15 장중 재기동 한 번에
 * 오전에 나간 짝꿍 여섯 통이 같은 등급으로 다시 발송됐습니다. 그날 재기동은
 * 세 번이었고, 두 번 오는 알림은 읽지 않게 됩니다.
 *
 * 규칙은 두 가지입니다. **보낸 뒤에만 적습니다** -- 실패한 것을 보냈다고 적으면
 * 영영 다시 안 보냅니다. **등급은 내려가지 않습니다** -- 짝꿍처럼 등급이 오를 때
 * 다시 보내는 알림이 낮은 등급으로 덮어쓰면 다음 틱에 같은 알림이 또 갑니다.
 *
 * 표는 alert_sent(kind, session_date, key). kind별 key의 뜻은 마이그레이션 036에.
 */

/** 오늘 이 kind로 보낸 것. key → { note, rank, sentAt }. 틱마다 한 번 읽습니다. */
export async function loadAlertSent(config, kind, day) {
  const { rows } = await query(config, `
    SELECT key, rank, note, sent_at FROM alert_sent
     WHERE kind = $1 AND session_date = $2::date`, [kind, day]);

  return new Map(rows.map((row) => [row.key, { note: row.note, rank: Number(row.rank), sentAt: row.sent_at }]));
}

/** 보낸 뒤에 적습니다. 같은 키가 다시 오면 등급은 높은 쪽을, note와 시각은 새 것을 남깁니다. */
export async function markAlertSent(config, kind, day, key, { note = null, rank = 0 } = {}) {
  await query(config, `
    INSERT INTO alert_sent (kind, session_date, key, rank, note)
    VALUES ($1, $2::date, $3, $4, $5)
    ON CONFLICT (kind, session_date, key) DO UPDATE
      SET rank = GREATEST(alert_sent.rank, EXCLUDED.rank), note = EXCLUDED.note, sent_at = now()`,
    [kind, day, key, rank, note]);
}
