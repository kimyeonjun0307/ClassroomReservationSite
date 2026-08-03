-- ============================================================
-- room_busy_slots: 예약자(assistant)가 "이 시간대 비어있는지"만 확인할 수 있게 해주는 뷰
-- ============================================================
-- bookings 테이블의 RLS(bookings_select)는 본인 신청 건만 보이게 되어 있음(다른 사람 예약 내용은
-- 프라이버시상 당연히 막아야 함). 그런데 그러면 예약자가 "이 시간에 이미 예약이 있는지"조차
-- 확인할 방법이 없어서, 목적/신청자 같은 민감정보는 빼고 room_id/date/start_time/end_time만
-- 노출하는 뷰를 따로 만든다.
--
-- 이 뷰는 postgres(테이블 소유자) 권한으로 실행되도록 SECURITY INVOKER를 끄고(기본값) 만들어서
-- bookings의 RLS를 우회한다 - Supabase/PostgreSQL에서 "RLS 걸린 테이블의 안전한 부분만 공개"할 때
-- 쓰는 표준 패턴.
CREATE OR REPLACE VIEW public.room_busy_slots AS
SELECT room_id, date, start_time, end_time
FROM public.bookings
WHERE status IN ('pending', 'approved');

GRANT SELECT ON public.room_busy_slots TO authenticated;
