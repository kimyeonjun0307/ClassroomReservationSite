  // 사번(학번) -> Supabase Auth용 내부 가짜 이메일 변환. 이 프로젝트 전체(로그인/회원가입/bulk-create)에서 동일한 규칙을 써야 함.
  function toInternalEmail(staffNo) {
    return staffNo.trim() + '@ubspace.local';
  }

  // role enum('assistant','mid_admin','final_admin') → 이동할 페이지
  var ROLE_REDIRECT = {
    assistant: 'index.html',
    mid_admin: 'manager.html',
    final_admin: 'admin.html'
  };

  // ---------------- 로그인/회원가입 폼 전환 ----------------
  var loginCard = document.getElementById('loginCard');
  var signupCard = document.getElementById('signupCard');

  document.getElementById('showSignup').addEventListener('click', function () {
    loginCard.classList.add('hidden');
    signupCard.classList.remove('hidden');
  });
  document.getElementById('showLogin').addEventListener('click', function () {
    signupCard.classList.add('hidden');
    loginCard.classList.remove('hidden');
  });

  function showMsg(el, text, type) {
    el.textContent = text;
    el.className = 'form-msg ' + type;
  }

  // ---------------- 회원가입: 소속부서 목록 불러오기 ----------------
  (async function loadDepartments() {
    var deptSelect = document.getElementById('signupDept');
    var res = await supabase.from('departments').select('id, name').order('name');
    if (!res.error && res.data) {
      deptSelect.innerHTML = '<option value="">선택해주세요</option>' +
        res.data.map(function (d) { return '<option value="' + d.id + '">' + d.name + '</option>'; }).join('');
    }
  })();

  // 가입 시 role은 항상 'assistant'로 고정되므로 건물 선택 UI는 제거됨.
  // 중간관리자/최종관리자 승격은 최종관리자가 나중에 users 테이블을 직접 수정.

  // ---------------- 회원가입: 개인 이메일 인증 (신규 가입자부터 필수) ----------------
  var emailVerified = false;
  var signupEmailInput = document.getElementById('signupEmail');
  var signupCodeField = document.getElementById('signupCodeField');
  var signupCodeInput = document.getElementById('signupCode');
  var sendCodeBtn = document.getElementById('sendCodeBtn');
  var checkCodeBtn = document.getElementById('checkCodeBtn');
  var btnSignup = document.getElementById('btnSignup');
  var emailVerifiedNotice = document.getElementById('emailVerifiedNotice');
  var signupMsg = document.getElementById('signupMsg');

  function setEmailVerified(v) {
    emailVerified = v;
    btnSignup.disabled = !v;
    btnSignup.textContent = v ? '회원가입' : '회원가입 (이메일 인증 필요)';
    emailVerifiedNotice.textContent = v ? '✓ 인증 완료되었습니다.' : '';
  }

  // 인증 완료 후 이메일을 바꾸면 다시 인증해야 함
  signupEmailInput.addEventListener('input', function () {
    if (emailVerified) setEmailVerified(false);
  });

  sendCodeBtn.addEventListener('click', async function () {
    var email = signupEmailInput.value.trim();
    if (!email) {
      showMsg(signupMsg, '개인 이메일을 입력해주세요.', 'error');
      signupMsg.classList.remove('hidden');
      return;
    }

    sendCodeBtn.disabled = true;
    sendCodeBtn.textContent = '발송 중...';
    signupMsg.classList.add('hidden');

    var res = await supabase.functions.invoke('send-verification-code', { body: { email: email } });

    if (res.error || (res.data && res.data.error)) {
      var errMsg = (res.data && res.data.error) || res.error.message;
      showMsg(signupMsg, '인증코드 발송에 실패했습니다: ' + errMsg, 'error');
      signupMsg.classList.remove('hidden');
      sendCodeBtn.disabled = false;
      sendCodeBtn.textContent = '인증코드 발송';
      return;
    }

    signupCodeField.classList.remove('hidden');
    showMsg(signupMsg, '인증코드를 발송했습니다. 메일을 확인해주세요.', 'success');
    signupMsg.classList.remove('hidden');

    // 60초 재발송 쿨다운
    var remaining = 60;
    sendCodeBtn.textContent = '재발송 (' + remaining + 's)';
    var timer = setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(timer);
        sendCodeBtn.disabled = false;
        sendCodeBtn.textContent = '인증코드 재발송';
      } else {
        sendCodeBtn.textContent = '재발송 (' + remaining + 's)';
      }
    }, 1000);
  });

  checkCodeBtn.addEventListener('click', async function () {
    var email = signupEmailInput.value.trim();
    var code = signupCodeInput.value.trim();
    if (!code) {
      showMsg(signupMsg, '인증코드를 입력해주세요.', 'error');
      signupMsg.classList.remove('hidden');
      return;
    }

    checkCodeBtn.disabled = true;
    checkCodeBtn.textContent = '확인 중...';

    var res = await supabase.functions.invoke('verify-email-code', { body: { email: email, code: code } });

    checkCodeBtn.disabled = false;
    checkCodeBtn.textContent = '확인';

    if (res.error || !res.data || !res.data.verified) {
      var reason = (res.data && res.data.reason) || (res.error && res.error.message) || '인증에 실패했습니다.';
      showMsg(signupMsg, reason, 'error');
      signupMsg.classList.remove('hidden');
      setEmailVerified(false);
      return;
    }

    setEmailVerified(true);
    signupMsg.classList.add('hidden');
  });

  // ---------------- 로그인 ----------------
  document.getElementById('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var msg = document.getElementById('loginMsg');
    var btn = document.getElementById('btnLogin');
    var staffNo = document.getElementById('loginStaffNo').value.trim();
    var password = document.getElementById('loginPw').value;

    if (!staffNo || !password) {
      showMsg(msg, '사번과 비밀번호를 모두 입력해주세요.', 'error');
      msg.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    msg.classList.add('hidden');

    var authRes = await supabase.auth.signInWithPassword({ email: toInternalEmail(staffNo), password: password });

    if (authRes.error) {
      showMsg(msg, '로그인에 실패했습니다. 사번 또는 비밀번호를 확인해주세요.', 'error');
      msg.classList.remove('hidden');
      btn.disabled = false;
      return;
    }

    // 로그인 성공 → users 테이블에서 실제 role 조회 후 그 role에 맞는 화면으로 이동
    var profileRes = await supabase
      .from('users')
      .select('role')
      .eq('id', authRes.data.user.id)
      .single();

    btn.disabled = false;

    if (profileRes.error || !profileRes.data) {
      showMsg(msg, '계정 정보를 불러오지 못했습니다. 관리자에게 문의해주세요.', 'error');
      msg.classList.remove('hidden');
      return;
    }

    window.location.href = ROLE_REDIRECT[profileRes.data.role] || 'index.html';
  });

  // ---------------- 회원가입 ----------------
  document.getElementById('signupForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var msg = document.getElementById('signupMsg');
    var btn = document.getElementById('btnSignup');

    var name = document.getElementById('signupName').value.trim();
    var staffNo = document.getElementById('signupStaffNo').value.trim();
    var personalEmail = signupEmailInput.value.trim();
    var password = document.getElementById('signupPw').value;
    var departmentId = document.getElementById('signupDept').value;

    if (!name || !staffNo || !password) {
      showMsg(msg, '모든 항목을 입력해주세요.', 'error');
      msg.classList.remove('hidden');
      return;
    }
    if (!departmentId) {
      showMsg(msg, '소속부서를 선택해주세요.', 'error');
      msg.classList.remove('hidden');
      return;
    }
    if (!emailVerified) {
      showMsg(msg, '개인 이메일 인증을 먼저 완료해주세요.', 'error');
      msg.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    msg.classList.add('hidden');

    // auth.users 계정 생성. role은 절대 여기서 보내지 않음 — 백엔드 트리거가 무조건 'assistant'로 고정 처리함.
    // users row는 DB 트리거가 auth.users insert 시 raw_user_meta_data를 읽어 자동 생성(staff_no 포함).
    var signUpRes = await supabase.auth.signUp({
      email: toInternalEmail(staffNo),
      password: password,
      options: {
        data: {
          name: name,
          department_id: departmentId,
          staff_no: staffNo
        }
      }
    });

    btn.disabled = false;

    if (signUpRes.error) {
      showMsg(msg, '회원가입에 실패했습니다: ' + signUpRes.error.message, 'error');
      msg.classList.remove('hidden');
      return;
    }

    // 인증된 개인 이메일을 users 행에 저장. 가입 직후엔 보통 바로 로그인 세션이 생기므로
    // "본인 정보 수정 가능" RLS 정책(db/migrations/2026-10-20_*.sql)으로 본인 행을 고칠 수 있음.
    // 세션이 아직 없는 경우(이메일 확인 설정이 켜져 있는 경우)엔 조용히 건너뛰고, 이땐
    // 최종관리자가 나중에 Supabase 대시보드에서 채워줘야 함.
    if (signUpRes.data.session && signUpRes.data.user) {
      await supabase.from('users').update({ personal_email: personalEmail }).eq('id', signUpRes.data.user.id);
    }

    showMsg(msg, '가입이 완료됐습니다. 로그인해주세요.', 'success');
    msg.classList.remove('hidden');
    setTimeout(function () {
      signupCard.classList.add('hidden');
      loginCard.classList.remove('hidden');
      document.getElementById('signupForm').reset();
      signupCodeField.classList.add('hidden');
      setEmailVerified(false);
    }, 1500);
  });

  // ---------------- 이미 로그인된 세션이면 바로 리다이렉트 ----------------
  (async function checkExistingSession() {
    var sessionRes = await supabase.auth.getSession();
    if (sessionRes.data.session) {
      var profileRes = await supabase
        .from('users')
        .select('role')
        .eq('id', sessionRes.data.session.user.id)
        .single();
      if (profileRes.data) {
        window.location.href = ROLE_REDIRECT[profileRes.data.role] || 'index.html';
      }
    }
  })();
