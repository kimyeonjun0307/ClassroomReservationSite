-- ============================================================
-- 동서대학교 강의실(공간) 예약 시스템 - DB 스키마 (PostgreSQL 15 / Supabase)
-- v3: 팀원 스키마 최신본 반영 - floor 정수화(지하=음수), rooms.managing_dept/manager_name
--     임시 컬럼, bookings.status에 done 추가(+ pg_cron 자동 전환), assistants 역할이
--     아닌 사람은 예약 신청 못 하도록 RLS 보강.
--
-- 원본 데이터: 강의실 현황_uit.xlsx (UIT관 24개실)
-- 화면 기준: index.html(예약자), manager.html(중간관리자), admin.html(최종관리자), mypage.html
-- 권한 모델: final_admin은 건물 단위로만 스코프됨 (여러 건물 총괄하는 최상위 관리자 없음)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;  -- 시간 겹침 방지(EXCLUDE) 제약에 필요


-- ============================================================
-- 0. ENUM 타입
-- ============================================================
CREATE TYPE assistant_role AS ENUM ('assistant', 'mid_admin', 'final_admin');

-- rooms.is_active(노출 on/off)와는 별개 축: "보이긴 하는데 지금 예약은 못 받는 상태"를 표현
CREATE TYPE room_status AS ENUM ('available', 'maintenance', 'renovation', 'closed');

-- 'done'(이용완료)은 배치/크론이 approved 건을 날짜 지나면 넘겨주는 값 (섹션 10-1 pg_cron 참고).
-- 조회 시점 계산(approved AND date<오늘)으로도 충분하긴 한데, 노쇼 처리처럼 done과 별개로 구분하고
-- 싶은 상태가 생길 수도 있어서 팀원 쪽 설계(명시적 컬럼)를 따르기로 함.
CREATE TYPE booking_status AS ENUM ('pending', 'approved', 'rejected', 'cancelled', 'done');

-- 감사로그(booking_logs)에 남기는 행위
CREATE TYPE booking_action AS ENUM ('submit', 'approve', 'reject', 'cancel');


-- ============================================================
-- 1. assistants (계정: 조교/중간관리자/최종관리자)
-- ============================================================
-- id = auth.users.id : 비밀번호/이메일 인증은 Supabase Auth가 담당하고, 여기는 프로필+권한만 관리.
-- 이 방식이 자체 password_hash 컬럼을 두는 것보다 낫습니다 (비밀번호 보안 책임을 직접 안 짐).
-- 최종관리자(final_admin)는 특정 건물에 속하지 않고 전체 건물/강의실을 총괄합니다.
-- 중간관리자(mid_admin)의 담당 범위도 건물 단위가 아니라 rooms.manager_id로 강의실 하나하나
-- 직접 배정되는 방식이라, 이 테이블에 건물 소속 컬럼 자체가 필요 없습니다.
CREATE TABLE assistants (
    id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name          VARCHAR(50) NOT NULL,
    role          assistant_role NOT NULL DEFAULT 'assistant',
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,     -- '계정 삭제'는 실제로는 이걸 FALSE로 (아래 노트 참고)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 왜 계정을 진짜로 DELETE하지 않고 is_active로 죽이나:
--   assistants.id를 bookings.requester_id, booking_logs.actor_id 등 여러 테이블이 참조하고 있어서
--   실제로 DELETE하면 예약 이력/감사로그가 통째로 깨지거나(고아 FK) CASCADE 설정에 따라 과거 기록이
--   같이 삭제돼버립니다. admin.html의 "계정 삭제" 버튼은 UPDATE assistants SET is_active=false 로
--   구현하는 걸 권장합니다 (로그인 차단 + 목록에서 숨김, 과거 예약 기록은 그대로 보존).

-- Supabase Auth 표준 패턴: auth.users에 신규 가입이 생기면 자동으로 assistants 프로필 행을 만듭니다.
CREATE OR REPLACE FUNCTION public.handle_new_assistant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    INSERT INTO public.assistants (id, name, role)
    VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'name', NEW.email), 'assistant');
    RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_assistant();
