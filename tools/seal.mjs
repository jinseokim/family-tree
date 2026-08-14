#!/usr/bin/env node
// 평문 family.json <-> 암호화된 family.enc.json 변환 도구 (Node 20+, 의존성 없음)
//
//   봉인:  node tools/seal.mjs seal family.json data/family.enc.json
//   해제:  node tools/seal.mjs open data/family.enc.json family.json
//   원격 저장 설정 봉인:  node tools/seal.mjs remote data/remote.enc.json
//     ("GitHub에 저장" 버튼용 — 저장소 정보와 fine-grained PAT를
//      쓰기 암호로 봉인해 저장소에 함께 커밋한다)
//
// 암호는 실행 후 프롬프트로 입력받는다 (셸 히스토리에 남지 않도록).
// 비대화식 실행은 환경변수 FT_READ_PW / FT_WRITE_PW
// (remote 모드는 FT_GH_OWNER / FT_GH_REPO / FT_GH_BRANCH / FT_GH_TOKEN) 사용.

import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sealJSON, openJSON } = require('../crypto.js');

const [mode, inFile, outFile] = process.argv.slice(2);
const badArgs = mode === 'remote'
  ? !inFile
  : (!['seal', 'open'].includes(mode) || !inFile || !outFile);
if (badArgs) {
  console.error('사용법: node tools/seal.mjs <seal|open> <입력파일> <출력파일>');
  console.error('       node tools/seal.mjs remote <출력파일>');
  process.exit(1);
}

if (mode === 'remote') {
  const env = process.env;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const owner = env.FT_GH_OWNER || await rl.question('GitHub 사용자명(owner): ');
  const repo = env.FT_GH_REPO || await rl.question('저장소 이름(repo): ');
  const branch = env.FT_GH_BRANCH || (await rl.question('브랜치 [main]: ')) || 'main';
  const token = env.FT_GH_TOKEN
    || await rl.question('Fine-grained PAT (이 저장소 Contents read/write 권한만): ');
  const writePw = env.FT_WRITE_PW || await rl.question('쓰기 암호: ');
  rl.close();
  if (!owner || !repo || !token || !writePw) {
    console.error('모든 값이 필요합니다.');
    process.exit(1);
  }
  const blob = await sealJSON(
    { owner, repo, branch, path: 'data/family.enc.json', token }, writePw);
  writeFileSync(inFile, JSON.stringify(blob));
  console.error(`원격 저장 설정 봉인 완료: ${inFile} (${owner}/${repo}@${branch})`);
  process.exit(0);
}

let readPw = process.env.FT_READ_PW, writePw = process.env.FT_WRITE_PW;
if (!readPw || !writePw) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  readPw = readPw || await rl.question('읽기 암호: ');
  writePw = writePw || await rl.question('쓰기 암호: ');
  rl.close();
}
if (!readPw || !writePw) {
  console.error('암호는 비워둘 수 없습니다.');
  process.exit(1);
}

const input = JSON.parse(readFileSync(inFile, 'utf8'));

if (mode === 'seal') {
  // 사람별 private 필드를 분리해 쓰기 암호로, 나머지는 읽기 암호로 암호화
  const privMap = {};
  const people = input.people.map(p => {
    const { private: priv, ...pub } = p;
    if (priv && Object.keys(priv).length) privMap[p.id] = priv;
    return pub;
  });
  const publicDoc = { ...input, people };
  const out = {
    format: 'familytree-sealed-v1',
    public: await sealJSON(publicDoc, readPw),
    private: await sealJSON(privMap, writePw),
  };
  writeFileSync(outFile, JSON.stringify(out));
  console.error(`봉인 완료: ${outFile} (인물 ${people.length}명, 비공개 항목 ${Object.keys(privMap).length}건)`);
} else {
  const publicDoc = await openJSON(input.public, readPw);
  const privMap = await openJSON(input.private, writePw);
  publicDoc.people = publicDoc.people.map(p =>
    privMap[p.id] ? { ...p, private: privMap[p.id] } : p);
  writeFileSync(outFile, JSON.stringify(publicDoc, null, 2) + '\n');
  console.error(`해제 완료: ${outFile}`);
}
