  async function logout() {
    await supabase.auth.signOut();
    window.location.href = 'login.html';
  }

  var currentUser = null; // { id, name, role, department_id }
  var MY_BOOKINGS = [];   // bookings row + room/building 조인

  var STATUS_LABEL = { pending: '승인 대기', approved: '승인 완료', rejected: '승인 거절', cancelled: '취소됨', done: '이용 완료' };
  var STATUS_CLASS = { pending: 'status-pending', approved: 'status-approved', rejected: 'status-rejected', cancelled: 'status-canceled', done: 'status-done' };

  var cards = {
    approved: document.getElementById('card-approved'),
    pending: document.getElementById('card-pending'),
    rejected: document.getElementById('card-rejected'),
    done: document.getElementById('card-done')
  };
  var banner = document.getElementById('filterBanner');
  var bannerText = document.getElementById('filterBannerText');
  var currentFilterStatus = '';

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function timeShort(t) { return String(t).slice(0, 5); }
  var WEEKDAY_KOR = ['일', '월', '화', '수', '목', '금', '토'];
  function formatBookingDate(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    var dow = WEEKDAY_KOR[d.getDay()];
    return dateStr + ' (' + dow + ')';
  }
  function dateToISO(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  // class_schedules.weekday 규칙: 일=0, 월=1 ... 토=6 (JS Date.getDay()와 동일, index.html과 동일 규칙)
  var CURRENT_SEMESTER = null;
  var CURRENT_SEMESTER_ID = null;
  async function loadCurrentSemester() {
    var semRes = await supabase.from('semesters').select('id, start_date, end_date').eq('is_current', true).limit(1).maybeSingle();
    CURRENT_SEMESTER = (!semRes.error && semRes.data) ? semRes.data : null;
    CURRENT_SEMESTER_ID = CURRENT_SEMESTER ? CURRENT_SEMESTER.id : null;
  }

  function showPageMessage(text, type) {
    var box = document.getElementById('pageMessageBox');
    box.textContent = text;
    box.style.display = 'block';
    if (type === 'error') {
      box.style.background = 'var(--danger-bg)'; box.style.color = 'var(--danger)'; box.style.border = '1px solid var(--danger-border)';
    } else {
      box.style.background = 'var(--success-bg)'; box.style.color = 'var(--success)'; box.style.border = '1px solid var(--success-border)';
    }
    clearTimeout(showPageMessage._t);
    showPageMessage._t = setTimeout(function () { box.style.display = 'none'; }, 4500);
  }

  async function requireSessionAndLoadUser() {
    var sessionRes = await supabase.auth.getSession();
    if (!sessionRes.data.session) { window.location.href = 'login.html'; return false; }

    var profileRes = await supabase.from('users').select('id, name, role, department_id, phone, personal_email, staff_no, departments(name)').eq('id', sessionRes.data.session.user.id).single();
    if (profileRes.error || !profileRes.data) { window.location.href = 'login.html'; return false; }

    currentUser = profileRes.data;
    currentUser.email = sessionRes.data.session.user.email || '-';
    currentUser.deptName = (profileRes.data.departments && profileRes.data.departments.name) || '-';
    return true;
  }

  var ROLE_LABEL = { assistant: '예약자(조교)', mid_admin: '중간관리자', final_admin: '최종관리자' };

  function renderProfile() {
    document.getElementById('headerUserInfo').textContent = '👤 ' + currentUser.name + ' (' + currentUser.deptName + ')';
    document.getElementById('profileName').textContent = currentUser.name;
    document.getElementById('profileDept').textContent = currentUser.deptName;
    document.getElementById('profileDept2').textContent = currentUser.deptName;
    document.getElementById('profileEmail').textContent = currentUser.staff_no || '-';
    document.getElementById('profilePhone').textContent = currentUser.phone || '-';
    document.getElementById('profilePersonalEmail').textContent = currentUser.personal_email || '미등록 (회원정보 수정에서 등록)';
    document.getElementById('profileRole').textContent = ROLE_LABEL[currentUser.role] || currentUser.role;
  }

  async function loadMyBookings() {
    var res = await supabase
      .from('bookings')
      .select('*, rooms(room_no, buildings!building_id(name))')
      .eq('requester_id', currentUser.id)
      .order('booking_date', { ascending: false });
    MY_BOOKINGS = (!res.error && res.data) ? res.data : [];
  }

  function renderSummaryCounts() {
    var counts = { approved: 0, pending: 0, rejected: 0, done: 0 };
    MY_BOOKINGS.forEach(function (b) { if (counts.hasOwnProperty(b.status)) counts[b.status]++; });
    document.getElementById('count-approved').textContent = counts.approved + '건';
    document.getElementById('count-pending').textContent = counts.pending + '건';
    document.getElementById('count-rejected').textContent = counts.rejected + '건';
    document.getElementById('count-done').textContent = counts.done + '건';
  }

  function renderBookingTable() {
    var tbody = document.getElementById('bookingTbody');
    var list = currentFilterStatus ? MY_BOOKINGS.filter(function (b) { return b.status === currentFilterStatus; }) : MY_BOOKINGS;

    if (!list.length) {
      tbody.innerHTML = '<tr class="empty-row"><td colspan="7">해당하는 내역이 없습니다.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(function (b) {
      var spaceName = b.rooms ? ((b.rooms.buildings ? b.rooms.buildings.name + ' ' : '') + b.rooms.room_no + '호') : '-';
      var usage = formatBookingDate(b.booking_date) + '<br>' + timeShort(b.start_time) + '~' + timeShort(b.end_time);
      var statusHtml = '<span class="status ' + (STATUS_CLASS[b.status] || '') + '">' + (STATUS_LABEL[b.status] || b.status) + '</span>';
      var reasonHtml = b.reject_reason ? '<span class="warn">⚠ ' + b.reject_reason + '</span>' : '-';
      var actionHtml = (b.status === 'pending' || b.status === 'approved')
        ? '<button type="button" class="btn-cancel" data-cancel-id="' + b.id + '">예약 취소</button>'
        : '<span class="cell-dash">-</span>';

      var rebookHtml = b.room_id
        ? '<button type="button" class="btn-rebook" data-rebook-id="' + b.id + '">재예약</button>'
        : '<span class="cell-dash">-</span>';

      return '<tr data-status="' + b.status + '" data-booking-id="' + b.id + '">' +
        '<td class="space-name">' + spaceName + '</td>' +
        '<td>' + usage + '</td>' +
        '<td>' + (b.purpose || '-') + '</td>' +
        '<td>' + statusHtml + '</td>' +
        '<td class="reason">' + reasonHtml + '</td>' +
        '<td>' + actionHtml + '</td>' +
        '<td>' + rebookHtml + '</td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('[data-cancel-id]').forEach(function (btn) {
      btn.addEventListener('click', function () { cancelReservation(parseInt(btn.getAttribute('data-cancel-id'), 10)); });
    });
    tbody.querySelectorAll('[data-rebook-id]').forEach(function (btn) {
      btn.addEventListener('click', function () { openRebookModal(parseInt(btn.getAttribute('data-rebook-id'), 10)); });
    });
  }

  function clearActiveCards() {
    Object.keys(cards).forEach(function (k) { cards[k].classList.remove('active'); });
  }

  function filterByStatus(status, label) {
    clearActiveCards();
    cards[status].classList.add('active');
    currentFilterStatus = status;
    renderBookingTable();
    banner.classList.add('show');
    bannerText.textContent = '"' + label + '" 상태의 내역만 보고 있습니다.';
  }

  function showAll() {
    clearActiveCards();
    currentFilterStatus = '';
    renderBookingTable();
    banner.classList.remove('show');
  }

  async function cancelReservation(bookingId) {
    var b = MY_BOOKINGS.filter(function (x) { return x.id === bookingId; })[0];
    if (!b || (b.status !== 'pending' && b.status !== 'approved')) return;

    var spaceName = b.rooms ? ((b.rooms.buildings ? b.rooms.buildings.name + ' ' : '') + b.rooms.room_no + '호') : '이 강의실';
    var usage = formatBookingDate(b.booking_date).replace(/<br>/g, ' ') + ' ' + timeShort(b.start_time) + '~' + timeShort(b.end_time);
    var ok = confirm('"' + spaceName + '" (' + usage + ') 예약을 취소하시겠습니까?\n취소한 예약은 되돌릴 수 없습니다.');
    if (!ok) return;

    // 예약 행 자체는 하드 삭제하지만(마이페이지 목록에서 바로 사라짐), 감사로그는 남겨둠
    // (booking_logs.booking_id엔 FK가 없어서 예약이 삭제돼도 로그는 그대로 남음)
    await supabase.from('booking_logs').insert({
      booking_id: b.id, room_id: b.room_id, booking_date: b.booking_date,
      start_time: b.start_time, end_time: b.end_time, action: 'cancelled_by_requester',
      actor_id: currentUser.id, actor_name: currentUser.name,
      requester_id: currentUser.id, requester_name: currentUser.name
    });

    var res = await supabase.from('bookings').delete().eq('id', bookingId);
    if (res.error) { alert('취소에 실패했습니다: ' + res.error.message); return; }

    MY_BOOKINGS = MY_BOOKINGS.filter(function (x) { return x.id !== bookingId; });
    renderSummaryCounts();
    renderBookingTable();
  }

  /* ---------- 재예약 (이전 예약과 같은 강의실로, 날짜·시간을 자유롭게 선택해 새로 신청) ---------- */
  var rebookModalOverlay = document.getElementById('rebookModalOverlay');
  var rebookDateInput = document.getElementById('rebookDateInput');
  var rebookStartTimeSelect = document.getElementById('rebookStartTimeSelect');
  var rebookEndTimeSelect = document.getElementById('rebookEndTimeSelect');
  var rebookPurposeInput = document.getElementById('rebookPurposeInput');
  var rebookErrorBox = document.getElementById('rebookErrorBox');
  var rebookConfirmBtn = document.getElementById('rebookModalConfirmBtn');
  var rebookTarget = null; // { roomId, spaceName, headcount }

  // 이용 시간 선택 옵션 채우기 (09:00~19:00, 1시간 단위 - index.html의 예약 가능 시간대와 동일)
  (function fillRebookTimeOptions() {
    var startHtml = '', endHtml = '';
    for (var h = 9; h <= 19; h++) {
      var label = pad2(h) + ':00';
      startHtml += '<option value="' + h + '">' + label + '</option>';
      endHtml += '<option value="' + h + '">' + label + '</option>';
    }
    rebookStartTimeSelect.innerHTML = startHtml;
    rebookEndTimeSelect.innerHTML = endHtml;
  })();

  function hourToTimeStr(h) { return pad2(h) + ':00:00'; }

  function nextDateForWeekday(weekday) {
    // 오늘(포함) 이후 날짜 중 원래 예약과 같은 요일이 처음 오는 날짜를 기본값으로 제안
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    var diff = (weekday - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  function hideRebookError() {
    rebookErrorBox.style.display = 'none';
    rebookErrorBox.textContent = '';
  }

  function showRebookError(text) {
    rebookErrorBox.textContent = text;
    rebookErrorBox.style.display = 'block';
  }

  function openRebookModal(bookingId) {
    var b = MY_BOOKINGS.filter(function (x) { return x.id === bookingId; })[0];
    if (!b || !b.room_id) return;

    var spaceName = b.rooms ? ((b.rooms.buildings ? b.rooms.buildings.name + ' ' : '') + b.rooms.room_no + '호') : '해당 강의실';
    var origDow = new Date(b.booking_date + 'T00:00:00').getDay();
    var startHour = parseInt(b.start_time, 10);
    var endHour = parseInt(b.end_time, 10);

    rebookTarget = {
      roomId: b.room_id,
      spaceName: spaceName,
      headcount: b.headcount || null
    };

    document.getElementById('rebookModalDesc').innerHTML =
      '<b>' + spaceName + '</b><br>날짜와 시간을 자유롭게 선택해 재예약을 신청할 수 있습니다. (기본값: 이전과 같은 시간)';

    // 기본값: 날짜는 이전 예약과 같은 요일의 다음 날짜, 시간은 이전 예약과 동일한 시간
    var defaultDate = nextDateForWeekday(origDow);
    rebookDateInput.value = dateToISO(defaultDate);
    rebookDateInput.min = dateToISO(new Date());
    rebookStartTimeSelect.value = String(startHour);
    rebookEndTimeSelect.value = String(endHour);
    rebookPurposeInput.value = b.purpose || '';
    hideRebookError();
    rebookModalOverlay.classList.add('show');
  }

  document.getElementById('rebookModalCancelBtn').addEventListener('click', function () {
    rebookModalOverlay.classList.remove('show');
    rebookTarget = null;
  });

  // 선택한 날짜·시간에 겹치는 정규 수업/기존 예약을 모두 찾아서 반환 (충돌이 없으면 빈 배열)
  async function findRebookConflicts(roomId, dateStr, startTime, endTime, weekday) {
    var conflicts = [];

    // 1) 정규 수업(class_schedules)과 겹치는지 확인 (학기 기간 내인 경우만)
    if (CURRENT_SEMESTER_ID != null && CURRENT_SEMESTER &&
        !(CURRENT_SEMESTER.start_date > dateStr || CURRENT_SEMESTER.end_date < dateStr)) {
      var csRes = await supabase.from('class_schedules')
        .select('start_time, end_time, professor_name, subject_name')
        .eq('room_id', roomId).eq('weekday', weekday).eq('semester_id', CURRENT_SEMESTER_ID);
      if (!csRes.error && csRes.data) {
        csRes.data.forEach(function (cs) {
          if (startTime < cs.end_time && endTime > cs.start_time) {
            conflicts.push({
              start: cs.start_time, end: cs.end_time,
              label: '정규 수업 · ' + (cs.professor_name || '담당교수 미정') + (cs.subject_name ? (' (' + cs.subject_name + ')') : '')
            });
          }
        });
      }
    }

    // 2) 이미 승인/대기 중인 다른 예약과 겹치는지 확인
    var bkRes = await supabase.from('bookings')
      .select('start_time, end_time, status')
      .eq('room_id', roomId).eq('booking_date', dateStr).in('status', ['pending', 'approved']);
    if (!bkRes.error && bkRes.data) {
      bkRes.data.forEach(function (bk) {
        if (startTime < bk.end_time && endTime > bk.start_time) {
          conflicts.push({
            start: bk.start_time, end: bk.end_time,
            label: (STATUS_LABEL[bk.status] || bk.status) + ' 상태의 다른 예약'
          });
        }
      });
    }

    return conflicts;
  }

  function formatConflictList(conflicts) {
    return conflicts.map(function (c) {
      return '· ' + timeShort(c.start) + '~' + timeShort(c.end) + ' — ' + c.label;
    }).join('\n');
  }

  rebookConfirmBtn.addEventListener('click', async function () {
    if (!rebookTarget) { rebookModalOverlay.classList.remove('show'); return; }
    hideRebookError();

    if (!currentUser.personal_email) {
      showRebookError('개인 이메일을 등록(+인증)해야 예약을 신청할 수 있습니다. "회원정보 수정"에서 먼저 등록해주세요.');
      return;
    }

    var dateStr = rebookDateInput.value;
    if (!dateStr) { showRebookError('예약 날짜를 선택해주세요.'); return; }
    var todayStr = dateToISO(new Date());
    if (dateStr < todayStr) { showRebookError('오늘 이후의 날짜만 선택할 수 있습니다.'); return; }

    var startVal = rebookStartTimeSelect.value;
    var endVal = rebookEndTimeSelect.value;
    if (!startVal || !endVal) { showRebookError('이용 시작·종료 시간을 선택해주세요.'); return; }
    var startHour = parseInt(startVal, 10);
    var endHour = parseInt(endVal, 10);
    if (startHour >= endHour) { showRebookError('종료 시간은 시작 시간보다 이후여야 합니다.'); return; }

    var startTime = hourToTimeStr(startHour);
    var endTime = hourToTimeStr(endHour);
    var dow = new Date(dateStr + 'T00:00:00').getDay();

    rebookConfirmBtn.disabled = true;
    rebookConfirmBtn.textContent = '확인 중...';

    var conflicts = await findRebookConflicts(rebookTarget.roomId, dateStr, startTime, endTime, dow);

    rebookConfirmBtn.disabled = false;
    rebookConfirmBtn.textContent = '재예약 신청';

    if (conflicts.length) {
      showRebookError('선택하신 시간에 다음 예약이 있어 신청할 수 없습니다.\n' + formatConflictList(conflicts));
      return;
    }

    var purpose = rebookPurposeInput.value.trim();
    var insertRes = await supabase.from('bookings').insert([{
      room_id: rebookTarget.roomId,
      booking_date: dateStr,
      start_time: startTime,
      end_time: endTime,
      purpose: purpose || null,
      headcount: rebookTarget.headcount,
      requester_id: currentUser.id,
      status: 'pending'
    }]).select();

    if (insertRes.error) { showRebookError('재예약 신청에 실패했습니다: ' + insertRes.error.message); return; }

    if (insertRes.data && insertRes.data[0]) {
      var newBooking = insertRes.data[0];
      await supabase.from('booking_logs').insert({
        booking_id: newBooking.id, room_id: newBooking.room_id, booking_date: newBooking.booking_date,
        start_time: newBooking.start_time, end_time: newBooking.end_time, action: 'applied',
        actor_id: currentUser.id, actor_name: currentUser.name,
        requester_id: currentUser.id, requester_name: currentUser.name
      });
    }

    rebookModalOverlay.classList.remove('show');
    var doneSpaceName = rebookTarget.spaceName;
    rebookTarget = null;

    await loadMyBookings();
    renderSummaryCounts();
    renderBookingTable();
    showPageMessage(doneSpaceName + ' 예약이 재신청되었습니다. 담당 중간관리자 승인 후 확정됩니다.', 'success');
  });

  /* ---------- 회원정보 수정 (1단계: 비밀번호 재확인 -> 2단계: 이름/연락처 수정) ---------- */
  var pwConfirmModalOverlay = document.getElementById('pwConfirmModalOverlay');
  var pwConfirmInput = document.getElementById('pwConfirmInput');
  var pwConfirmErrorBox = document.getElementById('pwConfirmErrorBox');
  var pwConfirmConfirmBtn = document.getElementById('pwConfirmConfirmBtn');

  var editProfileModalOverlay = document.getElementById('editProfileModalOverlay');
  var editProfileNameInput = document.getElementById('editProfileNameInput');
  var editProfilePhoneInput = document.getElementById('editProfilePhoneInput');
  var editProfileEmailInput = document.getElementById('editProfileEmailInput');
  var editProfileCodeField = document.getElementById('editProfileCodeField');
  var editProfileCodeInput = document.getElementById('editProfileCodeInput');
  var editProfileSendCodeBtn = document.getElementById('editProfileSendCodeBtn');
  var editProfileCheckCodeBtn = document.getElementById('editProfileCheckCodeBtn');
  var editProfileEmailStatus = document.getElementById('editProfileEmailStatus');
  var editProfileErrorBox = document.getElementById('editProfileErrorBox');
  var editProfileSaveBtn = document.getElementById('editProfileSaveBtn');

  // 모달을 열었을 때의 개인이메일 값(변경 여부 판단 기준)과, 새 값에 대한 인증 완료 여부
  var originalPersonalEmail = '';
  var profileEmailVerified = false;

  editProfileEmailInput.addEventListener('input', function () {
    profileEmailVerified = false;
    editProfileEmailStatus.textContent = '';
    editProfileCodeField.style.display = 'none';
  });

  editProfileSendCodeBtn.addEventListener('click', async function () {
    var email = editProfileEmailInput.value.trim();
    if (!email) {
      editProfileErrorBox.textContent = '이메일을 입력해주세요.';
      editProfileErrorBox.style.display = 'block';
      return;
    }
    editProfileErrorBox.style.display = 'none';
    editProfileSendCodeBtn.disabled = true;
    editProfileSendCodeBtn.textContent = '발송 중...';

    var res = await supabase.functions.invoke('send-verification-code', { body: { email: email } });

    editProfileSendCodeBtn.disabled = false;
    editProfileSendCodeBtn.textContent = '인증코드 발송';

    if (res.error || (res.data && res.data.error)) {
      var errMsg = (res.data && res.data.error) || res.error.message;
      editProfileErrorBox.textContent = '인증코드 발송에 실패했습니다: ' + errMsg;
      editProfileErrorBox.style.display = 'block';
      return;
    }

    editProfileCodeField.style.display = 'block';
    editProfileEmailStatus.style.color = 'var(--gray-500)';
    editProfileEmailStatus.textContent = '인증코드를 발송했습니다. 메일을 확인해주세요.';
  });

  editProfileCheckCodeBtn.addEventListener('click', async function () {
    var email = editProfileEmailInput.value.trim();
    var code = editProfileCodeInput.value.trim();
    if (!code) {
      editProfileErrorBox.textContent = '인증코드를 입력해주세요.';
      editProfileErrorBox.style.display = 'block';
      return;
    }
    editProfileErrorBox.style.display = 'none';
    editProfileCheckCodeBtn.disabled = true;
    editProfileCheckCodeBtn.textContent = '확인 중...';

    var res = await supabase.functions.invoke('verify-email-code', { body: { email: email, code: code } });

    editProfileCheckCodeBtn.disabled = false;
    editProfileCheckCodeBtn.textContent = '확인';

    if (res.error || !res.data || !res.data.verified) {
      var reason = (res.data && res.data.reason) || (res.error && res.error.message) || '인증에 실패했습니다.';
      editProfileErrorBox.textContent = reason;
      editProfileErrorBox.style.display = 'block';
      profileEmailVerified = false;
      return;
    }

    profileEmailVerified = true;
    editProfileEmailStatus.style.color = 'var(--success)';
    editProfileEmailStatus.textContent = '✓ 인증 완료되었습니다. 저장을 눌러 반영하세요.';
  });

  function openPwConfirmModal() {
    pwConfirmInput.value = '';
    pwConfirmErrorBox.style.display = 'none';
    pwConfirmModalOverlay.classList.add('show');
    pwConfirmInput.focus();
  }
  document.getElementById('pwConfirmCancelBtn').addEventListener('click', function () {
    pwConfirmModalOverlay.classList.remove('show');
  });
  pwConfirmModalOverlay.addEventListener('click', function (e) { if (e.target === pwConfirmModalOverlay) pwConfirmModalOverlay.classList.remove('show'); });

  pwConfirmConfirmBtn.addEventListener('click', async function () {
    var pw = pwConfirmInput.value;
    if (!pw) {
      pwConfirmErrorBox.textContent = '비밀번호를 입력해주세요.';
      pwConfirmErrorBox.style.display = 'block';
      return;
    }

    pwConfirmConfirmBtn.disabled = true;
    pwConfirmConfirmBtn.textContent = '확인 중...';

    // 세션을 새로 만드는 게 아니라, 현재 로그인된 이메일+입력한 비밀번호가 맞는지만 재검증하는 용도
    var reauth = await supabase.auth.signInWithPassword({ email: currentUser.email, password: pw });

    pwConfirmConfirmBtn.disabled = false;
    pwConfirmConfirmBtn.textContent = '확인';

    if (reauth.error) {
      pwConfirmErrorBox.textContent = '비밀번호가 올바르지 않습니다.';
      pwConfirmErrorBox.style.display = 'block';
      return;
    }

    pwConfirmModalOverlay.classList.remove('show');
    openEditProfileModal();
  });

  function openEditProfileModal() {
    editProfileNameInput.value = currentUser.name || '';
    editProfilePhoneInput.value = currentUser.phone || '';
    originalPersonalEmail = currentUser.personal_email || '';
    editProfileEmailInput.value = originalPersonalEmail;
    profileEmailVerified = false;
    editProfileCodeField.style.display = 'none';
    editProfileCodeInput.value = '';
    editProfileEmailStatus.textContent = '';
    editProfileErrorBox.style.display = 'none';
    editProfileModalOverlay.classList.add('show');
  }
  document.getElementById('editProfileCancelBtn').addEventListener('click', function () {
    editProfileModalOverlay.classList.remove('show');
  });
  editProfileModalOverlay.addEventListener('click', function (e) { if (e.target === editProfileModalOverlay) editProfileModalOverlay.classList.remove('show'); });

  editProfileSaveBtn.addEventListener('click', async function () {
    var name = editProfileNameInput.value.trim();
    var phone = editProfilePhoneInput.value.trim();
    var email = editProfileEmailInput.value.trim();
    var emailChanged = email !== originalPersonalEmail;

    if (!name) {
      editProfileErrorBox.textContent = '이름을 입력해주세요.';
      editProfileErrorBox.style.display = 'block';
      return;
    }
    if (emailChanged && email && !profileEmailVerified) {
      editProfileErrorBox.textContent = '개인 이메일을 변경하려면 인증코드 확인을 먼저 완료해주세요.';
      editProfileErrorBox.style.display = 'block';
      return;
    }

    editProfileSaveBtn.disabled = true;
    editProfileSaveBtn.textContent = '저장 중...';

    var res = await supabase.from('users')
      .update({ name: name, phone: phone || null, personal_email: email || null })
      .eq('id', currentUser.id).select();

    editProfileSaveBtn.disabled = false;
    editProfileSaveBtn.textContent = '저장';

    if (res.error) {
      editProfileErrorBox.textContent = '저장에 실패했습니다: ' + res.error.message;
      editProfileErrorBox.style.display = 'block';
      return;
    }
    // RLS에 막히면 에러 없이 0건 처리될 수 있어서 반영 건수를 직접 확인
    if (!res.data || !res.data.length) {
      editProfileErrorBox.textContent = '저장에 실패했습니다: 권한이 없거나 반영되지 않았습니다.';
      editProfileErrorBox.style.display = 'block';
      return;
    }

    currentUser.name = name;
    currentUser.phone = phone || null;
    currentUser.personal_email = email || null;
    renderProfile();
    editProfileModalOverlay.classList.remove('show');
    showPageMessage('회원정보가 수정되었습니다.', 'success');
  });

  var ROLE_HOME = { assistant: 'index.html', mid_admin: 'manager.html', final_admin: 'admin.html' };
  function mainback() {
    window.location.href = (currentUser && ROLE_HOME[currentUser.role]) || 'index.html';
  }

  (async function init() {
    var ok = await requireSessionAndLoadUser();
    if (!ok) return;
    renderProfile();
    await Promise.all([loadMyBookings(), loadCurrentSemester()]);
    renderSummaryCounts();
    renderBookingTable();
  })();