-- 가입 직후엔 전부 'assistant' role로 시작하고, mid_admin/final_admin 승격은
-- final_admin이 admin.html에서 UPDATE assistants SET role=... 로 처리합니다.


-- ============================================================
-- 2. buildings (건물)
-- ============================================================
CREATE TABLE buildings (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          VARCHAR(100) NOT NULL UNIQUE,   -- 'UIT관'
    contact_dept  VARCHAR(100),
    contact_phone VARCHAR(20),
    contact_email VARCHAR(255),
    has_equipment BOOLEAN NOT NULL DEFAULT FALSE,  -- 기자재 선택 UI 노출 여부 (UIT관 = false)
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ============================================================
-- 3. room_types (공간유형 마스터)
-- ============================================================
-- ENUM 대신 마스터 테이블로: 최종관리자가 유형을 추가/이름 변경할 때 ALTER TYPE 없이 INSERT/UPDATE로 처리 가능.
CREATE TABLE room_types (
    id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE   -- 이론강의실 / 실습강의실 / 소형세미나실 / 대형세미나실
);


-- ============================================================
-- 4. equipment (기자재 마스터)
-- ============================================================
CREATE TABLE equipment (
    id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE   -- 빔프로젝터 / 전자교탁 / 화이트보드 / VR장비
);


-- ============================================================
-- 5. rooms (강의실)
-- ============================================================
CREATE TABLE rooms (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    building_id     BIGINT NOT NULL REFERENCES buildings(id),
    floor           SMALLINT NOT NULL,       -- 지상=양수, 지하=음수 (B3→-3, B4→-4). 문자열보다 정렬/범위조회가 쉬움.
    room_no         VARCHAR(20) NOT NULL,    -- 호실 (U003)
    room_name       VARCHAR(100) NOT NULL,   -- 강의실명 (U003 대강의실) - 엑셀 원본에 호실과 별도로 존재
    room_type_id    BIGINT NOT NULL REFERENCES room_types(id),
    capacity        SMALLINT NOT NULL,
    area            NUMERIC(6,2),            -- 면적(㎡). 지금 화면엔 안 쓰이지만 엑셀 원본값이라 보존
    pc_count        SMALLINT DEFAULT 0,      -- 위와 동일한 이유로 보존
    manager_id      UUID REFERENCES assistants(id) ON DELETE SET NULL,  -- 담당 중간관리자. 계정 삭제 시 자동 미배정
    managing_dept   VARCHAR(100),            -- 임시 컬럼: 담당자 실계정(manager_id) 생기기 전까지 담당부서 텍스트로 표시
    manager_name    VARCHAR(50),             -- 임시 컬럼: 위와 동일한 이유, manager_id 채워지면 두 컬럼 다 제거 예정
    thumbnail_url   TEXT,
    guideline_text  TEXT,                    -- 이용수칙 실제 문구 (NULL = 이용수칙 없음)
    contact_phone   VARCHAR(20),             -- 방 단위 문의 전화. NULL이면 buildings 기본값 사용 (아래 뷰 참고)
    contact_email   VARCHAR(255),
    status          room_status NOT NULL DEFAULT 'available',  -- 정비중/보수중/폐쇄 뱃지
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,              -- 최종관리자 노출 on/off (완전히 숨김)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (building_id, room_no)
);

CREATE INDEX idx_rooms_manager ON rooms (manager_id);
CREATE INDEX idx_rooms_building ON rooms (building_id);

-- 엑셀 원본은 같은 건물 안에서도 방마다 담당부서가 다름(소프트웨어융합대학/미디어콘텐츠대학/ai융합교육원/사무처).
-- buildings 레벨 연락처만으로는 이걸 표현 못 해서, 방 단위 값이 있으면 그걸 쓰고 없으면 건물 기본값으로 대체.
CREATE VIEW rooms_with_contact AS
SELECT
    r.*,
    COALESCE(r.managing_dept, b.contact_dept)  AS effective_contact_dept,
    COALESCE(r.contact_phone, b.contact_phone) AS effective_contact_phone,
    COALESCE(r.contact_email, b.contact_email) AS effective_contact_email
FROM rooms r
JOIN buildings b ON b.id = r.building_id;

-- 강의실이 '보유'하고 있는 기자재 (M:N)
CREATE TABLE room_equipment (
    room_id      BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    equipment_id BIGINT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    PRIMARY KEY (room_id, equipment_id)
);


-- ============================================================
-- 6. semesters (학기) - admin.html "학기 관리" 탭: 모든 중간관리자에게 공통 노출
-- ============================================================
-- 팀원 초안엔 없었는데, class_schedules에 term_start/end를 매번 직접 입력하게 하면
-- admin.html에 이미 있는 "학기 관리" 탭(공용 학기 목록)을 구현할 데이터가 없어서 복원했습니다.
CREATE TABLE semesters (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       VARCHAR(50) NOT NULL,          -- '2026학년도 겨울계절학기'
    start_date DATE NOT NULL,
    end_date   DATE NOT NULL,
    created_by UUID NOT NULL REFERENCES assistants(id),  -- final_admin
    CHECK (start_date < end_date)
);


-- ============================================================
-- 7. class_schedules (정기수업 - 요일 반복, 승인/거절 대상 아님)
-- ============================================================
CREATE TABLE class_schedules (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id        BIGINT NOT NULL REFERENCES rooms(id),
    semester_id    BIGINT NOT NULL REFERENCES semesters(id),
    weekday        SMALLINT NOT NULL CHECK (weekday BETWEEN 1 AND 5),  -- 1=월 ... 5=금
    start_time     TIME NOT NULL,
    end_time       TIME NOT NULL,
    subject_name   VARCHAR(100) NOT NULL,   -- 과목명 (manager.html 등록 모달에 있는데 팀원 초안에 빠져있었음)
    professor_name VARCHAR(50) NOT NULL,
    headcount      SMALLINT,                -- 수강인원 (마찬가지로 복원)
    created_by     UUID NOT NULL REFERENCES assistants(id),  -- 담당 중간관리자 또는 final_admin (아래 노트)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (start_time < end_time),
    -- 같은 강의실·같은 요일·같은 학기 안에서 시간이 겹치는 정기수업을 DB가 원천 차단
    EXCLUDE USING gist (
        room_id WITH =,
        semester_id WITH =,
        weekday WITH =,
        tsrange('2000-01-01'::date + start_time, '2000-01-01'::date + end_time) WITH &&
    )
);
-- 참고: manager.html 목업엔 "정기수업 등록" 버튼이 중간관리자 화면에 있는데, 팀원 스키마 주석은 두 번 연속
-- final_admin으로 되어 있어서 실제 의도가 뭔지 아직 확인 못 했습니다. 확정 전까지는 RLS를
-- mid_admin(해당 강의실 담당자)과 final_admin(같은 건물) 둘 다 등록 가능하게 열어뒀습니다.


-- ============================================================
-- 8. bookings (일일 대여 신청)
-- ============================================================
CREATE TABLE bookings (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    room_id          BIGINT NOT NULL REFERENCES rooms(id),
    date             DATE NOT NULL,
    start_time       TIME NOT NULL,
    end_time         TIME NOT NULL,
    purpose          VARCHAR(200) NOT NULL,   -- 자유 텍스트 (팀원 방식 채택: ENUM+기타분기보다 단순함)
    headcount        SMALLINT NOT NULL,       -- index.html 필수 항목인데 팀원 초안에 빠져있었음 - 복원
    requester_id     UUID NOT NULL REFERENCES assistants(id),
    status           booking_status NOT NULL DEFAULT 'pending',
    reviewed_by      UUID REFERENCES assistants(id),   -- 최근 처리자 (빠른 조회용 - 담당 중간관리자)
    reviewed_at      TIMESTAMPTZ,
    review_comment   TEXT,                    -- manager.html "관리자 코멘트"(승인/거절 사유) - 저장할 곳이 없어서 추가
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (start_time < end_time)
);

CREATE INDEX idx_bookings_requester ON bookings (requester_id);
CREATE INDEX idx_bookings_room_date ON bookings (room_id, date);

-- 더블부킹 방지: 같은 강의실에서 pending/approved 상태 예약끼리는 시간이 겹칠 수 없음.
-- rejected/cancelled는 실제 자리를 차지하지 않으므로 WHERE로 제외 (partial exclusion constraint).
ALTER TABLE bookings
    ADD CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (
        room_id WITH =,
        tsrange(date + start_time, date + end_time) WITH &&
    ) WHERE (status IN ('pending', 'approved'));
-- Supabase도 결국 PostgreSQL이라 이 제약을 그대로 쓸 수 있습니다. 애플리케이션 코드에서
-- "겹치는지 SELECT로 확인 후 INSERT"만 하면 동시 요청 시 레이스 컨디션으로 이중예약이 뚫릴 수 있는데,
-- 이 제약이 있으면 DB가 트랜잭션 레벨에서 막아줘서 그 걱정이 없어집니다.

-- 참고: bookings vs class_schedules(정기수업) 간 시간 겹침은 하나는 특정 날짜, 하나는 요일 반복이라
-- DB 제약 하나로 잡기 어렵습니다. 예약 신청 시 서비스 레이어에서 해당 요일 정기수업과 겹치는지
-- 검사해서 막아주세요.

-- 예약 시 '요청'하는 기자재 (M:N). 지금은 buildings.has_equipment=false라 안 쓰이지만,
-- 기자재 기능을 쓰는 건물이 추가될 때를 대비해 테이블만 미리 만들어둠 (스키마 변경 없이 바로 사용 가능).
CREATE TABLE booking_equipment (
    booking_id   BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    equipment_id BIGINT NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    PRIMARY KEY (booking_id, equipment_id)
);

-- 예약 처리 이력 (append-only 감사로그)
-- bookings.reviewed_by/reviewed_at/review_comment는 '최근 처리 1건'만 빠르게 보여주기 위한 값이고,
-- 상태가 여러 번 바뀌는 경우(승인 후 취소 등) 전체 히스토리는 여기 쌓입니다.
CREATE TABLE booking_logs (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id BIGINT NOT NULL REFERENCES bookings(id),
    actor_id   UUID NOT NULL REFERENCES assistants(id),
    action     booking_action NOT NULL,
    comment    TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_booking_logs_booking ON booking_logs (booking_id);


-- ============================================================
-- 9. favorites (즐겨찾기)
-- ============================================================
CREATE TABLE favorites (
    assistant_id UUID NOT NULL REFERENCES assistants(id) ON DELETE CASCADE,
    room_id      BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (assistant_id, room_id)
);


-- ============================================================
-- 10. updated_at 자동 갱신 트리거 (rooms, bookings)
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_rooms_updated_at BEFORE UPDATE ON rooms
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_bookings_updated_at BEFORE UPDATE ON bookings
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================
-- 10-1. pg_cron: approved 예약을 날짜 지나면 자동으로 done 처리
-- ============================================================
-- 함수 자체는 여기서 만들지만, cron.schedule(...) 등록은 pg_cron 확장을 Dashboard에서
-- 켠 다음 SQL Editor에서 "한 번만" 실행하면 됩니다 (아래 채팅 안내 참고). 매 마이그레이션마다
-- 실행하면 동일 이름 잡이 중복 등록될 수 있어서 이 파일엔 함수 정의까지만 둡니다.
CREATE OR REPLACE FUNCTION public.mark_bookings_done()
RETURNS void
LANGUAGE sql
AS $$
    UPDATE bookings SET status = 'done'
    WHERE status = 'approved' AND date < CURRENT_DATE;
$$;


-- ============================================================
-- 11. 기준 데이터 시드 (엑셀 '강의실 현황_uit.xlsx' 기반)
-- ============================================================
INSERT INTO buildings (name, has_equipment) VALUES
    ('UIT관', FALSE);

INSERT INTO room_types (name) VALUES
    ('대형세미나실'), ('이론강의실'), ('실습강의실'), ('소형세미나실');

INSERT INTO equipment (name) VALUES
    ('빔프로젝터'), ('전자교탁'), ('화이트보드'), ('VR장비');

INSERT INTO rooms
    (building_id, floor, room_no, room_name, room_type_id, capacity, area, pc_count, managing_dept, manager_name)
VALUES
    ((SELECT id FROM buildings WHERE name = 'UIT관'), -3, 'U003', 'U003 대강의실', (SELECT id FROM room_types WHERE name = '대형세미나실'), 168, 299.7, 1, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), -4, 'U004', 'U004 영상강의실', (SELECT id FROM room_types WHERE name = '대형세미나실'), 90, 70.47, 1, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 1, 'U106', 'U106 대학원 세미나실', (SELECT id FROM room_types WHERE name = '이론강의실'), 20, 36.45, 1, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 1, 'U107', 'U107 네트워크설계응용실험실', (SELECT id FROM room_types WHERE name = '실습강의실'), 46, 109.35, 46, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 1, 'U108', 'U108 U-임베디드실습실', (SELECT id FROM room_types WHERE name = '실습강의실'), 40, 72.9, 41, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 1, 'U109', 'U109 첨단프로잭트강의실', (SELECT id FROM room_types WHERE name = '실습강의실'), 47, 130.3, 41, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 1, 'U110', 'U110  1인미디어제작실', (SELECT id FROM room_types WHERE name = '소형세미나실'), 1, 1, 0, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 2, 'U209', 'U209 그래픽프로그래밍실습실', (SELECT id FROM room_types WHERE name = '실습강의실'), 40, 72.9, 41, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 3, 'U303', 'U303 인터넷프로그래밍실습실', (SELECT id FROM room_types WHERE name = '실습강의실'), 40, 70.47, 41, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 3, 'U308', 'U308 임베디드소프트웨어실습실', (SELECT id FROM room_types WHERE name = '실습강의실'), 40, 72.9, 41, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 3, 'U310', 'U310 스마트 소프트웨어 실습실', (SELECT id FROM room_types WHERE name = '실습강의실'), 44, 99, 45, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 4, 'U401', 'U401 실시간원격강의실습실', (SELECT id FROM room_types WHERE name = '실습강의실'), 50, 122.1, 51, '미디어콘텐츠대학', '이지원'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 4, 'U402', 'U402 컴퓨터 음악 실습실', (SELECT id FROM room_types WHERE name = '실습강의실'), 40, 72.9, 41, '미디어콘텐츠대학', '이지원'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 4, 'U407', 'U407 컨셉디자인룸', (SELECT id FROM room_types WHERE name = '이론강의실'), 56, 72.9, 1, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 4, 'U409', 'U409 게임프로토타입 기획실', (SELECT id FROM room_types WHERE name = '실습강의실'), 40, 99, 41, '미디어콘텐츠대학', '이지원'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 5, 'U501', 'U501 웹툰스튜디오 2', (SELECT id FROM room_types WHERE name = '실습강의실'), 50, 195, 51, '미디어콘텐츠대학', '이지원'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 5, 'U503', 'U503 영상강의실', (SELECT id FROM room_types WHERE name = '이론강의실'), 54, 72.9, 1, '미디어콘텐츠대학', '이지원'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 5, 'U504', 'U504 웹툰스튜디오 1', (SELECT id FROM room_types WHERE name = '실습강의실'), 40, 36.45, 41, '미디어콘텐츠대학', '이지원'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 5, 'U505', 'U505 WEBTOON INNOVATION STUDIO', (SELECT id FROM room_types WHERE name = '실습강의실'), 32, 109.35, 33, '미디어콘텐츠대학', '이지원'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 6, 'U601', 'U601 하이브리드 강의실', (SELECT id FROM room_types WHERE name = '이론강의실'), 60, 122.1, 1, '소프트웨어융합대학', '김경희'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 6, 'U602', 'U602 AI·SW 실습실2', (SELECT id FROM room_types WHERE name = '실습강의실'), 30, 72.9, 0, 'ai융합교육원', '김소연'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 6, 'U603', 'U603 국제세미나실', (SELECT id FROM room_types WHERE name = '대형세미나실'), 170, 209, 1, '사무처', '사무처'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 7, 'U702', 'U702 AI콘텐츠실습실', (SELECT id FROM room_types WHERE name = '실습강의실'), 40, 72.9, 41, '미디어콘텐츠대학', '이지원'),
    ((SELECT id FROM buildings WHERE name = 'UIT관'), 7, 'U709', 'U709 데이터베이스실습실', (SELECT id FROM room_types WHERE name = '실습강의실'), 40, 72.9, 41, '미디어콘텐츠대학', '이지원');

-- 엑셀 '이용수칙' 컬럼이 o였던 방 (실제 문구는 아직 없어서 guideline_text는 NULL로 비워둠 - 담당자에게 문구 받아서 채워넣을 것):
-- U003, U004, U107, U108, U109, U209, U303, U308, U310, U401, U402, U407, U409, U501, U504, U505, U702, U709

-- 담당자(김경희/이지원/김소연/사무처) 실계정은 이메일이 없어 지금은 managing_dept/manager_name
-- 텍스트로만 표시합니다. 최종관리자가 admin.html에서 mid_admin 계정을 만든 뒤 아래처럼 연결하고,
-- 연결이 끝나면 managing_dept/manager_name 두 컬럼은 DROP COLUMN으로 정리하면 됩니다:
--   UPDATE rooms SET manager_id = '<신규 mid_admin의 auth uid>' WHERE room_no = 'U003';


-- ============================================================
-- 12. Row Level Security (RLS)
-- ============================================================
-- 헬퍼 함수: 정책 안에서 assistants를 재귀적으로 조회하는 걸 피하려고 SECURITY DEFINER로 우회.
-- (정책이 assistants를 직접 서브쿼리하면 그 서브쿼리도 같은 정책 평가를 다시 타게 되어 느려지거나 꼬일 수 있음)
CREATE OR REPLACE FUNCTION public.current_assistant_role() RETURNS assistant_role
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT role FROM assistants WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.is_manager_of_room(target_room_id BIGINT) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM rooms WHERE id = target_room_id AND manager_id = auth.uid());
$$;

