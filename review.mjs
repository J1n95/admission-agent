const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

async function json(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.message || "请求失败");
  return payload;
}

function selectedValues(selector) {
  return [...($(selector)?.selectedOptions || [])].map(option => option.value).filter(Boolean);
}

function renderCollectorOptions(value) {
  const countries = value.countries || [];
  const schools = value.schools || [];
  const directions = value.directions || [];
  const countrySelect = $("#collector-countries");
  const schoolSelect = $("#collector-institutions");
  const directionSelect = $("#collector-focus-tags");
  countrySelect.innerHTML = countries.map(country => `<option value="${escapeHtml(country.id)}">${escapeHtml(country.name)}</option>`).join("");
  directionSelect.innerHTML = directions.map(direction => `<option value="${escapeHtml(direction.id)}">${escapeHtml(direction.name)}（${direction.programmeCount}个项目）</option>`).join("");
  const renderSchools = () => {
    const selectedCountries = selectedValues("#collector-countries");
    const selectedSchools = new Set(selectedValues("#collector-institutions"));
    const visibleSchools = schools.filter(school => !selectedCountries.length || selectedCountries.includes(school.country));
    schoolSelect.innerHTML = visibleSchools.map(school => `<option value="${escapeHtml(school.id)}" ${selectedSchools.has(school.id) ? "selected" : ""}>${escapeHtml(school.name)}（${escapeHtml(school.country)}）</option>`).join("");
  };
  countrySelect.addEventListener("change", renderSchools);
  renderSchools();
}

function renderSummary(value) {
  const labels = [["total", "总记录"], ["approved", "已通过"], ["pending", "待分流"], ["needs-review", "需复核"], ["rejected", "已排除"]];
  $("#summary").innerHTML = labels.map(([key, label]) => `<div><strong>${value[key] || 0}</strong><span>${label}</span></div>`).join("");
}

function renderCollectorStatus(value) {
  const active = Boolean(value.active);
  const state = $("#collector-state");
  const scope = value.scope;
  const scopeLabel = scope
    ? `范围：${scope.countries?.length ? scope.countries.join("、") : "全部地区"} · ${scope.institutions?.length ? `${scope.institutions.length}所学校` : "全部学校"} · ${scope.focusTags?.length ? scope.focusTags.join("、") : "全部方向"}`
    : "范围：未启动";
  state.textContent = active
    ? `运行中 · PID ${value.pid} · 启动于 ${value.startedAt || "未知"} · ${scopeLabel}`
    : value.finishedAt
      ? `当前未运行 · 上次结束于 ${value.finishedAt} · 退出码 ${value.exitCode ?? "未知"} · ${scopeLabel}`
      : "当前没有运行中的案例采集 Agent";
  $("#collector-start").disabled = active;
  $("#collector-stop").disabled = !active;
  $("#collector-log").textContent = (value.output || []).slice(-30).join("\n");
}

async function loadCollectorStatus() {
  try {
    renderCollectorStatus(await json("/api/collector/status"));
  } catch (error) {
    $("#collector-state").textContent = error.message;
  }
}

