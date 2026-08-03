-- ============================================================
-- 최종관리자 권한 모델 정정: 건물 1개 담당 -> 전체 건물/강의실 총괄
-- ============================================================
-- 지금까지는 assistants.building_id로 final_admin을 건물 하나에 묶어놨었는데,
-- 실제 요구사항은 "최종관리자가 전체를 총괄하고, 중간관리자에게 강의실을 건물 무관하게
-- 골라서 배정한다"였음. building_id 스코프를 전부 걷어낸다.

-- ---------- 1. building_id를 참조하던 정책들 먼저 제거 ----------
DROP POLICY IF EXISTS assistants_manage_by_final_admin ON assistants;
DROP POLICY IF EXISTS buildings_update_by_final_admin ON buildings;
DROP POLICY IF EXISTS rooms_manage_by_final_admin ON rooms;
DROP POLICY IF EXISTS room_equipment_manage ON room_equipment;
DROP POLICY IF EXISTS class_schedules_manage ON class_schedules;
DROP POLICY IF EXISTS bookings_select ON bookings;

-- ---------- 2. assistants.building_id 컬럼 제거 ----------
ALTER TABLE assistants DROP CONSTRAINT IF EXISTS fk_assistants_building;
ALTER TABLE assistants DROP COLUMN IF EXISTS building_id;

-- ---------- 3. 이제 안 쓰는 헬퍼 함수 제거 ----------
DROP FUNCTION IF EXISTS public.current_building_id();

-- ---------- 4. 셀프 승격 방지 트리거: building_id 체크 제거 ----------
CREATE OR REPLACE FUNCTION public.prevent_self_role_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role AND current_assistant_role() <> 'final_admin' THEN
        RAISE EXCEPTION 'role은 final_admin만 변경할 수 있습니다';
    END IF;
    RETURN NEW;
END;
$$;

-- ---------- 5. 정책 재작성 (건물 스코프 없이 전체 허용) ----------
CREATE POLICY assistants_manage_by_final_admin ON assistants FOR UPDATE
    USING (current_assistant_role() = 'final_admin')
    WITH CHECK (current_assistant_role() = 'final_admin');

-- buildings: 조회는 전체 공개(buildings_select 기존 유지), 등록/수정/삭제는 final_admin 누구나
CREATE POLICY buildings_manage_by_final_admin ON buildings FOR ALL
    USING (current_assistant_role() = 'final_admin')
    WITH CHECK (current_assistant_role() = 'final_admin');

CREATE POLICY rooms_manage_by_final_admin ON rooms FOR ALL
    USING (current_assistant_role() = 'final_admin')
    WITH CHECK (current_assistant_role() = 'final_admin');

CREATE POLICY room_equipment_manage ON room_equipment FOR ALL
    USING (is_manager_of_room(room_id) OR current_assistant_role() = 'final_admin')
    WITH CHECK (is_manager_of_room(room_id) OR current_assistant_role() = 'final_admin');

CREATE POLICY class_schedules_manage ON class_schedules FOR ALL
    USING (is_manager_of_room(room_id) OR current_assistant_role() = 'final_admin')
    WITH CHECK (is_manager_of_room(room_id) OR current_assistant_role() = 'final_admin');

-- bookings 조회: 신청자 본인 / 담당 중간관리자 / final_admin(전체 오버사이트)
CREATE POLICY bookings_select ON bookings FOR SELECT
    USING (
        requester_id = auth.uid()
        OR is_manager_of_room(room_id)
        OR current_assistant_role() = 'final_admin'
    );