ALTER TABLE assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE buildings ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE semesters ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE favorites ENABLE ROW LEVEL SECURITY;

-- ---- assistants: 본인 행 조회/수정, final_admin은 전체 조회 + role 변경(승격/강등) ----
CREATE POLICY assistants_select ON assistants FOR SELECT
    USING (id = auth.uid() OR current_assistant_role() = 'final_admin');

CREATE POLICY assistants_update_self ON assistants FOR UPDATE
    USING (id = auth.uid());

-- final_admin은 건물에 묶이지 않는 총괄 관리자라, 어떤 assistant든 role을 바꿀 수 있음
CREATE POLICY assistants_manage_by_final_admin ON assistants FOR UPDATE
    USING (current_assistant_role() = 'final_admin')
    WITH CHECK (current_assistant_role() = 'final_admin');

-- ---- buildings: 전체 조회 가능, 등록/수정/삭제는 final_admin 누구나 (건물 개수 제한 없음) ----
CREATE POLICY buildings_select ON buildings FOR SELECT USING (TRUE);

CREATE POLICY buildings_manage_by_final_admin ON buildings FOR ALL
    USING (current_assistant_role() = 'final_admin')
    WITH CHECK (current_assistant_role() = 'final_admin');

-- ---- room_types / equipment: 전역 마스터라 전체 조회, 수정은 final_admin 누구나 ----
CREATE POLICY room_types_select ON room_types FOR SELECT USING (TRUE);
CREATE POLICY room_types_manage ON room_types FOR ALL
    USING (current_assistant_role() = 'final_admin') WITH CHECK (current_assistant_role() = 'final_admin');

