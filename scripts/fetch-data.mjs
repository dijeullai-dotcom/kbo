// KBO 데이터 스크래퍼 — GitHub Actions가 실행해 data/*.json 으로 저장.
// 의존성 없음 (Node 18+ 내장 fetch 사용).
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

const BASE = "https://www.koreabaseball.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function stripTags(s = "") {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- 팀 순위 ----
async function fetchRank() {
  const res = await fetch(`${BASE}/Record/TeamRank/TeamRankDaily.aspx`, {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`rank HTTP ${res.status}`);
  const html = await res.text();

  const m =
    html.match(/<table[^>]*class="tData tt"[^>]*>[\s\S]*?<\/table>/) ||
    html.match(/<table[^>]*tData[^>]*>[\s\S]*?<\/table>/);
  if (!m) throw new Error("ranking table not found");

  const rows = [...m[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => r[1]);
  const teams = [];
  for (const r of rows) {
    const cells = [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) =>
      stripTags(c[1])
    );
    if (cells.length < 8 || !/^\d+$/.test(cells[0])) continue;
    teams.push({
      rank: +cells[0],
      team: cells[1],
      games: +cells[2],
      wins: +cells[3],
      losses: +cells[4],
      draws: +cells[5],
      pct: cells[6],
      gb: cells[7],
      last10: cells[8] || "",
      streak: cells[9] || "",
      home: cells[10] || "",
      away: cells[11] || "",
    });
  }
  const d = html.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  const asOf = d ? `${d[1]}.${d[2]}.${d[3]}` : "";
  return { asOf, teams };
}

// ---- 경기 일정 ----
function parsePlay(html = "") {
  const names = [...html.matchAll(/<span>([^<]*)<\/span>/g)]
    .map((x) => x[1].trim())
    .filter((x) => x && x !== "vs");
  const scores = [...html.matchAll(/<span class="(win|lose|draw)">(\d+)<\/span>/g)].map(
    (x) => +x[2]
  );
  return {
    away: names[0] || "",
    home: names[1] || "",
    awayScore: scores.length > 0 ? scores[0] : null,
    homeScore: scores.length > 1 ? scores[1] : null,
  };
}

async function fetchMonth(seasonId, gameMonth) {
  const body = new URLSearchParams({
    leId: "1",
    srIdList: "0,9,6", // 정규시즌
    seasonId,
    gameMonth,
    teamId: "",
  });
  const res = await fetch(`${BASE}/ws/Schedule.asmx/GetScheduleList`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": UA,
      Referer: `${BASE}/Schedule/Schedule.aspx`, // 필수 — 없으면 에러 HTML 반환
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });
  if (!res.ok) throw new Error(`schedule HTTP ${res.status}`);
  const data = await res.json();

  const games = [];
  let curDate = "";
  for (const r of data.rows || []) {
    const cells = r.row || [];
    const byClass = {};
    for (const c of cells) if (c.Class) byClass[c.Class] = c.Text;

    if (byClass.day) {
      const dm = byClass.day.match(/(\d{2})\.(\d{2})/);
      if (dm) curDate = `${seasonId}${dm[1]}${dm[2]}`;
    }
    if (!byClass.play) continue;

    const texts = cells.map((c) => stripTags(c.Text));
    const stadium = texts.length >= 2 ? texts[texts.length - 2] : "";
    const note = texts.length >= 1 ? texts[texts.length - 1] : "";
    const { away, home, awayScore, homeScore } = parsePlay(byClass.play);
    if (!away && !home) continue;

    // 게임ID (선발투수 병합용) — 리뷰/하이라이트 버튼 href 에 들어있음
    const gidMatch = cells
      .map((c) => c.Text || "")
      .join(" ")
      .match(/gameId=([0-9A-Z]+)/);
    const gameId = gidMatch ? gidMatch[1] : "";

    const finished = awayScore !== null && homeScore !== null;
    games.push({
      date: curDate,
      gameId,
      time: byClass.time ? stripTags(byClass.time) : "",
      away,
      home,
      awayScore,
      homeScore,
      awayPitcher: "",
      homePitcher: "",
      stadium,
      note: note === stadium ? "" : note,
      status: finished
        ? "종료"
        : note && /취소|연기|서스펜디드/.test(note)
        ? "취소"
        : "예정",
    });
  }
  return games;
}