function renderCoverage(value) {
  const projects = value.projects || [];
  const excludedProjects = value.excludedProjects || [];
  const reached = projects.filter(project => project.reached).length;
  const gaps = projects.filter(project => !project.reached);
  const renderTable = rows => rows.length ? `<div class="coverage-table-wrap"><table class="coverage-table">
    <thead><tr><th>项目</th><th>approved</th><th>目标</th><th>缺口</th><th>待审核</th><th>pending</th><th>状态</th></tr></thead>
    <tbody>${rows.map(project => `<tr>
      <td><strong>${escapeHtml(project.university)}</strong><span>${escapeHtml(project.name)}</span></td>
      <td class="${project.reached ? "ok" : "short"}">${project.approved}</td>
      <td>${project.target}</td>
      <td>${project.gap ? `<strong class="short">${project.gap}</strong>` : "—"}</td>
      <td>${project.needsReview}</td>
      <td>${project.pending}</td>
      <td><span class="coverage-status ${project.reached ? "ok" : "short"}">${project.reached ? "已达标" : "需补充"}</span></td>
    </tr>`).join("")}</tbody>
  </table></div>` : '<p class="empty coverage-empty">当前没有项目缺口。</p>';
  const exclusionLabel = project => project.exclusion === "new-programme"
    ? "新项目"
    : project.exclusion === "no-case-source"
      ? "多来源检索后仍无新增"
      : "范围待复核";
  const renderExcluded = rows => rows.length ? `<div class="coverage-table-wrap"><table class="coverage-table">
    <thead><tr><th>项目</th><th>approved</th><th>状态</th><th>说明</th></tr></thead>
    <tbody>${rows.map(project => `<tr>
      <td><strong>${escapeHtml(project.university)}</strong><span>${escapeHtml(project.name)}</span></td>
      <td>${project.approved}</td>
      <td><span class="coverage-status">${escapeHtml(exclusionLabel(project))}</span></td>
      <td>${escapeHtml(project.exclusionReason || project.statusReason || "")}</td>
    </tr>`).join("")}</tbody>
  </table></div>` : '<p class="empty coverage-empty">没有被排除的项目。</p>';
  $("#coverage").innerHTML = `
    <div class="coverage-head">
    <div><h2>港八新二全部项目案例覆盖</h2><p>仅统计 ${escapeHtml(value.yearFrom || 2021)} 年及之后；每个有效授课型硕士项目目标 ${escapeHtml(value.target || 10)} 条 approved。</p></div>
      <strong>${reached}/${projects.length} 已达标</strong>
    </div>
    <p class="meta">主表项目 ${escapeHtml(value.totalMasterProgrammes || projects.length)} 个；当前纳入目标 ${escapeHtml(value.eligibleProjects || projects.length)} 个；缺口 ${gaps.length} 个。</p>
    <details class="coverage-group"><summary>当前缺口项目（${gaps.length}）</summary>${renderTable(gaps)}</details>
    <details class="coverage-group" open><summary>已达标项目（${reached}）</summary>${renderTable(projects.filter(project => project.reached))}</details>`;
  $("#coverage").insertAdjacentHTML("beforeend", `<details class="coverage-group"><summary>不纳入当前缺口（${excludedProjects.length}）</summary>${renderExcluded(excludedProjects)}</details>`);
}

function renderPreview(payload) {
  const items = payload.decisions || [];
  const preview = $("#llmPreview");
  if (!items.length) { preview.hidden = true; preview.innerHTML = ""; return; }
  preview.hidden = false;
  preview.innerHTML = `<h2>LLM 试审结果（仅预览）</h2>${items.map(item => {
    const decision = item.decision || {};
    const evidence = (decision.evidence || []).map(entry => `${escapeHtml(entry.field)}：${escapeHtml(entry.quote)}`).join("；") || "无原文证据";
    return `<div class="preview-item"><p><strong>${escapeHtml(item.undergraduateUniversity || "本科院校未披露")}</strong> · ${escapeHtml(item.targetUniversity)} · 建议 ${escapeHtml(decision.decision)} · 置信度 ${escapeHtml(decision.confidence)}</p><p>${escapeHtml(decision.reason)}</p><p>证据：${evidence}</p></div>`;
  }).join("")}`;
}

