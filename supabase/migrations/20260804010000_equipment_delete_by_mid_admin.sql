-- ============================================================
-- 기자재 마스터: 중간관리자도 삭제할 수 있게 허용
-- ============================================================
-- room_equipment.equipment_id는 ON DELETE CASCADE라서, 기자재를 삭제하면
-- 그 기자재를 쓰던 다른 강의실에서도 자동으로 빠진다 (프론트에서 확인창으로 경고함).
CREATE POLICY equipment_delete_by_mid_admin ON equipment FOR DELETE
    USING (current_assistant_role() IN ('mid_admin', 'final_admin'));
