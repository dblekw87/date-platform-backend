-- overlay를 실제로 쓰는 길.
--
-- 031이 kr_theme_overlay를 만들었지만 **아무 데서도 읽지 않았습니다.** 표만 있고
-- 경로가 없어서, 넣기로 결정했더라도 화면은 모르는 상태였습니다. 여기서 읽는 층을
-- 하나 만들고 모든 소비자를 그리로 옮깁니다.
--
-- 뷰인 이유는 소비자가 여덟 곳이기 때문입니다. UNION을 여덟 번 베껴 쓰면 한 곳만
-- 빠뜨려도 화면과 측정이 서로 다른 사전을 보게 되고, 그 어긋남은 조용합니다.
--
-- **theme_no는 이미 있는 테마의 번호를 물려받습니다.** overlay는 대개 "있는 테마에
-- 종목을 더 넣는" 일이라 그 테마의 번호를 그대로 쓰는 것이 맞습니다. 새 이름이면
-- 900000번대를 주어 대표 라벨 동점 처리에서 뒤로 갑니다 -- theme_no는 동점일 때만
-- 쓰이므로(naver-themes.mjs의 ORDER BY 마지막 항) 이 값이 판정을 뒤집지 않습니다.
--
-- **네이버가 나중에 같은 편입을 담으면 overlay 행은 조용히 무의미해집니다.**
-- NOT EXISTS가 중복을 막으므로 같은 짝이 두 번 세어지지 않습니다 -- 짝꿍 측정에서
-- 테마를 여럿 공유하는 짝이 표본을 24% 부풀렸던 것과 같은 종류의 사고입니다.

CREATE OR REPLACE VIEW kr_theme_membership AS
SELECT theme_no, theme_name, symbol, name, 'naver'::text AS origin
  FROM kr_theme_members
 UNION ALL
SELECT coalesce(known.theme_no, 900000) AS theme_no,
       o.theme_name, o.symbol, NULL::text AS name, 'overlay'::text AS origin
  FROM kr_theme_overlay o
  LEFT JOIN LATERAL (
    SELECT min(theme_no) AS theme_no
      FROM kr_theme_members m
     WHERE m.theme_name = o.theme_name
  ) known ON true
 WHERE o.approved
   AND NOT EXISTS (
     SELECT 1 FROM kr_theme_members m
      WHERE m.symbol = o.symbol AND m.theme_name = o.theme_name
   );

-- 승인 대기 행을 찾는 일이 잦습니다. 표가 작아 인덱스는 필요 없고, 조회만 한 곳에
-- 둡니다.
COMMENT ON VIEW kr_theme_membership IS
  '네이버 사전 + 승인된 overlay. 편입을 묻는 모든 코드는 이 뷰를 봅니다.';
