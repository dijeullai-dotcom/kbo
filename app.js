// 팀별 색상
const TEAM = {
  LG: "#c30452", KT: "#eb1c24", 삼성: "#0e4ca1", KIA: "#ea0029", 두산: "#1a1748",
  한화: "#ff6600", NC: "#315288", SSG: "#ce0e2d", 키움: "#820024", 롯데: "#d00f31",
};
const teamColor = (t) => TEAM[t] || "#5b6675";

// 팀명 → KBO 엠블럼 이미지 링크 (팀마다 연도 폴더가 다름)
const LOGO_BASE =
  "https://6ptotvmi5753.edge.naverncp.com/KBO_IMAGE/KBOHome/resources/images/emblem/regular";
const TEAM_LOGO = {
  LG: `${LOGO_BASE}/2022/LG.png`,
  KT: `${LOGO_BASE}/2022/KT.png`,
  삼성: `${LOGO_BASE}/2022/SS.png`,
  KIA: `${LOGO_BASE}/2022/HT.png`,
  롯데: `${LOGO_BASE}/2022/LT.png`,
  NC: `${LOGO_BASE}/2022/NC.png`,
  키움: `${LOGO_BASE}/2022/WO.png`,
  SSG: `${LOGO_BASE}/2024/SK.png`,
  한화: `${LOGO_BASE}/2025/HH.png`,
  두산: `${LOGO_BASE}/2025/OB.png`,
};
const teamLogo = (t) => TEAM_LOGO[t] || "";

const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, "0");

function ymd(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}
const toInput = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
const fromInput = (v) => v.replace(/-/g, "");

function prettyDate(s) {
  const dow = ["일", "월", "화", "수", "목", "금", "토"];
  const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return `${+s.slice(4, 6)}월 ${+s.slice(6, 8)}일 (${dow[d.getDay()]})`;
}
function relTime(iso) {
  if (!iso) return "";
  const diff = (Date.now() - new Date(iso).getTime()) / 60000;
  if (diff < 1) return "방금 전";
  if (diff < 60) return `${Math.floor(diff)}분 전`;
  if (diff < 1440) return `${Math.floor(diff / 60)}시간 전`;
  return `${Math.floor(diff / 1440)}일 전`;
}

let current = ymd(new Date());
let schedule = null; // { games, dates, updatedAt }

