-- ============================================================
-- 동서대학교 강의실(공간) 예약 시스템 - 실제 배포 DB 스키마
-- Supabase project: yclrlgcixldovbhygjrc (2026-09 새로 만든 계정)
--
-- 이 파일은 손으로 짠 설계안이 아니라, 2026-09-08에 SQL Editor에서
--   information_schema.columns / pg_policies / pg_type(enum) / pg_proc(함수)
-- 를 직접 조회해서 "실제로 지금 이렇게 배포되어 있다"를 그대로 옮겨 적은 문서입니다.
--
-- 주의: PRIMARY KEY / FOREIGN KEY / UNIQUE / CHECK 제약조건의 정확한 이름과
-- 존재 여부는 조회하지 않았습니다 (information_schema.table_constraints 미조회).
-- 아래 REFERENCES/PRIMARY KEY 표시는 컬럼명 패턴(room_id→rooms.id 등)과
-- 실제 화면 코드의 동작으로 미루어 "추정"한 것이라, 정확한 제약조건이 필요하면
-- information_schema.table_constraints / key_column_usage를 추가로 조회해야 합니다.
--
-- 이전 버전(git 이력 참고)은 팀원 초안을 반영한 훨씬 큰 설계 문서였는데(assistants,
-- room_status, booking_logs, role_requests, inquiries 등 포함), 실제로 새 계정에
-- 배포된 스키마는 그보다 많이 단순합니다. 아래 "이전 설계안에는 있었지만 실제로는
-- 없는 것들" 항목을 꼭 참고하세요.
-- ============================================================


-- ============================================================
-- 0. ENUM 타입 (public 스키마 소속만)
-- ============================================================
CREATE TYPE user_role AS ENUM ('assistant', 'mid_admin', 'final_admin');
CREATE TYPE booking_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled', 'done');


-- ============================================================
-- 1. users (계정: 조교/중간관리자/최종관리자)
-- ============================================================
-- id = auth.users.id (Supabase Auth가 인증 담당, 여기는 프로필+권한만).
CREATE TABLE users (
    id                    UUID PRIMARY KEY REFERENCES auth.users(id),
    name                  VARCHAR(50) NOT NULL,
    department_id         INTEGER REFERENCES departments(id),
    staff_no              VARCHAR(50),
    phone                 VARCHAR(20),
    role                  user_role NOT NULL DEFAULT 'assistant',
    is_active             BOOLEAN DEFAULT TRUE,
    must_change_password  BOOLEAN DEFAULT TRUE   -- 최초 비밀번호(사번+"*") 강제 변경용 (change-password.html)
);
-- 가입 시 role은 항상 'assistant'로 고정 (login.html 회원가입 코드 참고 — 가입 화면에 역할 선택 UI 없음).
-- mid_admin/final_admin 승격은 별도 "신청/승인" 절차 없이, final_admin이 admin.html
-- "중간관리자 관리" 탭에서 직접 UPDATE users SET role=... 로 처리합니다.


-- ============================================================
-- 2. departments (부서 마스터 - users.department_id, 조직도용)
-- ============================================================
CREATE TABLE departments (
    id   SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL
);


-- ============================================================
-- 3. buildings (건물)
-- ============================================================
CREATE TABLE buildings (
    id     SERIAL PRIMARY KEY,
    name   VARCHAR(100) NOT NULL,
    status BOOLEAN DEFAULT TRUE   -- 노출 on/off (index.html은 status=true인 건물만 조회)
);
-- admin.html엔 건물을 추가/수정하는 UI가 없습니다 (강의실 등록 시 기존 건물 중에서 고르기만 함).
-- 새 건물이 필요하면 지금은 SQL Editor/Table Editor로 직접 INSERT해야 합니다.


-- ============================================================
-- 4. room_types (공간유형 마스터)
-- ============================================================
CREATE TABLE room_types (
    id   SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL
);


-- ============================================================
-- 5. equipment (기자재 마스터)
-- ============================================================
CREATE TABLE equipment (
    id   SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL
);


-- ============================================================
-- 6. rooms (강의실)
-- ============================================================
CREATE TABLE rooms (
    id             SERIAL PRIMARY KEY,
    building_id    INTEGER NOT NULL REFERENCES buildings(id),
    floor          INTEGER NOT NULL,          -- 지상=양수, 지하=음수
    room_no        VARCHAR(20) NOT NULL,
    capacity       INTEGER,
    room_type_id   INTEGER REFERENCES room_types(id),
    manager_id     UUID REFERENCES users(id), -- 담당 중간관리자
    thumbnail_url  TEXT,
    guideline_text TEXT,
    is_active      BOOLEAN DEFAULT TRUE
);
-- 이전 설계안에 있던 room_name / area / pc_count / managing_dept / manager_name /
-- contact_phone / contact_email / status(room_status enum) 컬럼은 실제 DB엔 없습니다.

