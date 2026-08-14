// 가계도 뷰어/편집기 — 외부 의존성 없는 순수 JS + SVG
'use strict';

// ---------- 레이아웃 상수 ----------
// 상자 높이는 렌더링 직전에 계산되고(computeNodeSize), 폭은 인물별 이름 길이에 맞춘다
const NODE_W = 74;  // 간격 계산용 기준 폭
let NODE_H = 30, ROW_H = 100;
const COUPLE_GAP = 8;

function computeNodeSize() {
  NODE_H = S.priv ? 40 : 30;  // 생몰년 줄이 보일 때만 높게
  ROW_H = NODE_H + 70;
}

const nodeW = p => Math.max(64, p.name.length * 15 + 16);

// ---------- 전역 상태 ----------
const S = {
  db: null,          // { version, title, defaultFocus, people:[...] } (private 제외)
  priv: null,        // { id: {birth, death, note, links} } — 쓰기 암호 해제 후에만
  byId: {}, orderOf: {},
  readPw: null, writePw: null, remote: null,
  focusId: null, selectedId: null,
  editMode: false, dirty: false, chonView: false, maxChon: -1, showInlaw: true,
  bulkSel: new Set(), bulkOpen: false,
  view: { x: 0, y: 0, k: 1 },
};

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- 데이터 헬퍼 ----------
function indexDb() {
  S.byId = {}; S.orderOf = {};
  S.db.people.forEach((p, i) => { S.byId[p.id] = p; S.orderOf[p.id] = i; });
}
const order = p => S.orderOf[p.id] ?? 0;
const childrenOf = id =>
  id ? S.db.people.filter(p => p.father === id || p.mother === id) : [];
function spouseOf(p) {
  if (p.spouses && p.spouses.length) return S.byId[p.spouses[0]] || null;
  const q = S.db.people.find(q => (q.spouses || []).includes(p.id));
  if (q) return q;
  // 명시된 배우자가 없으면 공동 자녀의 반대편 부모로 유추
  const child = S.db.people.find(c => c.father === p.id || c.mother === p.id);
  if (child) {
    const otherId = child.father === p.id ? child.mother : child.father;
    return otherId ? S.byId[otherId] || null : null;
  }
  return null;
}
const siblingsOf = p => S.db.people.filter(q =>
  q.id !== p.id && ((p.father && q.father === p.father) ||
                    (p.mother && q.mother === p.mother)));
const privOf = id => (S.priv && S.priv[id]) || null;

function allSpouses(p) {
  const out = new Map();
  for (const id of p.spouses || []) if (S.byId[id]) out.set(id, S.byId[id]);
  for (const q of S.db.people) {
    if ((q.spouses || []).includes(p.id)) out.set(q.id, q);
  }
  // 명시가 없어도 공동 자녀가 있으면 배우자로 묶는다
  for (const c of S.db.people) {
    if (c.father === p.id && c.mother && S.byId[c.mother]) out.set(c.mother, S.byId[c.mother]);
    if (c.mother === p.id && c.father && S.byId[c.father]) out.set(c.father, S.byId[c.father]);
  }
  return [...out.values()];
}

// ---------- 레이아웃 ----------
// v4 "두 클랜 + 말단 배우자" 모델 (2026-08-14, 사용자 설계):
// 표시 대상을 [포커스의 혈족 + 그 배우자]와 [배우자의 혈족 + 그 배우자]로
// 한정하면(법적 인척의 정의) 모든 혼인 상대는 말단(잎)이 된다 — 형수의 친정
// 같은 사돈 계열이 아예 없으므로, 혈족 1명 + 말단 배우자들을 블록 하나로 묶고
// 형제 사이사이에 각자의 배우자를 끼워 그릴 수 있다.
// 순서: 계보(직계) 구간 키를 위 세대부터 아래로 흘리는 캐스케이드 —
//   친가 < 외가 < 본인 < 배우자 < 처친가 < 처외가 순서가 자연히 나온다.
// 좌표: 우선순위 고정 배치(중앙부터 동결) + 조상 부부쌍의 대칭 배치.

// 혈족 = 조상들(본인 포함) + 그 조상들의 모든 후손
function bloodOf(id) {
  const anc = new Set([id]);
  const qa = [id];
  while (qa.length) {
    const p = S.byId[qa.pop()];
    if (!p) continue;
    for (const pid of [p.father, p.mother]) {
      if (pid && S.byId[pid] && !anc.has(pid)) { anc.add(pid); qa.push(pid); }
    }
  }
  const blood = new Set(anc);
  const qd = [...anc];
  while (qd.length) {
    for (const c of childrenOf(qd.pop())) {
      if (!blood.has(c.id)) { blood.add(c.id); qd.push(c.id); }
    }
  }
  return blood;
}

// 표시 대상 2단계: ① 혈족 + 혈족의 배우자 ② + 배우자의 혈족 + 그 혈족의 배우자.
// anchors = 어느 한 클랜의 혈족(자기 블록을 가짐), 나머지 표시 인물은 말단 배우자.
function visibleSet(focusId) {
  const anchors = bloodOf(focusId);
  if (S.showInlaw) {
    for (const sp of allSpouses(S.byId[focusId])) {
      for (const id of bloodOf(sp.id)) anchors.add(id);
    }
  }
  const vis = new Set(anchors);
  for (const id of anchors) {
    for (const s of allSpouses(S.byId[id])) vis.add(s.id);
  }
  return { vis, anchors };
}

// 블록 = 혈족(닻) 1명 + 그 말단 배우자들, 남자들 먼저(남남여). 두 뷰 공용.
function buildBlocks(people, vis, anchors) {
  const gid = new Map(), groups = [];
  for (const p of people) {
    if (!anchors.has(p.id) || gid.has(p.id)) continue;
    const mem0 = [p, ...allSpouses(p).filter(s =>
      vis.has(s.id) && !anchors.has(s.id) && !gid.has(s.id))];
    const mem = [...mem0.filter(x => x.gender !== 'F'),
                 ...mem0.filter(x => x.gender === 'F')];
    const g = { id: groups.length, members: mem, anchor: p, x: 0 };
    groups.push(g);
    mem.forEach(m => gid.set(m.id, g));
  }
  for (const p of people) {  // 안전망: 겹혼인 말단 등 못 붙은 사람은 단독 블록
    if (gid.has(p.id)) continue;
    const g = { id: groups.length, members: [p], anchor: p, x: 0 };
    groups.push(g);
    gid.set(p.id, g);
  }
  return { gid, groups };
}

