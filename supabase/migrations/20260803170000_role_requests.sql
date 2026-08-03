-- ============================================================
-- 회원가입 시 중간관리자/최종관리자 "신청" 기능 (승인 대기 방식)
-- ============================================================
-- 가입 화면에서 희망 역할을 고를 수 있게 하되, assistant 외의 역할은 즉시 부여하지 않고
-- role_requests에 대기 상태로 쌓아서 기존 final_admin이 승인해야 실제 role이 바뀌게 한다.
-- (가입 화면에서 바로 최종관리자를 자기 마음대로 고를 수 있게 하면 보안 구멍이 됨)

CREATE TYPE role_request_status AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE role_requests (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    assistant_id    UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    requested_role  assistant_role NOT NULL,
    status          role_request_status NOT NULL DEFAULT 'pending',
    reviewed_by     UUID REFERENCES assistants(id),
    reviewed_at     TIMESTAMPTZ,
    comment         TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (requested_role IN ('mid_admin', 'final_admin'))
);

CREATE INDEX idx_role_requests_status ON role_requests (status);

ALTER TABLE role_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY role_requests_select ON role_requests FOR SELECT
    USING (assistant_id = auth.uid() OR current_assistant_role() = 'final_admin');

-- 트리거(SECURITY DEFINER)가 만드는 요청은 RLS를 우회하지만, 혹시 나중에 앱에서 직접
-- 신청서를 또 넣는 기능을 만들 경우를 대비해 본인 명의 INSERT도 허용해둠
CREATE POLICY role_requests_insert_self ON role_requests FOR INSERT
    WITH CHECK (assistant_id = auth.uid());

CREATE POLICY role_requests_review_by_final_admin ON role_requests FOR UPDATE
    USING (current_assistant_role() = 'final_admin')
    WITH CHECK (current_assistant_role() = 'final_admin');

-- ---------- 가입 트리거 확장: 메타데이터에 desired_role이 있으면 신청서도 같이 생성 ----------
CREATE OR REPLACE FUNCTION public.handle_new_assistant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    desired_role text;
BEGIN
    INSERT INTO public.assistants (id, name, role)
    VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'name', NEW.email), 'assistant');

    desired_role := NEW.raw_user_meta_data->>'desired_role';
    IF desired_role IN ('mid_admin', 'final_admin') THEN
        INSERT INTO public.role_requests (assistant_id, requested_role)
        VALUES (NEW.id, desired_role::assistant_role);
    END IF;

    RETURN NEW;
END;
$$;
