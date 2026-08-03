-- ============================================================
-- 기자재 마스터: 중간관리자도 새 종류를 추가할 수 있게 허용
-- ============================================================
-- equipment는 이름 목록일 뿐이라 mid_admin이 추가해도 권한 상승 위험이 없음.
-- 기존 equipment_manage(final_admin 전용) 정책은 그대로 두고, mid_admin용 INSERT만 별도로 추가.
CREATE POLICY equipment_insert_by_mid_admin ON equipment FOR INSERT
    WITH CHECK (current_assistant_role() IN ('mid_admin', 'final_admin'));