let programmes = [];
let summaryValue = {};
function input(name, value, type = "text") { return `<label>${name}<input data-field="${name}" type="${type}" value="${escapeHtml(value ?? "")}"></label>`; }
function renderCase(item) {
  const decision = item.decision ? `<p class="meta">自动建议：${escapeHtml(item.decision.status)} · ${escapeHtml(item.decision.confidence)} · ${escapeHtml(item.decision.reason)}</p>` : "";
  const issues = item.issues?.length ? `<p class="issue">疑点：${escapeHtml(item.issues.join("；"))}</p>` : "";
  const fields = [item.targetUniversity, item.targetProgramme, `竞争批次 ${item.offerYear || "待补"}`, item.undergraduateUniversity, item.undergraduateMajor, item.gpaRaw, item.languageTest && `${item.languageTest} ${item.languageScore ?? ""}`].filter(Boolean);
  const programmeOptions = programmes.map(p => `<option value="${escapeHtml(p.id)}" ${p.id === item.targetProgrammeId ? "selected" : ""}>${escapeHtml(`${p.institutionNameZh || p.institutionId}｜${p.nameZh}`)}</option>`).join("");
  return `<article class="case" data-fingerprint="${escapeHtml(item.fingerprint)}"><div class="case-head"><div><h2>${escapeHtml(item.undergraduateUniversity || "本科院校未披露")}</h2><div class="meta">${escapeHtml(item.targetUniversity)} · ${escapeHtml(item.targetProgramme)} · <a href="${escapeHtml(item.sourceUrl)}" target="_blank">打开原文</a></div></div><div class="case-actions"><button data-action="approve">通过</button><button data-action="reject">排除</button><button data-action="pending">保留</button></div></div><div class="chips">${fields.map(field => `<span class="chip">${escapeHtml(field)}</span>`).join("")}</div>${issues}${decision}<details class="edit"><summary>修改案例字段</summary><p class="meta">竞争批次年份：优先明确的录取年份；没有时填写文章发布时间对应年份。</p><div class="edit-grid">${input("targetUniversity", item.targetUniversity)}${input("targetProgramme", item.targetProgramme)}<label>目标项目<select data-field="targetProgrammeId"><option value="">未匹配</option>${programmeOptions}</select></label>${input("offerYear", item.offerYear, "number")}${input("sourcePublishedAt", item.sourcePublishedAt, "date")}${input("undergraduateUniversity", item.undergraduateUniversity)}${input("undergraduateMajor", item.undergraduateMajor)}${input("gpaRaw", item.gpaRaw)}${input("languageTest", item.languageTest)}${input("languageScore", item.languageScore, "number")}</div><button data-edit-save>保存修改</button></details><details><summary>查看原始字段与证据</summary><pre>${escapeHtml(JSON.stringify({fingerprint:item.fingerprint,fields:{targetUniversity:item.targetUniversity,targetProgramme:item.targetProgramme,offerYear:item.offerYear,undergraduateUniversity:item.undergraduateUniversity,undergraduateMajor:item.undergraduateMajor,gpaRaw:item.gpaRaw,gpaScale:item.gpaScale,languageTest:item.languageTest,languageScore:item.languageScore,internships:item.internships,research:item.research,competitions:item.competitions},sourceEvidence:item.sourceEvidence,sourceRefs:item.sourceRefs},null,2))}</pre></details></article>`;
}

