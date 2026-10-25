  /* ================= 로그인 확인 (final_admin은 건물 범위 제한 없이 전체 관리) ================= */
  var currentAssistant = null; // { id, name, role }

  async function requireFinalAdmin() {
    var sessionRes = await supabase.auth.getSession();
    if (!sessionRes.data.session) { window.location.href = "login.html"; return false; }

    var profileRes = await supabase.from("users").select("id, name, role").eq("id", sessionRes.data.session.user.id).single();
    if (profileRes.error || !profileRes.data) { window.location.href = "login.html"; return false; }
    currentAssistant = profileRes.data;

    if (currentAssistant.role !== "final_admin") {
      alert("최종관리자 계정으로만 접근할 수 있습니다.");
      window.location.href = "login.html";
      return false;
    }
    return true;
  }

  /* ================= DB 상태 (메모리 캐시, 매 렌더링 전에 fetchAllData()로 새로고침) ================= */
  var BUILDINGS_LIST = [];    // [{id, name, status}]
  var ROOM_TYPES_LIST = [];   // [{id, name}]
  var EQUIPMENT_LIST = [];    // [{id, name}]
  var ROOMS = [];             // 전체 건물의 rooms row (manager 조인 포함)
  var ROOM_EQUIP_BY_ID = {};  // room_id -> [equipment name]
  var SEMESTERS = [];         // semesters row 전체 (전역 공유)
  var ASSISTANT_USERS = [];   // role='assistant'인 사용자 전체 (중간관리자 지정용 후보 목록)
  var MID_ADMIN_USERS = [];   // role='mid_admin'인 사용자 전체 (담당 강의실 0개여도 전부 포함)

  // 동명이인 구분용: 이름 뒤에 조교 아이디(staff_no)를 괄호로 붙여서 표시
  function nameWithId(u) {
    if (!u) return "";
    return u.name + (u.staff_no ? " (" + u.staff_no + ")" : "");
  }

  function buildingName(id) {
    var b = BUILDINGS_LIST.filter(function (x) { return x.id === id; })[0];
    return b ? b.name : "";
  }

  function roomTypeName(id) {
    var t = ROOM_TYPES_LIST.filter(function (x) { return x.id === id; })[0];
    return t ? t.name : "";
  }

  function findRoom(id) {
    return ROOMS.filter(function (r) { return r.id === id; })[0] || null;
  }

  /* 담당 관리자 id -> { info, rooms:[room,...] }
     주의: users(role='mid_admin')를 기준으로 먼저 채우고 그 다음 rooms를 끼워넣는다.
     전에는 rooms부터 돌면서 매니저가 있는 것만 모았어서, 담당 강의실이 0개인
     mid_admin은 목록에서 완전히 사라지는 버그가 있었음. */
  function buildManagersMap() {
    var map = {};
    MID_ADMIN_USERS.forEach(function (u) {
      map[u.id] = { info: u, rooms: [] };
    });
    ROOMS.forEach(function (r) {
      if (!r.manager_id || !map[r.manager_id]) return;
      map[r.manager_id].rooms.push(r);
    });
    return map;
  }

  async function fetchAllData() {
    var buildingsRes = await supabase.from("buildings").select("id, name, status").order("name");
    BUILDINGS_LIST = (!buildingsRes.error && buildingsRes.data) ? buildingsRes.data : [];

    var roomsRes = await supabase
      .from("rooms")
      .select("*, manager:manager_id(id, name, staff_no)")
      .order("building_id")
      .order("floor")
      .order("room_no");
    ROOMS = (!roomsRes.error && roomsRes.data) ? roomsRes.data : [];

    var usersRes = await supabase.from("users").select("id, name, role, staff_no").in("role", ["assistant", "mid_admin"]).order("name");
    var allUsers = (!usersRes.error && usersRes.data) ? usersRes.data : [];
    ASSISTANT_USERS = allUsers.filter(function (u) { return u.role === "assistant"; });
    MID_ADMIN_USERS = allUsers.filter(function (u) { return u.role === "mid_admin"; });

    var roomIds = ROOMS.map(function (r) { return r.id; });
    ROOM_EQUIP_BY_ID = {};
    if (roomIds.length) {
      var reRes = await supabase.from("room_equipment").select("room_id, equipment:equipment_id(name)").in("room_id", roomIds);
      if (!reRes.error && reRes.data) {
        reRes.data.forEach(function (row) {
          if (!ROOM_EQUIP_BY_ID[row.room_id]) ROOM_EQUIP_BY_ID[row.room_id] = [];
          if (row.equipment && row.equipment.name) ROOM_EQUIP_BY_ID[row.room_id].push(row.equipment.name);
        });
      }
    }

    if (!ROOM_TYPES_LIST.length) {
      var typesRes = await supabase.from("room_types").select("id, name").order("id");
      ROOM_TYPES_LIST = (!typesRes.error && typesRes.data) ? typesRes.data : [];
    }
    if (!EQUIPMENT_LIST.length) {
      var equipRes = await supabase.from("equipment").select("id, name").order("id");
      EQUIPMENT_LIST = (!equipRes.error && equipRes.data) ? equipRes.data : [];
    }

    var semRes = await supabase.from("semesters").select("*").order("start_date");
    SEMESTERS = (!semRes.error && semRes.data) ? semRes.data : [];
  }

  /* ================= 탭 전환 ================= */
  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.toggle("active", b === btn); });
      var tab = btn.getAttribute("data-tab");
      document.getElementById("tabRooms").classList.toggle("active", tab === "rooms");
      document.getElementById("tabManagers").classList.toggle("active", tab === "managers");
      document.getElementById("tabSemesters").classList.toggle("active", tab === "semesters");
    });
  });

  /* ================= 강의실 관리 탭 ================= */
  var roomBuildingFilter = document.getElementById("roomBuildingFilter");
  roomBuildingFilter.addEventListener("change", renderRoomTable);

  function initRoomBuildingFilterOptions() {
    roomBuildingFilter.innerHTML = '<option value="">전체 건물</option>' +
      BUILDINGS_LIST.map(function (b) { return '<option value="' + b.id + '">' + b.name + "</option>"; }).join("");
  }

  function renderRoomTable() {
    var tbody = document.getElementById("roomTableBody");
    var filterBId = roomBuildingFilter.value;
    var rooms = ROOMS.filter(function (rm) { return !filterBId || String(rm.building_id) === filterBId; });

    document.getElementById("roomCountLabel").textContent = rooms.length;
    document.getElementById("roomEmptyState").style.display = rooms.length ? "none" : "block";

    tbody.innerHTML = rooms.map(function (rm) {
      var equipNames = ROOM_EQUIP_BY_ID[rm.id] || [];
      var mgrChip = rm.manager
        ? '<span class="manager-chip">' + nameWithId(rm.manager) + "</span>"
        : '<span class="manager-chip none">미배정</span>';
      var status = rm.is_active ? "available" : "closed";
      var statusSelect = '<select class="status-select st-' + status + '" data-room-id="' + rm.id + '">' +
        '<option value="available"' + (status === "available" ? " selected" : "") + '>사용가능</option>' +
        '<option value="closed"' + (status === "closed" ? " selected" : "") + '>사용중지</option>' +
        '</select>';
      return "<tr>" +
        "<td>" + buildingName(rm.building_id) + "</td>" +
        "<td>" + floorLabel(rm.floor) + "</td>" +
        '<td class="cell-room">' + rm.room_no + "호</td>" +
        "<td>" + rm.capacity + "명</td>" +
        "<td>" + (roomTypeName(rm.room_type_id) || "-") + "</td>" +
        "<td>" + (equipNames.length ? equipNames.join(", ") : "-") + "</td>" +
        "<td>" + statusSelect + "</td>" +
        "<td>" + mgrChip + "</td>" +
        '<td style="text-align:right;"><button type="button" class="icon-btn danger" data-del-room="' + rm.id + '">삭제</button></td>' +
        "</tr>";
    }).join("");

    tbody.querySelectorAll("[data-del-room]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openDeleteRoomModal(parseInt(btn.getAttribute("data-del-room"), 10));
      });
    });
    tbody.querySelectorAll("[data-room-id]").forEach(function (sel) {
      sel.addEventListener("change", async function () {
        var roomId = parseInt(sel.getAttribute("data-room-id"), 10);
        var isActive = sel.value === "available";
        var res = await supabase.from("rooms").update({ is_active: isActive }).eq("id", roomId);
        if (res.error) { alert("상태 변경에 실패했습니다: " + res.error.message); return; }
        var room = findRoom(roomId);
        if (room) room.is_active = isActive;
        sel.className = "status-select st-" + sel.value;
      });
    });
  }

  function floorLabel(f) {
    var n = parseInt(f, 10);
    return (n < 0 ? ("지하" + (-n) + "층") : (n + "층"));
  }

  /* ---------- 강의실 추가 ---------- */
  var addRoomModalOverlay = document.getElementById("addRoomModalOverlay");

  document.getElementById("openAddRoomBtn").addEventListener("click", function () {
    document.getElementById("arBuilding").innerHTML = BUILDINGS_LIST.map(function (b) {
      return '<option value="' + b.id + '">' + b.name + "</option>";
    }).join("");
    document.getElementById("arFloor").value = "";
    document.getElementById("arRoomNumber").value = "";
    document.getElementById("arCapacity").value = "";
    document.getElementById("arErrorBox").classList.remove("show");
    document.getElementById("arRoomType").innerHTML = ROOM_TYPES_LIST.map(function (t) {
      return '<option value="' + t.id + '">' + t.name + "</option>";
    }).join("");
    document.getElementById("arEquipCheckList").innerHTML = EQUIPMENT_LIST.map(function (e) {
      return '<label class="rcl-item"><input type="checkbox" value="' + e.id + '">' + e.name + "</label>";
    }).join("") || '<div class="empty-state" style="padding:20px;">등록된 기자재가 없어요.</div>';
    addRoomModalOverlay.classList.add("show");
  });
  document.getElementById("arCancelBtn").addEventListener("click", function () { addRoomModalOverlay.classList.remove("show"); });

  document.getElementById("arSaveBtn").addEventListener("click", async function () {
    var buildingId = document.getElementById("arBuilding").value;
    var floor = document.getElementById("arFloor").value;
    var rNum = document.getElementById("arRoomNumber").value.trim();
    var capacity = document.getElementById("arCapacity").value;
    var roomTypeId = document.getElementById("arRoomType").value;
    var errBox = document.getElementById("arErrorBox");

    if (!buildingId) { errBox.textContent = "건물을 선택해주세요."; errBox.classList.add("show"); return; }
    if (floor === "") { errBox.textContent = "층을 입력해주세요."; errBox.classList.add("show"); return; }
    if (!rNum) { errBox.textContent = "호실 번호를 입력해주세요."; errBox.classList.add("show"); return; }
    if (ROOMS.some(function (r) { return String(r.building_id) === buildingId && r.floor === parseInt(floor, 10) && r.room_no === rNum; })) {
      errBox.textContent = "이 건물의 같은 층에 이미 존재하는 호실 번호예요."; errBox.classList.add("show"); return;
    }
    if (!capacity) { errBox.textContent = "수용 인원을 입력해주세요."; errBox.classList.add("show"); return; }

    var insertRes = await supabase.from("rooms").insert({
      building_id: parseInt(buildingId, 10),
      floor: parseInt(floor, 10),
      room_no: rNum,
      capacity: parseInt(capacity, 10),
      room_type_id: roomTypeId ? parseInt(roomTypeId, 10) : null,
      is_active: true
    }).select().single();

    if (insertRes.error) { errBox.textContent = "추가에 실패했습니다: " + insertRes.error.message; errBox.classList.add("show"); return; }

    var newRoomId = insertRes.data.id;
    var checkedEquipIds = Array.from(document.querySelectorAll("#arEquipCheckList input:checked")).map(function (cb) { return parseInt(cb.value, 10); });
    if (checkedEquipIds.length) {
      var rows = checkedEquipIds.map(function (eid) { return { room_id: newRoomId, equipment_id: eid }; });
      await supabase.from("room_equipment").insert(rows);
    }

    addRoomModalOverlay.classList.remove("show");
    await fetchAllData();
    renderRoomTable();
    renderManagerGrid();
  });

  /* ---------- 강의실 삭제 ---------- */
  var deleteRoomModalOverlay = document.getElementById("deleteRoomModalOverlay");
  var pendingDeleteRoomId = null;

  function openDeleteRoomModal(roomId) {
    pendingDeleteRoomId = roomId;
    var room = findRoom(roomId);
    document.getElementById("deleteRoomDesc").textContent =
      (room ? room.room_no + "호를" : "이 강의실을") + " 삭제하면 되돌릴 수 없어요. 이미 예약/수업 기록이 있는 강의실은 삭제 대신 '사용중지'로 바꿔주세요.";
    deleteRoomModalOverlay.classList.add("show");
  }
  document.getElementById("deleteRoomCancelBtn").addEventListener("click", function () { deleteRoomModalOverlay.classList.remove("show"); });
  document.getElementById("deleteRoomConfirmBtn").addEventListener("click", async function () {
    if (!pendingDeleteRoomId) return;
    var roomId = pendingDeleteRoomId;

    await supabase.from("room_equipment").delete().eq("room_id", roomId);
    var delRes = await supabase.from("rooms").delete().eq("id", roomId);

    deleteRoomModalOverlay.classList.remove("show");
    pendingDeleteRoomId = null;

    if (delRes.error) {
      alert("삭제에 실패했습니다. 이미 예약/수업 기록이 있는 강의실일 수 있어요. 대신 상태를 '사용중지'로 바꿔주세요.\n(" + delRes.error.message + ")");
      return;
    }

    await fetchAllData();
    renderRoomTable();
    renderManagerGrid();
  });

  /* ================= 중간관리자 관리 탭 ================= */
  function renderManagerGrid() {
    var grid = document.getElementById("managerGrid");
    var managersMap = buildManagersMap();
    var ids = Object.keys(managersMap);
    document.getElementById("managerCountLabel").textContent = ids.length;

    if (!ids.length) {
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">지정된 중간관리자가 없어요.</div>';
      return;
    }

    grid.innerHTML = ids.map(function (id) {
      var entry = managersMap[id];
      var m = entry.info;
      var chips = entry.rooms.length
        ? entry.rooms.map(function (rm) { return '<span class="manager-chip">' + rm.room_no + "호</span>"; }).join("")
        : '<span class="manager-chip none">담당 강의실 없음</span>';
      return '<div class="manager-card">' +
        '<div class="manager-card-head">' +
          '<div class="manager-avatar">' + (m.name ? m.name.charAt(0) : "?") + '</div>' +
          '<div><div class="manager-name">' + nameWithId(m) + '</div><div class="manager-email">' + (m.email || "") + '</div></div>' +
        '</div>' +
        '<div class="manager-rooms-label">담당 강의실 (' + entry.rooms.length + ')</div>' +
        '<div class="manager-rooms-chips">' + chips + '</div>' +
        '<div class="manager-card-actions">' +
          '<button type="button" class="icon-btn" data-perm-id="' + id + '">🔑 강의실 권한 수정</button>' +
          '<button type="button" class="icon-btn danger" data-del-mgr="' + id + '">담당 해제</button>' +
        '</div>' +
        '</div>';
    }).join("");

    grid.querySelectorAll("[data-perm-id]").forEach(function (btn) {
      btn.addEventListener("click", function () { openEditPermModal(btn.getAttribute("data-perm-id")); });
    });
    grid.querySelectorAll("[data-del-mgr]").forEach(function (btn) {
      btn.addEventListener("click", function () { openDeleteManagerModal(btn.getAttribute("data-del-mgr")); });
    });
  }

  /* ---------- 강의실 체크리스트 공통 렌더링 (내 건물 강의실만) ---------- */
  function buildRoomCheckListHTML(checkedRoomIds, excludeManagerId) {
    var html = "";
    ROOMS.forEach(function (r) {
      var checked = checkedRoomIds.indexOf(r.id) !== -1 ? " checked" : "";
      var takenLabel = "";
      if (r.manager_id && r.manager_id !== excludeManagerId && r.manager) {
        takenLabel = '<span class="rcl-taken">' + nameWithId(r.manager) + " 담당중</span>";
      }
      html += '<label class="rcl-item"><input type="checkbox" value="' + r.id + '"' + checked + ">" +
        buildingName(r.building_id) + " " + floorLabel(r.floor) + " " + r.room_no + "호" + takenLabel + "</label>";
    });
    return html || '<div class="empty-state" style="padding:20px;">등록된 강의실이 없어요.</div>';
  }
  function checkedRoomIdsFrom(listId) {
    return Array.from(document.querySelectorAll("#" + listId + " input:checked")).map(function (cb) { return parseInt(cb.value, 10); });
  }

  /* ---------- 중간관리자 지정 (이미 가입된 조교 목록에서 선택해서 지정) ---------- */
  var addManagerModalOverlay = document.getElementById("addManagerModalOverlay");
  document.getElementById("openAddManagerBtn").addEventListener("click", function () {
    var userSelect = document.getElementById("amUserSelect");
    if (!ASSISTANT_USERS.length) {
      userSelect.innerHTML = '<option value="">지정 가능한 조교 계정이 없어요</option>';
    } else {
      userSelect.innerHTML = ASSISTANT_USERS.map(function (u) {
        return '<option value="' + u.id + '">' + nameWithId(u) + "</option>";
      }).join("");
    }
    document.getElementById("amErrorBox").classList.remove("show");
    document.getElementById("amRoomCheckList").innerHTML = buildRoomCheckListHTML([], null);
    addManagerModalOverlay.classList.add("show");
  });
  document.getElementById("amCancelBtn").addEventListener("click", function () { addManagerModalOverlay.classList.remove("show"); });

  document.getElementById("amSaveBtn").addEventListener("click", async function () {
    var userId = document.getElementById("amUserSelect").value;
    var errBox = document.getElementById("amErrorBox");

    if (!userId) { errBox.textContent = "지정할 조교를 선택해주세요."; errBox.classList.add("show"); return; }

    var roomIds = checkedRoomIdsFrom("amRoomCheckList");

    var roleRes = await supabase.from("users").update({ role: "mid_admin" }).eq("id", userId);
    if (roleRes.error) { errBox.textContent = "지정에 실패했습니다: " + roleRes.error.message; errBox.classList.add("show"); return; }

    if (roomIds.length) {
      var assignRes = await supabase.from("rooms").update({ manager_id: userId }).in("id", roomIds);
      if (assignRes.error) { errBox.textContent = "강의실 배정에 실패했습니다: " + assignRes.error.message; errBox.classList.add("show"); return; }
    }

    addManagerModalOverlay.classList.remove("show");
    await fetchAllData();
    renderManagerGrid();
    renderRoomTable();
  });

  /* ---------- 강의실 권한 수정 ---------- */
  var editPermModalOverlay = document.getElementById("editPermModalOverlay");
  var currentEditPermId = null;

  function openEditPermModal(id) {
    currentEditPermId = id;
    var entry = buildManagersMap()[id];
    if (!entry) return;
    document.getElementById("editPermDesc").textContent = entry.info.name + "님이 담당할 강의실을 체크/해제해주세요.";
    var checkedIds = entry.rooms.map(function (r) { return r.id; });
    document.getElementById("epRoomCheckList").innerHTML = buildRoomCheckListHTML(checkedIds, id);
    editPermModalOverlay.classList.add("show");
  }
  document.getElementById("epCancelBtn").addEventListener("click", function () { editPermModalOverlay.classList.remove("show"); });

  document.getElementById("epSaveBtn").addEventListener("click", async function () {
    if (!currentEditPermId) return;
    var checkedIds = checkedRoomIdsFrom("epRoomCheckList");
    var prevIds = (buildManagersMap()[currentEditPermId] || { rooms: [] }).rooms.map(function (r) { return r.id; });

    var toAdd = checkedIds.filter(function (id) { return prevIds.indexOf(id) === -1; });
    var toRemove = prevIds.filter(function (id) { return checkedIds.indexOf(id) === -1; });

    if (toAdd.length) await supabase.from("rooms").update({ manager_id: currentEditPermId }).in("id", toAdd);
    if (toRemove.length) await supabase.from("rooms").update({ manager_id: null }).in("id", toRemove);

    editPermModalOverlay.classList.remove("show");
    await fetchAllData();
    renderManagerGrid();
    renderRoomTable();
  });

  /* ---------- 중간관리자 담당 해제 (계정 자체는 삭제하지 않고, role을 assistant로 되돌림) ---------- */
  var deleteManagerModalOverlay = document.getElementById("deleteManagerModalOverlay");
  var pendingDeleteManagerId = null;

  function openDeleteManagerModal(id) {
    pendingDeleteManagerId = id;
    var entry = buildManagersMap()[id];
    document.getElementById("deleteManagerDesc").textContent =
      (entry ? entry.info.name : "이 사람") + "님의 담당을 해제하면 담당하던 강의실 " + (entry ? entry.rooms.length : 0) + "개가 모두 미배정 상태가 되고, 예약자(조교) 권한으로 돌아가요.";
    deleteManagerModalOverlay.classList.add("show");
  }
  document.getElementById("deleteManagerCancelBtn").addEventListener("click", function () { deleteManagerModalOverlay.classList.remove("show"); });
  document.getElementById("deleteManagerConfirmBtn").addEventListener("click", async function () {
    if (!pendingDeleteManagerId) return;
    var id = pendingDeleteManagerId;

    await supabase.from("rooms").update({ manager_id: null }).eq("manager_id", id);
    await supabase.from("users").update({ role: "assistant" }).eq("id", id);

    deleteManagerModalOverlay.classList.remove("show");
    pendingDeleteManagerId = null;
    await fetchAllData();
    renderManagerGrid();
    renderRoomTable();
  });

  /* ================= 학기 관리 탭 (semesters 테이블, 전역 공유) ================= */
  function renderSemesterTable() {
    var tbody = document.getElementById("semesterTableBody");
    document.getElementById("semesterCountLabel").textContent = SEMESTERS.length;
    document.getElementById("semesterEmptyState").style.display = SEMESTERS.length ? "none" : "block";

    tbody.innerHTML = SEMESTERS.map(function (s) {
      return "<tr>" +
        '<td class="cell-room">' + s.name + "</td>" +
        "<td>" + s.start_date + "</td>" +
        "<td>" + s.end_date + "</td>" +
        "<td>" + (s.is_current
          ? '<span class="status-badge st-renovation">현재 학기</span>'
          : '<button type="button" class="icon-btn" data-set-current-sem="' + s.id + '">현재 학기로 설정</button>') + "</td>" +
        '<td style="text-align:right;">' +
          '<button type="button" class="icon-btn" data-edit-sem="' + s.id + '" style="margin-right:6px;">수정</button>' +
          '<button type="button" class="icon-btn danger" data-del-sem="' + s.id + '">삭제</button>' +
        "</td>" +
        "</tr>";
    }).join("");

    tbody.querySelectorAll("[data-del-sem]").forEach(function (btn) {
      btn.addEventListener("click", function () { openDeleteSemesterModal(parseInt(btn.getAttribute("data-del-sem"), 10)); });
    });
    tbody.querySelectorAll("[data-edit-sem]").forEach(function (btn) {
      btn.addEventListener("click", function () { openEditSemesterModal(parseInt(btn.getAttribute("data-edit-sem"), 10)); });
    });
    tbody.querySelectorAll("[data-set-current-sem]").forEach(function (btn) {
      btn.addEventListener("click", function () { setCurrentSemester(parseInt(btn.getAttribute("data-set-current-sem"), 10)); });
    });
  }

  // 학기는 한 번에 하나만 "현재 학기"일 수 있으므로, 나머지는 전부 false로 내리고 선택한 것만 true로 설정
  async function setCurrentSemester(semesterId) {
    var offRes = await supabase.from("semesters").update({ is_current: false }).neq("id", semesterId);
    if (offRes.error) { alert("현재 학기 설정에 실패했습니다: " + offRes.error.message); return; }
    var onRes = await supabase.from("semesters").update({ is_current: true }).eq("id", semesterId);
    if (onRes.error) { alert("현재 학기 설정에 실패했습니다: " + onRes.error.message); return; }

    await fetchAllData();
    renderSemesterTable();
  }

  var addSemesterModalOverlay = document.getElementById("addSemesterModalOverlay");
  var pendingEditSemesterId = null;

  document.getElementById("openAddSemesterBtn").addEventListener("click", function () {
    pendingEditSemesterId = null;
    document.getElementById("asModalTitle").textContent = "학기 추가";
    document.getElementById("asModalDesc").textContent = '모든 중간관리자의 "정기수업 등록" 화면에 동일하게 노출돼요.';
    document.getElementById("asSaveBtn").textContent = "추가";
    document.getElementById("asName").value = "";
    document.getElementById("asStartDate").value = "";
    document.getElementById("asEndDate").value = "";
    document.getElementById("asErrorBox").classList.remove("show");
    addSemesterModalOverlay.classList.add("show");
  });
  document.getElementById("asCancelBtn").addEventListener("click", function () { addSemesterModalOverlay.classList.remove("show"); });

  function openEditSemesterModal(id) {
    var s = SEMESTERS.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    pendingEditSemesterId = id;
    document.getElementById("asModalTitle").textContent = "학기 수정";
    document.getElementById("asModalDesc").textContent = "수정 내용은 모든 중간관리자 화면에 즉시 반영돼요.";
    document.getElementById("asSaveBtn").textContent = "저장";
    document.getElementById("asName").value = s.name;
    document.getElementById("asStartDate").value = s.start_date;
    document.getElementById("asEndDate").value = s.end_date;
    document.getElementById("asErrorBox").classList.remove("show");
    addSemesterModalOverlay.classList.add("show");
  }

  document.getElementById("asSaveBtn").addEventListener("click", async function () {
    var name = document.getElementById("asName").value.trim();
    var start = document.getElementById("asStartDate").value;
    var end = document.getElementById("asEndDate").value;
    var errBox = document.getElementById("asErrorBox");

    if (!name) { errBox.textContent = "학기명을 입력해주세요."; errBox.classList.add("show"); return; }
    if (!start || !end) { errBox.textContent = "시작일과 종료일을 모두 선택해주세요."; errBox.classList.add("show"); return; }
    if (start > end) { errBox.textContent = "종료일은 시작일보다 빠를 수 없어요."; errBox.classList.add("show"); return; }

    var res;
    if (pendingEditSemesterId) {
      res = await supabase.from("semesters").update({ name: name, start_date: start, end_date: end }).eq("id", pendingEditSemesterId);
    } else {
      res = await supabase.from("semesters").insert({ name: name, start_date: start, end_date: end });
    }
    if (res.error) { errBox.textContent = "저장에 실패했습니다: " + res.error.message; errBox.classList.add("show"); return; }

    addSemesterModalOverlay.classList.remove("show");
    await fetchAllData();
    renderSemesterTable();
  });

  var deleteSemesterModalOverlay = document.getElementById("deleteSemesterModalOverlay");
  var pendingDeleteSemesterId = null;
  function openDeleteSemesterModal(id) {
    pendingDeleteSemesterId = id;
    var s = SEMESTERS.filter(function (x) { return x.id === id; })[0];
    document.getElementById("deleteSemesterDesc").textContent =
      (s ? '"' + s.name + '"' : "이 학기") + "를 삭제하면 모든 중간관리자의 목록에서 즉시 사라져요.";
    deleteSemesterModalOverlay.classList.add("show");
  }
  document.getElementById("deleteSemesterCancelBtn").addEventListener("click", function () { deleteSemesterModalOverlay.classList.remove("show"); });
  document.getElementById("deleteSemesterConfirmBtn").addEventListener("click", async function () {
    if (!pendingDeleteSemesterId) return;
    var res = await supabase.from("semesters").delete().eq("id", pendingDeleteSemesterId);
    deleteSemesterModalOverlay.classList.remove("show");
    if (res.error) { alert("삭제에 실패했습니다: " + res.error.message); return; }
    pendingDeleteSemesterId = null;
    await fetchAllData();
    renderSemesterTable();
  });

  /* ---------- 모달 바깥 클릭시 닫기 ---------- */
  [addRoomModalOverlay, deleteRoomModalOverlay, addManagerModalOverlay, editPermModalOverlay,
   deleteManagerModalOverlay, addSemesterModalOverlay, deleteSemesterModalOverlay].forEach(function (ov) {
    ov.addEventListener("click", function (e) { if (e.target === ov) ov.classList.remove("show"); });
  });

  /* ---------- 로그아웃 ---------- */
  document.getElementById("logoutBtn").addEventListener("click", async function () {
    await supabase.auth.signOut();
    window.location.href = "login.html";
  });

  /* ================= 초기 렌더 ================= */
  (async function init() {
    var ok = await requireFinalAdmin();
    if (!ok) return;
    await fetchAllData();
    initRoomBuildingFilterOptions();
    renderRoomTable();
    renderManagerGrid();
    renderSemesterTable();
  })();
