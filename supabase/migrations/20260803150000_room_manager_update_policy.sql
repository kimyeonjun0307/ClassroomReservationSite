-- ============================================================
-- rooms: 담당 중간관리자가 자기 강의실 정보(이름/수용인원/이용수칙/문의처)를 수정할 수 있게 함
-- ============================================================
-- 기존 rooms_manage_by_final_admin 정책은 final_admin만 허용해서, manager.html의
-- "강의실 정보 수정" 기능(중간관리자가 직접 하는 화면)을 실행할 권한이 없었음.
CREATE POLICY rooms_update_by_manager ON rooms FOR UPDATE
    USING (manager_id = auth.uid())
    WITH CHECK (manager_id = auth.uid());
