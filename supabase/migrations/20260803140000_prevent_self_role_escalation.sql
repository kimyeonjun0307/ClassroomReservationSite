-- ============================================================
-- 보안 수정: 본인이 role/building_id를 스스로 바꾸는 것을 막음
-- ============================================================
-- assistants_update_self 정책은 "본인 행인지"만 확인하고 "어떤 컬럼을 바꾸는지"는
-- 확인하지 않아서, 로그인한 일반 assistant가 자기 role을 final_admin으로
-- 셀프 승격시킬 수 있는 구멍이 있었다. RLS는 행 단위 접근만 통제하기 때문에
-- 컬럼 단위 통제는 트리거로 막는다.
CREATE OR REPLACE FUNCTION public.prevent_self_role_escalation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    -- SQL Editor/서비스 롤로 직접 실행할 때는 auth.uid()가 NULL이라 그대로 통과시킴
    -- (최초 final_admin을 만드는 부트스트랩 경로는 이걸 통해서만 가능해야 함)
    IF auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;

    IF (NEW.role IS DISTINCT FROM OLD.role OR NEW.building_id IS DISTINCT FROM OLD.building_id)
       AND current_assistant_role() <> 'final_admin' THEN
        RAISE EXCEPTION 'role, building_id는 final_admin만 변경할 수 있습니다';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_self_role_escalation ON assistants;
CREATE TRIGGER trg_prevent_self_role_escalation
    BEFORE UPDATE ON assistants
    FOR EACH ROW EXECUTE FUNCTION public.prevent_self_role_escalation();