function buildLayout(focusId) {
  // ---------- 표시 대상: 친족 2단계 필터 + 촌수 제한 ----------
  const { vis: visAll, anchors } = visibleSet(focusId);
  let people = S.db.people.filter(p => visAll.has(p.id));
  if (S.maxChon >= 0) {
    const { dist } = chonKinship(focusId);
    people = people.filter(p => dist.get(p.id) <= S.maxChon);
  }
  const vis = new Set(people.map(p => p.id));
  const fPer = S.byId[focusId];

  // ---------- 세대(rank): 배우자·형제 0, 부모 -1, 자식 +1 ----------
  const rankOf = new Map();
  const assignRank = (startId, r0) => {
    rankOf.set(startId, r0);
    const q = [startId];
    while (q.length) {
      const id = q.shift();
      const r = rankOf.get(id), p = S.byId[id];
      const push = (nid, nr) => {
        if (nid && vis.has(nid) && !rankOf.has(nid)) { rankOf.set(nid, nr); q.push(nid); }
      };
      push(p.father, r - 1);
      push(p.mother, r - 1);
      for (const c of childrenOf(id)) push(c.id, r + 1);
      for (const s of allSpouses(p)) push(s.id, r);
      for (const s of siblingsOf(p)) push(s.id, r);
    }
  };
  assignRank(focusId, 0);
  for (const p of people) if (!rankOf.has(p.id)) assignRank(p.id, 0);

  // ---------- 블록: 혈족(닻) 1명 + 말단 배우자들 — 남자들 먼저(남남여) ----------
  const { gid, groups } = buildBlocks(people, vis, anchors);
  for (const g of groups) g.rank = rankOf.get(g.anchor.id);
  const SIB_GAP = 10, GROUP_GAP = 44;
  const gW = g => g.members.reduce((s, m) => s + nodeW(m), 0) +
    (g.members.length - 1) * SIB_GAP;
  const memberOff = (g, id) => {  // 블록 중심 기준 구성원 중심 오프셋
    let ax = -gW(g) / 2;
    for (const m of g.members) {
      if (m.id === id) return ax + nodeW(m) / 2;
      ax += nodeW(m) + SIB_GAP;
    }
    return 0;
  };
  const px = id => { const g = gid.get(id); return g.x + memberOff(g, id); };
  // 자식의 부모쌍 키 (보이는 부모만)
  const cKey = c => (c.father && vis.has(c.father) ? c.father : '') + '|' +
    (c.mother && vis.has(c.mother) ? c.mother : '');
  // 이웃 블록 간격 위계: 부부(닻끼리 혼인) 10 < 형제(부모 공유) 18 < 무관 44
  const RUN_GAP = 18;
  const isCoupleB = (a, b) => allSpouses(a.anchor).some(s => s.id === b.anchor.id);
  const sameRun = (a, b) =>
    (a.anchor.father && a.anchor.father === b.anchor.father) ||
    (a.anchor.mother && a.anchor.mother === b.anchor.mother);
  const gapOf = (a, b) => isCoupleB(a, b) ? SIB_GAP : sameRun(a, b) ? RUN_GAP : GROUP_GAP;

  const rows = new Map();
  for (const g of groups) {
    if (!rows.has(g.rank)) rows.set(g.rank, []);
    rows.get(g.rank).push(g);
  }
  const rankList = [...rows.keys()].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);

  // ---------- 1단계: 행 순서 — 계보 구간 키 캐스케이드 ----------
  // 계보(포커스·배우자와 그 조상)에게 구간 이분 키를 준다: 포커스 클랜 (0,1),
  // n번째 배우자 클랜 (n, n+1); 아버지 = 구간 왼쪽 절반, 어머니 = 오른쪽 절반.
  // 그 뒤 위 세대부터 부부 단위로 자식 블록을 다음 행에 흘려보낸다. 자식 정렬값
  // = 부모 블록 정렬값 평균 + 배지 순서 — 형제는 배지 순으로 연달아 붙고(사이에
  // 각자의 말단 배우자), 사촌 무리는 제 부모 아래, 이복 형제는 제 부모쌍 밑으로.
  const keyNum = new Map();
  const seedLineage = (rootId, base) => {
    const walk = (id, lo, hi) => {
      if (keyNum.has(id)) return;
      keyNum.set(id, (lo + hi) / 2);
      const p = S.byId[id];
      if (p.father && vis.has(p.father)) walk(p.father, lo, (lo + hi) / 2);
      if (p.mother && vis.has(p.mother)) walk(p.mother, (lo + hi) / 2, hi);
    };
    walk(rootId, base, base + 1);
  };
  seedLineage(focusId, 0);
  const spIds = [];  // 포커스의 배우자 중 자기 블록(닻)을 가진 사람
  for (const sp of allSpouses(fPer)) {
    if (vis.has(sp.id) && anchors.has(sp.id)) spIds.push(sp.id);
  }
  {  // 남편 클랜은 왼쪽(-), 아내 클랜은 오른쪽(+) — 남편-왼쪽 규칙의 클랜 버전
    let nl = 0, nr = 0;
    for (const sid of spIds) {
      seedLineage(sid, S.byId[sid].gender !== 'F' ? -(++nl) : (nr++) + 1);
    }
  }

  // 정렬키 = 계층 배열(사전식 비교): 꼭대기는 [계보 키], 자식 무리는
  // "혈족 쪽 부모(부 우선)의 키" + [배우자 순번, 몇째]를 이어붙인다.
  // → 사촌 무리들이 부모의 형제 순서 그대로 늘어선다 (부모 평균을 쓰면
  //   양가 혈족 부부의 자식이 안사돈 쪽으로 끌려가 손위 무리를 역전함).
  const sortVal = new Map();  // 블록 id -> 계층 정렬키 (숫자 배열)
  let tie = 0;
  const apexVal = g => [keyNum.get(g.anchor.id) ?? 1e6 + (tie++)];
  const cmpKey = (a, b) => {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return a.length - b.length;
  };
  const ranksAsc = [...rows.keys()].sort((a, b) => a - b);
  for (const r of ranksAsc) {
    const rowB = rows.get(r);
    for (const g of rowB) {  // 씨앗: 보이는 부모가 없는 블록 (계보 꼭대기 등)
      if (!sortVal.has(g.id)) sortVal.set(g.id, apexVal(g));
    }
    rowB.sort((a, b) => cmpKey(sortVal.get(a.id), sortVal.get(b.id)));
    const emit = new Map();  // 부모쌍 키 -> (자식 id -> 자식)
    for (const g of rowB) {
      for (const m of g.members) {
        for (const c of childrenOf(m.id)) {
          if (!vis.has(c.id)) continue;
          const k = cKey(c);
          if (!emit.has(k)) emit.set(k, new Map());
          emit.get(k).set(c.id, c);
        }
      }
    }
    for (const [k, cm] of emit) {
      const [fid, mid] = k.split('|');
      const pid = fid && anchors.has(fid) ? fid
        : (mid && anchors.has(mid) ? mid : (fid || mid));
      const pB = pid ? gid.get(pid) : null;
      const base = pB ? sortVal.get(pB.id) : null;
      if (!base) continue;
      const otherId = pid === fid ? mid : fid;
      let spIdx = 0;
      if (otherId) {
        spIdx = allSpouses(S.byId[pid]).findIndex(s => s.id === otherId);
        if (spIdx < 0) spIdx = 0;
      }
      const cs = [...cm.values()].sort((a, b) => order(a) - order(b));
      cs.forEach((c, i) => {
        const cg = gid.get(c.id);
        if (cg && cg.anchor.id === c.id && !sortVal.has(cg.id)) {
          sortVal.set(cg.id, [...base, spIdx, i]);
        }
      });
    }
  }
  for (const r of ranksAsc) {
    rows.get(r).sort((a, b) =>
      cmpKey(sortVal.get(a.id) || [1e6 + (tie++)], sortVal.get(b.id) || [1e6 + (tie++)]));
  }

  // ---------- 2단계: 우선순위 고정 배치 ----------
  // 중앙(계보)부터 동결. 조상 부부쌍은 자식 형제단 스팬의 중점 위에 대칭 배치 —
  // 부부 사이에 낄 형제 블록 폭은 미리 예약하고, 같은 행의 이웃 사슬과 충돌하면
  // 두 사슬이 아래에서 만나는 접합 부부의 간격을 벌려(extraPair) 다시 패스한다.
  {
    const frozen = new Set();
    const rowIdx = new Map();
    for (const r of rankList) rows.get(r).forEach((g, i) => rowIdx.set(g.id, i));
    const resetX = () => {
      frozen.clear();
      for (const r of rankList) {
        let cx = 0;
        const row = rows.get(r);
        row.forEach((g, i) => {
          if (i > 0) cx += gapOf(row[i - 1], g);
          g.x = cx + gW(g) / 2;
          cx += gW(g);
        });
      }
    };
    const boundsFor = g => {  // 동결된 가장 가까운 이웃까지 (사이 미고정 폭·간격 예약)
      const row = rows.get(g.rank), i = rowIdx.get(g.id);
      let lo = -Infinity, hi = Infinity;
      for (let j = i - 1; j >= 0; j--) {
        if (!frozen.has(row[j].id)) continue;
        lo = row[j].x + gW(row[j]) / 2 + gW(g) / 2;
        for (let k = j; k < i; k++) lo += gapOf(row[k], row[k + 1]);
        for (let k = j + 1; k < i; k++) lo += gW(row[k]);
        break;
      }
      for (let j = i + 1; j < row.length; j++) {
        if (!frozen.has(row[j].id)) continue;
        hi = row[j].x - gW(row[j]) / 2 - gW(g) / 2;
        for (let k = i; k < j; k++) hi -= gapOf(row[k], row[k + 1]);
        for (let k = i + 1; k < j; k++) hi -= gW(row[k]);
        break;
      }
      return [lo, hi];
    };
    const put = (g, desired) => {
      if (frozen.has(g.id)) return;
      const [lo, hi] = boundsFor(g);
      g.x = Math.max(lo, Math.min(hi, desired ?? g.x));
      frozen.add(g.id);
    };
    // 두 부모의 레일 세로선 x (렌더의 midX와 같은 공식) — 동결된 부모만 신뢰
    const railMid = (faId, moId) => {
      const ids = [faId, moId].filter(id => id && gid.has(id) && frozen.has(gid.get(id).id));
      if (!ids.length) return null;
      if (ids.length === 1) return px(ids[0]);
      const [a, b] = ids.map(id => ({ x: px(id), w: nodeW(S.byId[id]) }));
      const adj = Math.abs(a.x - b.x) - (a.w + b.w) / 2 <= GROUP_GAP + 2;
      if (!adj) return (a.x + b.x) / 2;
      const [l, r2] = a.x < b.x ? [a, b] : [b, a];
      return ((l.x + l.w / 2) + (r2.x - r2.w / 2)) / 2;
    };
    const spouseMid = g => {
      const ms = [];
      for (const m of g.members) {
        for (const s of allSpouses(m)) {
          const sg = gid.get(s.id);
          if (sg && sg !== g && frozen.has(sg.id)) ms.push(sg.x);
        }
      }
      return ms.length ? ms.reduce((a, b) => a + b) / ms.length : null;
    };
    // 같은 부모쌍 형제(닻) 블록들, 행 순서대로. 부모가 없으면 자기 혼자.
    const runOf = p => {
      const k = cKey(p);
      const bs = k === '|' ? [gid.get(p.id)]
        : [...new Set(people.filter(c => anchors.has(c.id) && cKey(c) === k)
          .map(c => gid.get(c.id)))];
      return bs.sort((a, b) => rowIdx.get(a.id) - rowIdx.get(b.id));
    };
    // 형제단 세그먼트 배치: 일부가 이미 고정이면(계보 인물) 그 양옆에 압축,
    // 아니면 통째로 목표 중점에 — 동결 이웃까지 (사이 폭 예약) 한계 안에서.
    const segPlace = (blocks, target) => {
      if (!blocks.length) return;
      const fi = blocks.findIndex(g => frozen.has(g.id));
      if (fi >= 0) {
        for (let i = fi + 1; i < blocks.length; i++) {
          const g = blocks[i], L = blocks[i - 1];
          put(g, L.x + gW(L) / 2 + gapOf(L, g) + gW(g) / 2);
        }
        for (let i = fi - 1; i >= 0; i--) {
          const g = blocks[i], R = blocks[i + 1];
          put(g, R.x - gW(R) / 2 - gapOf(g, R) - gW(g) / 2);
        }
        return;
      }
      const i0 = rowIdx.get(blocks[0].id);
      if (!blocks.every((g, i) => rowIdx.get(g.id) === i0 + i)) {
        for (const g of blocks) put(g, target);  // 행에서 끊긴 형제단은 낱개로
        return;
      }
      let cx = 0;
      const rel = new Map();
      blocks.forEach((g, i) => {
        if (i > 0) cx += gapOf(blocks[i - 1], g);
        rel.set(g.id, cx + gW(g) / 2);
        cx += gW(g);
      });
      const W = cx;
      const first = blocks[0], last = blocks[blocks.length - 1];
      let T = (target ?? first.x + W / 2 - gW(first) / 2) - W / 2;
      const [lo1] = boundsFor(first);
      const [, hi2] = boundsFor(last);
      T = Math.min(T, hi2 - rel.get(last.id));
      T = Math.max(T, lo1 - rel.get(first.id));
      for (const g of blocks) { g.x = T + rel.get(g.id); frozen.add(g.id); }
    };

    // 계보 부부 사다리 (아래 레벨 → 위 레벨)
    const lineChild = new Map();  // 계보 인물 -> 그 사람의 계보 자식
    const pairLevels = [];
    {
      let level = [focusId, ...spIds];
      const seen = new Set(level);
      while (level.length) {
        const next = [], pl = [];
        for (const cid of level) {
          const c = S.byId[cid];
          const fa = c.father && vis.has(c.father) ? c.father : null;
          const mo = c.mother && vis.has(c.mother) ? c.mother : null;
          if (!fa && !mo) continue;
          pl.push({ fa, mo, child: cid });
          for (const pid of [fa, mo]) {
            if (pid && !seen.has(pid)) { seen.add(pid); lineChild.set(pid, cid); next.push(pid); }
          }
        }
        if (pl.length) pairLevels.push(pl);
        level = next;
      }
    }
    const pKey = (a, b) => [a, b].sort().join('&');
    const junctionOf = (c1, c2) => {  // 두 계보 사슬이 아래에서 만나는 접합 부부
      const down = id => {
        const path = [id];
        while (lineChild.has(id)) { id = lineChild.get(id); path.push(id); }
        return path;
      };
      const p1 = down(c1), p2 = down(c2);
      for (const a of p1) {
        const sps = new Set(allSpouses(S.byId[a]).map(s => s.id));
        for (const b of p2) if (sps.has(b)) return [a, b];
      }
      return null;
    };
    const extraPair = new Map();  // 접합 부부 pKey -> 추가 벌림 (부부 중점 보존)
    const fB = gid.get(focusId);
    const sBs = [];
    for (const sid of spIds) {
      const b = gid.get(sid);
      if (b && b !== fB && !sBs.includes(b)) sBs.push(b);
    }

    let again = true;
    for (let pass = 0; pass < 4 && again; pass++) {
      again = false;
      resetX();
      // 0층: 포커스·배우자 블록 (접합 벌림 반영) + 각자의 형제단 압축
      let eL = 0, eR = 0;
      for (const b of sBs) {
        const e = extraPair.get(pKey(focusId, b.anchor.id)) || 0;
        if (keyNum.get(b.anchor.id) < 0) eL = Math.max(eL, e);
        else eR = Math.max(eR, e);
      }
      put(fB, (eL - eR) / 2);
      for (const b of sBs) {
        const d = gW(fB) / 2 + gapOf(fB, b) + gW(b) / 2;
        put(b, keyNum.get(b.anchor.id) < 0
          ? fB.x - d - eL
          : fB.x + d + eR);
      }
      segPlace(runOf(fPer), null);
      for (const b of sBs) segPlace(runOf(b.anchor), null);
      // 조상 레벨: 부부쌍 대칭 배치 → 그 부모들 자신의 형제단 압축
      const lastIn = new Map();  // rank -> {right, child, lastB}
      for (const pl of pairLevels) {
        const ordered = pl.slice().sort((a, b) =>
          rowIdx.get(gid.get(a.fa || a.mo).id) - rowIdx.get(gid.get(b.fa || b.mo).id));
        for (const pr of ordered) {
          const run = runOf(S.byId[pr.child]).filter(g => frozen.has(g.id));
          if (!run.length) continue;
          let lo = Infinity, hi = -Infinity;
          for (const b of run) {
            lo = Math.min(lo, b.x - gW(b) / 2);
            hi = Math.max(hi, b.x + gW(b) / 2);
          }
          const M = (lo + hi) / 2;  // 자식 형제단 스팬 중점 = 레일 세로선 목표
          const faB = pr.fa ? gid.get(pr.fa) : null;
          const moB = pr.mo ? gid.get(pr.mo) : null;
          let L = faB, R = moB, xL, xR;
          if (L && R && L !== R) {
            if (rowIdx.get(L.id) > rowIdx.get(R.id)) [L, R] = [R, L];
            if (frozen.has(L.id) || frozen.has(R.id)) {  // 계보 겹침(드묾): 남은 쪽만
              const anchorB = frozen.has(L.id) ? L : R;
              const other = anchorB === L ? R : L;
              put(other, 2 * M - anchorB.x);
              continue;
            }
            const row = rows.get(L.rank);
            const iL = rowIdx.get(L.id), iR = rowIdx.get(R.id);
            let innerW = 0, gaps = 0;
            for (let k = iL + 1; k < iR; k++) innerW += gW(row[k]);
            for (let k = iL; k < iR; k++) gaps += gapOf(row[k], row[k + 1]);
            const cnt = iR - iL - 1;
            const extra = extraPair.get(pKey(pr.fa, pr.mo)) || 0;
            if (!cnt && !extra) {  // 인접 부부: 사이 간격의 중점 = M (레일 공식 일치)
              xL = M - gaps / 2 - gW(L) / 2;
              xR = M + gaps / 2 + gW(R) / 2;
            } else {  // 떨어짐: 두 중심의 평균 = M (레일 공식 일치)
              const D = gW(L) / 2 + gaps + innerW + gW(R) / 2 + extra;
              xL = M - D / 2;
              xR = M + D / 2;
            }
          } else {  // 부모가 하나(또는 같은 블록)
            const b2 = L || R;
            if (!b2 || frozen.has(b2.id)) continue;
            L = R = b2;
            const off = pr.fa && pr.mo
              ? (memberOff(b2, pr.fa) + memberOff(b2, pr.mo)) / 2
              : memberOff(b2, pr.fa || pr.mo);
            xL = xR = M - off;
          }
          // 왼쪽 이웃 사슬과 충돌: 접합 부부를 벌려 다음 패스에서 자리 확보
          const prev = lastIn.get(L.rank);
          if (prev) {
            const row = rows.get(L.rank);
            const i0 = rowIdx.get(prev.lastB.id), i1 = rowIdx.get(L.id);
            let lim = prev.right + gW(L) / 2;
            for (let k = i0; k < i1; k++) lim += gapOf(row[k], row[k + 1]);
            for (let k = i0 + 1; k < i1; k++) lim += gW(row[k]);
            if (xL < lim - 0.5) {
              const need = lim - xL;
              const j = junctionOf(prev.child, pr.child);
              if (j && pass < 3) {
                const jk = pKey(j[0], j[1]);
                extraPair.set(jk, (extraPair.get(jk) || 0) + need);
                again = true;
              }
              xL += need;
              xR += need;
            }
          }
          L.x = xL;
          frozen.add(L.id);
          if (R !== L) { R.x = xR; frozen.add(R.id); }
          lastIn.set(L.rank, { right: xR + gW(R) / 2, child: pr.child, lastB: R });
        }
        for (const pr of ordered) {
          for (const pid of [pr.fa, pr.mo]) {
            if (pid && anchors.has(pid)) segPlace(runOf(S.byId[pid]), null);
          }
        }
      }
    }
    // 파도: 중앙에서 바깥으로, 부부 단위 자식 형제단을 레일 중점 아래에 배치
    const bfsQ = [];
    const qd = new Set();
    const pushQ = g => { if (g && !qd.has(g.id)) { qd.add(g.id); bfsQ.push(g); } };
    groups.filter(g => frozen.has(g.id))
      .sort((a, b) => Math.abs(a.rank) - Math.abs(b.rank) || Math.abs(a.x) - Math.abs(b.x))
      .forEach(pushQ);
    const doneCouple = new Set();
    while (bfsQ.length) {
      const A = bfsQ.shift();
      for (const m of A.members) {
        for (const c of childrenOf(m.id)) {
          if (!vis.has(c.id) || !anchors.has(c.id)) continue;
          const k = cKey(c);
          if (doneCouple.has(k)) continue;
          doneCouple.add(k);
          const [f2, m2] = k.split('|');
          const run = runOf(c);
          segPlace(run, railMid(f2 || null, m2 || null));
          run.forEach(pushQ);
        }
      }
    }
    for (const r of rankList) {  // 잔여 (연결 없는 블록)
      for (const g of rows.get(r)) if (!frozen.has(g.id)) put(g, spouseMid(g));
    }
  }
  // ---------- 노드 생성 (포커스 x=0) ----------
  const nodes = [], nodeOfId = new Map();
  for (const g of groups) {
    let ax = g.x - gW(g) / 2;
    for (const m of g.members) {
      const w = nodeW(m);
      const n = { p: m, x: ax + w / 2, y: g.rank * ROW_H, w, rank: g.rank };
      nodes.push(n);
      nodeOfId.set(m.id, n);
      ax += w + SIB_GAP;
    }
  }
  {
    const fN = nodeOfId.get(focusId);
    if (fN) { const dx = -fN.x; nodes.forEach(n => { n.x += dx; }); }
  }

  // ---------- 연결선: [부모 가로선] → 가운데 짧은 세로선 → [자식 버스] ----------
  const lines = [], dots = [];
  const pairs = new Map();
  for (const c of people) {
    if (!nodeOfId.has(c.id)) continue;
    const f = c.father && nodeOfId.has(c.father) ? c.father : '';
    const m = c.mother && nodeOfId.has(c.mother) ? c.mother : '';
    if (!f && !m) continue;
    const k = f + '|' + m;
    if (!pairs.has(k)) pairs.set(k, []);
    pairs.get(k).push(c);
  }
  for (const p of people) {  // 자식 없는 부부도 혼인선 대상으로
    for (const s of allSpouses(p)) {
      if (!vis.has(s.id)) continue;
      const [a, b] = p.gender !== 'F' ? [p.id, s.id] : [s.id, p.id];
      if (!pairs.has(a + '|' + b) && !pairs.has(b + '|' + a)) pairs.set(a + '|' + b, []);
    }
  }
  const rails = [], coupleLines = [];
  for (const [k, cs] of pairs) {
    const pNodes = k.split('|').filter(Boolean).map(id => nodeOfId.get(id)).filter(Boolean);
    if (!pNodes.length) continue;
    const cNodes = cs.map(c => nodeOfId.get(c.id)).filter(Boolean);
    const [a, b] = pNodes;
    const coupleAdj = pNodes.length === 2 && a.y === b.y
      && Math.abs(a.x - b.x) - (a.w + b.w) / 2 <= GROUP_GAP + 2;
    if (coupleAdj) coupleLines.push([a, b]);  // 혼인선은 y 확정 후에 그린다
    const midX = pNodes.length === 2
      ? (coupleAdj
        ? ((a.x < b.x ? a.x + a.w / 2 : b.x + b.w / 2) + (a.x < b.x ? b.x - b.w / 2 : a.x - a.w / 2)) / 2
        : (a.x + b.x) / 2)
      : pNodes[0].x;
    if (!cNodes.length && coupleAdj) continue;
    const gapRank = cNodes.length
      ? Math.min(...cNodes.map(n => n.rank))
      : pNodes[0].rank + 1;
    rails.push({ gapRank, pNodes, cNodes, coupleAdj, midX });
  }
  const byGap = new Map();
  for (const rl of rails) {
    const xs = [...rl.pNodes.map(n => n.x), rl.midX, ...rl.cNodes.map(n => n.x)];
    rl.x1 = Math.min(...xs);
    rl.x2 = Math.max(...xs);
    if (!byGap.has(rl.gapRank)) byGap.set(rl.gapRank, []);
    byGap.get(rl.gapRank).push(rl);
  }
  for (const arr of byGap.values()) {  // 레인 배정 (부모선+버스 두 층)
    arr.sort((a, b) => a.x1 - b.x1);
    const laneEnd = [];
    for (const rl of arr) {
      let lane = laneEnd.findIndex(end => end + 16 <= rl.x1);
      if (lane === -1) { lane = laneEnd.length; laneEnd.push(rl.x2); }
      else laneEnd[lane] = rl.x2;
      rl.lane = lane;
    }
  }
  // 세대 간 y 간격을 그 사이 레인 수에 맞춰 동적으로 벌린다
  {
    const laneCount = new Map();
    for (const rl of rails) {
      laneCount.set(rl.gapRank, Math.max(laneCount.get(rl.gapRank) || 0, rl.lane + 1));
    }
    const ranksAsc = [...new Set(nodes.map(n => n.rank))].sort((a, b) => a - b);
    const gapH = r => 16 + (laneCount.get(r) || 1) * 22 + 18;
    const rowY = new Map();
    let y = 0;
    for (let i = 0; i < ranksAsc.length; i++) {
      if (i > 0) y += NODE_H + gapH(ranksAsc[i]);
      rowY.set(ranksAsc[i], y);
    }
    for (const n of nodes) n.y = rowY.get(n.rank);
    for (const rl of rails) {
      const base = rowY.has(rl.gapRank)
        ? rowY.get(rl.gapRank) - gapH(rl.gapRank)
        : Math.max(...nodes.filter(n => n.rank === rl.gapRank - 1).map(n => n.y)) + NODE_H;
      rl.y = base + 12 + rl.lane * 22;
      rl.busY = rl.y + 10;
    }
  }
  for (const [a, b] of coupleLines) {  // 인접 부부 혼인선
    const [l, rgt] = a.x < b.x ? [a, b] : [b, a];
    lines.push([l.x + l.w / 2, l.y + NODE_H / 2, rgt.x - rgt.w / 2, rgt.y + NODE_H / 2]);
  }
  for (const rl of rails) {
    const dotAt = (x, y, lo, hi) => { if (x > lo + 1 && x < hi - 1) dots.push([x, y]); };
    if (rl.coupleAdj) {  // 부부선 가운데에서 짧은 세로선이 버스로
      if (rl.cNodes.length) {
        lines.push([rl.midX, rl.pNodes[0].y + NODE_H / 2, rl.midX, rl.busY]);
      }
    } else {  // 떨어진 부모: stub → 부모 가로선 → 가운데 짧은 세로선
      const pxs = [...rl.pNodes.map(n => n.x), rl.midX];
      const p1 = Math.min(...pxs), p2 = Math.max(...pxs);
      if (p2 - p1 >= 2) lines.push([p1, rl.y, p2, rl.y]);
      for (const n of rl.pNodes) {
        lines.push([n.x, n.y + NODE_H, n.x, rl.y]);
        dotAt(n.x, rl.y, p1, p2);
      }
      if (rl.cNodes.length) lines.push([rl.midX, rl.y, rl.midX, rl.busY]);
    }
    if (!rl.cNodes.length) continue;
    const bxs = [rl.midX, ...rl.cNodes.map(n => n.x)];
    const b1 = Math.min(...bxs), b2 = Math.max(...bxs);
    if (b2 - b1 >= 2) lines.push([b1, rl.busY, b2, rl.busY]);
    dotAt(rl.midX, rl.busY, b1, b2);
    for (const n of rl.cNodes) {
      lines.push([n.x, rl.busY, n.x, n.y]);
      dotAt(n.x, rl.busY, b1, b2);
    }
  }
  return { nodes, lines, arcs: [], dots };
}