CREATE POLICY equipment_select ON equipment FOR SELECT USING (TRUE);
CREATE POLICY equipment_manage ON equipment FOR ALL
    USING (current_assistant_role() = 'final_admin') WITH CHECK (current_assistant_role() = 'final_admin');

-- mid_admin도 새 기자재 종류는 추가할 수 있음 (권한 상승 위험 없는 단순 이름 목록이라)
CREATE POLICY equipment_insert_by_mid_admin ON equipment FOR INSERT
    WITH CHECK (current_assistant_role() IN ('mid_admin', 'final_admin'));

-- ---- rooms: 전체 조회 가능, CRUD는 final_admin 누구나 (건물 무관, 전체 총괄) ----
CREATE POLICY rooms_select ON rooms FOR SELECT USING (TRUE);

CREATE POLICY rooms_manage_by_final_admin ON rooms FOR ALL
    USING (current_assistant_role() = 'final_admin')
    WITH CHECK (current_assistant_role() = 'final_admin');

-- 담당 중간관리자는 자기 강의실 정보(이름/수용인원/이용수칙/문의처)를 직접 수정 가능 (manager.html)
CREATE POLICY rooms_update_by_manager ON rooms FOR UPDATE
    USING (manager_id = auth.uid())
    WITH CHECK (manager_id = auth.uid());

