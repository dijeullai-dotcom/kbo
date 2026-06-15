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

    const finished = awayScore !== null && homeScore !== null;
    games.push({
      date: curDate,
      time: byClass.time ? stripTags(byClass.time) : "",
      away,
      home,
      awayScore,
      homeScore,
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