// ---------- 촌수 계산 ----------
// 배우자 0촌, 부모-자식 1촌 가중치의 최단거리 = 촌수 (형제 2촌, 사촌 4촌).
// 규모가 작으므로 벨만-포드식 반복으로 충분하다.
function chonKinship(focusId) {
  const dist = new Map(S.db.people.map(p => [p.id, Infinity]));
  dist.set(focusId, 0);
  const edges = [];
  for (const p of S.db.people) {
    for (const pid of [p.father, p.mother]) {
      if (pid && S.byId[pid]) edges.push([p.id, pid, 1]);
    }
    for (const s of allSpouses(p)) edges.push([p.id, s.id, 0]);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const [a, b, w] of edges) {
      if (dist.get(a) + w < dist.get(b)) { dist.set(b, dist.get(a) + w); changed = true; }
      else if (dist.get(b) + w < dist.get(a)) { dist.set(a, dist.get(b) + w); changed = true; }
    }
  }
  return { dist, edges };
}

// ---------- 촌수 레이아웃 (v2: 부 9시·모 3시 완전 고정 부채꼴) ----------
// 가계도 뷰의 원칙을 방사형에 그대로 적용한다: 같은 2단계 친족 필터, 같은
// 블록(혈족 1명 + 말단 배우자 인라인), 부모 각도 상속(가족 부채꼴), 손위 왼쪽.
// 화면 각도: 0=3시, 90°=6시(아래), 180°=9시, 270°=12시.
// · 계보 조상 = 부채꼴 이분 상속: 아버지는 부모의 광선을 그대로 물려받아
//   직계 부계가 일직선이 되고(부 9시 광선, 모의 부계 3시 광선),
//   어머니는 구간의 남은 절반으로 갈라진다 → 친가 조상 좌상단, 외가 우상단.
// · 아래 반원 = 본인 계열: 형제·자손 6시, 배우자 클랜은 미러 규칙으로
//   아내 오른쪽-아래(장인 75°·장모 45°), 남편 왼쪽-아래(시부 105°·시모 135°).
// · 비계보 무리는 부모의 각도를 물려받아 같은 방향 바깥 링으로.
// · 링 안에서는 각도 순 정렬 + 최소 간격 확보 — 부·모 블록은 핀(벽)이라
//   절대 밀리지 않고, 나머지가 그 사이 구간 안에서만 움직인다.
function buildChonLayout(focusId) {
  const { dist, edges } = chonKinship(focusId);
  const { vis: visAll, anchors } = visibleSet(focusId);
  let people = S.db.people.filter(p => visAll.has(p.id));
  if (S.maxChon >= 0) people = people.filter(p => dist.get(p.id) <= S.maxChon);
  const vis = new Set(people.map(p => p.id));
  const fp = S.byId[focusId];
  const { gid, groups } = buildBlocks(people, vis, anchors);
  const gWb = g => g.members.reduce((s, m) => s + nodeW(m), 0) +
    (g.members.length - 1) * COUPLE_GAP;

  const nodes = [];
  const putN = (p, cx, cy) => nodes.push({ p, x: cx, y: cy - NODE_H / 2, w: nodeW(p) });

  // 0촌: 포커스(중앙)와 배우자 — 0촌 블록의 말단 동배우자까지 한 줄로
  putN(fp, 0, 0);
  const fpSps = allSpouses(fp).filter(s => vis.has(s.id));
  const ring0 = new Set([focusId]);
  let right = nodeW(fp) / 2;
  const addRow = p => {
    putN(p, right + COUPLE_GAP + nodeW(p) / 2, 0);
    right += COUPLE_GAP + nodeW(p);
    ring0.add(p.id);
  };
  for (const m of gid.get(focusId).members) if (!ring0.has(m.id)) addRow(m);
  for (const sp of fpSps) {
    for (const m of gid.get(sp.id).members) if (!ring0.has(m.id)) addRow(m);
  }

  // 목표 각도 뼈대
  const D = d => d * Math.PI / 180;
  const target = new Map();   // personId -> 라디안
  // 계보 조상 부채꼴 이분: atHi=true(모계식)는 광선이 hi 쪽, false(부계식)는 lo 쪽
  const anc = (id, lo, hi, atHi) => {
    if (!id || !vis.has(id) || target.has(id)) return;
    target.set(id, atHi ? hi : lo);
    const p = S.byId[id];
    const mid = (lo + hi) / 2;
    if (atHi) {
      anc(p.father, mid, hi, true);   // 아버지: 광선 유지
      anc(p.mother, lo, mid, true);   // 어머니: 절반 갈라짐
    } else {
      anc(p.father, lo, mid, false);
      anc(p.mother, mid, hi, false);
    }
  };
  const pinIds = [];
  if (fp.father && vis.has(fp.father)) { anc(fp.father, D(180), D(270), false); pinIds.push(fp.father); }
  if (fp.mother && vis.has(fp.mother)) { anc(fp.mother, D(270), D(360), true); pinIds.push(fp.mother); }
  for (const sp of fpSps) {  // 배우자 클랜: 아내 우하단 / 남편 좌하단 미러
    if (sp.gender === 'F') {
      anc(sp.father, D(45), D(75), true);
      anc(sp.mother, D(15), D(45), true);
    } else {
      anc(sp.father, D(105), D(135), false);
      anc(sp.mother, D(135), D(165), false);
    }
  }
  const pinned = new Set(pinIds.map(id => gid.get(id).id));

  // 링 구성 (블록 단위 — 말단 배우자는 닻과 같은 링에 인라인)
  const ringsOf = new Map();
  for (const g of groups) {
    if (ring0.has(g.anchor.id)) continue;
    const k = dist.get(g.anchor.id);
    if (!isFinite(k) || k === 0) continue;
    if (!ringsOf.has(k)) ringsOf.set(k, []);
    ringsOf.get(k).push(g);
  }

  const RING = 150;
  const rings = [];
  let prevR = 0;
  const angleOf = new Map();  // 배치된 인물 각도 (안쪽 링 상속용)
  // 도메인 [-90°, 270°) — 이음새는 인구가 가장 적은 12시
  const norm = a => {
    a = a % (2 * Math.PI);
    while (a < D(-90)) a += 2 * Math.PI;
    while (a >= D(270)) a -= 2 * Math.PI;
    return a;
  };
  const cmean = angs => {
    const x = angs.reduce((s, a) => s + Math.cos(a), 0);
    const y = angs.reduce((s, a) => s + Math.sin(a), 0);
    return (Math.abs(x) + Math.abs(y) < 1e-9) ? D(90) : Math.atan2(y, x);
  };
  for (const [k, gs] of [...ringsOf.entries()].sort((a, b) => a[0] - b[0])) {
    const items = gs.map(g => {
      const a = g.anchor;
      let th;
      if (target.has(a.id)) th = target.get(a.id);
      else if (a.father === focusId || a.mother === focusId
        || (fp.father && a.father === fp.father && fp.mother && a.mother === fp.mother)) {
        th = D(90);  // 본인의 자녀와 친형제: 정확히 아래
      } else {
        const rel = [a.father, a.mother].filter(id => id && angleOf.has(id));
        if (!rel.length) {
          rel.push(...[...allSpouses(a).map(s => s.id),
                       ...childrenOf(a.id).map(c => c.id)].filter(id => angleOf.has(id)));
        }
        th = rel.length ? cmean(rel.map(id => angleOf.get(id))) : D(90);
      }
      // 닻이 광선 위에 오도록 밀리는 만큼, 각도 점유폭이 위/아래 비대칭이 된다:
      // 접선 +방향은 각도 감소 방향이므로 dLo(작은 각 쪽)/dHi(큰 각 쪽)로 나눔
      let ax = -gWb(g) / 2, aOff = 0;
      for (const m of g.members) {
        if (m.id === g.anchor.id) aOff = ax + nodeW(m) / 2;
        ax += nodeW(m) + COUPLE_GAP;
      }
      return { g, th: norm(th), w: gWb(g), aOff, pin: pinned.has(g.id) };
    });
    // 각도 순 정렬 (동률은 손위가 큰 각도 = 아래 반원에서 왼쪽)
    items.sort((x, y) => x.th - y.th || order(y.g.anchor) - order(x.g.anchor));
    const idxPins = items.map((it, i) => it.pin ? i : -1).filter(i => i >= 0);
    // 반지름: 기본 간격 + 전체 둘레 + "핀 사이 구간별" 소요량 (핀은 못 움직이므로
    // 구간이 과밀하면 그만큼 링을 키워야 핀 밖으로 밀려나지 않는다)
    const total = items.reduce((s, it) => s + it.w + 26, 0);
    let segNeed = 0;
    for (let s = 0; s <= idxPins.length; s++) {
      const i0 = s === 0 ? 0 : idxPins[s - 1] + 1;
      const i1 = s === idxPins.length ? items.length - 1 : idxPins[s] - 1;
      if (i0 > i1) continue;
      let need = 0;
      for (let i = i0; i <= i1; i++) need += items[i].w + 26;
      const loA = s === 0 ? D(-89)
        : items[idxPins[s - 1]].th + 0;  // 핀 가장자리 폭은 아래에서 px로 더함
      const hiA = s === idxPins.length ? D(269) : items[idxPins[s]].th;
      if (s > 0) need += items[idxPins[s - 1]].w / 2 + items[idxPins[s - 1]].aOff + 13;
      if (s < idxPins.length) need += items[idxPins[s]].w / 2 - items[idxPins[s]].aOff + 13;
      segNeed = Math.max(segNeed, need / Math.max(0.2, hiA - loA));
    }
    const r = Math.max(prevR + RING * 0.75, k * RING, right + 90,
      total / (2 * Math.PI * 0.85), segNeed);
    prevR = r;
    rings.push({ r, label: k + '촌' });
    const dLo = it => (it.w / 2 - it.aOff + 13) / r;
    const dHi = it => (it.w / 2 + it.aOff + 13) / r;
    // 핀 사이 구간별 최소 간격 (앞→뒤 / 뒤→앞) — 핀은 절대 안 움직임
    for (let s = 0; s <= idxPins.length; s++) {
      const i0 = s === 0 ? 0 : idxPins[s - 1] + 1;
      const i1 = s === idxPins.length ? items.length - 1 : idxPins[s] - 1;
      if (i0 > i1) continue;
      const lo = s === 0 ? D(-89) : items[idxPins[s - 1]].th + dHi(items[idxPins[s - 1]]);
      const hi = s === idxPins.length ? D(269) : items[idxPins[s]].th - dLo(items[idxPins[s]]);
      for (let i = i0; i <= i1; i++) {
        items[i].th = Math.max(items[i].th, i === i0
          ? lo + dLo(items[i])
          : items[i - 1].th + dHi(items[i - 1]) + dLo(items[i]));
      }
      for (let i = i1; i >= i0; i--) {
        items[i].th = Math.min(items[i].th, i === i1
          ? hi - dHi(items[i])
          : items[i + 1].th - dLo(items[i + 1]) - dHi(items[i]));
      }
    }
    for (const it of items) {
      // 블록 구성원은 접선 방향으로 나란히 — 6시에선 가로줄(남편 왼쪽),
      // 3시·9시에선 세로 기둥이 되어 이웃 링을 침범하지 않는다.
      // 닻(혈족)이 정확히 광선 위에 오도록 블록을 접선 방향으로 민다 (핀 보장).
      const cx = r * Math.cos(it.th), cy = r * Math.sin(it.th);
      const tx = Math.sin(it.th), ty = -Math.cos(it.th);
      let ax = -gWb(it.g) / 2;
      for (const m of it.g.members) {
        const o = ax + nodeW(m) / 2 - it.aOff;
        putN(m, cx + tx * o, cy + ty * o);
        angleOf.set(m.id, it.th);
        ax += nodeW(m) + COUPLE_GAP;
      }
    }
  }

  // 관계선 (희미하게): 부부 + 부모-자식
  const posOf = new Map(nodes.map(n => [n.p.id, n]));
  const lines = [], seen = new Set();
  for (const [a, b] of edges) {
    const key = a < b ? a + '|' + b : b + '|' + a;
    if (seen.has(key)) continue;
    seen.add(key);
    const na = posOf.get(a), nb = posOf.get(b);
    if (na && nb) lines.push([na.x, na.y + NODE_H / 2, nb.x, nb.y + NODE_H / 2]);
  }
  return { nodes, lines, rings, dim: true };
}