CREATE POLICY room_equipment_select ON room_equipment FOR SELECT USING (TRUE);
CREATE POLICY room_equipment_manage ON room_equipment FOR ALL
    USING (is_manager_of_room(room_id) OR current_assistant_role() = 'final_admin')
    WITH CHECK (is_manager_of_room(room_id) OR current_assistant_role() = 'final_admin');

-- ---- semesters: 전체 조회, 등록/수정은 final_admin (admin.html 학기 관리 탭) ----
CREATE POLICY semesters_select ON semesters FOR SELECT USING (TRUE);
CREATE POLICY semesters_manage ON semesters FOR ALL
    USING (current_assistant_role() = 'final_admin') WITH CHECK (current_assistant_role() = 'final_admin');

-- ---- class_schedules: 전체 조회, 등록/수정은 담당 중간관리자 또는 final_admin ----
CREATE POLICY class_schedules_select ON class_schedules FOR SELECT USING (TRUE);
CREATE POLICY class_schedules_manage ON class_schedules FOR ALL
    USING (is_manager_of_room(room_id) OR current_assistant_role() = 'final_admin')
    WITH CHECK (is_manager_of_room(room_id) OR current_assistant_role() = 'final_admin');

-- ---- bookings ----
-- 조회: 신청자 본인 / 담당 중간관리자 / final_admin(전체 오버사이트)
CREATE POLICY bookings_select ON bookings FOR SELECT
    USING (
        requester_id = auth.uid()
        OR is_manager_of_room(room_id)
        OR current_assistant_role() = 'final_admin'
    );

