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
  const texts = [...html.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((x) => x[1].trim());
  const names = texts.filter((x) => x && x.toLowerCase() !== "vs" && isNaN(Number(x)));
  const scores = texts.filter((x) => x && !isNaN(Number(x))).map((x) => Number(x));

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
    srIdList: "0,9,6", 
    seasonId,
    gameMonth,
    teamId: "",
  });
  const res = await fetch(`${BASE}/ws/Schedule.asmx/GetScheduleList`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": UA,
      Referer: `${BASE}/Schedule/Schedule.aspx`,
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

  const map = {};
  for (const g of arr) {
    const info = {
      awayPitcher: cleanName(g.T_PIT_P_NM),
      homePitcher: cleanName(g.B_PIT_P_NM),
      winPitcher: cleanName(g.W_PIT_P_NM),
      losePitcher: cleanName(g.L_PIT_P_NM),
      savePitcher: cleanName(g.SV_PIT_P_NM),
    };
    if (g.G_ID) map[g.G_ID] = info;
    map[`${date}|${cleanName(g.AWAY_NM)}|${cleanName(g.HOME_NM)}`] = info;
  }
  return map;
}

// ---- 예고 선발 투수 (StartingPitcher.aspx) ----
async function fetchPreviewPitchers() {
  try {
    const res = await fetch(`${BASE}/Schedule/StartingPitcher.aspx`, {
      headers: { "User-Agent": UA },
    });
    if (!res.ok) throw new Error(`preview HTTP ${res.status}`);
    const html = await res.text();

    const previewMap = {};
    const blocks = html.match(/<div class="team">[\s\S]*?<\/div>/g) || [];

    for (const block of blocks) {
      const teamMatch = block.match(/alt="([^"]+)"/);
      const nameMatch = block.match(/class="name"[^>]*>([^<]+)/) || block.match(/class="tit"[^>]*>선발투수.*?([^<]+)/s);

      if (teamMatch && nameMatch) {
        let team = cleanName(teamMatch[1]);
        let pitcher = cleanName(nameMatch[1]);
        
        pitcher = pitcher.replace(/선발투수|좌투좌타|우투우타|우투좌타|좌투우타/g, "").trim();
        if (team && pitcher) {
          previewMap[team] = pitcher;
        }
      }
    }
    return previewMap;
  } catch (e) {
    console.error(`예고 선발 수집 실패: ${e.message}`);
    return {}; 
  }
}

function monthsAround(d) {
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

  // 순위 (가져오기만 하고 저장은 마지막 단계에서 처리)
  const rank = await fetchRank();

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

  const previewPitchers = await fetchPreviewPitchers();
  console.log(`예고 선발 데이터 확보: ${Object.keys(previewPitchers).length}팀`);

  let pitcherDays = 0;
  for (const date of dates) {
    try {
      const map = await fetchGameList(date);
      for (const g of games) {
        if (g.date !== date) continue;
        const info = map[g.gameId] || map[`${date}|${g.away}|${g.home}`];
        
        g.awayPitcher = (info && info.awayPitcher) ? info.awayPitcher : (previewPitchers[g.away] || "");
        g.homePitcher = (info && info.homePitcher) ? info.homePitcher : (previewPitchers[g.home] || "");

        if (info) {
          g.winPitcher = info.winPitcher || "";
          g.losePitcher = info.losePitcher || "";
          g.savePitcher = info.savePitcher || "";
        }
      }
      pitcherDays++;
    } catch (e) {
      console.error(`pitcher ${date} 실패: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 120)); 
  }
  console.log(`선발투수 병합 완료: ${pitcherDays}/${dates.length}일 처리`);

  // 💡 [방어 로직] 데이터가 불완전하면 파일 저장을 중단하고 빠져나갑니다.
  const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const todayStr = `${kstNow.getUTCFullYear()}${String(kstNow.getUTCMonth() + 1).padStart(2, "0")}${String(kstNow.getUTCDate()).padStart(2, "0")}`;
  
  const todaysGames = games.filter(g => g.date === todayStr);
  let isAmbiguous = false;

  for (const g of todaysGames) {
    const hasScore = g.awayScore !== null && g.homeScore !== null;
    const isDraw = hasScore && (g.awayScore === g.homeScore);
    const isCanceled = g.status === "취소" || (g.note && g.note.includes("취소"));

    // 점수는 났고 무승부/취소가 아닌데, 승리 투수 기록이 비어있다면 대기 상태로 간주
    if (hasScore && !isDraw && !isCanceled && !g.winPitcher) {
      console.log(`[보류] ${g.away} vs ${g.home} : 경기는 끝났으나 KBO 승/패 투수 집계 대기 중`);
      isAmbiguous = true;
    }
  }

  if (isAmbiguous) {
    console.log("🚨 애매한 데이터 감지! 파일 업데이트(커밋)를 건너뛰고 15분 뒤 다음 스케줄을 기다립니다.");
    process.exit(0); 
  }

  // 💡 [저장 로직] 방어선을 무사히 통과했을 때만 최종적으로 파일을 업데이트합니다.
  await writeFile(
    path.join(DATA_DIR, "rank.json"),
    JSON.stringify({ ...rank, updatedAt }, null, 2),
    "utf8"
  );
  console.log(`rank.json: ${rank.teams.length}팀 (기준 ${rank.asOf})`);

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