// 기대 유전자 공유율(coefficient of relationship): 공통 조상을 거쳐
// "올라갔다 내려오는" 경로만 유효 — 최소 공통 조상 a마다 0.5^(내깊이+상대깊이)를 합산.
// 친형제 = 부·모 두 경로 합 50%, 이복/이부 형제 = 한 경로 25%, 배우자·인척 = 0%.
function ancMap(id) {
  const m = new Map([[id, 0]]);
  const q = [id];
  while (q.length) {
    const cur = q.pop();
    const d = m.get(cur);
    const p = S.byId[cur];
    if (!p) continue;
    for (const pid of [p.father, p.mother]) {
      if (pid && S.byId[pid] && (m.get(pid) ?? Infinity) > d + 1) {
        m.set(pid, d + 1);
        q.push(pid);
      }
    }
  }
  return m;
}

function geneShare(focusId) {
  const fAnc = ancMap(focusId);
  const ancCache = new Map();
  const getAnc = id => {
    if (!ancCache.has(id)) ancCache.set(id, ancMap(id));
    return ancCache.get(id);
  };
  const out = new Map();
  for (const p of S.db.people) {
    const xAnc = getAnc(p.id);
    const common = [...fAnc.keys()].filter(a => xAnc.has(a));
    // 다른 공통 조상의 조상인 것은 제외 (경로가 그 후손을 거치므로 중복)
    const minimal = common.filter(a =>
      !common.some(b => b !== a && getAnc(b).has(a)));
    let r = 0;
    for (const a of minimal) r += Math.pow(0.5, fAnc.get(a) + xAnc.get(a));
    out.set(p.id, Math.min(1, r));
  }
  return out;
}