-- 신청: 로그인한 사람이 자기 이름으로만, 그리고 조교(assistant) 역할만 (mid_admin/final_admin은 예약 신청 대상 아님)
CREATE POLICY bookings_insert ON bookings FOR INSERT
    WITH CHECK (requester_id = auth.uid() AND current_assistant_role() = 'assistant');

-- 취소: 신청자 본인이 pending/approved 상태일 때만 (mypage.html 동작과 동일)
CREATE POLICY bookings_cancel_by_requester ON bookings FOR UPDATE
    USING (requester_id = auth.uid() AND status IN ('pending', 'approved'));

-- 승인/거절: 담당 중간관리자만
CREATE POLICY bookings_review_by_manager ON bookings FOR UPDATE
    USING (is_manager_of_room(room_id));

CREATE POLICY booking_equipment_select ON booking_equipment FOR SELECT
    USING (EXISTS (SELECT 1 FROM bookings bk WHERE bk.id = booking_id AND bk.requester_id = auth.uid())
        OR EXISTS (SELECT 1 FROM bookings bk WHERE bk.id = booking_id AND is_manager_of_room(bk.room_id)));
CREATE POLICY booking_equipment_insert ON booking_equipment FOR INSERT
    WITH CHECK (EXISTS (SELECT 1 FROM bookings bk WHERE bk.id = booking_id AND bk.requester_id = auth.uid()));

