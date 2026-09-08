// bulk-create-users.js
// 절대 웹사이트(login.html 등)에 넣지 말고, 이 파일은 본인 컴퓨터 터미널에서만 node로 실행하세요.
// service_role 키는 DB 전체를 무제한으로 조작 가능한 키라서 브라우저/웹서버에 노출되면 위험합니다.

const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  'https://yclrlgcixldovbhygjrc.supabase.co',   // Project Settings → API → Project URL
  'REPLACE_WITH_SERVICE_ROLE_KEY'                // Project Settings → API → service_role (anon 키 아님!)
);

const staffList = [
  { staff_no: '2024001', name: '김경희', department_id: 1, phone: '010-1234-5678' },
  { staff_no: '2024002', name: '이지원', department_id: 2, phone: '010-2345-6789' },
  // ... 학교에서 받은 명단 전체를 여기에 추가
];

async function bulkCreate() {
  for (const staff of staffList) {
    const { error } = await supabaseAdmin.auth.admin.createUser({
      email: `${staff.staff_no}@ubspace.local`,
      password: `${staff.staff_no}*`,   // 초기 비밀번호 = 사번 + "*". 최초 로그인 시 강제로 변경됨.
      email_confirm: true,
      user_metadata: {
        name: staff.name,
        department_id: staff.department_id,
        staff_no: staff.staff_no,
        phone: staff.phone
      }
    });

    if (error) console.error(`${staff.staff_no} 생성 실패:`, error.message);
    else console.log(`${staff.staff_no} 생성 완료`);
  }
}

bulkCreate();