function genePct(r) {
  if (!r) return '0%';
  const v = Math.round(100 * r);
  return v >= 1 ? v + '%' : '<1%';
}

// 포커스 기준 실존하는 최대 촌수
function chonMaxOf(focusId) {
  const { dist } = chonKinship(focusId);
  return Math.max(0, ...[...dist.values()].filter(isFinite));
}

// ---------- 렌더링 ----------
function render() {
  computeNodeSize();
  const geneD = geneShare(S.focusId);
  const chonD = chonKinship(S.focusId).dist;
  // 촌수 스테퍼: 실존 최대값 이상이면 "전체"(-1)로 정규화하고 최대값을 표시
  const mf = chonMaxOf(S.focusId);
  if (S.maxChon >= mf) S.maxChon = -1;
  $('#chonNum').value = S.maxChon < 0 ? mf : S.maxChon;
  const layout = S.chonView ? buildChonLayout(S.focusId) : buildLayout(S.focusId);
  const world = $('#world');
  let svg = '';
  for (const rg of layout.rings || []) {
    svg += `<circle class="ring" r="${rg.r}"/>`
      + `<text class="ringlbl" y="${-rg.r - 8}">${esc(rg.label)}</text>`;
  }
  for (const [x1, y1, x2, y2] of layout.lines) {
    svg += `<line class="edge${layout.dim ? ' dim' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }
  for (const [x1, y1, x2, y2] of layout.arcs || []) {  // 떨어진 배우자 연결
    svg += `<path class="edge" d="M ${x1} ${y1} C ${x1} ${y1 + 20}, ${x2} ${y2 + 20}, ${x2} ${y2}"/>`;
  }
  for (const [x, y] of layout.dots || []) {  // 레일 접점 (교차와 연결 구분)
    svg += `<circle class="dot" cx="${x}" cy="${y}" r="2.4"/>`;
  }
  for (const n of layout.nodes) {
    const p = n.p;
    const g = p.gender === 'M' ? 'm' : p.gender === 'F' ? 'f' : 'u';
    const cls = ['node', g,
      p.id === S.focusId ? 'focus' : '',
      p.id === S.selectedId ? 'selected' : ''].join(' ');
    const pv = privOf(p.id);
    let sub = '';
    if (pv && (pv.birth || pv.death)) {
      const y = d => d ? String(d).slice(0, 4) : '';
      sub = pv.death ? `${y(pv.birth)}–${y(pv.death)}` : y(pv.birth);
    }
    // 형제가 있으면 몇째인지 숫자로 왼쪽 위에 표시
    let ord = '';
    const sibs = siblingsOf(p);
    if (sibs.length) {
      const i = [p, ...sibs].sort((a, b) => order(a) - order(b)).indexOf(p);
      ord = `<text class="ord" x="4.5" y="10.5">${i + 1}</text>`;
    }
    // 포커스 기준 촌수와 기대 유전자 공유율을 오른쪽 위에 작게 표시
    if (p.id !== S.focusId) {
      const cd = chonD.get(p.id);
      const label = (isFinite(cd) ? cd + 'c, ' : '') + genePct(geneD.get(p.id));
      ord += `<text class="gene" x="${n.w - 3}" y="8">${label}</text>`;
    }
    svg += `<g class="${cls}" data-id="${esc(p.id)}" transform="translate(${n.x - n.w / 2},${n.y})">`
      + `<rect width="${n.w}" height="${NODE_H}" rx="8"/>` + ord
      + `<text class="name" x="${n.w / 2}" y="${sub ? 20 : NODE_H / 2 + 6.5}">${esc(p.name)}</text>`
      + (sub ? `<text class="sub" x="${n.w / 2}" y="${NODE_H - 6}">${esc(sub)}</text>` : '')
      + `</g>`;
  }
  world.innerHTML = svg;
  fitView(layout.nodes, layout.rings);
  renderDetail();
}

function fitView(nodes, rings) {
  const svg = $('#tree');
  const W = svg.clientWidth, H = svg.clientHeight;
  let minX = Math.min(...nodes.map(n => n.x - n.w / 2)) - 40;
  let maxX = Math.max(...nodes.map(n => n.x + n.w / 2)) + 40;
  let minY = Math.min(...nodes.map(n => n.y)) - 40;
  let maxY = Math.max(...nodes.map(n => n.y)) + NODE_H + 40;
  if (rings && rings.length) {
    const R = Math.max(...rings.map(r => r.r)) + 60;
    minX = Math.min(minX, -R); maxX = Math.max(maxX, R);
    minY = Math.min(minY, -R); maxY = Math.max(maxY, R);
  }
  const fitK = Math.min(W / (maxX - minX), H / (maxY - minY), 1.1);
  if (fitK >= 0.5) {
    // 전체가 무리 없이 들어가면 전부 보이게
    S.view.k = fitK;
    S.view.x = W / 2 - fitK * (minX + maxX) / 2;
    S.view.y = H / 2 - fitK * (minY + maxY) / 2;
  } else {
    // 너무 커지면 포커스를 중심에 두되, 들어가는 축은 전체를 가운데로
    const f = nodes.find(n => n.p.id === S.focusId) || nodes[0];
    const k = 0.6;
    S.view.k = k;
    S.view.x = (maxX - minX) * k <= W
      ? W / 2 - k * (minX + maxX) / 2 : W / 2 - k * f.x;
    S.view.y = (maxY - minY) * k <= H
      ? H / 2 - k * (minY + maxY) / 2 : H / 2 - k * (f.y + NODE_H / 2);
  }
  applyView();
}

function applyView() {
  $('#world').setAttribute('transform',
    `translate(${S.view.x},${S.view.y}) scale(${S.view.k})`);
}

function setFocus(id) {
  if (!S.byId[id]) return;
  S.focusId = id;
  S.selectedId = id;
  S.maxChon = -1;  // 포커스가 바뀌면 그 사람 기준 전체(실존 최대 촌수)로 리셋
  render();
}

// ---------- 상세 패널 ----------
function relBtns(ids) {
  return ids.filter(id => S.byId[id]).map(id =>
    `<button class="lnk" data-goto="${esc(id)}">${esc(S.byId[id].name)}</button>`
  ).join(' ') || '<span class="dim">—</span>';
}

function renderDetail() {
  const box = $('#detail');
  const p = S.byId[S.selectedId];
  if (!p) { box.innerHTML = ''; return; }
  const kids = childrenOf(p.id);
  const sibs = siblingsOf(p).sort((a, b) => order(a) - order(b));
  const pv = privOf(p.id);
  const gtxt = p.gender === 'M' ? '남' : p.gender === 'F' ? '여' : '-';

  let h = `<h2>${esc(p.name)} <span class="gender ${p.gender === 'M' ? 'm' : 'f'}">${gtxt}</span></h2>`;
  h += `<dl>
    <dt>부</dt><dd>${relBtns([p.father])}</dd>
    <dt>모</dt><dd>${relBtns([p.mother])}</dd>
    <dt>배우자</dt><dd>${relBtns(allSpouses(p).map(s => s.id))}</dd>
    <dt>형제</dt><dd>${relBtns(sibs.map(s => s.id))}</dd>
    <dt>자녀</dt><dd>${relBtns(kids.map(k => k.id))}</dd>`;
  if (pv) {
    if (pv.birth) h += `<dt>출생</dt><dd>${esc(pv.birth)}</dd>`;
    if (pv.death) h += `<dt>사망</dt><dd>${esc(pv.death)}</dd>`;
    if (pv.note) h += `<dt>메모</dt><dd>${esc(pv.note)}</dd>`;
    if (pv.links && pv.links.length) {
      h += `<dt>링크</dt><dd>` + pv.links.map(u =>
        `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`
      ).join('<br>') + `</dd>`;
    }
  } else if (!S.priv) {
    h += `<dt class="dim">비공개</dt><dd class="dim">쓰기 암호 해제 시 표시</dd>`;
  }
  h += `</dl>`;
  if (S.editMode) h += editFormHtml(p, pv) + bulkHtml();
  box.innerHTML = h;
  if (S.editMode) { bindEditForm(p); bindBulk(); }
}

// ---------- 일괄 삭제 ----------
function bulkHtml() {
  const rows = byName(S.db.people).map(p =>
    `<label class="bulk-row"><input type="checkbox" data-bulk="${esc(p.id)}"${
      S.bulkSel.has(p.id) ? ' checked' : ''}> ${esc(p.name)} <span class="dim">${esc(p.id)}</span></label>`
  ).join('');
  return `<details class="bulk"${S.bulkOpen ? ' open' : ''}>
    <summary>일괄 삭제…</summary>${rows}
    <button type="button" id="btnBulkDel" class="danger">선택한 ${S.bulkSel.size}명 삭제</button>
  </details>`;
}

function bindBulk() {
  const bulk = $('#detail .bulk');
  bulk.addEventListener('toggle', () => { S.bulkOpen = bulk.open; });
  bulk.querySelectorAll('[data-bulk]').forEach(cb => cb.addEventListener('change', () => {
    if (cb.checked) S.bulkSel.add(cb.dataset.bulk);
    else S.bulkSel.delete(cb.dataset.bulk);
    $('#btnBulkDel').textContent = `선택한 ${S.bulkSel.size}명 삭제`;
  }));
  $('#btnBulkDel').addEventListener('click', () => {
    const ids = new Set([...S.bulkSel].filter(id => S.byId[id]));
    if (!ids.size) return;
    if (ids.size >= S.db.people.length) { alert('최소 한 명은 남아야 합니다.'); return; }
    const names = S.db.people.filter(p => ids.has(p.id)).map(p => p.name).join(', ');
    if (!confirm(`${ids.size}명을 삭제할까요?\n${names}\n(부모/배우자 참조도 함께 정리됩니다)`)) return;
    S.db.people = S.db.people.filter(p => !ids.has(p.id));
    for (const q of S.db.people) {
      if (ids.has(q.father)) delete q.father;
      if (ids.has(q.mother)) delete q.mother;
      if (q.spouses) {
        q.spouses = q.spouses.filter(id => !ids.has(id));
        if (!q.spouses.length) delete q.spouses;
      }
    }
    for (const id of ids) delete S.priv[id];
    S.bulkSel.clear();
    markDirty();
    setFocus(ids.has(S.focusId) ? S.db.people[0].id : S.focusId);
  });
}

// ---------- 편집 ----------
// 사람 고르는 목록은 이름 순 (people 배열 순서는 형제 순서 전용이라 읽기 어렵다)
const byName = list => [...list].sort((a, b) => a.name.localeCompare(b.name, 'ko'));

function personOptions(selected, excludeId) {
  let h = `<option value="">(없음)</option>`;
  for (const q of byName(S.db.people)) {
    if (q.id === excludeId) continue;
    h += `<option value="${esc(q.id)}"${q.id === selected ? ' selected' : ''}>${esc(q.name)}</option>`;
  }
  return h;
}

function editFormHtml(p, pv) {
  pv = pv || {};
  const sps = allSpouses(p);
  return `<form id="editForm" class="edit">
    <h3>편집</h3>
    <label>이름 <input name="name" value="${esc(p.name)}" required></label>
    <label>성별 <select name="gender">
      <option value="M"${p.gender === 'M' ? ' selected' : ''}>남</option>
      <option value="F"${p.gender === 'F' ? ' selected' : ''}>여</option>
    </select></label>
    <label>부 <span class="pick">
      <select name="father">${personOptions(p.father, p.id)}</select>
      <button type="button" id="btnNewFather" title="새 인물을 만들어 부로 지정">＋새</button>
    </span></label>
    <label>모 <span class="pick">
      <select name="mother">${personOptions(p.mother, p.id)}</select>
      <button type="button" id="btnNewMother" title="새 인물을 만들어 모로 지정">＋새</button>
    </span></label>
    <label>배우자 (순서 = 표시 순서)</label>
    <div class="splist">
      ${sps.map(s => `<div class="sp-row">
        <span>${esc(s.name)}</span>
        <span>
          <button type="button" data-spmove="${esc(s.id)}|-1" title="순서 앞으로">◀</button>
          <button type="button" data-spmove="${esc(s.id)}|1" title="순서 뒤로">▶</button>
          <button type="button" data-spdel="${esc(s.id)}" class="danger" title="배우자 관계 삭제 (공동 자녀가 있으면 유추로 다시 나타남)">×</button>
        </span>
      </div>`).join('')}
      <div class="sp-row">
        <select id="spAddSel">${personOptions('', p.id)}</select>
        <button type="button" id="btnSpAdd">＋ 추가</button>
        <button type="button" id="btnSpNew" title="새 인물을 만들어 배우자로 추가 (자녀의 빈 반대편 부모도 채움)">＋새</button>
      </div>
    </div>
    <label>출생 <input name="birth" value="${esc(pv.birth)}" placeholder="YYYY-MM-DD"></label>
    <label>사망 <input name="death" value="${esc(pv.death)}" placeholder="YYYY-MM-DD"></label>
    <label>메모 <textarea name="note" rows="2">${esc(pv.note)}</textarea></label>
    <label>링크(줄당 1개) <textarea name="links" rows="2">${esc((pv.links || []).join('\n'))}</textarea></label>
    <div class="btns">
      <button type="submit">적용</button>
      <button type="button" id="btnUp" title="바로 손위 형제 앞으로">손위로 ▲</button>
      <button type="button" id="btnDown" title="바로 손아래 형제 뒤로">손아래로 ▼</button>
      <button type="button" id="btnChild">＋ 자녀</button>
      <button type="button" id="btnDelete" class="danger">삭제</button>
    </div>
  </form>`;
}

function markDirty() {
  S.dirty = true;
  indexDb();
  $('#btnSave').classList.remove('hidden');
  $('#btnBackup').classList.remove('hidden');
}

function bindEditForm(p) {
  const form = $('#editForm');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const v = name => form.elements[name].value.trim();
    p.name = v('name');
    p.gender = v('gender');
    p.father = v('father') || undefined;
    p.mother = v('mother') || undefined;
    if (!p.father) delete p.father;
    if (!p.mother) delete p.mother;
    // 폼에 없는 커스텀 비공개 필드는 보존한다
    const priv = { ...(S.priv[p.id] || {}) };
    const setOrDel = (k, val) => { if (val && val.length) priv[k] = val; else delete priv[k]; };
    setOrDel('birth', v('birth'));
    setOrDel('death', v('death'));
    setOrDel('note', v('note'));
    setOrDel('links', v('links').split('\n').map(s => s.trim()).filter(Boolean));
    if (Object.keys(priv).length) S.priv[p.id] = priv;
    else delete S.priv[p.id];
    markDirty();
    render();
  });
  // 형제 순서만 의미가 있으므로, 가장 가까운 형제의 바로 앞/뒤로 점프한다
  // 배우자 목록 조작 — 조작 시 유추 포함 전체를 spouses 배열로 정규화한다
  const normSp = () => { p.spouses = allSpouses(p).map(s => s.id); };
  form.querySelectorAll('[data-spmove]').forEach(b => b.addEventListener('click', () => {
    const [id, d] = b.dataset.spmove.split('|');
    normSp();
    const i = p.spouses.indexOf(id), j = i + Number(d);
    if (i < 0 || j < 0 || j >= p.spouses.length) return;
    [p.spouses[i], p.spouses[j]] = [p.spouses[j], p.spouses[i]];
    markDirty();
    render();
  }));
  form.querySelectorAll('[data-spdel]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.spdel;
    normSp();
    p.spouses = p.spouses.filter(x => x !== id);
    if (!p.spouses.length) delete p.spouses;
    const q = S.byId[id];
    if (q && q.spouses) {
      q.spouses = q.spouses.filter(x => x !== p.id);
      if (!q.spouses.length) delete q.spouses;
    }
    markDirty();
    render();
  }));
  $('#btnSpAdd').addEventListener('click', () => {
    const id = $('#spAddSel').value;
    if (!id) return;
    normSp();
    if (!p.spouses.includes(id)) p.spouses.push(id);
    markDirty();
    render();
  });
  // 새 인물을 만들어 배우자로 — 자녀의 빈 반대편 부모 자리도 채운다
  $('#btnSpNew').addEventListener('click', () => {
    const name = prompt('새 배우자 이름:');
    if (!name) return;
    const sp = { id: newId(), name, gender: p.gender === 'M' ? 'F' : 'M' };
    S.db.people.push(sp);
    normSp();
    p.spouses.push(sp.id);
    for (const c of childrenOf(p.id)) {
      const other = c.father === p.id ? 'mother' : 'father';
      if (!c[other]) c[other] = sp.id;  // 이미 있으면 건드리지 않는다
    }
    markDirty();
    render();
  });
  // 새 인물을 만들어 부/모로
  const newParent = which => {
    const name = prompt(which === 'father' ? '부 이름:' : '모 이름:');
    if (!name) return;
    const np = { id: newId(), name, gender: which === 'father' ? 'M' : 'F' };
    S.db.people.push(np);
    p[which] = np.id;
    markDirty();
    render();
  };
  $('#btnNewFather').addEventListener('click', () => newParent('father'));
  $('#btnNewMother').addEventListener('click', () => newParent('mother'));

  const move = dir => {
    const i = S.db.people.indexOf(p);
    const idxs = siblingsOf(p).map(s => S.db.people.indexOf(s));
    const target = dir < 0
      ? Math.max(...idxs.filter(x => x < i))
      : Math.min(...idxs.filter(x => x > i));
    if (!isFinite(target)) return;  // 그 방향에 형제 없음
    S.db.people.splice(i, 1);
    // 제거 후: ▲는 형제가 여전히 target에 있어 그 앞으로, ▼는 형제가
    // target-1로 당겨져 그 뒤(=target)로 — 양쪽 모두 target 위치 삽입
    S.db.people.splice(target, 0, p);
    markDirty();
    render();
  };
  $('#btnUp').addEventListener('click', () => move(-1));
  $('#btnDown').addEventListener('click', () => move(1));
  $('#btnChild').addEventListener('click', () => {
    const name = prompt('자녀 이름:');
    if (!name) return;
    const sp = spouseOf(p);
    const child = {
      id: newId(),
      name, gender: 'M',
      father: p.gender === 'F' ? (sp && sp.id) : p.id,
      mother: p.gender === 'F' ? p.id : (sp && sp.id),
    };
    if (!child.father) delete child.father;
    if (!child.mother) delete child.mother;
    S.db.people.push(child);
    markDirty();
    setFocus(child.id);
  });
  $('#btnDelete').addEventListener('click', () => {
    if (!confirm(`${p.name} 님을 삭제할까요? (참조도 함께 정리됩니다)`)) return;
    S.db.people = S.db.people.filter(q => q.id !== p.id);
    for (const q of S.db.people) {
      if (q.father === p.id) delete q.father;
      if (q.mother === p.id) delete q.mother;
      if (q.spouses) {
        q.spouses = q.spouses.filter(id => id !== p.id);
        if (!q.spouses.length) delete q.spouses;
      }
    }
    delete S.priv[p.id];
    markDirty();
    setFocus(S.db.people[0] ? S.db.people[0].id : null);
  });
}

// 새 인물 id: p + 현재시각(36진수) + 난수 2자 — 사람이 정하지 않아도 유일함 보장.
// 평문 family.json에서 보기 좋은 id로 바꿔도 된다 (참조하는 곳도 함께 수정).
function newId() {
  let id;
  do {
    id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
  } while (S.byId[id]);
  return id;
}

function addPerson() {
  const name = prompt('새 인물 이름:');
  if (!name) return;
  const person = { id: newId(), name, gender: 'M' };
  S.db.people.push(person);
  markDirty();
  setFocus(person.id);
}

// ---------- 내보내기 ----------
function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function sealAll() {
  return {
    format: 'familytree-sealed-v1',
    public: await sealJSON(S.db, S.readPw),
    private: await sealJSON(S.priv, S.writePw),
  };
}

async function exportEnc() {
  download('family.enc.json', JSON.stringify(await sealAll()));
  S.dirty = false;
}

// GitHub Contents API로 암호화 데이터를 저장소에 바로 커밋.
// 토큰·저장소 정보는 data/remote.enc.json 에 쓰기 암호로 봉인되어 있으므로,
// 쓰기 암호를 아는 사람은 git 권한 없이도 여기서 저장할 수 있다.
async function pushEnc() {
  const rc = S.remote;
  const btn = $('#btnPush');
  btn.disabled = true;
  btn.textContent = '저장 중…';
  try {
    const api = 'https://api.github.com/repos/'
      + rc.owner + '/' + rc.repo + '/contents/' + (rc.path || 'data/family.enc.json');
    const hdr = { Authorization: 'Bearer ' + rc.token, Accept: 'application/vnd.github+json' };
    const branch = rc.branch || 'main';
    let sha;
    const cur = await fetch(api + '?ref=' + branch, { headers: hdr });
    if (cur.ok) sha = (await cur.json()).sha;
    const body = {
      message: '가계도 데이터 갱신 (웹 편집)',
      branch,
      content: b64encode(FT_ENC.encode(JSON.stringify(await sealAll()))),
    };
    if (sha) body.sha = sha;
    const res = await fetch(api, { method: 'PUT', headers: hdr, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(res.status + ' ' + (await res.text()).slice(0, 180));
    S.dirty = false;
    btn.textContent = '저장됨 ✓';
  } catch (e) {
    btn.textContent = 'GitHub에 저장';
    alert('GitHub 저장 실패: ' + e.message);
  } finally {
    btn.disabled = false;
    setTimeout(() => { btn.textContent = 'GitHub에 저장'; }, 3000);
  }
}

function exportPlain() {
  const doc = {
    ...S.db,
    people: S.db.people.map(p =>
      S.priv[p.id] ? { ...p, private: S.priv[p.id] } : p),
  };
  download('family.json', JSON.stringify(doc, null, 2) + '\n');
}

// ---------- 잠금 해제 ----------
async function unlockRead(pw) {
  S.db = await openJSON(window.SEALED.public, pw);  // 실패 시 예외
  S.readPw = pw;
  sessionStorage.setItem('ft-read', pw);
  indexDb();
  const focus = S.byId[S.db.defaultFocus] ? S.db.defaultFocus : S.db.people[0].id;
  document.title = S.db.title || '가계도';
  $('#title').textContent = S.db.title || '가계도';
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  buildSearch();
  setFocus(focus);
}

async function unlockWrite(pw) {
  S.priv = await openJSON(window.SEALED.private, pw);  // 실패 시 예외
  S.writePw = pw;
  S.editMode = true;
  $('#btnEdit').classList.add('hidden');
  $('#btnAdd').classList.remove('hidden');
  if (window.REMOTE) {
    try {
      S.remote = await openJSON(window.REMOTE, pw);
      $('#btnPush').classList.remove('hidden');
    } catch { /* 원격 설정이 다른 암호로 봉인됨 — 내려받기만 가능 */ }
  }
  render();
}

function buildSearch() {
  $('#names').innerHTML = S.db.people.map(p =>
    `<option value="${esc(p.name)}">`).join('');
}

// ---------- 이벤트 ----------
function initEvents() {
  const svg = $('#tree');

  // 팬/줌
  let drag = null, moved = 0, downTarget = null;
  svg.addEventListener('pointerdown', e => {
    drag = { x: e.clientX, y: e.clientY };
    moved = 0;
    downTarget = e.target;  // 캡처 후에는 이벤트 target이 svg로 바뀌므로 기억해 둠
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    moved += Math.abs(dx) + Math.abs(dy);
    S.view.x += dx; S.view.y += dy;
    drag = { x: e.clientX, y: e.clientY };
    applyView();
  });
  svg.addEventListener('pointerup', () => {
    drag = null;
    // 노드 클릭 → 재중심 (드래그와 구분)
    if (moved <= 6 && downTarget) {
      const g = downTarget.closest('.node');
      if (g) setFocus(g.dataset.id);
    }
    downTarget = null;
  });
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    const k = Math.exp(-e.deltaY * 0.0012);
    const nk = Math.min(3, Math.max(0.2, S.view.k * k));
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left, py = e.clientY - r.top;
    S.view.x = px - (px - S.view.x) * (nk / S.view.k);
    S.view.y = py - (py - S.view.y) * (nk / S.view.k);
    S.view.k = nk;
    applyView();
  }, { passive: false });

  // 인척 표시 토글
  $('#ckInlaw').addEventListener('change', e => {
    S.showInlaw = e.target.checked;
    render();
  });

  // 촌수 제한 스테퍼
  const stepChon = d => {
    const mf = chonMaxOf(S.focusId);
    const cur = S.maxChon < 0 ? mf : S.maxChon;
    const v = Math.max(0, cur + d);
    S.maxChon = v >= mf ? -1 : v;
    render();
  };
  $('#chonDec').addEventListener('click', () => stepChon(-1));
  $('#chonInc').addEventListener('click', () => stepChon(1));
  $('#chonNum').addEventListener('change', e => {
    const v = parseInt(e.target.value, 10);
    if (isNaN(v)) { render(); return; }
    S.maxChon = Math.max(0, v);
    render();  // render가 최대값 이상이면 전체(-1)로 정규화
  });

  // 가계도 ↔ 촌수 뷰 전환
  $('#btnView').addEventListener('click', () => {
    S.chonView = !S.chonView;
    $('#btnView').textContent = S.chonView ? '가계도 보기' : '촌수 보기';
    render();
  });

  // 상세 패널의 관계 버튼
  $('#detail').addEventListener('click', e => {
    const b = e.target.closest('[data-goto]');
    if (b) setFocus(b.dataset.goto);
  });

  // 검색
  $('#search').addEventListener('change', e => {
    const name = e.target.value.trim();
    const p = S.db.people.find(q => q.name === name);
    if (p) { setFocus(p.id); e.target.value = ''; }
  });

  // 읽기 암호 게이트
  $('#gateForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await unlockRead($('#gatePw').value);
    } catch {
      $('#gateMsg').textContent = '암호가 올바르지 않습니다.';
    }
  });

  // 편집 잠금 해제
  $('#btnEdit').addEventListener('click', async () => {
    const pw = prompt('쓰기 암호:');
    if (!pw) return;
    try {
      await unlockWrite(pw);
    } catch {
      alert('암호가 올바르지 않습니다.');
    }
  });
  $('#btnAdd').addEventListener('click', addPerson);
  $('#btnSave').addEventListener('click', exportEnc);
  $('#btnPush').addEventListener('click', pushEnc);
  $('#btnBackup').addEventListener('click', exportPlain);

  window.addEventListener('resize', () => { if (S.db) render(); });
  window.addEventListener('beforeunload', e => {
    if (S.dirty) e.preventDefault();
  });
}

// ---------- 부팅 ----------
async function boot() {
  initEvents();
  try {
    const res = await fetch('data/family.enc.json');
    if (!res.ok) throw new Error(res.status);
    window.SEALED = await res.json();
  } catch {
    $('#gateMsg').textContent =
      'data/family.enc.json 을 불러올 수 없습니다. README의 봉인 절차를 확인하세요.';
    $('#gateForm').classList.add('hidden');
    return;
  }
  try {  // 원격 저장 설정 (없어도 됨 — 그러면 "enc 내려받기"만 표시)
    const res = await fetch('data/remote.enc.json');
    if (res.ok) window.REMOTE = await res.json();
  } catch { /* 무시 */ }
  const saved = sessionStorage.getItem('ft-read');
  if (saved) {
    try { await unlockRead(saved); return; } catch { /* 무시하고 게이트 표시 */ }
  }
  $('#gatePw').focus();
}

boot();