CREATE POLICY booking_logs_select ON booking_logs FOR SELECT
    USING (EXISTS (SELECT 1 FROM bookings bk WHERE bk.id = booking_id
                     AND (bk.requester_id = auth.uid() OR is_manager_of_room(bk.room_id))));
CREATE POLICY booking_logs_insert ON booking_logs FOR INSERT
    WITH CHECK (actor_id = auth.uid());

-- ---- favorites: 본인 것만 ----
CREATE POLICY favorites_owner ON favorites FOR ALL
    USING (assistant_id = auth.uid()) WITH CHECK (assistant_id = auth.uid());


-- ============================================================
-- 13. room_busy_slots: bookings RLS를 우회해 "이 시간대 비어있는지"만 노출하는 뷰
-- ============================================================
-- bookings_select 정책상 assistant는 본인 예약만 보이는데, 그러면 다른 사람이 이미 잡아놓은
-- 시간대인지 신청 전에 확인할 방법이 없다. 목적/신청자 같은 민감정보는 빼고
-- room_id/date/start_time/end_time만 노출하는 뷰를 postgres(테이블 소유자) 권한으로 만들어서
-- (SECURITY INVOKER를 안 켠 기본 상태) bookings의 RLS를 우회한다.
CREATE OR REPLACE VIEW public.room_busy_slots AS
SELECT room_id, date, start_time, end_time
FROM public.bookings
WHERE status IN ('pending', 'approved');