async function load() {
  const status = $("#status").value;
  $("#list").setAttribute("aria-busy", "true");
  $("#list").innerHTML = '<p class="loading">正在读取待审核案例…</p>';
  const [summary, coverage, payload, master] = await Promise.all([
    json("/api/review/summary"),
    json("/api/review/coverage"),
    json(`/api/review/cases?status=${encodeURIComponent(status)}&limit=100`),
    programmes.length ? Promise.resolve({ programmes }) : json("/api/review/programmes")
  ]);
  programmes = master.programmes || programmes;
  summaryValue = summary;
  renderSummary(summaryValue);
  renderCoverage(coverage);
  $("#list").innerHTML = payload.cases.length ? payload.cases.map(renderCase).join("") : '<p class="empty">没有待处理记录。</p>';
  $("#list").removeAttribute("aria-busy");
  document.querySelectorAll("[data-action]").forEach(button => button.addEventListener("click", async () => {
    const card = button.closest(".case");
    const statusValue = button.dataset.action === "approve" ? "approved" : button.dataset.action === "reject" ? "rejected" : "pending";
    if (statusValue === "rejected" && !window.confirm("只排除分析，不删除原始记录。确定排除吗？")) return;
    card.querySelectorAll("button").forEach(item => { item.disabled = true; });
    card.classList.add("processing");
    try {
      await json(`/api/review/case/${encodeURIComponent(card.dataset.fingerprint)}`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({status:statusValue}) });
      card.remove();
      const [nextSummary, nextCoverage] = await Promise.all([json("/api/review/summary"), json("/api/review/coverage")]);
      summaryValue = nextSummary;
      renderSummary(summaryValue);
      renderCoverage(nextCoverage);
    } catch (error) {
      card.classList.remove("processing");
      card.querySelectorAll("button").forEach(item => { item.disabled = false; });
      window.alert(error.message);
    }
  }));
  document.querySelectorAll("[data-edit-save]").forEach(button => button.addEventListener("click", async () => {
    const card = button.closest(".case");
    const body = Object.fromEntries([...card.querySelectorAll("[data-field]")].map(field => [field.dataset.field, field.value]));
    await json(`/api/review/edit/${encodeURIComponent(card.dataset.fingerprint)}`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body) });
    await load();
  }));
}

$("#refresh").addEventListener("click", load);
$("#status").addEventListener("change", load);
$("#collector-form").addEventListener("submit", async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  const start = $("#collector-start");
  start.disabled = true;
  try {
    await json("/api/collector/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        limit: Number(values.limit),
        concurrency: Number(values.concurrency),
        targetApproved: Number(values.targetApproved),
        maxPages: Number(values.maxPages),
        searchRequests: Number(values.searchRequests),
        countries: selectedValues("#collector-countries"),
        institutions: selectedValues("#collector-institutions"),
        focusTags: selectedValues("#collector-focus-tags"),
        importMastermate: values.importMastermate === "on"
      })
    });
    await loadCollectorStatus();
  } catch (error) {
    window.alert(error.message);
    start.disabled = false;
  }
});

$("#collector-stop").addEventListener("click", async () => {
  if (!window.confirm("确定停止后台案例采集 Agent 吗？已经写入数据库的案例不会丢失。")) return;
  await json("/api/collector/stop", { method: "POST" });
  await loadCollectorStatus();
});

$("#collector-refresh").addEventListener("click", loadCollectorStatus);
$("#logout").addEventListener("click", async () => {
  await json("/api/admin/logout", { method: "POST" });
  location.replace("/admin.html");
});
$("#triage").addEventListener("click", async () => {
  const preview = await json("/api/review/auto-triage", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({apply:false,limit:500}) });
  if (!window.confirm(`系统识别出 ${preview.suggestedApproved} 条高置信度记录。只会把这些记录标记为 approved，不会删除任何数据。继续吗？`)) return;
  await json("/api/review/auto-triage", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({apply:true,limit:500}) });
  await load();
});

$("#llmTriage").addEventListener("click", async () => {
  if (!window.confirm("将调用已配置的外部模型 API，抓取来源页面并试审最多 5 条案例。先只预览，不会修改数据库。继续吗？")) return;
  const preview = await json("/api/review/llm-triage", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({apply:false,limit:5}) });
  renderPreview(preview);
  const approved = preview.suggestedApproved || 0;
  const rejected = preview.suggestedRejected || 0;
  if (!window.confirm(`LLM 建议通过 ${approved} 条、排除 ${rejected} 条。只有高置信度且有至少 2 条原文证据的结果会被应用，继续写入吗？`)) return;
  await json("/api/review/llm-triage", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({apply:true,limit:5}) });
  await load();
});

load().catch(error => { $("#list").innerHTML = `<p class="issue">${escapeHtml(error.message)}</p>`; });
json("/api/collector/options").then(renderCollectorOptions).catch(error => { $("#collector-state").textContent = error.message; });
loadCollectorStatus();
setInterval(loadCollectorStatus, 5000);
