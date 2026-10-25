  /* ================= 기본 설정 ================= */
  var TIME_START = 9;
  var TIME_END = 18; // 09:00 ~ 18:00, 9시간
  var KOREAN_DOW = ["일", "월", "화", "수", "목", "금", "토"]; // 일=0 ~ 토=6 (class_schedules.weekday와 동일 규칙)

  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function dateToISO(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }
  function timeStrToHour(t) { return parseInt(String(t).split(":")[0], 10); }
  function hourToTimeStr(h) { return pad2(h) + ":00:00"; }

  function roomKey(bName, room) { return bName + "_" + room; }
  function displayRoomName(bName, room) { return bName + " " + room + "호"; }
  function roomLabel(bName, room) { return displayRoomName(bName, room); }

  var STATUS_LABELS = { available: "사용가능", closed: "사용중지" };

  /* ================= 로그인 확인 (실제 세션 기반) ================= */
  var currentUser = null; // { id, name, role }
  var MY_ROOMS = [];      // rooms row + { b, r } (buildingName, room_no)
  var ROOMS_BY_KEY = {};  // roomKey -> room
  var EQUIPMENT_LIST = []; // [{id, name}] 전체 기자재 마스터 목록

  async function requireMidAdmin() {
    var sessionRes = await supabase.auth.getSession();
    if (!sessionRes.data.session) { window.location.href = "login.html"; return false; }

    var profileRes = await supabase.from("users").select("id, name, role").eq("id", sessionRes.data.session.user.id).single();
    if (profileRes.error || !profileRes.data) { window.location.href = "login.html"; return false; }
    currentUser = profileRes.data;

    if (currentUser.role !== "mid_admin") {
      alert("중간관리자 계정으로만 접근할 수 있습니다.");
      window.location.href = "login.html";
      return false;
    }
    return true;
  }

  async function loadMyRooms() {
    var res = await supabase
      .from("rooms")
      .select("*, buildings!building_id(name)")
      .eq("manager_id", currentUser.id)
      .order("floor")
      .order("room_no");
    var rows = (!res.error && res.data) ? res.data : [];

    MY_ROOMS = rows.map(function (r) {
      return {
        id: r.id, building_id: r.building_id, floor: r.floor,
        b: r.buildings ? r.buildings.name : "", r: r.room_no,
        capacity: r.capacity, room_type_id: r.room_type_id, manager_id: r.manager_id,
        is_active: r.is_active, guideline_text: r.guideline_text, thumbnail_url: r.thumbnail_url,
        equipNames: [], equipIds: []
      };
    });
    ROOMS_BY_KEY = {};
    MY_ROOMS.forEach(function (r) { ROOMS_BY_KEY[roomKey(r.b, r.r)] = r; });

    if (!EQUIPMENT_LIST.length) {
      var equipRes = await supabase.from("equipment").select("id, name").order("id");
      EQUIPMENT_LIST = (!equipRes.error && equipRes.data) ? equipRes.data : [];
    }

    var roomIds = MY_ROOMS.map(function (r) { return r.id; });
    if (roomIds.length) {
      var reRes = await supabase.from("room_equipment").select("room_id, equipment_id, equipment:equipment_id(name)").in("room_id", roomIds);
      if (!reRes.error && reRes.data) {
        var byId = {};
        MY_ROOMS.forEach(function (r) { byId[r.id] = r; });
        reRes.data.forEach(function (row) {
          var rm = byId[row.room_id];
          if (!rm) return;
          rm.equipIds.push(row.equipment_id);
          if (row.equipment && row.equipment.name) rm.equipNames.push(row.equipment.name);
        });
      }
    }
  }

  function getRoomStatus(bName, room) {
    var rm = ROOMS_BY_KEY[roomKey(bName, room)];
    return (rm && rm.is_active) ? "available" : "closed";
  }

  /* ================= 학기 목록 (semesters 테이블, 전역 공유) ================= */
  var SEMESTERS = [];
  var CURRENT_SEMESTER_ID = null;
  var CURRENT_SEMESTER = null; // { id, start_date, end_date, ... } - 정기수업이 실제 이 기간 안에서만 보이게 하는 데 사용
  async function loadSemesters() {
    var res = await supabase.from("semesters").select("*").order("start_date");
    SEMESTERS = (!res.error && res.data) ? res.data : [];
    var cur = SEMESTERS.filter(function (s) { return s.is_current; })[0];
    CURRENT_SEMESTER = cur || null;
    CURRENT_SEMESTER_ID = cur ? cur.id : null;
  }

  /* ================= 상태 ================= */
  var state = {
    myRooms: [],           // MY_ROOMS와 동일 배열 참조
    selectedFilterKey: "", // "" = 전체, 아니면 "b_r"
    selectedBuilding: "",  // "" = 전체 건물, 아니면 건물명
    selection: { b: null, r: null, idx: null },
    selectedDate: new Date(),
    calViewMonth: new Date()
  };

  function formatSelectedDate() {
    var d = state.selectedDate;
    return d.getFullYear() + "년 " + (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + KOREAN_DOW[d.getDay()] + ")";
  }

  function mondayOf(date) {
    var day = date.getDay();
    var diff = (day === 0) ? -6 : (1 - day);
    var monday = new Date(date);
    monday.setDate(date.getDate() + diff);
    return monday;
  }

  // 선택된 날짜가 속한 주의 월~금 5일 목록: [{date, dow, label, dayNum, iso}]
  function weekDaysForSelection() {
    var monday = mondayOf(state.selectedDate);
    var days = [];
    for (var i = 0; i < 5; i++) {
      var dt = new Date(monday);
      dt.setDate(monday.getDate() + i);
      days.push({ date: dt, dow: dt.getDay(), label: KOREAN_DOW[dt.getDay()], dayNum: dt.getDate(), iso: dateToISO(dt) });
    }
    return days;
  }

  /* ================= 강의실 스케줄 (class_schedules + bookings 실제 조회) ================= */
  var SCHEDULE_CACHE = {}; // roomKey -> blocks[]
  var PENDING_BOOKINGS = []; // 담당 강의실 전체의 승인 대기 예약 (현재 보고 있는 주/날짜와 무관하게 전체 조회)

  async function fetchSchedules() {
    SCHEDULE_CACHE = {};
    MY_ROOMS.forEach(function (r) { SCHEDULE_CACHE[roomKey(r.b, r.r)] = []; });

    var roomIds = MY_ROOMS.map(function (r) { return r.id; });
    if (!roomIds.length) { PENDING_BOOKINGS = []; return; }

    var roomIdToKey = {};
    MY_ROOMS.forEach(function (r) { roomIdToKey[r.id] = roomKey(r.b, r.r); });

    var week = weekDaysForSelection();
    var weekIsoList = week.map(function (d) { return d.iso; });

    if (CURRENT_SEMESTER_ID != null) {
      var csRes = await supabase.from("class_schedules").select("*").in("room_id", roomIds).eq("semester_id", CURRENT_SEMESTER_ID);
      if (!csRes.error && csRes.data) {
        csRes.data.forEach(function (cs) {
          var key = roomIdToKey[cs.room_id];
          if (!key) return;
          // 이번 주(week)에서 해당 요일의 실제 날짜가 학기 기간 밖이면 정기수업을 표시하지 않음
          var dayInfo = week.filter(function (d) { return d.dow === cs.weekday; })[0];
          if (dayInfo && CURRENT_SEMESTER && (CURRENT_SEMESTER.start_date > dayInfo.iso || CURRENT_SEMESTER.end_date < dayInfo.iso)) return;
          SCHEDULE_CACHE[key].push({
            start: timeStrToHour(cs.start_time), end: timeStrToHour(cs.end_time),
            status: "approved", sub: cs.subject_name, applicant: cs.professor_name || "-",
            purpose: "정규 강의", headcount: "-", equip: "-", note: "-",
            days: [cs.weekday], classScheduleId: cs.id
          });
        });
      }
    }

    var bkRes = await supabase.from("bookings")
      .select("*, requester:users!requester_id(name)")
      .in("room_id", roomIds)
      .in("booking_date", weekIsoList)
      .in("status", ["pending", "approved", "rejected"]);
    if (!bkRes.error && bkRes.data) {
      bkRes.data.forEach(function (bk) {
        var key = roomIdToKey[bk.room_id];
        if (!key) return;
        var dayInfo = week.filter(function (d) { return d.iso === bk.booking_date; })[0];
        if (!dayInfo) return;
        SCHEDULE_CACHE[key].push({
          start: timeStrToHour(bk.start_time), end: timeStrToHour(bk.end_time),
          status: bk.status === "approved" ? "confirmed" : bk.status, // 'pending' | 'confirmed' | 'rejected'
          sub: bk.purpose || "예약", applicant: (bk.requester && bk.requester.name) || "알 수 없음",
          purpose: bk.purpose || "-", headcount: bk.headcount ? (bk.headcount + "명") : "-",
          equip: "-", note: bk.reject_reason || "-", days: [dayInfo.dow],
          bookingId: bk.id, requesterId: bk.requester_id, comment: bk.reject_reason || ""
        });
      });
    }

    // 승인 대기 목록은 현재 보고 있는 주/날짜와 무관하게 담당 강의실 전체를 대상으로 별도 조회
    // (하단 "승인 대기 목록" 패널이 특정 날짜로 이동해야만 보이는 문제를 막기 위함)
    var pendingRes = await supabase.from("bookings")
      .select("*, requester:users!requester_id(name)")
      .in("room_id", roomIds)
      .eq("status", "pending")
      .order("booking_date").order("start_time");
    if (!pendingRes.error && pendingRes.data) {
      PENDING_BOOKINGS = pendingRes.data.map(function (bk) {
        var key = roomIdToKey[bk.room_id];
        var rm = key ? ROOMS_BY_KEY[key] : null;
        return {
          bookingId: bk.id, b: rm ? rm.b : "", r: rm ? rm.r : "",
          bookingDate: bk.booking_date, start: timeStrToHour(bk.start_time), end: timeStrToHour(bk.end_time),
          sub: bk.purpose || "예약", applicant: (bk.requester && bk.requester.name) || "알 수 없음"
        };
      });
    } else {
      PENDING_BOOKINGS = [];
    }
  }

  function scheduleFor(bName, room) {
    return SCHEDULE_CACHE[roomKey(bName, room)] || [];
  }

  /* ================= 로그인 화면 참조 ================= */
  var loginScreen = document.getElementById("loginScreen");
  var appRoot = document.getElementById("appRoot");

  document.getElementById("logoutBtn").addEventListener("click", async function () {
    await supabase.auth.signOut();
    window.location.href = "login.html";
  });

  /* ================= 시간 헤더 ================= */
  (function renderHours() {
    var row = document.getElementById("hoursRow");
    var html = "<div></div>";
    for (var h = TIME_START; h < TIME_END; h++) html += "<div>" + (h < 10 ? "0" + h : h) + "</div>";
    row.innerHTML = html;
  })();

  /* ================= 건물 선택 ================= */
  function renderBuildingGrid() {
    var grid = document.getElementById("buildingGrid");
    var byBuilding = {};
    state.myRooms.forEach(function (rm) {
      if (!byBuilding[rm.b]) byBuilding[rm.b] = [];
      byBuilding[rm.b].push(rm);
    });
    var buildings = Object.keys(byBuilding).sort();

    var html = '<div class="floor-item' + (state.selectedBuilding === "" ? " selected" : "") + '" data-building="">전체</div>';
    html += buildings.map(function (b) {
      var pending = PENDING_BOOKINGS.filter(function (p) { return p.b === b; }).length;
      var badgeClass = "fbadge" + (pending === 0 ? " zero" : "");
      return '<div class="floor-item' + (state.selectedBuilding === b ? " selected" : "") + '" data-building="' + b + '">' +
        b + '<span class="' + badgeClass + '">' + pending + '</span></div>';
    }).join("");

    grid.innerHTML = html;
    grid.querySelectorAll(".floor-item").forEach(function (item) {
      item.addEventListener("click", function () {
        state.selectedBuilding = item.getAttribute("data-building");
        state.selectedFilterKey = ""; // 건물을 바꾸면 강의실 개별 필터는 초기화
        renderBuildingGrid();
        renderMyRoomGroup();
        renderTimelineAndPanels();
      });
    });
  }

  /* ================= 내 담당 강의실 목록 ================= */
  function renderMyRoomGroup() {
    var group = document.getElementById("myRoomGroup");
    var roomsInBuilding = state.myRooms.filter(function (rm) {
      return !state.selectedBuilding || rm.b === state.selectedBuilding;
    });
    var html = '<div class="radio-item' + (state.selectedFilterKey === "" ? " selected" : "") + '" data-key=""><span class="dot"></span>전체 보기</div>';
    html += roomsInBuilding.map(function (rm) {
      var key = roomKey(rm.b, rm.r);
      var label = displayRoomName(rm.b, rm.r);
      var status = getRoomStatus(rm.b, rm.r);
      var badge = status !== "available" ? '<span class="status-badge st-' + status + '">' + STATUS_LABELS[status] + '</span>' : '';
      return '<div class="radio-item' + (state.selectedFilterKey === key ? " selected" : "") + '" data-key="' + key + '"><span class="dot"></span>' + label + badge + '</div>';
    }).join("");
    group.innerHTML = html;
    group.querySelectorAll(".radio-item").forEach(function (item) {
      item.addEventListener("click", function () {
        state.selectedFilterKey = item.getAttribute("data-key");
        renderMyRoomGroup();
        renderTimelineAndPanels();

        if (state.selectedFilterKey) {
          var rm = state.myRooms.filter(function (r) { return roomKey(r.b, r.r) === state.selectedFilterKey; })[0];
          if (rm) showRoomDetailPanel(rm.b, rm.r);
        } else {
          resetDetailPanel();
        }
      });
    });
  }

  function visibleRooms() {
    var rooms = state.myRooms;
    if (state.selectedBuilding) {
      rooms = rooms.filter(function (rm) { return rm.b === state.selectedBuilding; });
    }
    if (!state.selectedFilterKey) return rooms;
    return rooms.filter(function (rm) { return roomKey(rm.b, rm.r) === state.selectedFilterKey; });
  }

  /* ================= Ajax 갱신 ================= */
  document.getElementById("ajaxBtn").addEventListener("click", async function () {
    var btn = this;
    btn.classList.add("spinning");
    btn.disabled = true;
    var original = btn.innerHTML;

    await loadMyRooms();
    state.myRooms = MY_ROOMS;
    await fetchSchedules();

    btn.classList.remove("spinning");
    btn.disabled = false;
    btn.innerHTML = '<span class="spin">✓</span> 갱신 완료';
    renderBuildingGrid();
    renderMyRoomGroup();
    renderAll();
    setTimeout(function () { btn.innerHTML = original; }, 1200);
  });

  /* ================= 달력 보기 ================= */
  var calBtn = document.getElementById("calBtn");
  var miniCal = document.getElementById("miniCal");
  calBtn.addEventListener("click", function () {
    renderMiniCal();
    miniCal.classList.toggle("show");
  });
  document.addEventListener("click", function (e) {
    if (!e.target.closest(".cal-box")) miniCal.classList.remove("show");
  });

  function renderMiniCal() {
    var grid = document.getElementById("mcGrid");
    var label = document.getElementById("mcLabel");
    var y = state.calViewMonth.getFullYear(), m = state.calViewMonth.getMonth();
    label.textContent = y + "년 " + (m + 1) + "월";

    var firstDow = new Date(y, m, 1).getDay();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var selIso = dateToISO(state.selectedDate);

    var html = KOREAN_DOW.map(function (d) { return '<div class="dow">' + d + '</div>'; }).join("");
    for (var i = 0; i < firstDow; i++) html += '<div class="day empty"></div>';
    for (var d = 1; d <= daysInMonth; d++) {
      var iso = dateToISO(new Date(y, m, d));
      html += '<div class="day' + (iso === selIso ? " today" : "") + '" data-day="' + d + '">' + d + '</div>';
    }
    grid.innerHTML = html;
    grid.querySelectorAll(".day[data-day]").forEach(function (el) {
      el.addEventListener("click", async function () {
        var d = parseInt(el.getAttribute("data-day"), 10);
        state.selectedDate = new Date(y, m, d);
        state.calViewMonth = new Date(y, m, 1);
        await onDateChanged();
        miniCal.classList.remove("show");
      });
    });
  }

  document.getElementById("mcPrev").addEventListener("click", function (e) {
    e.stopPropagation();
    state.calViewMonth.setMonth(state.calViewMonth.getMonth() - 1);
    renderMiniCal();
  });
  document.getElementById("mcNext").addEventListener("click", function (e) {
    e.stopPropagation();
    state.calViewMonth.setMonth(state.calViewMonth.getMonth() + 1);
    renderMiniCal();
  });

  async function onDateChanged() {
    await fetchSchedules();
    renderMiniCal();
    renderTimelineAndPanels();
  }

  document.getElementById("datePrevBtn").addEventListener("click", async function () {
    state.selectedDate.setDate(state.selectedDate.getDate() - 1);
    await onDateChanged();
  });
  document.getElementById("dateNextBtn").addEventListener("click", async function () {
    state.selectedDate.setDate(state.selectedDate.getDate() + 1);
    await onDateChanged();
  });

  /* ================= 유틸 ================= */
  function timeLabel(h) {
    var hh = Math.floor(h);
    var mm = Math.round((h - hh) * 60);
    return (hh < 10 ? "0" : "") + hh + ":" + (mm === 0 ? "00" : mm);
  }
  function segStyle(b) {
    var left = ((b.start - TIME_START) / (TIME_END - TIME_START)) * 100;
    var width = ((b.end - b.start) / (TIME_END - TIME_START)) * 100;
    return "left:" + left + "%; width:" + width + "%;";
  }
  function statusLabel(s) {
    return s === "approved" ? "정기수업" : s === "pending" ? "대기중" : s === "confirmed" ? "확정예약" : "거절됨";
  }

  var weekViewRoom = null; // 강의실 하나를 선택해 주간 보기를 렌더링 중일 때 해당 강의실 {b, r}

  /* ================= 타임라인 렌더링 ================= */
  function renderTimeline() {
    pendingDragSelections = []; // 타임라인이 다시 그려지면(필터/날짜 변경 등) 이전 드래그 선택 표시는 의미가 없으므로 초기화
    var container = document.getElementById("timelineList");
    var rooms = visibleRooms();

    if (!rooms.length) {
      container.innerHTML = '<div class="empty-hint">담당 강의실이 없습니다</div>';
      return;
    }

    // 강의실을 하나 선택한 경우: 해당 강의실의 월~금 전체를 보여줌
    if (state.selectedFilterKey && rooms.length === 1) {
      renderRoomWeekView(container, rooms[0]);
      return;
    }

    // 전체 보기: 담당 강의실 전체의 당일(선택한 날짜) 일정만 보여줌
    weekViewRoom = null;
    container.innerHTML = rooms.map(function (rm) {
      var blocks = scheduleFor(rm.b, rm.r);
      var status = getRoomStatus(rm.b, rm.r);
      var segsHtml = blocks.map(function (b, idx) {
        if (!isBlockVisibleToday(b)) return "";
        var sel = (state.selection.b === rm.b && state.selection.r === rm.r && state.selection.idx === idx) ? " selected" : "";
        return '<div class="seg status-' + b.status + sel + '" style="' + segStyle(b) + '" ' +
          'data-b="' + rm.b + '" data-r="' + rm.r + '" data-idx="' + idx + '" ' +
          'data-info="' + displayRoomName(rm.b, rm.r) + ' · ' + timeLabel(b.start) + '-' + timeLabel(b.end) + ' · ' + b.applicant + ' · ' + b.sub + '">' +
          b.applicant + '</div>';
      }).join("");
      return '<div class="grid-body' + (status !== "available" ? " room-unavailable" : "") + '">' +
        '<div class="room-tag-cell">' +
        '<span class="room-tag">' + displayRoomName(rm.b, rm.r) + '</span>' +
        (status !== "available" ? '<span class="status-badge st-' + status + '">' + STATUS_LABELS[status] + '</span>' : '') +
        '<button type="button" class="room-edit-btn" data-b="' + rm.b + '" data-r="' + rm.r + '" title="강의실 정보 수정">✎ 수정</button>' +
        '</div>' +
        '<div class="track-wrap"' + (status !== "available" ? ' data-unavailable-label="🚧 ' + STATUS_LABELS[status] + '으로 예약을 받지 않아요"' : '') + '><div class="track">' + segsHtml + '</div></div>' +
        '</div>';
    }).join("");
  }

  // 강의실 하나를 선택했을 때: 월~금 5일치를 한 번에 보여줌
  function renderRoomWeekView(container, rm) {
    var blocks = scheduleFor(rm.b, rm.r);
    var status = getRoomStatus(rm.b, rm.r);
    var week = weekDaysForSelection();
    var todayIso = dateToISO(state.selectedDate);

    var header = '<div class="week-room-header">' +
      '<span class="room-tag">' + displayRoomName(rm.b, rm.r) + '</span>' +
      (status !== "available" ? '<span class="status-badge st-' + status + '">' + STATUS_LABELS[status] + '</span>' : '') +
      '<button type="button" class="room-edit-btn" data-b="' + rm.b + '" data-r="' + rm.r + '" title="강의실 정보 수정">✎ 수정</button>' +
      '</div>';

    var rowsHtml = week.map(function (d) {
      var segsHtml = blocks.map(function (b, idx) {
        if (!isBlockVisibleOnDow(b, d.dow)) return "";
        var sel = (state.selection.b === rm.b && state.selection.r === rm.r && state.selection.idx === idx) ? " selected" : "";
        return '<div class="seg status-' + b.status + sel + '" style="' + segStyle(b) + '" ' +
          'data-b="' + rm.b + '" data-r="' + rm.r + '" data-idx="' + idx + '" ' +
          'data-info="' + displayRoomName(rm.b, rm.r) + ' · ' + d.label + '요일 ' + timeLabel(b.start) + '-' + timeLabel(b.end) + ' · ' + b.applicant + ' · ' + b.sub + '">' +
          b.applicant + '</div>';
      }).join("");
      var isToday = d.iso === todayIso;
      var rowClass = "week-day-row" + (isToday ? " is-today" : "") + (status !== "available" ? " room-unavailable" : "");
      return '<div class="' + rowClass + '">' +
        '<div class="week-day-label">' + d.label + '<span>' + d.dayNum + '일</span></div>' +
        '<div class="track-wrap"' + (status !== "available" ? ' data-unavailable-label="🚧 ' + STATUS_LABELS[status] + '으로 예약을 받지 않아요"' : '') +
        '><div class="track" data-dow="' + d.dow + '">' + segsHtml + '</div></div>' +
        '</div>';
    }).join("");

    container.innerHTML = header + rowsHtml;
    weekViewRoom = { b: rm.b, r: rm.r };
  }

  var timelineList = document.getElementById("timelineList");
  timelineList.addEventListener("click", function (e) {
    var editBtn = e.target.closest(".room-edit-btn");
    if (editBtn) {
      openEditRoomModal(editBtn.getAttribute("data-b"), editBtn.getAttribute("data-r"));
      return;
    }
    var seg = e.target.closest(".seg");
    if (!seg) return;
    selectReservation(seg.getAttribute("data-b"), seg.getAttribute("data-r"), parseInt(seg.getAttribute("data-idx"), 10));
  });
  timelineList.addEventListener("mouseover", function (e) {
    var seg = e.target.closest(".seg");
    if (!seg) return;
    document.getElementById("tooltip").textContent = seg.getAttribute("data-info");
  });
  timelineList.addEventListener("mouseout", function (e) {
    if (!e.target.closest(".seg")) return;
    document.getElementById("tooltip").textContent = "회색/파랑/노랑 블록에 마우스를 올리면 상세 정보가 표시됩니다.";
  });

  /* ================= 우측 예약 목록 ================= */
  function renderResvList() {
    var list = document.getElementById("resvList");
    if (!state.selection.b) {
      list.innerHTML = '<div class="empty-hint">타임라인에서 강의실 블록을 선택하면<br>해당 강의실의 예약 목록이 표시됩니다</div>';
      return;
    }
    var blocks = scheduleFor(state.selection.b, state.selection.r);
    list.innerHTML = blocks.map(function (b, idx) {
      if (!isBlockVisibleToday(b)) return "";
      var active = (state.selection.idx === idx) ? " active" : "";
      return '<div class="resv-item' + active + '" data-idx="' + idx + '">' +
        '<span class="rtime">' + timeLabel(b.start) + '~' + timeLabel(b.end) + '</span>' +
        '<span class="rmid">' + b.sub + '</span>' +
        '<span class="rstatus status-' + b.status + '">' + statusLabel(b.status) + '</span>' +
        '</div>';
    }).join("");
    list.querySelectorAll(".resv-item").forEach(function (el) {
      el.addEventListener("click", function () {
        selectReservation(state.selection.b, state.selection.r, parseInt(el.getAttribute("data-idx"), 10));
      });
    });
  }

  /* ================= 예약 건 선택 ================= */
  function selectReservation(bName, room, idx) {
    state.selection = { b: bName, r: room, idx: idx };
    var b = scheduleFor(bName, room)[idx];
    if (!b) return;
    var rm = ROOMS_BY_KEY[roomKey(bName, room)];
    var label = displayRoomName(bName, room);

    document.getElementById("roomTitleR").textContent = label + " 예약 정보";
    document.getElementById("roomMetaR").textContent = "예약 정보 목록 (" + formatSelectedDate() + ")";
    document.getElementById("roomInfoR").textContent =
      "수용인원 " + (rm ? rm.capacity + "명" : "-") + " · 보유장비 " + (rm && rm.equipNames.length ? rm.equipNames.join(", ") : "정보 없음");
    document.getElementById("editRoomFromDetailBtn").style.display = "inline-block";

    var roomStatus = getRoomStatus(bName, room);
    var warnBanner = document.getElementById("statusWarningBanner");
    if (roomStatus !== "available") {
      warnBanner.className = "status-warning-banner show";
      warnBanner.textContent = "🚧 이 강의실은 최종관리자가 \"" + STATUS_LABELS[roomStatus] + "\" 상태로 지정했어요. 승인 전에 확인해주세요.";
    } else {
      warnBanner.className = "status-warning-banner";
      warnBanner.textContent = "";
    }

    document.getElementById("detailBox").innerHTML =
      '<div class="drow"><div class="dlabel">신청자</div><div class="dval">' + b.applicant + '</div></div>' +
      '<div class="drow"><div class="dlabel">대여목적</div><div class="dval">' + b.purpose + '</div></div>' +
      '<div class="drow"><div class="dlabel">이용시간</div><div class="dval">' + timeLabel(b.start) + ' ~ ' + timeLabel(b.end) + '</div></div>' +
      '<div class="drow"><div class="dlabel">이용인원</div><div class="dval">' + b.headcount + '</div></div>' +
      '<div class="drow"><div class="dlabel">장비 요청</div><div class="dval">' + b.equip + '</div></div>' +
      '<div class="drow"><div class="dlabel">특이사항</div><div class="dval">' + b.note + '</div></div>';

    document.getElementById("adminComment").value = b.comment || "";

    var banner = document.getElementById("statusBanner");
    var approveBtn = document.getElementById("approveBtn");
    var rejectBtn = document.getElementById("rejectBtn");
    var cancelMakeupBtn = document.getElementById("cancelMakeupBtn");

    if (b.status === "pending") {
      banner.className = "status-banner show locked";
      banner.textContent = "관리자 승인이 필요한 예약 건입니다.";
      approveBtn.disabled = false; rejectBtn.disabled = false; cancelMakeupBtn.disabled = true;
    } else if (b.status === "approved") {
      banner.className = "status-banner show approved";
      banner.textContent = "정규 수업(고정 일정)으로, 승인/거절 대상이 아닙니다.";
      approveBtn.disabled = true; rejectBtn.disabled = true; cancelMakeupBtn.disabled = true;
    } else if (b.status === "confirmed") {
      banner.className = "status-banner show approved";
      banner.textContent = "이미 승인 완료된 예약입니다.";
      approveBtn.disabled = true; rejectBtn.disabled = false; cancelMakeupBtn.disabled = false;
    } else {
      banner.className = "status-banner show rejected";
      banner.textContent = "거절 처리된 예약입니다.";
      approveBtn.disabled = false; rejectBtn.disabled = true; cancelMakeupBtn.disabled = true;
    }

    renderTimeline();
    renderResvList();
    renderSummary();
    renderBookingLogBox(b.bookingId || null);
  }

  /* ================= 처리 이력(감사로그) 보기 ================= */
  async function renderBookingLogBox(bookingId) {
    var box = document.getElementById("bookingLogBox");
    if (!bookingId) { box.innerHTML = ""; return; }

    var res = await supabase.from("booking_logs")
      .select("action, actor_name, requester_name, reason, created_at")
      .eq("booking_id", bookingId)
      .order("created_at", { ascending: false });

    var ACTION_LABEL = {
      applied: "신청됨", approved: "승인됨", rejected: "거절됨",
      cancelled_by_requester: "본인이 취소함", cancelled_by_manager: "관리자가 취소함(보강 등)"
    };

    if (res.error || !res.data || !res.data.length) {
      box.innerHTML = '<div style="font-weight:700; margin-bottom:4px;">처리 이력</div><div>기록이 없습니다.</div>';
      return;
    }

    box.innerHTML = '<div style="font-weight:700; margin-bottom:6px;">처리 이력</div>' +
      res.data.map(function (log) {
        var when = String(log.created_at).replace("T", " ").slice(0, 16);
        return '<div style="padding:6px 0; border-top:1px solid #E7E9ED;">' +
          '<b>' + (ACTION_LABEL[log.action] || log.action) + '</b> · ' + when + '<br>' +
          '처리자: ' + (log.actor_name || "-") +
          (log.reason ? ('<br>사유: ' + log.reason) : '') +
          '</div>';
      }).join('');
  }

  /* ================= 승인 / 거절 (실제 bookings 업데이트) ================= */
  document.getElementById("approveBtn").addEventListener("click", openApproveModal);
  document.getElementById("rejectBtn").addEventListener("click", openRejectModal);

  async function handleDecision(newStatus) {
    if (!state.selection.b || state.selection.idx === null) return;
    var blocks = scheduleFor(state.selection.b, state.selection.r);
    var b = blocks[state.selection.idx];
    if (!b || b.status === "approved" || !b.bookingId) return; // 정규 수업은 변경 불가

    var comment = document.getElementById("adminComment").value;
    var updatePayload = {
      status: newStatus === "approved" ? "approved" : "rejected",
      reviewed_by: currentUser.id,
      reviewed_at: new Date().toISOString()
    };
    if (newStatus !== "approved") updatePayload.reject_reason = comment || null;

    var res = await supabase.from("bookings").update(updatePayload).eq("id", b.bookingId).select().single();
    if (res.error) { alert("처리에 실패했습니다: " + res.error.message); return; }

    var room = ROOMS_BY_KEY[roomKey(state.selection.b, state.selection.r)];
    await supabase.from("booking_logs").insert({
      booking_id: b.bookingId, room_id: room ? room.id : null,
      booking_date: res.data.booking_date, start_time: res.data.start_time, end_time: res.data.end_time,
      action: newStatus === "approved" ? "approved" : "rejected",
      actor_id: currentUser.id, actor_name: currentUser.name,
      requester_id: b.requesterId, requester_name: b.applicant,
      reason: newStatus !== "approved" ? (comment || null) : null
    });

    var bookingId = b.bookingId;
    var selB = state.selection.b, selR = state.selection.r;
    await fetchSchedules();
    renderTimelineAndPanels();
    var newBlocks = scheduleFor(selB, selR);
    var newIdx = newBlocks.findIndex(function (x) { return x.bookingId === bookingId; });
    if (newIdx !== -1) selectReservation(selB, selR, newIdx);
    else renderResvList();
  }

  var approveModalOverlay = document.getElementById("approveModalOverlay");
  function openApproveModal() {
    if (!state.selection.b || state.selection.idx === null) return;
    approveModalOverlay.classList.add("show");
  }
  function closeApproveModal() { approveModalOverlay.classList.remove("show"); }
  document.getElementById("approveModalCancelBtn").addEventListener("click", closeApproveModal);
  approveModalOverlay.addEventListener("click", function (e) { if (e.target === approveModalOverlay) closeApproveModal(); });
  document.getElementById("approveModalConfirmBtn").addEventListener("click", function () { handleDecision("approved"); closeApproveModal(); });

  var rejectModalOverlay = document.getElementById("rejectModalOverlay");
  function openRejectModal() {
    if (!state.selection.b || state.selection.idx === null) return;
    rejectModalOverlay.classList.add("show");
  }
  function closeRejectModal() { rejectModalOverlay.classList.remove("show"); }
  document.getElementById("modalCancelBtn").addEventListener("click", closeRejectModal);

  /* ================= 알림(🔔): 내 담당 강의실의 승인 대기 건만 모아서 보여줌 ================= */
  var bellToggle = document.getElementById("bellToggle");
  var bellDropdown = document.getElementById("bellDropdown");

  function renderBellDropdown() {
    if (!PENDING_BOOKINGS.length) {
      bellDropdown.innerHTML = '<div class="bell-empty">새로운 알림이 없습니다</div>';
      return;
    }
    bellDropdown.innerHTML = '<div class="bell-title">내 담당 강의실 승인 대기 (' + PENDING_BOOKINGS.length + "건)</div>" +
      PENDING_BOOKINGS.slice(0, 8).map(function (row) {
        return '<div class="bell-item">' + displayRoomName(row.b, row.r) + " · " + shortDateLabel(row.bookingDate) + " " +
          timeLabel(row.start) + "~" + timeLabel(row.end) +
          '<br><span class="bell-sub">' + row.applicant + " · " + row.sub + "</span></div>";
      }).join("");
  }

  bellToggle.addEventListener("click", function (e) {
    e.stopPropagation();
    renderBellDropdown();
    bellDropdown.classList.toggle("show");
    document.getElementById("bellDot").style.display = "none"; // 알림창을 열어서 확인한 순간 빨간 점은 끔
  });
  bellDropdown.addEventListener("click", function (e) { e.stopPropagation(); });
  document.addEventListener("click", function () { bellDropdown.classList.remove("show"); });

  /* ================= 보강으로 인한 취소 (이미 승인된 예약만 대상, 거절과는 별개 동작) ================= */
  var cancelMakeupModalOverlay = document.getElementById("cancelMakeupModalOverlay");
  var cancelMakeupReasonInput = document.getElementById("cancelMakeupReasonInput");
  var cancelMakeupErrorBox = document.getElementById("cancelMakeupErrorBox");
  var cancelMakeupConfirmBtn = document.getElementById("cancelMakeupModalConfirmBtn");

  document.getElementById("cancelMakeupBtn").addEventListener("click", function () {
    if (!state.selection.b || state.selection.idx === null) return;
    cancelMakeupReasonInput.value = "";
    cancelMakeupErrorBox.style.display = "none";
    cancelMakeupModalOverlay.classList.add("show");
  });
  document.getElementById("cancelMakeupModalCancelBtn").addEventListener("click", function () {
    cancelMakeupModalOverlay.classList.remove("show");
  });
  cancelMakeupModalOverlay.addEventListener("click", function (e) {
    if (e.target === cancelMakeupModalOverlay) cancelMakeupModalOverlay.classList.remove("show");
  });

  cancelMakeupConfirmBtn.addEventListener("click", async function () {
    var reason = cancelMakeupReasonInput.value.trim();
    if (!reason) {
      cancelMakeupErrorBox.textContent = "취소 사유(보강 수업 정보 등)를 입력해주세요.";
      cancelMakeupErrorBox.style.display = "block";
      return;
    }
    if (!state.selection.b || state.selection.idx === null) return;
    var blocks = scheduleFor(state.selection.b, state.selection.r);
    var b = blocks[state.selection.idx];
    if (!b || !b.bookingId) return;

    cancelMakeupConfirmBtn.disabled = true;
    cancelMakeupConfirmBtn.textContent = "처리 중...";

    // 이메일 발송에 필요한 정보(날짜/시간/강의실명/신청자 개인이메일)를 직접 다시 조회
    var bkRes = await supabase.from("bookings")
      .select("room_id, booking_date, start_time, end_time, rooms(room_no, buildings!building_id(name)), requester:users!requester_id(name, personal_email)")
      .eq("id", b.bookingId).single();

    var updateRes = await supabase.from("bookings").update({
      status: "cancelled",
      reject_reason: reason,
      reviewed_by: currentUser.id,
      reviewed_at: new Date().toISOString()
    }).eq("id", b.bookingId);

    cancelMakeupConfirmBtn.disabled = false;
    cancelMakeupConfirmBtn.textContent = "취소 처리";

    if (updateRes.error) {
      cancelMakeupErrorBox.textContent = "처리에 실패했습니다: " + updateRes.error.message;
      cancelMakeupErrorBox.style.display = "block";
      return;
    }

    cancelMakeupModalOverlay.classList.remove("show");

    await supabase.from("booking_logs").insert({
      booking_id: b.bookingId, room_id: bkRes.data ? bkRes.data.room_id : null,
      booking_date: bkRes.data ? bkRes.data.booking_date : null,
      start_time: bkRes.data ? bkRes.data.start_time : null, end_time: bkRes.data ? bkRes.data.end_time : null,
      action: "cancelled_by_manager",
      actor_id: currentUser.id, actor_name: currentUser.name,
      requester_id: b.requesterId, requester_name: bkRes.data && bkRes.data.requester ? bkRes.data.requester.name : b.applicant,
      reason: reason
    });

    if (!bkRes.error && bkRes.data && bkRes.data.requester && bkRes.data.requester.personal_email) {
      var room = bkRes.data.rooms;
      var roomName = room ? ((room.buildings ? room.buildings.name + " " : "") + room.room_no + "호") : "-";
      await supabase.functions.invoke("send-cancellation-email", {
        body: {
          to: bkRes.data.requester.personal_email,
          requester_name: bkRes.data.requester.name,
          room_name: roomName,
          booking_date: bkRes.data.booking_date,
          start_time: bkRes.data.start_time,
          end_time: bkRes.data.end_time,
          reason: reason
        }
      });
    } else {
      alert("취소 처리되었습니다. (이 예약자는 등록된 개인 이메일이 없어 알림 메일은 보내지 못했습니다)");
    }

    var bookingId = b.bookingId;
    var selB = state.selection.b, selR = state.selection.r;
    await fetchSchedules();
    renderTimelineAndPanels();
    var newBlocks = scheduleFor(selB, selR);
    var newIdx = newBlocks.findIndex(function (x) { return x.bookingId === bookingId; });
    if (newIdx !== -1) selectReservation(selB, selR, newIdx);
    else renderResvList();
  });
  rejectModalOverlay.addEventListener("click", function (e) { if (e.target === rejectModalOverlay) closeRejectModal(); });
  document.getElementById("modalConfirmBtn").addEventListener("click", function () { handleDecision("rejected"); closeRejectModal(); });

  /* ================= 강의실 정보 수정 (수용인원 / 기자재 / 이용안내 / 사진 URL) ================= */
  var editRoomModalOverlay = document.getElementById("editRoomModalOverlay");
  var editingRoom = { b: null, r: null };

  function renderEditRoomEquipList(checkedIds) {
    var box = document.getElementById("editRoomEquipList");
    if (!EQUIPMENT_LIST.length) {
      box.innerHTML = '<div class="empty-hint" style="padding:8px 0;">등록된 기자재가 없어요.</div>';
      return;
    }
    box.innerHTML = EQUIPMENT_LIST.map(function (e) {
      var checked = checkedIds.indexOf(e.id) !== -1 ? " checked" : "";
      return '<label class="equip-check-item"><input type="checkbox" value="' + e.id + '"' + checked + '>' + e.name + '</label>';
    }).join("");
  }

  function openEditRoomModal(bName, room) {
    editingRoom = { b: bName, r: room };
    var rm = ROOMS_BY_KEY[roomKey(bName, room)];
    document.getElementById("editRoomCapacity").value = (rm && rm.capacity) || "";
    renderEditRoomEquipList((rm && rm.equipIds) || []);
    document.getElementById("editRoomNote").value = (rm && rm.guideline_text) || "";
    document.getElementById("editRoomThumb").value = (rm && rm.thumbnail_url) || "";
    document.getElementById("editRoomErrorBox").style.display = "none";
    editRoomModalOverlay.classList.add("show");
  }
  function closeEditRoomModal() { editRoomModalOverlay.classList.remove("show"); }
  document.getElementById("editRoomCancelBtn").addEventListener("click", closeEditRoomModal);
  editRoomModalOverlay.addEventListener("click", function (e) { if (e.target === editRoomModalOverlay) closeEditRoomModal(); });
  document.getElementById("editRoomSaveBtn").addEventListener("click", async function () {
    if (!editingRoom.b) return;
    var rm = ROOMS_BY_KEY[roomKey(editingRoom.b, editingRoom.r)];
    if (!rm) return;
    var box = document.getElementById("editRoomErrorBox");

    var capacityVal = parseInt(document.getElementById("editRoomCapacity").value, 10);
    if (!capacityVal || capacityVal <= 0) {
      box.textContent = "수용 인원을 올바르게 입력해주세요.";
      box.style.display = "block";
      return;
    }
    var checkedEquipIds = Array.from(document.querySelectorAll("#editRoomEquipList input:checked")).map(function (cb) { return parseInt(cb.value, 10); });
    var note = document.getElementById("editRoomNote").value.trim();
    var thumb = document.getElementById("editRoomThumb").value.trim();

    var res = await supabase.from("rooms").update({
      capacity: capacityVal, guideline_text: note || null, thumbnail_url: thumb || null
    }).eq("id", rm.id);
    if (res.error) {
      box.textContent = "저장에 실패했습니다: " + res.error.message;
      box.style.display = "block";
      return;
    }

    await supabase.from("room_equipment").delete().eq("room_id", rm.id);
    if (checkedEquipIds.length) {
      var rows = checkedEquipIds.map(function (eid) { return { room_id: rm.id, equipment_id: eid }; });
      var reInsertRes = await supabase.from("room_equipment").insert(rows);
      if (reInsertRes.error) {
        box.textContent = "기자재 저장에 실패했습니다: " + reInsertRes.error.message;
        box.style.display = "block";
        return;
      }
    }

    rm.capacity = capacityVal;
    rm.equipIds = checkedEquipIds;
    rm.equipNames = EQUIPMENT_LIST.filter(function (e) { return checkedEquipIds.indexOf(e.id) !== -1; }).map(function (e) { return e.name; });
    rm.guideline_text = note;
    rm.thumbnail_url = thumb;

    closeEditRoomModal();
    renderMyRoomGroup();
    renderTimelineAndPanels();
    if (state.selection.b === editingRoom.b && state.selection.r === editingRoom.r) {
      if (state.selection.idx !== null) selectReservation(state.selection.b, state.selection.r, state.selection.idx);
      else showRoomDetailPanel(state.selection.b, state.selection.r);
    }
  });

  document.getElementById("editRoomFromDetailBtn").addEventListener("click", function () {
    if (!state.selection.b) return;
    openEditRoomModal(state.selection.b, state.selection.r);
  });

  var selectedSemesterId = null;

  function renderAcSemesterList() {
    var box = document.getElementById("acSemesterList");
    if (!SEMESTERS.length) {
      box.innerHTML = '<div class="semester-pick-empty">최종관리자가 등록한 학기가 없어요.</div>';
      return;
    }
    box.innerHTML = SEMESTERS.map(function (s) {
      return '<div class="semester-pick-item' + (selectedSemesterId === s.id ? " selected" : "") + '" data-id="' + s.id + '">' +
        '<span class="sp-name">' + s.name + (s.is_current ? ' (현재 학기)' : '') + '</span>' +
        '<span class="sp-dates">' + s.start_date + ' ~ ' + s.end_date + '</span>' +
        '</div>';
    }).join("");
    box.querySelectorAll(".semester-pick-item").forEach(function (item) {
      item.addEventListener("click", function () {
        selectedSemesterId = parseInt(item.getAttribute("data-id"), 10);
        renderAcSemesterList();
      });
    });
  }

  /* ================= 정기수업 등록 (중간관리자가 직접 입력 → class_schedules INSERT) ================= */
  var addClassModalOverlay = document.getElementById("addClassModalOverlay");
  var DOW_NAMES = ["일", "월", "화", "수", "목", "금", "토"];
  var acSlots = []; // [{b, r, day, start, end}] - 슬롯마다 강의실·요일·시간이 다를 수 있음

  function currentDow() { return state.selectedDate.getDay(); }
  function isBlockVisibleToday(b) {
    return !b.days || b.days.indexOf(currentDow()) !== -1;
  }
  function isBlockVisibleOnDow(b, dow) {
    return !b.days || b.days.indexOf(dow) !== -1;
  }

  function hourOptions(selectEl, includeEnd) {
    var html = "";
    var last = includeEnd ? TIME_END : TIME_END - 1;
    for (var h = TIME_START; h <= last; h++) {
      html += '<option value="' + h + '">' + (h < 10 ? "0" + h : h) + ":00</option>";
    }
    selectEl.innerHTML = html;
  }

  function renderAcSlotList() {
    var box = document.getElementById("acSlotList");
    if (!acSlots.length) {
      box.innerHTML = '<div class="empty-hint" style="padding:8px 0;">추가된 요일·시간이 없습니다. 위에서 요일과 시간을 골라 "추가"를 눌러주세요.</div>';
      return;
    }
    box.innerHTML = acSlots.map(function (s, idx) {
      var startTxt = (s.start < 10 ? "0" + s.start : s.start) + ":00";
      var endTxt = (s.end < 10 ? "0" + s.end : s.end) + ":00";
      return '<div class="ac-slot-row"><span>' + displayRoomName(s.b, s.r) + ' · ' + DOW_NAMES[s.day] + '요일 ' + startTxt + ' ~ ' + endTxt + '</span>' +
        '<button type="button" class="remove" data-idx="' + idx + '">삭제</button></div>';
    }).join("");
    box.querySelectorAll(".remove").forEach(function (btn) {
      btn.addEventListener("click", function () {
        acSlots.splice(parseInt(btn.getAttribute("data-idx"), 10), 1);
        renderAcSlotList();
      });
    });
  }

  document.getElementById("acSlotAddBtn").addEventListener("click", function () {
    var rm = ROOMS_BY_KEY[document.getElementById("acRoom").value];
    var day = parseInt(document.getElementById("acSlotDay").value, 10);
    var start = parseFloat(document.getElementById("acSlotStart").value);
    var end = parseFloat(document.getElementById("acSlotEnd").value);
    hideAddClassError();
    if (!rm) { showAddClassError("강의실을 선택해주세요."); return; }
    if (end <= start) { showAddClassError("종료 시간은 시작 시간보다 늦어야 합니다."); return; }
    var dup = acSlots.some(function (s) { return s.b === rm.b && s.r === rm.r && s.day === day && start < s.end && end > s.start; });
    if (dup) { showAddClassError("이미 같은 강의실·요일에 겹치는 시간이 추가되어 있습니다."); return; }
    acSlots.push({ b: rm.b, r: rm.r, day: day, start: start, end: end });
    renderAcSlotList();
  });

  /* presetList: [{ b, r, start, end, day }] - 타임라인 드래그로 등록을 시작한 경우 전달됨 (드래그한 슬롯은 각자의 강의실 그대로 모두 반영됨) */
  async function openAddClassModal(presetList) {
    if (!state.myRooms.length) return;
    await loadSemesters();
    selectedSemesterId = CURRENT_SEMESTER_ID || (SEMESTERS.length ? SEMESTERS[0].id : null);
    renderAcSemesterList();

    var roomSel = document.getElementById("acRoom");
    roomSel.innerHTML = state.myRooms.map(function (rm) {
      var key = roomKey(rm.b, rm.r);
      return '<option value="' + key + '">' + displayRoomName(rm.b, rm.r) + '</option>';
    }).join("");

    var daySel = document.getElementById("acSlotDay");
    daySel.innerHTML = DOW_NAMES.map(function (n, i) { return '<option value="' + i + '">' + n + '요일</option>'; }).join("");
    var startSel = document.getElementById("acSlotStart");
    var endSel = document.getElementById("acSlotEnd");
    hourOptions(startSel, false);
    hourOptions(endSel, true);

    if (presetList && presetList.length) {
      roomSel.value = roomKey(presetList[0].b, presetList[0].r);
      acSlots = presetList.map(function (p) {
        var day = (p.day !== null && p.day !== undefined) ? p.day : currentDow();
        return { b: p.b, r: p.r, day: day, start: p.start, end: p.end };
      });
    } else {
      if (state.selectedFilterKey) roomSel.value = state.selectedFilterKey;
      daySel.value = currentDow();
      acSlots = [];
    }
    renderAcSlotList();

    document.getElementById("acSubject").value = "";
    document.getElementById("acProfessor").value = "";
    hideAddClassError();

    addClassModalOverlay.classList.add("show");
  }
  function closeAddClassModal() { addClassModalOverlay.classList.remove("show"); }
  function showAddClassError(msg) {
    var box = document.getElementById("acErrorBox");
    box.textContent = msg;
    box.style.display = "block";
  }
  function hideAddClassError() {
    document.getElementById("acErrorBox").style.display = "none";
  }

  document.getElementById("addClassBtn").addEventListener("click", function () {
    var presetList = pendingDragSelections.map(function (s) { return { b: s.b, r: s.r, start: s.start, end: s.end, day: s.day }; });
    clearPendingDragSelections();
    openAddClassModal(presetList);
  });
  document.getElementById("addClassCancelBtn").addEventListener("click", closeAddClassModal);
  addClassModalOverlay.addEventListener("click", function (e) { if (e.target === addClassModalOverlay) closeAddClassModal(); });

  document.getElementById("addClassSaveBtn").addEventListener("click", async function () {
    if (!selectedSemesterId) { showAddClassError("학기를 선택해주세요."); return; }

    var subject = document.getElementById("acSubject").value.trim();
    var professor = document.getElementById("acProfessor").value.trim();

    if (!acSlots.length) { showAddClassError("요일·시간을 최소 1개 이상 추가해주세요."); return; }
    if (!subject) { showAddClassError("과목명을 입력해주세요."); return; }
    if (!professor) { showAddClassError("담당 교수를 입력해주세요."); return; }

    // 저장 전에 모든 슬롯의 충돌 여부를 먼저 검사 (슬롯마다 강의실이 다를 수 있음, 하나라도 겹치면 전체 등록 취소)
    for (var i = 0; i < acSlots.length; i++) {
      var s = acSlots[i];
      var blocks = scheduleFor(s.b, s.r);
      var overlap = blocks.some(function (b) {
        var timeOverlap = s.start < b.end && s.end > b.start;
        if (!timeOverlap) return false;
        return !b.days || b.days.indexOf(s.day) !== -1;
      });
      if (overlap) {
        showAddClassError(displayRoomName(s.b, s.r) + " " + DOW_NAMES[s.day] + "요일 " + timeLabel(s.start) + "~" + timeLabel(s.end) + " 시간대에 이미 다른 예약이 있습니다.");
        return;
      }
    }

    var rows = acSlots.map(function (s) {
      var rm = ROOMS_BY_KEY[roomKey(s.b, s.r)];
      return {
        room_id: rm.id, semester_id: selectedSemesterId, weekday: s.day,
        start_time: hourToTimeStr(s.start), end_time: hourToTimeStr(s.end),
        subject_name: subject, professor_name: professor, created_by: currentUser.id
      };
    });

    var insertRes = await supabase.from("class_schedules").insert(rows);
    if (insertRes.error) { showAddClassError("등록에 실패했습니다: " + insertRes.error.message); return; }

    closeAddClassModal();
    await fetchSchedules();
    renderTimelineAndPanels();
  });

  /* ================= 강의실 예약 등록 (중간관리자가 직접 등록 → bookings에 확정 상태로 즉시 INSERT) ================= */
  var directBookingModalOverlay = document.getElementById("directBookingModalOverlay");
  var dbSlots = []; // [{b, r, date: iso, start, end}] - 슬롯마다 강의실·날짜·시간이 다를 수 있음, 여러 개를 한 번에 등록 가능

  function isoDateForDow(dow) {
    var match = weekDaysForSelection().filter(function (d) { return d.dow === dow; })[0];
    return match ? match.iso : dateToISO(state.selectedDate);
  }
  function formatIsoDateKorean(iso) {
    var parts = iso.split("-").map(function (n) { return parseInt(n, 10); });
    var d = new Date(parts[0], parts[1] - 1, parts[2]);
    return d.getFullYear() + "년 " + (d.getMonth() + 1) + "월 " + d.getDate() + "일 (" + KOREAN_DOW[d.getDay()] + ")";
  }

  // 정기수업(class_schedules)과 예약(bookings)을 선택한 날짜 기준으로 직접 서버에 조회해 겹침 여부 확인
  // (날짜를 자유롭게 고를 수 있어 현재 화면에 캐시된 주간 데이터만으로는 정확한 검사가 불가능함)
  async function checkDirectBookingOverlap(rm, iso, dow, start, end) {
    var semester = SEMESTERS.filter(function (s) { return s.start_date <= iso && s.end_date >= iso; })[0];
    if (semester) {
      var csRes = await supabase.from("class_schedules").select("start_time, end_time")
        .eq("room_id", rm.id).eq("semester_id", semester.id).eq("weekday", dow);
      if (!csRes.error && csRes.data) {
        var csOverlap = csRes.data.some(function (cs) {
          return start < timeStrToHour(cs.end_time) && end > timeStrToHour(cs.start_time);
        });
        if (csOverlap) return true;
      }
    }

    var bkRes = await supabase.from("bookings").select("start_time, end_time")
      .eq("room_id", rm.id).eq("booking_date", iso).in("status", ["pending", "approved"]);
    if (!bkRes.error && bkRes.data) {
      var bkOverlap = bkRes.data.some(function (b) {
        return start < timeStrToHour(b.end_time) && end > timeStrToHour(b.start_time);
      });
      if (bkOverlap) return true;
    }
    return false;
  }

  function renderDbSlotList() {
    var box = document.getElementById("dbSlotList");
    if (!dbSlots.length) {
      box.innerHTML = '<div class="empty-hint" style="padding:8px 0;">추가된 날짜·시간이 없습니다. 위에서 날짜와 시간을 골라 "추가"를 눌러주세요.</div>';
      return;
    }
    box.innerHTML = dbSlots.map(function (s, idx) {
      return '<div class="ac-slot-row"><span>' + displayRoomName(s.b, s.r) + ' · ' + formatIsoDateKorean(s.date) + " " + timeLabel(s.start) + " ~ " + timeLabel(s.end) + '</span>' +
        '<button type="button" class="remove" data-idx="' + idx + '">삭제</button></div>';
    }).join("");
    box.querySelectorAll(".remove").forEach(function (btn) {
      btn.addEventListener("click", function () {
        dbSlots.splice(parseInt(btn.getAttribute("data-idx"), 10), 1);
        renderDbSlotList();
      });
    });
  }

  document.getElementById("dbSlotAddBtn").addEventListener("click", function () {
    var rm = ROOMS_BY_KEY[document.getElementById("dbRoom").value];
    var dateVal = document.getElementById("dbSlotDate").value;
    var start = parseInt(document.getElementById("dbSlotStart").value, 10);
    var end = parseInt(document.getElementById("dbSlotEnd").value, 10);
    hideDirectBookingError();
    if (!rm) { showDirectBookingError("강의실을 선택해주세요."); return; }
    if (!dateVal) { showDirectBookingError("날짜를 선택해주세요."); return; }
    if (end <= start) { showDirectBookingError("종료 시간은 시작 시간보다 늦어야 합니다."); return; }
    var dup = dbSlots.some(function (s) { return s.b === rm.b && s.r === rm.r && s.date === dateVal && start < s.end && end > s.start; });
    if (dup) { showDirectBookingError("이미 같은 강의실·날짜에 겹치는 시간이 추가되어 있습니다."); return; }
    dbSlots.push({ b: rm.b, r: rm.r, date: dateVal, start: start, end: end });
    renderDbSlotList();
  });

  /* presetList: [{ b, r, start, end, day }] - 타임라인 드래그로 등록을 시작한 경우 전달됨 (드래그한 슬롯은 각자의 강의실 그대로 모두 반영됨) */
  function openDirectBookingModal(presetList) {
    if (!state.myRooms.length) return;

    var roomSel = document.getElementById("dbRoom");
    roomSel.innerHTML = state.myRooms.map(function (rm) {
      var key = roomKey(rm.b, rm.r);
      return '<option value="' + key + '">' + displayRoomName(rm.b, rm.r) + '</option>';
    }).join("");

    var slotDateInput = document.getElementById("dbSlotDate");
    var startSel = document.getElementById("dbSlotStart");
    var endSel = document.getElementById("dbSlotEnd");
    hourOptions(startSel, false);
    hourOptions(endSel, true);

    if (presetList && presetList.length) {
      roomSel.value = roomKey(presetList[0].b, presetList[0].r);
      dbSlots = presetList.map(function (p) {
        var iso = (p.day !== null && p.day !== undefined) ? isoDateForDow(p.day) : dateToISO(state.selectedDate);
        return { b: p.b, r: p.r, date: iso, start: p.start, end: p.end };
      });
      slotDateInput.value = dbSlots[dbSlots.length - 1].date;
    } else {
      if (state.selectedFilterKey) roomSel.value = state.selectedFilterKey;
      dbSlots = [];
      slotDateInput.value = dateToISO(state.selectedDate);
    }
    startSel.value = TIME_START;
    endSel.value = TIME_START + 1;
    renderDbSlotList();

    document.getElementById("dbPurpose").value = "";
    document.getElementById("dbHeadcount").value = "";
    hideDirectBookingError();
    directBookingModalOverlay.classList.add("show");
  }
  function closeDirectBookingModal() { directBookingModalOverlay.classList.remove("show"); }
  function showDirectBookingError(msg) {
    var box = document.getElementById("dbErrorBox");
    box.textContent = msg;
    box.style.display = "block";
  }
  function hideDirectBookingError() {
    document.getElementById("dbErrorBox").style.display = "none";
  }

  document.getElementById("directBookingBtn").addEventListener("click", function () {
    var presetList = pendingDragSelections.map(function (s) { return { b: s.b, r: s.r, start: s.start, end: s.end, day: s.day }; });
    clearPendingDragSelections();
    openDirectBookingModal(presetList);
  });
  document.getElementById("dbCancelBtn").addEventListener("click", closeDirectBookingModal);
  directBookingModalOverlay.addEventListener("click", function (e) { if (e.target === directBookingModalOverlay) closeDirectBookingModal(); });

  document.getElementById("dbSaveBtn").addEventListener("click", async function () {
    if (!dbSlots.length) { showDirectBookingError("날짜·시간을 최소 1개 이상 추가해주세요."); return; }

    var purpose = document.getElementById("dbPurpose").value.trim();
    if (!purpose) { showDirectBookingError("대여 목적을 입력해주세요."); return; }

    var headcountVal = parseInt(document.getElementById("dbHeadcount").value, 10);
    var headcount = (!isNaN(headcountVal) && headcountVal > 0) ? headcountVal : null;

    var saveBtn = this;
    saveBtn.disabled = true;

    // 슬롯마다 강의실이 다를 수 있으므로 각각 자신의 강의실 기준으로 겹침을 검사 (하나라도 겹치면 전체 등록 취소)
    for (var i = 0; i < dbSlots.length; i++) {
      var s = dbSlots[i];
      var rm = ROOMS_BY_KEY[roomKey(s.b, s.r)];
      if (!rm) { saveBtn.disabled = false; showDirectBookingError(displayRoomName(s.b, s.r) + " 강의실 정보를 찾을 수 없습니다."); return; }
      var dow = new Date(s.date + "T00:00:00").getDay();
      var overlap = await checkDirectBookingOverlap(rm, s.date, dow, s.start, s.end);
      if (overlap) {
        saveBtn.disabled = false;
        showDirectBookingError(displayRoomName(s.b, s.r) + " " + formatIsoDateKorean(s.date) + " " + timeLabel(s.start) + "~" + timeLabel(s.end) + " 시간대에 이미 다른 예약이 있습니다.");
        return;
      }
    }

    var nowIso = new Date().toISOString();
    var rows = dbSlots.map(function (s) {
      var rm = ROOMS_BY_KEY[roomKey(s.b, s.r)];
      return {
        room_id: rm.id, booking_date: s.date,
        start_time: hourToTimeStr(s.start), end_time: hourToTimeStr(s.end),
        purpose: purpose, headcount: headcount,
        requester_id: currentUser.id, status: "approved",
        reviewed_by: currentUser.id, reviewed_at: nowIso
      };
    });
    var insertRes = await supabase.from("bookings").insert(rows);
    saveBtn.disabled = false;
    if (insertRes.error) { showDirectBookingError("등록에 실패했습니다: " + insertRes.error.message); return; }

    closeDirectBookingModal();
    await fetchSchedules();
    renderTimelineAndPanels();
  });

  /* ---------- 타임라인에서 드래그로 시간대 "선택"만 해두고, 버튼을 눌러야 해당 모달이 열림 (여러 개 동시 선택 가능) ---------- */
  var dragState = null;
  var pendingDragSelections = []; // [{ b, r, start, end, day, ghostEl }] - 드래그로 선택됐지만 아직 등록 버튼을 누르지 않은 시간대들

  function clearPendingDragSelections() {
    pendingDragSelections.forEach(function (s) { if (s.ghostEl) s.ghostEl.remove(); });
    pendingDragSelections = [];
  }
  function removeDragSelection(sel) {
    var idx = pendingDragSelections.indexOf(sel);
    if (idx !== -1) pendingDragSelections.splice(idx, 1);
    if (sel.ghostEl) sel.ghostEl.remove();
  }
  // 확정된 선택 블록을 클릭하면 다시 선택 해제되도록 함 (진행 중인 드래그 고스트와 구분하기 위해 이 시점에만 pointer-events를 켬)
  function finalizeDragSelection(sel) {
    var el = sel.ghostEl;
    el.style.pointerEvents = "auto";
    el.style.cursor = "pointer";
    el.title = "클릭하면 선택 해제";
    el.addEventListener("mousedown", function (e) { e.stopPropagation(); });
    el.addEventListener("click", function (e) {
      e.stopPropagation();
      removeDragSelection(sel);
    });
  }

  function pixelToHour(clientX, rect) {
    var ratio = (clientX - rect.left) / rect.width;
    ratio = Math.max(0, Math.min(1, ratio));
    return Math.round(TIME_START + ratio * (TIME_END - TIME_START));
  }
  function updateGhost(ghostEl, h1, h2) {
    var s = Math.min(h1, h2), e = Math.max(h1, h2);
    var left = ((s - TIME_START) / (TIME_END - TIME_START)) * 100;
    var width = ((e - s) / (TIME_END - TIME_START)) * 100;
    ghostEl.style.left = left + "%";
    ghostEl.style.width = width + "%";
  }

  timelineList.addEventListener("mousedown", function (e) {
    if (e.target.closest(".seg") || e.target.closest(".room-edit-btn")) return;
    var track = e.target.closest(".track");
    if (!track) return;
    var dowAttr = track.getAttribute("data-dow");
    var bName, room, day;
    if (dowAttr !== null) {
      if (!weekViewRoom) return;
      bName = weekViewRoom.b;
      room = weekViewRoom.r;
      day = parseInt(dowAttr, 10);
    } else {
      var gridBody = track.closest(".grid-body");
      var editBtn = gridBody.querySelector(".room-edit-btn");
      if (!editBtn) return;
      bName = editBtn.getAttribute("data-b");
      room = editBtn.getAttribute("data-r");
      day = null;
    }
    var rect = track.getBoundingClientRect();
    var startHour = pixelToHour(e.clientX, rect);
    var ghost = document.createElement("div");
    ghost.className = "drag-ghost";
    track.appendChild(ghost);
    dragState = { track: track, bName: bName, room: room, day: day, startHour: startHour, ghost: ghost };
    updateGhost(ghost, startHour, startHour);
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", function (e) {
    if (!dragState) return;
    var rect = dragState.track.getBoundingClientRect();
    var curHour = pixelToHour(e.clientX, rect);
    updateGhost(dragState.ghost, dragState.startHour, curHour);
  });

  document.addEventListener("mouseup", function (e) {
    if (!dragState) return;
    var rect = dragState.track.getBoundingClientRect();
    var endHour = pixelToHour(e.clientX, rect);
    var s = Math.min(dragState.startHour, endHour);
    var en = Math.max(dragState.startHour, endHour);
    document.body.style.userSelect = "";
    var bName = dragState.bName, room = dragState.room, day = dragState.day, ghost = dragState.ghost;
    dragState = null;

    if (en - s >= 1) {
      // 같은 강의실·요일에서 새로 선택한 범위와 겹치거나 맞닿아 있는 기존 선택들을 모두 하나로 합침
      var mergedStart = s, mergedEnd = en;
      var toRemove = [];
      var foundMore = true;
      while (foundMore) {
        foundMore = false;
        pendingDragSelections.forEach(function (sel) {
          if (toRemove.indexOf(sel) !== -1) return;
          if (sel.b === bName && sel.r === room && sel.day === day && sel.start <= mergedEnd && sel.end >= mergedStart) {
            mergedStart = Math.min(mergedStart, sel.start);
            mergedEnd = Math.max(mergedEnd, sel.end);
            toRemove.push(sel);
            foundMore = true;
          }
        });
      }
      toRemove.forEach(function (sel) { removeDragSelection(sel); });

      ghost.textContent = timeLabel(mergedStart) + "~" + timeLabel(mergedEnd) + " 선택됨";
      updateGhost(ghost, mergedStart, mergedEnd);
      var newSel = { b: bName, r: room, start: mergedStart, end: mergedEnd, day: day, ghostEl: ghost };
      pendingDragSelections.push(newSel);
      finalizeDragSelection(newSel);
    } else {
      ghost.remove();
    }
  });

  /* ================= 좌측 요약 카드 / 하단 대기 목록 ================= */
  function shortDateLabel(iso) {
    var p = iso.split("-").map(function (n) { return parseInt(n, 10); });
    var d = new Date(p[0], p[1] - 1, p[2]);
    return p[1] + "/" + p[2] + "(" + KOREAN_DOW[d.getDay()] + ")";
  }

  function renderSummary() {
    var rooms = state.myRooms;
    var total = 0;
    rooms.forEach(function (rm) {
      var blocks = scheduleFor(rm.b, rm.r);
      blocks.forEach(function (b) {
        if (!isBlockVisibleToday(b)) return;
        total++;
      });
    });
    document.getElementById("sumRooms").textContent = rooms.length + "개";
    document.getElementById("sumTotal").textContent = total + "건";
    document.getElementById("sumPending").textContent = PENDING_BOOKINGS.length + "건";
    document.getElementById("subbarPendingBadge").textContent = "승인 대기 " + PENDING_BOOKINGS.length + "건";
    document.getElementById("bellDot").style.display = PENDING_BOOKINGS.length ? "block" : "none";
    renderPendingBottomList();
    renderBuildingGrid();
  }

  // 승인 대기 목록은 현재 보고 있는 날짜/주와 무관하게 담당 강의실 전체의 대기 건을 표시함 (PENDING_BOOKINGS)
  function renderPendingBottomList() {
    var list = document.getElementById("pendingListBottom");
    if (!PENDING_BOOKINGS.length) {
      list.innerHTML = '<div class="empty-hint">현재 승인 대기중인 예약이 없습니다</div>';
      return;
    }
    list.innerHTML = PENDING_BOOKINGS.map(function (row) {
      var label = displayRoomName(row.b, row.r);
      return '<div class="pending-row" data-booking-id="' + row.bookingId + '">' +
        '<span class="pr-room">' + label + '</span>' +
        '<span class="pr-time">' + shortDateLabel(row.bookingDate) + ' ' + timeLabel(row.start) + '~' + timeLabel(row.end) + '</span>' +
        '<span class="pr-sub">' + row.sub + '</span>' +
        '<span class="pr-applicant">' + row.applicant + '</span>' +
        '<span class="pr-actions">' +
        '<button type="button" class="pr-btn pr-approve" data-action="approve">승인</button>' +
        '<button type="button" class="pr-btn pr-reject" data-action="reject">거절</button>' +
        '</span></div>';
    }).join("");
  }

  document.getElementById("pendingListBottom").addEventListener("click", async function (e) {
    var row = e.target.closest(".pending-row");
    if (!row) return;
    var bookingId = parseInt(row.getAttribute("data-booking-id"), 10);
    var pb = PENDING_BOOKINGS.filter(function (p) { return p.bookingId === bookingId; })[0];
    if (!pb) return;
    var actionBtn = e.target.closest(".pr-btn");

    // 이 대기 건이 있는 날짜로 이동해야 타임라인/상세 패널에서 정상적으로 선택/승인할 수 있음
    // (승인 대기 목록은 날짜와 무관하게 전체를 보여주므로, 지금 보고 있는 주와 다를 수 있음)
    var parts = pb.bookingDate.split("-").map(function (n) { return parseInt(n, 10); });
    state.selectedDate = new Date(parts[0], parts[1] - 1, parts[2]);
    state.calViewMonth = new Date(parts[0], parts[1] - 1, 1);
    state.selectedBuilding = "";
    state.selectedFilterKey = "";
    await fetchSchedules();
    renderMiniCal();
    renderBuildingGrid();
    renderMyRoomGroup();
    renderTimelineAndPanels();

    var blocks = scheduleFor(pb.b, pb.r);
    var idx = blocks.findIndex(function (bl) { return bl.bookingId === bookingId; });
    if (idx !== -1) selectReservation(pb.b, pb.r, idx);

    if (!actionBtn) return;
    if (actionBtn.getAttribute("data-action") === "approve") openApproveModal();
    else openRejectModal();
  });

  document.getElementById("jumpToPendingBtn").addEventListener("click", function () {
    document.getElementById("pendingPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  /* ================= 센터 타이틀 ================= */
  function updateCenterTitle() {
    document.getElementById("dateLabel").textContent = formatSelectedDate();
    var label = "· 전체 담당 강의실";
    if (state.selectedFilterKey) {
      var match = state.myRooms.filter(function (rm) { return roomKey(rm.b, rm.r) === state.selectedFilterKey; })[0];
      if (match) label = "· " + displayRoomName(match.b, match.r);
    }
    document.getElementById("buildingLabel").textContent = label;
  }

  /* ================= 좌측에서 강의실 선택 시 우측 상세 패널 표시 ================= */
  function showRoomDetailPanel(bName, room) {
    var rm = ROOMS_BY_KEY[roomKey(bName, room)];
    var label = displayRoomName(bName, room);

    document.getElementById("roomTitleR").textContent = label;
    document.getElementById("roomMetaR").textContent = "강의실 상세 정보";
    var infoText = "수용인원 " + (rm ? rm.capacity + "명" : "-") + " · 보유장비 " + (rm && rm.equipNames.length ? rm.equipNames.join(", ") : "정보 없음");
    if (rm && rm.guideline_text) infoText += " · " + rm.guideline_text;
    document.getElementById("roomInfoR").textContent = infoText;
    document.getElementById("editRoomFromDetailBtn").style.display = "inline-block";

    var thumb = document.querySelector(".thumb");
    if (thumb) {
      if (rm && rm.thumbnail_url) {
        thumb.style.backgroundImage = "url('" + rm.thumbnail_url + "')";
        thumb.style.backgroundSize = "cover";
        thumb.style.backgroundPosition = "center";
        thumb.textContent = "";
      } else {
        thumb.style.backgroundImage = "";
        thumb.textContent = "강의실 사진";
      }
    }

    var roomStatus = getRoomStatus(bName, room);
    var warnBanner = document.getElementById("statusWarningBanner");
    if (roomStatus !== "available") {
      warnBanner.className = "status-warning-banner show";
      warnBanner.textContent = "🚧 이 강의실은 최종관리자가 \"" + STATUS_LABELS[roomStatus] + "\" 상태로 지정했어요.";
    } else {
      warnBanner.className = "status-warning-banner";
      warnBanner.textContent = "";
    }

    // 아직 특정 예약 건을 고른 게 아니므로 승인/거절 영역은 비활성 상태로 초기화
    state.selection = { b: bName, r: room, idx: null };
    document.getElementById("detailBox").innerHTML = '<div class="empty-hint" style="padding:20px 0;">타임라인에서 예약 건을 선택하면 승인/거절할 수 있어요</div>';
    document.getElementById("adminComment").value = "";
    document.getElementById("statusBanner").className = "status-banner";
    document.getElementById("approveBtn").disabled = true;
    document.getElementById("rejectBtn").disabled = true;
    document.getElementById("cancelMakeupBtn").disabled = true;
    document.getElementById("bookingLogBox").innerHTML = "";

    renderResvList();
  }

  function resetDetailPanel() {
    state.selection = { b: null, r: null, idx: null };
    document.getElementById("roomTitleR").textContent = "강의실을 선택해주세요";
    document.getElementById("roomMetaR").textContent = "타임라인의 블록을 클릭하세요";
    document.getElementById("roomInfoR").textContent = "";
    document.getElementById("editRoomFromDetailBtn").style.display = "none";
    var thumb = document.querySelector(".thumb");
    if (thumb) { thumb.style.backgroundImage = ""; thumb.textContent = "강의실 사진"; }
    document.getElementById("statusWarningBanner").className = "status-warning-banner";
    document.getElementById("statusWarningBanner").textContent = "";
    document.getElementById("detailBox").innerHTML = '<div class="empty-hint" style="padding:20px 0;">왼쪽에서 예약 건을 선택하세요</div>';
    document.getElementById("adminComment").value = "";
    document.getElementById("statusBanner").className = "status-banner";
    document.getElementById("approveBtn").disabled = true;
    document.getElementById("rejectBtn").disabled = true;
    document.getElementById("cancelMakeupBtn").disabled = true;
    document.getElementById("bookingLogBox").innerHTML = "";
    renderResvList();
  }

  /* ================= 렌더 묶음 ================= */
  function renderTimelineAndPanels() {
    updateCenterTitle();
    renderTimeline();
    renderSummary();
  }

  function renderAll() {
    updateCenterTitle();
    resetDetailPanel();

    renderTimeline();
    renderResvList();
    renderSummary();

    // 대기중 건이 있으면 담당 강의실 순서대로 첫 건 자동 선택
    var rooms = visibleRooms();
    for (var i = 0; i < rooms.length; i++) {
      var blocks = scheduleFor(rooms[i].b, rooms[i].r);
      var pendingIdx = blocks.findIndex(function (b) { return b.status === "pending"; });
      if (pendingIdx !== -1) { selectReservation(rooms[i].b, rooms[i].r, pendingIdx); break; }
    }
  }

  /* ================= 초기화: 로그인 확인 → 내 담당 강의실/학기/스케줄 로드 ================= */
  (async function init() {
    var ok = await requireMidAdmin();
    if (!ok) return;

    await loadMyRooms();
    state.myRooms = MY_ROOMS;
    await loadSemesters();
    await fetchSchedules();

    document.getElementById("headerManagerName").textContent = currentUser.name + "님";
    loginScreen.classList.add("hide");
    appRoot.classList.add("show");

    state.calViewMonth = new Date(state.selectedDate.getFullYear(), state.selectedDate.getMonth(), 1);
    renderBuildingGrid();
    renderMyRoomGroup();
    renderMiniCal();
    renderAll();
  })();