// ---- 선발투수 등 (날짜별 GameCenter 게임리스트) ----
function cleanName(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

async function fetchGameList(date) {
  // GetKboGameList: 해당 날짜 전 경기의 선발/승패/세이브 투수, 점수, 상태
  const body = new URLSearchParams({
    leId: "1",
    srId: "0,1,3,4,5,6,7,9",
    date,
  });
  const res = await fetch(`${BASE}/ws/Main.asmx/GetKboGameList`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": UA,
      Referer: `${BASE}/Schedule/GameCenter/Main.aspx`,
      "X-Requested-With": "XMLHttpRequest",
    },
    body,
  });
  if (!res.ok) throw new Error(`gamelist HTTP ${res.status}`);
  const data = await res.json();
  const arr = data.game || (data.d ? JSON.parse(data.d).game : []) || [];

  // gameId 와 (날짜|원정|홈) 두 키로 등록 (더블헤더 대비해 gameId 우선)
  const map = {};
  for (const g of arr) {
    const info = {
      awayPitcher: cleanName(g.T_PIT_P_NM), // 원정(선공) 선발
      homePitcher: cleanName(g.B_PIT_P_NM), // 홈(후공) 선발
      winPitcher: cleanName(g.W_PIT_P_NM),
      losePitcher: cleanName(g.L_PIT_P_NM),
      savePitcher: cleanName(g.SV_PIT_P_NM),
      // 선발 투수 상세 정보 (승, 패, ERA) 추가
      awayStarterInfo: {
        name: cleanName(g.T_PIT_P_NM),
        wins: g.T_PIT_W_CN || "0",
        losses: g.T_PIT_L_CN || "0",
        era: g.T_PIT_ERA_RT || "-"
      },
      homeStarterInfo: {
        name: cleanName(g.B_PIT_P_NM),
        wins: g.B_PIT_W_CN || "0",
        losses: g.B_PIT_L_CN || "0",
        era: g.B_PIT_ERA_RT || "-"
      }
    };
    if (g.G_ID) map[g.G_ID] = info;
    map[`${date}|${cleanName(g.AWAY_NM)}|${cleanName(g.HOME_NM)}`] = info;
  }
  return map;
}

function monthsAround(d) {
  // 이전달·이번달·다음달 (YYYY, MM)
  const out = [];
  for (let off = -1; off <= 1; off++) {
    const x = new Date(d.getFullYear(), d.getMonth() + off, 1);
    out.push([String(x.getFullYear()), String(x.getMonth() + 1).padStart(2, "0")]);
  }
  return out;
}

async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  const now = new Date();
  const updatedAt = now.toISOString();

  // 순위
  const rank = await fetchRank();
  await writeFile(
    path.join(DATA_DIR, "rank.json"),
    JSON.stringify({ ...rank, updatedAt }, null, 2),
    "utf8"
  );
  console.log(`rank.json: ${rank.teams.length}팀 (기준 ${rank.asOf})`);

  // 일정 (이전·이번·다음 달)
  let games = [];
  for (const [y, m] of monthsAround(now)) {
    try {
      const g = await fetchMonth(y, m);
      games = games.concat(g);
      console.log(`schedule ${y}.${m}: ${g.length}경기`);
    } catch (e) {
      console.error(`schedule ${y}.${m} 실패: ${e.message}`);
    }
  }
  // 중복 제거 + 날짜순 정렬
  const seen = new Set();
  games = games
    .filter((g) => {
      const k = `${g.date}|${g.away}|${g.home}|${g.time}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const dates = [...new Set(games.map((g) => g.date))].sort();

  // 선발투수 병합 — 경기 있는 날짜마다 GetKboGameList 호출
  let pitcherDays = 0;
  for (const date of dates) {
    try {
      const map = await fetchGameList(date);
      for (const g of games) {
        if (g.date !== date) continue;
        const info = map[g.gameId] || map[`${date}|${g.away}|${g.home}`];
        if (!info) continue;
        
        g.awayPitcher = info.awayPitcher;
        g.homePitcher = info.homePitcher;
        g.winPitcher = info.winPitcher;
        g.losePitcher = info.losePitcher;
        g.savePitcher = info.savePitcher;
        
        // 파싱한 선발 투수 상세 정보를 최종 데이터에 병합
        g.awayStarterInfo = info.awayStarterInfo;
        g.homeStarterInfo = info.homeStarterInfo;
      }
      pitcherDays++;
    } catch (e) {
      console.error(`pitcher ${date} 실패: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 120)); // KBO 서버 부담 완화
  }
  console.log(`선발투수 병합: ${pitcherDays}/${dates.length}일`);

  await writeFile(
    path.join(DATA_DIR, "schedule.json"),
    JSON.stringify({ games, dates, updatedAt }, null, 2),
    "utf8"
  );
  console.log(`schedule.json: 총 ${games.length}경기, ${dates.length}일`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