// ---------- 데이터 로드 ----------
async function loadSchedule() {
  const box = $("#gameList");
  box.innerHTML = `<div class="loading">불러오는 중…</div>`;
  try {
    const res = await fetch(`data/schedule.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`schedule.json (${res.status})`);
    schedule = await res.json();
    renderGames();
  } catch (e) {
    box.innerHTML = `<div class="error">경기 정보를 불러오지 못했습니다.<br>${e.message}<br><small>아직 데이터가 수집되지 않았을 수 있습니다.</small></div>`;
  }
}

async function loadRank() {
  const box = $("#rankTable");
  box.innerHTML = `<div class="loading">불러오는 중…</div>`;
  try {
    const res = await fetch(`data/rank.json?t=${Date.now()}`);
    if (!res.ok) throw new Error(`rank.json (${res.status})`);
    const data = await res.json();
    const stamp = [data.asOf ? `${data.asOf} 기준` : "", data.updatedAt ? `· ${relTime(data.updatedAt)} 수집` : ""]
      .filter(Boolean)
      .join(" ");
    $("#rankAsOf").textContent = stamp;
    renderRank(data.teams);
  } catch (e) {
    box.innerHTML = `<div class="error">순위를 불러오지 못했습니다.<br>${e.message}</div>`;
  }
}

// ---------- 렌더 ----------
function renderGames() {
  const box = $("#gameList");
  $("#datePick").value = toInput(current);
  const games = (schedule?.games || []).filter((g) => g.date === current);

  if (!games.length) {
    box.innerHTML = `<div class="empty">${prettyDate(current)}<br>예정된 경기가 없습니다.</div>`;
    return;
  }
  box.innerHTML = "";
  const head = document.createElement("div");
  head.className = "asof";
  head.style.padding = "0 4px 2px";
  head.textContent = `${prettyDate(current)} · ${games.length}경기` +
    (schedule.updatedAt ? `  ·  ${relTime(schedule.updatedAt)} 수집` : "");
  box.appendChild(head);

  for (const g of games) {
    const finished = g.status === "종료" && g.awayScore != null;
    const awayWin = finished && g.awayScore > g.homeScore;
    const homeWin = finished && g.homeScore > g.awayScore;

    const badge =
      g.status === "종료"
        ? `<span class="gc-badge b-end">경기종료</span>`
        : g.status === "취소"
        ? `<span class="gc-badge b-cancel">${g.note || "취소"}</span>`
        : `<span class="gc-badge b-soon">${g.time || "예정"}</span>`;

    const mid = finished
      ? `<div class="gc-score"><span class="${awayWin ? "w" : "l"}">${g.awayScore}</span>
           <span style="color:var(--muted);font-size:16px"> : </span>
           <span class="${homeWin ? "w" : "l"}">${g.homeScore}</span></div>`
      : `<div class="gc-vs">VS</div>`;

    // 선발투수 (예고 또는 실제) — 라벨은 종료 경기면 "선발" 그대로
    const awayPit = g.awayPitcher
      ? `<div class="gc-pit">선발 ${g.awayPitcher}</div>`
      : "";
    const homePit = g.homePitcher
      ? `<div class="gc-pit">선발 ${g.homePitcher}</div>`
      : "";
    // 종료 경기면 승/패/세이브 투수 요약
    const decision = finished
      ? `<div class="gc-decide">${[
          g.winPitcher && `<span class="d-w">승 ${g.winPitcher}</span>`,
          g.losePitcher && `<span class="d-l">패 ${g.losePitcher}</span>`,
          g.savePitcher && `<span class="d-s">세 ${g.savePitcher}</span>`,
        ]
          .filter(Boolean)
          .join("")}</div>`
      : "";

    const card = document.createElement("div");
    card.className = "game-card";
    card.style.setProperty("--team", teamColor(g.home));
    const awayLogo = `<img class="gc-logo" src="${teamLogo(g.away)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
    const homeLogo = `<img class="gc-logo" src="${teamLogo(g.home)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
    card.innerHTML = `
      <div class="gc-team away">
        <div class="gc-name">${awayLogo}${g.away}</div>
        ${awayPit}
      </div>
      <div class="gc-mid">
        ${mid}
        ${badge}
        <div class="gc-meta">${g.stadium || ""}</div>
        ${decision}
      </div>
      <div class="gc-team home">
        <div class="gc-name">${g.home}${homeLogo}</div>
        ${homePit}
      </div>`;
    box.appendChild(card);
  }
}

function renderRank(teams) {
  const box = $("#rankTable");
  if (!teams || !teams.length) {
    box.innerHTML = `<div class="empty">순위 데이터가 없습니다.</div>`;
    return;
  }
  const rows = teams
    .map((t) => {
      const sc = /승$/.test(t.streak) ? "streak-up" : /패$/.test(t.streak) ? "streak-down" : "";
      return `<tr>
        <td class="t-rank">${t.rank}</td>
        <td class="t-team"><img class="t-logo" src="${teamLogo(t.team)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">${t.team}</td>
        <td>${t.games}</td>
        <td>${t.wins}</td>
        <td>${t.losses}</td>
        <td>${t.draws}</td>
        <td class="t-pct">${t.pct}</td>
        <td>${t.gb}</td>
        <td>${t.last10}</td>
        <td class="${sc}">${t.streak}</td>
      </tr>`;
    })
    .join("");

  box.innerHTML = `<table class="rank">
    <thead><tr>
      <th>순위</th><th>팀</th><th>경기</th><th>승</th><th>패</th><th>무</th>
      <th>승률</th><th>게임차</th><th>최근10</th><th>연속</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ---------- 이벤트 ----------
function shiftDay(delta) {
  const d = new Date(+current.slice(0, 4), +current.slice(4, 6) - 1, +current.slice(6, 8));
  d.setDate(d.getDate() + delta);
  current = ymd(d);
  renderGames();
}

$("#prevDay").addEventListener("click", () => shiftDay(-1));
$("#nextDay").addEventListener("click", () => shiftDay(1));
$("#todayBtn").addEventListener("click", () => { current = ymd(new Date()); renderGames(); });
$("#datePick").addEventListener("change", (e) => { current = fromInput(e.target.value); renderGames(); });
$("#refresh").addEventListener("click", () => { loadSchedule(); loadRank(); });

// 초기 로드
loadSchedule();
loadRank();