CREATE TABLE room_equipment (
    room_id      INTEGER NOT NULL REFERENCES rooms(id),
    equipment_id INTEGER NOT NULL REFERENCES equipment(id)
    -- PRIMARY KEY (room_id, equipment_id) 로 추정
);


-- ============================================================
-- 7. semesters (학기) - admin.html "학기 관리" 탭
-- ============================================================
CREATE TABLE semesters (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(50) NOT NULL,
    start_date DATE NOT NULL,
    end_date   DATE NOT NULL,
    is_current BOOLEAN DEFAULT FALSE   -- 전체 학기 중 정확히 1개만 TRUE여야 함 (admin.html이 토글 시 나머지를 FALSE로 내림)
);
-- 이전 설계안에 있던 created_by 컬럼은 실제 DB엔 없습니다.
--
-- *** 2026-09-08 기준 이 테이블이 완전히 비어있음(0행) → index.html/manager.html이
-- "현재 학기"를 못 찾아서 정규강의 스케줄이 아예 안 뜨는 원인이었음. admin.html에서
-- 학기를 추가하고 "현재 학기로 설정"을 눌러야 그 다음부터 정상 동작함. ***


-- ============================================================
-- 8. class_schedules (정기수업 - 요일 반복)
-- ============================================================
CREATE TABLE class_schedules (
    id             SERIAL PRIMARY KEY,
    room_id        INTEGER NOT NULL REFERENCES rooms(id),
    semester_id    INTEGER NOT NULL REFERENCES semesters(id),
    weekday        INTEGER NOT NULL,   -- 0=일 ... 6=토 (JS Date.getDay()와 동일 규칙, index.html 주석 참고)
    start_time     TIME NOT NULL,
    end_time       TIME NOT NULL,
    subject_name   VARCHAR(100) NOT NULL,
    professor_name VARCHAR(50),
    created_by     UUID REFERENCES users(id)
);
-- 이전 설계안에 있던 headcount(수강인원) 컬럼은 실제 DB엔 없습니다.


-- ============================================================
-- 9. bookings (일일 대여 신청)
-- ============================================================
CREATE TABLE bookings (
    id             SERIAL PRIMARY KEY,
    room_id        INTEGER NOT NULL REFERENCES rooms(id),
    booking_date   DATE NOT NULL,
    start_time     TIME NOT NULL,
    end_time       TIME NOT NULL,
    purpose        TEXT,
    headcount      INTEGER,
    requester_id   UUID NOT NULL REFERENCES users(id),
    status         booking_status DEFAULT 'pending',
    reject_reason  TEXT,
    reviewed_by    UUID REFERENCES users(id),
    reviewed_at    TIMESTAMPTZ
);
-- 이전 설계안에 있던 review_comment/updated_at 컬럼, booking_equipment/booking_logs
-- 테이블, 더블부킹 방지용 EXCLUDE 제약은 실제 DB에 없습니다 (겹침 검사는 프론트에서
-- SELECT 후 직접 확인하는 방식 — manager.html/index.html의 겹침 체크 로직 참고).


-- ============================================================
-- 10. favorites (즐겨찾기)
-- ============================================================
CREATE TABLE favorites (
    user_id UUID NOT NULL REFERENCES users(id),
    room_id INTEGER NOT NULL REFERENCES rooms(id)
    -- PRIMARY KEY (user_id, room_id) 로 추정
);


-- ============================================================
-- 11. 이전 설계안에는 있었지만 실제 DB엔 없는 것들
-- ============================================================
-- - inquiries: index.html "문의하기" 기능이 쓰는 테이블. 없음 → 문의 등록 시 에러남
--   (팀원이 별도로 처리하기로 함, 지금은 그대로 둠)
-- - role_requests / role_request_status enum: 가입 시 mid_admin·final_admin을
--   "신청 → final_admin 승인" 하는 흐름용이었는데, 실제 코드(login.html)는 가입 시
--   role을 무조건 assistant로 고정하고 이 신청 절차 자체가 없음. admin.html에도
--   "가입 승인" 탭이 없음 (실제 탭: 강의실 관리 / 중간관리자 관리 / 학기 관리 3개뿐).
-- - booking_logs / booking_action enum: 예약 처리 이력(감사로그) 저장용, 없음.
-- - room_busy_slots 뷰, mark_bookings_done() / set_updated_at() 함수, pg_cron 자동
--   상태 전환: 없음 (booking_status에 'done'은 있지만 자동으로 넣어주는 트리거/크론 없음).


-- ============================================================
-- 12. 헬퍼 함수 (실제 정의, pg_proc에서 그대로 가져옴)
-- ============================================================
CREATE OR REPLACE FUNCTION public.current_user_role()
 RETURNS user_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT role FROM public.users WHERE id = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.is_room_manager(target_room_id integer)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.rooms
    WHERE id = target_room_id AND manager_id = auth.uid()
  );
$function$;


-- ============================================================
-- 13. Row Level Security (RLS) - 실제 정책, pg_policies에서 그대로 가져옴
-- ============================================================