GRANT SELECT ON public.room_busy_slots TO authenticated;


-- ============================================================
-- 14. 보안 수정: 본인이 role을 스스로 바꾸는 것을 막음
-- ============================================================
-- assistants_update_self 정책은 "본인 행인지"만 확인해서, 로그인한 일반 assistant가
-- 자기 role을 final_admin으로 셀프 승격시킬 수 있는 구멍이 있었다. RLS는 행 단위
-- 접근만 통제하므로 컬럼 단위 통제는 트리거로 막는다.
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

    IF NEW.role IS DISTINCT FROM OLD.role AND current_assistant_role() <> 'final_admin' THEN
        RAISE EXCEPTION 'role은 final_admin만 변경할 수 있습니다';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_self_role_escalation ON assistants;
CREATE TRIGGER trg_prevent_self_role_escalation
    BEFORE UPDATE ON assistants
    FOR EACH ROW EXECUTE FUNCTION public.prevent_self_role_escalation();


-- ============================================================
-- 15. 회원가입 시 중간관리자/최종관리자 "신청" (승인 대기 방식)
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

CREATE POLICY role_requests_insert_self ON role_requests FOR INSERT
    WITH CHECK (assistant_id = auth.uid());

CREATE POLICY role_requests_review_by_final_admin ON role_requests FOR UPDATE
    USING (current_assistant_role() = 'final_admin')
    WITH CHECK (current_assistant_role() = 'final_admin');

-- 가입 트리거 확장: 메타데이터에 desired_role이 있으면 신청서도 같이 생성
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