-- ---- users ----
-- 주의: "로그인한 사용자는 서로 이름 조회 가능"(전체 true)과 "본인 또는 final_admin 조회"
-- 정책이 둘 다 있음 — SELECT는 permissive라 OR로 합쳐지므로, 결과적으로는 로그인한
-- 사람이면 누구나 users 전체를 조회할 수 있는 상태 (더 좁은 정책은 사실상 죽어있음).
CREATE POLICY "final_admin만 수정" ON users FOR UPDATE
    USING (current_user_role() = 'final_admin')
    WITH CHECK (current_user_role() = 'final_admin');
CREATE POLICY "로그인한 사용자는 서로 이름 조회 가능" ON users FOR SELECT
    USING (true);
CREATE POLICY "본인 또는 final_admin 조회" ON users FOR SELECT
    USING (id = auth.uid() OR current_user_role() = 'final_admin');

-- ---- departments ----
CREATE POLICY "final_admin만 수정" ON departments FOR ALL
    USING (current_user_role() = 'final_admin') WITH CHECK (current_user_role() = 'final_admin');
CREATE POLICY "누구나 조회" ON departments FOR SELECT USING (true);
CREATE POLICY "비로그인도 조회 가능" ON departments FOR SELECT USING (true);

-- ---- buildings ----
CREATE POLICY "final_admin만 수정" ON buildings FOR ALL
    USING (current_user_role() = 'final_admin') WITH CHECK (current_user_role() = 'final_admin');
CREATE POLICY "누구나 조회" ON buildings FOR SELECT USING (true);

-- ---- room_types ----
CREATE POLICY "final_admin만 수정" ON room_types FOR ALL
    USING (current_user_role() = 'final_admin') WITH CHECK (current_user_role() = 'final_admin');
CREATE POLICY "누구나 조회" ON room_types FOR SELECT USING (true);

-- ---- equipment ----
CREATE POLICY "final_admin만 수정" ON equipment FOR ALL
    USING (current_user_role() = 'final_admin') WITH CHECK (current_user_role() = 'final_admin');
CREATE POLICY "누구나 조회" ON equipment FOR SELECT USING (true);

-- ---- rooms ----
CREATE POLICY "final_admin만 수정" ON rooms FOR ALL
    USING (current_user_role() = 'final_admin') WITH CHECK (current_user_role() = 'final_admin');
CREATE POLICY "누구나 조회" ON rooms FOR SELECT USING (true);

-- ---- room_equipment ----
CREATE POLICY "final_admin만 수정" ON room_equipment FOR ALL
    USING (current_user_role() = 'final_admin') WITH CHECK (current_user_role() = 'final_admin');
CREATE POLICY "누구나 조회" ON room_equipment FOR SELECT USING (true);
CREATE POLICY "담당 강의실 관리자는 기자재 구성 수정 가능" ON room_equipment FOR ALL
    USING (is_room_manager(room_id)) WITH CHECK (is_room_manager(room_id));

-- ---- semesters ----
CREATE POLICY "final_admin만 수정" ON semesters FOR ALL
    USING (current_user_role() = 'final_admin') WITH CHECK (current_user_role() = 'final_admin');
CREATE POLICY "누구나 조회" ON semesters FOR SELECT USING (true);

-- ---- class_schedules ----
CREATE POLICY "final_admin 또는 담당 mid_admin 수정" ON class_schedules FOR ALL
    USING (current_user_role() = 'final_admin' OR is_room_manager(room_id))
    WITH CHECK (current_user_role() = 'final_admin' OR is_room_manager(room_id));
CREATE POLICY "누구나 조회" ON class_schedules FOR SELECT USING (true);

-- ---- bookings ----
-- 주의: 신청 정책이 role 체크 없이 requester_id만 확인함 → mid_admin/final_admin
-- 계정으로도 자기 명의 예약 신청이 가능한 상태 (이전 설계안은 assistant만 가능하게 제한했었음).
CREATE POLICY "로그인한 모두 전체 조회" ON bookings FOR SELECT USING (true);
CREATE POLICY "본인 명의로만 신청" ON bookings FOR INSERT
    WITH CHECK (requester_id = auth.uid());
CREATE POLICY "본인 취소 또는 담당자 또는 final_admin 삭제" ON bookings FOR DELETE
    USING (requester_id = auth.uid() OR is_room_manager(room_id) OR current_user_role() = 'final_admin');
CREATE POLICY "본인 취소 또는 담당자 승인반려 또는 final_admin" ON bookings FOR UPDATE
    USING (requester_id = auth.uid() OR is_room_manager(room_id) OR current_user_role() = 'final_admin')
    WITH CHECK (requester_id = auth.uid() OR is_room_manager(room_id) OR current_user_role() = 'final_admin');

-- ---- favorites ----
CREATE POLICY "본인 즐겨찾기만 조회" ON favorites FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "본인 즐겨찾기만 추가" ON favorites FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "본인 즐겨찾기만 삭제" ON favorites FOR DELETE USING (user_id = auth.uid());
